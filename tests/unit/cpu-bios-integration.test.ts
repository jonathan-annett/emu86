import { describe, expect, it } from 'vitest';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryDisk, SECTOR_SIZE } from '../../src/disk/disk.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';

/**
 * End-to-end integration tests: assemble a guest program that issues real
 * `INT N` instructions, hand it to the IBMPCMachine, and verify the
 * trap-handler mechanism takes the BIOS handler all the way through to
 * register / memory / console / disk side effects and resumes at the
 * instruction after `INT N`.
 *
 * This is the proof that the BIOS pieces (ROM image, IVT setup, trap
 * registry, JS handlers, IRET stubs) hold together as a single boot path.
 *
 * Each test follows the pattern:
 *   1. Build a Machine with a deterministic console / disk / clock.
 *   2. Plant a small guest program at 0x1000:0 (well outside the BIOS area).
 *   3. Run the IVT-init code from the BIOS first by stepping enough times
 *      to clear the init code, then jump to the guest program. We do that
 *      by setting CS:IP directly after a partial run — easier than trying
 *      to RET out of init.
 *   4. Step the CPU through the INT N + IRET stub pair and assert.
 */

/**
 * Run BIOS init code to completion (the HLT at the end of init). This
 * populates the IVT, BDA, and stops at the safety-net HLT after INT 19h
 * fails (no disk attached for the boot test) — *or* at INT 19h's IRET
 * trampoline if a disk is attached.
 *
 * Returns the number of steps executed. Used as a sanity check.
 */
function stepUntilHaltOrLimit(m: IBMPCMachine, limit = 5000): number {
  let n = 0;
  while (!m.cpu.halted && n < limit) {
    m.cpu.step();
    n++;
  }
  return n;
}

/** Place `bytes` at linear `addr` directly via memory.writeByte. */
function plant(m: IBMPCMachine, addr: number, bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) {
    m.memory.writeByte(addr + i, bytes[i]! & 0xFF);
  }
}

/**
 * Run the BIOS init code far enough that the IVT is populated and the BDA
 * is set up, *without* taking the INT 19h boot. We step until the CPU has
 * just executed the IVT-build loop, the IVT[0x1E] override, the BDA stores,
 * and the SS:SP setup, then we override CS:IP to point at the guest.
 *
 * Easier in practice: just run init to its terminal HLT (no disk → INT 19h
 * sets CF and returns), confirm HLT, then clear the halt and set CS:IP.
 */
function runInitThenJumpTo(m: IBMPCMachine, guestSeg: number, guestOff: number): void {
  // Reset puts CS:IP at FFFF:0000 (reset vector). The first instruction is
  // the JMP F000:0100 in the ROM, then init runs to HLT.
  m.reset();
  stepUntilHaltOrLimit(m);
  // After init's safety-net HLT: clear and resume at the guest.
  m.cpu.halted = false;
  m.cpu.regs.CS = guestSeg;
  m.cpu.regs.IP = guestOff;
}

describe('CPU + BIOS integration', () => {
  it('INT 10h AH=0Eh writes a character to the console and resumes at next instruction', () => {
    const console_ = new InMemoryConsole();
    const m = new IBMPCMachine({ console: console_, hostClock: new InMemoryHostClock() });
    runInitThenJumpTo(m, 0x1000, 0x0000);

    // Guest:  MOV AH, 0x0E ; MOV AL, 'A' ; INT 0x10 ; HLT
    plant(m, 0x10000, [
      0xB4, 0x0E,
      0xB0, 0x41,
      0xCD, 0x10,
      0xF4,
    ]);

    // Step until HLT. INT 10h itself takes one step; the trap+IRET takes one
    // more (handler runs, then the 0xCF byte executes); MOV/HLT one each.
    let safety = 50;
    while (!m.cpu.halted && safety-- > 0) m.cpu.step();
    expect(m.cpu.halted).toBe(true);
    expect(console_.output).toBe('A');
    // CPU should now be at the instruction after HLT (HLT does not advance IP
    // beyond itself in our model — but the INT 10h handler completed and IRET
    // returned us to the HLT, which is the last instruction).
    // Verify we returned to the instruction *after* INT 0x10 — at offset 6.
    expect(m.cpu.regs.IP).toBe(0x0007);
    expect(m.cpu.regs.CS).toBe(0x1000);
  });

  it('INT 13h AH=02h reads a sector into ES:BX from the attached disk', () => {
    // Stage a recognisable pattern on LBA 0 of a 1.44 MB floppy.
    const disk = new InMemoryDisk({
      geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 },
    });
    const sec = new Uint8Array(SECTOR_SIZE);
    for (let i = 0; i < SECTOR_SIZE; i++) sec[i] = (i + 1) & 0xFF;
    disk.writeSector(0, sec);

    const m = new IBMPCMachine({ disk, hostClock: new InMemoryHostClock() });
    runInitThenJumpTo(m, 0x1000, 0x0000);

    // Guest:
    //   MOV AX, 0x2000 ; MOV ES, AX
    //   MOV BX, 0x0000
    //   MOV AH, 0x02 ; MOV AL, 1                ; read 1 sector
    //   MOV CH, 0    ; MOV CL, 1   ; MOV DH, 0  ; CHS = 0,0,1 → LBA 0
    //   MOV DL, 0
    //   INT 0x13
    //   HLT
    plant(m, 0x10000, [
      0xB8, 0x00, 0x20,         // MOV AX, 0x2000
      0x8E, 0xC0,               // MOV ES, AX
      0xBB, 0x00, 0x00,         // MOV BX, 0
      0xB4, 0x02,               // MOV AH, 0x02
      0xB0, 0x01,               // MOV AL, 1
      0xB5, 0x00,               // MOV CH, 0
      0xB1, 0x01,               // MOV CL, 1
      0xB6, 0x00,               // MOV DH, 0
      0xB2, 0x00,               // MOV DL, 0
      0xCD, 0x13,               // INT 0x13
      0xF4,                     // HLT
    ]);

    let safety = 200;
    while (!m.cpu.halted && safety-- > 0) m.cpu.step();
    expect(m.cpu.halted).toBe(true);
    // ES:BX = 0x2000:0 → linear 0x20000. Spot-check first and last bytes.
    expect(m.memory.readByte(0x20000)).toBe(1);
    expect(m.memory.readByte(0x20000 + SECTOR_SIZE - 1)).toBe(SECTOR_SIZE & 0xFF);
    expect(m.cpu.regs.AH).toBe(0x00);   // success
    expect(m.cpu.regs.AL).toBe(0x01);   // sectors transferred
  });

  it('INT 12h returns AX=640 (KiB) — the BDA value the init code planted', () => {
    const m = new IBMPCMachine();
    runInitThenJumpTo(m, 0x1000, 0x0000);
    plant(m, 0x10000, [
      0xCD, 0x12,    // INT 0x12
      0xF4,          // HLT
    ]);
    let safety = 30;
    while (!m.cpu.halted && safety-- > 0) m.cpu.step();
    expect(m.cpu.halted).toBe(true);
    expect(m.cpu.regs.AX).toBe(640);
  });

  it('INT 1Ah AH=02h fetches BCD time from the deterministic host clock', () => {
    const hostClock = new InMemoryHostClock({
      hours: 12, minutes: 34, seconds: 56,
    });
    const m = new IBMPCMachine({ hostClock });
    runInitThenJumpTo(m, 0x1000, 0x0000);
    plant(m, 0x10000, [
      0xB4, 0x02,    // MOV AH, 0x02
      0xCD, 0x1A,    // INT 0x1A
      0xF4,
    ]);
    let safety = 30;
    while (!m.cpu.halted && safety-- > 0) m.cpu.step();
    expect(m.cpu.halted).toBe(true);
    expect(m.cpu.regs.CH).toBe(0x12);
    expect(m.cpu.regs.CL).toBe(0x34);
    expect(m.cpu.regs.DH).toBe(0x56);
  });

  it('reset → BIOS init runs, IVT and BDA are populated, no-disk INT 19h fails into HLT', () => {
    // No disk → INT 19h fails, init code falls through to the safety HLT.
    const m = new IBMPCMachine({ hostClock: new InMemoryHostClock() });
    m.reset();
    const steps = stepUntilHaltOrLimit(m);
    expect(m.cpu.halted).toBe(true);
    expect(steps).toBeLessThan(5000);

    // IVT entry 0x10 should now point at trap-stub address F000:1010.
    const ivt10Off = m.memory.readWord(0x10 * 4);
    const ivt10Seg = m.memory.readWord(0x10 * 4 + 2);
    expect(ivt10Off).toBe(0x1010);
    expect(ivt10Seg).toBe(0xF000);
    // IVT entry 0x1E should point at the diskette parameter table.
    expect(m.memory.readWord(0x1E * 4)).toBe(0x2000);
    expect(m.memory.readWord(0x1E * 4 + 2)).toBe(0xF000);

    // BDA equipment word (0x40:0x10) should be 0x0021.
    expect(m.memory.readWord(0x400 + 0x10)).toBe(0x0021);
    // BDA memory size (0x40:0x13) should be 640.
    expect(m.memory.readWord(0x400 + 0x13)).toBe(640);
  });

  it('reset → INT 19h boot reads sector 0 to 0:7C00 and CS:IP lands there', () => {
    const disk = new InMemoryDisk({
      geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 },
    });
    // Boot sector: just an HLT then the 55AA signature.
    const boot = new Uint8Array(SECTOR_SIZE);
    boot[0] = 0xF4;             // HLT — first instruction the boot sector executes
    boot[510] = 0x55;
    boot[511] = 0xAA;
    disk.writeSector(0, boot);

    const m = new IBMPCMachine({ disk, hostClock: new InMemoryHostClock() });
    m.reset();
    const steps = stepUntilHaltOrLimit(m);
    expect(m.cpu.halted).toBe(true);
    expect(steps).toBeLessThan(5000);

    // After INT 19h's IRET we should be executing at 0:7C00; HLT lives there
    // and is one byte, so the CPU halted with CS=0, IP at 0x7C00 (HLT does not
    // advance IP past itself; we land at and execute 0x7C00 then halt).
    expect(m.cpu.regs.CS).toBe(0x0000);
    expect(m.cpu.regs.IP).toBe(0x7C01);   // IP advances over the HLT byte then halts
    // Boot signature copied verbatim into low memory.
    expect(m.memory.readByte(0x7DFE)).toBe(0x55);
    expect(m.memory.readByte(0x7DFF)).toBe(0xAA);
    // DL set to boot drive (0).
    expect(m.cpu.regs.DL).toBe(0x00);
  });
});
