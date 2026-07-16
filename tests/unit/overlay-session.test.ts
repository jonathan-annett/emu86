/**
 * overlay-session — the Phase 17 M2 lifecycle state machine.
 *
 * All fakes in-memory (the drive-session.test.ts precedent — its
 * header records why fake-indexeddb is banned from state-machine
 * suites). The store fake keeps the real store's copy/throw
 * semantics where they matter (copyOverlay throws on a missing
 * source; rows are independent after copy).
 */

import { describe, it, expect } from 'vitest';
import {
  OVERLAY_GC_MAX_AGE_MS,
  gcOrphanOverlays,
  mintOverlayId,
  overlayLockName,
  resolveOverlaySession,
  type OverlayStoreLike,
} from '../../web/overlay-session.js';
import type { ForkLocks } from '../../web/drive-session.js';
import type { SessionState } from '../../web/session-store.js';
import type { OverlayChunkRow, OverlayMeta } from '../../web/overlay-store.js';

class MemOverlayStore implements OverlayStoreLike {
  readonly metas = new Map<string, OverlayMeta>();
  readonly chunks = new Map<string, Map<number, Uint8Array>>();

  seed(overlayId: string, fingerprint: string | null, rows: Array<[number, number]>): void {
    this.metas.set(overlayId, {
      overlayId,
      baseFingerprint: fingerprint,
      chunkSizeBytes: 1024,
      lastTouched: 1_000,
    });
    const m = new Map<number, Uint8Array>();
    for (const [index, fill] of rows) m.set(index, new Uint8Array(8).fill(fill));
    this.chunks.set(overlayId, m);
  }

  getMeta(id: string): Promise<OverlayMeta | null> {
    return Promise.resolve(this.metas.get(id) ?? null);
  }

  getChunks(id: string): Promise<OverlayChunkRow[]> {
    const m = this.chunks.get(id) ?? new Map<number, Uint8Array>();
    return Promise.resolve(
      [...m.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([chunkIndex, bytes]) => ({
          overlayId: id,
          chunkIndex,
          bytes: new Uint8Array(bytes),
        })),
    );
  }

  deleteOverlay(id: string): Promise<void> {
    this.metas.delete(id);
    this.chunks.delete(id);
    return Promise.resolve();
  }

  copyOverlay(fromId: string, toId: string): Promise<void> {
    const meta = this.metas.get(fromId);
    if (meta === undefined) return Promise.reject(new Error(`no overlay with id ${fromId}`));
    this.metas.set(toId, { ...meta, overlayId: toId, lastTouched: 2_000 });
    const src = this.chunks.get(fromId) ?? new Map<number, Uint8Array>();
    const dst = new Map<number, Uint8Array>();
    for (const [k, v] of src) dst.set(k, new Uint8Array(v));
    this.chunks.set(toId, dst);
    return Promise.resolve();
  }

  listMeta(): Promise<OverlayMeta[]> {
    return Promise.resolve([...this.metas.values()]);
  }
}

/** In-memory locks: `foreign` names read as held by another tab. */
function makeLocks(foreign: string[] = []): ForkLocks & { mine: Set<string> } {
  const mine = new Set<string>();
  const other = new Set(foreign);
  return {
    supported: true,
    mine,
    acquireForever(name: string): Promise<boolean> {
      if (other.has(name)) return Promise.resolve(false);
      mine.add(name);
      return Promise.resolve(true);
    },
    probeFree(name: string): Promise<boolean> {
      return Promise.resolve(!other.has(name) && !mine.has(name));
    },
    heldNames(): Promise<Set<string>> {
      return Promise.resolve(new Set([...mine, ...other]));
    },
  };
}

function makeSession(initial?: Partial<SessionState>): {
  state: () => SessionState;
  loadSession: () => SessionState;
  saveSession: (patch: Partial<SessionState>) => SessionState;
} {
  let state: SessionState = {
    sessionId: 'tab-under-test',
    tanHostOctet: null,
    driveForkId: null,
    pendingBlankKb: null,
    overlayId: null,
    overlayResetPending: false,
    pendingRestoreStateId: null,
    pendingColdBoot: false,
    ...initial,
  };
  return {
    state: () => state,
    loadSession: () => ({ ...state }),
    saveSession: (patch) => {
      state = { ...state, ...patch };
      return { ...state };
    },
  };
}

describe('resolveOverlaySession', () => {
  it('fresh tab: mints an id, locks it, nothing to fold', async () => {
    const store = new MemOverlayStore();
    const locks = makeLocks();
    const session = makeSession();
    const r = await resolveOverlaySession({ store, locks, ...session });
    expect(r.origin).toBe('fresh');
    expect(r.boot).toBeNull();
    expect(session.state().overlayId).toBe(r.overlayId);
    expect(locks.mine.has(overlayLockName(r.overlayId))).toBe(true);
  });

  it('reload: same id, folds its stored chunks', async () => {
    const store = new MemOverlayStore();
    store.seed('ov-1', 'fp-abc', [[3, 0x33], [1, 0x11]]);
    const session = makeSession({ overlayId: 'ov-1' });
    const r = await resolveOverlaySession({ store, locks: makeLocks(), ...session });
    expect(r.origin).toBe('reload');
    expect(r.overlayId).toBe('ov-1');
    expect(r.boot?.fingerprint).toBe('fp-abc');
    expect(r.boot?.chunkSizeBytes).toBe(1024);
    expect(r.boot?.chunks.map((c) => c.chunkIndex)).toEqual([1, 3]);
  });

  it('reload with no stored rows: same id, pristine boot', async () => {
    const session = makeSession({ overlayId: 'ov-empty' });
    const r = await resolveOverlaySession({
      store: new MemOverlayStore(),
      locks: makeLocks(),
      ...session,
    });
    expect(r.origin).toBe('reload');
    expect(r.boot).toBeNull();
  });

  it('duplicate: copies chunks under a fresh id and boots the copy', async () => {
    const store = new MemOverlayStore();
    store.seed('ov-parent', 'fp-abc', [[0, 0xaa]]);
    const locks = makeLocks([overlayLockName('ov-parent')]); // parent alive
    const session = makeSession({ overlayId: 'ov-parent' });
    const r = await resolveOverlaySession({ store, locks, ...session });

    expect(r.origin).toBe('duplicate');
    expect(r.overlayId).not.toBe('ov-parent');
    expect(session.state().overlayId).toBe(r.overlayId);
    expect(r.boot?.chunks[0]?.bytes[0]).toBe(0xaa);
    // The parent's rows are untouched and independent.
    expect(store.metas.has('ov-parent')).toBe(true);
    store.chunks.get(r.overlayId)?.get(0)?.fill(0);
    expect(store.chunks.get('ov-parent')?.get(0)?.[0]).toBe(0xaa);
  });

  it('duplicate of a tab that never swept: fresh id, nothing copied', async () => {
    const locks = makeLocks([overlayLockName('ov-parent')]);
    const session = makeSession({ overlayId: 'ov-parent' });
    const store = new MemOverlayStore();
    const r = await resolveOverlaySession({ store, locks, ...session });
    expect(r.origin).toBe('duplicate');
    expect(r.boot).toBeNull();
    expect(store.metas.size).toBe(0);
  });

  it('M1-era rows (null fingerprint) are deleted, never folded', async () => {
    const store = new MemOverlayStore();
    store.seed('ov-m1', null, [[0, 0x01]]);
    const session = makeSession({ overlayId: 'ov-m1' });
    const r = await resolveOverlaySession({ store, locks: makeLocks(), ...session });
    expect(r.boot).toBeNull();
    expect(r.notes.join(' ')).toContain('M1-era');
    expect(store.metas.has('ov-m1')).toBe(false);
  });

  it('queued factory reset: drops the overlay, pristine boot, flag cleared', async () => {
    const store = new MemOverlayStore();
    store.seed('ov-1', 'fp-abc', [[0, 0x01]]);
    const session = makeSession({ overlayId: 'ov-1', overlayResetPending: true });
    const r = await resolveOverlaySession({ store, locks: makeLocks(), ...session });
    expect(r.origin).toBe('fresh');
    expect(r.boot).toBeNull();
    expect(store.metas.has('ov-1')).toBe(false);
    expect(session.state().overlayResetPending).toBe(false);
    expect(session.state().overlayId).toBe(r.overlayId);
    expect(r.overlayId).not.toBe('ov-1');
  });

  it('a duplicated tab inheriting a pending reset must not delete the parent rows', async () => {
    const store = new MemOverlayStore();
    store.seed('ov-parent', 'fp-abc', [[0, 0x01]]);
    const locks = makeLocks([overlayLockName('ov-parent')]); // parent alive
    const session = makeSession({ overlayId: 'ov-parent', overlayResetPending: true });
    const r = await resolveOverlaySession({ store, locks, ...session });
    expect(r.origin).toBe('fresh'); // reset honored for THIS tab...
    expect(store.metas.has('ov-parent')).toBe(true); // ...parent untouched
  });
});

describe('gcOrphanOverlays', () => {
  const now = OVERLAY_GC_MAX_AGE_MS + 10_000;

  it('sweeps unheld + stale; spares held or fresh', async () => {
    const store = new MemOverlayStore();
    store.seed('stale-orphan', 'fp', [[0, 1]]); // lastTouched 1000 — stale
    store.seed('held', 'fp', [[0, 2]]);
    store.seed('fresh-orphan', 'fp', [[0, 3]]);
    const freshMeta = store.metas.get('fresh-orphan');
    if (freshMeta) freshMeta.lastTouched = now - 1_000; // recent

    const locks = makeLocks([overlayLockName('held')]);
    const removed = await gcOrphanOverlays(store, locks, { now });
    expect(removed).toBe(1);
    expect(store.metas.has('stale-orphan')).toBe(false);
    expect(store.metas.has('held')).toBe(true);
    expect(store.metas.has('fresh-orphan')).toBe(true);
  });

  it('never guesses: unsupported locks or unknowable holders → 0', async () => {
    const store = new MemOverlayStore();
    store.seed('stale', 'fp', [[0, 1]]);
    const unsupported: ForkLocks = {
      supported: false,
      acquireForever: () => Promise.resolve(true),
      probeFree: () => Promise.resolve(true),
      heldNames: () => Promise.reject(new Error('unknowable')),
    };
    expect(await gcOrphanOverlays(store, unsupported, { now })).toBe(0);
    const unknowable: ForkLocks = {
      supported: true,
      acquireForever: () => Promise.resolve(true),
      probeFree: () => Promise.resolve(true),
      heldNames: () => Promise.reject(new Error('unknowable')),
    };
    expect(await gcOrphanOverlays(store, unknowable, { now })).toBe(0);
    expect(store.metas.has('stale')).toBe(true);
  });
});

describe('mintOverlayId', () => {
  it('mints unique non-empty ids', () => {
    const a = mintOverlayId();
    const b = mintOverlayId();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
