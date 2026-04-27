import { describe, expect, it } from 'vitest';
import { R16, R8, SREG, Registers } from '../../src/core/registers.js';

describe('Registers', () => {
  it('starts zeroed', () => {
    const r = new Registers();
    expect(r.AX).toBe(0);
    expect(r.BX).toBe(0);
    expect(r.CS).toBe(0);
    expect(r.IP).toBe(0);
  });

  describe('AX/AH/AL aliasing', () => {
    it('setting AX updates AH and AL', () => {
      const r = new Registers();
      r.AX = 0x1234;
      expect(r.AH).toBe(0x12);
      expect(r.AL).toBe(0x34);
    });

    it('setting AL preserves AH', () => {
      const r = new Registers();
      r.AX = 0x1234;
      r.AL = 0x56;
      expect(r.AX).toBe(0x1256);
      expect(r.AH).toBe(0x12);
    });

    it('setting AH preserves AL', () => {
      const r = new Registers();
      r.AX = 0x1234;
      r.AH = 0xAB;
      expect(r.AX).toBe(0xAB34);
      expect(r.AL).toBe(0x34);
    });

    it('works for all four dual-half GP regs', () => {
      const r = new Registers();
      r.BX = 0xCAFE; expect(r.BH).toBe(0xCA); expect(r.BL).toBe(0xFE);
      r.CX = 0xDEAD; expect(r.CH).toBe(0xDE); expect(r.CL).toBe(0xAD);
      r.DX = 0xBEEF; expect(r.DH).toBe(0xBE); expect(r.DL).toBe(0xEF);
    });

    it('word-only regs (SP/BP/SI/DI) have no byte alias', () => {
      const r = new Registers();
      r.SP = 0xFFFE;
      r.BP = 0x1234;
      r.SI = 0x5678;
      r.DI = 0x9ABC;
      // Setting AH shouldn't affect any of them
      r.AH = 0xFF;
      expect(r.SP).toBe(0xFFFE);
      expect(r.BP).toBe(0x1234);
      expect(r.SI).toBe(0x5678);
      expect(r.DI).toBe(0x9ABC);
    });
  });

  describe('indexed accessors match ModR/M encoding', () => {
    it('reg16 indices map to named regs correctly', () => {
      const r = new Registers();
      r.setReg16(R16.AX, 0x1111);
      r.setReg16(R16.CX, 0x2222);
      r.setReg16(R16.DX, 0x3333);
      r.setReg16(R16.BX, 0x4444);
      r.setReg16(R16.SP, 0x5555);
      r.setReg16(R16.BP, 0x6666);
      r.setReg16(R16.SI, 0x7777);
      r.setReg16(R16.DI, 0x8888);
      expect(r.AX).toBe(0x1111); expect(r.CX).toBe(0x2222);
      expect(r.DX).toBe(0x3333); expect(r.BX).toBe(0x4444);
      expect(r.SP).toBe(0x5555); expect(r.BP).toBe(0x6666);
      expect(r.SI).toBe(0x7777); expect(r.DI).toBe(0x8888);
    });

    it('reg8 indices map to byte halves correctly', () => {
      const r = new Registers();
      // Set via indexed API, read via named — verifies encoding matches
      r.setReg8(R8.AL, 0xA1); r.setReg8(R8.AH, 0xA2);
      r.setReg8(R8.CL, 0xC1); r.setReg8(R8.CH, 0xC2);
      r.setReg8(R8.DL, 0xD1); r.setReg8(R8.DH, 0xD2);
      r.setReg8(R8.BL, 0xB1); r.setReg8(R8.BH, 0xB2);
      expect(r.AL).toBe(0xA1); expect(r.AH).toBe(0xA2);
      expect(r.CL).toBe(0xC1); expect(r.CH).toBe(0xC2);
      expect(r.DL).toBe(0xD1); expect(r.DH).toBe(0xD2);
      expect(r.BL).toBe(0xB1); expect(r.BH).toBe(0xB2);
      // And the composite words
      expect(r.AX).toBe(0xA2A1);
      expect(r.CX).toBe(0xC2C1);
      expect(r.DX).toBe(0xD2D1);
      expect(r.BX).toBe(0xB2B1);
    });

    it('sreg indices map to named segs correctly', () => {
      const r = new Registers();
      r.setSreg(SREG.ES, 0x1000);
      r.setSreg(SREG.CS, 0x2000);
      r.setSreg(SREG.SS, 0x3000);
      r.setSreg(SREG.DS, 0x4000);
      expect(r.ES).toBe(0x1000);
      expect(r.CS).toBe(0x2000);
      expect(r.SS).toBe(0x3000);
      expect(r.DS).toBe(0x4000);
    });
  });

  describe('masking on write', () => {
    it('truncates Uint16 writes to 16 bits', () => {
      const r = new Registers();
      r.AX = 0x12345;          // > 16 bits
      expect(r.AX).toBe(0x2345);  // Uint16Array naturally truncates
    });

    it('truncates Uint8 writes to 8 bits', () => {
      const r = new Registers();
      r.AL = 0x1FF;
      expect(r.AL).toBe(0xFF);
    });
  });

  describe('snapshot / restore', () => {
    it('round-trips full state', () => {
      const r = new Registers();
      r.AX = 0x1111; r.BX = 0x2222; r.CX = 0x3333; r.DX = 0x4444;
      r.SP = 0x5555; r.BP = 0x6666; r.SI = 0x7777; r.DI = 0x8888;
      r.ES = 0x1000; r.CS = 0x2000; r.SS = 0x3000; r.DS = 0x4000;
      r.IP = 0x9999;

      const snap = r.snapshot();
      // Mutate after snapshot
      r.AX = 0; r.CS = 0; r.IP = 0;
      r.restore(snap);

      expect(r.AX).toBe(0x1111);
      expect(r.CS).toBe(0x2000);
      expect(r.IP).toBe(0x9999);
    });

    it('snapshot arrays are independent copies', () => {
      const r = new Registers();
      r.AX = 0x1234;
      const snap = r.snapshot();
      r.AX = 0xFFFF;
      // snapshot should still hold the original value
      expect(snap.gp[0]).toBe(0x1234);
    });
  });
});
