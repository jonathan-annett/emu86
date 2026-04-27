import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';
import { linearAddress } from '../../src/core/types.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0; cpu.regs.IP = 0;
  cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
  return cpu;
}

describe('INT n (0xCD)', () => {
  it('INT 0x21 jumps via vector 0x21', () => {
    // CD 21
    const cpu = cpuWith([0xCD, 0x21]);
    cpu.memory.writeWord(0x21 * 4 + 0, 0x4567);   // IP
    cpu.memory.writeWord(0x21 * 4 + 2, 0x1234);   // CS
    cpu.flags.IF = true; cpu.flags.TF = true; cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.CS).toBe(0x1234);
    expect(cpu.regs.IP).toBe(0x4567);
    // IF and TF cleared on entry; other flags untouched
    expect(cpu.flags.IF).toBe(false);
    expect(cpu.flags.TF).toBe(false);
    expect(cpu.flags.CF).toBe(true);
    // Stack should hold pushed flags, CS, IP (saved IP = 2, the byte after CD 21)
    expect(cpu.regs.SP).toBe(0x1000 - 6);
    expect(cpu.memory.readWord(linearAddress(0, 0x1000 - 2))).not.toBe(0); // pushed flags include IF
    expect(cpu.memory.readWord(linearAddress(0, 0x1000 - 4))).toBe(0);     // saved CS
    expect(cpu.memory.readWord(linearAddress(0, 0x1000 - 6))).toBe(2);     // saved IP
  });
});

describe('INT 3 (0xCC)', () => {
  it('INT 3 uses vector 3', () => {
    const cpu = cpuWith([0xCC]);
    cpu.memory.writeWord(3 * 4 + 0, 0xCAFE);
    cpu.memory.writeWord(3 * 4 + 2, 0xBEEF);
    cpu.step();
    expect(cpu.regs.IP).toBe(0xCAFE);
    expect(cpu.regs.CS).toBe(0xBEEF);
  });
});

describe('INTO (0xCE)', () => {
  it('INTO with OF=1 traps via vector 4', () => {
    const cpu = cpuWith([0xCE]);
    cpu.flags.OF = true;
    cpu.memory.writeWord(4 * 4 + 0, 0x1111);
    cpu.memory.writeWord(4 * 4 + 2, 0x2222);
    cpu.step();
    expect(cpu.regs.IP).toBe(0x1111);
    expect(cpu.regs.CS).toBe(0x2222);
  });

  it('INTO with OF=0 is a no-op', () => {
    const cpu = cpuWith([0xCE]);
    cpu.flags.OF = false;
    cpu.step();
    expect(cpu.regs.IP).toBe(1);    // just past INTO
    expect(cpu.regs.SP).toBe(0x1000); // stack unchanged
  });
});

describe('IRET (0xCF)', () => {
  it('IRET pops IP, CS, and flags', () => {
    // Lay out the post-INT stack manually, then run IRET.
    const cpu = cpuWith([0xCF]);
    // Stack growing down: SP=0x1000-6 contains [IP=0x0042, CS=0x0100, FLAGS]
    cpu.regs.SP = 0x1000 - 6;
    cpu.memory.writeWord(linearAddress(0, 0x1000 - 6), 0x0042);   // IP
    cpu.memory.writeWord(linearAddress(0, 0x1000 - 4), 0x0100);   // CS
    cpu.memory.writeWord(linearAddress(0, 0x1000 - 2), 0x0202);   // FLAGS (CF + IF set in low bits)
    cpu.step();
    expect(cpu.regs.IP).toBe(0x0042);
    expect(cpu.regs.CS).toBe(0x0100);
    expect(cpu.regs.SP).toBe(0x1000);
    expect(cpu.flags.IF).toBe(true);    // bit 9
    expect(cpu.flags.CF).toBe(false);   // bit 0 wasn't set in 0x0202
  });

  it('INT followed by IRET round-trips state', () => {
    // CD 80  CF — INT 0x80 then (after handler) IRET
    // But we test by simulating INT, then placing IRET at the handler.
    const cpu = cpuWith([0xCD, 0x80]);
    cpu.memory.writeByte(0x100, 0xCF);              // IRET at the handler
    cpu.memory.writeWord(0x80 * 4 + 0, 0x0100);     // vector → 0x0000:0x0100
    cpu.memory.writeWord(0x80 * 4 + 2, 0x0000);
    cpu.flags.CF = true;
    cpu.step();   // INT 0x80
    expect(cpu.regs.IP).toBe(0x0100);
    cpu.step();   // IRET
    expect(cpu.regs.IP).toBe(2);                    // back to byte after CD 80
    expect(cpu.flags.CF).toBe(true);                // restored
  });
});
