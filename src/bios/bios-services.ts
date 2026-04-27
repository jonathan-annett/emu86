/**
 * TypeScript BIOS service handlers.
 *
 * Each `int*Handler` below is a {@link TrapHandler}: a JS function that runs
 * just before the CPU executes the IRET stub at `F000:1000+N`. The handler
 * reads inputs from CPU registers, does the work, writes outputs back to
 * registers (and to the pushed-FLAGS word on the stack for CF), then
 * returns. The IRET that follows pops flags/CS/IP and we're back in guest
 * code with the right state.
 *
 * Why this works without any custom CPU opcodes: the trap registry from
 * Phase 1 lets us hook a JS function at any linear address. The CPU's
 * normal `INT N` instruction pushes flags+CS+IP and far-jumps through the
 * IVT to our trap address. From the CPU's point of view, nothing
 * non-standard happens; from the guest's point of view, it's calling a
 * BIOS service the usual way.
 *
 * Reference contracts: 8086tiny `bios.asm` for the AH-subfunction register
 * layouts and the BDA fields that need updating.
 */

import type { CPU8086 } from '../cpu8086/cpu.js';
import type { Console } from '../console/console.js';
import type { Disk } from '../disk/disk.js';
import { SECTOR_SIZE } from '../disk/disk.js';
import type { HostClock } from '../host-clock/host-clock.js';
import { linearAddress } from '../core/types.js';
import { BiosDataArea, BDA, EQUIPMENT_DEFAULT, MEMORY_SIZE_KB_DEFAULT } from './bios-data-area.js';

/**
 * Per-machine context shared by every handler. The Machine constructs it
 * once at startup and curries it into each handler at registration time.
 */
export interface BiosContext {
  console: Console;
  disk: Disk | null;
  hostClock: HostClock;
  /** Diagnostic sink for unimplemented subfunctions. Default silent. */
  warn: (msg: string) => void;
  /** Optional EOI port (for INT 8 timer handler). Default 0x20. */
  eoiPort: number;
}

/** Convenience: a curried handler ready for `TrapRegistry.register`. */
export type BiosHandler = (cpu: CPU8086) => void;

// ============================================================
// Stack helpers — read/write the FLAGS / CS / IP that the INT N
// pushed onto the caller's stack. The IRET stub at our trap address
// will pop these; modifying them in-place changes what the caller sees
// when control returns.
//
// Stack layout immediately after INT N (low to high addresses):
//   SS:SP+0   IP    (IRET pops first)
//   SS:SP+2   CS
//   SS:SP+4   FLAGS
// ============================================================

function pushedAddr(cpu: CPU8086, byteOffset: number): number {
  // Word offsets within the SS segment may wrap, but the handlers below
  // don't care about that pathological case — SP is never within 6 bytes
  // of a segment wrap during normal BIOS calls. Use linearAddress to mask
  // the result into our 20-bit address space.
  return linearAddress(cpu.regs.SS, (cpu.regs.SP + byteOffset) & 0xFFFF);
}

function readPushedFlags(cpu: CPU8086): number {
  return cpu.memory.readWord(pushedAddr(cpu, 4));
}
function writePushedFlags(cpu: CPU8086, value: number): void {
  cpu.memory.writeWord(pushedAddr(cpu, 4), value & 0xFFFF);
}

/** Set / clear a single bit in the pushed FLAGS word. */
function setPushedFlagBit(cpu: CPU8086, mask: number, value: boolean): void {
  let f = readPushedFlags(cpu);
  if (value) f |= mask; else f &= ~mask;
  writePushedFlags(cpu, f);
}

const FLAG_CF = 0x0001;
const FLAG_ZF = 0x0040;

/** Set / clear CF on return. The IRET will pop this into the live FLAGS. */
export function setReturnCF(cpu: CPU8086, value: boolean): void {
  setPushedFlagBit(cpu, FLAG_CF, value);
}
/** Set / clear ZF on return. Used by INT 16h AH=01h. */
export function setReturnZF(cpu: CPU8086, value: boolean): void {
  setPushedFlagBit(cpu, FLAG_ZF, value);
}

/** Modify the pushed CS:IP. Used by INT 19h to "jump" into the boot sector. */
export function setReturnCsIp(cpu: CPU8086, segment: number, offset: number): void {
  cpu.memory.writeWord(pushedAddr(cpu, 0), offset & 0xFFFF);
  cpu.memory.writeWord(pushedAddr(cpu, 2), segment & 0xFFFF);
}

// ============================================================
// INT 10h — Video / console
// ============================================================

/**
 * Make the cursor advance one position. Wraps to the next row at column 80;
 * scrolls (via a single newline emitted to the console) when row 25 is
 * reached. We don't model real CGA video memory; the console is the only
 * sink for actual character output.
 */
function advanceCursor(bda: BiosDataArea, console: Console): void {
  let [col, row] = bda.getCursor();
  col++;
  if (col >= 80) {
    col = 0;
    row++;
    if (row >= 25) {
      // "Scroll" the screen by emitting a newline. This is the headless
      // approximation; a real BIOS would copy CGA memory rows. The
      // newline keeps the host terminal flowing naturally.
      console.writeChar(0x0A);
      row = 24;
    }
  }
  bda.setCursor(col, row);
}

export function int10Handler(cpu: CPU8086, ctx: BiosContext): void {
  const bda = new BiosDataArea(cpu.memory);
  const ah = cpu.regs.AH;

  switch (ah) {
    case 0x00: {
      // Set Video Mode (AL = mode). We have one mode (3 = colour text 80x25).
      // Just stash what the caller asked for so AH=0Fh reports it back.
      bda.writeByte(BDA.VIDEO_MODE, cpu.regs.AL);
      return;
    }
    case 0x02: {
      // Set Cursor Position. BH = page (ignored), DH = row, DL = column.
      bda.setCursor(cpu.regs.DL, cpu.regs.DH);
      return;
    }
    case 0x03: {
      // Get Cursor Position. CH/CL = cursor type, DH = row, DL = column.
      const [col, row] = bda.getCursor();
      cpu.regs.DH = row;
      cpu.regs.DL = col;
      const cursorType = bda.readWord(BDA.CURSOR_TYPE);
      cpu.regs.CH = (cursorType >> 8) & 0xFF;
      cpu.regs.CL = cursorType & 0xFF;
      return;
    }
    case 0x06:
    case 0x07: {
      // Scroll Up / Scroll Down Window. We can't model the rectangle
      // properly without screen memory; the most useful headless approximation
      // is to emit a single newline when AL=0 (clear-and-scroll-everything),
      // which keeps log-style output flowing on the host terminal.
      if (cpu.regs.AL === 0) {
        ctx.console.writeChar(0x0A);
      }
      // Reset cursor to (0, 0) is what AL=0 does on real hardware too.
      if (cpu.regs.AL === 0) bda.setCursor(0, 0);
      return;
    }
    case 0x08: {
      // Get character at cursor. We don't track screen contents; report
      // a space with default attribute. Plenty of code calls this just to
      // probe — the safe answer is "space".
      cpu.regs.AL = 0x20;
      cpu.regs.AH = 0x07;
      return;
    }
    case 0x09: {
      // Write Character with Attribute. AL = char, CX = count. Doesn't
      // advance cursor on real hardware. We ignore BL (attribute / colour).
      const ch = cpu.regs.AL;
      const count = cpu.regs.CX;
      for (let i = 0; i < count; i++) ctx.console.writeChar(ch);
      return;
    }
    case 0x0E: {
      // Write Character TTY. AL = char. Special-handle CR/LF/BS so the
      // headless console behaves intuitively.
      const ch = cpu.regs.AL;
      ctx.console.writeChar(ch);
      let [col, row] = bda.getCursor();
      switch (ch) {
        case 0x0D: col = 0; break;                                        // CR
        case 0x0A: row = Math.min(row + 1, 24); break;                    // LF
        case 0x08: if (col > 0) col--; break;                             // BS
        default: advanceCursor(bda, ctx.console); return;
      }
      bda.setCursor(col, row);
      return;
    }
    case 0x0F: {
      // Get Video Mode. AH = columns, AL = current mode, BH = active page.
      cpu.regs.AL = bda.readByte(BDA.VIDEO_MODE);
      cpu.regs.AH = bda.readWord(BDA.VIDEO_COLS) & 0xFF;
      cpu.regs.BH = 0;
      return;
    }
    default: {
      ctx.warn(`INT 10h: unimplemented AH=${ah.toString(16)}`);
      return;
    }
  }
}

// ============================================================
// INT 11h — Equipment list. Returns AX = BDA equipment word.
// ============================================================

export function int11Handler(cpu: CPU8086, _ctx: BiosContext): void {
  const bda = new BiosDataArea(cpu.memory);
  const equip = bda.readWord(BDA.EQUIPMENT);
  // Fall back to the constant default in case the BDA hasn't been
  // initialised (e.g., a unit test that calls the handler without running
  // the BIOS init code).
  cpu.regs.AX = equip === 0 ? EQUIPMENT_DEFAULT : equip;
}

// ============================================================
// INT 12h — Memory size. Returns AX = KiB of conventional memory.
// ============================================================

export function int12Handler(cpu: CPU8086, _ctx: BiosContext): void {
  const bda = new BiosDataArea(cpu.memory);
  const kb = bda.readWord(BDA.MEMORY_SIZE_KB);
  cpu.regs.AX = kb === 0 ? MEMORY_SIZE_KB_DEFAULT : kb;
}

// ============================================================
// INT 13h — Disk services
// ============================================================

/**
 * CHS → LBA translation. CL bits 0-5 = sector number (1-based), CL bits 6-7
 * = cylinder high 2 bits, CH = cylinder low 8 bits. DH = head, DL = drive.
 */
function chsToLba(geometry: { heads: number; sectorsPerTrack: number }, ch: number, cl: number, dh: number): number {
  const sector = cl & 0x3F;                          // 1-based
  const cylinder = ((cl & 0xC0) << 2) | (ch & 0xFF); // 10-bit
  return (cylinder * geometry.heads + dh) * geometry.sectorsPerTrack + (sector - 1);
}

const DISK_STATUS_OK = 0x00;
const DISK_STATUS_BAD_COMMAND = 0x01;
const DISK_STATUS_SECTOR_NOT_FOUND = 0x04;
const DISK_STATUS_DRIVE_NOT_READY = 0xAA;

function setDiskStatus(cpu: CPU8086, bda: BiosDataArea, status: number): void {
  cpu.regs.AH = status;
  bda.writeByte(BDA.DISK_LASTSTATUS, status);
  setReturnCF(cpu, status !== DISK_STATUS_OK);
}

export function int13Handler(cpu: CPU8086, ctx: BiosContext): void {
  const bda = new BiosDataArea(cpu.memory);
  const ah = cpu.regs.AH;

  switch (ah) {
    case 0x00: {
      // Reset Disk System. Always succeeds in our virtual world.
      setDiskStatus(cpu, bda, DISK_STATUS_OK);
      return;
    }
    case 0x01: {
      // Get Last Status. Returns AH = stored status, CF = (status != 0).
      const last = bda.readByte(BDA.DISK_LASTSTATUS);
      cpu.regs.AH = last;
      setReturnCF(cpu, last !== 0);
      return;
    }
    case 0x02:
    case 0x03:
    case 0x04: {
      // Read / Write / Verify Sectors.
      if (!ctx.disk) {
        setDiskStatus(cpu, bda, DISK_STATUS_DRIVE_NOT_READY);
        cpu.regs.AL = 0;
        return;
      }
      const dl = cpu.regs.DL;
      // For now we accept any drive number that maps to drive 0/0x80 and
      // route to the single attached disk. Multi-drive support is a future
      // brief.
      if (dl !== 0x00 && dl !== 0x80) {
        setDiskStatus(cpu, bda, DISK_STATUS_BAD_COMMAND);
        cpu.regs.AL = 0;
        return;
      }
      const count = cpu.regs.AL;
      const lbaBase = chsToLba(ctx.disk.geometry, cpu.regs.CH, cpu.regs.CL, cpu.regs.DH);
      const bufSeg = cpu.regs.ES;
      const bufOff = cpu.regs.BX;
      let done = 0;
      try {
        for (let i = 0; i < count; i++) {
          const lba = lbaBase + i;
          if (lba >= ctx.disk.sectorCount) {
            throw new Error('out of range');
          }
          if (ah === 0x03) {
            // Write: copy bytes out of guest memory into a sector buffer.
            const sec = new Uint8Array(SECTOR_SIZE);
            for (let j = 0; j < SECTOR_SIZE; j++) {
              sec[j] = cpu.memory.readByte(linearAddress(bufSeg, (bufOff + i * SECTOR_SIZE + j) & 0xFFFF));
            }
            ctx.disk.writeSector(lba, sec);
          } else {
            // Read or Verify: read the sector. For Verify we discard.
            const sec = ctx.disk.readSector(lba);
            if (ah === 0x02) {
              for (let j = 0; j < SECTOR_SIZE; j++) {
                cpu.memory.writeByte(linearAddress(bufSeg, (bufOff + i * SECTOR_SIZE + j) & 0xFFFF), sec[j]!);
              }
            }
          }
          done++;
        }
        cpu.regs.AL = done;
        setDiskStatus(cpu, bda, DISK_STATUS_OK);
      } catch (err) {
        ctx.warn(`INT 13h read/write failed at LBA ${lbaBase + done}: ${(err as Error).message}`);
        cpu.regs.AL = done;
        setDiskStatus(cpu, bda, DISK_STATUS_SECTOR_NOT_FOUND);
      }
      return;
    }
    case 0x05: {
      // Format Track — no-op for virtual disks.
      setDiskStatus(cpu, bda, DISK_STATUS_OK);
      return;
    }
    case 0x08: {
      // Get Drive Parameters (HD style). DL = drive number.
      if (!ctx.disk) {
        setDiskStatus(cpu, bda, DISK_STATUS_DRIVE_NOT_READY);
        cpu.regs.BL = 0; cpu.regs.CH = 0; cpu.regs.CL = 0; cpu.regs.DH = 0; cpu.regs.DL = 0;
        return;
      }
      const g = ctx.disk.geometry;
      const maxCyl = g.cylinders - 1;        // last cylinder (0-based)
      const maxHead = g.heads - 1;
      const maxSec = g.sectorsPerTrack;       // sectors per track (1-based, fits in 6 bits)
      cpu.regs.CH = maxCyl & 0xFF;
      cpu.regs.CL = (maxSec & 0x3F) | ((maxCyl >> 2) & 0xC0);
      cpu.regs.DH = maxHead;
      cpu.regs.DL = 1;                        // one drive attached
      cpu.regs.BL = 0x04;                     // 1.44 MB type code (8086tiny convention)
      setDiskStatus(cpu, bda, DISK_STATUS_OK);
      return;
    }
    case 0x15: {
      // Get Disk Type. AH = 1 (floppy w/o change-line) for floppies, 3 for HD.
      if (!ctx.disk) {
        setDiskStatus(cpu, bda, DISK_STATUS_DRIVE_NOT_READY);
        return;
      }
      cpu.regs.AH = (cpu.regs.DL & 0x80) ? 0x03 : 0x01;
      setReturnCF(cpu, false);
      return;
    }
    case 0x16: {
      // Detect Disk Change. AH = 0 means no change.
      cpu.regs.AH = 0;
      setReturnCF(cpu, false);
      return;
    }
    default: {
      ctx.warn(`INT 13h: unimplemented AH=${ah.toString(16)}`);
      setDiskStatus(cpu, bda, DISK_STATUS_BAD_COMMAND);
      return;
    }
  }
}

// ============================================================
// INT 16h — Keyboard
// ============================================================

/**
 * Pull every available character from the host console and push it into the
 * BDA keyboard buffer. We do this lazily inside each INT 16h call rather
 * than wiring an INT 9 path — for our headless setup the BDA is the source
 * of truth and the buffer-fill timing doesn't matter.
 */
function drainConsoleIntoKbBuffer(ctx: BiosContext, bda: BiosDataArea): void {
  while (ctx.console.hasInput()) {
    const c = ctx.console.readChar();
    if (c < 0) break;
    // Scancode 0 — we don't translate ASCII back to PC scancodes. ELKS
    // and most DOS code just look at the ASCII low byte. Documented
    // simplification.
    if (!bda.pushKey(c & 0xFF, 0)) break;     // buffer full; stop draining
  }
}

export function int16Handler(cpu: CPU8086, ctx: BiosContext): void {
  const bda = new BiosDataArea(cpu.memory);
  drainConsoleIntoKbBuffer(ctx, bda);
  const ah = cpu.regs.AH;

  switch (ah) {
    case 0x00: {
      // Read Key (blocking). Real BIOSes loop with HLT until INT 9
      // populates the buffer. For our v0 we just return whatever's there;
      // if empty, return AX=0 with CF=0. ELKS may notice — see brief.
      const k = bda.popKey();
      cpu.regs.AX = k < 0 ? 0 : (k & 0xFFFF);
      return;
    }
    case 0x01: {
      // Check for Key. ZF=1 if no key, ZF=0 + AX = next key (don't pop).
      const k = bda.peekKey();
      if (k < 0) {
        setReturnZF(cpu, true);
      } else {
        cpu.regs.AX = k & 0xFFFF;
        setReturnZF(cpu, false);
      }
      return;
    }
    case 0x02: {
      // Get Shift Flags. AL = BDA keyflags1 (capslock, numlock, etc.)
      cpu.regs.AL = bda.readByte(BDA.KEYFLAGS1);
      return;
    }
    default: {
      ctx.warn(`INT 16h: unimplemented AH=${ah.toString(16)}`);
      return;
    }
  }
}

// ============================================================
// INT 19h — Bootstrap loader
// ============================================================

export function int19Handler(cpu: CPU8086, ctx: BiosContext): void {
  const bda = new BiosDataArea(cpu.memory);
  if (!ctx.disk) {
    ctx.warn('INT 19h: no disk attached, cannot boot');
    setReturnCF(cpu, true);
    return;
  }
  const driveNumber = 0x00;     // floppy. (HD boot: 0x80; we always boot from drive 0.)
  // Read sector 0 (CHS 0,0,1 = LBA 0) into 0x0000:0x7C00.
  let bootSector: Uint8Array;
  try {
    bootSector = ctx.disk.readSector(0);
  } catch (err) {
    ctx.warn(`INT 19h: read of boot sector failed: ${(err as Error).message}`);
    setReturnCF(cpu, true);
    return;
  }
  for (let i = 0; i < SECTOR_SIZE; i++) {
    cpu.memory.writeByte(0x7C00 + i, bootSector[i]!);
  }
  // Set DL = boot drive number (boot sectors expect this).
  cpu.regs.DL = driveNumber;
  // Modify the pushed CS:IP so the IRET stub jumps to 0:7C00.
  setReturnCsIp(cpu, 0x0000, 0x7C00);
  // Clear the disk status as a clean baseline.
  bda.writeByte(BDA.DISK_LASTSTATUS, 0);
  setReturnCF(cpu, false);
}

// ============================================================
// INT 1Ah — Real-time clock
// ============================================================

const TICKS_PER_SECOND = 65_536 / 3600;     // ≈ 18.2065 Hz

function decimalToBcd(n: number): number {
  if (n < 0 || n > 99) throw new Error(`decimalToBcd: out of range (${n})`);
  return ((Math.floor(n / 10) & 0x0F) << 4) | (n % 10);
}

export function int1aHandler(cpu: CPU8086, ctx: BiosContext): void {
  const ah = cpu.regs.AH;
  switch (ah) {
    case 0x00: {
      // Get System Time. CX:DX = 32-bit tick counter, AL = midnight rollover.
      const t = ctx.hostClock.now();
      const totalSec = t.hours * 3600 + t.minutes * 60 + t.seconds + t.milliseconds / 1000;
      const ticks = Math.floor(totalSec * TICKS_PER_SECOND);
      cpu.regs.CX = (ticks >>> 16) & 0xFFFF;
      cpu.regs.DX = ticks & 0xFFFF;
      cpu.regs.AL = 0;
      return;
    }
    case 0x02: {
      // Get RTC Time. CH = hours BCD, CL = minutes BCD, DH = seconds BCD,
      // DL = DST flag (0 = no DST).
      const t = ctx.hostClock.now();
      cpu.regs.CH = decimalToBcd(t.hours);
      cpu.regs.CL = decimalToBcd(t.minutes);
      cpu.regs.DH = decimalToBcd(t.seconds);
      cpu.regs.DL = t.dst > 0 ? 1 : 0;
      setReturnCF(cpu, false);
      return;
    }
    case 0x04: {
      // Get RTC Date. CH = century BCD, CL = year BCD, DH = month BCD, DL = day BCD.
      const t = ctx.hostClock.now();
      const fullYear = 1900 + t.year;
      const century = Math.floor(fullYear / 100);
      const yearInCentury = fullYear % 100;
      cpu.regs.CH = decimalToBcd(century);
      cpu.regs.CL = decimalToBcd(yearInCentury);
      cpu.regs.DH = decimalToBcd(t.month + 1);     // 1-based for the BIOS
      cpu.regs.DL = decimalToBcd(t.dayOfMonth);
      setReturnCF(cpu, false);
      return;
    }
    default: {
      ctx.warn(`INT 1Ah: unimplemented AH=${ah.toString(16)}`);
      return;
    }
  }
}

// ============================================================
// INT 8 — Hardware timer tick (PIC IRQ 0)
// ============================================================

export function int8Handler(cpu: CPU8086, ctx: BiosContext): void {
  const bda = new BiosDataArea(cpu.memory);
  // Increment 32-bit tick counter (clk_dtimer). ELKS reads this for jiffies.
  const ticks = (bda.readDword(BDA.CLK_DTIMER) + 1) >>> 0;
  bda.writeDword(BDA.CLK_DTIMER, ticks);
  // Send EOI to PIC. (We deliberately don't chain to INT 1Ch in v0 —
  // chaining requires re-entering the CPU through INT and our trap handler
  // can't service that synchronously. Document.)
  cpu.io.outByte(ctx.eoiPort, 0x20);
}

// ============================================================
// Registration helper — wires every handler above into a TrapRegistry.
// ============================================================

import type { TrapRegistry } from '../cpu8086/trap-registry.js';
import type { BiosRomLayout } from './bios-rom.js';

/**
 * Register every BIOS handler against its trap address from the ROM layout.
 * Idempotent against the registry: callers should pass a fresh registry per
 * Machine (the registry's `register()` throws on duplicate addresses).
 *
 * Trivial INT vectors (most of 0–7, the unused IRQ stubs, INT 14h, etc.)
 * are *not* registered — their trap stub is just IRET, which is exactly
 * what those handlers should do.
 */
export function registerBiosHandlers(
  registry: TrapRegistry,
  layout: BiosRomLayout,
  ctx: BiosContext,
): void {
  const pairs: ReadonlyArray<[number, (cpu: CPU8086, ctx: BiosContext) => void]> = [
    [0x08, int8Handler],
    [0x10, int10Handler],
    [0x11, int11Handler],
    [0x12, int12Handler],
    [0x13, int13Handler],
    [0x16, int16Handler],
    [0x19, int19Handler],
    [0x1A, int1aHandler],
  ];
  for (const [vec, fn] of pairs) {
    const addr = layout.trapAddresses[vec];
    if (addr === undefined) {
      throw new Error(`BIOS handler registration: no trap address for INT ${vec.toString(16)}`);
    }
    registry.register(addr, (cpu) => fn(cpu, ctx));
  }
}
