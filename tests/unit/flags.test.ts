import { describe, expect, it } from 'vitest';
import { FLAG, Flags } from '../../src/core/flags.js';

describe('Flags', () => {
  it('initialises with 8086 reserved bits set', () => {
    const f = new Flags();
    // bit 1 + bits 12-15 always set on 8086
    expect(f.value).toBe(0xF002);
    expect(f.CF).toBe(false);
    expect(f.ZF).toBe(false);
  });

  it('individual flag setters are independent', () => {
    const f = new Flags();
    f.CF = true;
    expect(f.CF).toBe(true);
    expect(f.ZF).toBe(false);
    expect(f.value & FLAG.CF).toBeTruthy();
  });

  it('enforces always-set bits on raw value writes', () => {
    const f = new Flags();
    // Try to clear everything including reserved bits
    f.value = 0x0000;
    // Reserved bits should come back
    expect(f.value).toBe(0xF002);
  });

  it('drops always-zero bits on raw value writes', () => {
    const f = new Flags();
    // Bits 3 and 5 must stay zero
    f.value = 0xFFFF;
    expect(f.value & (1 << 3)).toBe(0);
    expect(f.value & (1 << 5)).toBe(0);
    // But all real flags are set
    expect(f.CF).toBe(true);
    expect(f.ZF).toBe(true);
    expect(f.OF).toBe(true);
  });

  it('setting a flag false clears only that flag', () => {
    const f = new Flags();
    f.value = 0xFFFF;  // all real flags on
    f.CF = false;
    expect(f.CF).toBe(false);
    expect(f.ZF).toBe(true);
    expect(f.OF).toBe(true);
  });

  it('reset() returns to power-on state', () => {
    const f = new Flags();
    f.CF = true; f.ZF = true; f.IF = true;
    f.reset();
    expect(f.value).toBe(0xF002);
  });

  it('FLAG constants match bit positions', () => {
    expect(FLAG.CF).toBe(1 << 0);
    expect(FLAG.PF).toBe(1 << 2);
    expect(FLAG.AF).toBe(1 << 4);
    expect(FLAG.ZF).toBe(1 << 6);
    expect(FLAG.SF).toBe(1 << 7);
    expect(FLAG.IF).toBe(1 << 9);
    expect(FLAG.DF).toBe(1 << 10);
    expect(FLAG.OF).toBe(1 << 11);
  });
});
