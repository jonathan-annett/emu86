/**
 * Phase 10 — IBMPCMachine disk-class routing.
 *
 * Confirms the wiring: a HD-class disk attached to the machine surfaces
 * via `machine.diskClass = 'hard-disk'` and routes INT 13h read/write
 * requests on DL=0x80; a floppy-class disk surfaces as 'floppy' and
 * routes on DL=0x00. Cross-class requests bounce with BAD_COMMAND.
 *
 * Tests construct the full machine (BIOS loaded) and call int13Handler
 * via the trap registry — the same path real guest code would take.
 */

import { describe, expect, it } from 'vitest';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';

const HD_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const FD_GEOMETRY = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };

describe('IBMPCMachine — disk-class derivation', () => {
  it('attaches an HD-geometry disk as hard-disk class by default', () => {
    const disk = new InMemoryDisk({ geometry: HD_GEOMETRY });
    const m = new IBMPCMachine({ disk });
    expect(m.diskClass).toBe('hard-disk');
    expect(m.disk).toBe(disk);
  });

  it('attaches a floppy-geometry disk as floppy class by default', () => {
    const disk = new InMemoryDisk({ geometry: FD_GEOMETRY });
    const m = new IBMPCMachine({ disk });
    expect(m.diskClass).toBe('floppy');
  });

  it('honours an explicit diskClass override', () => {
    // Floppy geometry, but caller pins HD class — explicit wins.
    const disk = new InMemoryDisk({ geometry: FD_GEOMETRY });
    const m = new IBMPCMachine({ disk, diskClass: 'hard-disk' });
    expect(m.diskClass).toBe('hard-disk');
  });

  it('defaults to floppy when no disk is attached', () => {
    const m = new IBMPCMachine({});
    expect(m.diskClass).toBe('floppy');
    expect(m.disk).toBeNull();
  });
});

describe('IBMPCMachine — INT 13h drive routing', () => {
  // Helper that fires the BIOS handler for INT 13h via the trap registry.
  // We don't run a real INT N here — we look up the trap address and invoke
  // the JS handler directly, identical to how the cpu-bios-integration test
  // exercises the path.
  function fireInt13(m: IBMPCMachine): void {
    const addr = m.bios!.layout.trapAddresses[0x13];
    if (addr === undefined) throw new Error('no trap address for INT 13h');
    const handler = m.traps!.get(addr);
    if (!handler) throw new Error('no handler at INT 13h trap');
    // Handlers expect SS:SP+4 to hold pushed FLAGS — seed it.
    m.cpu.regs.SS = 0x0030;
    m.cpu.regs.SP = 0x0100;
    m.memory.writeWord((m.cpu.regs.SS << 4) + m.cpu.regs.SP + 4, 0x0202);
    handler(m.cpu);
  }

  it('HD machine: AH=0x08 with DL=0x80 succeeds, DL=0x00 errors', () => {
    const disk = new InMemoryDisk({ geometry: HD_GEOMETRY });
    const m = new IBMPCMachine({ disk });
    m.reset();

    m.cpu.regs.AH = 0x08;
    m.cpu.regs.DL = 0x80;
    fireInt13(m);
    expect(m.cpu.regs.AH).toBe(0);          // success
    expect(m.cpu.regs.DH).toBe(15);         // heads-1 for HD geometry

    m.cpu.regs.AH = 0x08;
    m.cpu.regs.DL = 0x00;                    // wrong class
    fireInt13(m);
    expect(m.cpu.regs.AH).toBe(0x01);       // BAD_COMMAND
  });

  it('Floppy machine: AH=0x08 with DL=0x00 succeeds, DL=0x80 errors', () => {
    const disk = new InMemoryDisk({ geometry: FD_GEOMETRY });
    const m = new IBMPCMachine({ disk });
    m.reset();

    m.cpu.regs.AH = 0x08;
    m.cpu.regs.DL = 0x00;
    fireInt13(m);
    expect(m.cpu.regs.AH).toBe(0);
    expect(m.cpu.regs.DH).toBe(1);          // heads-1 for floppy

    m.cpu.regs.AH = 0x08;
    m.cpu.regs.DL = 0x80;                    // wrong class
    fireInt13(m);
    expect(m.cpu.regs.AH).toBe(0x01);
  });

  it('HD machine: AH=0x02 sector read on DL=0x80 returns the staged byte', () => {
    const disk = new InMemoryDisk({ geometry: HD_GEOMETRY });
    const sec = new Uint8Array(512);
    sec[0] = 0x77;
    disk.writeSector(0, sec);
    const m = new IBMPCMachine({ disk });
    m.reset();

    m.cpu.regs.AH = 0x02;
    m.cpu.regs.AL = 1;
    m.cpu.regs.CH = 0;
    m.cpu.regs.CL = 1;        // sector 1 = LBA 0
    m.cpu.regs.DH = 0;
    m.cpu.regs.DL = 0x80;
    m.cpu.regs.ES = 0x2000;
    m.cpu.regs.BX = 0x0000;
    fireInt13(m);
    expect(m.cpu.regs.AH).toBe(0);
    expect(m.cpu.regs.AL).toBe(1);
    expect(m.memory.readByte(0x20000)).toBe(0x77);
  });
});
