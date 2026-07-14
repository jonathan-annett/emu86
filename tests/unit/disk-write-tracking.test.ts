/**
 * WriteTrackingDisk unit tests (Phase 15 M2 — virtual drives).
 *
 * The tracker is the worker-side substrate for the persistent
 * secondary drive: distinct-sector dirty counting (the unsaved-changes
 * signal) and full-image snapshots (what Save persists).
 */

import { describe, it, expect } from 'vitest';
import { InMemoryDisk, WriteTrackingDisk, SECTOR_SIZE } from '../../src/disk/disk.js';

const GEOMETRY = { cylinders: 2, heads: 2, sectorsPerTrack: 4 }; // 16 sectors

function sector(fill: number): Uint8Array {
  return new Uint8Array(SECTOR_SIZE).fill(fill);
}

describe('WriteTrackingDisk', () => {
  it('passes reads and writes through and mirrors the inner disk shape', () => {
    const inner = new InMemoryDisk({ geometry: GEOMETRY });
    const disk = new WriteTrackingDisk(inner);
    expect(disk.geometry).toEqual(GEOMETRY);
    expect(disk.sectorCount).toBe(16);
    expect(disk.readonly).toBe(false);

    disk.writeSector(5, sector(0xaa));
    expect(Array.from(disk.readSector(5))).toEqual(Array.from(sector(0xaa)));
    expect(Array.from(inner.readSector(5))).toEqual(Array.from(sector(0xaa)));
  });

  it('counts distinct dirty sectors, not writes', () => {
    const disk = new WriteTrackingDisk(new InMemoryDisk({ geometry: GEOMETRY }));
    expect(disk.dirtySectorCount).toBe(0);
    disk.writeSector(1, sector(1));
    disk.writeSector(1, sector(2)); // same sector again
    disk.writeSector(9, sector(3));
    expect(disk.dirtySectorCount).toBe(2);
  });

  it('snapshot() is the full image, byte-exact, writes included', () => {
    const contents = new Uint8Array(16 * SECTOR_SIZE);
    contents.fill(0x11, 0, SECTOR_SIZE); // sector 0 pre-filled
    const disk = new WriteTrackingDisk(
      new InMemoryDisk({ geometry: GEOMETRY, contents }),
    );
    disk.writeSector(2, sector(0x22));
    const snap = disk.snapshot();
    expect(snap.length).toBe(16 * SECTOR_SIZE);
    expect(snap[0]).toBe(0x11);
    expect(snap[2 * SECTOR_SIZE]).toBe(0x22);
    expect(snap[3 * SECTOR_SIZE]).toBe(0); // untouched sector stays zero
  });

  it('markClean() resets the dirty count without touching data', () => {
    const disk = new WriteTrackingDisk(new InMemoryDisk({ geometry: GEOMETRY }));
    disk.writeSector(4, sector(0x44));
    expect(disk.dirtySectorCount).toBe(1);
    disk.markClean();
    expect(disk.dirtySectorCount).toBe(0);
    expect(disk.readSector(4)[0]).toBe(0x44);
    // New writes dirty again after a clean.
    disk.writeSector(4, sector(0x45));
    expect(disk.dirtySectorCount).toBe(1);
  });
});
