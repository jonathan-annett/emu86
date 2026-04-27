import { describe, expect, it } from 'vitest';
import { formatMismatches, runSSTCase } from './runner.js';
import type { SSTCase } from './types.js';

/**
 * Hand-crafted cases in the SingleStepTests JSON shape, exercising the
 * harness end-to-end. When we download the real corpus, the data shape is
 * identical — only the source of the test-case objects changes.
 */

describe('SST harness', () => {
  it('passes a synthetic NOP case', () => {
    // NOP at F000:0000 — linear 0xF0000
    const tc: SSTCase = {
      name: 'NOP baseline',
      initial: {
        regs: { cs: 0xF000, ip: 0x0000, flags: 0xF002 },
        ram: [[0xF0000, 0x90]],
      },
      final: {
        regs: { cs: 0xF000, ip: 0x0001, flags: 0xF002 },
        ram: [],
      },
    };
    const r = runSSTCase(tc);
    expect(r.pass, formatMismatches(r)).toBe(true);
  });

  it('passes a synthetic MOV AX, imm16 case', () => {
    // B8 34 12  =>  MOV AX, 0x1234
    const tc: SSTCase = {
      name: 'MOV AX, 0x1234',
      initial: {
        regs: { cs: 0, ip: 0, ax: 0x0000, flags: 0xF002 },
        ram: [[0, 0xB8], [1, 0x34], [2, 0x12]],
      },
      final: {
        regs: { cs: 0, ip: 3, ax: 0x1234, flags: 0xF002 },
        ram: [],
      },
    };
    const r = runSSTCase(tc);
    expect(r.pass, formatMismatches(r)).toBe(true);
  });

  it('passes a synthetic ADD AL, imm8 case with flag effects', () => {
    // 04 01   =>  ADD AL, 0x01 with AL = 0x7F  =>  AL=0x80, OF=SF=AF=1
    // Expected flags: 0xF002 (reserved) | OF | SF | AF | PF(0x80 has 1 bit, odd → 0)
    // Actually 0x80 has 1 set bit → parity odd → PF=0. Start with reserved bits.
    // Set bits:   OF (0x800), SF (0x80), AF (0x10)  = 0x890
    const expectedFlags = 0xF002 | 0x800 | 0x80 | 0x10;
    const tc: SSTCase = {
      name: 'ADD AL, 0x01 (overflow)',
      initial: {
        regs: { cs: 0, ip: 0, ax: 0x007F, flags: 0xF002 },
        ram: [[0, 0x04], [1, 0x01]],
      },
      final: {
        regs: { cs: 0, ip: 2, ax: 0x0080, flags: expectedFlags },
        ram: [],
      },
    };
    const r = runSSTCase(tc);
    expect(r.pass, formatMismatches(r)).toBe(true);
  });

  it('reports register mismatches clearly', () => {
    const tc: SSTCase = {
      name: 'broken NOP',
      initial: {
        regs: { cs: 0, ip: 0, ax: 0x0001 },
        ram: [[0, 0x90]],
      },
      final: {
        regs: { cs: 0, ip: 1, ax: 0x9999 },    // wrong — NOP doesn't touch AX
        ram: [],
      },
    };
    const r = runSSTCase(tc);
    expect(r.pass).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]!.kind).toBe('reg');
    expect(r.mismatches[0]!.name).toBe('ax');
    expect(r.mismatches[0]!.actual).toBe(0x0001);
    expect(r.mismatches[0]!.expected).toBe(0x9999);
  });

  it('reports RAM mismatches', () => {
    // Write a memory effect that we'll check — but v0 has no opcodes that
    // write memory, so we deliberately set up a case where the expected
    // final RAM differs from the actual (because NOP doesn't write).
    const tc: SSTCase = {
      name: 'expected memory write that never happens',
      initial: {
        regs: { cs: 0, ip: 0 },
        ram: [[0, 0x90], [0x1000, 0x00]],
      },
      final: {
        regs: { cs: 0, ip: 1 },
        ram: [[0x1000, 0xAA]],     // harness will see 0x00 and fail
      },
    };
    const r = runSSTCase(tc);
    expect(r.pass).toBe(false);
    const ramMismatch = r.mismatches.find((m) => m.kind === 'ram');
    expect(ramMismatch?.expected).toBe(0xAA);
    expect(ramMismatch?.actual).toBe(0x00);
  });

  it('flagsMask option ignores bits outside the mask', () => {
    // Fake an "expected flags" that differs from ours only in bit 3 (always 0
    // in our model) — masking should ignore that.
    const tc: SSTCase = {
      name: 'NOP with different reserved flag layout',
      initial: {
        regs: { cs: 0, ip: 0, flags: 0xF002 },
        ram: [[0, 0x90]],
      },
      final: {
        regs: { cs: 0, ip: 1, flags: 0xF00A },  // bit 3 set — not writable on us
        ram: [],
      },
    };
    // Without a mask, we see the reserved bit discrepancy
    expect(runSSTCase(tc).pass).toBe(false);
    // Mask out bit 3 and it passes
    expect(runSSTCase(tc, { flagsMask: ~(1 << 3) & 0xFFFF }).pass).toBe(true);
  });
});
