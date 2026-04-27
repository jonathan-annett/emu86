import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';
import { linearAddress } from '../../src/core/types.js';
import { FLAG } from '../../src/core/flags.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0; cpu.regs.IP = 0;
  cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
  return cpu;
}

describe('XCHG r/m, r (0x86 / 0x87)', () => {
  it('XCHG r/m8, r8: register operand', () => {
    // 86 C3 = XCHG AL, BL
    const cpu = cpuWith([0x86, 0xC3]);
    cpu.regs.AL = 0x12; cpu.regs.BL = 0x34;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x34);
    expect(cpu.regs.BL).toBe(0x12);
  });

  it('XCHG r/m16, r16: memory operand', () => {
    // 87 1E 00 02 = XCHG BX, [0x0200]
    const cpu = cpuWith([0x87, 0x1E, 0x00, 0x02]);
    cpu.regs.BX = 0xCAFE;
    cpu.memory.writeWord(0x200, 0xBEEF);
    cpu.step();
    expect(cpu.regs.BX).toBe(0xBEEF);
    expect(cpu.memory.readWord(0x200)).toBe(0xCAFE);
  });
});

describe('CBW / CWD (0x98 / 0x99)', () => {
  it('CBW sign-extends positive AL', () => {
    const cpu = cpuWith([0x98]);
    cpu.regs.AL = 0x42;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x0042);
  });

  it('CBW sign-extends negative AL', () => {
    const cpu = cpuWith([0x98]);
    cpu.regs.AL = 0x80;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xFF80);
  });

  it('CWD with positive AX clears DX', () => {
    const cpu = cpuWith([0x99]);
    cpu.regs.AX = 0x1234; cpu.regs.DX = 0xFFFF;
    cpu.step();
    expect(cpu.regs.DX).toBe(0);
  });

  it('CWD with negative AX sets DX to 0xFFFF', () => {
    const cpu = cpuWith([0x99]);
    cpu.regs.AX = 0x8000;
    cpu.step();
    expect(cpu.regs.DX).toBe(0xFFFF);
  });
});

describe('PUSHF / POPF (0x9C / 0x9D)', () => {
  it('PUSHF then POPF round-trips flag value', () => {
    const cpu = cpuWith([0x9C, 0x9D]);
    cpu.flags.CF = true; cpu.flags.OF = true; cpu.flags.IF = true;
    cpu.step();   // PUSHF
    expect(cpu.regs.SP).toBe(0x1000 - 2);
    cpu.flags.CF = false; cpu.flags.OF = false; cpu.flags.IF = false;
    cpu.step();   // POPF
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.OF).toBe(true);
    expect(cpu.flags.IF).toBe(true);
  });
});

describe('SAHF / LAHF (0x9E / 0x9F)', () => {
  it('SAHF copies AH into the low byte of FLAGS', () => {
    const cpu = cpuWith([0x9E]);
    cpu.regs.AH = FLAG.CF | FLAG.ZF | FLAG.SF;    // 0x81 + 0x40 + ... wait check
    // CF=bit0, ZF=bit6, SF=bit7. 0x01 | 0x40 | 0x80 = 0xC1
    cpu.regs.AH = 0xC1;
    cpu.step();
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.SF).toBe(true);
  });

  it('LAHF copies low byte of FLAGS into AH', () => {
    const cpu = cpuWith([0x9F]);
    cpu.flags.CF = true; cpu.flags.ZF = true; cpu.flags.SF = true;
    cpu.step();
    expect(cpu.regs.AH & FLAG.CF).toBe(FLAG.CF);
    expect(cpu.regs.AH & FLAG.ZF).toBe(FLAG.ZF);
    expect(cpu.regs.AH & FLAG.SF).toBe(FLAG.SF);
  });

  it('LAHF preserves the always-set bit 1', () => {
    const cpu = cpuWith([0x9F]);
    cpu.step();
    expect(cpu.regs.AH & 0x02).toBe(0x02);
  });
});

describe('XLAT (0xD7)', () => {
  it('XLAT reads [DS:BX+AL] into AL', () => {
    const cpu = cpuWith([0xD7]);
    cpu.regs.DS = 0; cpu.regs.BX = 0x100; cpu.regs.AL = 5;
    cpu.memory.writeByte(0x105, 0x42);
    cpu.step();
    expect(cpu.regs.AL).toBe(0x42);
  });

  it('XLAT honours segment override', () => {
    // 26 D7 = ES: XLAT
    const cpu = cpuWith([0x26, 0xD7]);
    cpu.regs.DS = 0; cpu.regs.ES = 0x1000;
    cpu.regs.BX = 0x100; cpu.regs.AL = 0;
    cpu.memory.writeByte(linearAddress(0x1000, 0x100), 0xAA);
    cpu.memory.writeByte(linearAddress(0,      0x100), 0xBB);
    cpu.step();
    expect(cpu.regs.AL).toBe(0xAA);
  });
});

describe('LOCK (0xF0)', () => {
  it('LOCK runs the next instruction (no observable lock state)', () => {
    // F0 40 = LOCK INC AX
    const cpu = cpuWith([0xF0, 0x40]);
    cpu.regs.AX = 5;
    cpu.step();
    expect(cpu.regs.AX).toBe(6);
  });
});

describe('WAIT (0x9B)', () => {
  it('WAIT is a no-op', () => {
    const cpu = cpuWith([0x9B]);
    cpu.step();
    expect(cpu.regs.IP).toBe(1);
  });
});

describe('ESC (0xD8-0xDF)', () => {
  it('ESC consumes a ModR/M byte and continues', () => {
    // D8 00 = ESC 0, [BX+SI]
    const cpu = cpuWith([0xD8, 0x00]);
    cpu.step();
    expect(cpu.regs.IP).toBe(2);
  });

  it('ESC with displacement consumes the disp bytes too', () => {
    // DC 87 34 12 = ESC ..., [BX+0x1234]   (mod=10 rm=111 → +disp16)
    const cpu = cpuWith([0xDC, 0x87, 0x34, 0x12]);
    cpu.step();
    expect(cpu.regs.IP).toBe(4);
  });
});

describe('TEST (0x84/0x85/0xA8/0xA9) — corpus-driven additions', () => {
  it('TEST r/m8, r8 sets ZF when AND is zero', () => {
    // 84 C3 = TEST AL, BL
    const cpu = cpuWith([0x84, 0xC3]);
    cpu.regs.AL = 0xF0; cpu.regs.BL = 0x0F;
    cpu.step();
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(false);
    expect(cpu.regs.AL).toBe(0xF0);   // operand unchanged
  });

  it('TEST r/m16, r16 sets SF on negative AND', () => {
    // 85 C3 = TEST AX, BX
    const cpu = cpuWith([0x85, 0xC3]);
    cpu.regs.AX = 0xFFFF; cpu.regs.BX = 0x8000;
    cpu.step();
    expect(cpu.flags.SF).toBe(true);
    expect(cpu.flags.ZF).toBe(false);
  });

  it('TEST AL, imm8', () => {
    // A8 0F = TEST AL, 0x0F
    const cpu = cpuWith([0xA8, 0x0F]);
    cpu.regs.AL = 0x05;
    cpu.step();
    expect(cpu.flags.ZF).toBe(false);
    expect(cpu.flags.PF).toBe(true);   // 0x05 has 2 bits → even parity
  });

  it('TEST AX, imm16 — clears CF/OF unconditionally', () => {
    // A9 FF FF = TEST AX, 0xFFFF
    const cpu = cpuWith([0xA9, 0xFF, 0xFF]);
    cpu.regs.AX = 0x1234;
    cpu.flags.value = cpu.flags.value | FLAG.CF | FLAG.OF;
    cpu.step();
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(false);
  });
});

describe('SALC (0xD6) — undocumented', () => {
  it('AL = 0xFF when CF=1', () => {
    const cpu = cpuWith([0xD6]);
    cpu.flags.value = cpu.flags.value | FLAG.CF;
    cpu.regs.AL = 0x55;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFF);
  });

  it('AL = 0x00 when CF=0', () => {
    const cpu = cpuWith([0xD6]);
    cpu.flags.value = cpu.flags.value & ~FLAG.CF;
    cpu.regs.AL = 0x55;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x00);
  });

  it('SALC does not modify flags', () => {
    const cpu = cpuWith([0xD6]);
    cpu.flags.value = cpu.flags.value | FLAG.CF | FLAG.ZF | FLAG.SF;
    const before = cpu.flags.value;
    cpu.step();
    expect(cpu.flags.value).toBe(before);
  });
});
