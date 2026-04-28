/**
 * Shared numeric types and address helpers.
 *
 * TypeScript's `number` is a 64-bit float. We rely on bitwise operators
 * (which coerce to 32-bit int) plus explicit masks to keep values in range.
 * Types below are documentation-only — there's no runtime enforcement.
 */
/** Compute 20-bit linear address from seg:off. Masks to 20 bits (1 MiB wrap). */
export function linearAddress(segment, offset) {
    return (((segment << 4) + offset) >>> 0) & 0xFFFFF;
}
/** Sign-extend an 8-bit value to 16 bits. */
export function signExtend8(v) {
    return (v & 0x80) ? (v | 0xFF00) : v;
}
/** Sign-extend a 16-bit value to 32 bits (as signed number). */
export function signedWord(v) {
    return (v & 0x8000) ? v - 0x10000 : v;
}
/** Sign-extend an 8-bit value to a signed JS number. */
export function signedByte(v) {
    return (v & 0x80) ? v - 0x100 : v;
}
