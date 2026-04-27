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

describe('Flag manipulation opcodes', () => {
  it('CLC (0xF8) clears CF', () => {
    const cpu = cpuWith([0xF8]);
    cpu.flags.CF = true;
    cpu.step();
    expect(cpu.flags.CF).toBe(false);
  });

  it('STC (0xF9) sets CF', () => {
    const cpu = cpuWith([0xF9]);
    cpu.flags.CF = false;
    cpu.step();
    expect(cpu.flags.CF).toBe(true);
  });

  it('CMC (0xF5) toggles CF', () => {
    const cpu = cpuWith([0xF5, 0xF5]);
    cpu.flags.CF = false;
    cpu.step();  expect(cpu.flags.CF).toBe(true);
    cpu.step();  expect(cpu.flags.CF).toBe(false);
  });

  it('CLD/STD/CLI/STI control DF and IF', () => {
    const cpu = cpuWith([0xFC, 0xFD, 0xFA, 0xFB]);
    cpu.flags.DF = true; cpu.flags.IF = false;
    cpu.step();  expect(cpu.flags.DF).toBe(false);   // CLD
    cpu.step();  expect(cpu.flags.DF).toBe(true);    // STD
    cpu.step();  expect(cpu.flags.IF).toBe(false);   // CLI
    cpu.step();  expect(cpu.flags.IF).toBe(true);    // STI
  });

  it('flag ops do not disturb other flags', () => {
    const cpu = cpuWith([0xF8]);    // CLC
    cpu.flags.CF = true; cpu.flags.ZF = true; cpu.flags.SF = true; cpu.flags.OF = true;
    cpu.step();
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.SF).toBe(true);
    expect(cpu.flags.OF).toBe(true);
  });
});

describe('INC reg16 (0x40–0x47) / DEC reg16 (0x48–0x4F)', () => {
  it('INC AX wraps 0xFFFF→0 with ZF set, CF preserved', () => {
    const cpu = cpuWith([0x40]);
    cpu.regs.AX = 0xFFFF; cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.AX).toBe(0);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.CF).toBe(true);   // INC must not touch CF
  });

  it('INC sets OF on 0x7FFF→0x8000', () => {
    const cpu = cpuWith([0x40]);
    cpu.regs.AX = 0x7FFF;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x8000);
    expect(cpu.flags.OF).toBe(true);
    expect(cpu.flags.SF).toBe(true);
  });

  it('DEC sets OF on 0x8000→0x7FFF', () => {
    const cpu = cpuWith([0x48]);     // DEC AX
    cpu.regs.AX = 0x8000;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x7FFF);
    expect(cpu.flags.OF).toBe(true);
    expect(cpu.flags.SF).toBe(false);
  });

  it('DEC CX wraps 0→0xFFFF with CF preserved', () => {
    const cpu = cpuWith([0x49]);     // DEC CX
    cpu.regs.CX = 0; cpu.flags.CF = false;
    cpu.step();
    expect(cpu.regs.CX).toBe(0xFFFF);
    expect(cpu.flags.CF).toBe(false);    // preserved
  });

  it('all 8 INC and DEC slots target the right register', () => {
    const regs: Array<keyof CPU8086['regs']> = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
    for (let i = 0; i < 8; i++) {
      const incCpu = cpuWith([0x40 + i]);
      (incCpu.regs as unknown as Record<string, number>)[regs[i]!] = 0;
      incCpu.step();
      expect((incCpu.regs as unknown as Record<string, number>)[regs[i]!]).toBe(1);

      const decCpu = cpuWith([0x48 + i]);
      (decCpu.regs as unknown as Record<string, number>)[regs[i]!] = 5;
      decCpu.step();
      expect((decCpu.regs as unknown as Record<string, number>)[regs[i]!]).toBe(4);
    }
  });
});

describe('XCHG AX, r16 (0x91–0x97)', () => {
  it('XCHG AX, BX swaps the two', () => {
    const cpu = cpuWith([0x93]);     // XCHG AX, BX
    cpu.regs.AX = 0x1234; cpu.regs.BX = 0xABCD;
    cpu.step();
    expect(cpu.regs.AX).toBe(0xABCD);
    expect(cpu.regs.BX).toBe(0x1234);
  });

  it('XCHG does not touch flags', () => {
    const cpu = cpuWith([0x91]);
    cpu.regs.AX = 0; cpu.regs.CX = 0;
    cpu.flags.CF = true; cpu.flags.ZF = true;
    cpu.step();
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
  });
});
