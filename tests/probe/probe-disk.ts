/**
 * Probe-disk FAT12 builder (Phase 12).
 *
 * Builds a 1.44 MB FAT12 floppy image that holds a probe script (and
 * optional extra files) at known paths in the root directory. The image
 * is read-only data for the running ELKS userland — `mount /dev/fd1
 * /mnt && cat /mnt/probe.sh` returns exactly the bytes we wrote.
 *
 * # Why pure TypeScript
 *
 * The Termux environment doesn't ship `mtools` / `mkfs.fat`, so we can't
 * shell out at build time. The brief's Section 1 / 5 fallback ranking
 * was: "FAT12 with mtools (cleanest), or pure-TypeScript FAT12 writer
 * (a 200-line spec, very tractable)". With no mtools available we take
 * the pure-TS path — and it's stable enough that we don't need a
 * template + edit dance.
 *
 * # Why 1.44 MB rather than 360 KB
 *
 * The brief said "smaller is fine" because the probe disk doesn't need
 * to be bootable. But the existing emu86 secondary-disk plumbing
 * (Phase 11) and the kernel's BIOS-driver geometry probing all flow
 * through `inferFromSize` and known-floppy geometries
 * (1.44 MB / 1.2 MB). Sticking to 1.44 MB means:
 *
 *   - Existing ELKS floppy-driver geometry handling treats `/dev/fd1`
 *     as a stock 1.44 MB disk — no risk of an exotic geometry tripping
 *     a code path that hasn't been exercised before.
 *   - The image still costs only 1.44 MB of test memory per probe; the
 *     bytes are cheap and probes are sequential.
 *   - The FAT12 BPB values for 1.44 MB are textbook (BPB at MS-DOS 5.0+
 *     reference values), making the bytes easy to reason about and
 *     verify against any FAT12 reference.
 *
 * If a future probe wants a smaller (or larger) disk for a specific
 * reason, the builder can grow a `size` option; v0 doesn't need it.
 *
 * # FAT12 layout (1.44 MB stock)
 *
 * | Region          | Sectors | Notes                                |
 * |-----------------|---------|--------------------------------------|
 * | Boot sector     | 0       | BPB + 0x55AA at 510-511              |
 * | FAT 1           | 1-9     | 9 sectors                            |
 * | FAT 2           | 10-18   | 9 sectors (mirror of FAT 1)          |
 * | Root directory  | 19-32   | 14 sectors × 16 entries = 224 slots  |
 * | Data area       | 33-2879 | Cluster N starts at sector 33+(N-2)  |
 *
 * Cluster size = 1 sector = 512 bytes. So each file uses exactly
 * `ceil(size / 512)` clusters, chained through FAT entries.
 *
 * The on-disk byte order for everything multi-byte is little-endian.
 *
 * # Validation against the ELKS msdos driver
 *
 * `reference/elks/elks/fs/msdos/inode.c:152-205` reads the BPB and
 * computes `clusters = data_sectors / cluster_size`. It rejects the
 * image if any of:
 *
 *   - `sb->fats == 0`               → we set `fats = 2`
 *   - `(dir_entries & (DPS-1))`     → we set `dir_entries = 224`,
 *                                       DPS=16 for 512-byte sectors;
 *                                       224 % 16 = 0 ✓
 *   - `cluster_size == 0`           → we set `cluster_size = 1`
 *
 * So the kernel will accept our image and read files from it. Auto-
 * detect via `mount /dev/fd1 /mnt` (no `-t`) sets `MS_AUTOMOUNT`, which
 * tries MINIX first, fails (no MINIX magic), then tries FAT — see
 * `elkscmd/sys_utils/mount.c:128-135`.
 */

import type { DiskGeometry } from '../../src/disk/disk.js';

const SECTOR_SIZE = 512;

/** 1.44 MB floppy geometry. Matches `fd1440-*.img` images. */
export const FD1440_GEOMETRY: DiskGeometry = {
  cylinders: 80,
  heads: 2,
  sectorsPerTrack: 18,
};

const TOTAL_SECTORS = 2880;
const RESERVED_SECTORS = 1;
const NUM_FATS = 2;
const SECTORS_PER_FAT = 9;
const ROOT_DIR_ENTRIES = 224;
const ROOT_DIR_SECTORS = (ROOT_DIR_ENTRIES * 32) / SECTOR_SIZE; // 14
const DATA_START_SECTOR =
  RESERVED_SECTORS + NUM_FATS * SECTORS_PER_FAT + ROOT_DIR_SECTORS; // 33
const DATA_SECTORS = TOTAL_SECTORS - DATA_START_SECTOR; // 2847
const SECTORS_PER_CLUSTER = 1;
const TOTAL_CLUSTERS = Math.floor(DATA_SECTORS / SECTORS_PER_CLUSTER); // 2847
const MEDIA_DESCRIPTOR = 0xf0;
const DIR_ENTRY_SIZE = 32;

export interface ProbeDiskFile {
  /** 8.3-style filename, e.g. `probe.sh`. Case is folded to upper. */
  readonly name: string;
  /** File body. Strings are encoded as ASCII (LF line endings preserved). */
  readonly content: string | Uint8Array;
}

export interface ProbeDiskBuildResult {
  readonly bytes: Uint8Array;
  readonly geometry: DiskGeometry;
  /** Convenience: cluster index where each input file's data starts. */
  readonly fileOffsets: ReadonlyArray<{ name: string; cluster: number; size: number }>;
}

/**
 * Build a FAT12 floppy image containing the listed files.
 *
 * Files are laid out in the root directory in the order given; their
 * data clusters are allocated sequentially starting at cluster 2. The
 * image's bytes are byte-for-byte deterministic given the same input,
 * which makes diffing builds and reasoning about offsets easy.
 *
 * Constraints:
 *   - `files.length` ≤ {@link ROOT_DIR_ENTRIES} (224).
 *   - Total file content ≤ {@link DATA_SECTORS} × 512 bytes (~1.43 MB).
 *   - Each filename must fit in 8.3 form (≤ 8 chars before `.`,
 *     ≤ 3 after; one optional `.`).
 *
 * Throws on any constraint violation rather than silently truncating.
 */
export function buildProbeDisk(files: readonly ProbeDiskFile[]): ProbeDiskBuildResult {
  if (files.length === 0) {
    throw new Error('buildProbeDisk: at least one file is required');
  }
  if (files.length > ROOT_DIR_ENTRIES) {
    throw new Error(
      `buildProbeDisk: too many files (${files.length} > ${ROOT_DIR_ENTRIES})`,
    );
  }

  // Encode each file's body once, eagerly, so we can size + checksum
  // before laying down any bytes.
  const encoded = files.map((f) => ({
    nameRaw: f.name,
    nameParts: parse83Name(f.name),
    body: typeof f.content === 'string' ? asciiEncode(f.content) : f.content,
  }));

  // Total clusters needed = sum of ceil(size/512), with a minimum of 1
  // for empty files (FAT files with size 0 take no cluster, but to keep
  // the cluster bookkeeping uniform we treat empty files as 0 clusters
  // with no chain entry; their dir entry's startCluster is 0).
  let nextCluster = 2; // FAT12 reserves 0 (media) and 1 (eoc marker).
  const fileLayout: { cluster: number; size: number; clusters: number }[] = [];
  for (const e of encoded) {
    const size = e.body.length;
    const clusters = size === 0 ? 0 : Math.ceil(size / SECTOR_SIZE);
    if (nextCluster + clusters - 1 > TOTAL_CLUSTERS + 1) {
      throw new Error(
        `buildProbeDisk: not enough data sectors for file '${e.nameRaw}' ` +
          `(needs ${clusters} more clusters; only ${TOTAL_CLUSTERS - (nextCluster - 2)} free)`,
      );
    }
    fileLayout.push({ cluster: clusters === 0 ? 0 : nextCluster, size, clusters });
    nextCluster += clusters;
  }

  // ---- allocate the image ------------------------------------------------
  const image = new Uint8Array(TOTAL_SECTORS * SECTOR_SIZE);

  // ---- boot sector (BPB) -------------------------------------------------
  writeBootSector(image);

  // ---- FAT(s) ------------------------------------------------------------
  const fat = new Uint8Array(SECTORS_PER_FAT * SECTOR_SIZE);
  // FAT[0] = 0xFF0 (low byte = media descriptor). FAT[1] = 0xFFF (eoc).
  setFat12(fat, 0, 0xff0);
  setFat12(fat, 1, 0xfff);
  for (let f = 0; f < fileLayout.length; f++) {
    const lay = fileLayout[f];
    if (lay === undefined || lay.clusters === 0) continue;
    for (let i = 0; i < lay.clusters; i++) {
      const cur = lay.cluster + i;
      const next = i === lay.clusters - 1 ? 0xfff : cur + 1;
      setFat12(fat, cur, next);
    }
  }
  // Write FAT 1 and FAT 2 (mirror).
  image.set(fat, RESERVED_SECTORS * SECTOR_SIZE);
  image.set(fat, (RESERVED_SECTORS + SECTORS_PER_FAT) * SECTOR_SIZE);

  // ---- root directory ----------------------------------------------------
  const rootDir = new Uint8Array(ROOT_DIR_SECTORS * SECTOR_SIZE);
  for (let f = 0; f < encoded.length; f++) {
    const e = encoded[f];
    const lay = fileLayout[f];
    if (e === undefined || lay === undefined) continue;
    writeDirEntry(rootDir, f * DIR_ENTRY_SIZE, e.nameParts, lay.cluster, lay.size);
  }
  image.set(
    rootDir,
    (RESERVED_SECTORS + NUM_FATS * SECTORS_PER_FAT) * SECTOR_SIZE,
  );

  // ---- data area ---------------------------------------------------------
  for (let f = 0; f < encoded.length; f++) {
    const e = encoded[f];
    const lay = fileLayout[f];
    if (e === undefined || lay === undefined || lay.clusters === 0) continue;
    const dataOffset =
      (DATA_START_SECTOR + (lay.cluster - 2) * SECTORS_PER_CLUSTER) * SECTOR_SIZE;
    image.set(e.body, dataOffset);
    // Trailing cluster bytes after EOF stay 0x00 — same as a freshly
    // formatted disk.
  }

  const fileOffsets = fileLayout.map((lay, i) => ({
    name: files[i]?.name ?? '',
    cluster: lay.cluster,
    size: lay.size,
  }));

  return { bytes: image, geometry: FD1440_GEOMETRY, fileOffsets };
}

/**
 * Parse an 8.3 filename (e.g. `probe.sh`) into the FAT directory entry's
 * fixed 8-byte name and 3-byte extension fields, both space-padded and
 * uppercased. Throws on malformed inputs.
 */
function parse83Name(name: string): { name: Uint8Array; ext: Uint8Array } {
  const upper = name.toUpperCase();
  // Allowed chars: A-Z 0-9 and a small set of punctuation. We're not
  // policing every detail — ELKS's FAT driver tolerates wider sets — but
  // we block obviously-illegal chars (path separators, NUL).
  if (/[\x00-\x1f\x7f\/\\:]/.test(upper)) {
    throw new Error(`Invalid character in filename '${name}'`);
  }
  const parts = upper.split('.');
  if (parts.length > 2) {
    throw new Error(`Filename '${name}' has more than one '.'`);
  }
  const stem = parts[0] ?? '';
  const ext = parts[1] ?? '';
  if (stem.length === 0 || stem.length > 8) {
    throw new Error(`Filename stem '${stem}' must be 1-8 chars (got ${stem.length})`);
  }
  if (ext.length > 3) {
    throw new Error(`Filename ext '${ext}' must be 0-3 chars (got ${ext.length})`);
  }
  const nameBuf = new Uint8Array(8);
  nameBuf.fill(0x20); // ASCII space
  for (let i = 0; i < stem.length; i++) nameBuf[i] = stem.charCodeAt(i);
  const extBuf = new Uint8Array(3);
  extBuf.fill(0x20);
  for (let i = 0; i < ext.length; i++) extBuf[i] = ext.charCodeAt(i);
  return { name: nameBuf, ext: extBuf };
}

function writeDirEntry(
  buf: Uint8Array,
  offset: number,
  nameParts: { name: Uint8Array; ext: Uint8Array },
  startCluster: number,
  fileSize: number,
): void {
  // Bytes 0-7: name; 8-10: ext.
  buf.set(nameParts.name, offset);
  buf.set(nameParts.ext, offset + 8);
  // Byte 11: attributes. 0x20 = ARCHIVE (matches a freshly created file).
  buf[offset + 11] = 0x20;
  // Bytes 12-21: NT reserved + create-time-tenths + create-time + create-
  // date + last-access-date. Zero is fine; ELKS doesn't read these.
  // Bytes 22-23: write time. Bytes 24-25: write date. We use a fixed
  // sentinel date to keep builds reproducible. 2026-01-01 00:00:00:
  //   date = ((2026-1980)<<9) | (1<<5) | 1 = (46<<9) | 32 | 1 = 0x5C21
  //   time = 0
  writeU16LE(buf, offset + 22, 0x0000); // write time
  writeU16LE(buf, offset + 24, 0x5c21); // write date 2026-01-01
  // Bytes 26-27: starting cluster (FAT12 only uses low 16 bits).
  writeU16LE(buf, offset + 26, startCluster & 0xffff);
  // Bytes 28-31: file size in bytes.
  writeU32LE(buf, offset + 28, fileSize >>> 0);
}

/**
 * Write a 12-bit FAT entry. Entries are packed: pair (i, i+1) live in
 * 3 bytes; the LSB of the byte triple is the low 8 bits of entry i, the
 * middle byte's low nibble is the high 4 bits of entry i and the high
 * nibble is the low 4 bits of entry i+1, the MSB is the high 8 bits of
 * entry i+1.
 */
function setFat12(fat: Uint8Array, index: number, value: number): void {
  const off = Math.floor((index * 3) / 2);
  if (index % 2 === 0) {
    // Even: low byte then low nibble of next.
    fat[off] = value & 0xff;
    const hi = fat[off + 1] ?? 0;
    fat[off + 1] = (hi & 0xf0) | ((value >> 8) & 0x0f);
  } else {
    // Odd: high nibble of prev byte holds low nibble; next byte holds high 8.
    const lo = fat[off] ?? 0;
    fat[off] = (lo & 0x0f) | ((value & 0x0f) << 4);
    fat[off + 1] = (value >> 4) & 0xff;
  }
}

/**
 * Read back a 12-bit FAT entry — exposed for tests to verify the writer's
 * output without needing a separate FAT12 reader. Same encoding as
 * {@link setFat12}.
 */
export function getFat12(fat: Uint8Array, index: number): number {
  const off = Math.floor((index * 3) / 2);
  const a = fat[off] ?? 0;
  const b = fat[off + 1] ?? 0;
  if (index % 2 === 0) {
    return a | ((b & 0x0f) << 8);
  }
  return ((a & 0xf0) >> 4) | (b << 4);
}

function writeBootSector(image: Uint8Array): void {
  // Jump instruction (3 bytes) — typical FAT BPB starts with `EB 3C 90`.
  image[0] = 0xeb;
  image[1] = 0x3c;
  image[2] = 0x90;
  // OEM name (8 bytes) — `EMU86PRB` (probe-disk identifier).
  const oem = 'EMU86PRB';
  for (let i = 0; i < 8; i++) image[3 + i] = oem.charCodeAt(i);
  // BPB at offset 11.
  writeU16LE(image, 11, SECTOR_SIZE); // bytes/sector
  image[13] = SECTORS_PER_CLUSTER; // sectors/cluster
  writeU16LE(image, 14, RESERVED_SECTORS); // reserved sectors
  image[16] = NUM_FATS; // number of FATs
  writeU16LE(image, 17, ROOT_DIR_ENTRIES); // root entries
  writeU16LE(image, 19, TOTAL_SECTORS); // total sectors (16-bit)
  image[21] = MEDIA_DESCRIPTOR; // media descriptor
  writeU16LE(image, 22, SECTORS_PER_FAT); // sectors/FAT
  writeU16LE(image, 24, FD1440_GEOMETRY.sectorsPerTrack); // sectors/track
  writeU16LE(image, 26, FD1440_GEOMETRY.heads); // heads
  writeU32LE(image, 28, 0); // hidden sectors
  writeU32LE(image, 32, 0); // total sectors (32-bit, unused — total fits in 16)
  // Extended boot record at offset 36 (DOS 4.0+):
  image[36] = 0x00; // drive number
  image[37] = 0x00; // reserved
  image[38] = 0x29; // extended boot signature
  writeU32LE(image, 39, 0xdeadbeef >>> 0); // volume serial
  // Volume label (11 bytes):
  const label = 'EMU86 PROBE';
  for (let i = 0; i < 11; i++) image[43 + i] = label.charCodeAt(i);
  // FS type (8 bytes):
  const fsType = 'FAT12   ';
  for (let i = 0; i < 8; i++) image[54 + i] = fsType.charCodeAt(i);
  // Boot signature at 510-511.
  image[510] = 0x55;
  image[511] = 0xaa;
}

function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

function asciiEncode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) {
      throw new Error(`Non-ASCII character at index ${i} (0x${c.toString(16)})`);
    }
    out[i] = c;
  }
  return out;
}

/**
 * Read a file's bytes back from a built probe disk. Useful for tests
 * that want to verify round-trip correctness without booting the VM.
 *
 * Returns null if the file isn't found in the root directory. Empty
 * files (size 0) return a zero-length Uint8Array.
 */
export function readProbeDiskFile(image: Uint8Array, filename: string): Uint8Array | null {
  const expected = parse83Name(filename);
  const rootDirOffset =
    (RESERVED_SECTORS + NUM_FATS * SECTORS_PER_FAT) * SECTOR_SIZE;
  for (let i = 0; i < ROOT_DIR_ENTRIES; i++) {
    const entryOff = rootDirOffset + i * DIR_ENTRY_SIZE;
    const first = image[entryOff] ?? 0;
    if (first === 0x00) break; // end of directory
    if (first === 0xe5) continue; // deleted
    let nameMatch = true;
    for (let k = 0; k < 8; k++) {
      if ((image[entryOff + k] ?? 0) !== (expected.name[k] ?? 0)) {
        nameMatch = false;
        break;
      }
    }
    if (!nameMatch) continue;
    let extMatch = true;
    for (let k = 0; k < 3; k++) {
      if ((image[entryOff + 8 + k] ?? 0) !== (expected.ext[k] ?? 0)) {
        extMatch = false;
        break;
      }
    }
    if (!extMatch) continue;
    const startCluster =
      (image[entryOff + 26] ?? 0) | ((image[entryOff + 27] ?? 0) << 8);
    const size =
      (image[entryOff + 28] ?? 0) |
      ((image[entryOff + 29] ?? 0) << 8) |
      ((image[entryOff + 30] ?? 0) << 16) |
      ((image[entryOff + 31] ?? 0) << 24);
    if (size === 0) return new Uint8Array(0);
    // Walk the cluster chain.
    const fatOffset = RESERVED_SECTORS * SECTOR_SIZE;
    const fat = image.subarray(fatOffset, fatOffset + SECTORS_PER_FAT * SECTOR_SIZE);
    const out = new Uint8Array(size);
    let written = 0;
    let cluster = startCluster;
    let safety = 0;
    while (cluster >= 2 && cluster < 0xff8 && written < size) {
      if (++safety > TOTAL_CLUSTERS + 2) {
        throw new Error(`FAT chain runaway reading ${filename}`);
      }
      const sector = DATA_START_SECTOR + (cluster - 2) * SECTORS_PER_CLUSTER;
      const dataOff = sector * SECTOR_SIZE;
      const remaining = size - written;
      const copyBytes = Math.min(SECTOR_SIZE * SECTORS_PER_CLUSTER, remaining);
      out.set(image.subarray(dataOff, dataOff + copyBytes), written);
      written += copyBytes;
      cluster = getFat12(fat, cluster);
    }
    return out;
  }
  return null;
}
