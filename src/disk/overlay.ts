/**
 * Phase 17 M1 — block-level COW overlay engine for the boot disk.
 *
 * The primary disk's guest writes must survive a reload without ever
 * writing the base image (phase 17 brief §1). The mechanism is a hot
 * map + epoch sweep:
 *
 *   - **Hot map**: every `writeSector` lands in the wrapped disk's RAM
 *     (authoritative, exactly as before) AND in a `Map<lba, bytes>`
 *     with the bytes COPIED AT WRITE TIME. The copy is what makes
 *     sweep epochs exact — callers (BIOS INT 13h, replaceContents-
 *     style loops) reuse and subarray their buffers.
 *   - **Reads never touch the map.** `readSector` executes inside
 *     `cpu.step()`, which is synchronous and infallible (hard rule 1);
 *     it delegates straight to the wrapped disk. All persistence I/O
 *     happens elsewhere (main thread), at sweep or boot time.
 *   - **Epoch sweep**: `beginSweep` swaps in a fresh hot map and
 *     coalesces the old one into fixed-size ALIGNED chunks — adjacent
 *     dirty sectors collapse into one record, and chunk keys are
 *     idempotent (a chunk overwrites its prior version in the store).
 *     A swept chunk carries its FULL aligned span: sectors the epoch
 *     doesn't have are read from the wrapped disk at sweep time (RAM
 *     is authoritative and current, so this is safe), which keeps
 *     chunk records self-contained. The tail chunk is short when the
 *     disk size isn't a chunk multiple.
 *   - **Ack/nack**: exactly one epoch may be in flight. `ackSweep`
 *     drops it; `nackSweep` (IDB failure, ack timeout) merges it back
 *     over the current hot map — the hot map's entries win, they are
 *     newer — so a later sweep retries with nothing lost.
 *
 * Epoch ids are supplied by the caller (the worker host owns a
 * monotonic counter that survives machine teardown), so a late ack
 * from before a reset can never be mistaken for the current epoch's.
 *
 * This engine is pure synchronous TypeScript with no host coupling —
 * the worker host decides WHEN to sweep (throttle, forced threshold,
 * flush, reset) and where the chunks go (the overlay-sweep protocol
 * message).
 */

import { SECTOR_SIZE, type Disk, type DiskGeometry } from './disk.js';

/**
 * Aligned chunk span for sweep coalescing — THE tunable constant
 * (§4.2 decision: 32 KB / 64 sectors; retune later from the stats
 * heartbeat's telemetry, not from taste).
 */
export const OVERLAY_CHUNK_BYTES = 32 * 1024;

/**
 * Forced-sweep threshold (§4.2 decision: 4 MB). The worker host posts
 * a sweep past the 5 s throttle once the hot map holds this many
 * bytes — a guest dd'ing the whole disk must not balloon the map.
 */
export const FORCED_SWEEP_BYTES = 4 * 1024 * 1024;

/**
 * One coalesced chunk of an overlay epoch. `bytes` covers the full
 * aligned span starting at sector `chunkIndex * (chunkBytes / 512)`,
 * freshly allocated per sweep — safe to transfer across postMessage.
 */
export interface OverlayChunk {
  chunkIndex: number;
  bytes: Uint8Array;
}

export interface OverlayDiskOptions {
  /**
   * Chunk span override for tests. Must be a positive multiple of
   * {@link SECTOR_SIZE}. Production uses {@link OVERLAY_CHUNK_BYTES}.
   */
  chunkBytes?: number;
}

/** The chunk set a boot folds — matches BootConfig's overlay carriage. */
export interface OverlayFoldInput {
  chunks: readonly OverlayChunk[];
  /** The aligned span the chunks were swept under (self-describing —
   *  fold must not assume the CURRENT constant, which may retune). */
  chunkSizeBytes: number;
}

/**
 * Fold swept chunks over a base image (Phase 17 M2): returns a
 * full-disk-size buffer — base bytes zero-padded to `diskSizeBytes`,
 * then each chunk written at its aligned offset. Chunks are byte
 * spans, not sector maps, so later stamps (bootopts patch) apply on
 * the RESULT — the order is base → overlay → stamps (brief §1.4).
 * Throws on a chunk outside the disk: the caller verified the base
 * fingerprint, so an out-of-range chunk is a corrupt store, not a
 * mismatch to tolerate.
 */
export function foldOverlay(
  base: Uint8Array,
  diskSizeBytes: number,
  overlay: OverlayFoldInput,
): Uint8Array {
  if (base.length > diskSizeBytes) {
    throw new Error(
      `foldOverlay: base image (${base.length} B) exceeds disk size (${diskSizeBytes} B)`,
    );
  }
  const out = new Uint8Array(diskSizeBytes);
  out.set(base, 0);
  for (const chunk of overlay.chunks) {
    const offset = chunk.chunkIndex * overlay.chunkSizeBytes;
    if (offset < 0 || offset + chunk.bytes.length > diskSizeBytes) {
      throw new Error(
        `foldOverlay: chunk ${chunk.chunkIndex} (${chunk.bytes.length} B at ${offset}) ` +
          `outside disk (${diskSizeBytes} B)`,
      );
    }
    out.set(chunk.bytes, offset);
  }
  return out;
}

/**
 * SHA-256 of `bytes` as lowercase hex — the overlay identity
 * fingerprint (brief §1.3: overlay validity is keyed to the EXACT
 * base). `crypto.subtle` is native in workers, browsers, and Node —
 * no new deps (hard rule 2). ~tens of ms over a 32 MB image, once
 * per boot, pre-run.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle wants a view over a plain ArrayBuffer; TS 5.7+ types
  // Uint8Array generically over ArrayBufferLike. The copy keeps this
  // correct for ANY view (offset, shared backing) without type
  // gymnastics — one extra pass over the bytes, boot-time only.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += (view[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Disk decorator + overlay epoch state machine. Wraps the primary
 * disk transparently — the machine and BIOS see only {@link Disk}.
 */
export class OverlayDisk implements Disk {
  readonly #inner: Disk;
  readonly #chunkBytes: number;
  readonly #sectorsPerChunk: number;

  /** Hot map — writes since the last sweep began. Bytes are copies. */
  #hot = new Map<number, Uint8Array>();
  /** The one in-flight epoch, between beginSweep and ack/nack. */
  #pending: { epochId: number; sectors: Map<number, Uint8Array> } | null = null;

  constructor(inner: Disk, opts: OverlayDiskOptions = {}) {
    const chunkBytes = opts.chunkBytes ?? OVERLAY_CHUNK_BYTES;
    if (chunkBytes <= 0 || chunkBytes % SECTOR_SIZE !== 0) {
      throw new Error(
        `OverlayDisk: chunkBytes must be a positive multiple of ${SECTOR_SIZE} (got ${chunkBytes})`,
      );
    }
    this.#inner = inner;
    this.#chunkBytes = chunkBytes;
    this.#sectorsPerChunk = chunkBytes / SECTOR_SIZE;
  }

  get geometry(): DiskGeometry {
    return this.#inner.geometry;
  }

  get readonly(): boolean {
    return this.#inner.readonly;
  }

  get sectorCount(): number {
    return this.#inner.sectorCount;
  }

  /** The aligned chunk span sweeps coalesce into. */
  get chunkBytes(): number {
    return this.#chunkBytes;
  }

  /** Distinct sectors in the hot map (excludes any in-flight epoch). */
  get hotSectorCount(): number {
    return this.#hot.size;
  }

  /** Hot-map payload size — what the forced-sweep threshold watches. */
  get hotByteCount(): number {
    return this.#hot.size * SECTOR_SIZE;
  }

  /** True while an epoch awaits its ack/nack. */
  get sweepPending(): boolean {
    return this.#pending !== null;
  }

  /** The in-flight epoch's id, or null when none is pending. */
  get pendingEpochId(): number | null {
    return this.#pending?.epochId ?? null;
  }

  readSector(lba: number): Uint8Array {
    // Runtime reads live entirely in RAM (hard rule 1) — the hot map
    // is a write-side artifact and never consulted here.
    return this.#inner.readSector(lba);
  }

  writeSector(lba: number, data: Uint8Array): void {
    // Inner write first: its range/size/readonly validation gates the
    // capture, so a rejected write never pollutes the hot map.
    this.#inner.writeSector(lba, data);
    const copy = new Uint8Array(SECTOR_SIZE);
    copy.set(data);
    this.#hot.set(lba, copy);
  }

  /**
   * Swap epochs and coalesce the outgoing hot map into aligned chunks.
   * Returns null when there is nothing to sweep or an epoch is already
   * in flight — callers treat null as "not now".
   */
  beginSweep(epochId: number): OverlayChunk[] | null {
    if (this.#pending !== null || this.#hot.size === 0) return null;
    const sectors = this.#hot;
    this.#hot = new Map();
    this.#pending = { epochId, sectors };

    const chunkIndexes = new Set<number>();
    for (const lba of sectors.keys()) {
      chunkIndexes.add(Math.floor(lba / this.#sectorsPerChunk));
    }

    const chunks: OverlayChunk[] = [];
    for (const chunkIndex of [...chunkIndexes].sort((a, b) => a - b)) {
      const firstLba = chunkIndex * this.#sectorsPerChunk;
      const lastLba = Math.min(firstLba + this.#sectorsPerChunk, this.sectorCount);
      const bytes = new Uint8Array((lastLba - firstLba) * SECTOR_SIZE);
      for (let lba = firstLba; lba < lastLba; lba++) {
        // Epoch bytes where the epoch has them (exact point-in-time),
        // RAM fill-in for the rest of the span.
        const sector = sectors.get(lba) ?? this.#inner.readSector(lba);
        bytes.set(sector, (lba - firstLba) * SECTOR_SIZE);
      }
      chunks.push({ chunkIndex, bytes });
    }
    return chunks;
  }

  /** The epoch persisted — drop it. Stale/unknown ids are ignored. */
  ackSweep(epochId: number): void {
    if (this.#pending?.epochId === epochId) this.#pending = null;
  }

  /**
   * The epoch failed to persist (nack or ack timeout) — merge it back
   * over the hot map. Hot-map entries win: they are newer than the
   * epoch's. Stale/unknown ids are ignored.
   */
  nackSweep(epochId: number): void {
    if (this.#pending?.epochId !== epochId) return;
    const { sectors } = this.#pending;
    this.#pending = null;
    for (const [lba, bytes] of sectors) {
      if (!this.#hot.has(lba)) this.#hot.set(lba, bytes);
    }
  }
}
