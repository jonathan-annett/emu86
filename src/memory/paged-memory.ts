import type { Byte, LinearAddress, Word } from '../core/types.js';
import { DEFAULT_PAGE_SIZE, type Memory } from './memory.js';
import type { PageStore } from './page-store.js';

/**
 * A synchronous, fault-free paged memory with lazy write-behind persistence.
 *
 * Model:
 *   - All currently-in-use pages live resident in a Map<pageId, PageSlab>.
 *   - Reads/writes are pure synchronous Map lookups + typed-array indexing.
 *   - Pages never evict. Our address spaces (1 MiB for 8086, 16 MiB for
 *     286-real) fit comfortably in a browser tab, so there's no memory
 *     pressure reason to drop pages. The Map is the working set.
 *   - Dirty pages are tracked in a Set. A separate async loop ("write-back")
 *     periodically drains this Set into the backing PageStore.
 *
 * Why no fault path:
 *   A fault path (throw on absent page, retry after async load) requires
 *   snapshot/restore on the CPU and wraps the run loop in try/catch per
 *   instruction. By committing to "always resident," we delete all of
 *   that complexity in exchange for a one-time hydrate() cost at startup.
 *
 * Concurrency:
 *   JS is single-threaded within an agent. The only interleaving between
 *   CPU writes and the write-back loop happens at `await` points. We use
 *   a clear-then-snapshot pattern so concurrent writes during a flush
 *   never get lost (they just trigger an extra flush next cycle).
 */

export interface PagedMemoryOptions {
  /** Page size in bytes. Must be a power of two. Default 4096. */
  pageSize?: number;
  /** Address space size in bytes. Default 1 MiB (8086). */
  addressSpaceSize?: number;
  /** Backing store for persistence. Optional — omit for pure-RAM operation. */
  store?: PageStore;
}

interface PageSlab {
  readonly data: Uint8Array;
  // We don't need a per-slab dirty flag — the dirty Set is authoritative.
  //
  // `readonly` marks ROM pages: writes from the CPU are silently dropped
  // (matching real-hardware bus behaviour) and never enter the dirty set.
  // RAM pages have `readonly: false` and behave exactly as before.
  readonly: boolean;
}

export interface WriteBackOptions {
  /** Interval between flush passes (ms). Default 1000. */
  intervalMs?: number;
}

/**
 * Serialized RAM image (Phase 18 M1). Carries every resident RAM page;
 * ROM pages are deliberately excluded — they are rebuilt deterministically
 * at machine construction (`buildBiosRom()`), so serializing them would
 * only bloat the snapshot and invite fingerprint drift.
 */
export interface PagedMemoryState {
  readonly v: 1;
  /** Page size the pages were captured at. Restore refuses a mismatch. */
  readonly pageSize: number;
  /** Non-ROM resident pages, sorted by pageId. Bytes are copies. */
  readonly pages: ReadonlyArray<{ readonly pageId: number; readonly bytes: Uint8Array }>;
}

export class PagedMemory implements Memory {
  readonly pageSize: number;
  readonly pageMask: number;          // pageSize - 1, for offset-in-page
  readonly pageShift: number;         // log2(pageSize), for address → pageId
  readonly addressSpaceSize: number;
  readonly addressMask: number;       // addressSpaceSize - 1

  private readonly pages = new Map<number, PageSlab>();
  private readonly dirty = new Set<number>();
  private readonly store: PageStore | undefined;

  // Write-back loop state
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wakeSleeper: (() => void) | null = null;

  constructor(opts: PagedMemoryOptions = {}) {
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    if (pageSize <= 0 || (pageSize & (pageSize - 1)) !== 0) {
      throw new Error(`pageSize must be a positive power of two (got ${pageSize})`);
    }
    const addressSpaceSize = opts.addressSpaceSize ?? 0x100000;  // 1 MiB default
    if (addressSpaceSize <= 0 || (addressSpaceSize & (addressSpaceSize - 1)) !== 0) {
      throw new Error(`addressSpaceSize must be a positive power of two`);
    }
    if (addressSpaceSize < pageSize) {
      throw new Error(`addressSpaceSize must be >= pageSize`);
    }

    this.pageSize = pageSize;
    this.pageMask = pageSize - 1;
    this.pageShift = Math.log2(pageSize);
    this.addressSpaceSize = addressSpaceSize;
    this.addressMask = addressSpaceSize - 1;
    this.store = opts.store;
  }

  // ============================================================
  // CPU-facing sync API (hot path — keep these tight)
  // ============================================================

  readByte(addr: LinearAddress): Byte {
    const a = addr & this.addressMask;
    const pageId = a >>> this.pageShift;
    const off = a & this.pageMask;
    const slab = this.pages.get(pageId) ?? this.#materialisePage(pageId);
    return slab.data[off]!;
  }

  readWord(addr: LinearAddress): Word {
    // Two byte reads — handles page boundary crossing for free.
    const lo = this.readByte(addr);
    const hi = this.readByte(addr + 1);
    return ((hi << 8) | lo) & 0xFFFF;
  }

  writeByte(addr: LinearAddress, v: Byte): void {
    const a = addr & this.addressMask;
    const pageId = a >>> this.pageShift;
    const off = a & this.pageMask;
    const slab = this.pages.get(pageId) ?? this.#materialisePage(pageId);
    // ROM pages: silently drop the write, do NOT enter the dirty set.
    // Real hardware ignores writes to ROM at the bus level — no fault, no
    // side effect. Adding to `dirty` here would cause the write-back loop
    // to attempt to persist ROM pages, which is a bug we explicitly avoid.
    if (slab.readonly) return;
    slab.data[off] = v & 0xFF;
    this.dirty.add(pageId);
  }

  writeWord(addr: LinearAddress, v: Word): void {
    this.writeByte(addr,     v & 0xFF);
    this.writeByte(addr + 1, (v >>> 8) & 0xFF);
  }

  // ============================================================
  // Host-facing control plane (async, called from run loop / setup)
  // ============================================================

  /**
   * Populate the cache from the backing store. Call once before starting
   * the CPU, after constructing the memory. Safe no-op if no store is set.
   */
  async hydrate(): Promise<void> {
    if (!this.store) return;
    for await (const [pageId, data] of this.store.loadAll()) {
      if (data.length !== this.pageSize) {
        throw new Error(
          `store page ${pageId} size ${data.length} !== pageSize ${this.pageSize}`
        );
      }
      // Copy into a freshly-allocated slab so the store's buffer isn't aliased.
      const slab: PageSlab = { data: new Uint8Array(data), readonly: false };
      this.pages.set(pageId, slab);
      // Hydrated pages are clean by definition.
    }
  }

  /**
   * Start the background write-back loop. Idempotent — second call is a no-op.
   */
  startWriteBack(opts: WriteBackOptions = {}): void {
    if (!this.store || this.store.readonly) return;  // nothing to write
    if (this.running) return;
    this.running = true;
    const intervalMs = opts.intervalMs ?? 1000;
    this.loopPromise = this.#writeBackLoop(intervalMs);
  }

  /**
   * Stop the write-back loop and wait for its final drain to complete.
   * Ensures no in-flight or pending writes are lost.
   */
  async stopWriteBack(): Promise<void> {
    if (!this.running) {
      // Still need to wait if a previous loop is exiting.
      if (this.loopPromise) await this.loopPromise;
      return;
    }
    this.running = false;
    this.wakeSleeper?.();
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
  }

  /**
   * Drain all currently-dirty pages to the store immediately. Returns the
   * number of pages written. Safe to call at any time (including while the
   * background loop is running).
   */
  async flushDirty(): Promise<number> {
    if (!this.store || this.store.readonly) {
      // Writes would be discarded — just clear the dirty set to keep it bounded.
      const n = this.dirty.size;
      this.dirty.clear();
      return n;
    }

    // Snapshot and clear the dirty set atomically (sync block).
    // Any CPU write during the async saves below re-adds to dirty and will
    // be picked up on the next drain. This is the race-free anchor point.
    const batch = Array.from(this.dirty);
    this.dirty.clear();

    let written = 0;
    for (const pageId of batch) {
      const slab = this.pages.get(pageId);
      if (!slab) continue;  // defensive: can't happen in current code

      // Copy the slab bytes BEFORE the await so the persisted snapshot is
      // a consistent point-in-time image. A write that lands after this
      // line will re-add pageId to dirty and be captured next time.
      const snapshot = new Uint8Array(slab.data);
      await this.store.save(pageId, snapshot);
      written++;
    }
    return written;
  }

  // ============================================================
  // Introspection (tests, debug)
  // ============================================================

  get dirtyCount(): number { return this.dirty.size; }
  get residentCount(): number { return this.pages.size; }

  dirtyPages(): Iterable<number> {
    // Return a copy so callers can't accidentally mutate our state.
    return Array.from(this.dirty);
  }

  residentPages(): Iterable<number> {
    return Array.from(this.pages.keys());
  }

  /** Test helper: directly materialise a page (skip the read/write path). */
  ensurePage(pageId: number): void {
    if (!this.pages.has(pageId)) this.#materialisePage(pageId);
  }

  /** Test helper: check whether a page has been materialised (without creating one). */
  hasPage(pageId: number): boolean {
    return this.pages.has(pageId);
  }

  /** True if the page at `pageId` is marked read-only (ROM). False for RAM
   *  pages or pages that haven't been materialised. */
  isReadOnly(pageId: number): boolean {
    return this.pages.get(pageId)?.readonly ?? false;
  }

  // ============================================================
  // State plane (Phase 18 M1 — the brief's scoped rule-3 addition)
  // ============================================================

  /**
   * Copy the bytes of one resident page. Returns `null` for pages that
   * have never been materialised (their content is all-zero by
   * construction). The returned array is a copy — callers can't alias
   * our slabs.
   */
  getPageBytes(pageId: number): Uint8Array | null {
    const slab = this.pages.get(pageId);
    return slab ? new Uint8Array(slab.data) : null;
  }

  /**
   * Serialize every resident RAM page (ROM pages excluded — see
   * {@link PagedMemoryState}). Pages are emitted sorted by pageId so two
   * captures of identical memory compare byte-for-byte without a sort.
   */
  serializeState(): PagedMemoryState {
    const pages: Array<{ pageId: number; bytes: Uint8Array }> = [];
    const ids = Array.from(this.pages.keys()).sort((a, b) => a - b);
    for (const pageId of ids) {
      const slab = this.pages.get(pageId);
      if (!slab || slab.readonly) continue;
      pages.push({ pageId, bytes: new Uint8Array(slab.data) });
    }
    return { v: 1, pageSize: this.pageSize, pages };
  }

  /**
   * Overwrite RAM with a serialized image:
   *
   *   - Every RAM page in `state` is materialised (if needed) and its
   *     bytes replaced. Restored pages enter the dirty set — a backing
   *     store, when present, must be told their contents changed.
   *   - Resident RAM pages NOT in `state` are dropped entirely, so the
   *     resident set matches the capture exactly (a later
   *     `serializeState()` round-trips byte-identically).
   *   - ROM pages are untouched. A `state` page that collides with a
   *     resident ROM page is a configuration mismatch — fail loud.
   *
   * Validation runs before any mutation, so a thrown restore leaves
   * memory in its prior state.
   */
  restoreState(state: PagedMemoryState): void {
    if (state.v !== 1) {
      throw new Error(`PagedMemory.restoreState: unsupported schema version ${String(state.v)}`);
    }
    if (state.pageSize !== this.pageSize) {
      throw new Error(
        `PagedMemory.restoreState: pageSize mismatch (state ${state.pageSize}, memory ${this.pageSize})`,
      );
    }
    const maxPageId = (this.addressSpaceSize >>> this.pageShift) - 1;
    for (const { pageId, bytes } of state.pages) {
      if (!Number.isInteger(pageId) || pageId < 0 || pageId > maxPageId) {
        throw new Error(`PagedMemory.restoreState: pageId ${pageId} out of range (max ${maxPageId})`);
      }
      if (bytes.length !== this.pageSize) {
        throw new Error(
          `PagedMemory.restoreState: page ${pageId} has ${bytes.length} bytes (pageSize ${this.pageSize})`,
        );
      }
      if (this.pages.get(pageId)?.readonly) {
        throw new Error(
          `PagedMemory.restoreState: page ${pageId} is ROM here but RAM in the snapshot (config mismatch)`,
        );
      }
    }

    // Drop resident RAM pages absent from the snapshot (they were not
    // resident at capture, i.e. all-zero to the guest).
    const keep = new Set(state.pages.map((p) => p.pageId));
    for (const [pageId, slab] of this.pages) {
      if (slab.readonly || keep.has(pageId)) continue;
      this.pages.delete(pageId);
      this.dirty.delete(pageId);
    }

    for (const { pageId, bytes } of state.pages) {
      const slab = this.pages.get(pageId) ?? this.#materialisePage(pageId);
      slab.data.set(bytes);
      this.dirty.add(pageId);
    }
  }

  // ============================================================
  // ROM region support
  // ============================================================

  /**
   * Populate one or more pages with ROM bytes and mark them read-only.
   *
   * Constraints (all enforced — overlapping or misaligned ROM loads are
   * configuration bugs, fail loud):
   *   - `linearAddress` must be page-aligned.
   *   - `bytes.length` must be a positive multiple of `pageSize`.
   *   - No page in the affected range may already be a ROM page.
   *   - No page in the affected range may be in the dirty set (loading
   *     ROM over guest-modified RAM is suspicious; reset memory first).
   *
   * After this call:
   *   - Each affected page is resident with the supplied bytes.
   *   - Each affected page has `readonly: true`; CPU writes silently drop.
   *   - The dirty set is unchanged — `flushDirty()` will not persist ROM.
   *
   * Validation runs over all pages BEFORE any are mutated, so a thrown
   * loadROM leaves memory in its prior state.
   */
  loadROM(linearAddress: LinearAddress, bytes: Uint8Array | number[]): void {
    if (linearAddress < 0 || (linearAddress & this.pageMask) !== 0) {
      throw new Error(
        `loadROM: linearAddress 0x${linearAddress.toString(16)} is not page-aligned (pageSize=${this.pageSize})`,
      );
    }
    if (bytes.length === 0) {
      throw new Error(`loadROM: bytes must be non-empty`);
    }
    if ((bytes.length & this.pageMask) !== 0) {
      throw new Error(
        `loadROM: bytes.length ${bytes.length} is not a multiple of pageSize ${this.pageSize}`,
      );
    }

    const startPageId = linearAddress >>> this.pageShift;
    const numPages = bytes.length >>> this.pageShift;
    const endPageIdExclusive = startPageId + numPages;

    // Pre-validate every affected page before mutating any.
    for (let pageId = startPageId; pageId < endPageIdExclusive; pageId++) {
      const existing = this.pages.get(pageId);
      if (existing?.readonly) {
        throw new Error(
          `loadROM: page ${pageId} is already a ROM page (overlap)`,
        );
      }
      if (this.dirty.has(pageId)) {
        throw new Error(
          `loadROM: page ${pageId} is dirty; reset memory before loading ROM here`,
        );
      }
    }

    // Apply. Allocate a fresh Uint8Array per page so the caller's buffer
    // isn't aliased into our slabs.
    const src = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    for (let i = 0; i < numPages; i++) {
      const pageId = startPageId + i;
      const data = new Uint8Array(this.pageSize);
      data.set(src.subarray(i * this.pageSize, (i + 1) * this.pageSize));
      this.pages.set(pageId, { data, readonly: true });
      // Deliberately NOT adding to `dirty`. ROM is never persisted.
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  #materialisePage(pageId: number): PageSlab {
    const slab: PageSlab = { data: new Uint8Array(this.pageSize), readonly: false };
    this.pages.set(pageId, slab);
    // Fresh zero-page is clean (matches what the store would give us
    // for an absent page). Don't add to dirty.
    return slab;
  }

  async #writeBackLoop(intervalMs: number): Promise<void> {
    try {
      while (this.running) {
        await this.flushDirty();
        if (!this.running) break;
        await this.#sleep(intervalMs);
      }
    } finally {
      // Always do a final drain on exit so stopWriteBack() is lossless.
      await this.flushDirty();
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSleeper = null;
        resolve();
      }, ms);
      this.wakeSleeper = () => {
        clearTimeout(timer);
        this.wakeSleeper = null;
        resolve();
      };
    });
  }
}
