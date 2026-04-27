import { describe, expect, it } from 'vitest';
import { FLAG } from '../../src/core/flags.js';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { OPCODE_TABLE } from '../../src/cpu8086/opcodes.js';
import { PagedMemory } from '../../src/memory/index.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0; cpu.regs.IP = 0;
  return cpu;
}

/**
 * For each Jcc, check the taken-and-not-taken paths against the right flag
 * combination. We don't test every synonym separately — the dispatch is
 * by opcode and each opcode has one predicate.
 */

describe('Conditional jumps (Jcc)', () => {
  // Each test constructs `op disp NOP NOP NOP NOP NOP target` so the
  // taken IP is a known value (2 + disp = 2 + 5 = 7 reaches the last NOP).

  function runJcc(op: number, disp: number, setup: (cpu: CPU8086) => void): CPU8086 {
    const program = [op, disp & 0xFF, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90];
    const cpu = cpuWith(program);
    setup(cpu);
    cpu.step();
    return cpu;
  }

  // (opcode, "taken" setup, "not taken" setup, name)
  const cases: Array<[number, (c: CPU8086) => void, (c: CPU8086) => void, string]> = [
    [0x70, c => { c.flags.OF = true; },               c => { c.flags.OF = false; },           'JO'],
    [0x71, c => { c.flags.OF = false; },              c => { c.flags.OF = true; },            'JNO'],
    [0x72, c => { c.flags.CF = true; },               c => { c.flags.CF = false; },           'JB/JC'],
    [0x73, c => { c.flags.CF = false; },              c => { c.flags.CF = true; },            'JAE/JNC'],
    [0x74, c => { c.flags.ZF = true; },               c => { c.flags.ZF = false; },           'JE/JZ'],
    [0x75, c => { c.flags.ZF = false; },              c => { c.flags.ZF = true; },            'JNE/JNZ'],
    [0x76, c => { c.flags.CF = true;  c.flags.ZF=false; }, c => { c.flags.CF=false; c.flags.ZF=false; }, 'JBE'],
    [0x77, c => { c.flags.CF = false; c.flags.ZF=false; }, c => { c.flags.CF=true; },         'JA'],
    [0x78, c => { c.flags.SF = true; },               c => { c.flags.SF = false; },           'JS'],
    [0x79, c => { c.flags.SF = false; },              c => { c.flags.SF = true; },            'JNS'],
    [0x7A, c => { c.flags.PF = true; },               c => { c.flags.PF = false; },           'JP/JPE'],
    [0x7B, c => { c.flags.PF = false; },              c => { c.flags.PF = true; },            'JNP/JPO'],
    [0x7C, c => { c.flags.SF=true; c.flags.OF=false; }, c => { c.flags.SF=true; c.flags.OF=true; }, 'JL'],
    [0x7D, c => { c.flags.SF=true; c.flags.OF=true; }, c => { c.flags.SF=true; c.flags.OF=false; }, 'JGE'],
    [0x7E, c => { c.flags.ZF=true; },                  c => { c.flags.ZF=false; c.flags.SF=true; c.flags.OF=true; }, 'JLE'],
    [0x7F, c => { c.flags.ZF=false; c.flags.SF=true; c.flags.OF=true; }, c => { c.flags.ZF=true; }, 'JG'],
  ];

  for (const [op, takenSetup, notTakenSetup, name] of cases) {
    it(`0x${op.toString(16).toUpperCase()} ${name}: jumps when predicate true`, () => {
      const cpu = runJcc(op, 0x05, takenSetup);
      expect(cpu.regs.IP).toBe(7);
    });
    it(`0x${op.toString(16).toUpperCase()} ${name}: falls through when predicate false`, () => {
      const cpu = runJcc(op, 0x05, notTakenSetup);
      expect(cpu.regs.IP).toBe(2);
    });
  }

  it('Jcc with negative displacement', () => {
    // 74 FE  — JZ -2: jumps to itself (infinite loop).
    const cpu = cpuWith([0x74, 0xFE]);
    cpu.flags.ZF = true;
    cpu.step();
    expect(cpu.regs.IP).toBe(0);
  });
});

describe('LOOP family (0xE0–0xE3)', () => {
  it('LOOP (0xE2): decrements CX, jumps when result != 0', () => {
    // E2 FE  — LOOP -2 (jumps to itself)
    const cpu = cpuWith([0xE2, 0xFE]);
    cpu.regs.CX = 3;
    cpu.step();
    expect(cpu.regs.CX).toBe(2);
    expect(cpu.regs.IP).toBe(0);     // jumped back
  });

  it('LOOP exits when CX reaches 0', () => {
    const cpu = cpuWith([0xE2, 0xFE]);
    cpu.regs.CX = 1;
    cpu.step();
    expect(cpu.regs.CX).toBe(0);
    expect(cpu.regs.IP).toBe(2);     // fell through
  });

  it('LOOP does not affect flags', () => {
    const cpu = cpuWith([0xE2, 0x00]);
    cpu.regs.CX = 5;
    cpu.flags.CF = true; cpu.flags.ZF = true;
    cpu.step();
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
  });

  it('LOOPE/LOOPZ (0xE1): jumps only if CX!=0 AND ZF=1', () => {
    // CX=2, ZF=1 → jumps; CX=2, ZF=0 → doesn't jump
    let cpu = cpuWith([0xE1, 0xFE]);
    cpu.regs.CX = 2; cpu.flags.ZF = true;
    cpu.step();
    expect(cpu.regs.IP).toBe(0);
    expect(cpu.regs.CX).toBe(1);

    cpu = cpuWith([0xE1, 0xFE]);
    cpu.regs.CX = 2; cpu.flags.ZF = false;
    cpu.step();
    expect(cpu.regs.IP).toBe(2);
    expect(cpu.regs.CX).toBe(1);
  });

  it('LOOPNE/LOOPNZ (0xE0): jumps only if CX!=0 AND ZF=0', () => {
    let cpu = cpuWith([0xE0, 0xFE]);
    cpu.regs.CX = 2; cpu.flags.ZF = false;
    cpu.step();
    expect(cpu.regs.IP).toBe(0);

    cpu = cpuWith([0xE0, 0xFE]);
    cpu.regs.CX = 2; cpu.flags.ZF = true;
    cpu.step();
    expect(cpu.regs.IP).toBe(2);
  });

  it('JCXZ (0xE3): jumps when CX=0, no decrement', () => {
    let cpu = cpuWith([0xE3, 0x05, 0, 0, 0, 0, 0, 0x90]);
    cpu.regs.CX = 0;
    cpu.step();
    expect(cpu.regs.IP).toBe(7);
    expect(cpu.regs.CX).toBe(0);

    cpu = cpuWith([0xE3, 0x05]);
    cpu.regs.CX = 1;
    cpu.step();
    expect(cpu.regs.IP).toBe(2);
    expect(cpu.regs.CX).toBe(1);
  });
});

describe('0x60-0x6F — Jcc aliases on 8086 silicon', () => {
  function cpuWithBytes(bytes: number[]): CPU8086 {
    const mem = new PagedMemory();
    bytes.forEach((b, i) => mem.writeByte(i, b));
    const c = new CPU8086(mem);
    c.reset();
    c.regs.CS = 0; c.regs.IP = 0;
    return c;
  }

  it('0x60 with OF=1 jumps (alias of JO)', () => {
    // 60 04 = JO +4 (alias)
    const cpu = cpuWithBytes([0x60, 0x04]);
    cpu.flags.value = cpu.flags.value | FLAG.OF;
    cpu.step();
    expect(cpu.regs.IP).toBe(0x06);   // 2 (advance) + 4 (disp)
  });

  it('0x60 with OF=0 falls through', () => {
    const cpu = cpuWithBytes([0x60, 0x04]);
    cpu.flags.value = cpu.flags.value & ~FLAG.OF;
    cpu.step();
    expect(cpu.regs.IP).toBe(0x02);
  });

  it('0x6F equals JG (0x7F)', () => {
    expect(OPCODE_TABLE[0x6F]).toBe(OPCODE_TABLE[0x7F]);
  });
});
