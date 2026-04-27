import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { decodeModRM, regOperand, rmOperand } from '../../src/cpu8086/modrm.js';
import { PagedMemory } from '../../src/memory/index.js';
import { linearAddress } from '../../src/core/types.js';

/** CPU with `bytes` placed at CS:IP = 0:0. */
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

/** Build a ModR/M byte from its three fields. */
function modrm(mod: number, reg: number, rm: number): number {
  return ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7);
}

describe('ModR/M decoder', () => {
  // ============================================================
  // Field decomposition
  // ============================================================

  describe('field decomposition', () => {
    it('decomposes mod/reg/rm correctly', () => {
      // mod=10 (binary), reg=101, rm=011  =>  0b10_101_011 = 0xAB
      const cpu = cpuWith([0xAB, 0x00, 0x00]);
      const m = decodeModRM(cpu);
      expect(m.mod).toBe(0b10);
      expect(m.reg).toBe(0b101);
      expect(m.rm).toBe(0b011);
    });

    it('handles mod=11 (register operand) without consuming displacement', () => {
      // mod=11, reg=000, rm=000 (AX/AL) => 0xC0
      const cpu = cpuWith([0xC0]);
      const m = decodeModRM(cpu);
      expect(m.isMemory).toBe(false);
      expect(m.segment).toBe(0);
      expect(m.offset).toBe(0);
      expect(cpu.regs.IP).toBe(1);   // only the ModR/M byte consumed
    });
  });

  // ============================================================
  // The 8 mod=00 EA formulas
  // ============================================================

  describe('mod=00 effective addresses', () => {
    it('rm=000  [BX+SI]  defaults DS', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b000)]);
      cpu.regs.BX = 0x1000; cpu.regs.SI = 0x0020; cpu.regs.DS = 0x1234;
      const m = decodeModRM(cpu);
      expect(m.isMemory).toBe(true);
      expect(m.offset).toBe(0x1020);
      expect(m.segment).toBe(0x1234);
    });

    it('rm=001  [BX+DI]', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b001)]);
      cpu.regs.BX = 0x0100; cpu.regs.DI = 0x0001;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x0101);
    });

    it('rm=010  [BP+SI]  defaults SS', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b010)]);
      cpu.regs.BP = 0x0200; cpu.regs.SI = 0x0050; cpu.regs.SS = 0x9999;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x0250);
      expect(m.segment).toBe(0x9999);
    });

    it('rm=011  [BP+DI]  defaults SS', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b011)]);
      cpu.regs.BP = 0x0100; cpu.regs.DI = 0x0030; cpu.regs.SS = 0xAAAA;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x0130);
      expect(m.segment).toBe(0xAAAA);
    });

    it('rm=100  [SI]', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b100)]);
      cpu.regs.SI = 0x4321;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x4321);
    });

    it('rm=101  [DI]', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b101)]);
      cpu.regs.DI = 0x1234;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x1234);
    });

    it('rm=110 SPECIAL CASE: [disp16], default DS (NOT [BP])', () => {
      // mod=00, rm=110, disp16 = 0xBEEF (LE)
      const cpu = cpuWith([modrm(0b00, 0, 0b110), 0xEF, 0xBE]);
      cpu.regs.BP = 0xFFFF; cpu.regs.DS = 0x1000;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0xBEEF);
      expect(m.segment).toBe(0x1000);   // DS, not SS
    });

    it('rm=111  [BX]', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b111)]);
      cpu.regs.BX = 0x5678;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x5678);
    });
  });

  // ============================================================
  // Displacements (mod=01 disp8, mod=10 disp16)
  // ============================================================

  describe('displacement handling', () => {
    it('mod=01 sign-extends disp8 (positive)', () => {
      const cpu = cpuWith([modrm(0b01, 0, 0b111), 0x10]);
      cpu.regs.BX = 0x0100;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x0110);
    });

    it('mod=01 sign-extends disp8 (negative)', () => {
      const cpu = cpuWith([modrm(0b01, 0, 0b111), 0xFE]);  // -2
      cpu.regs.BX = 0x0100;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x00FE);
    });

    it('mod=01 with [BP] uses SS even with disp8', () => {
      const cpu = cpuWith([modrm(0b01, 0, 0b110), 0x04]);  // [BP+4]
      cpu.regs.BP = 0x0010; cpu.regs.SS = 0x7000;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x0014);
      expect(m.segment).toBe(0x7000);
    });

    it('mod=10 adds 16-bit displacement', () => {
      const cpu = cpuWith([modrm(0b10, 0, 0b111), 0x34, 0x12]);  // [BX+0x1234]
      cpu.regs.BX = 0x0100;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x1334);
    });

    it('offset wraps at 16 bits', () => {
      const cpu = cpuWith([modrm(0b10, 0, 0b111), 0x01, 0x00]);  // [BX+1]
      cpu.regs.BX = 0xFFFF;
      const m = decodeModRM(cpu);
      expect(m.offset).toBe(0x0000);
    });

    it('IP advances correctly past disp8', () => {
      const cpu = cpuWith([modrm(0b01, 0, 0b111), 0x05]);
      decodeModRM(cpu);
      expect(cpu.regs.IP).toBe(2);
    });

    it('IP advances correctly past disp16', () => {
      const cpu = cpuWith([modrm(0b10, 0, 0b111), 0x00, 0x00]);
      decodeModRM(cpu);
      expect(cpu.regs.IP).toBe(3);
    });
  });

  // ============================================================
  // Segment override
  // ============================================================

  describe('segment override', () => {
    it('honours segOverride for default-DS access', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b111)]);  // [BX], default DS
      cpu.regs.BX = 0x0010;
      cpu.regs.DS = 0x1000; cpu.regs.ES = 0x2000;
      cpu.segOverride = 0;  // ES
      const m = decodeModRM(cpu);
      expect(m.segment).toBe(0x2000);
    });

    it('honours segOverride for default-SS (BP-based) access', () => {
      const cpu = cpuWith([modrm(0b00, 0, 0b110), 0x10, 0x00]); // wait — that's [disp16]
      // Use mod=01 [BP+0] instead, which IS BP-based.
      const cpu2 = cpuWith([modrm(0b01, 0, 0b110), 0x00]);
      cpu2.regs.BP = 0x0040;
      cpu2.regs.SS = 0x3000; cpu2.regs.DS = 0x4000;
      cpu2.segOverride = 3;  // DS
      const m = decodeModRM(cpu2);
      expect(m.segment).toBe(0x4000);
      void cpu;
    });
  });

  // ============================================================
  // Operand abstraction
  // ============================================================

  describe('operand abstraction', () => {
    it('register operand at width 8 reads/writes the right byte register', () => {
      // mod=11, reg=ignored, rm=001 -> CL
      const cpu = cpuWith([modrm(0b11, 0, 0b001)]);
      cpu.regs.CL = 0x42;
      const m = decodeModRM(cpu);
      const op = rmOperand(cpu, m);
      expect(op.read8()).toBe(0x42);
      op.write8(0x99);
      expect(cpu.regs.CL).toBe(0x99);
      expect(op.isMemory).toBe(false);
    });

    it('register operand at width 16 reads/writes the right word register', () => {
      // mod=11, rm=011 -> BX
      const cpu = cpuWith([modrm(0b11, 0, 0b011)]);
      cpu.regs.BX = 0x1234;
      const m = decodeModRM(cpu);
      const op = rmOperand(cpu, m);
      expect(op.read16()).toBe(0x1234);
      op.write16(0xABCD);
      expect(cpu.regs.BX).toBe(0xABCD);
    });

    it('memory operand reads/writes through cpu.memory', () => {
      // mod=00, rm=110, disp16 = 0x0100; default DS
      const cpu = cpuWith([modrm(0b00, 0, 0b110), 0x00, 0x01]);
      cpu.regs.DS = 0x0010;   // linear base = 0x100
      cpu.memory.writeByte(linearAddress(0x0010, 0x0100), 0x55);
      const m = decodeModRM(cpu);
      const op = rmOperand(cpu, m);
      expect(op.isMemory).toBe(true);
      expect(op.segment).toBe(0x0010);
      expect(op.offset).toBe(0x0100);
      expect(op.read8()).toBe(0x55);
      op.write8(0xAA);
      expect(cpu.memory.readByte(linearAddress(0x0010, 0x0100))).toBe(0xAA);
    });

    it('memory operand 16-bit handles offset wrap at segment boundary', () => {
      // mod=01 [BX+0]; BX=0xFFFF — write a word: low at offset 0xFFFF, high
      // wraps to offset 0x0000 inside the same segment.
      const cpu = cpuWith([modrm(0b01, 0, 0b111), 0x00]);
      cpu.regs.BX = 0xFFFF;
      cpu.regs.DS = 0x1000;
      const m = decodeModRM(cpu);
      const op = rmOperand(cpu, m);
      op.write16(0xBEEF);
      expect(cpu.memory.readByte(linearAddress(0x1000, 0xFFFF))).toBe(0xEF);
      expect(cpu.memory.readByte(linearAddress(0x1000, 0x0000))).toBe(0xBE);
    });

    it('regOperand selects the /reg field register', () => {
      // /reg = 4 -> AH at width 8, SP at width 16
      const cpu = cpuWith([modrm(0b11, 0b100, 0b000)]);
      cpu.regs.AH = 0x12; cpu.regs.SP = 0xCAFE;
      const m = decodeModRM(cpu);
      const reg = regOperand(cpu, m.reg);
      expect(reg.read8()).toBe(0x12);
      expect(reg.read16()).toBe(0xCAFE);
    });
  });
});
