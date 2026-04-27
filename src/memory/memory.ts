import type { Byte, LinearAddress, Word } from '../core/types.js';

/**
 * What the CPU sees.
 *
 * All methods are synchronous. Implementations must NEVER throw or await
 * in the hot path — the CPU runs with the assumption that any resident
 * byte is one function call away. Async concerns (persistence, hydration)
 * live entirely on the {@link PagedMemory} control plane below.
 *
 * 8086 addresses wrap at 20 bits (1 MiB). 80286 real mode extends to 20-24
 * bits depending on the A20 gate. Implementations mask inputs themselves;
 * callers pass raw linear addresses from `linearAddress(seg, off)`.
 */
export interface Memory {
  readByte(addr: LinearAddress): Byte;
  readWord(addr: LinearAddress): Word;
  writeByte(addr: LinearAddress, v: Byte): void;
  writeWord(addr: LinearAddress, v: Word): void;
}

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
export function readWordViaBytes(mem: Memory, addr: LinearAddress): Word {
  const lo = mem.readByte(addr);
  const hi = mem.readByte(addr + 1);
  return ((hi << 8) | lo) & 0xFFFF;
}

export function writeWordViaBytes(mem: Memory, addr: LinearAddress, v: Word): void {
  mem.writeByte(addr,     v & 0xFF);
  mem.writeByte(addr + 1, (v >>> 8) & 0xFF);
}
