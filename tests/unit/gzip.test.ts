/**
 * gunzip helpers — round-trips against node:zlib's gzip (the same
 * format the committed web/public/hd32-minix.img.gz was made with).
 * DecompressionStream is global in Node ≥18, same API the browser
 * runs.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { gunzipBytes, gunzipStream, gzipBytes } from '../../web/gzip.js';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('gunzip', () => {
  it('round-trips bytes, including long zero runs (the disk-image shape)', async () => {
    const original = new Uint8Array(256 * 1024);
    original.fill(0x5a, 1000, 2000);
    original.fill(0xa5, 200_000, 200_512);
    const packed = new Uint8Array(gzipSync(original));
    expect(packed.length).toBeLessThan(original.length / 10); // the 10:1 class
    const out = await gunzipBytes(packed);
    expect(sameBytes(out, original)).toBe(true);
  });

  it('reports COMPRESSED progress monotonically up to the wire size', async () => {
    const original = new Uint8Array(64 * 1024).fill(7);
    const packed = new Uint8Array(gzipSync(original));
    const seen: number[] = [];
    const out = await gunzipStream(
      new Blob([packed]).stream(),
      (loaded) => seen.push(loaded),
    );
    expect(out.length).toBe(original.length);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(packed.length);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] ?? 0).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    }
  });

  it('corrupt input rejects (gzip CRC is the integrity check)', async () => {
    const packed = new Uint8Array(gzipSync(new Uint8Array(1024).fill(3)));
    const tail = packed.length - 5; // wreck the CRC/tail
    packed[tail] = (packed[tail] ?? 0) ^ 0xff;
    await expect(gunzipBytes(packed)).rejects.toThrow();
  });
});

describe('gzip (Phase 18 M2 — the compress half)', () => {
  it('gzipBytes → gunzipBytes round-trips, compressing the disk-image shape', async () => {
    const original = new Uint8Array(256 * 1024);
    original.fill(0x42, 500, 1500);
    original.fill(0x99, 100_000, 100_777);
    const packed = await gzipBytes(original);
    expect(packed.length).toBeLessThan(original.length / 10); // the 10:1 class
    const out = await gunzipBytes(packed);
    expect(sameBytes(out, original)).toBe(true);
  });

  it('interoperates with node:zlib (real gzip format, not just self-consistent)', async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    const packed = await gzipBytes(original);
    const viaZlib = new Uint8Array(gunzipSync(packed));
    expect(sameBytes(viaZlib, original)).toBe(true);
  });
});
