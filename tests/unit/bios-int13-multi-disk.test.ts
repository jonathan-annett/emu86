/**
 * Phase 11 — INT 13h multi-disk routing.
 *
 * Pins the per-slot drive-number routing table from the brief:
 *
 *   | DL    | Floppy primary | Floppy secondary | HD primary | HD secondary |
 *   | 0x00  | →primary       | not present      | not present| not present  |
 *   | 0x01  | not present    | →secondary       | not present| not present  |
 *   | 0x80  | not present    | not present      | →primary   | not present  |
 *   | 0x81  | not present    | not present      | not present| →secondary   |
 *
 * Plus per-class drive-count for AH=08h (1 / 2 depending on configuration)
 * and per-drive geometry — each slot's CHS is reported independently of
 * the other.
 *
 * Phase 10's single-disk tests live in `bios-int13-hd.test.ts` and
 * `machine-disk-routing.test.ts` and remain unchanged. These tests are
 * additive — they exercise the new code path that activates only when a
 * `secondaryDisk` is wired into the BiosContext.
 */

import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/cpu.js';
import { BasicIOBus } from '../../src/io/io-bus.js';
import { PagedMemory } from '../../src/memory/paged-memory.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import {
  int13Handler,
  type BiosContext,
} from '../../src/bios/bios-services.js';

const HD32 = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD64 = { cylinders: 131, heads: 16, sectorsPerTrack: 63 };
const FD144 = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };
const FD120 = { cylinders: 80, heads: 2, sectorsPerTrack: 15 };

interface Slot {
  geometry: { cylinders: number; heads: number; sectorsPerTrack: number };
  cls: 'floppy' | 'hard-disk';
}

interface Harness {
  cpu: CPU8086;
  memory: PagedMemory;
  ctx: BiosContext;
  primary: InMemoryDisk;
  secondary: InMemoryDisk | null;
}

function makeHarness(primary: Slot, secondary: Slot | null): Harness {
  const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
  const bus = new BasicIOBus();
  const cpu = new CPU8086(memory, bus);
  cpu.regs.SS = 0x0030;
  cpu.regs.SP = 0x0100;
  memory.writeWord((cpu.regs.SS << 4) + cpu.regs.SP + 4, 0x0202);

  const primaryDisk = new InMemoryDisk({ geometry: primary.geometry });
  const secondaryDisk = secondary ? new InMemoryDisk({ geometry: secondary.geometry }) : null;
  const ctx: BiosContext = {
    console: new InMemoryConsole(),
    disk: primaryDisk,
    diskClass: primary.cls,
    secondaryDisk,
    secondaryDiskClass: secondary?.cls ?? 'floppy',
    hostClock: new InMemoryHostClock(),
    warn: () => { /* silent */ },
    eoiPort: 0x20,
    extendedMemoryKb: 0,
  };
  return { cpu, memory, ctx, primary: primaryDisk, secondary: secondaryDisk };
}

function readPushedFlags(memory: PagedMemory, cpu: CPU8086): number {
  return memory.readWord((cpu.regs.SS << 4) + cpu.regs.SP + 4);
}

describe('INT 13h AH=0x08 routing — DL → slot table', () => {
  // The brief's routing matrix has 8 cells we care about. Each call below
  // hits one cell and asserts whether the response is "drive present" (CF=0,
  // AH=0) or "not present" (CF=1, AH=0x01).

  it('HD primary + HD secondary: DL=0x80 routes to primary, returns its geometry', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: HD64, cls: 'hard-disk' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(h.cpu.regs.CH).toBe(62);          // HD32 cyl-1
  });

  it('HD primary + HD secondary: DL=0x81 routes to secondary, returns its geometry', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: HD64, cls: 'hard-disk' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x81;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    // HD64 has 131 cylinders → CH = (131-1) & 0xFF = 130
    expect(h.cpu.regs.CH).toBe(130);
  });

  it('HD primary + HD secondary: DL=0x00 not present (no floppies)', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: HD64, cls: 'hard-disk' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x00;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x01);
    expect(readPushedFlags(h.memory, h.cpu) & 0x01).toBe(0x01);
  });

  it('HD primary + Floppy secondary: DL=0x00 routes to secondary (it is the only floppy)', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: FD144, cls: 'floppy' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x00;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(h.cpu.regs.DH).toBe(1);          // 1.44M floppy: heads-1=1
  });

  it('HD primary + Floppy secondary: DL=0x01 not present', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: FD144, cls: 'floppy' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x01;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x01);
  });

  it('Floppy primary + Floppy secondary: DL=0x00 routes to primary', () => {
    const h = makeHarness({ geometry: FD144, cls: 'floppy' }, { geometry: FD120, cls: 'floppy' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x00;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(h.cpu.regs.CL & 0x3F).toBe(18);  // 1.44M floppy: 18 spt
  });

  it('Floppy primary + Floppy secondary: DL=0x01 routes to secondary', () => {
    const h = makeHarness({ geometry: FD144, cls: 'floppy' }, { geometry: FD120, cls: 'floppy' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x01;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(h.cpu.regs.CL & 0x3F).toBe(15);  // 1.2M floppy: 15 spt
  });

  it('Floppy primary + Floppy secondary: DL=0x80 not present (no HDs)', () => {
    const h = makeHarness({ geometry: FD144, cls: 'floppy' }, { geometry: FD120, cls: 'floppy' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x01);
  });

  it('Floppy primary + HD secondary: DL=0x80 routes to secondary', () => {
    const h = makeHarness({ geometry: FD144, cls: 'floppy' }, { geometry: HD32, cls: 'hard-disk' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(h.cpu.regs.DH).toBe(15);         // HD32: heads-1
  });
});

describe('INT 13h AH=0x08 — per-class drive count in DL', () => {
  it('HD primary + HD secondary: count = 2 in DL on AH=08h', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: HD64, cls: 'hard-disk' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DL).toBe(2);
  });

  it('HD primary alone: count = 1', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, null);
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DL).toBe(1);
  });

  it('HD primary + Floppy secondary: querying HD slot returns 1 HD, querying floppy slot returns 1 floppy', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: FD144, cls: 'floppy' });
    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x80;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DL).toBe(1);

    h.cpu.regs.AH = 0x08;
    h.cpu.regs.DL = 0x00;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DL).toBe(1);
  });
});

describe('INT 13h AH=0x02 — read sectors honour secondary disk', () => {
  it('HD primary + HD secondary: read on DL=0x81 lands the secondary\'s bytes', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: HD64, cls: 'hard-disk' });
    // Stage a recognisable byte at LBA 0 of each disk so the test catches
    // a misroute: primary[0] = 0xAA, secondary[0] = 0xBB.
    const pSec = new Uint8Array(512);
    pSec[0] = 0xAA;
    h.primary.writeSector(0, pSec);
    const sSec = new Uint8Array(512);
    sSec[0] = 0xBB;
    h.secondary!.writeSector(0, sSec);

    h.cpu.regs.AH = 0x02;
    h.cpu.regs.AL = 1;
    h.cpu.regs.CH = 0;
    h.cpu.regs.CL = 1;          // sector 1 (1-based) = LBA 0
    h.cpu.regs.DH = 0;
    h.cpu.regs.DL = 0x81;        // secondary HD
    h.cpu.regs.ES = 0x2000;
    h.cpu.regs.BX = 0x0000;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(h.memory.readByte(0x20000)).toBe(0xBB);
  });

  it('HD primary + Floppy secondary: read on DL=0x00 lands the floppy bytes', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, { geometry: FD144, cls: 'floppy' });
    const sSec = new Uint8Array(512);
    sSec[0] = 0xCD;
    h.secondary!.writeSector(0, sSec);

    h.cpu.regs.AH = 0x02;
    h.cpu.regs.AL = 1;
    h.cpu.regs.CH = 0;
    h.cpu.regs.CL = 1;
    h.cpu.regs.DH = 0;
    h.cpu.regs.DL = 0x00;        // the only floppy
    h.cpu.regs.ES = 0x3000;
    h.cpu.regs.BX = 0x0000;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0);
    expect(h.memory.readByte(0x30000)).toBe(0xCD);
  });

  it('Read on absent slot returns CF=1 + AH=0x01 (drive not present)', () => {
    const h = makeHarness({ geometry: HD32, cls: 'hard-disk' }, null);
    h.cpu.regs.AH = 0x02;
    h.cpu.regs.AL = 1;
    h.cpu.regs.CH = 0;
    h.cpu.regs.CL = 1;
    h.cpu.regs.DH = 0;
    h.cpu.regs.DL = 0x81;        // no secondary attached
    h.cpu.regs.ES = 0x2000;
    h.cpu.regs.BX = 0x0000;
    int13Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.AH).toBe(0x01);
    expect(readPushedFlags(h.memory, h.cpu) & 0x01).toBe(0x01);
  });
});
