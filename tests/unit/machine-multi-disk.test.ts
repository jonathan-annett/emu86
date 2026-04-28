/**
 * Phase 11 — IBMPCMachine multi-disk wiring.
 *
 * Confirms the machine config plumbs both `disk` (primary, back-compat
 * shape — every Phase 1-10 caller still works) and `secondaryDisk`
 * through to the BiosContext that the int13 handler closes over. Each
 * slot's drive-number reaches its own disk.
 */

import { describe, expect, it } from 'vitest';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';

const HD32 = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD64 = { cylinders: 131, heads: 16, sectorsPerTrack: 63 };
const FD144 = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };

function fireInt13(m: IBMPCMachine): void {
  const addr = m.bios!.layout.trapAddresses[0x13];
  if (addr === undefined) throw new Error('no trap address for INT 13h');
  const handler = m.traps!.get(addr);
  if (!handler) throw new Error('no handler at INT 13h trap');
  m.cpu.regs.SS = 0x0030;
  m.cpu.regs.SP = 0x0100;
  m.memory.writeWord((m.cpu.regs.SS << 4) + m.cpu.regs.SP + 4, 0x0202);
  handler(m.cpu);
}

describe('IBMPCMachine — secondary disk back-compat', () => {
  it('legacy single-disk shape still works (no secondary)', () => {
    // Pre-Phase-11 callers pass only `disk`. The fields default to "no
    // secondary" without any code change required.
    const disk = new InMemoryDisk({ geometry: HD32 });
    const m = new IBMPCMachine({ disk });
    expect(m.disk).toBe(disk);
    expect(m.diskClass).toBe('hard-disk');
    expect(m.secondaryDisk).toBeNull();
    expect(m.secondaryDiskClass).toBe('floppy');   // irrelevant default
  });

  it('secondary HD attaches and reports correct class', () => {
    const primary = new InMemoryDisk({ geometry: HD32 });
    const secondary = new InMemoryDisk({ geometry: HD64 });
    const m = new IBMPCMachine({ disk: primary, secondaryDisk: secondary });
    expect(m.disk).toBe(primary);
    expect(m.diskClass).toBe('hard-disk');
    expect(m.secondaryDisk).toBe(secondary);
    expect(m.secondaryDiskClass).toBe('hard-disk');
  });

  it('mixed HD primary + Floppy secondary infers both classes', () => {
    const primary = new InMemoryDisk({ geometry: HD32 });
    const secondary = new InMemoryDisk({ geometry: FD144 });
    const m = new IBMPCMachine({ disk: primary, secondaryDisk: secondary });
    expect(m.diskClass).toBe('hard-disk');
    expect(m.secondaryDiskClass).toBe('floppy');
  });

  it('explicit secondaryDiskClass override wins over geometry inference', () => {
    // Floppy geometry, but caller pins HD class — explicit wins.
    const primary = new InMemoryDisk({ geometry: FD144 });
    const secondary = new InMemoryDisk({ geometry: FD144 });
    const m = new IBMPCMachine({
      disk: primary,
      secondaryDisk: secondary,
      secondaryDiskClass: 'hard-disk',
    });
    expect(m.secondaryDiskClass).toBe('hard-disk');
  });
});

describe('IBMPCMachine — INT 13h reaches both slots', () => {
  it('HD primary + HD secondary: DL=0x80 hits primary, DL=0x81 hits secondary', () => {
    const primary = new InMemoryDisk({ geometry: HD32 });
    const secondary = new InMemoryDisk({ geometry: HD64 });
    // Sentinel-mark each slot's first sector so a misroute would surface.
    const p0 = new Uint8Array(512); p0[0] = 0x77;
    primary.writeSector(0, p0);
    const s0 = new Uint8Array(512); s0[0] = 0x88;
    secondary.writeSector(0, s0);

    const m = new IBMPCMachine({ disk: primary, secondaryDisk: secondary });
    m.reset();

    // Read primary into 0x2000:0
    m.cpu.regs.AH = 0x02;
    m.cpu.regs.AL = 1;
    m.cpu.regs.CH = 0;
    m.cpu.regs.CL = 1;
    m.cpu.regs.DH = 0;
    m.cpu.regs.DL = 0x80;
    m.cpu.regs.ES = 0x2000;
    m.cpu.regs.BX = 0x0000;
    fireInt13(m);
    expect(m.cpu.regs.AH).toBe(0);
    expect(m.memory.readByte(0x20000)).toBe(0x77);

    // Read secondary into 0x3000:0
    m.cpu.regs.AH = 0x02;
    m.cpu.regs.AL = 1;
    m.cpu.regs.CH = 0;
    m.cpu.regs.CL = 1;
    m.cpu.regs.DH = 0;
    m.cpu.regs.DL = 0x81;
    m.cpu.regs.ES = 0x3000;
    m.cpu.regs.BX = 0x0000;
    fireInt13(m);
    expect(m.cpu.regs.AH).toBe(0);
    expect(m.memory.readByte(0x30000)).toBe(0x88);
  });

  it('AH=08h count returned in DL is 2 when both slots are HDs', () => {
    const primary = new InMemoryDisk({ geometry: HD32 });
    const secondary = new InMemoryDisk({ geometry: HD64 });
    const m = new IBMPCMachine({ disk: primary, secondaryDisk: secondary });
    m.reset();

    m.cpu.regs.AH = 0x08;
    m.cpu.regs.DL = 0x80;
    fireInt13(m);
    expect(m.cpu.regs.AH).toBe(0);
    expect(m.cpu.regs.DL).toBe(2);
  });
});
