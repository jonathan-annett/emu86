import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryPageStore, PagedMemory } from '../../src/memory/index.js';

describe('PagedMemory', () => {
  describe('construction', () => {
    it('defaults to 4 KiB pages and 1 MiB address space', () => {
      const mem = new PagedMemory();
      expect(mem.pageSize).toBe(4096);
      expect(mem.addressSpaceSize).toBe(0x100000);
    });

    it('accepts custom power-of-two sizes', () => {
      const mem = new PagedMemory({ pageSize: 256, addressSpaceSize: 0x10000 });
      expect(mem.pageSize).toBe(256);
      expect(mem.addressSpaceSize).toBe(0x10000);
    });

    it('rejects non-power-of-two page size', () => {
      expect(() => new PagedMemory({ pageSize: 1000 })).toThrow(/power of two/);
      expect(() => new PagedMemory({ pageSize: 0 })).toThrow(/power of two/);
    });

    it('rejects address space smaller than page size', () => {
      expect(() => new PagedMemory({ pageSize: 4096, addressSpaceSize: 256 })).toThrow();
    });
  });

  describe('sync read/write', () => {
    it('reads zero from un-touched memory', () => {
      const mem = new PagedMemory();
      expect(mem.readByte(0)).toBe(0);
      expect(mem.readByte(0xFFFFF)).toBe(0);
      expect(mem.readWord(0x1000)).toBe(0);
    });

    it('reading does not mark a page dirty', () => {
      const mem = new PagedMemory();
      mem.readByte(0x100);
      mem.readByte(0x5000);
      expect(mem.dirtyCount).toBe(0);
      // But it does materialise (zero-fill on demand)
      expect(mem.residentCount).toBe(2);
    });

    it('writing a byte is visible on read', () => {
      const mem = new PagedMemory();
      mem.writeByte(0x1234, 0xAB);
      expect(mem.readByte(0x1234)).toBe(0xAB);
    });

    it('writing a word is little-endian in the backing bytes', () => {
      const mem = new PagedMemory();
      mem.writeWord(0x1000, 0x1234);
      expect(mem.readByte(0x1000)).toBe(0x34);
      expect(mem.readByte(0x1001)).toBe(0x12);
      expect(mem.readWord(0x1000)).toBe(0x1234);
    });

    it('handles word access straddling a page boundary', () => {
      const mem = new PagedMemory({ pageSize: 256, addressSpaceSize: 0x10000 });
      // Write a word at offset 255 — straddles page 0 and page 1
      mem.writeWord(255, 0xABCD);
      expect(mem.readByte(255)).toBe(0xCD);   // page 0, last byte
      expect(mem.readByte(256)).toBe(0xAB);   // page 1, first byte
      expect(mem.readWord(255)).toBe(0xABCD); // combined read works
      expect(mem.residentCount).toBe(2);
    });

    it('masks input addresses to the address space', () => {
      const mem = new PagedMemory();   // 1 MiB
      // Address 0x100000 should wrap to 0
      mem.writeByte(0, 0xAA);
      expect(mem.readByte(0x100000)).toBe(0xAA);
    });

    it('masks written byte values to 8 bits', () => {
      const mem = new PagedMemory();
      mem.writeByte(0x10, 0x1FF);
      expect(mem.readByte(0x10)).toBe(0xFF);
    });
  });

  describe('dirty tracking', () => {
    it('adds page id to dirty set on write', () => {
      const mem = new PagedMemory();
      mem.writeByte(0x10, 0xFF);       // page 0
      mem.writeByte(0x5000, 0xFF);     // page 5
      const dirty = [...mem.dirtyPages()].sort((a, b) => a - b);
      expect(dirty).toEqual([0, 5]);
    });

    it('multiple writes to same page don\'t duplicate', () => {
      const mem = new PagedMemory();
      for (let i = 0; i < 100; i++) {
        mem.writeByte(i, i & 0xFF);   // all page 0
      }
      expect(mem.dirtyCount).toBe(1);
    });

    it('word writes straddling pages dirty both pages', () => {
      const mem = new PagedMemory({ pageSize: 256, addressSpaceSize: 0x10000 });
      mem.writeWord(255, 0x1234);
      expect([...mem.dirtyPages()].sort((a, b) => a - b)).toEqual([0, 1]);
    });
  });

  describe('flushDirty()', () => {
    it('writes dirty pages to the store and clears dirty set', async () => {
      const store = new InMemoryPageStore();
      const mem = new PagedMemory({ store });
      mem.writeByte(0x100, 0xAB);
      mem.writeByte(0x5000, 0xCD);
      expect(mem.dirtyCount).toBe(2);

      const n = await mem.flushDirty();
      expect(n).toBe(2);
      expect(mem.dirtyCount).toBe(0);
      expect(store.persistedCount).toBe(2);
    });

    it('no-op when nothing dirty', async () => {
      const store = new InMemoryPageStore();
      const mem = new PagedMemory({ store });
      mem.readByte(0x100);  // materialise but don't dirty
      const n = await mem.flushDirty();
      expect(n).toBe(0);
      expect(store.persistedCount).toBe(0);
    });

    it('persisted page content matches live memory', async () => {
      const store = new InMemoryPageStore();
      const mem = new PagedMemory({ pageSize: 256, store });
      mem.writeByte(0, 0x11);
      mem.writeByte(1, 0x22);
      mem.writeByte(255, 0xFF);
      await mem.flushDirty();

      const saved = store.peek(0)!;
      expect(saved[0]).toBe(0x11);
      expect(saved[1]).toBe(0x22);
      expect(saved[255]).toBe(0xFF);
    });

    it('with no store, clears dirty set without persisting', async () => {
      const mem = new PagedMemory();   // no store
      mem.writeByte(0x100, 0xAB);
      expect(mem.dirtyCount).toBe(1);
      await mem.flushDirty();
      expect(mem.dirtyCount).toBe(0);
    });
  });

  describe('hydrate()', () => {
    it('pre-populates cache from store', async () => {
      const store = new InMemoryPageStore();
      // Pre-seed the store with a page
      const data = new Uint8Array(4096);
      data[10] = 0xDE;
      data[11] = 0xAD;
      await store.save(42, data);

      const mem = new PagedMemory({ store });
      await mem.hydrate();

      // Page 42 base address = 42 * 4096 = 0x2A000
      expect(mem.readByte(0x2A000 + 10)).toBe(0xDE);
      expect(mem.readByte(0x2A000 + 11)).toBe(0xAD);
      // Hydrated pages are clean — not in dirty set
      expect(mem.dirtyCount).toBe(0);
    });

    it('no-op without store', async () => {
      const mem = new PagedMemory();
      await expect(mem.hydrate()).resolves.toBeUndefined();
    });

    it('rejects pages with wrong size', async () => {
      const store = new InMemoryPageStore();
      // Hack: directly save a wrong-sized page
      await store.save(0, new Uint8Array(100));   // wrong size
      const mem = new PagedMemory({ pageSize: 4096, store });
      await expect(mem.hydrate()).rejects.toThrow(/size/);
    });
  });

  describe('race safety: writes concurrent with flush', () => {
    // JS is single-threaded, so "concurrent" means "interleaved at an await
    // point." We simulate by using a PageStore.save that awaits a promise we
    // control, letting us inject a CPU write at that exact interleave point.

    class ControllablePageStore extends InMemoryPageStore {
      savesBegan = 0;
      private gate: Promise<void> = Promise.resolve();
      private release: (() => void) | null = null;

      /** Pause save() until releaseNext() is called. */
      pauseNextSave(): void {
        this.gate = new Promise((resolve) => {
          this.release = resolve;
        });
      }
      releasePending(): void {
        this.release?.();
        this.release = null;
      }

      override async save(pageId: number, data: Uint8Array): Promise<void> {
        this.savesBegan++;
        await this.gate;
        this.gate = Promise.resolve();
        await super.save(pageId, data);
      }
    }

    it('write during a paused flush re-dirties the page', async () => {
      const store = new ControllablePageStore();
      const mem = new PagedMemory({ store });
      mem.writeByte(0x10, 0x11);       // page 0 dirty

      store.pauseNextSave();
      const flushPromise = mem.flushDirty();

      // Let the async save start so it's waiting at the gate
      await Promise.resolve();
      await Promise.resolve();
      expect(store.savesBegan).toBe(1);

      // Write during the in-flight flush — should re-dirty page 0
      expect(mem.dirtyCount).toBe(0);  // briefly empty (cleared at batch grab)
      mem.writeByte(0x20, 0x22);
      expect(mem.dirtyCount).toBe(1);

      // Complete the flush
      store.releasePending();
      await flushPromise;

      // The re-dirty persists — a follow-up flush will save the new write
      expect(mem.dirtyCount).toBe(1);
      await mem.flushDirty();
      expect(mem.dirtyCount).toBe(0);

      // Final persisted page has BOTH writes
      const saved = store.peek(0)!;
      expect(saved[0x10]).toBe(0x11);
      expect(saved[0x20]).toBe(0x22);
    });
  });

  describe('write-back loop', () => {
    it('start + stop drains dirty state', async () => {
      const store = new InMemoryPageStore();
      const mem = new PagedMemory({ store });
      mem.writeByte(0x100, 0xAB);

      mem.startWriteBack({ intervalMs: 10_000 });  // long interval; we stop early
      await mem.stopWriteBack();                    // triggers final drain

      expect(mem.dirtyCount).toBe(0);
      expect(store.persistedCount).toBe(1);
    });

    it('captures writes that arrive between flush cycles', async () => {
      const store = new InMemoryPageStore();
      const mem = new PagedMemory({ store });

      // Very short interval so multiple cycles happen
      mem.startWriteBack({ intervalMs: 5 });
      await new Promise((r) => setTimeout(r, 15));

      mem.writeByte(0x100, 0xAA);
      mem.writeByte(0x5000, 0xBB);

      await mem.stopWriteBack();

      expect(mem.dirtyCount).toBe(0);
      expect(store.persistedCount).toBe(2);
    });

    it('start is idempotent; second call is a no-op', async () => {
      const store = new InMemoryPageStore();
      const mem = new PagedMemory({ store });
      mem.startWriteBack({ intervalMs: 10_000 });
      mem.startWriteBack({ intervalMs: 10_000 });   // must not start a second loop
      await mem.stopWriteBack();
      // No assertion beyond "didn't hang or throw"
    });

    it('readonly store skips the loop entirely', () => {
      class ROStore extends InMemoryPageStore {
        override readonly = true;
      }
      const store = new ROStore();
      const mem = new PagedMemory({ store });
      mem.startWriteBack();            // should silently no-op
      // No loop running = stopWriteBack resolves immediately
      return mem.stopWriteBack();
    });
  });
});
