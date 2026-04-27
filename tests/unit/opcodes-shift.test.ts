import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0; cpu.regs.IP = 0;
  return cpu;
}

describe('SHL r/m, 1 (0xD0/D1 /4)', () => {
  it('SHL AL,1 with 0x40 → 0x80, OF set, CF clear, SF set', () => {
    // D0 E0 = SHL AL, 1
    const cpu = cpuWith([0xD0, 0xE0]);
    cpu.regs.AL = 0x40;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x80);
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(true);   // sign change
    expect(cpu.flags.SF).toBe(true);
    expect(cpu.flags.ZF).toBe(false);
  });

  it('SHL AL,1 with 0x80 → 0x00, CF set, ZF set, OF set (sign flipped)', () => {
    const cpu = cpuWith([0xD0, 0xE0]);
    cpu.regs.AL = 0x80;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x00);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.OF).toBe(true);   // MSB was 1, now 0
  });

  it('SHL AX,1 (16-bit)', () => {
    // D1 E0 = SHL AX, 1
    const cpu = cpuWith([0xD1, 0xE0]);
    cpu.regs.AX = 0x4000;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x8000);
    expect(cpu.flags.OF).toBe(true);
  });
});

describe('SHR r/m, 1 (0xD0/D1 /5)', () => {
  it('SHR AL,1 with 0x01 → 0x00, CF set, ZF set', () => {
    // D0 E8 = SHR AL, 1
    const cpu = cpuWith([0xD0, 0xE8]);
    cpu.regs.AL = 0x01;
    cpu.step();
    expect(cpu.regs.AL).toBe(0);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
  });

  it('SHR AL,1 OF = MSB(before) for count=1', () => {
    const cpu = cpuWith([0xD0, 0xE8]);
    cpu.regs.AL = 0x80;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x40);
    expect(cpu.flags.OF).toBe(true);   // MSB was 1
  });
});

describe('SAR r/m, 1 (0xD0/D1 /7)', () => {
  it('SAR AL,1 sign-extends 0x80 → 0xC0', () => {
    // D0 F8 = SAR AL, 1
    const cpu = cpuWith([0xD0, 0xF8]);
    cpu.regs.AL = 0x80;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xC0);
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(false);
  });

  it('SAR AL,1 with 0x01 sets CF and zero', () => {
    const cpu = cpuWith([0xD0, 0xF8]);
    cpu.regs.AL = 0x01;
    cpu.step();
    expect(cpu.regs.AL).toBe(0);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
  });
});

describe('ROL / ROR r/m, 1', () => {
  it('ROL AL,1 with 0x80 → 0x01, CF set', () => {
    // D0 C0 = ROL AL, 1
    const cpu = cpuWith([0xD0, 0xC0]);
    cpu.regs.AL = 0x80;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x01);
    expect(cpu.flags.CF).toBe(true);
  });

  it('ROL preserves PF/SF/ZF (not modified)', () => {
    const cpu = cpuWith([0xD0, 0xC0]);
    cpu.regs.AL = 0x40;
    cpu.flags.ZF = true; cpu.flags.SF = true; cpu.flags.PF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x80);
    expect(cpu.flags.ZF).toBe(true);   // unchanged by rotate
    expect(cpu.flags.SF).toBe(true);
    expect(cpu.flags.PF).toBe(true);
  });

  it('ROR AL,1 with 0x01 → 0x80, CF set', () => {
    // D0 C8 = ROR AL, 1
    const cpu = cpuWith([0xD0, 0xC8]);
    cpu.regs.AL = 0x01;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x80);
    expect(cpu.flags.CF).toBe(true);
  });
});

describe('RCL / RCR r/m, 1', () => {
  it('RCL AL,1 rotates CF in', () => {
    // D0 D0 = RCL AL, 1
    const cpu = cpuWith([0xD0, 0xD0]);
    cpu.regs.AL = 0x80; cpu.flags.CF = true;
    cpu.step();
    // 0x80 << 1 = 0x100; LSB picks up old CF=1 → 0x01; new CF = old MSB = 1
    expect(cpu.regs.AL).toBe(0x01);
    expect(cpu.flags.CF).toBe(true);
  });

  it('RCR AL,1 rotates CF in from the top', () => {
    // D0 D8 = RCR AL, 1
    const cpu = cpuWith([0xD0, 0xD8]);
    cpu.regs.AL = 0x01; cpu.flags.CF = true;
    cpu.step();
    // 0x01 >> 1 = 0x00; MSB picks up old CF=1 → 0x80; new CF = old LSB = 1
    expect(cpu.regs.AL).toBe(0x80);
    expect(cpu.flags.CF).toBe(true);
  });
});

describe('Shift by CL (0xD2/D3)', () => {
  it('SHL AL by CL=4', () => {
    // D2 E0 = SHL AL, CL
    const cpu = cpuWith([0xD2, 0xE0]);
    cpu.regs.AL = 0x03; cpu.regs.CL = 4;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x30);
  });

  it('SHL AX by CL=8', () => {
    // D3 E0 = SHL AX, CL
    const cpu = cpuWith([0xD3, 0xE0]);
    cpu.regs.AX = 0x00FF; cpu.regs.CL = 8;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xFF00);
  });

  it('SHR AL by CL=0 leaves operand and flags unchanged', () => {
    // D2 E8 = SHR AL, CL
    const cpu = cpuWith([0xD2, 0xE8]);
    cpu.regs.AL = 0x55; cpu.regs.CL = 0;
    cpu.flags.CF = true; cpu.flags.ZF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x55);
    expect(cpu.flags.CF).toBe(true);    // 8086: shift-by-0 doesn't touch flags
    expect(cpu.flags.ZF).toBe(true);
  });

  it('SAR AX by CL=15 produces sign-extended bit', () => {
    // D3 F8 = SAR AX, CL
    const cpu = cpuWith([0xD3, 0xF8]);
    cpu.regs.AX = 0x8000; cpu.regs.CL = 15;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xFFFF);
  });
});

describe('SETMO (0xD0-0xD3 /6) — undocumented set-to-minus-one', () => {
  it('D0 /6 writes 0xFF to byte operand', () => {
    // D0 F0 = SETMO AL  (mod=11 reg=110 rm=000)
    const cpu = cpuWith([0xD0, 0xF0]);
    cpu.regs.AL = 0x42;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFF);
    // Logical-op flag profile: CF=OF=AF=0; PF/SF/ZF from result.
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.OF).toBe(false);
    expect(cpu.flags.SF).toBe(true);
    expect(cpu.flags.ZF).toBe(false);
    expect(cpu.flags.PF).toBe(true);   // 0xFF has 8 bits set → even parity
  });

  it('D1 /6 writes 0xFFFF to word operand', () => {
    // D1 F0 = SETMO AX (mod=11 reg=110 rm=000 → AX in 16-bit context)
    const cpu = cpuWith([0xD1, 0xF0]);
    cpu.regs.AX = 0x1234;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xFFFF);
    expect(cpu.flags.SF).toBe(true);
    expect(cpu.flags.PF).toBe(true);
  });

  it('D2 /6 with CL=0 is a no-op (preserves operand and flags)', () => {
    const cpu = cpuWith([0xD2, 0xF0]);   // SETMO AL by CL
    cpu.regs.AL = 0x42; cpu.regs.CL = 0;
    const flagsBefore = cpu.flags.value;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x42);
    expect(cpu.flags.value).toBe(flagsBefore);
  });

  it('D2 /6 with CL=1 sets to 0xFF', () => {
    const cpu = cpuWith([0xD2, 0xF0]);
    cpu.regs.AL = 0x42; cpu.regs.CL = 1;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFF);
  });
});
