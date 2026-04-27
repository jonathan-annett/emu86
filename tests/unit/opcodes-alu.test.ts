import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';
import { linearAddress } from '../../src/core/types.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0;
  cpu.regs.IP = 0;
  cpu.regs.DS = 0;
  cpu.regs.SS = 0;
  cpu.regs.ES = 0;
  return cpu;
}

/**
 * The 8086 ALU family covers ADD/OR/ADC/SBB/AND/SUB/XOR/CMP. Each shares
 * six encodings (r/m←r, r←r/m, both widths, accumulator-immediate). The
 * SST corpus is the exhaustive validator; here we cover one representative
 * case per encoding per family plus the trickier flag edges.
 */

describe('ALU family — encodings', () => {
  // ----------------------------------------------------------------
  // OP r/m8, r8     (base+0)  — write to r/m, read from /reg
  // ----------------------------------------------------------------
  it('ADD r/m8, r8 (0x00) — register destination', () => {
    // 00 D8  =  ADD AL, BL  (mod=11, /reg=BL=3, /rm=AL=0)
    const cpu = cpuWith([0x00, 0xD8]);
    cpu.regs.AL = 0x05; cpu.regs.BL = 0x03;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x08);
    expect(cpu.regs.BL).toBe(0x03);
  });

  it('SUB r/m8, r8 (0x28) — sets CF on borrow', () => {
    // 28 D8  =  SUB AL, BL
    const cpu = cpuWith([0x28, 0xD8]);
    cpu.regs.AL = 0x01; cpu.regs.BL = 0x02;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFF);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.SF).toBe(true);
  });

  // ----------------------------------------------------------------
  // OP r/m16, r16   (base+1)
  // ----------------------------------------------------------------
  it('AND r/m16, r16 (0x21) — clears CF/OF, sets PF/ZF/SF normally', () => {
    // 21 D8  =  AND AX, BX
    const cpu = cpuWith([0x21, 0xD8]);
    cpu.regs.AX = 0xFF00; cpu.regs.BX = 0x00FF;
    cpu.flags.CF = true; cpu.flags.OF = true;   // should be cleared
    cpu.step();
    expect(cpu.regs.AX).toBe(0x0000);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(false);
  });

  // ----------------------------------------------------------------
  // OP r8, r/m8     (base+2)  — write to /reg, read from r/m
  // ----------------------------------------------------------------
  it('XOR r8, r/m8 (0x32) — register-on-self zeros and sets ZF/PF, clears SF', () => {
    // 32 C0  =  XOR AL, AL
    const cpu = cpuWith([0x32, 0xC0]);
    cpu.regs.AL = 0x55;
    cpu.step();
    expect(cpu.regs.AL).toBe(0);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.PF).toBe(true);
    expect(cpu.flags.SF).toBe(false);
    expect(cpu.flags.CF).toBe(false);
  });

  // ----------------------------------------------------------------
  // OP r16, r/m16   (base+3)  — with memory operand to exercise ModR/M EA
  // ----------------------------------------------------------------
  it('OR r16, r/m16 (0x0B) — reads through DS:[BX]', () => {
    // 0B 07  =  OR AX, [BX]   (mod=00, /reg=AX, /rm=[BX])
    const cpu = cpuWith([0x0B, 0x07]);
    cpu.regs.AX = 0x00F0; cpu.regs.BX = 0x0100; cpu.regs.DS = 0x0010;
    cpu.memory.writeWord(linearAddress(0x0010, 0x0100), 0x000F);
    cpu.step();
    expect(cpu.regs.AX).toBe(0x00FF);
  });

  // ----------------------------------------------------------------
  // OP AL/AX, imm   (base+4 / base+5)
  // ----------------------------------------------------------------
  it('CMP AL, imm8 (0x3C) — sets ZF on equality, no writeback', () => {
    // 3C 42  =  CMP AL, 0x42
    const cpu = cpuWith([0x3C, 0x42]);
    cpu.regs.AL = 0x42;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x42);     // no writeback
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.CF).toBe(false);
  });

  it('CMP AX, imm16 (0x3D) — sets CF when AX < imm', () => {
    // 3D 00 10  =  CMP AX, 0x1000
    const cpu = cpuWith([0x3D, 0x00, 0x10]);
    cpu.regs.AX = 0x0500;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x0500);   // no writeback
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(false);
  });

  // ----------------------------------------------------------------
  // ADC / SBB carry-in propagation
  // ----------------------------------------------------------------
  it('ADC AL, imm8 (0x14) — adds carry-in', () => {
    // 14 02  =  ADC AL, 2  (with CF=1)
    const cpu = cpuWith([0x14, 0x02]);
    cpu.regs.AL = 0x10; cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x13);     // 0x10 + 2 + 1
  });

  it('SBB AL, imm8 (0x1C) — subtracts carry-in', () => {
    const cpu = cpuWith([0x1C, 0x02]);
    cpu.regs.AL = 0x10; cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x0D);     // 0x10 - 2 - 1
  });

  // ----------------------------------------------------------------
  // 0x80 / 0x81 / 0x82 / 0x83 — ModR/M-driven sub-op
  // ----------------------------------------------------------------
  it('0x80 with /reg=0 (ADD) and r/m=AL', () => {
    // 80 C0 05  =  ADD AL, 5  (mod=11, /reg=000=ADD, /rm=000=AL)
    const cpu = cpuWith([0x80, 0xC0, 0x05]);
    cpu.regs.AL = 0x10;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x15);
  });

  it('0x80 with /reg=7 (CMP) and r/m=AL — does not write back', () => {
    // 80 F8 10  =  CMP AL, 0x10  (mod=11, /reg=111=CMP, /rm=000=AL)
    const cpu = cpuWith([0x80, 0xF8, 0x10]);
    cpu.regs.AL = 0x10;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x10);
    expect(cpu.flags.ZF).toBe(true);
  });

  it('0x81 with /reg=4 (AND) and r/m=AX', () => {
    // 81 E0 0F 00  =  AND AX, 0x000F
    const cpu = cpuWith([0x81, 0xE0, 0x0F, 0x00]);
    cpu.regs.AX = 0xABCD;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x000D);
    expect(cpu.flags.CF).toBe(false);   // AND clears CF
  });

  it('0x82 is an alias of 0x80 on 8086', () => {
    // 82 C0 05  =  ADD AL, 5  (same as 80 C0 05)
    const cpu = cpuWith([0x82, 0xC0, 0x05]);
    cpu.regs.AL = 0x10;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x15);
  });

  it('0x83 sign-extends imm8 to 16 bits before applying', () => {
    // 83 C0 FF  =  ADD AX, -1   (mod=11 /reg=000=ADD /rm=000=AX)
    const cpu = cpuWith([0x83, 0xC0, 0xFF]);
    cpu.regs.AX = 0x0010;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x000F);
  });

  it('0x83 with memory operand and CMP sub-op', () => {
    // 83 3F 10  =  CMP word [BX], 0x10  (/reg=111=CMP, /rm=111=[BX])
    const cpu = cpuWith([0x83, 0x3F, 0x10]);
    cpu.regs.BX = 0x0100; cpu.regs.DS = 0;
    cpu.memory.writeWord(0x0100, 0x0010);
    cpu.step();
    expect(cpu.flags.ZF).toBe(true);
    // No writeback for CMP — memory unchanged.
    expect(cpu.memory.readWord(0x0100)).toBe(0x0010);
  });
});

describe('ALU family — flag edges', () => {
  it('ADC: 0xFF + 0 + CF=1 wraps to 0 with CF/ZF/AF set', () => {
    const cpu = cpuWith([0x14, 0x00]);
    cpu.regs.AL = 0xFF; cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x00);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.AF).toBe(true);
  });

  it('SUB 16-bit OF: 0x8000 - 1 = 0x7FFF (neg→pos, OF set)', () => {
    // 81 E8 01 00  =  SUB AX, 1  (mod=11, /reg=101=SUB, /rm=000=AX)
    const cpu = cpuWith([0x81, 0xE8, 0x01, 0x00]);
    cpu.regs.AX = 0x8000;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x7FFF);
    expect(cpu.flags.OF).toBe(true);
    expect(cpu.flags.CF).toBe(false);
  });

  it('SBB: borrow propagation 0x00 - 0x00 - 1 = 0xFF, CF set', () => {
    const cpu = cpuWith([0x1C, 0x00]);
    cpu.regs.AL = 0x00; cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFF);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.SF).toBe(true);
  });

  it('AND/OR/XOR clear CF and OF unconditionally', () => {
    for (const op of [0x20, 0x08, 0x30]) {  // AND/OR/XOR r/m8, r8
      const cpu = cpuWith([op, 0xD8]);
      cpu.regs.AL = 0x55; cpu.regs.BL = 0xAA;
      cpu.flags.CF = true; cpu.flags.OF = true;
      cpu.step();
      expect(cpu.flags.CF, `op=${op.toString(16)}`).toBe(false);
      expect(cpu.flags.OF, `op=${op.toString(16)}`).toBe(false);
    }
  });
});

describe('ALU family — memory writeback', () => {
  it('ADD writes back to memory destination', () => {
    // 00 07  =  ADD [BX], AL  (mod=00, /reg=AL=0, /rm=[BX]=7)
    const cpu = cpuWith([0x00, 0x07]);
    cpu.regs.AL = 0x10; cpu.regs.BX = 0x0200; cpu.regs.DS = 0;
    cpu.memory.writeByte(0x0200, 0x05);
    cpu.step();
    expect(cpu.memory.readByte(0x0200)).toBe(0x15);
  });

  it('CMP does NOT write back to memory', () => {
    // 38 07  =  CMP [BX], AL  (mod=00, /reg=AL=0, /rm=[BX]=7)
    const cpu = cpuWith([0x38, 0x07]);
    cpu.regs.AL = 0x05; cpu.regs.BX = 0x0200; cpu.regs.DS = 0;
    cpu.memory.writeByte(0x0200, 0x10);
    cpu.step();
    expect(cpu.memory.readByte(0x0200)).toBe(0x10);   // unchanged
    expect(cpu.flags.CF).toBe(false);   // 0x10 - 0x05, no borrow
  });

  it('respects ES segment override on memory destination', () => {
    // 26 00 07  =  ES: ADD [BX], AL
    const cpu = cpuWith([0x26, 0x00, 0x07]);
    cpu.regs.AL = 0x10; cpu.regs.BX = 0x0300;
    cpu.regs.DS = 0; cpu.regs.ES = 0x1000;
    cpu.memory.writeByte(linearAddress(0x1000, 0x0300), 0x01);
    cpu.memory.writeByte(linearAddress(0,      0x0300), 0xAA);  // DS-side untouched
    cpu.step();
    expect(cpu.memory.readByte(linearAddress(0x1000, 0x0300))).toBe(0x11);
    expect(cpu.memory.readByte(linearAddress(0,      0x0300))).toBe(0xAA);
  });
});
