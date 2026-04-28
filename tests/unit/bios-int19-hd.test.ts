/**
 * Phase 10 — INT 19h boot drive number.
 *
 * Pins the DL value the BIOS hands the boot sector: 0x00 for floppy,
 * 0x80 for hard-disk. The ELKS kernel keys off this bit to pick
 * `/dev/fd0` vs `/dev/hda` (cite:
 * `reference/elks/elks/arch/i86/drivers/block/bios.c:446-473`,
 * `bios_conv_bios_drive` — `if (biosdrive & 0x80) ... hard drive ...`).
 *
 * The pre-Phase-10 floppy expectation lives in `bios-services.test.ts`;
 * tests here are HD-specific and supplement that.
 */

import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/cpu.js';
import { BasicIOBus } from '../../src/io/io-bus.js';
import { PagedMemory } from '../../src/memory/paged-memory.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import {
  int19Handler,
  type BiosContext,
} from '../../src/bios/bios-services.js';

interface BootHarness {
  cpu: CPU8086;
  memory: PagedMemory;
  ctx: BiosContext;
}

function makeBootHarness(opts: {
  diskClass: 'floppy' | 'hard-disk';
  geometry?: { cylinders: number; heads: number; sectorsPerTrack: number };
}): BootHarness {
  const memory = new PagedMemory({ addressSpaceSize: 0x100000 });
  const bus = new BasicIOBus();
  const cpu = new CPU8086(memory, bus);
  cpu.regs.SS = 0x0030;
  cpu.regs.SP = 0x0100;
  // Pushed FLAGS / CS:IP, like makeHarness in bios-services.test.ts.
  memory.writeWord((cpu.regs.SS << 4) + cpu.regs.SP + 4, 0x0202);
  memory.writeWord((cpu.regs.SS << 4) + cpu.regs.SP, 0xDEAD);
  memory.writeWord((cpu.regs.SS << 4) + cpu.regs.SP + 2, 0xBEEF);

  const geometry = opts.geometry
    ?? (opts.diskClass === 'hard-disk'
      ? { cylinders: 63, heads: 16, sectorsPerTrack: 63 }
      : { cylinders: 80, heads: 2, sectorsPerTrack: 18 });
  const disk = new InMemoryDisk({ geometry });

  // Stage a plausible boot sector so the load itself succeeds.
  const sec = new Uint8Array(512);
  sec[0] = 0xEB; sec[1] = 0x3C;
  sec[510] = 0x55; sec[511] = 0xAA;
  disk.writeSector(0, sec);

  const ctx: BiosContext = {
    console: new InMemoryConsole(),
    disk,
    diskClass: opts.diskClass,
    hostClock: new InMemoryHostClock(),
    warn: () => { /* silent */ },
    eoiPort: 0x20,
  };
  return { cpu, memory, ctx };
}

describe('INT 19h — boot drive number derivation', () => {
  it('floppy class → DL = 0x00 after handler', () => {
    const h = makeBootHarness({ diskClass: 'floppy' });
    int19Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DL).toBe(0x00);
    // Pushed CS:IP should be 0:7C00 (boot sector entry point).
    const baseAddr = (h.cpu.regs.SS << 4) + h.cpu.regs.SP;
    expect(h.memory.readWord(baseAddr)).toBe(0x7C00);
    expect(h.memory.readWord(baseAddr + 2)).toBe(0x0000);
    // Boot sector loaded at 0:7C00.
    expect(h.memory.readByte(0x7C00)).toBe(0xEB);
    expect(h.memory.readByte(0x7DFE)).toBe(0x55);
    expect(h.memory.readByte(0x7DFF)).toBe(0xAA);
  });

  it('hard-disk class → DL = 0x80 after handler', () => {
    const h = makeBootHarness({ diskClass: 'hard-disk' });
    int19Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DL).toBe(0x80);
    const baseAddr = (h.cpu.regs.SS << 4) + h.cpu.regs.SP;
    expect(h.memory.readWord(baseAddr)).toBe(0x7C00);
    expect(h.memory.readWord(baseAddr + 2)).toBe(0x0000);
    // Boot sector still loaded — HD path reads the same LBA 0.
    expect(h.memory.readByte(0x7C00)).toBe(0xEB);
  });

  it('hard-disk DL high bit set is what ELKS reads to pick /dev/hda', () => {
    // This is a meta-pin: explicitly check (DL & 0x80) — the kernel's exact
    // discriminator at `bios.c:446`.
    const h = makeBootHarness({ diskClass: 'hard-disk' });
    int19Handler(h.cpu, h.ctx);
    expect(h.cpu.regs.DL & 0x80).toBe(0x80);
  });
});
