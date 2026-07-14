/**
 * Per-tab drive fork state machine (Phase 16 M0 — brief Addendum A).
 *
 * The library here is an IN-MEMORY fake of the `ForkLibrary` subset,
 * not fake-indexeddb: the state machine allocates real drive-sized
 * images (8–16 MB), and fake-indexeddb's structured-clone polyfill
 * takes SECONDS per megabyte-scale put/get — a first cut of this file
 * on the real-library-on-fake-IDB pattern cost 177 s and a timeout.
 * The real ImageLibrary's byte round-trip (including the M0 additions:
 * 'fork' tag + explicit geometry) is covered with small payloads in
 * image-library.test.ts, where that pattern belongs.
 *
 * Locks and the session store are in-memory fakes so tests can express
 * the tab-lifecycle events only a browser produces: reload (locks
 * released, session kept), duplication (locks HELD by the original,
 * session copied), and a vanished row (GC or a wiped library).
 */

import { describe, expect, it } from 'vitest';
import type {
  ImageSourceTag,
  StoredDiskGeometry,
  StoredImage,
  StoredImageMeta,
  StoredViabilityTag,
} from '../../web/image-library.js';
import type { SessionState } from '../../web/session-store.js';
import {
  FORK_GC_MAX_AGE_MS,
  forkLockName,
  gcOrphanForks,
  resolveDriveSession,
  type DriveSessionDeps,
  type ForkLocks,
} from '../../web/drive-session.js';

const KB8086_BYTES = 311 * 4 * 13 * 512; // the default preset, CHS-exact

/**
 * Byte-equality for drive-sized arrays. NOT `toEqual`: structural
 * deep-equal walks typed arrays element-by-element with enough
 * per-element overhead that one 8 MB comparison costs ~90 s — this
 * file's first cut spent 200 s in exactly two such assertions.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** In-memory ForkLibrary with the real library's copy/throw semantics. */
class MemLibrary {
  readonly rows = new Map<string, StoredImage>();
  #n = 0;

  listImages(): Promise<StoredImageMeta[]> {
    const metas = [...this.rows.values()].map((entry) => {
      const { bytes: _bytes, ...meta } = entry;
      return { ...meta };
    });
    return Promise.resolve(metas);
  }

  getImageEntry(id: string): Promise<StoredImage> {
    const entry = this.rows.get(id);
    if (entry === undefined) {
      return Promise.reject(new Error(`MemLibrary: no image with id ${id}`));
    }
    return Promise.resolve({ ...entry, bytes: new Uint8Array(entry.bytes) });
  }

  addImage(
    name: string,
    bytes: Uint8Array,
    source: ImageSourceTag = 'upload',
    viability?: StoredViabilityTag,
    geometry?: StoredDiskGeometry,
  ): Promise<string> {
    this.#n += 1;
    const id = `img-${this.#n}`;
    this.rows.set(id, {
      id,
      name,
      bytes: new Uint8Array(bytes),
      uploadedAt: Date.now(),
      sizeBytes: bytes.byteLength,
      source,
      ...(viability !== undefined ? { viability } : {}),
      ...(geometry !== undefined ? { geometry } : {}),
    });
    return Promise.resolve(id);
  }

  removeImage(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }

  /* Assertion helpers (not part of ForkLibrary). */
  async getImageBytes(id: string): Promise<Uint8Array> {
    return (await this.getImageEntry(id)).bytes;
  }

  async updateImageBytes(id: string, bytes: Uint8Array): Promise<void> {
    const entry = await this.getImageEntry(id);
    if (bytes.byteLength !== entry.sizeBytes) {
      throw new Error('MemLibrary: size mismatch');
    }
    this.rows.set(id, { ...entry, bytes: new Uint8Array(bytes), modifiedAt: Date.now() });
  }

  hasImage(id: string): Promise<boolean> {
    return Promise.resolve(this.rows.has(id));
  }
}

/** In-memory ForkLocks. `foreign` = locks some OTHER tab holds. */
function makeLocks(foreign: string[] = []): ForkLocks & {
  mine: Set<string>;
  foreign: Set<string>;
} {
  const mine = new Set<string>();
  const foreignSet = new Set<string>(foreign);
  return {
    supported: true,
    mine,
    foreign: foreignSet,
    acquireForever(name: string): Promise<boolean> {
      if (foreignSet.has(name)) return Promise.resolve(false);
      mine.add(name);
      return Promise.resolve(true);
    },
    probeFree(name: string): Promise<boolean> {
      return Promise.resolve(!foreignSet.has(name) && !mine.has(name));
    },
    heldNames(): Promise<Set<string>> {
      return Promise.resolve(new Set<string>([...mine, ...foreignSet]));
    },
  };
}

function makeSession(initial?: Partial<SessionState>): {
  state: SessionState;
  loadSession: () => SessionState;
  saveSession: (patch: Partial<SessionState>) => SessionState;
} {
  let state: SessionState = {
    sessionId: 'tab-under-test',
    tanHostOctet: null,
    driveForkId: null,
    pendingBlankKb: null,
    ...initial,
  };
  return {
    get state() { return state; },
    loadSession: () => ({ ...state }),
    saveSession: (patch) => {
      state = { ...state, ...patch };
      return { ...state };
    },
  };
}

function deps(
  library: MemLibrary,
  session: ReturnType<typeof makeSession>,
  locks: ForkLocks,
  base: { kind: 'library'; id: string } | null = null,
): DriveSessionDeps {
  return {
    library,
    locks,
    loadSession: session.loadSession,
    saveSession: session.saveSession,
    base,
  };
}

describe('resolveDriveSession', () => {
  it('fresh tab, no base → blank 8086 KB fork, session pointed, lock held', async () => {
    const lib = new MemLibrary();
    const session = makeSession();
    const locks = makeLocks();

    const drive = await resolveDriveSession(deps(lib, session, locks));

    expect(drive.origin).toBe('fresh-blank');
    expect(drive.sizeBytes).toBe(KB8086_BYTES);
    expect(drive.geometry).toEqual({ cylinders: 311, heads: 4, sectorsPerTrack: 13 });
    expect(session.state.driveForkId).toBe(drive.imageId);
    expect(locks.mine.has(forkLockName(drive.imageId))).toBe(true);

    const rows = await lib.listImages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: drive.imageId, source: 'fork', sizeBytes: KB8086_BYTES });
  });

  it('fresh tab with a base → fork copies bytes + geometry; base row untouched', async () => {
    const lib = new MemLibrary();
    const baseBytes = new Uint8Array(2048).fill(0xC7);
    const baseId = await lib.addImage('workshop.img', baseBytes, 'blank', undefined, {
      cylinders: 1, heads: 2, sectorsPerTrack: 2,
    });
    const session = makeSession();
    const locks = makeLocks();

    const drive = await resolveDriveSession(
      deps(lib, session, locks, { kind: 'library', id: baseId }),
    );

    expect(drive.origin).toBe('fork-of-base');
    expect(drive.name).toBe('fork of workshop.img');
    expect(drive.imageId).not.toBe(baseId);
    expect(await lib.getImageBytes(drive.imageId)).toEqual(baseBytes);
    expect(drive.geometry).toEqual({ cylinders: 1, heads: 2, sectorsPerTrack: 2 });

    // Mutating the fork must not reach the base (fork = copy, not alias).
    const mutated = new Uint8Array(2048).fill(0x11);
    await lib.updateImageBytes(drive.imageId, mutated);
    expect(await lib.getImageBytes(baseId)).toEqual(baseBytes);
  });

  it('reload: existing fork + free lock → same row, no new rows', async () => {
    const lib = new MemLibrary();
    const session = makeSession();
    const first = await resolveDriveSession(deps(lib, session, makeLocks()));

    // "Reload": session survives, the old page's lock is gone.
    const drive = await resolveDriveSession(deps(lib, session, makeLocks()));

    expect(drive.origin).toBe('reload');
    expect(drive.imageId).toBe(first.imageId);
    expect(await lib.listImages()).toHaveLength(1);
  });

  it('duplicate: lock held elsewhere → bytes copied under a fresh id', async () => {
    const lib = new MemLibrary();
    const original = makeSession();
    const originalDrive = await resolveDriveSession(deps(lib, original, makeLocks()));
    const guestWrites = new Uint8Array(KB8086_BYTES).fill(0x5A);
    await lib.updateImageBytes(originalDrive.imageId, guestWrites);

    // "Duplicate": copied sessionStorage, but the original tab still
    // holds its fork lock.
    const dup = makeSession({ driveForkId: originalDrive.imageId });
    const locks = makeLocks([forkLockName(originalDrive.imageId)]);
    const drive = await resolveDriveSession(deps(lib, dup, locks));

    expect(drive.origin).toBe('duplicate');
    expect(drive.imageId).not.toBe(originalDrive.imageId);
    expect(dup.state.driveForkId).toBe(drive.imageId);
    expect(sameBytes(await lib.getImageBytes(drive.imageId), guestWrites)).toBe(true);
    expect(locks.mine.has(forkLockName(drive.imageId))).toBe(true);
    // The original row is untouched and still there.
    expect(sameBytes(await lib.getImageBytes(originalDrive.imageId), guestWrites)).toBe(true);
    expect(await lib.listImages()).toHaveLength(2);
  });

  it('vanished fork row degrades to a fresh fork instead of throwing', async () => {
    const lib = new MemLibrary();
    const session = makeSession({ driveForkId: 'row-that-was-gcd' });

    const drive = await resolveDriveSession(deps(lib, session, makeLocks()));

    expect(drive.origin).toBe('fresh-blank');
    expect(session.state.driveForkId).toBe(drive.imageId);
    expect(await lib.listImages()).toHaveLength(1);
  });

  it('vanished base degrades to a fresh blank, not a throw', async () => {
    const lib = new MemLibrary();
    const session = makeSession();
    const drive = await resolveDriveSession(
      deps(lib, session, makeLocks(), { kind: 'library', id: 'deleted-base' }),
    );
    expect(drive.origin).toBe('fresh-blank');
  });

  it('pending ?mkdrive swap: old row retired, fresh blank of asked size, pending cleared', async () => {
    const lib = new MemLibrary();
    const session = makeSession();
    const old = await resolveDriveSession(deps(lib, session, makeLocks()));
    // 16128 KB = the 16 MB preset's real presetKb (32×16×63 CHS). NB:
    // NOT 32256 — writing this test with the usage text's advertised
    // sizes exposed that its 32 MB figure had been wrong since
    // Phase 15 (63×16×63 is 31752 KB); control.ts is now corrected.
    session.saveSession({ pendingBlankKb: 16128 });

    // Reboot: the old page's lock is released, so the old row retires.
    const drive = await resolveDriveSession(deps(lib, session, makeLocks()));

    expect(drive.origin).toBe('swap');
    expect(drive.sizeBytes).toBe(16128 * 1024);
    expect(session.state.pendingBlankKb).toBeNull();
    expect(session.state.driveForkId).toBe(drive.imageId);
    const rows = await lib.listImages();
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.id === old.imageId)).toBe(false);
  });

  it('pending swap in a DUPLICATED tab leaves the original tab\'s row alone', async () => {
    const lib = new MemLibrary();
    const original = makeSession();
    const originalDrive = await resolveDriveSession(deps(lib, original, makeLocks()));

    // Duplicate inherits both the fork pointer AND the queued swap; the
    // original tab is still running (its lock is held).
    const dup = makeSession({
      driveForkId: originalDrive.imageId,
      pendingBlankKb: 8086,
    });
    const locks = makeLocks([forkLockName(originalDrive.imageId)]);
    const drive = await resolveDriveSession(deps(lib, dup, locks));

    expect(drive.origin).toBe('swap');
    expect(drive.imageId).not.toBe(originalDrive.imageId);
    // The original's row survives — it was locked.
    expect(await lib.hasImage(originalDrive.imageId)).toBe(true);
    expect(await lib.listImages()).toHaveLength(2);
  });

  it('an unrecognized pending size is dropped and normal resolution proceeds', async () => {
    const lib = new MemLibrary();
    const session = makeSession({ pendingBlankKb: 12345 });
    const drive = await resolveDriveSession(deps(lib, session, makeLocks()));
    expect(drive.origin).toBe('fresh-blank');
    expect(session.state.pendingBlankKb).toBeNull();
  });
});

describe('gcOrphanForks', () => {
  const WEEK_PLUS = FORK_GC_MAX_AGE_MS + 60_000;

  it('sweeps old unheld forks; keeps held forks and non-fork rows', async () => {
    const lib = new MemLibrary();
    const bytes = new Uint8Array(64);
    const oldOrphan = await lib.addImage('dead tab', bytes, 'fork');
    const heldFork = await lib.addImage('live tab', bytes, 'fork');
    const userImage = await lib.addImage('precious.img', bytes, 'upload');

    // Rows are stamped with the real Date.now(); age them by running GC
    // with a `now` a week in the future instead of faking the clock.
    const locks = makeLocks([forkLockName(heldFork)]);
    const removed = await gcOrphanForks(lib, locks, {
      now: Date.now() + WEEK_PLUS,
      maxAgeMs: FORK_GC_MAX_AGE_MS,
    });

    const left = new Set((await lib.listImages()).map((m) => m.id));
    expect(left.has(oldOrphan)).toBe(false); // unheld + old → swept
    expect(left.has(heldFork)).toBe(true); // held → kept, however old
    expect(left.has(userImage)).toBe(true); // not a fork → never touched
    expect(removed).toBe(1);
  });

  it('a young unheld fork survives (reopen-closed-tab grace)', async () => {
    const lib = new MemLibrary();
    const id = await lib.addImage('closed a minute ago', new Uint8Array(8), 'fork');
    const removed = await gcOrphanForks(lib, makeLocks(), {
      now: Date.now() + 60_000,
      maxAgeMs: FORK_GC_MAX_AGE_MS,
    });
    expect(removed).toBe(0);
    expect(await lib.hasImage(id)).toBe(true);
  });

  it('no-ops when the locks API is unsupported or unreadable', async () => {
    const lib = new MemLibrary();
    await lib.addImage('ancient', new Uint8Array(8), 'fork');

    const unsupported: ForkLocks = {
      supported: false,
      acquireForever: () => Promise.resolve(true),
      probeFree: () => Promise.resolve(true),
      heldNames: () => Promise.reject(new Error('unavailable')),
    };
    expect(await gcOrphanForks(lib, unsupported, { now: Date.now() + WEEK_PLUS })).toBe(0);

    const unreadable: ForkLocks = {
      ...unsupported,
      supported: true,
    };
    expect(await gcOrphanForks(lib, unreadable, { now: Date.now() + WEEK_PLUS })).toBe(0);
    expect(await lib.listImages()).toHaveLength(1);
  });
});
