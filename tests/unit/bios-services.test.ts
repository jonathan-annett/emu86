import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/cpu.js';
import { BasicIOBus } from '../../src/io/io-bus.js';
import { PagedMemory } from '../../src/memory/paged-memory.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import {
  BDA,
  BDA_BASE,
  BiosDataArea,
  EQUIPMENT_DEFAULT,
  MEMORY_SIZE_KB_DEFAULT,
} from '../../src/bios/bios-data-area.js';
import {
  int10Handler,
  int11Handler,
  int12Handler,
  int13Handler,
  int16Handler,
  int19Handler,
  int1aHandler,
  int8Handler,
  setReturnCF,
  setReturnZF,
  type BiosContext,
} from '../../src/bios/bios-services.js';

/**
 * Per-handler unit tests. Each test sets up a CPU, places sample inputs in
 * the registers (and on the stack where pushed-FLAGS / pushed-CS:IP matter),
 * calls the handler directly, and asserts the outputs.
 *
 * We don't run the CPU through an actual `INT N` — that's the
 * cpu-bios-integration test's job. Calling handlers directly keeps the
 * arithmetic / state changes isolated.
 */

interface Harness {
  cpu: CPU8086;
  memory: PagedMemory;
  bda: BiosDataArea;
  console: InMemoryConsole;
  /** Disk is non-null in the default harness; tests that opt out via
   *  `withDisk:false` should not read this. */
  disk: InMemoryDisk;
  hostClock: InMemoryHostClock;
  warnings: string[];
  ctx: BiosContext;
}

function makeHarness(opts: { withDisk?: boolean } = {}): Harness {
  const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
  const bus = new BasicIOBus();
  const cpu = new CPU8086(memory, bus);
  cpu.regs.SS = 0x0030;
  cpu.regs.SP = 0x0100;
  // Pre-place a recognisable FLAGS word at SS:SP+4 so we can observe CF/ZF
  // changes without ambiguity.
  const flagsAddr = (cpu.regs.SS << 4) + cpu.regs.SP + 4;
  memory.writeWord(flagsAddr, 0x0202);     // IF=1, reserved bit, no CF/ZF
  // Also seed the pushed CS:IP so we can verify INT 19h overwrites them.
  memory.writeWord((cpu.regs.SS << 4) + cpu.regs.SP, 0xDEAD);
  memory.writeWord((cpu.regs.SS << 4) + cpu.regs.SP + 2, 0xBEEF);

  const console_ = new InMemoryConsole();
  // Always create a disk for the harness's `disk` field so callers can stage
  // sectors. The handler-visible disk in `ctx` follows the `withDisk` flag.
  const disk = new InMemoryDisk({
    geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 },
  });
  const hostClock = new InMemoryHostClock();
  const warnings: string[] = [];

  const ctx: BiosContext = {
    console: console_,
    disk: opts.withDisk === false ? null : disk,
    hostClock,
    warn: (m) => warnings.push(m),
    eoiPort: 0x20,
  };

  return {
    cpu,
    memory,
    bda: new BiosDataArea(memory),
    console: console_,
    disk,
    hostClock,
    warnings,
    ctx,
  };
}

function readPushedFlags(h: Harness): number {
  return h.memory.readWord((h.cpu.regs.SS << 4) + h.cpu.regs.SP + 4);
}

// ============================================================
// setReturnCF / setReturnZF / pushed-flags helpers
// ============================================================

describe('flag-return helpers', () => {
  it('setReturnCF flips CF in the pushed FLAGS without touching other bits', () => {
    const h = makeHarness();
    const before = readPushedFlags(h);
    setReturnCF(h.cpu, true);
    const after = readPushedFlags(h);
    expect(after & 0x0001).toBe(1);
    expect(after & ~0x0001).toBe(before & ~0x0001);
    setReturnCF(h.cpu, false);
    expect(readPushedFlags(h) & 0x0001).toBe(0);
  });

  it('setReturnZF flips ZF in the pushed FLAGS', () => {
    const h = makeHarness();
    setReturnZF(h.cpu, true);
    expect(readPushedFlags(h) & 0x0040).toBeTruthy();
    setReturnZF(h.cpu, false);
    expect(readPushedFlags(h) & 0x0040).toBe(0);
  });
});

// ============================================================
// INT 10h
// ============================================================

describe('INT 10h — video', () => {
  it('AH=0Eh writes a character to the console and advances cursor', () => {
    const h = makeHarness();
    h.bda.setCursor(5, 7);
    h.cpu.regs.AH = 0x0E;
    h.cpu.regs.AL = 0x41;            // 'A'
    int10Handler(h.cpu, h.ctx);
    expect(h.console.output).toBe('A');
    const [col, row] = h.bda.getCursor();
    expect(col).toBe(6);
    expect(row).toBe(7);
  });

  it('AH=0Eh handles CR / LF / BS specially', () => {
    const h = makeHarness();
    h.bda.setCursor(10, 5);
    h.cpu.regs.AH = 0x0E;
    h.cpu.regs.AL = 0x0D;            // CR
    int10Handler(h.cpu, h.ctx);
    expect(h.bda.getCursor()).toEqual([0, 5]);
    h.bda.setCursor(10, 5);
    h.cpu.regs.AL = 0x0A;            // LF
    int10Handler(h.cpu, h.ctx);
    expect(h.bda.getCursor()).toEqual([10, 6]);
    h.bda.setCursor(10, 5);
    h.cpu.regs.AL = 0x08;            // BS
    int10Handler(h.cpu, h.ctx);
    expect(h.bda.getCursor()).toEqual([9, 5]);
  });

  it('AH=02h sets the cursor', () => {
    const h = makeHarness();
    h.cpu.regs.AH = 0x02;
    h.cpu.regs.DH = 12;
    h.cpu.regs.DL = 34;
    int10Handler(h.cpu, h.ctx);
    expect(h.bda.getCursor()).toEqual([34, 12]);
  });

  it('AH=03h returns the cursor in DH/DL', () => {
    const h = makeHarness();
    h.bda.setCursor(7, 9);
    h.cpu.regs.AH = 0x03;
    int10Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DH).toBe(9);
    expect(h.cpu.regs.DL).toBe(7);
  });

  it('AH=09h writes the character `count` times without advancing cursor', () => {
    const h = makeHarness();
    h.bda.setCursor(5, 5);
    h.cpu.regs.AH = 0x09;
    h.cpu.regs.AL = 0x2A;            // '*'
    h.cpu.regs.CX = 4;
    int10Handler(h.cpu, h.ctx);
    expect(h.console.output).toBe('****');
    expect(h.bda.getCursor()).toEqual([5, 5]);
  });

  it('AH=0Fh reports mode/columns/page', () => {
    const h = makeHarness();
    h.bda.writeByte(BDA.VIDEO_MODE, 3);
    h.bda.writeWord(BDA.VIDEO_COLS, 80);
    h.cpu.regs.AH = 0x0F;
    int10Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AL).toBe(3);
    expect(h.cpu.regs.AH).toBe(80);
    expect(h.cpu.regs.BH).toBe(0);
  });

  it('AH=00h stashes the requested mode in BDA', () => {
    const h = makeHarness();
    h.cpu.regs.AH = 0x00;
    h.cpu.regs.AL = 0x02;
    int10Handler(h.cpu, h.ctx);
    expect(h.bda.readByte(BDA.VIDEO_MODE)).toBe(0x02);
  });

  it('unknown AH triggers a warn but does not throw', () => {
    const h = makeHarness();
    h.cpu.regs.AH = 0x99;
    int10Handler(h.cpu, h.ctx);
    expect(h.warnings.length).toBe(1);
  });

  it('cursor wraps from column 80 to next row on AH=0Eh', () => {
    const h = makeHarness();
    h.bda.setCursor(79, 10);
    h.cpu.regs.AH = 0x0E;
    h.cpu.regs.AL = 0x42;             // 'B' — printable char
    int10Handler(h.cpu, h.ctx);
    expect(h.bda.getCursor()).toEqual([0, 11]);
  });
});

// ============================================================
// INT 11h / 12h
// ============================================================

describe('INT 11h — equipment list', () => {
  it('returns the BDA equipment word', () => {
    const h = makeHarness();
    h.bda.writeWord(BDA.EQUIPMENT, 0x1234);
    int11Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AX).toBe(0x1234);
  });
  it('falls back to EQUIPMENT_DEFAULT when BDA is zero', () => {
    const h = makeHarness();
    int11Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AX).toBe(EQUIPMENT_DEFAULT);
  });
});

describe('INT 12h — memory size', () => {
  it('returns BDA memory-size-KiB', () => {
    const h = makeHarness();
    h.bda.writeWord(BDA.MEMORY_SIZE_KB, 0x0280);
    int12Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AX).toBe(0x0280);
  });
  it('falls back to MEMORY_SIZE_KB_DEFAULT when BDA is zero', () => {
    const h = makeHarness();
    int12Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AX).toBe(MEMORY_SIZE_KB_DEFAULT);
  });
});

// ============================================================
// INT 13h
// ============================================================

describe('INT 13h — disk', () => {
  it('AH=00h reset succeeds, sets CF=0, AH=0', () => {
    const h = makeHarness();
    h.cpu.regs.AH = 0x00;
    h.cpu.regs.DL = 0x00;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(readPushedFlags(h) & 0x0001).toBe(0);
  });

  it('AH=02h reads sectors into ES:BX from the disk', () => {
    const h = makeHarness();
    // Plant a recognisable byte pattern in LBA 0.
    const sec = new Uint8Array(512);
    for (let i = 0; i < 512; i++) sec[i] = (i + 0x40) & 0xFF;
    h.disk.writeSector(0, sec);

    h.cpu.regs.AH = 0x02;
    h.cpu.regs.AL = 1;              // count = 1
    h.cpu.regs.CH = 0;              // cylinder lo
    h.cpu.regs.CL = 1;              // sector 1, cylinder hi=0
    h.cpu.regs.DH = 0;              // head
    h.cpu.regs.DL = 0;              // floppy 0
    h.cpu.regs.ES = 0x2000;
    h.cpu.regs.BX = 0x0000;
    int13Handler(h.cpu, h.ctx);

    expect(h.cpu.regs.AH).toBe(0);
    expect(h.cpu.regs.AL).toBe(1);
    expect(readPushedFlags(h) & 0x0001).toBe(0);
    // Spot-check the destination memory.
    expect(h.memory.readByte(0x20000)).toBe(0x40);
    expect(h.memory.readByte(0x20000 + 511)).toBe((511 + 0x40) & 0xFF);
  });

  it('AH=02h with no disk returns drive-not-ready', () => {
    const h = makeHarness({ withDisk: false });
    h.cpu.regs.AH = 0x02;
    h.cpu.regs.AL = 1;
    h.cpu.regs.DL = 0;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0xAA);   // drive not ready
    expect(readPushedFlags(h) & 0x0001).toBeTruthy();
  });

  it('AH=02h CHS->LBA: sector=2, head=1 reads LBA 19 on 18-sector floppy', () => {
    const h = makeHarness();
    const sec = new Uint8Array(512).fill(0xAA);
    sec[0] = 0x55;
    h.disk.writeSector(19, sec);

    h.cpu.regs.AH = 0x02;
    h.cpu.regs.AL = 1;
    h.cpu.regs.CH = 0;
    h.cpu.regs.CL = 2;        // sector 2 (1-based)
    h.cpu.regs.DH = 1;        // head 1
    h.cpu.regs.DL = 0;
    h.cpu.regs.ES = 0x3000;
    h.cpu.regs.BX = 0x0000;
    int13Handler(h.cpu, h.ctx);

    expect(h.cpu.regs.AH).toBe(0);
    expect(h.memory.readByte(0x30000)).toBe(0x55);
  });

  it('AH=03h writes sectors from ES:BX to the disk', () => {
    const h = makeHarness();
    // Plant data in guest memory.
    for (let i = 0; i < 512; i++) {
      h.memory.writeByte(0x40000 + i, (i ^ 0x5A) & 0xFF);
    }
    h.cpu.regs.AH = 0x03;
    h.cpu.regs.AL = 1;
    h.cpu.regs.CH = 0;
    h.cpu.regs.CL = 1;
    h.cpu.regs.DH = 0;
    h.cpu.regs.DL = 0;
    h.cpu.regs.ES = 0x4000;
    h.cpu.regs.BX = 0x0000;
    int13Handler(h.cpu, h.ctx);

    expect(h.cpu.regs.AH).toBe(0);
    const written = h.disk.readSector(0);
    expect(written[0]).toBe(0x5A);
    expect(written[5]).toBe((5 ^ 0x5A) & 0xFF);
  });

  it('AH=08h returns geometry packed into CL/CH/DH/DL', () => {
    const h = makeHarness();
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x00;
    int13Handler(h.cpu, h.ctx);
    // Geometry: 80c × 2h × 18s. maxCyl = 79 (0x4F), maxHead = 1, sectors = 18.
    expect(h.cpu.regs.CH).toBe(79);
    expect(h.cpu.regs.CL & 0x3F).toBe(18);
    expect(h.cpu.regs.DH).toBe(1);
    expect(h.cpu.regs.DL).toBe(1);
    expect(h.cpu.regs.AH).toBe(0);
  });

  it('AH=15h reports floppy type for DL=0 and HD type for DL=0x80', () => {
    const h = makeHarness();
    h.cpu.regs.AH = 0x15;
    h.cpu.regs.DL = 0;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x01);   // floppy w/o change-line

    const h2 = makeHarness();
    h2.cpu.regs.AH = 0x15;
    h2.cpu.regs.DL = 0x80;
    int13Handler(h2.cpu, h2.ctx);
    expect(h2.cpu.regs.AH).toBe(0x03);  // HD
  });

  it('AH=01h returns last status', () => {
    const h = makeHarness();
    h.bda.writeByte(BDA.DISK_LASTSTATUS, 0x80);
    h.cpu.regs.AH = 0x01;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x80);
    expect(readPushedFlags(h) & 0x0001).toBeTruthy();
  });
});

// ============================================================
// INT 16h
// ============================================================

describe('INT 16h — keyboard', () => {
  it('AH=01h with empty buffer sets ZF=1', () => {
    const h = makeHarness();
    // Init kbbuf head/tail/start/end fields like the BIOS init code does.
    h.bda.writeWord(BDA.KBBUF_HEAD, 0x1E);
    h.bda.writeWord(BDA.KBBUF_TAIL, 0x1E);
    h.bda.writeWord(BDA.KBBUF_START_PTR, 0x1E);
    h.bda.writeWord(BDA.KBBUF_END_PTR, 0x3E);
    h.cpu.regs.AH = 0x01;
    int16Handler(h.cpu, h.ctx);
    expect(readPushedFlags(h) & 0x0040).toBeTruthy();   // ZF=1
  });

  it('AH=01h with console input drains, populates buffer, returns ZF=0 and AX', () => {
    const h = makeHarness();
    h.bda.writeWord(BDA.KBBUF_HEAD, 0x1E);
    h.bda.writeWord(BDA.KBBUF_TAIL, 0x1E);
    h.bda.writeWord(BDA.KBBUF_START_PTR, 0x1E);
    h.bda.writeWord(BDA.KBBUF_END_PTR, 0x3E);
    h.console.pushInput('Z');
    h.cpu.regs.AH = 0x01;
    int16Handler(h.cpu, h.ctx);
    expect(readPushedFlags(h) & 0x0040).toBe(0);        // ZF=0
    expect(h.cpu.regs.AL).toBe(0x5A);                   // 'Z'
  });

  it('AH=00h pops the next key', () => {
    const h = makeHarness();
    h.bda.writeWord(BDA.KBBUF_HEAD, 0x1E);
    h.bda.writeWord(BDA.KBBUF_TAIL, 0x1E);
    h.bda.writeWord(BDA.KBBUF_START_PTR, 0x1E);
    h.bda.writeWord(BDA.KBBUF_END_PTR, 0x3E);
    h.console.pushInput('a');
    h.cpu.regs.AH = 0x00;
    int16Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AL).toBe(0x61);
    // Buffer should be empty again.
    expect(h.bda.isKbBufferEmpty()).toBe(true);
  });

  it('AH=02h returns BDA keyflags', () => {
    const h = makeHarness();
    h.bda.writeByte(BDA.KEYFLAGS1, 0x40);    // capslock
    h.cpu.regs.AH = 0x02;
    int16Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AL).toBe(0x40);
  });
});

// ============================================================
// INT 19h
// ============================================================

describe('INT 19h — boot', () => {
  it('reads sector 0 into 0:7C00 and modifies pushed CS:IP to 0:7C00', () => {
    const h = makeHarness();
    const sec = new Uint8Array(512);
    sec[0] = 0xEB;       // boot sector marker — JMP short
    sec[1] = 0x3C;
    sec[510] = 0x55;     // boot signature
    sec[511] = 0xAA;
    h.disk.writeSector(0, sec);
    int19Handler(h.cpu, h.ctx);
    expect(h.memory.readByte(0x7C00)).toBe(0xEB);
    expect(h.memory.readByte(0x7C01)).toBe(0x3C);
    expect(h.memory.readByte(0x7DFE)).toBe(0x55);
    expect(h.memory.readByte(0x7DFF)).toBe(0xAA);
    // Pushed IP at SS:SP+0, pushed CS at SS:SP+2.
    const baseAddr = (h.cpu.regs.SS << 4) + h.cpu.regs.SP;
    expect(h.memory.readWord(baseAddr)).toBe(0x7C00);
    expect(h.memory.readWord(baseAddr + 2)).toBe(0x0000);
    expect(h.cpu.regs.DL).toBe(0);
  });

  it('returns CF=1 when no disk is attached', () => {
    const h = makeHarness({ withDisk: false });
    int19Handler(h.cpu, h.ctx);
    expect(readPushedFlags(h) & 0x0001).toBeTruthy();
  });
});

// ============================================================
// INT 1Ah
// ============================================================

describe('INT 1Ah — RTC', () => {
  it('AH=02h returns BCD time fields', () => {
    const h = makeHarness();
    h.hostClock.setTime({
      seconds: 45, minutes: 23, hours: 19,
      dayOfMonth: 1, month: 0, year: 126,
      dayOfWeek: 4, dayOfYear: 0, dst: 0, milliseconds: 0,
    });
    h.cpu.regs.AH = 0x02;
    int1aHandler(h.cpu, h.ctx);
    expect(h.cpu.regs.CH).toBe(0x19);   // 19 BCD
    expect(h.cpu.regs.CL).toBe(0x23);
    expect(h.cpu.regs.DH).toBe(0x45);
    expect(h.cpu.regs.DL).toBe(0);      // DST flag
  });

  it('AH=04h returns BCD date fields with century in CH', () => {
    const h = makeHarness();
    h.hostClock.setTime({
      seconds: 0, minutes: 0, hours: 0,
      dayOfMonth: 27, month: 3, year: 126,    // 2026-04-27
      dayOfWeek: 1, dayOfYear: 116, dst: 0, milliseconds: 0,
    });
    h.cpu.regs.AH = 0x04;
    int1aHandler(h.cpu, h.ctx);
    expect(h.cpu.regs.CH).toBe(0x20);   // century = 20 (BCD)
    expect(h.cpu.regs.CL).toBe(0x26);
    expect(h.cpu.regs.DH).toBe(0x04);   // April = month 4 (1-based)
    expect(h.cpu.regs.DL).toBe(0x27);
  });

  it('AH=00h returns ticks proportional to wall-clock seconds since midnight', () => {
    const h = makeHarness();
    h.hostClock.setTime({
      seconds: 0, minutes: 0, hours: 1,           // 1:00:00 → 3600 sec
      dayOfMonth: 1, month: 0, year: 126,
      dayOfWeek: 4, dayOfYear: 0, dst: 0, milliseconds: 0,
    });
    h.cpu.regs.AH = 0x00;
    int1aHandler(h.cpu, h.ctx);
    // 3600 sec * (65536/3600) = 65536 ticks. CX:DX should encode that.
    const ticks = (h.cpu.regs.CX << 16) | h.cpu.regs.DX;
    expect(ticks).toBe(65536);
    expect(h.cpu.regs.AL).toBe(0);
  });
});

// ============================================================
// INT 8 — timer tick
// ============================================================

describe('INT 8 — hardware timer tick', () => {
  it('increments BDA.CLK_DTIMER and writes EOI to PIC port', () => {
    const h = makeHarness();
    // Capture port writes via a minimal stub registered on the bus.
    const portWrites: Array<[number, number]> = [];
    h.cpu.io.register({ start: 0x20, end: 0x20 }, {
      writeByte: (port, value) => { portWrites.push([port, value]); },
    });
    h.bda.writeDword(BDA.CLK_DTIMER, 100);
    int8Handler(h.cpu, h.ctx);
    expect(h.bda.readDword(BDA.CLK_DTIMER)).toBe(101);
    expect(portWrites).toEqual([[0x20, 0x20]]);
  });
});

// ============================================================
// BiosDataArea — keyboard buffer mechanics
// ============================================================

describe('BiosDataArea — kb buffer wrapping', () => {
  it('pushKey wraps from end-2 back to start', () => {
    const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
    const bda = new BiosDataArea(memory);
    bda.writeWord(BDA.KBBUF_START_PTR, 0x1E);
    bda.writeWord(BDA.KBBUF_END_PTR, 0x3E);
    // Head is at 0x20 (one slot consumed), tail is at the last slot (0x3C).
    // pushKey should write to 0x3C, then wrap nextTail to 0x1E (not equal to
    // head = 0x20, so the push succeeds).
    bda.writeWord(BDA.KBBUF_HEAD, 0x20);
    bda.writeWord(BDA.KBBUF_TAIL, 0x3C);
    expect(bda.pushKey(0x41, 0)).toBe(true);
    // Tail should have advanced to 0x3E and then wrapped to 0x1E.
    expect(bda.readWord(BDA.KBBUF_TAIL)).toBe(0x1E);
  });

  it('isKbBufferFull when next-tail would equal head', () => {
    const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
    const bda = new BiosDataArea(memory);
    bda.writeWord(BDA.KBBUF_START_PTR, 0x1E);
    bda.writeWord(BDA.KBBUF_END_PTR, 0x22);   // tiny buffer: 4 bytes = 2 entries
    bda.writeWord(BDA.KBBUF_HEAD, 0x1E);
    bda.writeWord(BDA.KBBUF_TAIL, 0x20);      // one entry queued
    expect(bda.isKbBufferFull()).toBe(true);
    expect(bda.pushKey(0x41, 0)).toBe(false); // dropped
  });

  it('popKey returns -1 when empty', () => {
    const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
    const bda = new BiosDataArea(memory);
    bda.writeWord(BDA.KBBUF_START_PTR, 0x1E);
    bda.writeWord(BDA.KBBUF_END_PTR, 0x3E);
    bda.writeWord(BDA.KBBUF_HEAD, 0x1E);
    bda.writeWord(BDA.KBBUF_TAIL, 0x1E);
    expect(bda.popKey()).toBe(-1);
  });
});

describe('BiosDataArea — dword roundtrip', () => {
  it('writeDword/readDword roundtrips a 32-bit value through 2 words', () => {
    const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
    const bda = new BiosDataArea(memory);
    bda.writeDword(BDA.CLK_DTIMER, 0x12345678);
    expect(bda.readDword(BDA.CLK_DTIMER)).toBe(0x12345678);
    // Spot-check the underlying memory: lo word at +0, hi word at +2.
    expect(memory.readWord(BDA_BASE + BDA.CLK_DTIMER)).toBe(0x5678);
    expect(memory.readWord(BDA_BASE + BDA.CLK_DTIMER + 2)).toBe(0x1234);
  });
});
