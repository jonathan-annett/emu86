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
  cpu.regs.DS = 0; cpu.regs.ES = 0; cpu.regs.SS = 0;
  return cpu;
}

describe('LEA (0x8D)', () => {
  it('LEA loads the EA offset, not the memory contents', () => {
    // 8D 1F = LEA BX, [BX]
    const cpu = cpuWith([0x8D, 0x1F]);
    cpu.regs.BX = 0x100;
    cpu.memory.writeWord(0x100, 0xDEAD);
    cpu.step();
    expect(cpu.regs.BX).toBe(0x100);   // not 0xDEAD
  });

  it('LEA computes [BX+SI+disp8]', () => {
    // 8D 40 04 = LEA AX, [BX+SI+4]
    const cpu = cpuWith([0x8D, 0x40, 0x04]);
    cpu.regs.BX = 0x100; cpu.regs.SI = 0x10;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x114);
  });

  it('LEA with [disp16] direct address', () => {
    // 8D 1E 34 12 = LEA BX, [0x1234]
    const cpu = cpuWith([0x8D, 0x1E, 0x34, 0x12]);
    cpu.step();
    expect(cpu.regs.BX).toBe(0x1234);
  });

  it('LEA does not touch flags', () => {
    const cpu = cpuWith([0x8D, 0x1E, 0x34, 0x12]);
    cpu.flags.CF = true; cpu.flags.ZF = true;
    cpu.step();
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
  });

  it('LEA with mod=11 throws', () => {
    // 8D C0 = LEA AX, AX (illegal)
    const cpu = cpuWith([0x8D, 0xC0]);
    expect(() => cpu.step()).toThrow();
  });
});

describe('LDS (0xC5) / LES (0xC4)', () => {
  it('LES loads offset into r16 and segment into ES', () => {
    // C4 1E 00 02 = LES BX, [0x0200]
    const cpu = cpuWith([0xC4, 0x1E, 0x00, 0x02]);
    cpu.memory.writeWord(0x200, 0x1234);   // offset
    cpu.memory.writeWord(0x202, 0x5678);   // segment
    cpu.step();
    expect(cpu.regs.BX).toBe(0x1234);
    expect(cpu.regs.ES).toBe(0x5678);
  });

  it('LDS loads offset into r16 and segment into DS', () => {
    // C5 1E 00 02 = LDS BX, [0x0200]
    const cpu = cpuWith([0xC5, 0x1E, 0x00, 0x02]);
    cpu.memory.writeWord(0x200, 0xCAFE);
    cpu.memory.writeWord(0x202, 0xBABE);
    cpu.step();
    expect(cpu.regs.BX).toBe(0xCAFE);
    expect(cpu.regs.DS).toBe(0xBABE);
  });

  it('LDS honours segment override on the source', () => {
    // 26 C5 1E 00 02 = ES: LDS BX, [0x0200]
    const cpu = cpuWith([0x26, 0xC5, 0x1E, 0x00, 0x02]);
    cpu.regs.DS = 0; cpu.regs.ES = 0x1000;
    cpu.memory.writeWord(linearAddress(0x1000, 0x200), 0x1111);
    cpu.memory.writeWord(linearAddress(0x1000, 0x202), 0x2222);
    cpu.step();
    expect(cpu.regs.BX).toBe(0x1111);
    expect(cpu.regs.DS).toBe(0x2222);
  });

  it('LES with mod=11 throws', () => {
    const cpu = cpuWith([0xC4, 0xC0]);
    expect(() => cpu.step()).toThrow();
  });
});
