import { DEFAULT_PAGE_SIZE } from './memory.js';
export class PagedMemory {
    pageSize;
    pageMask; // pageSize - 1, for offset-in-page
    pageShift; // log2(pageSize), for address → pageId
    addressSpaceSize;
    addressMask; // addressSpaceSize - 1
    pages = new Map();
    dirty = new Set();
    store;
    // Write-back loop state
    running = false;
    loopPromise = null;
    wakeSleeper = null;
    constructor(opts = {}) {
        const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
        if (pageSize <= 0 || (pageSize & (pageSize - 1)) !== 0) {
            throw new Error(`pageSize must be a positive power of two (got ${pageSize})`);
        }
        const addressSpaceSize = opts.addressSpaceSize ?? 0x100000; // 1 MiB default
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
    readByte(addr) {
        const a = addr & this.addressMask;
        const pageId = a >>> this.pageShift;
        const off = a & this.pageMask;
        const slab = this.pages.get(pageId) ?? this.#materialisePage(pageId);
        return slab.data[off];
    }
    readWord(addr) {
        // Two byte reads — handles page boundary crossing for free.
        const lo = this.readByte(addr);
        const hi = this.readByte(addr + 1);
        return ((hi << 8) | lo) & 0xFFFF;
    }
    writeByte(addr, v) {
        const a = addr & this.addressMask;
        const pageId = a >>> this.pageShift;
        const off = a & this.pageMask;
        const slab = this.pages.get(pageId) ?? this.#materialisePage(pageId);
        // ROM pages: silently drop the write, do NOT enter the dirty set.
        // Real hardware ignores writes to ROM at the bus level — no fault, no
        // side effect. Adding to `dirty` here would cause the write-back loop
        // to attempt to persist ROM pages, which is a bug we explicitly avoid.
        if (slab.readonly)
            return;
        slab.data[off] = v & 0xFF;
        this.dirty.add(pageId);
    }
    writeWord(addr, v) {
        this.writeByte(addr, v & 0xFF);
        this.writeByte(addr + 1, (v >>> 8) & 0xFF);
    }
    // ============================================================
    // Host-facing control plane (async, called from run loop / setup)
    // ============================================================
    /**
     * Populate the cache from the backing store. Call once before starting
     * the CPU, after constructing the memory. Safe no-op if no store is set.
     */
    async hydrate() {
        if (!this.store)
            return;
        for await (const [pageId, data] of this.store.loadAll()) {
            if (data.length !== this.pageSize) {
                throw new Error(`store page ${pageId} size ${data.length} !== pageSize ${this.pageSize}`);
            }
            // Copy into a freshly-allocated slab so the store's buffer isn't aliased.
            const slab = { data: new Uint8Array(data), readonly: false };
            this.pages.set(pageId, slab);
            // Hydrated pages are clean by definition.
        }
    }
    /**
     * Start the background write-back loop. Idempotent — second call is a no-op.
     */
    startWriteBack(opts = {}) {
        if (!this.store || this.store.readonly)
            return; // nothing to write
        if (this.running)
            return;
        this.running = true;
        const intervalMs = opts.intervalMs ?? 1000;
        this.loopPromise = this.#writeBackLoop(intervalMs);
    }
    /**
     * Stop the write-back loop and wait for its final drain to complete.
     * Ensures no in-flight or pending writes are lost.
     */
    async stopWriteBack() {
        if (!this.running) {
            // Still need to wait if a previous loop is exiting.
            if (this.loopPromise)
                await this.loopPromise;
            return;
        }
        this.running = false;
        this.wakeSleeper?.();
        if (this.loopPromise)
            await this.loopPromise;
        this.loopPromise = null;
    }
    /**
     * Drain all currently-dirty pages to the store immediately. Returns the
     * number of pages written. Safe to call at any time (including while the
     * background loop is running).
     */
    async flushDirty() {
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
            if (!slab)
                continue; // defensive: can't happen in current code
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
    get dirtyCount() { return this.dirty.size; }
    get residentCount() { return this.pages.size; }
    dirtyPages() {
        // Return a copy so callers can't accidentally mutate our state.
        return Array.from(this.dirty);
    }
    residentPages() {
        return Array.from(this.pages.keys());
    }
    /** Test helper: directly materialise a page (skip the read/write path). */
    ensurePage(pageId) {
        if (!this.pages.has(pageId))
            this.#materialisePage(pageId);
    }
    /** Test helper: check whether a page has been materialised (without creating one). */
    hasPage(pageId) {
        return this.pages.has(pageId);
    }
    /** True if the page at `pageId` is marked read-only (ROM). False for RAM
     *  pages or pages that haven't been materialised. */
    isReadOnly(pageId) {
        return this.pages.get(pageId)?.readonly ?? false;
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
    loadROM(linearAddress, bytes) {
        if (linearAddress < 0 || (linearAddress & this.pageMask) !== 0) {
            throw new Error(`loadROM: linearAddress 0x${linearAddress.toString(16)} is not page-aligned (pageSize=${this.pageSize})`);
        }
        if (bytes.length === 0) {
            throw new Error(`loadROM: bytes must be non-empty`);
        }
        if ((bytes.length & this.pageMask) !== 0) {
            throw new Error(`loadROM: bytes.length ${bytes.length} is not a multiple of pageSize ${this.pageSize}`);
        }
        const startPageId = linearAddress >>> this.pageShift;
        const numPages = bytes.length >>> this.pageShift;
        const endPageIdExclusive = startPageId + numPages;
        // Pre-validate every affected page before mutating any.
        for (let pageId = startPageId; pageId < endPageIdExclusive; pageId++) {
            const existing = this.pages.get(pageId);
            if (existing?.readonly) {
                throw new Error(`loadROM: page ${pageId} is already a ROM page (overlap)`);
            }
            if (this.dirty.has(pageId)) {
                throw new Error(`loadROM: page ${pageId} is dirty; reset memory before loading ROM here`);
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
    #materialisePage(pageId) {
        const slab = { data: new Uint8Array(this.pageSize), readonly: false };
        this.pages.set(pageId, slab);
        // Fresh zero-page is clean (matches what the store would give us
        // for an absent page). Don't add to dirty.
        return slab;
    }
    async #writeBackLoop(intervalMs) {
        try {
            while (this.running) {
                await this.flushDirty();
                if (!this.running)
                    break;
                await this.#sleep(intervalMs);
            }
        }
        finally {
            // Always do a final drain on exit so stopWriteBack() is lossless.
            await this.flushDirty();
        }
    }
    #sleep(ms) {
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
