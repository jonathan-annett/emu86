import type { Word } from './types.js';

/**
 * 8086 FLAGS register.
 *
 * Bit layout (8086):
 *   0   CF  Carry
 *   1   -   (reserved, always 1)
 *   2   PF  Parity
 *   3   -   (reserved, always 0)
 *   4   AF  Auxiliary carry
 *   5   -   (reserved, always 0)
 *   6   ZF  Zero
 *   7   SF  Sign
 *   8   TF  Trap
 *   9   IF  Interrupt enable
 *   10  DF  Direction
 *   11  OF  Overflow
 *   12-15 - (reserved, always 1 on 8086)
 *
 * On 80286 real mode, bits 12-15 are no longer forced to 1 (IOPL/NT live
 * in bits 12-14 in protected mode). For now we force the 8086 behaviour;
 * the 80286 core will override `value` setter semantics.
 */

export const FLAG = {
  CF: 1 << 0,
  PF: 1 << 2,
  AF: 1 << 4,
  ZF: 1 << 6,
  SF: 1 << 7,
  TF: 1 << 8,
  IF: 1 << 9,
  DF: 1 << 10,
  OF: 1 << 11,
} as const;

/** Writable mask for 8086 FLAGS: CF PF AF ZF SF TF IF DF OF. */
const WRITABLE_8086 = FLAG.CF | FLAG.PF | FLAG.AF | FLAG.ZF | FLAG.SF
                    | FLAG.TF | FLAG.IF | FLAG.DF | FLAG.OF;
/** Always-set bits on 8086: bit 1, bits 12-15. */
const ALWAYS_SET_8086 = 0xF002;

export class Flags {
  private _value: Word = ALWAYS_SET_8086;

  /** Raw 16-bit value, with reserved bits enforced. */
  get value(): Word {
    return this._value;
  }
  set value(v: Word) {
    this._value = ((v & WRITABLE_8086) | ALWAYS_SET_8086) & 0xFFFF;
  }

  // Individual boolean accessors. Hot path instructions can still use
  // bitwise ops directly against `value`; these are for clarity.
  get CF(): boolean { return (this._value & FLAG.CF) !== 0; }
  set CF(v: boolean) { this._value = v ? (this._value | FLAG.CF) : (this._value & ~FLAG.CF); }

  get PF(): boolean { return (this._value & FLAG.PF) !== 0; }
  set PF(v: boolean) { this._value = v ? (this._value | FLAG.PF) : (this._value & ~FLAG.PF); }

  get AF(): boolean { return (this._value & FLAG.AF) !== 0; }
  set AF(v: boolean) { this._value = v ? (this._value | FLAG.AF) : (this._value & ~FLAG.AF); }

  get ZF(): boolean { return (this._value & FLAG.ZF) !== 0; }
  set ZF(v: boolean) { this._value = v ? (this._value | FLAG.ZF) : (this._value & ~FLAG.ZF); }

  get SF(): boolean { return (this._value & FLAG.SF) !== 0; }
  set SF(v: boolean) { this._value = v ? (this._value | FLAG.SF) : (this._value & ~FLAG.SF); }

  get TF(): boolean { return (this._value & FLAG.TF) !== 0; }
  set TF(v: boolean) { this._value = v ? (this._value | FLAG.TF) : (this._value & ~FLAG.TF); }

  get IF(): boolean { return (this._value & FLAG.IF) !== 0; }
  set IF(v: boolean) { this._value = v ? (this._value | FLAG.IF) : (this._value & ~FLAG.IF); }

  get DF(): boolean { return (this._value & FLAG.DF) !== 0; }
  set DF(v: boolean) { this._value = v ? (this._value | FLAG.DF) : (this._value & ~FLAG.DF); }

  get OF(): boolean { return (this._value & FLAG.OF) !== 0; }
  set OF(v: boolean) { this._value = v ? (this._value | FLAG.OF) : (this._value & ~FLAG.OF); }

  /** Reset to power-on state (bit 1 + reserved bits set, all real flags clear). */
  reset(): void {
    this._value = ALWAYS_SET_8086;
  }
}
