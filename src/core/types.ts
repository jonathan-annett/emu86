/**
 * Shared numeric types and address helpers.
 *
 * TypeScript's `number` is a 64-bit float. We rely on bitwise operators
 * (which coerce to 32-bit int) plus explicit masks to keep values in range.
 * Types below are documentation-only — there's no runtime enforcement.
 */

/** 8-bit unsigned value (0..255). */
export type Byte = number;

/** 16-bit unsigned value (0..65535). */
export type Word = number;

/**
 * 20-bit linear physical address (0..0xFFFFF).
 * 8086 wraps at 1 MiB. 80286 real mode can extend via the A20 gate;
 * we'll deal with that when we get there.
 */
export type LinearAddress = number;

/** Segment:offset pair, the native 8086 addressing form. */
export interface LogicalAddress {
  readonly segment: Word;
  readonly offset: Word;
}

/**
 * Compute the linear address from seg:off.
 *
 * XMS brief M1 (2026-07-16): masks to 21 bits, not 20. seg:off tops
 * out at FFFF:FFFF = 0x10FFEF — the HMA — and where the wrap happens
 * is the MEMORY's job, exactly like real hardware's A20 gate:
 *
 *   - A 1 MiB PagedMemory masks bit 20 away itself, so every machine
 *     built to date behaves BIT-IDENTICALLY (the SST corpus's wrap
 *     semantics included): (x & 0x1FFFFF) & 0xFFFFF === x & 0xFFFFF.
 *   - A >1 MiB machine exposes the HMA (A20 permanently enabled —
 *     ELKS's verify_a20 wrap test passes), and everything beyond
 *     1 MiB+64 K stays reachable only through the BIOS block-move
 *     trap, which is the XMS_INT15 model.
 *
 * The 8042's A20 flag remains decorative (no dynamic gating): a
 * >1 MiB machine is "A20 always on", a 1 MiB machine is "always off".
 */
export function linearAddress(segment: Word, offset: Word): LinearAddress {
  return (((segment << 4) + offset) >>> 0) & 0x1FFFFF;
}

/** Sign-extend an 8-bit value to 16 bits. */
export function signExtend8(v: Byte): Word {
  return (v & 0x80) ? (v | 0xFF00) : v;
}

/** Sign-extend a 16-bit value to 32 bits (as signed number). */
export function signedWord(v: Word): number {
  return (v & 0x8000) ? v - 0x10000 : v;
}

/** Sign-extend an 8-bit value to a signed JS number. */
export function signedByte(v: Byte): number {
  return (v & 0x80) ? v - 0x100 : v;
}
