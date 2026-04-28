/**
 * IndexedDB-backed PageStore for browser-side persistence.
 *
 * Layout:
 *   - One database per instance (name configurable so multiple emulator
 *     instances on one origin don't collide).
 *   - One object store per database, hardcoded name `pages`, schema version 1.
 *   - Out-of-line keys (page IDs as integers), values are plain Uint8Arrays
 *     (structured-clone safe, round-trips byte-identically).
 *
 * Lifecycle:
 *   - The constructor does no I/O. The DB opens lazily on first use via
 *     `ready()`, which is idempotent (subsequent calls share the same promise).
 *   - One short-lived transaction per save/clear; loadAll() opens a single
 *     read-only cursor traversal. We don't hold long-running transactions
 *     because PagedMemory's write-back loop awaits between saves and IDB
 *     would auto-commit the moment we yielded to a non-IDB await anyway.
 *   - `close()` ends the connection; the next operation re-opens.
 *
 * Concurrency:
 *   - Multiple save()s in flight is fine — IDB orders writes by request time.
 *   - clear() racing with save() resolves by IDB's per-tx ordering; the caller
 *     (PagedMemory does not do this) is responsible for higher-level intent.
 */
const STORE_NAME = 'pages';
const SCHEMA_VERSION = 1;
const DEFAULT_DATABASE_NAME = 'emu86-pages';
export class IndexedDBPageStore {
    readonly = false;
    databaseName;
    db = null;
    openPromise = null;
    constructor(opts = {}) {
        this.databaseName = opts.databaseName ?? DEFAULT_DATABASE_NAME;
    }
    /**
     * Open the database (if not already open) and return the live IDBDatabase.
     * Idempotent: concurrent and subsequent callers share one in-flight promise.
     * If `close()` was called, the next `ready()` re-opens.
     */
    ready() {
        if (this.openPromise)
            return this.openPromise;
        this.openPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(this.databaseName, SCHEMA_VERSION);
            // onupgradeneeded MUST attach before the request runs to its first event,
            // and createObjectStore can ONLY be called inside this callback.
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                this.db = db;
                // If the browser closes the database underneath us (storage eviction,
                // version change from another tab), drop our cache so the next op
                // re-opens fresh rather than using a dead handle.
                db.onclose = () => {
                    if (this.db === db) {
                        this.db = null;
                        this.openPromise = null;
                    }
                };
                resolve(db);
            };
            req.onerror = () => {
                this.openPromise = null;
                reject(req.error ?? new Error('IndexedDBPageStore: open failed'));
            };
            req.onblocked = () => {
                this.openPromise = null;
                reject(new Error('IndexedDBPageStore: open blocked by another connection'));
            };
        });
        return this.openPromise;
    }
    /**
     * Close the underlying connection. Subsequent operations will re-open it.
     * Useful in tests for verifying clean teardown.
     */
    close() {
        this.db?.close();
        this.db = null;
        this.openPromise = null;
    }
    /**
     * Stream every persisted page via a cursor.
     *
     * NOTE on transaction lifetime: IDB transactions auto-commit when control
     * returns to the event loop with no pending requests. We call
     * `cursor.continue()` *before* yielding, so a request is always pending
     * across the yield. Consumers that interleave non-IDB awaits between
     * iterations may cause the transaction to commit early; the only in-tree
     * consumer (`PagedMemory.hydrate`) does pure-sync work per item, so this
     * is safe in practice.
     */
    async *loadAll() {
        const db = await this.ready();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).openCursor();
        // Promise-per-step adapter: each cursor.onsuccess fires once and we hand
        // its result to the awaiter, then immediately stage a fresh promise so
        // the *next* onsuccess (triggered by cursor.continue()) has somewhere to
        // land. resolveStep/rejectStep always point at the most recently-staged
        // promise, never at one that's already been resolved.
        let resolveStep;
        let rejectStep;
        let pending = new Promise((res, rej) => {
            resolveStep = res;
            rejectStep = rej;
        });
        request.onsuccess = () => {
            const deliver = resolveStep;
            pending = new Promise((res, rej) => {
                resolveStep = res;
                rejectStep = rej;
            });
            deliver(request.result);
        };
        request.onerror = () => {
            rejectStep(request.error ?? new Error('IndexedDBPageStore: cursor failed'));
        };
        while (true) {
            const cursor = await pending;
            if (!cursor)
                return;
            // Validate shape rather than trust IDBValidKey / `any` value blindly.
            // A non-number key or non-Uint8Array value would mean the schema was
            // tampered with out-of-band; surface that loudly.
            const key = cursor.key;
            if (typeof key !== 'number') {
                throw new Error(`IndexedDBPageStore: expected number key, got ${typeof key}`);
            }
            const value = cursor.value;
            if (!(value instanceof Uint8Array)) {
                throw new Error(`IndexedDBPageStore: expected Uint8Array value at key ${key}`);
            }
            // Copy so callers mutating the yielded buffer can't reach back into the
            // cursor's internal copy. Matches InMemoryPageStore.loadAll.
            const out = new Uint8Array(value);
            // Queue the next request BEFORE yielding so the transaction stays alive
            // (a pending request blocks auto-commit). Done in this order so the
            // consumer's iteration gets the synchronous handoff it needs.
            cursor.continue();
            yield [key, out];
        }
    }
    async save(pageId, data) {
        const db = await this.ready();
        // Copy BEFORE the transaction so PagedMemory's writer can mutate `data`
        // immediately after this call returns without affecting what we persist.
        // Mirrors InMemoryPageStore.save.
        const copy = new Uint8Array(data);
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(copy, pageId);
        await this.#awaitTransaction(tx);
    }
    async clear() {
        const db = await this.ready();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        await this.#awaitTransaction(tx);
    }
    /**
     * Resolve when the transaction commits successfully; reject on error/abort.
     * For single-request transactions this is the cleanest pattern: oncomplete
     * fires AFTER the request's onsuccess and only when every queued op landed.
     */
    #awaitTransaction(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDBPageStore: transaction error'));
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDBPageStore: transaction aborted'));
        });
    }
}
