import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';
import { FLAG } from '../../src/core/flags.js';
import { R16, R8 } from '../../src/core/registers.js';

/** Build a CPU with `bytes` loaded at CS:IP = 0:0. */
function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0;
  cpu.regs.IP = 0;
  return cpu;
}

describe('v0 opcode subset', () => {
  // ============================================================
  // Control: NOP / HLT
  // ============================================================

  describe('0x90 NOP', () => {
    it('advances IP by 1 and changes nothing else', () => {
      const cpu = cpuWith([0x90]);
      const flagsBefore = cpu.flags.value;
      cpu.regs.AX = 0x1234; cpu.regs.BX = 0x5678;
      cpu.step();
      expect(cpu.regs.IP).toBe(1);
      expect(cpu.regs.AX).toBe(0x1234);
      expect(cpu.regs.BX).toBe(0x5678);
      expect(cpu.flags.value).toBe(flagsBefore);
      expect(cpu.halted).toBe(false);
    });
  });

  describe('0xF4 HLT', () => {
    it('sets halted and advances IP past the opcode', () => {
      const cpu = cpuWith([0xF4]);
      cpu.step();
      expect(cpu.halted).toBe(true);
      expect(cpu.regs.IP).toBe(1);
    });
  });

  // ============================================================
  // MOV r8, imm8  (0xB0 – 0xB7)
  // ============================================================

  describe('MOV r8, imm8 (0xB0–B7)', () => {
    const cases: Array<[number, keyof CPU8086['regs'], number]> = [
      [0xB0, 'AL', R8.AL], [0xB1, 'CL', R8.CL],
      [0xB2, 'DL', R8.DL], [0xB3, 'BL', R8.BL],
      [0xB4, 'AH', R8.AH], [0xB5, 'CH', R8.CH],
      [0xB6, 'DH', R8.DH], [0xB7, 'BH', R8.BH],
    ];

    for (const [opcode, regName, _regIdx] of cases) {
      it(`${opcode.toString(16).toUpperCase()} sets ${regName}`, () => {
        const cpu = cpuWith([opcode, 0x42]);
        cpu.step();
        expect((cpu.regs as unknown as Record<string, number>)[regName]).toBe(0x42);
        expect(cpu.regs.IP).toBe(2);
      });
    }

    it('MOV AL does not disturb AH', () => {
      const cpu = cpuWith([0xB0, 0x42]);
      cpu.regs.AH = 0xFF;
      cpu.step();
      expect(cpu.regs.AL).toBe(0x42);
      expect(cpu.regs.AH).toBe(0xFF);
      expect(cpu.regs.AX).toBe(0xFF42);
    });

    it('does not touch flags', () => {
      const cpu = cpuWith([0xB0, 0x00]);
      cpu.flags.CF = true; cpu.flags.ZF = true;
      cpu.step();
      expect(cpu.flags.CF).toBe(true);
      expect(cpu.flags.ZF).toBe(true);
    });
  });

  // ============================================================
  // MOV r16, imm16  (0xB8 – 0xBF)
  // ============================================================

  describe('MOV r16, imm16 (0xB8–BF)', () => {
    const cases: Array<[number, keyof CPU8086['regs']]> = [
      [0xB8, 'AX'], [0xB9, 'CX'], [0xBA, 'DX'], [0xBB, 'BX'],
      [0xBC, 'SP'], [0xBD, 'BP'], [0xBE, 'SI'], [0xBF, 'DI'],
    ];
    for (const [opcode, regName] of cases) {
      it(`${opcode.toString(16).toUpperCase()} sets ${regName}`, () => {
        const cpu = cpuWith([opcode, 0x34, 0x12]);   // little-endian imm16
        cpu.step();
        expect((cpu.regs as unknown as Record<string, number>)[regName]).toBe(0x1234);
        expect(cpu.regs.IP).toBe(3);
      });
    }

    it('accepts 0xFFFF', () => {
      const cpu = cpuWith([0xB8, 0xFF, 0xFF]);
      cpu.step();
      expect(cpu.regs.AX).toBe(0xFFFF);
    });
  });

  // ============================================================
  // JMP short (0xEB rel8)
  // ============================================================

  describe('0xEB JMP short', () => {
    it('jumps forward by positive disp8', () => {
      // EB 05  — jump past 5 bytes
      // At IP=0 the opcode+disp consume 2 bytes, then +5 more => target IP=7
      const cpu = cpuWith([0xEB, 0x05, 0, 0, 0, 0, 0, 0x90]);  // NOP at IP=7
      cpu.step();
      expect(cpu.regs.IP).toBe(7);
    });

    it('jumps backward by negative disp8', () => {
      // At IP=10, EB FB means jump back 5 bytes, so IP = 12 + (-5) = 7
      const cpu = cpuWith(new Array(20).fill(0x90));
      // Place the jump at offset 10
      cpu.memory.writeByte(10, 0xEB);
      cpu.memory.writeByte(11, 0xFB);  // -5 signed
      cpu.regs.IP = 10;
      cpu.step();
      expect(cpu.regs.IP).toBe(7);
    });

    it('disp8=0 is a relative-to-next-instruction no-op jump', () => {
      const cpu = cpuWith([0xEB, 0x00]);
      cpu.step();
      expect(cpu.regs.IP).toBe(2);
    });

    it('wraps at 16-bit boundary on backward jump', () => {
      const cpu = cpuWith([0xEB, 0xFE]);   // -2: targets the JMP itself
      cpu.step();
      expect(cpu.regs.IP).toBe(0);         // back to start of JMP
    });
  });

  // ============================================================
  // ADD AL, imm8 (0x04)  —  the flag-computation pattern
  // ============================================================

  describe('0x04 ADD AL, imm8 — flag outcomes', () => {
    // Each case: (AL start, imm, expected result, expected flag subset)
    // Notation for flags below: capital = set, lowercase letter absent = clear
    interface ExpectedFlags {
      CF?: boolean; PF?: boolean; AF?: boolean;
      ZF?: boolean; SF?: boolean; OF?: boolean;
    }

    function runAdd(al: number, imm: number): { cpu: CPU8086 } {
      const cpu = cpuWith([0x04, imm]);
      cpu.regs.AL = al;
      cpu.step();
      return { cpu };
    }

    function expectFlags(cpu: CPU8086, expected: ExpectedFlags): void {
      for (const key of Object.keys(expected) as (keyof ExpectedFlags)[]) {
        expect(cpu.flags[key], `flag ${key}`).toBe(expected[key]);
      }
    }

    it('simple non-overflowing add', () => {
      const { cpu } = runAdd(0x20, 0x11);
      expect(cpu.regs.AL).toBe(0x31);
      expectFlags(cpu, { CF: false, ZF: false, SF: false, OF: false, AF: false });
    });

    it('zero result sets ZF and PF, clears SF', () => {
      const { cpu } = runAdd(0x00, 0x00);
      expect(cpu.regs.AL).toBe(0);
      expectFlags(cpu, { ZF: true, SF: false, PF: true, CF: false, OF: false });
    });

    it('carry out of bit 7 sets CF; result masked to byte', () => {
      const { cpu } = runAdd(0xFF, 0x01);
      expect(cpu.regs.AL).toBe(0x00);
      expectFlags(cpu, { CF: true, ZF: true, AF: true });
    });

    it('high-bit result sets SF, no OF for unsigned-only carry', () => {
      const { cpu } = runAdd(0x70, 0x20);      // 0x90
      expect(cpu.regs.AL).toBe(0x90);
      // 0x70 + 0x20: pos + pos → neg (bit 7 set) with no carry ⇒ OF set, SF set
      expectFlags(cpu, { SF: true, OF: true, CF: false });
    });

    it('signed overflow: pos + pos = neg', () => {
      // 0x7F + 0x01 = 0x80 (signed: +127 + 1 = -128)
      const { cpu } = runAdd(0x7F, 0x01);
      expect(cpu.regs.AL).toBe(0x80);
      expectFlags(cpu, { OF: true, SF: true, CF: false, ZF: false });
    });

    it('signed overflow: neg + neg = pos', () => {
      // 0x80 + 0x80 = 0x100 (signed: -128 + -128 = -256 → wraps to 0)
      const { cpu } = runAdd(0x80, 0x80);
      expect(cpu.regs.AL).toBe(0x00);
      expectFlags(cpu, { OF: true, CF: true, ZF: true, SF: false });
    });

    it('AF set on low-nibble carry', () => {
      const { cpu } = runAdd(0x0F, 0x01);    // nibble 0xF + 0x1 = 0x10
      expect(cpu.regs.AL).toBe(0x10);
      expectFlags(cpu, { AF: true, CF: false });
    });

    it('AF clear when no low-nibble carry', () => {
      const { cpu } = runAdd(0x01, 0x01);
      expect(cpu.regs.AL).toBe(0x02);
      expectFlags(cpu, { AF: false });
    });

    it('PF = even parity of low byte', () => {
      // 0x03 = 0b00000011 → 2 bits set → even → PF=1
      const { cpu: c1 } = runAdd(0x01, 0x02);
      expect(c1.flags.PF).toBe(true);
      // 0x07 = 0b00000111 → 3 bits set → odd → PF=0
      const { cpu: c2 } = runAdd(0x03, 0x04);
      expect(c2.flags.PF).toBe(false);
    });
  });

  // ============================================================
  // ADD AX, imm16 (0x05)
  // ============================================================

  describe('0x05 ADD AX, imm16', () => {
    it('adds and masks to 16 bits', () => {
      const cpu = cpuWith([0x05, 0x34, 0x12]);  // add 0x1234
      cpu.regs.AX = 0x0011;
      cpu.step();
      expect(cpu.regs.AX).toBe(0x1245);
      expect(cpu.regs.IP).toBe(3);
    });

    it('CF set on 16-bit carry out', () => {
      const cpu = cpuWith([0x05, 0x01, 0x00]);  // add 1
      cpu.regs.AX = 0xFFFF;
      cpu.step();
      expect(cpu.regs.AX).toBe(0x0000);
      expect(cpu.flags.CF).toBe(true);
      expect(cpu.flags.ZF).toBe(true);
    });

    it('OF set for 16-bit signed overflow', () => {
      // 0x7FFF + 1 = 0x8000 (+32767 + 1 → -32768)
      const cpu = cpuWith([0x05, 0x01, 0x00]);
      cpu.regs.AX = 0x7FFF;
      cpu.step();
      expect(cpu.regs.AX).toBe(0x8000);
      expect(cpu.flags.OF).toBe(true);
      expect(cpu.flags.SF).toBe(true);
      expect(cpu.flags.CF).toBe(false);
    });

    it('16-bit parity only considers low byte', () => {
      // 0x0100 → low byte 0x00 → 0 bits → even → PF=1
      const cpu = cpuWith([0x05, 0x00, 0x01]);
      cpu.regs.AX = 0x0000;
      cpu.step();
      expect(cpu.regs.AX).toBe(0x0100);
      expect(cpu.flags.PF).toBe(true);
    });
  });

  // Silence unused-symbol warnings from the destructuring cases above
  void FLAG; void R16;
});
