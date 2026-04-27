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

describe('MOV r/m, r and r, r/m (0x88-0x8B)', () => {
  it('MOV r/m8, r8: register destination (mod=11)', () => {
    // 88 D8 = MOV AL, BL  (mod=11, reg=BL(3), rm=AL(0))
    const cpu = cpuWith([0x88, 0xD8]);
    cpu.regs.AL = 0x00; cpu.regs.BL = 0x77;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x77);
  });

  it('MOV r/m16, r16: memory destination via [BX]', () => {
    // 89 07 = MOV [BX], AX  (mod=00, reg=AX(0), rm=111=[BX])
    const cpu = cpuWith([0x89, 0x07]);
    cpu.regs.AX = 0xCAFE; cpu.regs.BX = 0x100;
    cpu.step();
    expect(cpu.memory.readWord(0x100)).toBe(0xCAFE);
  });

  it('MOV r8, r/m8: load AL from [BX+SI]', () => {
    // 8A 00 = MOV AL, [BX+SI]
    const cpu = cpuWith([0x8A, 0x00]);
    cpu.regs.BX = 0x100; cpu.regs.SI = 0x10;
    cpu.memory.writeByte(0x110, 0x42);
    cpu.step();
    expect(cpu.regs.AL).toBe(0x42);
  });

  it('MOV r16, r/m16: register-to-register (mod=11)', () => {
    // 8B C3 = MOV AX, BX
    const cpu = cpuWith([0x8B, 0xC3]);
    cpu.regs.BX = 0x1234;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x1234);
  });

  it('MOV does not touch flags', () => {
    const cpu = cpuWith([0x88, 0xD8]);
    cpu.flags.CF = true; cpu.flags.ZF = true; cpu.flags.SF = true;
    cpu.regs.BL = 0;
    cpu.step();
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.SF).toBe(true);
  });

  it('MOV with [disp16] direct addressing', () => {
    // 8B 1E 00 02 = MOV BX, [0x0200]   (mod=00, reg=BX, rm=110 → disp16)
    const cpu = cpuWith([0x8B, 0x1E, 0x00, 0x02]);
    cpu.memory.writeWord(0x200, 0xBEEF);
    cpu.step();
    expect(cpu.regs.BX).toBe(0xBEEF);
  });
});

describe('MOV with segment registers (0x8C / 0x8E)', () => {
  it('MOV r/m16, sreg stores ES into AX', () => {
    // 8C C0 = MOV AX, ES  (mod=11, reg=000=ES, rm=000=AX)
    const cpu = cpuWith([0x8C, 0xC0]);
    cpu.regs.ES = 0x1234;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x1234);
  });

  it('MOV sreg, r/m16 loads DS from AX', () => {
    // 8E D8 = MOV DS, AX  (mod=11, reg=011=DS, rm=000=AX)
    const cpu = cpuWith([0x8E, 0xD8]);
    cpu.regs.AX = 0xABCD;
    cpu.step();
    expect(cpu.regs.DS).toBe(0xABCD);
  });

  it('MOV sreg, [mem] loads from memory', () => {
    // 8E 06 00 02 = MOV ES, [0x0200]  (reg=000=ES, mod=00 rm=110 disp16)
    const cpu = cpuWith([0x8E, 0x06, 0x00, 0x02]);
    cpu.memory.writeWord(0x200, 0x4000);
    cpu.step();
    expect(cpu.regs.ES).toBe(0x4000);
  });

  it('MOV sreg masks /reg & 3 (high bit ignored)', () => {
    // 8E F8 = /reg=111 → 011=DS after & 3
    const cpu = cpuWith([0x8E, 0xF8]);
    cpu.regs.AX = 0x9999;
    cpu.step();
    expect(cpu.regs.DS).toBe(0x9999);
  });
});

describe('MOV moffs accumulator (0xA0-0xA3)', () => {
  it('MOV AL, [moffs8] loads from DS:offset', () => {
    // A0 50 01 = MOV AL, [0x0150]
    const cpu = cpuWith([0xA0, 0x50, 0x01]);
    cpu.memory.writeByte(0x150, 0x77);
    cpu.step();
    expect(cpu.regs.AL).toBe(0x77);
  });

  it('MOV AX, [moffs16] loads a word', () => {
    // A1 50 01 = MOV AX, [0x0150]
    const cpu = cpuWith([0xA1, 0x50, 0x01]);
    cpu.memory.writeWord(0x150, 0xCAFE);
    cpu.step();
    expect(cpu.regs.AX).toBe(0xCAFE);
  });

  it('MOV [moffs8], AL stores AL', () => {
    // A2 50 01 = MOV [0x0150], AL
    const cpu = cpuWith([0xA2, 0x50, 0x01]);
    cpu.regs.AL = 0x88;
    cpu.step();
    expect(cpu.memory.readByte(0x150)).toBe(0x88);
  });

  it('MOV [moffs16], AX stores AX', () => {
    // A3 50 01 = MOV [0x0150], AX
    const cpu = cpuWith([0xA3, 0x50, 0x01]);
    cpu.regs.AX = 0xBEEF;
    cpu.step();
    expect(cpu.memory.readWord(0x150)).toBe(0xBEEF);
  });

  it('MOV moffs honours segment override (ES:)', () => {
    // 26 A0 50 01 = MOV AL, ES:[0x0150]
    const cpu = cpuWith([0x26, 0xA0, 0x50, 0x01]);
    cpu.regs.ES = 0x1000; cpu.regs.DS = 0x2000;
    cpu.memory.writeByte(linearAddress(0x1000, 0x150), 0xEE);
    cpu.memory.writeByte(linearAddress(0x2000, 0x150), 0xDD);
    cpu.step();
    expect(cpu.regs.AL).toBe(0xEE);
  });
});

describe('MOV r/m, imm (0xC6 / 0xC7)', () => {
  it('MOV r/m8, imm8 to register (mod=11)', () => {
    // C6 C0 42 = MOV AL, 0x42
    const cpu = cpuWith([0xC6, 0xC0, 0x42]);
    cpu.step();
    expect(cpu.regs.AL).toBe(0x42);
  });

  it('MOV r/m16, imm16 to memory via [disp16]', () => {
    // C7 06 00 02 EF BE = MOV WORD [0x0200], 0xBEEF
    const cpu = cpuWith([0xC7, 0x06, 0x00, 0x02, 0xEF, 0xBE]);
    cpu.step();
    expect(cpu.memory.readWord(0x200)).toBe(0xBEEF);
  });

  it('MOV r/m16, imm16 with displacement: [BX+disp8]', () => {
    // C7 47 04 34 12 = MOV WORD [BX+4], 0x1234
    const cpu = cpuWith([0xC7, 0x47, 0x04, 0x34, 0x12]);
    cpu.regs.BX = 0x100;
    cpu.step();
    expect(cpu.memory.readWord(0x104)).toBe(0x1234);
  });

  it('MOV r/m8, imm8 with /reg != 0 still does MOV (8086 silicon ignores /reg)', () => {
    // C6 C8 42 = mod=11 reg=001 rm=000 → AL on 8086 silicon (the /reg field
    // isn't decoded for this group; corpus opcode 0xC6 confirms with /reg=1..7
    // cases that all expect a MOV).
    const cpu = cpuWith([0xC6, 0xC8, 0x42]);
    cpu.step();
    expect(cpu.regs.AL).toBe(0x42);
  });

  it('MOV r/m16, imm16 with /reg != 0 still does MOV', () => {
    // C7 C8 34 12 = same sub-op pattern, 16-bit form → AX = 0x1234
    const cpu = cpuWith([0xC7, 0xC8, 0x34, 0x12]);
    cpu.step();
    expect(cpu.regs.AX).toBe(0x1234);
  });
});
