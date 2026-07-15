/**
 * Boot-disk overlay chunk store (Phase 17 M1) — the `emu86-overlays`
 * IndexedDB database, the origin's third IDB tenant.
 *
 * Deliberately its OWN database, not a store inside `emu86-images`
 * or `emu86-pages` (brief §1.3): the library is user-curated
 * artifacts, pages are disk-backed RAM cache, overlays are per-tab
 * machine state — wiping one must never surprise the others.
 *
 * Two object stores, created together:
 *   - `chunks`: keyPath `[overlayId, chunkIndex]` — one row per
 *     aligned chunk, IDEMPOTENT (a sweep's put overwrites the chunk's
 *     prior version). Compound keys make per-overlay enumeration,
 *     copy, and deletion key-range operations, which is exactly what
 *     M2's duplication/GC lifecycle needs.
 *   - `meta`: keyPath `overlayId` — { baseFingerprint, chunkSizeBytes,
 *     lastTouched }. `lastTouched` is stamped on every sweep (the
 *     `modifiedAt` discipline from the fork rows); M2's GC reads it
 *     with the same unheld-lock + 7-days-stale conjunction as
 *     `gcOrphanForks`.
 *
 * `baseFingerprint` is the SHA-256 of the base image the overlay was
 * written against. In M1 nobody computes it yet, so rows carry null —
 * "pre-identity era". M2's boot fold treats null as a mismatch (the
 * overlay is NOT applied silently); the field exists now so the row
 * shape doesn't churn. `putChunks` never downgrades a real
 * fingerprint back to null.
 *
 * Every sweep persists in ONE readwrite transaction over both stores —
 * an epoch is atomic: all chunks + the meta touch land together or
 * not at all (nack → the worker folds the epoch back and retries).
 * First multi-store / multi-put transaction in the tree; the one IDB
 * rule that matters is queue-everything-before-awaiting, because a
 * transaction auto-commits the moment control yields with no pending
 * request (idb-page-store.ts records the same caution for cursors).
 *
 * Class shape mirrors `ImageLibrary` (lazy memoized ready(), onclose
 * self-heal, awaitTransaction/awaitRequest helpers) so tests and
 * developer eyes see one lifecycle pattern across all three DBs.
 */

const DATABASE_NAME = 'emu86-overlays';
const SCHEMA_VERSION = 1;
const CHUNKS_STORE = 'chunks';
const META_STORE = 'meta';

export interface OverlayMeta {
  overlayId: string;
  /** SHA-256 hex of the base image, or null before M2 stamps identity. */
  baseFingerprint: string | null;
  /** The engine's aligned chunk span when these rows were written. */
  chunkSizeBytes: number;
  /** Date.now() of the last sweep — M2 GC staleness input. */
  lastTouched: number;
}

export interface OverlayChunkRow {
  overlayId: string;
  chunkIndex: number;
  bytes: Uint8Array;
}

/** A sweep's incoming chunk — matches the protocol's OverlayChunk. */
export interface OverlayChunkInput {
  chunkIndex: number;
  bytes: Uint8Array;
}

/** Every chunk row of one overlay, as a key range on the compound key. */
function overlayKeyRange(overlayId: string): IDBKeyRange {
  return IDBKeyRange.bound([overlayId, 0], [overlayId, Number.MAX_SAFE_INTEGER]);
}

export class OverlayStore {
  readonly databaseName: string;
  #db: IDBDatabase | null = null;
  #openPromise: Promise<IDBDatabase> | null = null;

  constructor(databaseName: string = DATABASE_NAME) {
    this.databaseName = databaseName;
  }

  /** Lazy open, shared in-flight promise, onclose self-heal (ImageLibrary pattern). */
  ready(): Promise<IDBDatabase> {
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.databaseName, SCHEMA_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.createObjectStore(CHUNKS_STORE, { keyPath: ['overlayId', 'chunkIndex'] });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'overlayId' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        this.#db = db;
        db.onclose = () => {
          if (this.#db === db) {
            this.#db = null;
            this.#openPromise = null;
          }
        };
        resolve(db);
      };
      req.onerror = () => {
        this.#openPromise = null;
        reject(req.error ?? new Error('OverlayStore: open failed'));
      };
      req.onblocked = () => {
        this.#openPromise = null;
        reject(new Error('OverlayStore: open blocked by another connection'));
      };
    });
    return this.#openPromise;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#openPromise = null;
  }

  /**
   * Persist one sweep epoch: every chunk row plus the meta touch, ONE
   * transaction. Chunk bytes are copied defensively (the caller may
   * have received them over postMessage, but nothing here should
   * depend on that). `baseFingerprint: null` keeps an existing
   * fingerprint — only a real value overwrites.
   */
  async putChunks(
    overlayId: string,
    chunks: readonly OverlayChunkInput[],
    meta: { chunkSizeBytes: number; baseFingerprint: string | null },
  ): Promise<void> {
    // Copy BEFORE the first await — the caller may reuse its buffers
    // the moment this returns (addImage's copy-at-call contract).
    const rows: OverlayChunkRow[] = chunks.map((chunk) => ({
      overlayId,
      chunkIndex: chunk.chunkIndex,
      bytes: new Uint8Array(chunk.bytes),
    }));
    const db = await this.ready();
    const tx = db.transaction([CHUNKS_STORE, META_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const existing = await awaitRequest<OverlayMeta | undefined>(metaStore.get(overlayId));
    // From here: queue ALL puts synchronously, then await the tx once —
    // yielding with no pending request would auto-commit early.
    const chunkStore = tx.objectStore(CHUNKS_STORE);
    for (const row of rows) {
      chunkStore.put(row);
    }
    metaStore.put({
      overlayId,
      baseFingerprint: meta.baseFingerprint ?? existing?.baseFingerprint ?? null,
      chunkSizeBytes: meta.chunkSizeBytes,
      lastTouched: Date.now(),
    } satisfies OverlayMeta);
    await awaitTransaction(tx);
  }

  /**
   * All chunk rows of one overlay, ascending chunkIndex (IDB getAll on
   * a key range returns key order). The boot fold's read path.
   */
  async getChunks(overlayId: string): Promise<OverlayChunkRow[]> {
    const db = await this.ready();
    const tx = db.transaction(CHUNKS_STORE, 'readonly');
    const rows = await awaitRequest<OverlayChunkRow[]>(
      tx.objectStore(CHUNKS_STORE).getAll(overlayKeyRange(overlayId)),
    );
    for (const row of rows) {
      if (!(row.bytes instanceof Uint8Array)) {
        throw new Error(`OverlayStore: chunk ${overlayId}/${row.chunkIndex} bytes corrupted`);
      }
    }
    return rows;
  }

  /** The overlay's meta row, or null when it has never swept. */
  async getMeta(overlayId: string): Promise<OverlayMeta | null> {
    const db = await this.ready();
    const tx = db.transaction(META_STORE, 'readonly');
    const row = await awaitRequest<OverlayMeta | undefined>(
      tx.objectStore(META_STORE).get(overlayId),
    );
    return row ?? null;
  }

  /** All meta rows — M2 GC's worklist and the settings modal's detail. */
  async listMeta(): Promise<OverlayMeta[]> {
    const db = await this.ready();
    const tx = db.transaction(META_STORE, 'readonly');
    return awaitRequest<OverlayMeta[]>(tx.objectStore(META_STORE).getAll());
  }

  /**
   * Drop one overlay wholesale — chunks and meta, one transaction.
   * The factory-reset action (M2 settings) and GC both land here.
   * No-op on an unknown id (IDB delete semantics, kept).
   */
  async deleteOverlay(overlayId: string): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction([CHUNKS_STORE, META_STORE], 'readwrite');
    tx.objectStore(CHUNKS_STORE).delete(overlayKeyRange(overlayId));
    tx.objectStore(META_STORE).delete(overlayId);
    await awaitTransaction(tx);
  }

  /**
   * Duplicate an overlay under a fresh id — M2's tab-duplication path
   * (the fork-copy precedent: the duplicate must never share rows with
   * the original). One transaction; fresh `lastTouched`. Throws if the
   * source has no meta row — copying chunk rows without their meta
   * would strand them for GC.
   */
  async copyOverlay(fromId: string, toId: string): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction([CHUNKS_STORE, META_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const chunkStore = tx.objectStore(CHUNKS_STORE);
    const meta = await awaitRequest<OverlayMeta | undefined>(metaStore.get(fromId));
    if (meta === undefined) {
      tx.abort();
      throw new Error(`OverlayStore: no overlay with id ${fromId}`);
    }
    const rows = await awaitRequest<OverlayChunkRow[]>(
      chunkStore.getAll(overlayKeyRange(fromId)),
    );
    for (const row of rows) {
      chunkStore.put({ overlayId: toId, chunkIndex: row.chunkIndex, bytes: row.bytes });
    }
    metaStore.put({ ...meta, overlayId: toId, lastTouched: Date.now() } satisfies OverlayMeta);
    await awaitTransaction(tx);
  }
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('OverlayStore: transaction error'));
    tx.onabort = () => reject(tx.error ?? new Error('OverlayStore: transaction aborted'));
  });
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('OverlayStore: request error'));
  });
}
