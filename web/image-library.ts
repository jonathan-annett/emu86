/**
 * Browser-side IndexedDB store for user-uploaded floppy images.
 *
 * Distinct from the page store (`emu86-pages`, owned by Phase 6's
 * `IndexedDBPageStore`). Mixing them would couple two unrelated concerns
 * — page-store sectors are an emulator-runtime cache; library entries are
 * user-curated artefacts — and would surprise users when a "wipe library"
 * action accidentally took out their disk-backed RAM.
 *
 * Schema:
 *   db   : 'emu86-images', version 1
 *   store: 'images' — out-of-line keys (entry.id is the key);
 *          values are the full `StoredImage` record, byte-array inline.
 *
 * Why Uint8Array, not Blob:
 *   Phase 9's worker-host already accepts `imageBytes: Uint8Array` in
 *   `BootMessage` (see src/browser/protocol.ts BootConfig). Using Blob in
 *   IDB would mean a Blob→ArrayBuffer→Uint8Array conversion at boot, plus
 *   a structured-clone step from main → worker that defeats the
 *   transferable optimisation. Uint8Array round-trips byte-identically
 *   through structured clone and is what the worker wants. Blob's main
 *   advantage (chunked streaming for very large values) doesn't help here
 *   — a 1.44 MB floppy fits a single allocation comfortably. If 9.3 brings
 *   multi-megabyte hard-disk images, revisit.
 *
 * Forward-compat for Phase 9.3:
 *   `source: 'upload' | 'github'` is a discriminator. Today we only write
 *   'upload'. Reading a 'github' entry written by 9.3 will round-trip
 *   correctly through the same listing/get/remove code. Keeping the union
 *   declared today means 9.3 doesn't need an IDB migration.
 *
 * Upload size cap is enforced at the call site (settings-modal.ts), not
 * here — the library accepts any byte buffer the caller hands it. Keeping
 * the validation policy out of the storage layer makes test setup simpler
 * and avoids encoding "what's a sensible image" in a place that can't
 * actually answer that.
 */

const DATABASE_NAME = 'emu86-images';
const STORE_NAME = 'images';
const SCHEMA_VERSION = 1;

/** Source discriminator. */
export type ImageSourceTag = 'upload' | 'github';

/**
 * Per-asset viability tag, mirrored from web/viability-tagging.ts. Stored
 * inline so the library list can show the tag without re-running the
 * heuristic — useful when an upstream rename would otherwise re-classify
 * an old entry. Optional because `'upload'` entries don't carry one and
 * pre-9.3 stored entries predate the field; readers treat undefined as
 * "unknown" (forward-compat).
 */
export type StoredViabilityTag = 'likely-works' | 'untested' | 'known-incompatible';

export interface StoredImage {
  /** UUID; primary key. */
  id: string;
  /** User-facing label; mutable via renameImage. */
  name: string;
  /** The floppy bytes. */
  bytes: Uint8Array;
  /** Date.now() at upload. */
  uploadedAt: number;
  /** Redundant with bytes.byteLength; kept for cheap listing. */
  sizeBytes: number;
  source: ImageSourceTag;
  /**
   * Viability tag captured at add-time. Only set for `'github'` sources
   * today; `'upload'` entries omit it. Reading code treats `undefined` as
   * "unknown" — that's the forward-compat path for entries written before
   * the field existed.
   */
  viability?: StoredViabilityTag;
}

/** Listing shape — same fields as StoredImage minus the bulk bytes. */
export type StoredImageMeta = Omit<StoredImage, 'bytes'>;

export interface QuotaUsage {
  /** Bytes the origin currently has in persistent storage, summed. */
  usedBytes: number;
  /** Quota cap in bytes, or null if the browser doesn't expose one. */
  quotaBytes: number | null;
}

export class ImageLibrary {
  readonly databaseName: string;
  #db: IDBDatabase | null = null;
  #openPromise: Promise<IDBDatabase> | null = null;

  constructor(databaseName: string = DATABASE_NAME) {
    this.databaseName = databaseName;
  }

  /**
   * Open (lazy) and cache the IDBDatabase. Subsequent calls share the in-flight
   * promise so concurrent first-use callers don't race on `indexedDB.open`.
   * Mirrors the discipline of `IndexedDBPageStore.ready` so tests and
   * developer eyes see the same lifecycle pattern across both DBs.
   */
  ready(): Promise<IDBDatabase> {
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.databaseName, SCHEMA_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
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
        reject(req.error ?? new Error('ImageLibrary: open failed'));
      };
      req.onblocked = () => {
        this.#openPromise = null;
        reject(new Error('ImageLibrary: open blocked by another connection'));
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
   * Add a new image. Returns the freshly-generated id. Bytes are copied to
   * decouple us from caller mutation (matches IndexedDBPageStore.save's
   * defensive copy).
   *
   * `viability` is optional and only meaningful for `'github'` sources —
   * the GitHub browser passes it through so the library row can show the
   * tag without re-running the heuristic. Omitted for `'upload'`.
   */
  async addImage(
    name: string,
    bytes: Uint8Array,
    source: ImageSourceTag = 'upload',
    viability?: StoredViabilityTag,
  ): Promise<string> {
    const id = generateId();
    const entry: StoredImage = {
      id,
      name,
      bytes: new Uint8Array(bytes),
      uploadedAt: Date.now(),
      sizeBytes: bytes.byteLength,
      source,
      ...(viability !== undefined ? { viability } : {}),
    };
    const db = await this.ready();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(entry);
    await awaitTransaction(tx);
    return id;
  }

  /** List metadata sorted by uploadedAt descending. Excludes `bytes`. */
  async listImages(): Promise<StoredImageMeta[]> {
    const db = await this.ready();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    const all = await awaitRequest<StoredImage[]>(request);
    // Strip bytes BEFORE returning so a caller logging the listing doesn't
    // dump a megabyte of bytes into the console. Cheaper than a cursor walk
    // for the small N we expect (tens of images, not thousands).
    const meta: StoredImageMeta[] = all.map((entry) => ({
      id: entry.id,
      name: entry.name,
      uploadedAt: entry.uploadedAt,
      sizeBytes: entry.sizeBytes,
      source: entry.source,
      ...(entry.viability !== undefined ? { viability: entry.viability } : {}),
    }));
    meta.sort((a, b) => b.uploadedAt - a.uploadedAt);
    return meta;
  }

  /** Cheap existence probe used by settings validation. */
  async hasImage(id: string): Promise<boolean> {
    const db = await this.ready();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getKey(id);
    const result = await awaitRequest<IDBValidKey | undefined>(request);
    return result !== undefined;
  }

  /**
   * Pull the bytes for one image. Returns a fresh Uint8Array — caller may
   * mutate without affecting our copy on the next read. Throws if the id
   * doesn't exist; callers can choose to check `hasImage` first.
   */
  async getImageBytes(id: string): Promise<Uint8Array> {
    const db = await this.ready();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    const entry = await awaitRequest<StoredImage | undefined>(request);
    if (!entry) {
      throw new Error(`ImageLibrary: no image with id ${id}`);
    }
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new Error(`ImageLibrary: stored image ${id} has non-Uint8Array bytes`);
    }
    return new Uint8Array(entry.bytes);
  }

  /**
   * Remove by id. No-op if id is absent — IDB's `delete` already has that
   * semantic and we don't want to force callers to pre-check.
   */
  async removeImage(id: string): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    await awaitTransaction(tx);
  }

  /**
   * Rename. Rejects if the id doesn't exist — renaming a vanished entry is
   * almost certainly a UI staleness bug worth surfacing rather than silently
   * succeeding.
   */
  async renameImage(id: string, newName: string): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const existing = await awaitRequest<StoredImage | undefined>(store.get(id));
    if (!existing) {
      // Abort the transaction — no write should land. The thrown error will
      // surface to the caller via the await on awaitTransaction below.
      tx.abort();
      throw new Error(`ImageLibrary: no image with id ${id}`);
    }
    const updated: StoredImage = { ...existing, name: newName };
    store.put(updated);
    await awaitTransaction(tx);
  }

  /**
   * Origin-wide quota probe. Wraps `navigator.storage.estimate()`. The API
   * is missing in older Safari and some private modes; we report
   * `{ usedBytes: 0, quotaBytes: null }` so the UI can show "unknown"
   * without branching.
   */
  async getQuotaUsage(): Promise<QuotaUsage> {
    const nav = (typeof navigator !== 'undefined' ? navigator : undefined);
    const storage = nav?.storage;
    if (!storage || typeof storage.estimate !== 'function') {
      return { usedBytes: 0, quotaBytes: null };
    }
    try {
      const est = await storage.estimate();
      const usedBytes = typeof est.usage === 'number' ? est.usage : 0;
      const quotaBytes = typeof est.quota === 'number' ? est.quota : null;
      return { usedBytes, quotaBytes };
    } catch {
      return { usedBytes: 0, quotaBytes: null };
    }
  }
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('ImageLibrary: transaction error'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('ImageLibrary: transaction aborted'));
  });
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('ImageLibrary: request error'));
  });
}

/**
 * UUID for primary keys. Prefer `crypto.randomUUID()` (well-supported in
 * modern browsers and Node ≥19); fall back to a v4-shaped hex string built
 * from `crypto.getRandomValues` for environments missing the convenience
 * helper. The fallback isn't a security boundary — id collisions across
 * the library are merely confusing, not exploitable — but using getRandomValues
 * still gives 122 bits of entropy and avoids `Math.random`.
 */
function generateId(): string {
  const c = (typeof crypto !== 'undefined' ? crypto : undefined);
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(16);
    c.getRandomValues(buf);
    // RFC 4122 v4 layout: set version (0100) and variant (10) bits.
    buf[6] = ((buf[6] ?? 0) & 0x0f) | 0x40;
    buf[8] = ((buf[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    return (
      hex.slice(0, 8) + '-' +
      hex.slice(8, 12) + '-' +
      hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' +
      hex.slice(20, 32)
    );
  }
  // Last-resort. Should never trigger in browsers; keeps tests under fake
  // environments alive. Time-prefixed so visual debugging is easier.
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(16)}`;
}
