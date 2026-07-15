/**
 * OverlayStore — the emu86-overlays IDB tenant (Phase 17 M1).
 *
 * Real-IDB round-trips via fake-indexeddb, SMALL payloads only (the
 * Phase 16 lesson: the polyfill's structured clone costs seconds per
 * MB — engine-scale byte handling is disk-overlay.test.ts's job, on
 * in-memory fakes). Fresh IDBFactory per test is the polyfill-blessed
 * reset path; unique database names keep tests independent of it.
 *
 * What matters here and nowhere else: the one-transaction epoch write
 * (all chunks + meta land atomically), chunk-key idempotence, key-range
 * isolation between overlayIds, the fingerprint never-downgrade rule,
 * and the copy/delete primitives M2's duplication/GC will call.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { OverlayStore } from '../../web/overlay-store.js';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

let dbSeq = 0;
function freshStore(): OverlayStore {
  return new OverlayStore(`test-overlays-${dbSeq++}`);
}

describe('OverlayStore — epoch writes', () => {
  it('round-trips chunks and stamps meta in one sweep', async () => {
    const store = freshStore();
    await store.putChunks(
      'tab-a',
      [
        { chunkIndex: 3, bytes: bytes(1, 2, 3) },
        { chunkIndex: 0, bytes: bytes(9) },
      ],
      { chunkSizeBytes: 32 * 1024, baseFingerprint: null },
    );

    const rows = await store.getChunks('tab-a');
    expect(rows.map((r) => r.chunkIndex)).toEqual([0, 3]); // key order
    expect(Array.from(rows[1]?.bytes ?? [])).toEqual([1, 2, 3]);

    const meta = await store.getMeta('tab-a');
    expect(meta?.chunkSizeBytes).toBe(32 * 1024);
    expect(meta?.baseFingerprint).toBeNull();
    expect(meta?.lastTouched).toBeGreaterThan(0);
    store.close();
  });

  it('chunk records are idempotent — a later epoch overwrites, count stays', async () => {
    const store = freshStore();
    await store.putChunks('t', [{ chunkIndex: 5, bytes: bytes(1) }], {
      chunkSizeBytes: 1024,
      baseFingerprint: null,
    });
    await store.putChunks('t', [{ chunkIndex: 5, bytes: bytes(2) }], {
      chunkSizeBytes: 1024,
      baseFingerprint: null,
    });
    const rows = await store.getChunks('t');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bytes[0]).toBe(2);
    store.close();
  });

  it('a real fingerprint sticks; null never downgrades it', async () => {
    const store = freshStore();
    await store.putChunks('t', [{ chunkIndex: 0, bytes: bytes(1) }], {
      chunkSizeBytes: 1024,
      baseFingerprint: 'abc123',
    });
    await store.putChunks('t', [{ chunkIndex: 1, bytes: bytes(2) }], {
      chunkSizeBytes: 1024,
      baseFingerprint: null, // M1-era sweep — must not erase identity
    });
    expect((await store.getMeta('t'))?.baseFingerprint).toBe('abc123');
    store.close();
  });

  it('bytes are copied defensively on put', async () => {
    const store = freshStore();
    const buffer = bytes(7, 7, 7);
    const put = store.putChunks('t', [{ chunkIndex: 0, bytes: buffer }], {
      chunkSizeBytes: 1024,
      baseFingerprint: null,
    });
    buffer.fill(0); // caller reuses its buffer immediately
    await put;
    const rows = await store.getChunks('t');
    expect(Array.from(rows[0]?.bytes ?? [])).toEqual([7, 7, 7]);
    store.close();
  });
});

describe('OverlayStore — isolation and lifecycle primitives', () => {
  it('key ranges keep overlays apart', async () => {
    const store = freshStore();
    await store.putChunks('a', [{ chunkIndex: 0, bytes: bytes(1) }], {
      chunkSizeBytes: 1024,
      baseFingerprint: null,
    });
    await store.putChunks('b', [{ chunkIndex: 0, bytes: bytes(2) }], {
      chunkSizeBytes: 1024,
      baseFingerprint: null,
    });
    expect((await store.getChunks('a'))[0]?.bytes[0]).toBe(1);
    expect((await store.getChunks('b'))[0]?.bytes[0]).toBe(2);
    expect(await store.getChunks('c')).toEqual([]);
    expect(await store.getMeta('c')).toBeNull();
    expect((await store.listMeta()).map((m) => m.overlayId).sort()).toEqual(['a', 'b']);
    store.close();
  });

  it('deleteOverlay removes chunks and meta, leaves neighbours', async () => {
    const store = freshStore();
    await store.putChunks('gone', [{ chunkIndex: 0, bytes: bytes(1) }, { chunkIndex: 9, bytes: bytes(2) }], {
      chunkSizeBytes: 1024,
      baseFingerprint: null,
    });
    await store.putChunks('stays', [{ chunkIndex: 0, bytes: bytes(3) }], {
      chunkSizeBytes: 1024,
      baseFingerprint: null,
    });
    await store.deleteOverlay('gone');
    expect(await store.getChunks('gone')).toEqual([]);
    expect(await store.getMeta('gone')).toBeNull();
    expect((await store.getChunks('stays'))[0]?.bytes[0]).toBe(3);
    await store.deleteOverlay('never-existed'); // no-op, no throw
    store.close();
  });

  it('copyOverlay duplicates rows under the new id (M2 tab duplication)', async () => {
    const store = freshStore();
    await store.putChunks('parent', [{ chunkIndex: 2, bytes: bytes(4, 5) }], {
      chunkSizeBytes: 2048,
      baseFingerprint: 'fp',
    });
    await store.copyOverlay('parent', 'child');

    const child = await store.getChunks('child');
    expect(child.map((r) => r.chunkIndex)).toEqual([2]);
    expect(Array.from(child[0]?.bytes ?? [])).toEqual([4, 5]);
    const meta = await store.getMeta('child');
    expect(meta?.baseFingerprint).toBe('fp');
    expect(meta?.chunkSizeBytes).toBe(2048);

    // Rows are independent: deleting the parent leaves the child.
    await store.deleteOverlay('parent');
    expect((await store.getChunks('child'))).toHaveLength(1);
    store.close();
  });

  it('copyOverlay refuses an unknown source', async () => {
    const store = freshStore();
    await expect(store.copyOverlay('ghost', 'child')).rejects.toThrow(/no overlay/);
    store.close();
  });
});
