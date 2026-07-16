/**
 * Whole-machine save-state store (Phase 18 M2) — the `emu86-machines`
 * IndexedDB database, the origin's FOURTH IDB tenant (brief §1.5).
 *
 * Deliberately its own database, same reasoning as the other three
 * (`emu86-images` = user-curated artifacts, `emu86-pages` = disk-backed
 * RAM cache, `emu86-overlays` = per-tab boot-disk state): wiping one
 * must never surprise the others.
 *
 * Two object stores, created together:
 *   - `meta`: keyPath `stateId` — the listing row (label, kind,
 *     createdAt/lastTouched, baseFingerprint, schemaVersion, sizeBytes).
 *     Everything the settings modal needs WITHOUT touching payloads.
 *   - `payload`: keyPath `stateId` — the captured machine state
 *     (M1's structured form, stored via structured clone) plus the
 *     disk carriage: gzipped embedded images for `kind: 'named'`
 *     (D2(a)), SHA-256 references for `kind: 'resume'` (D2(b)).
 *
 * D4 ownership semantics live in `kind`:
 *   - `'named'` — user-curated library artifacts. NEVER aged out;
 *     user-deletable only.
 *   - `'resume'` — the tab-owned reload-resume slot, keyed
 *     `resume-<sessionId>`. Rewritten on every capture; GC'd by the
 *     unheld-lock + staleness conjunction (gcOrphanForks pattern).
 *
 * Meta rows carry `schemaVersion` from day one — device formats WILL
 * churn (the settings key-per-era lesson); a future era refuses old
 * payloads loudly instead of restoring garbage.
 *
 * Class shape mirrors OverlayStore/ImageLibrary: lazy memoized
 * ready(), onclose self-heal, queue-everything-before-awaiting,
 * one-transaction writes over both stores.
 */

import type { MachineState } from '../src/browser/protocol.js';
import type { DiskClass, DiskGeometry } from '../src/browser/protocol.js';

const DATABASE_NAME = 'emu86-machines';
const SCHEMA_VERSION = 1;
const META_STORE = 'meta';
const PAYLOAD_STORE = 'payload';

/** The payload schema this build writes and accepts. */
export const MACHINE_STATE_SCHEMA_VERSION = 1;

export type MachineStateKind = 'named' | 'resume';

export interface MachineStateMeta {
  stateId: string;
  /** User label for named saves; null for the resume slot. */
  label: string | null;
  kind: MachineStateKind;
  createdAt: number;
  lastTouched: number;
  /** SHA-256 of the pristine base image at capture, or null (degraded boot). */
  baseFingerprint: string | null;
  /** Payload schema era — restore refuses mismatches loudly. */
  schemaVersion: number;
  /** Rough stored size (machine state + gzipped disks), for the UI. */
  sizeBytes: number;
}

/** One stored disk image (named saves): gzipped bytes + slot identity. */
export interface StoredDisk {
  gz: Uint8Array;
  geometry: DiskGeometry;
  diskClass: DiskClass;
}

export interface MachineStatePayload {
  stateId: string;
  /** M1's structured MachineState — structured-clone-stored as-is. */
  state: MachineState;
  capturedAt: number;
  /** Embedded primary (named saves); null for the resume slot. */
  primary: StoredDisk | null;
  /** Embedded secondary; null when none was attached or kind is resume. */
  secondary: StoredDisk | null;
  /** Reference hashes (resume slot; also stored for named saves as integrity). */
  primarySha: string | null;
  secondarySha: string | null;
  /**
   * Main-side terminal snapshot (Phase 18 field-loop UI): the last
   * ~48 KB of raw serial TX bytes plus the scroll position. Replayed
   * into xterm before the machine resumes, so the restored screen
   * looks like the one that was left — deliberately OUTSIDE the
   * machine state (it's xterm's history, not guest memory). Absent on
   * rows from before this field; restore just skips the replay.
   */
  terminal?: { tail: Uint8Array; viewportY: number } | null;
}

export interface MachineStateRecord {
  meta: MachineStateMeta;
  payload: MachineStatePayload;
}

export class MachineStore {
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
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'stateId' });
        }
        if (!db.objectStoreNames.contains(PAYLOAD_STORE)) {
          db.createObjectStore(PAYLOAD_STORE, { keyPath: 'stateId' });
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
        reject(req.error ?? new Error('MachineStore: open failed'));
      };
      req.onblocked = () => {
        this.#openPromise = null;
        reject(new Error('MachineStore: open blocked by another connection'));
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
   * Persist one save-state: meta + payload, ONE transaction. A put on
   * an existing stateId overwrites both rows — the resume slot's
   * every-capture rewrite and a named save's "save again under the
   * same name" both ride this. `createdAt` survives an overwrite
   * (the row's identity is when the SLOT was made; `lastTouched` and
   * `capturedAt` say when the state is from).
   */
  async putState(record: MachineStateRecord): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction([META_STORE, PAYLOAD_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const existing = await awaitRequest<MachineStateMeta | undefined>(
      metaStore.get(record.meta.stateId),
    );
    metaStore.put({
      ...record.meta,
      createdAt: existing?.createdAt ?? record.meta.createdAt,
    } satisfies MachineStateMeta);
    tx.objectStore(PAYLOAD_STORE).put(record.payload);
    await awaitTransaction(tx);
  }

  /** Meta + payload for one state, or null when absent (either row). */
  async getState(stateId: string): Promise<MachineStateRecord | null> {
    const db = await this.ready();
    const tx = db.transaction([META_STORE, PAYLOAD_STORE], 'readonly');
    const [meta, payload] = await Promise.all([
      awaitRequest<MachineStateMeta | undefined>(tx.objectStore(META_STORE).get(stateId)),
      awaitRequest<MachineStatePayload | undefined>(
        tx.objectStore(PAYLOAD_STORE).get(stateId),
      ),
    ]);
    if (meta === undefined || payload === undefined) return null;
    return { meta, payload };
  }

  /** The meta row alone (listing / staleness checks — no payload I/O). */
  async getMeta(stateId: string): Promise<MachineStateMeta | null> {
    const db = await this.ready();
    const tx = db.transaction(META_STORE, 'readonly');
    const row = await awaitRequest<MachineStateMeta | undefined>(
      tx.objectStore(META_STORE).get(stateId),
    );
    return row ?? null;
  }

  /** All meta rows — the settings modal's list and the GC worklist. */
  async listMeta(): Promise<MachineStateMeta[]> {
    const db = await this.ready();
    const tx = db.transaction(META_STORE, 'readonly');
    return awaitRequest<MachineStateMeta[]>(tx.objectStore(META_STORE).getAll());
  }

  /** Stamp lastTouched (a successful restore keeps its slot warm for GC). */
  async touch(stateId: string): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const row = await awaitRequest<MachineStateMeta | undefined>(store.get(stateId));
    if (row !== undefined) {
      store.put({ ...row, lastTouched: Date.now() } satisfies MachineStateMeta);
    }
    await awaitTransaction(tx);
  }

  /** Drop one state wholesale — meta and payload, one transaction. */
  async deleteState(stateId: string): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction([META_STORE, PAYLOAD_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(stateId);
    tx.objectStore(PAYLOAD_STORE).delete(stateId);
    await awaitTransaction(tx);
  }
}

/** The tab-owned resume slot's id — one per sessionId (D4). */
export function resumeSlotId(sessionId: string): string {
  return `resume-${sessionId}`;
}

/** Web Lock name guarding a resume slot (the overlayLockName pattern). */
export function resumeSlotLockName(stateId: string): string {
  return `emu86-machine-slot-${stateId}`;
}

/** Resume slots older than this are GC candidates (named saves never age). */
export const RESUME_SLOT_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sweep abandoned resume slots: kind 'resume', lock free, AND stale —
 * the same unheld-lock + staleness conjunction as gcOrphanForks /
 * gcOrphanOverlays. Named saves are user-curated (D4) and never
 * touched. Returns the number deleted.
 */
export async function gcOrphanResumeSlots(
  store: MachineStore,
  locks: {
    supported: boolean;
    probeFree: (name: string) => Promise<boolean>;
  },
  now: number = Date.now(),
): Promise<number> {
  if (!locks.supported) return 0;
  let deleted = 0;
  for (const meta of await store.listMeta()) {
    if (meta.kind !== 'resume') continue;
    if (now - meta.lastTouched < RESUME_SLOT_GC_MAX_AGE_MS) continue;
    if (!(await locks.probeFree(resumeSlotLockName(meta.stateId)))) continue;
    await store.deleteState(meta.stateId);
    deleted++;
  }
  return deleted;
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('MachineStore: transaction error'));
    tx.onabort = () => reject(tx.error ?? new Error('MachineStore: transaction aborted'));
  });
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('MachineStore: request error'));
  });
}
