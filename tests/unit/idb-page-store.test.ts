import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDBPageStore, PagedMemory } from '../../src/memory/index.js';

// fake-indexeddb keeps all DB state on the global IDBFactory. Replacing it
// with a fresh instance per test is the polyfill-blessed way to get clean
// state between cases (see fakeIndexedDB README); cheaper than tracking and
// deleting databases individually.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

async function collect(
  store: IndexedDBPageStore,
): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  for await (const [id, data] of store.loadAll()) {
    out.set(id, data);
  }
  return out;
}

describe('IndexedDBPageStore', () => {
  describe('lifecycle', () => {
    it('ready() is idempotent: concurrent calls share one promise', async () => {
      const s = new IndexedDBPageStore();
      const p1 = s.ready();
      const p2 = s.ready();
      expect(p1).toBe(p2);
      const db1 = await p1;
      const db2 = await p2;
      expect(db1).toBe(db2);
      s.close();
    });

    it('ready() after close() re-opens a fresh connection', async () => {
      const s = new IndexedDBPageStore();
      const db1 = await s.ready();
      s.close();
      const db2 = await s.ready();
      // Each open() returns a new IDBDatabase instance.
      expect(db2).not.toBe(db1);
      s.close();
    });

    it('readonly flag is false', () => {
      const s = new IndexedDBPageStore();
      expect(s.readonly).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('save then loadAll returns the same data byte-for-byte', async () => {
      const s = new IndexedDBPageStore();
      const data = new Uint8Array([1, 2, 3, 4, 5, 0, 0xFF, 0x80]);
      await s.save(7, data);

      const loaded = await collect(s);
      expect(loaded.size).toBe(1);
      expect(Array.from(loaded.get(7)!)).toEqual(Array.from(data));
      s.close();
    });

    it('saves and loads multiple pages with all keys present', async () => {
      const s = new IndexedDBPageStore();
      await s.save(0, new Uint8Array([10, 20]));
      await s.save(2, new Uint8Array([30, 40]));
      await s.save(5, new Uint8Array([50, 60]));

      const loaded = await collect(s);
      expect(loaded.size).toBe(3);
      expect(Array.from(loaded.get(0)!)).toEqual([10, 20]);
      expect(Array.from(loaded.get(2)!)).toEqual([30, 40]);
      expect(Array.from(loaded.get(5)!)).toEqual([50, 60]);
      s.close();
    });

    it('overwrite: a second save at the same key replaces the first', async () => {
      const s = new IndexedDBPageStore();
      await s.save(1, new Uint8Array([1, 1, 1]));
      await s.save(1, new Uint8Array([2, 2, 2]));

      const loaded = await collect(s);
      expect(loaded.size).toBe(1);
      expect(Array.from(loaded.get(1)!)).toEqual([2, 2, 2]);
      s.close();
    });
  });

  describe('mutation independence', () => {
    it('mutating the input buffer after save() does not affect persisted data', async () => {
      const s = new IndexedDBPageStore();
      const data = new Uint8Array([1, 2, 3]);
      await s.save(0, data);
      // Caller mutates the original buffer — store must hold its own copy.
      data[0] = 0x99;
      data[1] = 0x99;

      const loaded = await collect(s);
      expect(Array.from(loaded.get(0)!)).toEqual([1, 2, 3]);
      s.close();
    });

    it('mutating a loaded buffer does not bleed into a later loadAll', async () => {
      const s = new IndexedDBPageStore();
      await s.save(0, new Uint8Array([7, 8, 9]));

      const first = await collect(s);
      first.get(0)![0] = 0xAA;

      const second = await collect(s);
      expect(Array.from(second.get(0)!)).toEqual([7, 8, 9]);
      s.close();
    });
  });

  describe('clear', () => {
    it('removes all persisted pages', async () => {
      const s = new IndexedDBPageStore();
      await s.save(0, new Uint8Array([1]));
      await s.save(1, new Uint8Array([2]));
      await s.save(2, new Uint8Array([3]));

      await s.clear();

      const loaded = await collect(s);
      expect(loaded.size).toBe(0);
      s.close();
    });
  });

  describe('edge cases', () => {
    it('loadAll on a brand-new store yields nothing without throwing', async () => {
      const s = new IndexedDBPageStore();
      const loaded = await collect(s);
      expect(loaded.size).toBe(0);
      s.close();
    });

    it('round-trips a 4096-byte page filled with non-zero data', async () => {
      const s = new IndexedDBPageStore();
      const big = new Uint8Array(4096);
      for (let i = 0; i < big.length; i++) big[i] = (i * 17 + 3) & 0xFF;
      await s.save(42, big);

      const loaded = await collect(s);
      const got = loaded.get(42)!;
      expect(got.length).toBe(4096);
      expect(Array.from(got)).toEqual(Array.from(big));
      s.close();
    });

    it('handles 100+ pages and yields each exactly once', async () => {
      const s = new IndexedDBPageStore();
      const N = 150;
      for (let i = 0; i < N; i++) {
        const page = new Uint8Array(8);
        page[0] = i & 0xFF;
        page[1] = (i >>> 8) & 0xFF;
        await s.save(i, page);
      }

      const loaded = await collect(s);
      expect(loaded.size).toBe(N);
      for (let i = 0; i < N; i++) {
        const data = loaded.get(i)!;
        expect(data[0]).toBe(i & 0xFF);
        expect(data[1]).toBe((i >>> 8) & 0xFF);
      }
      s.close();
    });

    it('two stores with different database names are isolated', async () => {
      const a = new IndexedDBPageStore({ databaseName: 'emu86-test-a' });
      const b = new IndexedDBPageStore({ databaseName: 'emu86-test-b' });
      await a.save(0, new Uint8Array([1, 2, 3]));
      await b.save(0, new Uint8Array([9, 9, 9]));

      const aLoaded = await collect(a);
      const bLoaded = await collect(b);

      expect(Array.from(aLoaded.get(0)!)).toEqual([1, 2, 3]);
      expect(Array.from(bLoaded.get(0)!)).toEqual([9, 9, 9]);
      a.close();
      b.close();
    });
  });

  describe('integration with PagedMemory', () => {
    it('hydrate() pulls pre-populated pages from IDB into live memory', async () => {
      const store = new IndexedDBPageStore({
        databaseName: 'emu86-paged-hydrate',
      });
      const pageData = new Uint8Array(4096);
      pageData[10] = 0xDE;
      pageData[11] = 0xAD;
      await store.save(42, pageData);

      const mem = new PagedMemory({ store });
      await mem.hydrate();

      // Page 42 base address = 42 * 4096 = 0x2A000
      expect(mem.readByte(0x2A000 + 10)).toBe(0xDE);
      expect(mem.readByte(0x2A000 + 11)).toBe(0xAD);
      expect(mem.dirtyCount).toBe(0);
      store.close();
    });

    it('writes flushed through PagedMemory survive a fresh PagedMemory', async () => {
      // The end-to-end claim: PagedMemory write → flushDirty → close →
      // re-open → hydrate → read returns the original write.
      const dbName = 'emu86-paged-roundtrip';

      // Round 1: write through PagedMemory and flush to IDB.
      const storeA = new IndexedDBPageStore({ databaseName: dbName });
      const memA = new PagedMemory({ store: storeA });
      memA.writeByte(0x100, 0xAB);
      memA.writeByte(0x5000, 0xCD);
      const flushed = await memA.flushDirty();
      expect(flushed).toBe(2);
      storeA.close();

      // Round 2: brand-new PagedMemory, same backing DB, hydrate, verify.
      const storeB = new IndexedDBPageStore({ databaseName: dbName });
      const memB = new PagedMemory({ store: storeB });
      await memB.hydrate();
      expect(memB.readByte(0x100)).toBe(0xAB);
      expect(memB.readByte(0x5000)).toBe(0xCD);
      expect(memB.dirtyCount).toBe(0);
      storeB.close();
    });
  });
});
