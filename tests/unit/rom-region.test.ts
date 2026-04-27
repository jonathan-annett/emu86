import { describe, expect, it } from 'vitest';
import { InMemoryPageStore, PagedMemory } from '../../src/memory/index.js';

describe('PagedMemory ROM regions', () => {
  // Use small pages so ROM-load tests stay legible. 256 bytes × 4 pages = 1 KiB
  // ROM; address space 64 KiB is plenty for the cases we want to exercise.
  const PAGE = 256;
  const ADDR_SPACE = 0x10000;

  function makeRomBytes(numPages: number, seed = 0x10): Uint8Array {
    const out = new Uint8Array(numPages * PAGE);
    for (let i = 0; i < out.length; i++) out[i] = (seed + i) & 0xFF;
    return out;
  }

  it('loadROM populates pages and reads back the bytes', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    const rom = makeRomBytes(2);
    mem.loadROM(0x1000, rom);
    for (let i = 0; i < rom.length; i++) {
      expect(mem.readByte(0x1000 + i)).toBe(rom[i]);
    }
  });

  it('writes to a ROM page are silently dropped', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    const rom = makeRomBytes(1);
    mem.loadROM(0x2000, rom);
    expect(mem.readByte(0x2000)).toBe(rom[0]);

    // Attempt several writes — none of them takes effect, none throws.
    mem.writeByte(0x2000, 0xFF);
    mem.writeByte(0x2010, 0xAA);
    mem.writeWord(0x20A0, 0xBEEF);
    expect(mem.readByte(0x2000)).toBe(rom[0]);
    expect(mem.readByte(0x2010)).toBe(rom[0x10]);
    expect(mem.readByte(0x20A0)).toBe(rom[0xA0]);
    expect(mem.readByte(0x20A1)).toBe(rom[0xA1]);
  });

  it('loadROM does not add ROM pages to the dirty set', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    mem.loadROM(0x0000, makeRomBytes(3));
    expect(mem.dirtyCount).toBe(0);
  });

  it('writes to a ROM page do not add the page to the dirty set', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    mem.loadROM(0x0400, makeRomBytes(1));
    expect(mem.dirtyCount).toBe(0);
    mem.writeByte(0x0400, 0xFF);
    mem.writeByte(0x04FF, 0xAA);
    expect(mem.dirtyCount).toBe(0);
  });

  it('loadROM at a non-page-aligned address throws', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    expect(() => mem.loadROM(0x1001, makeRomBytes(1))).toThrow(/page-aligned/);
    expect(() => mem.loadROM(0x10F0, makeRomBytes(1))).toThrow(/page-aligned/);
  });

  it('loadROM with non-page-multiple length throws', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    expect(() => mem.loadROM(0x1000, new Uint8Array(PAGE - 1))).toThrow(/multiple of pageSize/);
    expect(() => mem.loadROM(0x1000, new Uint8Array(PAGE + 1))).toThrow(/multiple of pageSize/);
  });

  it('loadROM with zero-length input throws', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    expect(() => mem.loadROM(0x1000, new Uint8Array(0))).toThrow(/non-empty/);
  });

  it('loadROM that overlaps existing ROM throws', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    mem.loadROM(0x1000, makeRomBytes(2));   // pages 16, 17
    // Try to load over page 17:
    expect(() => mem.loadROM(0x1100, makeRomBytes(1))).toThrow(/already a ROM page/);
    // Try to load fully over both:
    expect(() => mem.loadROM(0x1000, makeRomBytes(2))).toThrow(/already a ROM page/);
  });

  it('loadROM that overlaps a dirty RAM page throws', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    mem.writeByte(0x1100, 0x42);              // dirty page 17
    expect(() => mem.loadROM(0x1000, makeRomBytes(2))).toThrow(/dirty/);
  });

  it('loadROM at multiple non-overlapping addresses works independently', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    const a = makeRomBytes(1, 0x10);
    const b = makeRomBytes(1, 0x80);
    mem.loadROM(0x0000, a);
    mem.loadROM(0x4000, b);
    expect(mem.readByte(0x0000)).toBe(a[0]);
    expect(mem.readByte(0x00FF)).toBe(a[0xFF]);
    expect(mem.readByte(0x4000)).toBe(b[0]);
    expect(mem.readByte(0x40FF)).toBe(b[0xFF]);
  });

  it('flushDirty after loadROM is a no-op (no save calls to PageStore)', async () => {
    const store = new InMemoryPageStore();
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE, store });
    mem.loadROM(0x0000, makeRomBytes(2));
    const n = await mem.flushDirty();
    expect(n).toBe(0);
    expect(store.persistedCount).toBe(0);
  });

  it('writes to a RAM page neighbouring a ROM page still succeed', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    mem.loadROM(0x1000, makeRomBytes(1));   // page 16
    mem.writeByte(0x1100, 0xAB);              // page 17 (RAM)
    expect(mem.readByte(0x1100)).toBe(0xAB);
    expect(mem.dirtyCount).toBe(1);
    expect([...mem.dirtyPages()]).toEqual([17]);
  });

  it('hasPage returns true for ROM pages and isReadOnly reflects ROM marking', () => {
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    mem.loadROM(0x0800, makeRomBytes(2));     // pages 8, 9
    expect(mem.hasPage(8)).toBe(true);
    expect(mem.hasPage(9)).toBe(true);
    expect(mem.isReadOnly(8)).toBe(true);
    expect(mem.isReadOnly(9)).toBe(true);
    expect(mem.isReadOnly(10)).toBe(false);   // not loaded
    mem.writeByte(0x0A00, 0x11);              // page 10 RAM write
    expect(mem.isReadOnly(10)).toBe(false);
  });

  it('ROM pages persist across a stopWriteBack cycle', async () => {
    const store = new InMemoryPageStore();
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE, store });
    const rom = makeRomBytes(1);
    mem.loadROM(0x2000, rom);

    mem.startWriteBack({ intervalMs: 10_000 });
    await mem.stopWriteBack();

    expect(store.persistedCount).toBe(0);
    expect(mem.readByte(0x2000)).toBe(rom[0]);
    expect(mem.readByte(0x20FF)).toBe(rom[0xFF]);
  });

  it('loadROM rejects an unaligned start when length spans multiple pages', () => {
    // Sanity for the alignment check across a multi-page load.
    const mem = new PagedMemory({ pageSize: PAGE, addressSpaceSize: ADDR_SPACE });
    expect(() => mem.loadROM(PAGE / 2, makeRomBytes(2))).toThrow(/page-aligned/);
  });
});
