/**
 * Simple in-memory backing store. Used by tests and as a sensible default
 * when no persistence is wanted (hydrate() is a no-op on a fresh instance).
 */
export class InMemoryPageStore {
    readonly = false;
    pages = new Map();
    async *loadAll() {
        for (const [id, data] of this.pages) {
            // Yield copies so callers can't mutate our storage by reference.
            yield [id, new Uint8Array(data)];
        }
    }
    async save(pageId, data) {
        // Copy on save so later mutations by the writer don't mutate our copy.
        this.pages.set(pageId, new Uint8Array(data));
    }
    async clear() {
        this.pages.clear();
    }
    /** Test helper: direct count of persisted pages without awaiting. */
    get persistedCount() {
        return this.pages.size;
    }
    /** Test helper: peek at a persisted page (copy). */
    peek(pageId) {
        const p = this.pages.get(pageId);
        return p ? new Uint8Array(p) : undefined;
    }
}
