/**
 * Phase 10 — INT 13h hard-disk paths.
 *
 * Pins the AH=0x08 reply shape for HD drives (DL ≥ 0x80), the
 * cross-class error path (asking for an HD when only a floppy is
 * mounted, and vice versa), and the floppy regression baseline.
 *
 * The pre-Phase-10 AH=0x08 baseline lives in `bios-services.test.ts` and
 * keeps passing — these tests are additive.
 */

import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/cpu.js';
import { BasicIOBus } from '../../src/io/io-bus.js';
import { PagedMemory } from '../../src/memory/paged-memory.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { BiosDataArea, BDA } from '../../src/bios/bios-data-area.js';
import {
  int13Handler,
  type BiosContext,
} from '../../src/bios/bios-services.js';

interface Harness {
  cpu: CPU8086;
  memory: PagedMemory;
  ctx: BiosContext;
}

function makeHdHarness(geometry = { cylinders: 63, heads: 16, sectorsPerTrack: 63 }): Harness {
  const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
  const bus = new BasicIOBus();
  const cpu = new CPU8086(memory, bus);
  cpu.regs.SS = 0x0030;
  cpu.regs.SP = 0x0100;
  // Pre-place a recognisable FLAGS word at SS:SP+4 so we can observe CF
  // changes without ambiguity.
  memory.writeWord((cpu.regs.SS << 4) + cpu.regs.SP + 4, 0x0202);

  const disk = new InMemoryDisk({ geometry });
  const ctx: BiosContext = {
    console: new InMemoryConsole(),
    disk,
    diskClass: 'hard-disk',
    hostClock: new InMemoryHostClock(),
    warn: () => { /* silent */ },
    eoiPort: 0x20,
    extendedMemoryKb: 0,
  };
  return { cpu, memory, ctx };
}

function makeFloppyHarness(): Harness {
  const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
  const bus = new BasicIOBus();
  const cpu = new CPU8086(memory, bus);
  cpu.regs.SS = 0x0030;
  cpu.regs.SP = 0x0100;
  memory.writeWord((cpu.regs.SS << 4) + cpu.regs.SP + 4, 0x0202);

  const disk = new InMemoryDisk({ geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 } });
  const ctx: BiosContext = {
    console: new InMemoryConsole(),
    disk,
    diskClass: 'floppy',
    hostClock: new InMemoryHostClock(),
    warn: () => { /* silent */ },
    eoiPort: 0x20,
    extendedMemoryKb: 0,
  };
  return { cpu, memory, ctx };
}

function readPushedFlags(memory: PagedMemory, cpu: CPU8086): number {
  return memory.readWord((cpu.regs.SS << 4) + cpu.regs.SP + 4);
}

describe('INT 13h AH=0x08 — Get Drive Parameters (HD)', () => {
  it('returns 63×16×63 geometry packed into CH/CL/DH for hd32', () => {
    const h = makeHdHarness();   // 63 × 16 × 63
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    // maxCyl = 62 (low 8 bits in CH; high 2 bits in CL[7:6])
    expect(h.cpu.regs.CH).toBe(62);
    expect(h.cpu.regs.CL & 0xC0).toBe(0);   // (62 >> 8) & 0x03 = 0 → CL[7:6] = 0
    expect(h.cpu.regs.CL & 0x3F).toBe(63);  // sectors per track in CL[5:0]
    expect(h.cpu.regs.DH).toBe(15);         // heads - 1
    expect(h.cpu.regs.AH).toBe(0);          // success
  });

  it('reports drive count 1 in DL for HD class', () => {
    const h = makeHdHarness();
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DL).toBe(1);
  });

  it('returns BL=0x00 for HD (not the floppy 0x04 type code)', () => {
    const h = makeHdHarness();
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.BL).toBe(0x00);
  });

  it('zeros ES:DI for HD (no drive parameter table)', () => {
    const h = makeHdHarness();
    h.cpu.regs.ES = 0x1234;
    h.cpu.regs.DI = 0x5678;
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.ES).toBe(0);
    expect(h.cpu.regs.DI).toBe(0);
  });

  it('handles cylinder ≥ 256 — high 2 bits go to CL[7:6]', () => {
    const h = makeHdHarness({ cylinders: 300, heads: 16, sectorsPerTrack: 63 });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    // maxCyl = 299. Low 8 = 299 & 0xFF = 43. High 2 = (299 >> 8) & 0x03 = 1 → CL bit 6.
    expect(h.cpu.regs.CH).toBe(43);
    expect(h.cpu.regs.CL & 0xC0).toBe(0x40);
    expect(h.cpu.regs.CL & 0x3F).toBe(63);
  });

  it('floppy regression: DL=0x00 still returns 80×2×18 with BL=0x04', () => {
    const h = makeFloppyHarness();
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x00;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.CH).toBe(79);
    expect(h.cpu.regs.CL & 0x3F).toBe(18);
    expect(h.cpu.regs.DH).toBe(1);
    expect(h.cpu.regs.DL).toBe(1);
    expect(h.cpu.regs.BL).toBe(0x04);
    expect(h.cpu.regs.AH).toBe(0);
  });

  it('cross-class error: DL=0x00 with HD mounted → BAD_COMMAND, CF=1', () => {
    const h = makeHdHarness();
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x00;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x01);    // BAD_COMMAND
    expect(readPushedFlags(h.memory, h.cpu) & 0x0001).toBeTruthy();   // CF=1
  });

  it('cross-class error: DL=0x80 with floppy mounted → BAD_COMMAND, CF=1', () => {
    const h = makeFloppyHarness();
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x01);
    expect(readPushedFlags(h.memory, h.cpu) & 0x0001).toBeTruthy();
  });
});

describe('INT 13h AH=0x02 — Read Sectors (HD routing)', () => {
  it('DL=0x80 with HD mounted reads sector 0', () => {
    const h = makeHdHarness();
    // Stage a recognisable byte at LBA 0.
    const sec = new Uint8Array(512);
    sec[0] = 0xAB;
    sec[511] = 0xCD;
    h.ctx.disk!.writeSector(0, sec);

    h.cpu.regs.AH = 0x02;
    h.cpu.regs.AL = 1;            // 1 sector
    h.cpu.regs.CH = 0;            // cylinder 0
    h.cpu.regs.CL = 1;            // sector 1 (1-based)
    h.cpu.regs.DH = 0;            // head 0
    h.cpu.regs.DL = 0x80;         // HD
    h.cpu.regs.ES = 0x2000;
    h.cpu.regs.BX = 0x0000;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(h.cpu.regs.AL).toBe(1);
    expect(h.memory.readByte(0x20000)).toBe(0xAB);
    expect(h.memory.readByte(0x20000 + 511)).toBe(0xCD);
  });

  it('DL=0x00 with HD mounted → BAD_COMMAND, no read', () => {
    const h = makeHdHarness();
    h.cpu.regs.AH = 0x02;
    h.cpu.regs.AL = 1;
    h.cpu.regs.CH = 0; h.cpu.regs.CL = 1; h.cpu.regs.DH = 0;
    h.cpu.regs.DL = 0x00;          // wrong class
    h.cpu.regs.ES = 0x2000;
    h.cpu.regs.BX = 0x0000;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x01);    // BAD_COMMAND
    expect(h.cpu.regs.AL).toBe(0);
    expect(readPushedFlags(h.memory, h.cpu) & 0x0001).toBeTruthy();
  });
});

describe('BDA last-status mirror — HD path writes status', () => {
  it('AH=0x08 success path leaves BDA last-status = 0', () => {
    const h = makeHdHarness();
    const bda = new BiosDataArea(h.memory);
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(bda.readByte(BDA.DISK_LASTSTATUS)).toBe(0);
  });

  it('AH=0x08 cross-class error stores BAD_COMMAND in BDA', () => {
    const h = makeHdHarness();
    const bda = new BiosDataArea(h.memory);
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x00;          // wrong class
    int13Handler(h.cpu, h.ctx);
    expect(bda.readByte(BDA.DISK_LASTSTATUS)).toBe(0x01);
  });
});
