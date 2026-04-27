import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0; cpu.regs.IP = 0;
  cpu.regs.SS = 0; cpu.regs.SP = 0x1000;     // give DIV-error path a stack
  return cpu;
}

describe('TEST r/m, imm (0xF6 /0, 0xF7 /0)', () => {
  it('TEST AL, imm8 sets ZF when no bit overlaps', () => {
    // F6 C0 0F = TEST AL, 0x0F
    const cpu = cpuWith([0xF6, 0xC0, 0x0F]);
    cpu.regs.AL = 0xF0;
    cpu.step();
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.CF).toBe(false);   // logical → CF cleared
    expect(cpu.flags.OF).toBe(false);
    expect(cpu.regs.AL).toBe(0xF0);     // not modified
  });

  it('TEST AX, imm16 sets SF when MSB set', () => {
    // F7 C0 00 80 = TEST AX, 0x8000
    const cpu = cpuWith([0xF7, 0xC0, 0x00, 0x80]);
    cpu.regs.AX = 0x8000;
    cpu.step();
    expect(cpu.flags.ZF).toBe(false);
    expect(cpu.flags.SF).toBe(true);
  });
});

describe('NOT r/m (0xF6 /2, 0xF7 /2)', () => {
  it('NOT AL inverts bits, leaves flags alone', () => {
    // F6 D0 = NOT AL
    const cpu = cpuWith([0xF6, 0xD0]);
    cpu.regs.AL = 0x55;
    cpu.flags.CF = true; cpu.flags.ZF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xAA);
    expect(cpu.flags.CF).toBe(true);    // unchanged
    expect(cpu.flags.ZF).toBe(true);
  });

  it('NOT AX inverts a word', () => {
    // F7 D0 = NOT AX
    const cpu = cpuWith([0xF7, 0xD0]);
    cpu.regs.AX = 0xAAAA;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x5555);
  });
});

describe('NEG r/m (0xF6 /3, 0xF7 /3)', () => {
  it('NEG AL negates, sets CF when nonzero', () => {
    // F6 D8 = NEG AL
    const cpu = cpuWith([0xF6, 0xD8]);
    cpu.regs.AL = 0x05;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFB);     // -5
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.SF).toBe(true);
    expect(cpu.flags.ZF).toBe(false);
  });

  it('NEG of zero leaves CF clear and ZF set', () => {
    const cpu = cpuWith([0xF6, 0xD8]);
    cpu.regs.AL = 0;
    cpu.step();
    expect(cpu.regs.AL).toBe(0);
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.ZF).toBe(true);
  });

  it('NEG 0x80 (8-bit) keeps 0x80 and sets OF', () => {
    const cpu = cpuWith([0xF6, 0xD8]);
    cpu.regs.AL = 0x80;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x80);     // -(-128) overflows to itself
    expect(cpu.flags.OF).toBe(true);
    expect(cpu.flags.CF).toBe(true);
  });

  it('NEG AX (16-bit)', () => {
    // F7 D8 = NEG AX
    const cpu = cpuWith([0xF7, 0xD8]);
    cpu.regs.AX = 0x0001;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xFFFF);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.SF).toBe(true);
  });
});

describe('MUL r/m (0xF6 /4, 0xF7 /4)', () => {
  it('MUL r/m8: AX = AL * src; CF/OF clear when high half zero', () => {
    // F6 E3 = MUL BL
    const cpu = cpuWith([0xF6, 0xE3]);
    cpu.regs.AL = 0x10; cpu.regs.BL = 0x05;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x50);
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(false);
  });

  it('MUL r/m8: CF/OF set when product overflows AL', () => {
    const cpu = cpuWith([0xF6, 0xE3]);
    cpu.regs.AL = 0xFF; cpu.regs.BL = 0xFF;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xFE01);   // 65025
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.OF).toBe(true);
  });

  it('MUL r/m16: DX:AX = AX * src', () => {
    // F7 E3 = MUL BX
    const cpu = cpuWith([0xF7, 0xE3]);
    cpu.regs.AX = 0x1000; cpu.regs.BX = 0x1000;
    cpu.step();
    expect(cpu.regs.DX).toBe(0x0100);
    expect(cpu.regs.AX).toBe(0x0000);
    expect(cpu.flags.CF).toBe(true);
  });
});

describe('IMUL r/m (0xF6 /5, 0xF7 /5)', () => {
  it('IMUL r/m8 sign-extends inputs', () => {
    // F6 EB = IMUL BL
    const cpu = cpuWith([0xF6, 0xEB]);
    cpu.regs.AL = 0xFF;       // -1
    cpu.regs.BL = 0x02;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xFFFE);  // -2
    // -2 fits in signed 8-bit, so CF/OF clear
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(false);
  });

  it('IMUL r/m8 sets CF/OF when result exceeds signed 8-bit', () => {
    const cpu = cpuWith([0xF6, 0xEB]);
    cpu.regs.AL = 0x10; cpu.regs.BL = 0x10;     // 16 * 16 = 256
    cpu.step();
    expect(cpu.regs.AX).toBe(0x0100);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.OF).toBe(true);
  });

  it('IMUL r/m16 with negative result', () => {
    // F7 EB = IMUL BX
    const cpu = cpuWith([0xF7, 0xEB]);
    cpu.regs.AX = 0xFFFF; cpu.regs.BX = 2;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xFFFE);
    expect(cpu.regs.DX).toBe(0xFFFF);  // sign-extended
    expect(cpu.flags.CF).toBe(false);
  });
});

describe('DIV r/m (0xF6 /6, 0xF7 /6)', () => {
  it('DIV r/m8: AL = AX/src, AH = AX%src', () => {
    // F6 F3 = DIV BL
    const cpu = cpuWith([0xF6, 0xF3]);
    cpu.regs.AX = 100; cpu.regs.BL = 7;
    cpu.step();
    expect(cpu.regs.AL).toBe(14);
    expect(cpu.regs.AH).toBe(2);
  });

  it('DIV by zero services INT 0', () => {
    // Place the program at 0x100 so the IVT (vector 0 lives at 0:0..3) doesn't
    // overlap our opcode bytes.
    const mem = new PagedMemory();
    mem.writeByte(0x100, 0xF6);
    mem.writeByte(0x101, 0xF3);
    const cpu = new CPU8086(mem); cpu.reset();
    cpu.regs.CS = 0; cpu.regs.IP = 0x100;
    cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
    cpu.regs.AX = 100; cpu.regs.BL = 0;
    cpu.memory.writeWord(0, 0x1234);    // IP
    cpu.memory.writeWord(2, 0x5678);    // CS
    cpu.step();
    expect(cpu.regs.IP).toBe(0x1234);
    expect(cpu.regs.CS).toBe(0x5678);
    expect(cpu.regs.SP).toBe(0x1000 - 6);   // pushed flags+CS+IP
  });

  it('DIV r/m16: DX:AX / src → quotient AX, remainder DX', () => {
    // F7 F3 = DIV BX
    const cpu = cpuWith([0xF7, 0xF3]);
    cpu.regs.DX = 0x0001; cpu.regs.AX = 0x0000;   // dividend = 0x10000 = 65536
    cpu.regs.BX = 256;
    cpu.step();
    expect(cpu.regs.AX).toBe(256);
    expect(cpu.regs.DX).toBe(0);
  });

  it('DIV quotient overflow services INT 0', () => {
    const mem = new PagedMemory();
    mem.writeByte(0x100, 0xF6);
    mem.writeByte(0x101, 0xF3);
    const cpu = new CPU8086(mem); cpu.reset();
    cpu.regs.CS = 0; cpu.regs.IP = 0x100;
    cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
    cpu.regs.AX = 0xFF00; cpu.regs.BL = 1;     // quotient 0xFF00 > 0xFF
    cpu.memory.writeWord(0, 0xAAAA);
    cpu.memory.writeWord(2, 0xBBBB);
    cpu.step();
    expect(cpu.regs.IP).toBe(0xAAAA);
    expect(cpu.regs.CS).toBe(0xBBBB);
  });
});

describe('IDIV r/m (0xF6 /7, 0xF7 /7)', () => {
  it('IDIV r/m8 with negative dividend', () => {
    // F6 FB = IDIV BL
    const cpu = cpuWith([0xF6, 0xFB]);
    cpu.regs.AX = 0xFFF6;     // -10
    cpu.regs.BL = 3;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFD);   // -3
    expect(cpu.regs.AH).toBe(0xFF);   // -1
  });

  it('IDIV r/m16 standard case', () => {
    // F7 FB = IDIV BX
    const cpu = cpuWith([0xF7, 0xFB]);
    cpu.regs.DX = 0; cpu.regs.AX = 100; cpu.regs.BX = 7;
    cpu.step();
    expect(cpu.regs.AX).toBe(14);
    expect(cpu.regs.DX).toBe(2);
  });

  it('IDIV r/m8: q = -128 services INT 0 (silicon |q|>0x7F rule)', () => {
    // Mathematically -128 fits a signed byte, but real 8086 microcode
    // overflow-traps when |q| > 0x7F. Set up a divide where q would be
    // exactly -128: AX=9999 / CH=-78 = -128 r 15. Program placed at 0x100
    // so IVT[0] writes don't clobber the opcode bytes.
    const mem = new PagedMemory();
    mem.writeByte(0x100, 0xF6); mem.writeByte(0x101, 0xFD);  // IDIV CH
    mem.writeWord(0, 0x1234);     // IVT[0].IP
    mem.writeWord(2, 0x5678);     // IVT[0].CS
    const cpu = new CPU8086(mem); cpu.reset();
    cpu.regs.CS = 0; cpu.regs.IP = 0x100;
    cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
    cpu.regs.AX = 9999;
    cpu.regs.CH = 0xB2;                  // -78 signed
    cpu.step();
    // Trapped → AX preserved, CS:IP at IVT entry
    expect(cpu.regs.AX).toBe(9999);
    expect(cpu.regs.IP).toBe(0x1234);
    expect(cpu.regs.CS).toBe(0x5678);
  });

  it('REP-prefixed IDIV negates the quotient (silicon quirk)', () => {
    // Per SST corpus, real 8086 negates the IDIV quotient when prefixed
    // by REP/REPNZ. Use a memory divisor at [0x0010] so AX/divisor are
    // independent: F3 F6 3E 10 00 = REP IDIV byte ptr [0x0010].
    const cpu = cpuWith([0xF3, 0xF6, 0x3E, 0x10, 0x00]);
    cpu.memory.writeByte(0x10, 3);
    cpu.regs.AX = 0xFFF6;                // -10
    cpu.step();
    // Without REP we'd get AL=0xFD (-3); with REP, AL=0x03 (+3). AH unchanged.
    expect(cpu.regs.AL).toBe(0x03);
    expect(cpu.regs.AH).toBe(0xFF);      // remainder = -1, unaffected by REP
  });
});

describe('INC/DEC r/m8 (0xFE)', () => {
  it('INC r/m8 wraps 0xFF→0 and sets ZF, CF preserved', () => {
    // FE C0 = INC AL
    const cpu = cpuWith([0xFE, 0xC0]);
    cpu.regs.AL = 0xFF; cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.CF).toBe(true);    // INC must not touch CF
  });

  it('DEC r/m8 0x00→0xFF; CF preserved', () => {
    // FE C8 = DEC AL
    const cpu = cpuWith([0xFE, 0xC8]);
    cpu.regs.AL = 0; cpu.flags.CF = false;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFF);
    expect(cpu.flags.SF).toBe(true);
    expect(cpu.flags.CF).toBe(false);
  });

  it('INC r/m8 to memory operand', () => {
    // FE 06 00 02 = INC byte ptr [0x0200]
    const cpu = cpuWith([0xFE, 0x06, 0x00, 0x02]);
    cpu.memory.writeByte(0x200, 0x41);
    cpu.step();
    expect(cpu.memory.readByte(0x200)).toBe(0x42);
  });

  it('0xFE /others throws', () => {
    const cpu = cpuWith([0xFE, 0xD0]);    // /reg=2, undefined
    expect(() => cpu.step()).toThrow();
  });
});

describe('0xF6 / 0xF7 /1 — TEST aliases on 8086 silicon', () => {
  function cpuWithBytes(bytes: number[]): CPU8086 {
    const mem = new PagedMemory();
    bytes.forEach((b, i) => mem.writeByte(i, b));
    const c = new CPU8086(mem);
    c.reset();
    c.regs.CS = 0; c.regs.IP = 0;
    return c;
  }

  it('F6 /1 behaves as TEST r/m8, imm8 (was previously throwing)', () => {
    // F6 C8 0F = TEST AL, 0x0F   (mod=11 reg=001 rm=000)
    const cpu = cpuWithBytes([0xF6, 0xC8, 0x0F]);
    cpu.regs.AL = 0x05;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x05);            // operand unchanged
    expect(cpu.flags.ZF).toBe(false);
    expect(cpu.flags.PF).toBe(true);           // 0x05 has 2 bits set
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(false);
  });

  it('F7 /1 behaves as TEST r/m16, imm16', () => {
    // F7 C8 FF FF = TEST AX, 0xFFFF
    const cpu = cpuWithBytes([0xF7, 0xC8, 0xFF, 0xFF]);
    cpu.regs.AX = 0x0000;
    cpu.step();
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.regs.AX).toBe(0);
  });
});
