/**
 * Pluggable backing store for persistence of memory pages.
 *
 * Implementations:
 *   - InMemoryPageStore  (default for Node tests; all data in a Map)
 *   - IndexedDBPageStore (browser; lazy module, not imported here)
 *   - FetchROMStore      (read-only; loads a BIOS or bootsector image)
 *   - CompositePageStore (layered: ROM over RAM-IDB)
 *
 * The API is coarse on purpose — we batch-load at hydrate() time rather than
 * per-page to keep page-in from ever appearing on the synchronous CPU path.
 *
 * All async methods should tolerate being called concurrently with CPU
 * execution on the main thread — they'll interleave at await points only.
 */
export interface PageStore {
  /**
   * True for stores that refuse writes (ROM, fetch-backed BIOS). `save()`
   * on a readonly store should be a no-op or throw, caller's choice by
   * convention — `PagedMemory` treats it as silent drop.
   */
  readonly readonly: boolean;

  /**
   * Load every persisted page. Called once during hydrate(). Implementations
   * should return an empty iterable on cold start.
   *
   * Return as an async iterable so large stores (up to ~4096 pages for 286)
   * can stream rather than materialise a giant array.
   */
  loadAll(): AsyncIterable<readonly [pageId: number, data: Uint8Array]>;

  /** Persist one page. May be called often; implementations should be cheap. */
  save(pageId: number, data: Uint8Array): Promise<void>;

  /** Drop all persisted state. Used in tests and for "reset session". */
  clear(): Promise<void>;
}

/**
 * Simple in-memory backing store. Used by tests and as a sensible default
 * when no persistence is wanted (hydrate() is a no-op on a fresh instance).
 */
export class InMemoryPageStore implements PageStore {
  readonly readonly: boolean = false;
  private readonly pages = new Map<number, Uint8Array>();

  async *loadAll(): AsyncIterable<readonly [number, Uint8Array]> {
    for (const [id, data] of this.pages) {
      // Yield copies so callers can't mutate our storage by reference.
      yield [id, new Uint8Array(data)];
    }
  }

  async save(pageId: number, data: Uint8Array): Promise<void> {
    // Copy on save so later mutations by the writer don't mutate our copy.
    this.pages.set(pageId, new Uint8Array(data));
  }

  async clear(): Promise<void> {
    this.pages.clear();
  }

  /** Test helper: direct count of persisted pages without awaiting. */
  get persistedCount(): number {
    return this.pages.size;
  }

  /** Test helper: peek at a persisted page (copy). */
  peek(pageId: number): Uint8Array | undefined {
    const p = this.pages.get(pageId);
    return p ? new Uint8Array(p) : undefined;
  }
}
