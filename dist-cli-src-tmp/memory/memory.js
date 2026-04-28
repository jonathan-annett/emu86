/**
 * Default page size: 4 KiB.
 *
 * Not x86 hardware-paging related (8086/286-real have no paging hardware).
 * This is purely our storage granularity for the PagedMemory cache and for
 * persistence to IndexedDB. 4 KiB balances per-page overhead against the
 * size of each IDB value and matches the hardware page size we'll later
 * emulate if we extend to 386+.
 */
export const DEFAULT_PAGE_SIZE = 4096;
/**
 * Read a word from a Memory that may not support unaligned access natively.
 * x86 allows unaligned word reads; they may straddle a page boundary. This
 * helper composes two byte reads, so it works regardless of page alignment.
 */
export function readWordViaBytes(mem, addr) {
    const lo = mem.readByte(addr);
    const hi = mem.readByte(addr + 1);
    return ((hi << 8) | lo) & 0xFFFF;
}
export function writeWordViaBytes(mem, addr, v) {
    mem.writeByte(addr, v & 0xFF);
    mem.writeByte(addr + 1, (v >>> 8) & 0xFF);
}
