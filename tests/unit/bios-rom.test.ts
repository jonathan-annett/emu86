import { describe, expect, it } from 'vitest';
import {
  BIOS_INIT_OFFSET,
  BIOS_RESET_VECTOR_OFFSET,
  BIOS_ROM_BASE,
  BIOS_ROM_SIZE,
  BIOS_TRAP_TABLE_OFFSET,
  buildBiosRom,
  trapAddressForVector,
} from '../../src/bios/bios-rom.js';

/**
 * Tests for the BIOS ROM image generator. We don't run the init code here —
 * the cpu+bios integration test does that. Here we just verify the bytes
 * land at the right offsets so the layout matches what handlers expect.
 */

describe('buildBiosRom — image structure', () => {
  it('produces a 64 KiB image at linear base 0xF0000', () => {
    const r = buildBiosRom();
    expect(r.bytes.length).toBe(BIOS_ROM_SIZE);
    expect(r.bytes.length).toBe(0x10000);
    expect(r.baseLinear).toBe(BIOS_ROM_BASE);
    expect(r.baseLinear).toBe(0xF0000);
  });

  it('fills unused space with 0xFF (open-bus / blank ROM convention)', () => {
    const r = buildBiosRom();
    // A region we know is empty: mid-ROM, well past the trap table and the
    // diskette parameter table, well before the reset vector.
    expect(r.bytes[0x4000]).toBe(0xFF);
    expect(r.bytes[0x8000]).toBe(0xFF);
    expect(r.bytes[0xC000]).toBe(0xFF);
  });
});

describe('buildBiosRom — reset vector', () => {
  it('places a far-jump at offset 0xFFF0 to F000:0100', () => {
    const r = buildBiosRom();
    // EA off_lo off_hi seg_lo seg_hi  →  JMP F000:0100
    expect(r.bytes[BIOS_RESET_VECTOR_OFFSET + 0]).toBe(0xEA);
    expect(r.bytes[BIOS_RESET_VECTOR_OFFSET + 1]).toBe(0x00);
    expect(r.bytes[BIOS_RESET_VECTOR_OFFSET + 2]).toBe(0x01);
    expect(r.bytes[BIOS_RESET_VECTOR_OFFSET + 3]).toBe(0x00);
    expect(r.bytes[BIOS_RESET_VECTOR_OFFSET + 4]).toBe(0xF0);
  });

  it('exposes the reset-vector linear address in the layout', () => {
    const r = buildBiosRom();
    expect(r.layout.resetVector).toBe(0xFFFF0);
  });
});

describe('buildBiosRom — init code', () => {
  it('starts at offset 0x100', () => {
    const r = buildBiosRom();
    // First instruction is CLI (0xFA).
    expect(r.bytes[BIOS_INIT_OFFSET]).toBe(0xFA);
  });

  it('initCodeLength stays under the 200-byte budget called out in the brief', () => {
    const r = buildBiosRom();
    expect(r.layout.initCodeLength).toBeLessThan(200);
    expect(r.layout.initCodeLength).toBeGreaterThan(40);
  });

  it('exposes the init-entry linear address in the layout', () => {
    const r = buildBiosRom();
    expect(r.layout.initEntry).toBe(0xF0100);
  });
});

describe('buildBiosRom — trap stub table', () => {
  it('every IVT entry has an IRET stub (0xCF) at its trap address', () => {
    const r = buildBiosRom();
    for (let n = 0; n < 256; n++) {
      const offset = BIOS_TRAP_TABLE_OFFSET + n;
      expect(r.bytes[offset]).toBe(0xCF);
    }
  });

  it('trapAddresses contains all 256 entries with correct linear addresses', () => {
    const r = buildBiosRom();
    expect(Object.keys(r.layout.trapAddresses).length).toBe(256);
    for (let n = 0; n < 256; n++) {
      expect(r.layout.trapAddresses[n]).toBe(0xF1000 + n);
    }
  });

  it('trapAddressForVector matches the layout', () => {
    const r = buildBiosRom();
    expect(trapAddressForVector(0x10)).toBe(r.layout.trapAddresses[0x10]);
    expect(trapAddressForVector(0x13)).toBe(r.layout.trapAddresses[0x13]);
    expect(trapAddressForVector(0x19)).toBe(r.layout.trapAddresses[0x19]);
  });

  it('rejects out-of-range vectors', () => {
    expect(() => trapAddressForVector(-1)).toThrow();
    expect(() => trapAddressForVector(256)).toThrow();
    expect(() => trapAddressForVector(1.5)).toThrow();
  });
});

describe('buildBiosRom — diskette parameter table', () => {
  it('plants 11 bytes of typical 1.44 MB floppy parameters at F000:2000', () => {
    const r = buildBiosRom();
    // First few bytes: specify-1, specify-2, motor-wait, bytes-per-sector code.
    expect(r.bytes[0x2000]).toBe(0xDF);
    expect(r.bytes[0x2001]).toBe(0x02);
    expect(r.bytes[0x2002]).toBe(0x25);
    expect(r.bytes[0x2003]).toBe(0x02);
    expect(r.bytes[0x2004]).toBe(0x12);   // sectors/track = 18
    expect(r.layout.disketteParamTable).toBe(0xF2000);
  });
});

describe('buildBiosRom — determinism', () => {
  it('produces byte-identical output across repeated calls', () => {
    const a = buildBiosRom();
    const b = buildBiosRom();
    expect(a.bytes).toEqual(b.bytes);
    expect(a.layout).toEqual(b.layout);
  });
});
