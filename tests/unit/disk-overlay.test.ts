/**
 * OverlayDisk — the Phase 17 M1 overlay engine's state machine.
 *
 * All in-memory (the Phase 16 lesson: fake-indexeddb costs seconds per
 * MB and `toEqual` on MB-scale arrays costs ~90 s — byte comparison
 * here is a plain loop, and no IDB is involved at this layer). The
 * three M1 acceptance scenarios from the brief live in this file:
 *
 *   1. a simulated write storm sweeps to exactly the expected chunk set;
 *   2. a nacked epoch merges back correctly (newer writes win);
 *   3. a full-disk rewrite stays bounded by the forced-sweep threshold.
 *
 * Tests use a small disk (64 sectors / 32 KiB) and a small chunk span
 * (2 KiB = 4 sectors) so expected values stay readable; the production
 * constants are pinned by their own test.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryDisk, SECTOR_SIZE } from '../../src/disk/disk.js';
import {
  FORCED_SWEEP_BYTES,
  OVERLAY_CHUNK_BYTES,
  OverlayDisk,
  type OverlayChunk,
} from '../../src/disk/overlay.js';

/** 64 sectors = 32 KiB. */
const GEOMETRY = { cylinders: 4, heads: 2, sectorsPerTrack: 8 };
const SECTORS = 64;
/** 4 sectors per chunk → 16 chunks over the test disk. */
const CHUNK_BYTES = 4 * SECTOR_SIZE;

/** Plain-loop byte equality — never `toEqual` on big arrays. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sector(fill: number): Uint8Array {
  return new Uint8Array(SECTOR_SIZE).fill(fill);
}

/** Base image where byte b of sector s is (s + 1), so RAM fill-in is visible. */
function seededDisk(): { inner: InMemoryDisk; overlay: OverlayDisk } {
  const contents = new Uint8Array(SECTORS * SECTOR_SIZE);
  for (let s = 0; s < SECTORS; s++) {
    contents.fill(s + 1, s * SECTOR_SIZE, (s + 1) * SECTOR_SIZE);
  }
  const inner = new InMemoryDisk({ geometry: GEOMETRY, contents });
  const overlay = new OverlayDisk(inner, { chunkBytes: CHUNK_BYTES });
  return { inner, overlay };
}

/** The chunk's expected bytes, read back from the disk's current RAM. */
function ramSpan(disk: OverlayDisk, chunkIndex: number, sectorsPerChunk: number): Uint8Array {
  const first = chunkIndex * sectorsPerChunk;
  const last = Math.min(first + sectorsPerChunk, disk.sectorCount);
  const out = new Uint8Array((last - first) * SECTOR_SIZE);
  for (let lba = first; lba < last; lba++) {
    out.set(disk.readSector(lba), (lba - first) * SECTOR_SIZE);
  }
  return out;
}

describe('OverlayDisk — constants', () => {
  it('pins the §4.2 decisions: 32 KB chunks, 4 MB forced-sweep threshold', () => {
    expect(OVERLAY_CHUNK_BYTES).toBe(32 * 1024);
    expect(OVERLAY_CHUNK_BYTES % SECTOR_SIZE).toBe(0);
    expect(FORCED_SWEEP_BYTES).toBe(4 * 1024 * 1024);
  });

  it('rejects a chunk span that is not a positive sector multiple', () => {
    const { inner } = seededDisk();
    expect(() => new OverlayDisk(inner, { chunkBytes: 100 })).toThrow(/multiple/);
    expect(() => new OverlayDisk(inner, { chunkBytes: 0 })).toThrow(/multiple/);
  });
});

describe('OverlayDisk — Disk decoration', () => {
  it('passes geometry/sectorCount/reads through and double-writes', () => {
    const { inner, overlay } = seededDisk();
    expect(overlay.geometry).toEqual(GEOMETRY);
    expect(overlay.sectorCount).toBe(SECTORS);
    expect(overlay.readonly).toBe(false);
    expect(overlay.chunkBytes).toBe(CHUNK_BYTES);
    expect(sameBytes(overlay.readSector(5), sector(6))).toBe(true);

    overlay.writeSector(5, sector(0xaa));
    // RAM stays authoritative (the inner disk saw the write)...
    expect(inner.readSector(5)[0]).toBe(0xaa);
    expect(overlay.readSector(5)[0]).toBe(0xaa);
    // ...and the hot map counted it (distinct sectors, not writes).
    overlay.writeSector(5, sector(0xab));
    expect(overlay.hotSectorCount).toBe(1);
    expect(overlay.hotByteCount).toBe(SECTOR_SIZE);
  });

  it('a rejected write never pollutes the hot map', () => {
    const { overlay } = seededDisk();
    expect(() => overlay.writeSector(SECTORS, sector(1))).toThrow(/out of range/);
    expect(() => overlay.writeSector(3, new Uint8Array(100))).toThrow(/512/);
    expect(overlay.hotSectorCount).toBe(0);
  });

  it('copies bytes at write time — caller buffer reuse cannot corrupt an epoch', () => {
    const { overlay } = seededDisk();
    const buffer = sector(0x11);
    overlay.writeSector(0, buffer);
    buffer.fill(0x99); // BIOS-style buffer reuse after the write
    const chunks = overlay.beginSweep(1);
    expect(chunks).not.toBeNull();
    expect(chunks?.[0]?.bytes[0]).toBe(0x11);
  });
});

describe('OverlayDisk — chunk coalescing', () => {
  it('adjacent dirty sectors collapse into one aligned chunk with RAM fill-in', () => {
    const { overlay } = seededDisk();
    // Sectors 0, 1, 3 dirty; sector 2 untouched (base pattern = 3).
    overlay.writeSector(0, sector(0xa0));
    overlay.writeSector(1, sector(0xa1));
    overlay.writeSector(3, sector(0xa3));

    const chunks = overlay.beginSweep(1);
    expect(chunks?.map((c) => c.chunkIndex)).toEqual([0]);
    const bytes = chunks?.[0]?.bytes;
    expect(bytes?.length).toBe(CHUNK_BYTES); // full aligned span
    expect(bytes?.[0 * SECTOR_SIZE]).toBe(0xa0);
    expect(bytes?.[1 * SECTOR_SIZE]).toBe(0xa1);
    expect(bytes?.[2 * SECTOR_SIZE]).toBe(3); // RAM fill-in, not zero
    expect(bytes?.[3 * SECTOR_SIZE]).toBe(0xa3);
  });

  it('sparse writes produce one chunk per touched span, sorted', () => {
    const { overlay } = seededDisk();
    overlay.writeSector(63, sector(1)); // chunk 15
    overlay.writeSector(0, sector(2));  // chunk 0
    overlay.writeSector(17, sector(3)); // chunk 4
    const chunks = overlay.beginSweep(1);
    expect(chunks?.map((c) => c.chunkIndex)).toEqual([0, 4, 15]);
  });

  it('the tail chunk is short when the disk is not a chunk multiple', () => {
    // 18 sectors, 4-sector chunks → chunk 4 spans sectors 16..17 only.
    const inner = new InMemoryDisk({
      geometry: { cylinders: 1, heads: 2, sectorsPerTrack: 9 },
    });
    const overlay = new OverlayDisk(inner, { chunkBytes: CHUNK_BYTES });
    overlay.writeSector(17, sector(0xee));
    const chunks = overlay.beginSweep(1);
    expect(chunks?.map((c) => c.chunkIndex)).toEqual([4]);
    expect(chunks?.[0]?.bytes.length).toBe(2 * SECTOR_SIZE);
    expect(chunks?.[0]?.bytes[1 * SECTOR_SIZE]).toBe(0xee);
  });
});

describe('OverlayDisk — epoch discipline', () => {
  it('beginSweep returns null when clean or when an epoch is in flight', () => {
    const { overlay } = seededDisk();
    expect(overlay.beginSweep(1)).toBeNull(); // nothing dirty

    overlay.writeSector(0, sector(1));
    expect(overlay.beginSweep(2)).not.toBeNull();
    expect(overlay.sweepPending).toBe(true);
    expect(overlay.pendingEpochId).toBe(2);

    overlay.writeSector(1, sector(2));
    expect(overlay.beginSweep(3)).toBeNull(); // single-flight
    expect(overlay.pendingEpochId).toBe(2);
  });

  it('writes during a pending epoch land in the next one', () => {
    const { overlay } = seededDisk();
    overlay.writeSector(0, sector(0x10));
    overlay.beginSweep(1);
    overlay.writeSector(4, sector(0x20)); // lands in the fresh map
    expect(overlay.hotSectorCount).toBe(1);

    overlay.ackSweep(1);
    const chunks = overlay.beginSweep(2);
    expect(chunks?.map((c) => c.chunkIndex)).toEqual([1]); // only the new write
  });

  it('ack drops the epoch; stale and unknown ids are ignored', () => {
    const { overlay } = seededDisk();
    overlay.writeSector(0, sector(1));
    overlay.beginSweep(7);
    overlay.ackSweep(6); // stale id — no-op
    expect(overlay.sweepPending).toBe(true);
    overlay.ackSweep(7);
    expect(overlay.sweepPending).toBe(false);
    overlay.ackSweep(7); // already settled — no-op
    overlay.nackSweep(7); // likewise
    expect(overlay.hotSectorCount).toBe(0);
  });

  // M1 acceptance 2: nack merges epochs correctly — newer wins.
  it('nack merges the epoch back under newer hot-map writes', () => {
    const { overlay } = seededDisk();
    overlay.writeSector(5, sector(0xaa)); // in the epoch
    overlay.writeSector(7, sector(0xdd)); // in the epoch, untouched after
    overlay.beginSweep(1);

    overlay.writeSector(5, sector(0xbb)); // NEWER write, same sector
    overlay.writeSector(6, sector(0xcc)); // new sector
    overlay.nackSweep(1);

    expect(overlay.hotSectorCount).toBe(3);
    const chunks = overlay.beginSweep(2);
    const bytes = chunks?.[0]?.bytes;
    expect(chunks?.map((c) => c.chunkIndex)).toEqual([1]);
    expect(bytes?.[(5 - 4) * SECTOR_SIZE]).toBe(0xbb); // newer won
    expect(bytes?.[(6 - 4) * SECTOR_SIZE]).toBe(0xcc);
    expect(bytes?.[(7 - 4) * SECTOR_SIZE]).toBe(0xdd); // epoch-only survived
  });
});

describe('OverlayDisk — M1 acceptance', () => {
  // Acceptance 1: a write storm sweeps to exactly the expected chunk set.
  it('write storm → exactly the expected chunks, byte-exact against RAM', () => {
    const { overlay } = seededDisk();
    const sectorsPerChunk = CHUNK_BYTES / SECTOR_SIZE;
    // Storm: all of chunk 3, half of chunk 7, one sector of chunk 12.
    const written = [12, 13, 14, 15, 28, 29, 48];
    for (const lba of written) overlay.writeSector(lba, sector(0x80 + lba));

    const chunks = overlay.beginSweep(1);
    expect(chunks?.map((c) => c.chunkIndex)).toEqual([3, 7, 12]);
    for (const chunk of chunks ?? []) {
      // Every swept sector was in the epoch, so the chunk must equal
      // the current RAM span exactly (writes + fill-in alike).
      expect(sameBytes(chunk.bytes, ramSpan(overlay, chunk.chunkIndex, sectorsPerChunk))).toBe(true);
    }
  });

  // Acceptance 3: a full-disk rewrite stays bounded by the forced-sweep
  // threshold. The engine exposes hotByteCount; the host-side trigger is
  // simulated here exactly as worker-host wires it (threshold check after
  // each write-turn, immediate ack). Chunk-record idempotence is verified
  // by replaying every epoch in order and comparing to final RAM.
  it('full-disk rewrite: hot map bounded by the threshold, chunks reassemble the disk', () => {
    const { overlay } = seededDisk();
    const sectorsPerChunk = CHUNK_BYTES / SECTOR_SIZE;
    const THRESHOLD = 8 * SECTOR_SIZE; // scaled-down FORCED_SWEEP_BYTES
    const replayed = new Map<number, Uint8Array>(); // chunkIndex → latest bytes
    let epoch = 0;
    let maxHotBytes = 0;

    for (let lba = 0; lba < SECTORS; lba++) {
      overlay.writeSector(lba, sector((lba * 7 + 3) % 256));
      maxHotBytes = Math.max(maxHotBytes, overlay.hotByteCount);
      if (overlay.hotByteCount >= THRESHOLD && !overlay.sweepPending) {
        const chunks = overlay.beginSweep(++epoch);
        for (const c of chunks ?? []) replayed.set(c.chunkIndex, c.bytes);
        overlay.ackSweep(epoch);
      }
    }
    // Final drain, as reset/flush would do.
    const rest = overlay.beginSweep(++epoch);
    for (const c of rest ?? []) replayed.set(c.chunkIndex, c.bytes);
    overlay.ackSweep(epoch);

    expect(maxHotBytes).toBeLessThanOrEqual(THRESHOLD);
    expect(overlay.hotSectorCount).toBe(0);

    // Idempotent replay (later chunk versions overwrote earlier ones)
    // must reproduce the disk byte-for-byte.
    const image = new Uint8Array(SECTORS * SECTOR_SIZE);
    for (const [chunkIndex, bytes] of replayed) {
      image.set(bytes, chunkIndex * sectorsPerChunk * SECTOR_SIZE);
    }
    const ram = new Uint8Array(SECTORS * SECTOR_SIZE);
    for (let lba = 0; lba < SECTORS; lba++) ram.set(overlay.readSector(lba), lba * SECTOR_SIZE);
    expect(sameBytes(image, ram)).toBe(true);
  });

  it('chunks are freshly allocated — safe to transfer', () => {
    const { overlay } = seededDisk();
    overlay.writeSector(0, sector(1));
    overlay.writeSector(4, sector(2));
    const chunks = overlay.beginSweep(1) as OverlayChunk[];
    expect(chunks[0]?.bytes.buffer).not.toBe(chunks[1]?.bytes.buffer);
    expect(chunks[0]?.bytes.byteOffset).toBe(0);
    expect(chunks[0]?.bytes.byteLength).toBe(chunks[0]?.bytes.buffer.byteLength);
  });
});
