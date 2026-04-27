import { FLAG, type Flags } from '../core/flags.js';
import { PARITY_TABLE } from './parity.js';

/**
 * Flag-computation helpers for ALU ops.
 *
 * We split by operand width (8 vs 16) rather than branching inside a single
 * helper. The masks, sign bits, and carry-out positions differ, and this is
 * the hottest code in the whole emulator — one branch per op across thousands
 * of instructions is measurable.
 *
 * Reference: Intel 8086 Family User's Manual, Appendix A (flag effects).
 *
 * Convention for all helpers:
 *   - Inputs `a` and `b` are the raw operands as presented to the ALU
 *     (unsigned, already masked to the right width).
 *   - `result` is the full unmasked arithmetic result — e.g., for ADD:
 *       result = a + b                    (NOT  (a + b) & 0xFFFF)
 *     We need the unmasked value to detect carry-out. The caller is
 *     responsible for masking before writing back to a register.
 */

// --- ADD -------------------------------------------------------------

/**
 * Set CF PF AF ZF SF OF after an 8-bit add.
 *   a, b:    0..0xFF operands
 *   result:  a + b (0..0x1FE, unmasked so we can read bit 8 as carry)
 */
export function flagsAdd8(flags: Flags, a: number, b: number, result: number): void {
  const r8 = result & 0xFF;
  let f = flags.value;

  // Carry: bit 8 of the unmasked result
  f = result & 0x100 ? (f | FLAG.CF) : (f & ~FLAG.CF);

  // Parity: PF of low byte
  f = PARITY_TABLE[r8]! ? (f | FLAG.PF) : (f & ~FLAG.PF);

  // Aux carry: carry out of bit 3 = bit 4 of (a XOR b XOR result)
  f = (a ^ b ^ result) & 0x10 ? (f | FLAG.AF) : (f & ~FLAG.AF);

  // Zero: masked result is 0
  f = r8 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);

  // Sign: bit 7 of masked result
  f = r8 & 0x80 ? (f | FLAG.SF) : (f & ~FLAG.SF);

  // Overflow (signed): set when operands have same sign but result differs.
  //   (a ^ result) & (b ^ result) & sign_bit
  f = ((a ^ result) & (b ^ result) & 0x80) ? (f | FLAG.OF) : (f & ~FLAG.OF);

  flags.value = f;
}

/**
 * Set CF PF AF ZF SF OF after a 16-bit add.
 *   a, b:    0..0xFFFF operands
 *   result:  a + b (0..0x1FFFE, unmasked)
 */
export function flagsAdd16(flags: Flags, a: number, b: number, result: number): void {
  const r16 = result & 0xFFFF;
  let f = flags.value;

  f = result & 0x10000 ? (f | FLAG.CF) : (f & ~FLAG.CF);
  f = PARITY_TABLE[r16 & 0xFF]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = (a ^ b ^ result) & 0x10 ? (f | FLAG.AF) : (f & ~FLAG.AF);
  f = r16 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r16 & 0x8000 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  f = ((a ^ result) & (b ^ result) & 0x8000) ? (f | FLAG.OF) : (f & ~FLAG.OF);

  flags.value = f;
}

// --- SUB / CMP -------------------------------------------------------
//
// CMP is SUB without writeback: same flag computation, caller discards result.
//
// CF on SUB: set when there's a *borrow*, i.e. unsigned a < b. The trick that
// makes the same code work as ADD: in two's complement, (a - b) computed as
// `a + (~b & 0xFF) + 1` produces a "borrow-out" that lands at bit 8 — which is
// what we get back from `a - b` followed by `result & 0x100` (negative results
// have bit 8 set after the implicit sign extension JS gives us).

export function flagsSub8(flags: Flags, a: number, b: number, result: number): void {
  const r8 = result & 0xFF;
  let f = flags.value;
  f = result & 0x100 ? (f | FLAG.CF) : (f & ~FLAG.CF);
  f = PARITY_TABLE[r8]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = (a ^ b ^ result) & 0x10 ? (f | FLAG.AF) : (f & ~FLAG.AF);
  f = r8 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r8 & 0x80 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  // OF for subtraction: operands have different signs AND the result's sign
  // differs from `a`. Equivalent to (a ^ b) & (a ^ result) & sign_bit.
  f = ((a ^ b) & (a ^ result) & 0x80) ? (f | FLAG.OF) : (f & ~FLAG.OF);
  flags.value = f;
}

export function flagsSub16(flags: Flags, a: number, b: number, result: number): void {
  const r16 = result & 0xFFFF;
  let f = flags.value;
  f = result & 0x10000 ? (f | FLAG.CF) : (f & ~FLAG.CF);
  f = PARITY_TABLE[r16 & 0xFF]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = (a ^ b ^ result) & 0x10 ? (f | FLAG.AF) : (f & ~FLAG.AF);
  f = r16 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r16 & 0x8000 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  f = ((a ^ b) & (a ^ result) & 0x8000) ? (f | FLAG.OF) : (f & ~FLAG.OF);
  flags.value = f;
}

// --- Logical (AND / OR / XOR / TEST) --------------------------------
//
// CF and OF are forced to 0. AF is left "undefined" by Intel — we set it to 0
// for determinism and rely on the SST corpus's flagsMask to ignore the bit
// when comparing against real-hardware output. PF/ZF/SF are normal.

export function flagsLogic8(flags: Flags, result: number): void {
  const r8 = result & 0xFF;
  let f = flags.value;
  f &= ~(FLAG.CF | FLAG.OF | FLAG.AF);
  f = PARITY_TABLE[r8]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = r8 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r8 & 0x80 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  flags.value = f;
}

export function flagsLogic16(flags: Flags, result: number): void {
  const r16 = result & 0xFFFF;
  let f = flags.value;
  f &= ~(FLAG.CF | FLAG.OF | FLAG.AF);
  f = PARITY_TABLE[r16 & 0xFF]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = r16 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r16 & 0x8000 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  flags.value = f;
}

// --- INC / DEC -------------------------------------------------------
//
// INC and DEC are ADD/SUB with the operand 1, EXCEPT they don't touch CF.
// That makes them useful inside loops that need to preserve a running carry.
// Easy mistake: forgetting the "don't touch CF" rule.

export function flagsInc8(flags: Flags, before: number, result: number): void {
  const r8 = result & 0xFF;
  let f = flags.value;
  // CF intentionally NOT written.
  f = PARITY_TABLE[r8]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = (before ^ 1 ^ result) & 0x10 ? (f | FLAG.AF) : (f & ~FLAG.AF);
  f = r8 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r8 & 0x80 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  // OF: only set when 0x7F → 0x80
  f = (before === 0x7F) ? (f | FLAG.OF) : (f & ~FLAG.OF);
  flags.value = f;
}

export function flagsInc16(flags: Flags, before: number, result: number): void {
  const r16 = result & 0xFFFF;
  let f = flags.value;
  f = PARITY_TABLE[r16 & 0xFF]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = (before ^ 1 ^ result) & 0x10 ? (f | FLAG.AF) : (f & ~FLAG.AF);
  f = r16 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r16 & 0x8000 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  f = (before === 0x7FFF) ? (f | FLAG.OF) : (f & ~FLAG.OF);
  flags.value = f;
}

export function flagsDec8(flags: Flags, before: number, result: number): void {
  const r8 = result & 0xFF;
  let f = flags.value;
  // CF intentionally NOT written.
  f = PARITY_TABLE[r8]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = (before ^ 1 ^ result) & 0x10 ? (f | FLAG.AF) : (f & ~FLAG.AF);
  f = r8 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r8 & 0x80 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  // OF: only set when 0x80 → 0x7F
  f = (before === 0x80) ? (f | FLAG.OF) : (f & ~FLAG.OF);
  flags.value = f;
}

export function flagsDec16(flags: Flags, before: number, result: number): void {
  const r16 = result & 0xFFFF;
  let f = flags.value;
  f = PARITY_TABLE[r16 & 0xFF]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = (before ^ 1 ^ result) & 0x10 ? (f | FLAG.AF) : (f & ~FLAG.AF);
  f = r16 === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = r16 & 0x8000 ? (f | FLAG.SF) : (f & ~FLAG.SF);
  f = (before === 0x8000) ? (f | FLAG.OF) : (f & ~FLAG.OF);
  flags.value = f;
}
