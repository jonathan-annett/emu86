import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { ImageLibrary } from '../../web/image-library.js';

// Each test starts on a clean IDBFactory — same pattern as
// idb-page-store.test.ts (the polyfill-blessed reset path).
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const sampleBytes = (n: number, fill = 0): Uint8Array => {
  const a = new Uint8Array(n);
  a.fill(fill);
  return a;
};

describe('ImageLibrary', () => {
  it('addImage → listImages → getImageBytes round-trips', async () => {
    const lib = new ImageLibrary('test-images-1');
    const id = await lib.addImage('alpha.img', sampleBytes(8, 0xAB), 'upload');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const list = await lib.listImages();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      name: 'alpha.img',
      sizeBytes: 8,
      source: 'upload',
    });
    expect(typeof list[0]?.uploadedAt).toBe('number');

    const bytes = await lib.getImageBytes(id);
    expect(bytes).toEqual(sampleBytes(8, 0xAB));
    lib.close();
  });

  it('listImages excludes the bytes payload', async () => {
    const lib = new ImageLibrary('test-images-2');
    await lib.addImage('a', sampleBytes(4, 1), 'upload');
    const list = await lib.listImages();
    expect(list).toHaveLength(1);
    // `bytes` is omitted from StoredImageMeta — assert structurally.
    expect(Object.keys(list[0]!).sort()).toEqual(
      ['id', 'name', 'sizeBytes', 'source', 'uploadedAt'].sort(),
    );
    expect((list[0] as Record<string, unknown>).bytes).toBeUndefined();
    lib.close();
  });

  it('multiple entries sort newest-first by uploadedAt', async () => {
    const lib = new ImageLibrary('test-images-3');
    // Three distinct uploadedAt values via real Date.now() spacing. Add a
    // tiny await between adds so the millisecond resolution doesn't collapse.
    const a = await lib.addImage('a', sampleBytes(2, 1));
    await new Promise((r) => setTimeout(r, 2));
    const b = await lib.addImage('b', sampleBytes(2, 2));
    await new Promise((r) => setTimeout(r, 2));
    const c = await lib.addImage('c', sampleBytes(2, 3));

    const list = await lib.listImages();
    expect(list.map((m) => m.id)).toEqual([c, b, a]);
    lib.close();
  });

  it('removeImage drops the entry; remove of missing id is a no-op', async () => {
    const lib = new ImageLibrary('test-images-4');
    const id = await lib.addImage('a', sampleBytes(2, 1));
    await lib.removeImage(id);
    expect(await lib.listImages()).toHaveLength(0);
    // Second remove of the same id must not throw.
    await expect(lib.removeImage(id)).resolves.toBeUndefined();
    // Remove of a never-stored id likewise.
    await expect(lib.removeImage('never-existed')).resolves.toBeUndefined();
    lib.close();
  });

  it('renameImage updates the name; rename of missing id rejects', async () => {
    const lib = new ImageLibrary('test-images-5');
    const id = await lib.addImage('old-name.img', sampleBytes(2, 1));
    await lib.renameImage(id, 'new-name.img');
    const list = await lib.listImages();
    expect(list[0]?.name).toBe('new-name.img');
    // Bytes unchanged after rename.
    const bytes = await lib.getImageBytes(id);
    expect(bytes).toEqual(sampleBytes(2, 1));

    await expect(lib.renameImage('never-existed', 'whatever'))
      .rejects.toThrow(/no image with id/);
    lib.close();
  });

  it('hasImage returns true for live ids, false otherwise', async () => {
    const lib = new ImageLibrary('test-images-6');
    const id = await lib.addImage('a', sampleBytes(2, 1));
    expect(await lib.hasImage(id)).toBe(true);
    expect(await lib.hasImage('never-existed')).toBe(false);
    await lib.removeImage(id);
    expect(await lib.hasImage(id)).toBe(false);
    lib.close();
  });

  it('getImageBytes throws on missing id', async () => {
    const lib = new ImageLibrary('test-images-7');
    await expect(lib.getImageBytes('never-existed')).rejects.toThrow(/no image with id/);
    lib.close();
  });

  it('getImageBytes returns a fresh copy, not the stored buffer', async () => {
    const lib = new ImageLibrary('test-images-8');
    const id = await lib.addImage('a', sampleBytes(4, 0xCC));
    const a = await lib.getImageBytes(id);
    a[0] = 0; // mutate caller's copy
    const b = await lib.getImageBytes(id);
    expect(b[0]).toBe(0xCC);  // store unaffected
    lib.close();
  });

  it('getQuotaUsage returns a sensible shape even when navigator is absent', async () => {
    // No navigator in this Node test env → the library returns the safe shape.
    const lib = new ImageLibrary('test-images-9');
    const usage = await lib.getQuotaUsage();
    expect(typeof usage.usedBytes).toBe('number');
    expect(usage.usedBytes).toBeGreaterThanOrEqual(0);
    // quotaBytes is null when storage.estimate is unavailable; otherwise
    // either a number or null. Don't over-constrain.
    expect(usage.quotaBytes === null || typeof usage.quotaBytes === 'number').toBe(true);
    lib.close();
  });

  it('uses the configured database name', () => {
    const lib = new ImageLibrary('custom-name');
    expect(lib.databaseName).toBe('custom-name');
    // Default name picked when omitted.
    const lib2 = new ImageLibrary();
    expect(lib2.databaseName).toBe('emu86-images');
  });

  // Phase 9.3: source: 'github' round-trip. The Phase 9.2 schema declared
  // the discriminator; this test pins down that listing/get/remove all
  // handle the new value identically. No IDB migration was needed.
  it("round-trips a source: 'github' entry through list / get / remove", async () => {
    const lib = new ImageLibrary('test-images-github-1');
    const id = await lib.addImage('hd32-fat.img', sampleBytes(16, 0x55), 'github');
    const list = await lib.listImages();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      name: 'hd32-fat.img',
      sizeBytes: 16,
      source: 'github',
    });
    const bytes = await lib.getImageBytes(id);
    expect(bytes).toEqual(sampleBytes(16, 0x55));
    await lib.removeImage(id);
    expect(await lib.listImages()).toHaveLength(0);
    lib.close();
  });

  // Phase 9.3: viability tag passes through addImage and shows up in
  // listImages metadata. Optional field — undefined is the legacy/upload
  // shape; reading code treats undefined as "unknown".
  it('carries a viability tag through addImage → listImages', async () => {
    const lib = new ImageLibrary('test-images-github-2');
    const id = await lib.addImage(
      'fd1440-fat-serial.img',
      sampleBytes(8, 1),
      'github',
      'likely-works',
    );
    const list = await lib.listImages();
    expect(list[0]?.viability).toBe('likely-works');
    // Upload-source entries omit viability.
    await lib.addImage('uploaded.img', sampleBytes(8, 2), 'upload');
    const after = await lib.listImages();
    const uploaded = after.find((m) => m.id !== id);
    expect(uploaded?.viability).toBeUndefined();
    lib.close();
  });
});
