import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { InvalidOpcodeError } from '../../src/cpu8086/errors.js';
import { OPCODE_TABLE } from '../../src/cpu8086/opcodes.js';
import { PagedMemory } from '../../src/memory/index.js';
import type { SegmentOverride } from '../../src/cpu8086/cpu.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0;
  cpu.regs.IP = 0;
  return cpu;
}

/**
 * Install a transient opcode at byte 0xFC for the duration of the callback.
 * Used to "spy" on what segOverride looks like *during* an inner handler.
 * 0xFC normally is CLD (we'll add it later) — we restore whatever was there.
 */
function withSpy(opcode: number, handler: (cpu: CPU8086) => void, fn: () => void): void {
  const prev = OPCODE_TABLE[opcode];
  OPCODE_TABLE[opcode] = handler;
  try { fn(); } finally { OPCODE_TABLE[opcode] = prev; }
}

describe('segment override prefixes (0x26/0x2E/0x36/0x3E)', () => {
  const cases: Array<[number, SegmentOverride, string]> = [
    [0x26, 0, 'ES'],
    [0x2E, 1, 'CS'],
    [0x36, 2, 'SS'],
    [0x3E, 3, 'DS'],
  ];

  for (const [op, expected, name] of cases) {
    it(`0x${op.toString(16)} sets segOverride to ${name} for the next opcode`, () => {
      // <prefix> 90 (NOP)
      const cpu = cpuWith([op, 0x90]);
      let seenOverride: SegmentOverride = null;
      withSpy(0x90, (c) => { seenOverride = c.segOverride; }, () => {
        cpu.step();
      });
      expect(seenOverride).toBe(expected);
      expect(cpu.regs.IP).toBe(2);   // prefix + NOP both consumed
    });
  }

  it('next step() resets segOverride to null', () => {
    // 26 90 90  — prefix + NOP, then plain NOP
    const cpu = cpuWith([0x26, 0x90, 0x90]);
    cpu.step();
    expect(cpu.segOverride).toBe(0);   // ES set by prefix, no opcode reset it
    cpu.step();
    expect(cpu.segOverride).toBe(null);
  });

  it('multiple prefixes — last one wins', () => {
    // 26 36 90  — ES override then SS override, then NOP
    const cpu = cpuWith([0x26, 0x36, 0x90]);
    let seen: SegmentOverride = null;
    withSpy(0x90, (c) => { seen = c.segOverride; }, () => {
      cpu.step();
    });
    expect(seen).toBe(2);  // SS wins
    expect(cpu.regs.IP).toBe(3);
  });

  it('prefix in front of an unimplemented opcode throws InvalidOpcodeError', () => {
    // After 0x60-0x6F were aliased to Jcc (per 8086 silicon), every
    // top-level byte 0x00-0xFF is mapped, so we can't easily exercise the
    // "prefix sees an unmapped byte" path without temporarily clearing one.
    // Verify the path by deleting the next opcode's slot for the duration
    // of the call.
    const cpu = cpuWith([0x26, 0x60]);   // ES: jo (alias of 0x70)
    const prev = OPCODE_TABLE[0x60];
    OPCODE_TABLE[0x60] = undefined;
    try {
      expect(() => cpu.step()).toThrow(InvalidOpcodeError);
    } finally {
      OPCODE_TABLE[0x60] = prev;
    }
  });
});
