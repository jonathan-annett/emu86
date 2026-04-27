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
  cpu.regs.DS = 0; cpu.regs.ES = 0;
  cpu.flags.DF = false;     // increment direction
  return cpu;
}

describe('MOVS / LODS / STOS', () => {
  it('MOVSB copies one byte from DS:SI to ES:DI and increments both', () => {
    const cpu = cpuWith([0xA4]);
    cpu.regs.DS = 0; cpu.regs.SI = 0x100;
    cpu.regs.ES = 0; cpu.regs.DI = 0x200;
    cpu.memory.writeByte(0x100, 0x42);
    cpu.step();
    expect(cpu.memory.readByte(0x200)).toBe(0x42);
    expect(cpu.regs.SI).toBe(0x101);
    expect(cpu.regs.DI).toBe(0x201);
  });

  it('MOVSB with DF=1 decrements SI and DI', () => {
    const cpu = cpuWith([0xA4]);
    cpu.regs.DS = 0; cpu.regs.SI = 0x100; cpu.regs.DI = 0x200;
    cpu.flags.DF = true;
    cpu.step();
    expect(cpu.regs.SI).toBe(0xFF);
    expect(cpu.regs.DI).toBe(0x1FF);
  });

  it('MOVSW copies a word and advances by 2', () => {
    const cpu = cpuWith([0xA5]);
    cpu.regs.SI = 0x100; cpu.regs.DI = 0x200;
    cpu.memory.writeWord(0x100, 0xCAFE);
    cpu.step();
    expect(cpu.memory.readWord(0x200)).toBe(0xCAFE);
    expect(cpu.regs.SI).toBe(0x102);
    expect(cpu.regs.DI).toBe(0x202);
  });

  it('LODSB loads AL from DS:SI', () => {
    const cpu = cpuWith([0xAC]);
    cpu.regs.SI = 0x100;
    cpu.memory.writeByte(0x100, 0x77);
    cpu.step();
    expect(cpu.regs.AL).toBe(0x77);
    expect(cpu.regs.SI).toBe(0x101);
  });

  it('STOSB stores AL to ES:DI', () => {
    const cpu = cpuWith([0xAA]);
    cpu.regs.AL = 0x33; cpu.regs.DI = 0x300; cpu.regs.ES = 0;
    cpu.step();
    expect(cpu.memory.readByte(0x300)).toBe(0x33);
    expect(cpu.regs.DI).toBe(0x301);
  });

  it('STOS destination is always ES, NOT overridable by DS:', () => {
    // 3E AA  — DS: STOSB. The DS override should NOT redirect — destination is ES.
    const cpu = cpuWith([0x3E, 0xAA]);
    cpu.regs.AL = 0xAB; cpu.regs.DI = 0x400;
    cpu.regs.ES = 0x1000; cpu.regs.DS = 0x2000;
    cpu.step();
    expect(cpu.memory.readByte(linearAddress(0x1000, 0x400))).toBe(0xAB);
    expect(cpu.memory.readByte(linearAddress(0x2000, 0x400))).toBe(0);   // unchanged
  });

  it('LODS source defaults to DS but is overridable', () => {
    // 26 AC  — ES: LODSB
    const cpu = cpuWith([0x26, 0xAC]);
    cpu.regs.SI = 0x100;
    cpu.regs.DS = 0; cpu.regs.ES = 0x1000;
    cpu.memory.writeByte(linearAddress(0x1000, 0x100), 0xEE);
    cpu.memory.writeByte(linearAddress(0,      0x100), 0xDD);
    cpu.step();
    expect(cpu.regs.AL).toBe(0xEE);
  });
});

describe('CMPS / SCAS', () => {
  it('CMPSB sets ZF when bytes match', () => {
    const cpu = cpuWith([0xA6]);
    cpu.regs.SI = 0x100; cpu.regs.DI = 0x200;
    cpu.memory.writeByte(0x100, 0x42);
    cpu.memory.writeByte(0x200, 0x42);
    cpu.step();
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.regs.SI).toBe(0x101);
    expect(cpu.regs.DI).toBe(0x201);
  });

  it('CMPSB sets CF when [SI] < [DI]', () => {
    const cpu = cpuWith([0xA6]);
    cpu.regs.SI = 0x100; cpu.regs.DI = 0x200;
    cpu.memory.writeByte(0x100, 0x10);
    cpu.memory.writeByte(0x200, 0x20);
    cpu.step();
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(false);
  });

  it('SCASB compares AL against [ES:DI]', () => {
    const cpu = cpuWith([0xAE]);
    cpu.regs.AL = 0xAA; cpu.regs.DI = 0x100; cpu.regs.ES = 0;
    cpu.memory.writeByte(0x100, 0xAA);
    cpu.step();
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.regs.DI).toBe(0x101);
  });
});

describe('REP prefix (0xF3)', () => {
  it('REP MOVSB copies CX bytes', () => {
    // F3 A4
    const cpu = cpuWith([0xF3, 0xA4]);
    cpu.regs.SI = 0x100; cpu.regs.DI = 0x200; cpu.regs.CX = 5;
    for (let i = 0; i < 5; i++) cpu.memory.writeByte(0x100 + i, 0xA0 + i);
    cpu.step();
    for (let i = 0; i < 5; i++) {
      expect(cpu.memory.readByte(0x200 + i)).toBe(0xA0 + i);
    }
    expect(cpu.regs.CX).toBe(0);
    expect(cpu.regs.SI).toBe(0x105);
    expect(cpu.regs.DI).toBe(0x205);
  });

  it('REP with CX=0 executes zero iterations', () => {
    const cpu = cpuWith([0xF3, 0xA4]);
    cpu.regs.SI = 0x100; cpu.regs.DI = 0x200; cpu.regs.CX = 0;
    cpu.memory.writeByte(0x100, 0xFF);
    cpu.step();
    expect(cpu.memory.readByte(0x200)).toBe(0);     // not touched
    expect(cpu.regs.CX).toBe(0);
    expect(cpu.regs.SI).toBe(0x100);
  });

  it('REPE CMPSB stops at first mismatch (ZF=0)', () => {
    // F3 A6 — REPE CMPSB
    const cpu = cpuWith([0xF3, 0xA6]);
    cpu.regs.SI = 0x100; cpu.regs.DI = 0x200; cpu.regs.CX = 4;
    // First three bytes match, fourth mismatches
    cpu.memory.writeByte(0x100, 0xAA); cpu.memory.writeByte(0x200, 0xAA);
    cpu.memory.writeByte(0x101, 0xBB); cpu.memory.writeByte(0x201, 0xBB);
    cpu.memory.writeByte(0x102, 0xCC); cpu.memory.writeByte(0x202, 0xCC);
    cpu.memory.writeByte(0x103, 0xDD); cpu.memory.writeByte(0x203, 0xEE);
    cpu.step();
    expect(cpu.regs.CX).toBe(0);     // CX decrements every iteration; 4-4=0
    expect(cpu.regs.SI).toBe(0x104);
    expect(cpu.flags.ZF).toBe(false);
  });

  it('REPE CMPSB with all matches consumes all CX', () => {
    const cpu = cpuWith([0xF3, 0xA6]);
    cpu.regs.SI = 0x100; cpu.regs.DI = 0x200; cpu.regs.CX = 3;
    for (let i = 0; i < 3; i++) {
      cpu.memory.writeByte(0x100 + i, 0x42);
      cpu.memory.writeByte(0x200 + i, 0x42);
    }
    cpu.step();
    expect(cpu.regs.CX).toBe(0);
    expect(cpu.flags.ZF).toBe(true);
  });
});

describe('REPNE prefix (0xF2)', () => {
  it('REPNE SCASB stops at the first match', () => {
    // F2 AE — scan ES:DI for AL; stop when found.
    const cpu = cpuWith([0xF2, 0xAE]);
    cpu.regs.AL = 0x42; cpu.regs.DI = 0x100; cpu.regs.ES = 0;
    cpu.regs.CX = 8;
    cpu.memory.writeByte(0x100, 0x10);
    cpu.memory.writeByte(0x101, 0x20);
    cpu.memory.writeByte(0x102, 0x42);     // match here
    cpu.memory.writeByte(0x103, 0x99);
    cpu.step();
    expect(cpu.flags.ZF).toBe(true);       // last comparison matched
    // Found on third iter; CX 8 → 7 → 6 → 5 (decremented once per iter)
    expect(cpu.regs.CX).toBe(5);
    expect(cpu.regs.DI).toBe(0x103);       // moved past the match
  });

  it('REPNE with no match runs through CX', () => {
    const cpu = cpuWith([0xF2, 0xAE]);
    cpu.regs.AL = 0xFF; cpu.regs.DI = 0x100; cpu.regs.CX = 4;
    cpu.memory.writeByte(0x100, 0x01);
    cpu.memory.writeByte(0x101, 0x02);
    cpu.memory.writeByte(0x102, 0x03);
    cpu.memory.writeByte(0x103, 0x04);
    cpu.step();
    expect(cpu.regs.CX).toBe(0);
    expect(cpu.flags.ZF).toBe(false);      // never matched
  });
});
