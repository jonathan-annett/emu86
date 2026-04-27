import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryDisk,
  NodeFileDisk,
  SECTOR_SIZE,
  type DiskGeometry,
} from '../../src/disk/index.js';

// 1.44 MB floppy: 80 cylinders × 2 heads × 18 sectors/track × 512 bytes
//                = 1,474,560 bytes (BIOS-standard "format type 4")
const FLOPPY_1440: DiskGeometry = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };
const FLOPPY_1440_BYTES = 80 * 2 * 18 * SECTOR_SIZE;

describe('InMemoryDisk', () => {
  it('construction with explicit geometry sets sectorCount', () => {
    const d = new InMemoryDisk({ geometry: FLOPPY_1440 });
    expect(d.sectorCount).toBe(80 * 2 * 18);
    expect(d.geometry).toEqual(FLOPPY_1440);
    expect(d.readonly).toBe(false);
  });

  it('rejects invalid geometry', () => {
    expect(() => new InMemoryDisk({ geometry: { cylinders: 0, heads: 1, sectorsPerTrack: 1 } }))
      .toThrow(/invalid geometry/);
    expect(() => new InMemoryDisk({ geometry: { cylinders: 1, heads: -1, sectorsPerTrack: 1 } }))
      .toThrow(/invalid geometry/);
  });

  it('a freshly constructed disk reads back zeros', () => {
    const d = new InMemoryDisk({ geometry: { cylinders: 1, heads: 1, sectorsPerTrack: 4 } });
    for (let lba = 0; lba < d.sectorCount; lba++) {
      const sec = d.readSector(lba);
      expect(sec.length).toBe(SECTOR_SIZE);
      for (let i = 0; i < SECTOR_SIZE; i++) expect(sec[i]).toBe(0);
    }
  });

  it('writeSector then readSector returns the same bytes', () => {
    const d = new InMemoryDisk({ geometry: { cylinders: 1, heads: 1, sectorsPerTrack: 4 } });
    const data = new Uint8Array(SECTOR_SIZE);
    for (let i = 0; i < SECTOR_SIZE; i++) data[i] = (i * 3 + 7) & 0xFF;
    d.writeSector(2, data);
    const back = d.readSector(2);
    expect(back).toEqual(data);
    // Other sectors still zero.
    expect(d.readSector(0).every((b) => b === 0)).toBe(true);
    expect(d.readSector(3).every((b) => b === 0)).toBe(true);
  });

  it('readSector returns a defensive copy (mutation does not affect storage)', () => {
    const d = new InMemoryDisk({ geometry: { cylinders: 1, heads: 1, sectorsPerTrack: 1 } });
    const filled = new Uint8Array(SECTOR_SIZE).fill(0xAA);
    d.writeSector(0, filled);
    const copy = d.readSector(0);
    copy[0] = 0;
    expect(d.readSector(0)[0]).toBe(0xAA);   // storage unchanged
  });

  it('readSector beyond sectorCount throws', () => {
    const d = new InMemoryDisk({ geometry: { cylinders: 1, heads: 1, sectorsPerTrack: 4 } });
    expect(() => d.readSector(4)).toThrow(/out of range/);
    expect(() => d.readSector(-1)).toThrow(/out of range/);
    expect(() => d.readSector(1.5)).toThrow(/out of range/);
  });

  it('writeSector beyond sectorCount throws', () => {
    const d = new InMemoryDisk({ geometry: { cylinders: 1, heads: 1, sectorsPerTrack: 4 } });
    const buf = new Uint8Array(SECTOR_SIZE);
    expect(() => d.writeSector(4, buf)).toThrow(/out of range/);
  });

  it('writeSector with wrong-size data throws', () => {
    const d = new InMemoryDisk({ geometry: { cylinders: 1, heads: 1, sectorsPerTrack: 1 } });
    expect(() => d.writeSector(0, new Uint8Array(511))).toThrow(/512 bytes/);
    expect(() => d.writeSector(0, new Uint8Array(513))).toThrow(/512 bytes/);
  });

  it('write to a readonly disk throws', () => {
    const d = new InMemoryDisk({
      geometry: { cylinders: 1, heads: 1, sectorsPerTrack: 1 },
      readonly: true,
    });
    expect(() => d.writeSector(0, new Uint8Array(SECTOR_SIZE))).toThrow(/read-only/);
  });

  it('initial contents are visible via readSector', () => {
    const geom: DiskGeometry = { cylinders: 1, heads: 1, sectorsPerTrack: 2 };
    const init = new Uint8Array(SECTOR_SIZE * 2);
    for (let i = 0; i < init.length; i++) init[i] = (i & 0xFF);
    const d = new InMemoryDisk({ geometry: geom, contents: init });
    expect(d.readSector(0)[5]).toBe(5);
    expect(d.readSector(1)[10]).toBe((SECTOR_SIZE + 10) & 0xFF);
  });

  it('initial contents shorter than disk size are zero-padded', () => {
    const geom: DiskGeometry = { cylinders: 1, heads: 1, sectorsPerTrack: 4 };
    const init = new Uint8Array(SECTOR_SIZE);
    init.fill(0xCC);
    const d = new InMemoryDisk({ geometry: geom, contents: init });
    expect(d.readSector(0).every((b) => b === 0xCC)).toBe(true);
    expect(d.readSector(1).every((b) => b === 0x00)).toBe(true);
    expect(d.readSector(3).every((b) => b === 0x00)).toBe(true);
  });

  it('initial contents larger than disk size throws', () => {
    const geom: DiskGeometry = { cylinders: 1, heads: 1, sectorsPerTrack: 1 };
    const tooBig = new Uint8Array(SECTOR_SIZE + 1);
    expect(() => new InMemoryDisk({ geometry: geom, contents: tooBig })).toThrow(/exceed/);
  });
});

describe('NodeFileDisk', () => {
  // One tmp dir per test, cleaned up after.
  let tmpDir: string | null = null;
  function makeTmp(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'emu86-disk-'));
    return tmpDir;
  }
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function writeImageFile(path: string, sizeBytes: number, fill = 0): void {
    const buf = Buffer.alloc(sizeBytes, fill);
    writeFileSync(path, buf);
  }

  it('constructs from a 1.44 MB image and infers floppy geometry', () => {
    const dir = makeTmp();
    const path = join(dir, 'floppy.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const d = new NodeFileDisk({ path });
    expect(d.geometry).toEqual(FLOPPY_1440);
    expect(d.sectorCount).toBe(FLOPPY_1440.cylinders * FLOPPY_1440.heads * FLOPPY_1440.sectorsPerTrack);
    d.close();
  });

  it('reads zero bytes from a freshly zeroed image', () => {
    const dir = makeTmp();
    const path = join(dir, 'z.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const d = new NodeFileDisk({ path });
    expect(d.readSector(0).every((b) => b === 0)).toBe(true);
    expect(d.readSector(d.sectorCount - 1).every((b) => b === 0)).toBe(true);
    d.close();
  });

  it('writeSector then readSector roundtrips', () => {
    const dir = makeTmp();
    const path = join(dir, 'rw.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const d = new NodeFileDisk({ path });
    const data = new Uint8Array(SECTOR_SIZE);
    for (let i = 0; i < SECTOR_SIZE; i++) data[i] = (i ^ 0x55) & 0xFF;
    d.writeSector(42, data);
    expect(d.readSector(42)).toEqual(data);
    d.close();
  });

  it('writes persist to the file (close, reopen, read same sector)', () => {
    const dir = makeTmp();
    const path = join(dir, 'persist.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const data = new Uint8Array(SECTOR_SIZE);
    for (let i = 0; i < SECTOR_SIZE; i++) data[i] = (i + 1) & 0xFF;

    const d1 = new NodeFileDisk({ path });
    d1.writeSector(7, data);
    d1.close();

    const d2 = new NodeFileDisk({ path });
    expect(d2.readSector(7)).toEqual(data);
    // And other sectors are still zero
    expect(d2.readSector(8).every((b) => b === 0)).toBe(true);
    d2.close();
  });

  it('throws when file size matches no standard geometry and no geometry passed', () => {
    const dir = makeTmp();
    const path = join(dir, 'odd.img');
    writeImageFile(path, SECTOR_SIZE * 100);   // 50 KB — not a standard floppy
    expect(() => new NodeFileDisk({ path })).toThrow(/standard floppy geometry/);
  });

  it('accepts an explicit geometry when size is non-standard', () => {
    const dir = makeTmp();
    const path = join(dir, 'custom.img');
    const geom: DiskGeometry = { cylinders: 5, heads: 2, sectorsPerTrack: 10 };
    writeImageFile(path, geom.cylinders * geom.heads * geom.sectorsPerTrack * SECTOR_SIZE);
    const d = new NodeFileDisk({ path, geometry: geom });
    expect(d.geometry).toEqual(geom);
    expect(d.sectorCount).toBe(100);
    d.close();
  });

  it('rejects an explicit geometry that does not match the file size', () => {
    const dir = makeTmp();
    const path = join(dir, 'mismatch.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const wrong: DiskGeometry = { cylinders: 80, heads: 2, sectorsPerTrack: 9 };
    expect(() => new NodeFileDisk({ path, geometry: wrong })).toThrow(/expects/);
  });

  it('readonly disk: writeSector throws', () => {
    const dir = makeTmp();
    const path = join(dir, 'ro.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const d = new NodeFileDisk({ path, readonly: true });
    expect(d.readonly).toBe(true);
    expect(() => d.writeSector(0, new Uint8Array(SECTOR_SIZE))).toThrow(/read-only/);
    d.close();
  });

  it('operations after close throw', () => {
    const dir = makeTmp();
    const path = join(dir, 'closed.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const d = new NodeFileDisk({ path });
    d.close();
    expect(() => d.readSector(0)).toThrow(/closed/);
    expect(() => d.writeSector(0, new Uint8Array(SECTOR_SIZE))).toThrow(/closed/);
  });

  it('close is idempotent', () => {
    const dir = makeTmp();
    const path = join(dir, 'idem.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const d = new NodeFileDisk({ path });
    d.close();
    expect(() => d.close()).not.toThrow();
  });

  it('write-through reaches the underlying file before close()', () => {
    // Verifies we don't only update the cache — the on-disk file actually
    // changes after writeSector, before any close(). Tests the consistency
    // contract that a crash between writeSector calls leaves a valid image.
    const dir = makeTmp();
    const path = join(dir, 'thru.img');
    writeImageFile(path, FLOPPY_1440_BYTES);
    const d = new NodeFileDisk({ path });
    const data = new Uint8Array(SECTOR_SIZE).fill(0xEE);
    d.writeSector(3, data);

    // Read the file directly without going through the disk class.
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(SECTOR_SIZE);
    readSync(fd, buf, 0, SECTOR_SIZE, 3 * SECTOR_SIZE);
    closeSync(fd);
    expect(buf.every((b) => b === 0xEE)).toBe(true);

    d.close();
  });

  it('handles a 360 KB floppy size (standard 5.25" DSDD)', () => {
    const dir = makeTmp();
    const path = join(dir, '360.img');
    const expected: DiskGeometry = { cylinders: 40, heads: 2, sectorsPerTrack: 9 };
    writeImageFile(path, expected.cylinders * expected.heads * expected.sectorsPerTrack * SECTOR_SIZE);
    const d = new NodeFileDisk({ path });
    expect(d.geometry).toEqual(expected);
    d.close();
  });

  it('non-existent path: open throws', () => {
    const dir = makeTmp();
    const path = join(dir, 'missing.img');
    expect(() => new NodeFileDisk({ path })).toThrow();
  });

  // Sanity: keep `writeSync` import warning-free by referencing it from a
  // helper that's actually used. (Not a behavioural test — just a guard
  // against vitest "unused import" complaints in strict mode.)
  it('exposes the SECTOR_SIZE constant', () => {
    expect(SECTOR_SIZE).toBe(512);
    void writeSync;   // silence unused import in some strict-mode toolchains
  });
});
