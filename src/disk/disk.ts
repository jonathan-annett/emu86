import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';

/**
 * Sector size for all disks in this module. 512 bytes is the universal
 * default for floppies and traditional HDs; the BIOS INT 13h interface
 * speaks 512-byte sectors. If we ever care about 4 KiB sectors or
 * 2048-byte CD-ROM blocks, that's a future brief.
 */
export const SECTOR_SIZE = 512;

export interface DiskGeometry {
  cylinders: number;
  heads: number;
  sectorsPerTrack: number;
}

/**
 * Block-addressed disk interface. Reads and writes are 512-byte sectors,
 * indexed by linear block address (LBA). CHS↔LBA translation is the
 * Phase 2 BIOS service handler's job — the disk itself doesn't need to
 * care, and pushing the geometry math up keeps the disk simple.
 *
 * Implementations:
 *   - {@link InMemoryDisk} — backed by a single Uint8Array for tests.
 *   - {@link NodeFileDisk} — backed by a host file via Node's sync `fs` API.
 *
 * Reads and writes are synchronous because they happen inside `cpu.step()`,
 * which is itself synchronous by design. The Node implementation accepts
 * the cost of a sync `fs.readSync` for now (mitigated by an in-memory
 * cache; see {@link NodeFileDisk}).
 */
export interface Disk {
  readonly geometry: DiskGeometry;
  readonly readonly: boolean;
  /** Total sectors = cylinders × heads × sectorsPerTrack. */
  readonly sectorCount: number;

  /** Read a 512-byte sector. Throws on out-of-range LBA. */
  readSector(lba: number): Uint8Array;

  /** Write a 512-byte sector. Throws on read-only or out-of-range LBA. */
  writeSector(lba: number, data: Uint8Array): void;
}

function totalSectors(g: DiskGeometry): number {
  return g.cylinders * g.heads * g.sectorsPerTrack;
}

function validateGeometry(g: DiskGeometry): void {
  if (
    !Number.isInteger(g.cylinders) || g.cylinders <= 0 ||
    !Number.isInteger(g.heads) || g.heads <= 0 ||
    !Number.isInteger(g.sectorsPerTrack) || g.sectorsPerTrack <= 0
  ) {
    throw new Error(
      `Disk: invalid geometry C=${g.cylinders} H=${g.heads} S=${g.sectorsPerTrack}`,
    );
  }
}

/**
 * Standard floppy geometries we recognise when inferring from file size.
 * The BIOS expects exactly these sizes for the corresponding format codes;
 * unknown sizes require an explicit geometry from the caller.
 */
const STANDARD_GEOMETRIES: readonly DiskGeometry[] = [
  { cylinders: 40, heads: 1, sectorsPerTrack: 8 },     // 160 KB 5.25" SS
  { cylinders: 40, heads: 1, sectorsPerTrack: 9 },     // 180 KB
  { cylinders: 40, heads: 2, sectorsPerTrack: 8 },     // 320 KB
  { cylinders: 40, heads: 2, sectorsPerTrack: 9 },     // 360 KB
  { cylinders: 80, heads: 2, sectorsPerTrack: 9 },     // 720 KB 3.5" / 5.25" 80-track
  { cylinders: 80, heads: 2, sectorsPerTrack: 15 },    // 1.2 MB 5.25" HD
  { cylinders: 80, heads: 2, sectorsPerTrack: 18 },    // 1.44 MB 3.5" HD
  { cylinders: 80, heads: 2, sectorsPerTrack: 36 },    // 2.88 MB 3.5" ED
];

function inferStandardGeometry(byteSize: number): DiskGeometry | null {
  for (const g of STANDARD_GEOMETRIES) {
    if (totalSectors(g) * SECTOR_SIZE === byteSize) return g;
  }
  return null;
}

// ============================================================
// InMemoryDisk
// ============================================================

export interface InMemoryDiskOptions {
  geometry: DiskGeometry;
  readonly?: boolean;
  /**
   * Initial contents. If shorter than the disk size, the remainder is
   * zero-filled (matches "freshly formatted disk that has some data on it").
   * If longer, throws — that's a real bug.
   */
  contents?: Uint8Array;
}

export class InMemoryDisk implements Disk {
  readonly geometry: DiskGeometry;
  readonly readonly: boolean;
  readonly sectorCount: number;

  // The whole disk lives as a single Uint8Array. Byte n of sector L is at
  // index L*SECTOR_SIZE + n. Allocating the full size up-front is cheap
  // (1.44 MB for a floppy) and avoids any sparse/fault complexity.
  readonly #data: Uint8Array;

  constructor(opts: InMemoryDiskOptions) {
    validateGeometry(opts.geometry);
    this.geometry = opts.geometry;
    this.readonly = opts.readonly ?? false;
    this.sectorCount = totalSectors(opts.geometry);
    const bytes = this.sectorCount * SECTOR_SIZE;
    this.#data = new Uint8Array(bytes);
    if (opts.contents) {
      if (opts.contents.length > bytes) {
        throw new Error(
          `InMemoryDisk: initial contents (${opts.contents.length} B) exceed disk size (${bytes} B)`,
        );
      }
      this.#data.set(opts.contents, 0);
      // Remaining bytes are already zero from Uint8Array initialisation.
    }
  }

  readSector(lba: number): Uint8Array {
    this.#checkLba(lba);
    // Return a fresh copy — callers shouldn't be able to mutate our backing
    // store by retaining the returned array.
    const out = new Uint8Array(SECTOR_SIZE);
    out.set(this.#data.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE));
    return out;
  }

  writeSector(lba: number, data: Uint8Array): void {
    if (this.readonly) {
      throw new Error('InMemoryDisk: write to read-only disk');
    }
    this.#checkLba(lba);
    if (data.length !== SECTOR_SIZE) {
      throw new Error(
        `InMemoryDisk: writeSector data must be ${SECTOR_SIZE} bytes (got ${data.length})`,
      );
    }
    this.#data.set(data, lba * SECTOR_SIZE);
  }

  #checkLba(lba: number): void {
    if (!Number.isInteger(lba) || lba < 0 || lba >= this.sectorCount) {
      throw new Error(
        `InMemoryDisk: LBA ${lba} out of range (sectorCount=${this.sectorCount})`,
      );
    }
  }
}

// ============================================================
// NodeFileDisk
// ============================================================

export interface NodeFileDiskOptions {
  path: string;
  /**
   * If absent, infer geometry from file size against {@link STANDARD_GEOMETRIES}.
   * For non-standard sizes (HDs, custom images) the caller must supply this.
   */
  geometry?: DiskGeometry;
  /** Default false. When true, the file is opened read-only. */
  readonly?: boolean;
}

/**
 * Disk backed by a host file.
 *
 * Strategy: load the entire file into a Uint8Array at construction time
 * ("in-memory cache"). Reads serve from the cache. Writes update the cache
 * AND write through to the file via `fs.writeSync` so the on-disk image
 * stays consistent with the cache after each sector write.
 *
 * Why load it all up front:
 *   - Floppies (1.44 MB) and small HDs are tiny by modern standards.
 *   - We avoid one `fs.readSync` per sector inside `cpu.step()`, which
 *     would block the Node event loop for the duration of the seek/read.
 *   - The cache makes test assertions trivial: write a sector, read it
 *     back, no race against the OS page cache.
 *
 * If we ever need to handle multi-GB disks, this strategy revisits.
 */
export class NodeFileDisk implements Disk {
  readonly geometry: DiskGeometry;
  readonly readonly: boolean;
  readonly sectorCount: number;
  readonly path: string;

  #fd: number | null;
  readonly #cache: Uint8Array;
  #closed = false;

  constructor(opts: NodeFileDiskOptions) {
    this.path = opts.path;
    this.readonly = opts.readonly ?? false;

    // Open the file. 'r' for read-only, 'r+' for read-write (we don't want
    // to truncate on open — the image already has its content).
    const flags = this.readonly ? 'r' : 'r+';
    this.#fd = openSync(opts.path, flags);

    let bytes: number;
    try {
      bytes = fstatSync(this.#fd).size;
    } catch (err) {
      closeSync(this.#fd);
      this.#fd = null;
      throw err;
    }

    let geometry = opts.geometry;
    if (!geometry) {
      const inferred = inferStandardGeometry(bytes);
      if (!inferred) {
        closeSync(this.#fd);
        this.#fd = null;
        throw new Error(
          `NodeFileDisk: file size ${bytes} bytes does not match any standard floppy geometry; pass an explicit geometry`,
        );
      }
      geometry = inferred;
    } else {
      validateGeometry(geometry);
      const expected = totalSectors(geometry) * SECTOR_SIZE;
      if (expected !== bytes) {
        closeSync(this.#fd);
        this.#fd = null;
        throw new Error(
          `NodeFileDisk: explicit geometry expects ${expected} bytes, file has ${bytes} bytes`,
        );
      }
    }

    this.geometry = geometry;
    this.sectorCount = totalSectors(geometry);

    // Slurp the whole file. readSync may return fewer bytes than requested
    // for short reads — loop until we have it all.
    this.#cache = new Uint8Array(bytes);
    let offset = 0;
    while (offset < bytes) {
      const n = readSync(this.#fd, this.#cache, offset, bytes - offset, offset);
      if (n === 0) break;   // EOF reached early; trust whatever we got
      offset += n;
    }
    if (offset !== bytes) {
      closeSync(this.#fd);
      this.#fd = null;
      throw new Error(
        `NodeFileDisk: short read on initial slurp (got ${offset} of ${bytes})`,
      );
    }
  }

  /**
   * Close the underlying file descriptor. Reads and writes after close()
   * throw. Idempotent.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }

  readSector(lba: number): Uint8Array {
    this.#assertOpen();
    this.#checkLba(lba);
    const out = new Uint8Array(SECTOR_SIZE);
    out.set(this.#cache.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE));
    return out;
  }

  writeSector(lba: number, data: Uint8Array): void {
    this.#assertOpen();
    if (this.readonly) {
      throw new Error('NodeFileDisk: write to read-only disk');
    }
    this.#checkLba(lba);
    if (data.length !== SECTOR_SIZE) {
      throw new Error(
        `NodeFileDisk: writeSector data must be ${SECTOR_SIZE} bytes (got ${data.length})`,
      );
    }
    const offset = lba * SECTOR_SIZE;
    // Cache first, then write through. If the writeSync fails we throw —
    // the cache is already updated, but the next close()/reopen will see
    // the on-disk version (so the inconsistency is bounded to this run).
    this.#cache.set(data, offset);
    if (this.#fd === null) {
      throw new Error('NodeFileDisk: file descriptor is null');
    }
    let written = 0;
    while (written < SECTOR_SIZE) {
      const n = writeSync(
        this.#fd,
        this.#cache,
        offset + written,
        SECTOR_SIZE - written,
        offset + written,
      );
      if (n === 0) break;
      written += n;
    }
    if (written !== SECTOR_SIZE) {
      throw new Error(`NodeFileDisk: short write (${written} of ${SECTOR_SIZE})`);
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#fd === null) {
      throw new Error('NodeFileDisk: operation on closed disk');
    }
  }

  #checkLba(lba: number): void {
    if (!Number.isInteger(lba) || lba < 0 || lba >= this.sectorCount) {
      throw new Error(
        `NodeFileDisk: LBA ${lba} out of range (sectorCount=${this.sectorCount})`,
      );
    }
  }
}
