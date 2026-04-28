/**
 * Phase 10 — size → (geometry, diskClass) inference for the worker host's
 * boot-time disk lookup.
 *
 * The size table covers floppy + ELKS HD shapes; tests here pin each size
 * we've committed to recognising, the head-based class heuristic, and the
 * negative case (unknown sizes return null so the caller falls back to an
 * explicit geometry).
 */

import { describe, expect, it } from 'vitest';
import {
  inferFromSize,
  classFromGeometry,
} from '../../src/browser/worker-host.js';
import { WorkerHost } from '../../src/browser/worker-host.js';
import { SECTOR_SIZE } from '../../src/disk/disk.js';

describe('inferFromSize — size table', () => {
  it('1.44 MB floppy maps to 80×2×18 / floppy', () => {
    const r = inferFromSize(1474560);
    expect(r).not.toBeNull();
    expect(r!.geometry).toEqual({ cylinders: 80, heads: 2, sectorsPerTrack: 18 });
    expect(r!.diskClass).toBe('floppy');
  });

  it('1.2 MB floppy maps to 80×2×15 / floppy', () => {
    const r = inferFromSize(1228800);
    expect(r).not.toBeNull();
    expect(r!.geometry).toEqual({ cylinders: 80, heads: 2, sectorsPerTrack: 15 });
    expect(r!.diskClass).toBe('floppy');
  });

  it('hd32 partitionless (32,514,048) maps to 63×16×63 / hard-disk (exact fit)', () => {
    const r = inferFromSize(32514048);
    expect(r).not.toBeNull();
    expect(r!.geometry).toEqual({ cylinders: 63, heads: 16, sectorsPerTrack: 63 });
    expect(r!.diskClass).toBe('hard-disk');
    // Sanity: 63 × 16 × 63 × 512 = exact image size.
    const cap = r!.geometry.cylinders * r!.geometry.heads * r!.geometry.sectorsPerTrack * SECTOR_SIZE;
    expect(cap).toBe(32514048);
  });

  it('hd32mbr (32,546,304) maps to a hard-disk geometry that contains the image', () => {
    const r = inferFromSize(32546304);
    expect(r).not.toBeNull();
    expect(r!.diskClass).toBe('hard-disk');
    // Geometry must hold the image (zero-padding the trailing region is OK —
    // the kernel reads the filesystem area only).
    const cap = r!.geometry.cylinders * r!.geometry.heads * r!.geometry.sectorsPerTrack * SECTOR_SIZE;
    expect(cap).toBeGreaterThanOrEqual(32546304);
  });

  it('hd64 partitionless (67,107,840) maps to a hard-disk geometry that contains the image', () => {
    const r = inferFromSize(67107840);
    expect(r).not.toBeNull();
    expect(r!.diskClass).toBe('hard-disk');
    const cap = r!.geometry.cylinders * r!.geometry.heads * r!.geometry.sectorsPerTrack * SECTOR_SIZE;
    expect(cap).toBeGreaterThanOrEqual(67107840);
  });

  it('hd64mbr (67,140,096) maps to a hard-disk geometry that contains the image', () => {
    const r = inferFromSize(67140096);
    expect(r).not.toBeNull();
    expect(r!.diskClass).toBe('hard-disk');
    const cap = r!.geometry.cylinders * r!.geometry.heads * r!.geometry.sectorsPerTrack * SECTOR_SIZE;
    expect(cap).toBeGreaterThanOrEqual(67140096);
  });

  it('unrecognised size returns null', () => {
    expect(inferFromSize(123456)).toBeNull();
    expect(inferFromSize(0)).toBeNull();
    expect(inferFromSize(2 * 1024 * 1024)).toBeNull();
  });
});

describe('classFromGeometry — heads-based heuristic', () => {
  it('heads ≤ 2 → floppy', () => {
    expect(classFromGeometry({ cylinders: 40, heads: 1, sectorsPerTrack: 9 })).toBe('floppy');
    expect(classFromGeometry({ cylinders: 80, heads: 2, sectorsPerTrack: 18 })).toBe('floppy');
  });

  it('heads ≥ 4 → hard-disk', () => {
    expect(classFromGeometry({ cylinders: 63, heads: 16, sectorsPerTrack: 63 })).toBe('hard-disk');
    expect(classFromGeometry({ cylinders: 200, heads: 4, sectorsPerTrack: 17 })).toBe('hard-disk');
  });
});

describe('WorkerHost boot — explicit geometry overrides the size table', () => {
  it('an unknown image size with explicit geometry boots without throwing', async () => {
    // 4-cylinder × 1-head × 1-spt × 512 = 2048-byte synthetic disk; smaller
    // than any table entry, so the size table will *not* infer for it. The
    // explicit geometry in the boot config takes precedence.
    const bytes = new Uint8Array(2048);
    const host = new WorkerHost({
      post: () => { /* ignore */ },
      autoRun: false,
    });
    host.handleMessage({
      type: 'boot',
      config: {
        imageBytes: bytes,
        geometry: { cylinders: 4, heads: 1, sectorsPerTrack: 1 },
      },
    });
    await host.whenIdle();
    expect(host.machine).not.toBeNull();
    expect(host.machine!.disk?.geometry).toEqual({ cylinders: 4, heads: 1, sectorsPerTrack: 1 });
    // Tiny synthetic geometry has heads < 4, so it's classed as floppy.
    expect(host.machine!.diskClass).toBe('floppy');
  });

  it('a 32 MB hd32 image boots with the inferred hard-disk class', async () => {
    const bytes = new Uint8Array(32514048);
    const host = new WorkerHost({
      post: () => { /* ignore */ },
      autoRun: false,
    });
    host.handleMessage({
      type: 'boot',
      config: { imageBytes: bytes },
    });
    await host.whenIdle();
    expect(host.machine).not.toBeNull();
    expect(host.machine!.diskClass).toBe('hard-disk');
    expect(host.machine!.disk?.geometry.heads).toBe(16);
  });

  it('explicit diskClass overrides geometry-based inference', async () => {
    // 1.44 MB floppy *image* (size table → floppy), but caller pins
    // diskClass:'hard-disk'. The explicit config wins.
    const bytes = new Uint8Array(1474560);
    const host = new WorkerHost({
      post: () => { /* ignore */ },
      autoRun: false,
    });
    host.handleMessage({
      type: 'boot',
      config: { imageBytes: bytes, diskClass: 'hard-disk' },
    });
    await host.whenIdle();
    expect(host.machine).not.toBeNull();
    expect(host.machine!.diskClass).toBe('hard-disk');
  });
});
