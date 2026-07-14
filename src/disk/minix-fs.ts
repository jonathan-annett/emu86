/**
 * MINIX v1 filesystem — read (Phase 16 M1) and whole-file write
 * (Phase 16 M2): the editor seam's enabling piece.
 *
 * WRITE MODEL (M2): `writeFile` (create or whole-file replace),
 * `remove` (files only), `mkdir`. Whole-file semantics only — no
 * partial writes, no append (brief §3 M2). Writes MUTATE the buffer
 * passed to `openMinixImage` — the caller owns the bytes and hands
 * the whole image back to the worker (`write-secondary`, M3), so
 * in-place mutation is exactly the contract. Allocation follows the
 * mfs reference: first-free-bit bitmap scans, zones allocated on
 * demand including the indirect table, all-zero blocks stored as
 * HOLES (writer.c writefile() does the same). The write path refuses
 * files needing the double-indirect chain (> 7+512 blocks = 531,456
 * bytes) with an honest error — brief §2 allows this; drive-sized
 * sources are not the use case. Truncation (replace-with-smaller)
 * DOES walk double-indirect chains, so replacing a 976 KB file with
 * a line of text frees everything correctly. ELKS `fsck` is the
 * judge (integration test), backed by a TS fsck-lite in the unit
 * suite (bitmaps vs reachable zones, exactly).
 *
 * One deliberate deviation from the reference, recorded: mfs
 * `dname_rem` (iname.c) frees dir block `size/BLOCK_SIZE + 1` when a
 * shrink lands exactly on a block boundary — one block PAST the one
 * the removed entry occupied, leaking the real block (its freezone
 * of the never-allocated next block is a no-op). This module frees
 * `size/BLOCK_SIZE`, the block that actually emptied.
 *
 * Parses the filesystem the ELKS guest's own `mkfs` writes to /dev/hdb
 * (`mkfs /dev/hdb 8086`): MINIX_SUPER_MAGIC 0x137F, 1 KB blocks,
 * 16-byte directory entries (2-byte inode + 14-char name), 32-byte
 * inodes with 7 direct zones + 1 indirect + 1 double-indirect. The
 * MAGIC2 variant (0x138F, 30-char names) parses too — same layout,
 * wider names. MINIX v2 is refused with an honest verdict, as is a
 * non-zero s_log_zone_size (zones ≠ blocks): the authoritative
 * reference this module is written against —
 * `reference/elks/elks/tools/mfs/` (ELKS's host-side mfs tool) —
 * assumes both, and so does every image this project produces.
 *
 * Written from that reference, not internet lore:
 *   - layout/macros:   mfs/minix_fs.h  (NORM_FIRSTZONE, DIRSIZE, …)
 *   - zone resolution: mfs/inode.c     ino_zone() — zone 0 is a HOLE,
 *                      read as zeros (mfs/reader.c readfile())
 *   - dir lookup:      mfs/iname.c     ilookup_name()/cmp_name()
 *   - path walk:       mfs/inode.c     find_inode()
 * Cross-checked against `elks/include/linuxmt/minix_fs.h` and
 * `Documentation/text/minix_fs.txt`.
 *
 * Pure TypeScript, no dependencies, no DOM, no Node APIs — the same
 * bytes parse in the browser panel and in vitest. Nothing here mutates
 * the image; the write path is M2, with ELKS `fsck` as its judge.
 *
 * Errors are VALUES, not throws, wherever the caller can act:
 *   - `openMinixImage` verdicts distinguish "not MINIX at all" (a FAT
 *     floppy, zeros — the panel shows 'unformatted') from "MINIX we
 *     don't do" (v2) from "MINIX but broken" (corrupt).
 *   - path operations return not-found / not-a-directory / not-a-file
 *     / corrupt, each with a human-readable detail.
 * Throws are reserved for caller bugs (they indicate code errors, not
 * data conditions) — and currently nothing throws.
 *
 * The 14-char name limit is real and surfaces here as-is: a lookup for
 * a longer name is honestly not-found. Name mangling is the editor
 * project's problem (brief §2), not this module's.
 */

export const MINIX_BLOCK_SIZE = 1024;
export const MINIX_ROOT_INODE = 1;

const MINIX_SUPER_MAGIC = 0x137f; // v1, 14-char names (what ELKS mkfs writes)
const MINIX_SUPER_MAGIC2 = 0x138f; // v1, 30-char names
const MINIX2_SUPER_MAGIC = 0x2468; // v2 — refused
const MINIX2_SUPER_MAGIC2 = 0x2478; // v2, 30-char names — refused

const INODE_SIZE = 32;
const DIRECT_ZONES = 7;
/** u16 zone pointers per 1 KB indirect block (mfs MINIX_ZONESZ). */
const ZONES_PER_INDIRECT = MINIX_BLOCK_SIZE / 2;

/* i_mode type field, per <sys/stat.h> / linuxmt/stat.h. */
const S_IFMT = 0o170000;
const TYPE_BY_IFMT: ReadonlyMap<number, MinixFileType> = new Map([
  [0o100000, 'file'],
  [0o040000, 'dir'],
  [0o120000, 'symlink'],
  [0o020000, 'chardev'],
  [0o060000, 'blockdev'],
  [0o010000, 'fifo'],
  [0o140000, 'socket'],
]);

export type MinixFileType =
  | 'file'
  | 'dir'
  | 'symlink'
  | 'chardev'
  | 'blockdev'
  | 'fifo'
  | 'socket'
  | 'unknown';

/** Superblock facts, decoded once at open (all fields little-endian). */
export interface MinixSuperblock {
  readonly magic: number;
  /** Directory-entry name capacity: 14 (magic 0x137F) or 30 (0x138F). */
  readonly nameLen: 14 | 30;
  readonly ninodes: number;
  /** Device size in 1 KB blocks (v1 s_nzones). */
  readonly nzones: number;
  readonly imapBlocks: number;
  readonly zmapBlocks: number;
  readonly firstDataZone: number;
  readonly logZoneSize: number;
  readonly maxSizeBytes: number;
  readonly state: number;
}

export interface MinixStat {
  readonly inode: number;
  readonly type: MinixFileType;
  /** Raw i_mode (type bits + permissions). */
  readonly mode: number;
  readonly sizeBytes: number;
  /** i_time — mtime, seconds since the Unix epoch. */
  readonly mtime: number;
  readonly uid: number;
  readonly gid: number;
  readonly nlinks: number;
}

/**
 * One directory entry, as stored — `.` and `..` are included: this
 * module reports the filesystem's truth and leaves filtering policy to
 * the caller (the editor panel hides them; a debugger wants them).
 */
export interface MinixDirEntry {
  readonly name: string;
  readonly stat: MinixStat;
}

export type MinixOpenErrorKind = 'not-minix' | 'unsupported' | 'corrupt';

export type MinixOpenResult =
  | { readonly ok: true; readonly fs: MinixFileSystem }
  | {
      readonly ok: false;
      readonly kind: MinixOpenErrorKind;
      readonly detail: string;
    };

export type MinixPathErrorKind =
  | 'not-found'
  | 'not-a-directory'
  | 'not-a-file'
  | 'corrupt';

export type MinixResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: MinixPathErrorKind;
      readonly detail: string;
    };

export type MinixWriteErrorKind =
  | MinixPathErrorKind
  | 'exists'
  | 'no-space'
  | 'too-large'
  | 'name-too-long';

export type MinixWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: MinixWriteErrorKind;
      readonly detail: string;
    };

/** v1 write cap: 7 direct + 512 indirect blocks. Double-indirect
 *  WRITES are refused (reads are not) — brief §2's honest limit. */
export const MINIX_MAX_WRITE_BYTES = (DIRECT_ZONES + ZONES_PER_INDIRECT) * MINIX_BLOCK_SIZE;

/**
 * Open a MINIX v1 image. The bytes are NOT copied — the caller owns
 * them and must not mutate while reading (in practice: a snapshot the
 * worker just handed over, or a fixture read from disk).
 */
export function openMinixImage(bytes: Uint8Array): MinixOpenResult {
  if (bytes.byteLength < 2 * MINIX_BLOCK_SIZE) {
    return {
      ok: false,
      kind: 'not-minix',
      detail: `image is ${bytes.byteLength} bytes — smaller than boot block + superblock`,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const superOff = MINIX_BLOCK_SIZE; // block 0 is the boot block
  const magic = view.getUint16(superOff + 16, true);

  if (magic === MINIX2_SUPER_MAGIC || magic === MINIX2_SUPER_MAGIC2) {
    return {
      ok: false,
      kind: 'unsupported',
      detail: `MINIX v2 (magic 0x${magic.toString(16)}) — this module reads the v1 fs ELKS mkfs writes`,
    };
  }
  if (magic !== MINIX_SUPER_MAGIC && magic !== MINIX_SUPER_MAGIC2) {
    return {
      ok: false,
      kind: 'not-minix',
      detail: `superblock magic 0x${magic.toString(16).padStart(4, '0')} is not MINIX (want 0x137f)`,
    };
  }

  const sb: MinixSuperblock = {
    magic,
    nameLen: magic === MINIX_SUPER_MAGIC ? 14 : 30,
    ninodes: view.getUint16(superOff + 0, true),
    nzones: view.getUint16(superOff + 2, true),
    imapBlocks: view.getUint16(superOff + 4, true),
    zmapBlocks: view.getUint16(superOff + 6, true),
    firstDataZone: view.getUint16(superOff + 8, true),
    logZoneSize: view.getUint16(superOff + 10, true),
    maxSizeBytes: view.getUint32(superOff + 12, true),
    state: view.getUint16(superOff + 18, true),
  };

  if (sb.logZoneSize !== 0) {
    return {
      ok: false,
      kind: 'unsupported',
      detail: `s_log_zone_size=${sb.logZoneSize} (zones larger than blocks) — the mfs reference and ELKS both assume 0`,
    };
  }
  if (sb.ninodes === 0 || sb.imapBlocks === 0 || sb.zmapBlocks === 0) {
    return {
      ok: false,
      kind: 'corrupt',
      detail: `implausible superblock: ninodes=${sb.ninodes} imap=${sb.imapBlocks} zmap=${sb.zmapBlocks}`,
    };
  }
  if (sb.nzones * MINIX_BLOCK_SIZE > bytes.byteLength) {
    return {
      ok: false,
      kind: 'corrupt',
      detail:
        `superblock claims ${sb.nzones} blocks (${sb.nzones * MINIX_BLOCK_SIZE} bytes) ` +
        `but the image is ${bytes.byteLength} bytes`,
    };
  }
  // Layout: boot(1) + super(1) + imaps + zmaps + inode table + data.
  const inodeBlocks = Math.ceil(sb.ninodes / (MINIX_BLOCK_SIZE / INODE_SIZE));
  const normFirstZone = 2 + sb.imapBlocks + sb.zmapBlocks + inodeBlocks;
  if (sb.firstDataZone < normFirstZone || sb.firstDataZone >= sb.nzones) {
    return {
      ok: false,
      kind: 'corrupt',
      detail:
        `s_firstdatazone=${sb.firstDataZone} outside [${normFirstZone}, ${sb.nzones}) ` +
        '— inode table and data zones overlap or fall off the device',
    };
  }

  const fs = new MinixFileSystem(bytes, view, sb, (2 + sb.imapBlocks + sb.zmapBlocks) * MINIX_BLOCK_SIZE);

  // The root inode is the one structure everything else hangs off —
  // verify it now so open() catches a wiped inode table, not stat().
  const root = fs.statInode(MINIX_ROOT_INODE);
  if (!root.ok) {
    return { ok: false, kind: 'corrupt', detail: `root inode: ${root.detail}` };
  }
  if (root.value.type !== 'dir') {
    return {
      ok: false,
      kind: 'corrupt',
      detail: `root inode is ${root.value.type} (mode 0o${root.value.mode.toString(8)}), not a directory`,
    };
  }
  return { ok: true, fs };
}

/** Decoded on-disk inode (v1, 32 bytes). Internal shape. */
interface RawInode {
  readonly mode: number;
  readonly uid: number;
  readonly size: number;
  readonly time: number;
  readonly gid: number;
  readonly nlinks: number;
  readonly zones: readonly number[]; // 7 direct
  readonly indirZone: number;
  readonly dblIndirZone: number;
}

export class MinixFileSystem {
  readonly superblock: MinixSuperblock;
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #inodeTableOffset: number;

  /** @internal — construct via {@link openMinixImage}. */
  constructor(
    bytes: Uint8Array,
    view: DataView,
    superblock: MinixSuperblock,
    inodeTableOffset: number,
  ) {
    this.#bytes = bytes;
    this.#view = view;
    this.superblock = superblock;
    this.#inodeTableOffset = inodeTableOffset;
  }

  /** stat() by path — the root is '/', separators collapse like Unix. */
  stat(path: string): MinixResult<MinixStat> {
    const resolved = this.#resolvePath(path);
    if (!resolved.ok) return resolved;
    return this.statInode(resolved.value);
  }

  /**
   * List a directory's entries as stored (including `.` and `..`).
   * Deleted slots (inode 0) are skipped, same as the mfs reference.
   */
  list(path: string): MinixResult<MinixDirEntry[]> {
    const resolved = this.#resolvePath(path);
    if (!resolved.ok) return resolved;
    return this.#listInode(resolved.value, path);
  }

  /**
   * Whole-file read, byte-exact per i_size. Holes (zone pointer 0)
   * read as zeros — mfs/reader.c does the same. Regular files only;
   * a directory or device answers not-a-file.
   */
  readFile(path: string): MinixResult<Uint8Array> {
    const resolved = this.#resolvePath(path);
    if (!resolved.ok) return resolved;
    const inodeNo = resolved.value;
    const ino = this.#readInode(inodeNo);
    if (ino === null) {
      return { ok: false, kind: 'corrupt', detail: `inode ${inodeNo} is outside the inode table` };
    }
    if ((ino.mode & S_IFMT) !== 0o100000) {
      return {
        ok: false,
        kind: 'not-a-file',
        detail: `${path} is a ${typeOfMode(ino.mode)}, not a regular file`,
      };
    }
    const out = new Uint8Array(ino.size);
    for (let off = 0; off < ino.size; off += MINIX_BLOCK_SIZE) {
      const zone = this.#zoneForFileBlock(ino, off / MINIX_BLOCK_SIZE);
      if (typeof zone === 'string') return { ok: false, kind: 'corrupt', detail: zone };
      if (zone === 0) continue; // hole — stays zeros
      const want = Math.min(MINIX_BLOCK_SIZE, ino.size - off);
      const src = zone * MINIX_BLOCK_SIZE;
      if (src + want > this.#bytes.byteLength) {
        return {
          ok: false,
          kind: 'corrupt',
          detail: `zone ${zone} points past the end of the image`,
        };
      }
      out.set(this.#bytes.subarray(src, src + want), off);
    }
    return { ok: true, value: out };
  }

  /** stat() by inode number — used internally and by open()'s root check. */
  statInode(inodeNo: number): MinixResult<MinixStat> {
    const ino = this.#readInode(inodeNo);
    if (ino === null) {
      return {
        ok: false,
        kind: 'corrupt',
        detail: `inode ${inodeNo} is outside the inode table (ninodes=${this.superblock.ninodes})`,
      };
    }
    return {
      ok: true,
      value: {
        inode: inodeNo,
        type: typeOfMode(ino.mode),
        mode: ino.mode,
        sizeBytes: ino.size,
        mtime: ino.time,
        uid: ino.uid,
        gid: ino.gid,
        nlinks: ino.nlinks,
      },
    };
  }

  /* ---------------- write path (M2) ---------------- */

  /**
   * Create or whole-file-replace a regular file. Mutates the image
   * buffer. All-zero 1 KB blocks are stored as holes (the reference
   * writer does the same). Refuses double-indirect sizes — see
   * MINIX_MAX_WRITE_BYTES.
   */
  writeFile(path: string, bytes: Uint8Array): MinixWriteResult<MinixStat> {
    if (bytes.byteLength > MINIX_MAX_WRITE_BYTES) {
      return {
        ok: false,
        kind: 'too-large',
        detail:
          `${bytes.byteLength} bytes needs the double-indirect chain; the v1 write path ` +
          `stops at ${MINIX_MAX_WRITE_BYTES} (7 direct + 512 indirect blocks) — brief §2`,
      };
    }
    const split = this.#splitForWrite(path);
    if (!split.ok) return split;
    const { parentInode, name } = split.value;

    const existing = this.#lookupIn(parentInode, name);
    if (typeof existing === 'string') return { ok: false, kind: 'corrupt', detail: existing };

    let target: number;
    let created = false;
    if (existing !== null) {
      const st = this.statInode(existing);
      if (!st.ok) return st;
      if (st.value.type !== 'file') {
        return {
          ok: false,
          kind: 'not-a-file',
          detail: `${path} is a ${st.value.type}, not a regular file`,
        };
      }
      target = existing;
    } else {
      const alloc = this.#allocInode();
      if (alloc === null) {
        return { ok: false, kind: 'no-space', detail: 'no free inodes' };
      }
      this.#storeInode(alloc, {
        mode: 0o100644,
        uid: 0,
        size: 0,
        time: nowSeconds(),
        gid: 0,
        nlinks: 1,
        zones: [0, 0, 0, 0, 0, 0, 0],
        indirZone: 0,
        dblIndirZone: 0,
      });
      const added = this.#dnameAdd(parentInode, name, alloc);
      if (added !== null) {
        this.#freeInode(alloc); // unwind: nothing references it yet
        return { ok: false, ...added };
      }
      target = alloc;
      created = true;
    }

    const wrote = this.#writeData(target, bytes);
    if (wrote !== null) {
      if (created) {
        // Unwind a half-created file: free its zones, drop the dirent,
        // release the inode. Replacing an EXISTING file that ran out of
        // space stays as-written-so-far — recorded, and fsck-clean.
        this.#truncInode(target, 0);
        this.#dnameRem(parentInode, name);
        this.#freeInode(target);
      }
      return { ok: false, ...wrote };
    }
    return this.statInode(target);
  }

  /** Unlink a regular file (or symlink). Directories are refused —
   *  rmdir is not in M2's scope. Mutates the image buffer. */
  remove(path: string): MinixWriteResult<null> {
    const split = this.#splitForWrite(path);
    if (!split.ok) return split;
    const { parentInode, name } = split.value;

    const found = this.#lookupIn(parentInode, name);
    if (typeof found === 'string') return { ok: false, kind: 'corrupt', detail: found };
    if (found === null) return { ok: false, kind: 'not-found', detail: `${path}: not found` };

    const ino = this.#readInode(found);
    if (ino === null) {
      return { ok: false, kind: 'corrupt', detail: `inode ${found} is outside the inode table` };
    }
    if ((ino.mode & S_IFMT) === 0o040000) {
      return {
        ok: false,
        kind: 'not-a-file',
        detail: `${path} is a directory — rmdir is not in M2 (brief §3)`,
      };
    }
    this.#dnameRem(parentInode, name);
    if (ino.nlinks > 1) {
      this.#storeInode(found, { ...ino, nlinks: ino.nlinks - 1 });
    } else {
      this.#truncInode(found, 0);
      this.#storeInode(found, {
        mode: 0, uid: 0, size: 0, time: 0, gid: 0, nlinks: 0,
        zones: [0, 0, 0, 0, 0, 0, 0], indirZone: 0, dblIndirZone: 0,
      });
      this.#freeInode(found);
    }
    return { ok: true, value: null };
  }

  /** Create a directory (with `.` and `..`). Mutates the image buffer. */
  mkdir(path: string): MinixWriteResult<MinixStat> {
    const split = this.#splitForWrite(path);
    if (!split.ok) return split;
    const { parentInode, name } = split.value;

    const existing = this.#lookupIn(parentInode, name);
    if (typeof existing === 'string') return { ok: false, kind: 'corrupt', detail: existing };
    if (existing !== null) {
      return { ok: false, kind: 'exists', detail: `${path}: already exists` };
    }
    const alloc = this.#allocInode();
    if (alloc === null) return { ok: false, kind: 'no-space', detail: 'no free inodes' };
    this.#storeInode(alloc, {
      mode: 0o040755,
      uid: 0,
      size: 0,
      time: nowSeconds(),
      gid: 0,
      nlinks: 1, // '.' bumps it to 2 below — domkdir's arithmetic
      zones: [0, 0, 0, 0, 0, 0, 0],
      indirZone: 0,
      dblIndirZone: 0,
    });
    const failures =
      this.#dnameAdd(parentInode, name, alloc) ??
      this.#dnameAdd(alloc, '.', alloc) ??
      this.#dnameAdd(alloc, '..', parentInode);
    if (failures !== null) {
      this.#truncInode(alloc, 0);
      this.#dnameRem(parentInode, name);
      this.#freeInode(alloc);
      return { ok: false, ...failures };
    }
    const self = this.#readInode(alloc);
    const parent = this.#readInode(parentInode);
    if (self === null || parent === null) {
      return { ok: false, kind: 'corrupt', detail: 'inode vanished during mkdir' };
    }
    this.#storeInode(alloc, { ...self, nlinks: self.nlinks + 1 });
    this.#storeInode(parentInode, { ...parent, nlinks: parent.nlinks + 1 });
    return this.statInode(alloc);
  }

  /* ---------------- write internals ---------------- */

  get #imapOffset(): number {
    return 2 * MINIX_BLOCK_SIZE;
  }

  get #zmapOffset(): number {
    return (2 + this.superblock.imapBlocks) * MINIX_BLOCK_SIZE;
  }

  #bit(mapOffset: number, n: number): boolean {
    const byte = this.#bytes[mapOffset + (n >> 3)] ?? 0;
    return (byte & (1 << (n & 7))) !== 0;
  }

  #setBit(mapOffset: number, n: number, on: boolean): void {
    const idx = mapOffset + (n >> 3);
    const cur = this.#bytes[idx] ?? 0;
    this.#bytes[idx] = on ? cur | (1 << (n & 7)) : cur & ~(1 << (n & 7));
  }

  /** First clear bit in a map, or null. mkfs sets bit 0 and all
   *  padding bits past the valid range, so a plain scan is safe. */
  #firstFreeBit(mapOffset: number, mapBlocks: number): number | null {
    const totalBits = mapBlocks * MINIX_BLOCK_SIZE * 8;
    for (let n = 0; n < totalBits; n += 1) {
      if (!this.#bit(mapOffset, n)) return n;
    }
    return null;
  }

  #allocInode(): number | null {
    const n = this.#firstFreeBit(this.#imapOffset, this.superblock.imapBlocks);
    // n < ninodes, not <=: ELKS mkfs never clears bit ninodes (its
    // clear loop is `i < INODES`), so inode №ninodes is padding in
    // every image the guest formats. The bitmap enforces this on its
    // own — the guard just keeps us honest against foreign images.
    if (n === null || n < 1 || n >= this.superblock.ninodes) return null;
    this.#setBit(this.#imapOffset, n, true);
    return n; // inode N ↔ bit N
  }

  #freeInode(inodeNo: number): void {
    this.#setBit(this.#imapOffset, inodeNo, false);
  }

  /** Allocate a data zone: mark its bit and zero its bytes. */
  #allocZone(): number | null {
    const n = this.#firstFreeBit(this.#zmapOffset, this.superblock.zmapBlocks);
    if (n === null) return null;
    const zone = n + this.superblock.firstDataZone - 1; // bit 1 ↔ firstdatazone
    if (zone < this.superblock.firstDataZone || zone >= this.superblock.nzones) return null;
    this.#setBit(this.#zmapOffset, n, true);
    this.#bytes.fill(0, zone * MINIX_BLOCK_SIZE, (zone + 1) * MINIX_BLOCK_SIZE);
    return zone;
  }

  #freeZone(zone: number): void {
    if (zone === 0) return;
    this.#setBit(this.#zmapOffset, zone - this.superblock.firstDataZone + 1, false);
  }

  #storeInode(inodeNo: number, ino: RawInode): void {
    const off = this.#inodeTableOffset + (inodeNo - 1) * INODE_SIZE;
    const v = this.#view;
    v.setUint16(off + 0, ino.mode, true);
    v.setUint16(off + 2, ino.uid, true);
    v.setUint32(off + 4, ino.size, true);
    v.setUint32(off + 8, ino.time, true);
    v.setUint8(off + 12, ino.gid);
    v.setUint8(off + 13, ino.nlinks);
    for (let i = 0; i < DIRECT_ZONES; i += 1) {
      v.setUint16(off + 14 + i * 2, ino.zones[i] ?? 0, true);
    }
    v.setUint16(off + 28, ino.indirZone, true);
    v.setUint16(off + 30, ino.dblIndirZone, true);
  }

  /** Ensure file block `blk` has a zone; allocate (and wire the
   *  indirect table) as needed. Returns the zone or a write error. */
  #ensureZone(
    inodeNo: number,
    blk: number,
  ): number | { kind: MinixWriteErrorKind; detail: string } {
    const ino = this.#readInode(inodeNo);
    if (ino === null) return { kind: 'corrupt', detail: `inode ${inodeNo} unreadable` };
    if (blk < DIRECT_ZONES) {
      const cur = ino.zones[blk] ?? 0;
      if (cur !== 0) return cur;
      const zone = this.#allocZone();
      if (zone === null) return { kind: 'no-space', detail: 'no free zones' };
      const zones = [...ino.zones];
      zones[blk] = zone;
      this.#storeInode(inodeNo, { ...ino, zones });
      return zone;
    }
    const idx = blk - DIRECT_ZONES;
    if (idx >= ZONES_PER_INDIRECT) {
      return { kind: 'too-large', detail: `file block ${blk} is past the v1 write cap` };
    }
    let table = ino.indirZone;
    if (table === 0) {
      const t = this.#allocZone();
      if (t === null) return { kind: 'no-space', detail: 'no free zones (indirect table)' };
      table = t;
      this.#storeInode(inodeNo, { ...ino, indirZone: table });
    }
    const ptrOff = table * MINIX_BLOCK_SIZE + idx * 2;
    const cur = this.#view.getUint16(ptrOff, true);
    if (cur !== 0) return cur;
    const zone = this.#allocZone();
    if (zone === null) return { kind: 'no-space', detail: 'no free zones' };
    this.#view.setUint16(ptrOff, zone, true);
    return zone;
  }

  /**
   * Free file block `blk`'s zone, collapsing indirect tables that
   * empty out — the full ino_freezone port, double-indirect included
   * (truncating a big READ-side file must free its whole chain even
   * though the WRITE side never creates one).
   */
  #freeFileBlock(inodeNo: number, blk: number): void {
    const ino = this.#readInode(inodeNo);
    if (ino === null) return;
    if (blk < DIRECT_ZONES) {
      const cur = ino.zones[blk] ?? 0;
      if (cur === 0) return;
      this.#freeZone(cur);
      const zones = [...ino.zones];
      zones[blk] = 0;
      this.#storeInode(inodeNo, { ...ino, zones });
      return;
    }
    let rest = blk - DIRECT_ZONES;
    if (rest < ZONES_PER_INDIRECT) {
      if (ino.indirZone === 0) return;
      const base = ino.indirZone * MINIX_BLOCK_SIZE;
      const cur = this.#view.getUint16(base + rest * 2, true);
      if (cur !== 0) this.#freeZone(cur);
      this.#view.setUint16(base + rest * 2, 0, true);
      if (this.#tableEmpty(ino.indirZone)) {
        this.#freeZone(ino.indirZone);
        this.#storeInode(inodeNo, { ...ino, indirZone: 0 });
      }
      return;
    }
    rest -= ZONES_PER_INDIRECT;
    if (ino.dblIndirZone === 0) return;
    const outerBase = ino.dblIndirZone * MINIX_BLOCK_SIZE;
    const outerIdx = Math.floor(rest / ZONES_PER_INDIRECT);
    const mid = this.#view.getUint16(outerBase + outerIdx * 2, true);
    if (mid === 0) return;
    const innerBase = mid * MINIX_BLOCK_SIZE;
    const innerIdx = rest % ZONES_PER_INDIRECT;
    const cur = this.#view.getUint16(innerBase + innerIdx * 2, true);
    if (cur !== 0) this.#freeZone(cur);
    this.#view.setUint16(innerBase + innerIdx * 2, 0, true);
    if (this.#tableEmpty(mid)) {
      this.#freeZone(mid);
      this.#view.setUint16(outerBase + outerIdx * 2, 0, true);
      if (this.#tableEmpty(ino.dblIndirZone)) {
        this.#freeZone(ino.dblIndirZone);
        this.#storeInode(inodeNo, { ...ino, dblIndirZone: 0 });
      }
    }
  }

  #tableEmpty(tableZone: number): boolean {
    const base = tableZone * MINIX_BLOCK_SIZE;
    for (let i = 0; i < ZONES_PER_INDIRECT; i += 1) {
      if (this.#view.getUint16(base + i * 2, true) !== 0) return false;
    }
    return true;
  }

  /** Whole-file write onto an existing inode: blocks in, size set,
   *  excess blocks (a previously-larger file) freed, mtime bumped. */
  #writeData(
    inodeNo: number,
    bytes: Uint8Array,
  ): { kind: MinixWriteErrorKind; detail: string } | null {
    const blockCount = Math.ceil(bytes.byteLength / MINIX_BLOCK_SIZE);
    for (let blk = 0; blk < blockCount; blk += 1) {
      const start = blk * MINIX_BLOCK_SIZE;
      const chunk = bytes.subarray(start, Math.min(start + MINIX_BLOCK_SIZE, bytes.byteLength));
      if (chunk.every((b) => b === 0)) {
        this.#freeFileBlock(inodeNo, blk); // store a hole, like writer.c
        continue;
      }
      const zone = this.#ensureZone(inodeNo, blk);
      if (typeof zone !== 'number') return zone;
      const dst = zone * MINIX_BLOCK_SIZE;
      this.#bytes.fill(0, dst, dst + MINIX_BLOCK_SIZE);
      this.#bytes.set(chunk, dst);
    }
    this.#truncInode(inodeNo, bytes.byteLength);
    return null;
  }

  /** Set size, freeing blocks past the new end (trunc_inode). */
  #truncInode(inodeNo: number, newSize: number): void {
    const ino = this.#readInode(inodeNo);
    if (ino === null) return;
    const startBlk = Math.ceil(newSize / MINIX_BLOCK_SIZE);
    const endBlk = Math.ceil(ino.size / MINIX_BLOCK_SIZE);
    for (let blk = startBlk; blk < endBlk; blk += 1) {
      this.#freeFileBlock(inodeNo, blk);
    }
    const after = this.#readInode(inodeNo);
    if (after === null) return;
    this.#storeInode(inodeNo, { ...after, size: newSize, time: nowSeconds() });
  }

  /** Add a dirent: first inode-0 slot, else extend by one entry
   *  (dname_add). Returns null on success or a write error. */
  #dnameAdd(
    dirInode: number,
    name: string,
    targetInode: number,
  ): { kind: MinixWriteErrorKind; detail: string } | null {
    const dir = this.#readInode(dirInode);
    if (dir === null) return { kind: 'corrupt', detail: `dir inode ${dirInode} unreadable` };
    const dentsz = 2 + this.superblock.nameLen;

    // Find the first deleted slot, else place at end-of-file.
    let slotOffset = dir.size;
    scan: for (let off = 0; off < dir.size; off += MINIX_BLOCK_SIZE) {
      const zone = this.#zoneForFileBlock(dir, off / MINIX_BLOCK_SIZE);
      if (typeof zone === 'string') return { kind: 'corrupt', detail: zone };
      const bsz = Math.min(MINIX_BLOCK_SIZE, dir.size - off);
      for (let j = 0; j + dentsz <= bsz; j += dentsz) {
        const ino =
          zone === 0 ? 0 : this.#view.getUint16(zone * MINIX_BLOCK_SIZE + j, true);
        if (ino === 0) {
          slotOffset = off + j;
          break scan;
        }
      }
    }

    const blk = Math.floor(slotOffset / MINIX_BLOCK_SIZE);
    const j = slotOffset % MINIX_BLOCK_SIZE;
    const zone = this.#ensureZone(dirInode, blk);
    if (typeof zone !== 'number') return zone;
    const base = zone * MINIX_BLOCK_SIZE + j;
    this.#view.setUint16(base, targetInode, true);
    for (let i = 0; i < this.superblock.nameLen; i += 1) {
      this.#bytes[base + 2 + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0;
    }
    if (slotOffset >= dir.size) {
      const cur = this.#readInode(dirInode);
      if (cur !== null) {
        this.#storeInode(dirInode, { ...cur, size: dir.size + dentsz, time: nowSeconds() });
      }
    }
    return null;
  }

  /** Remove a dirent: shrink if it was the last entry (freeing the
   *  block that emptied — the corrected boundary; see module doc),
   *  else zero the slot (dname_rem). */
  #dnameRem(dirInode: number, name: string): void {
    const dir = this.#readInode(dirInode);
    if (dir === null) return;
    const dentsz = 2 + this.superblock.nameLen;

    let entryOffset = -1;
    scan: for (let off = 0; off < dir.size; off += MINIX_BLOCK_SIZE) {
      const zone = this.#zoneForFileBlock(dir, off / MINIX_BLOCK_SIZE);
      if (typeof zone === 'string' || zone === 0) continue;
      const bsz = Math.min(MINIX_BLOCK_SIZE, dir.size - off);
      for (let j = 0; j + dentsz <= bsz; j += dentsz) {
        const base = zone * MINIX_BLOCK_SIZE + j;
        if (this.#view.getUint16(base, true) === 0) continue;
        if (this.#decodeName(base + 2) === name) {
          entryOffset = off + j;
          break scan;
        }
      }
    }
    if (entryOffset === -1) return;

    const newSize = dir.size - dentsz;
    if (entryOffset === newSize) {
      if (newSize % MINIX_BLOCK_SIZE === 0 && newSize < dir.size) {
        this.#freeFileBlock(dirInode, newSize / MINIX_BLOCK_SIZE);
      }
      const cur = this.#readInode(dirInode);
      if (cur !== null) this.#storeInode(dirInode, { ...cur, size: newSize, time: nowSeconds() });
    } else {
      const blk = Math.floor(entryOffset / MINIX_BLOCK_SIZE);
      const zone = this.#zoneForFileBlock(dir, blk);
      if (typeof zone === 'string' || zone === 0) return;
      const base = zone * MINIX_BLOCK_SIZE + (entryOffset % MINIX_BLOCK_SIZE);
      this.#bytes.fill(0, base, base + dentsz);
      const cur = this.#readInode(dirInode);
      if (cur !== null) this.#storeInode(dirInode, { ...cur, time: nowSeconds() });
    }
  }

  /** Look `name` up in a directory inode: inode number, null if
   *  absent, or a corrupt-detail string. */
  #lookupIn(dirInode: number, name: string): number | null | string {
    const listed = this.#listInode(dirInode, name);
    if (!listed.ok) return listed.detail;
    const hit = listed.value.find((e) => e.name === name);
    return hit === undefined ? null : hit.stat.inode;
  }

  /** Split a write path into (parent dir inode, final name), with the
   *  name-length check writes need. */
  #splitForWrite(
    path: string,
  ): MinixWriteResult<{ parentInode: number; name: string }> {
    const parts = path.split('/').filter((p) => p.length > 0);
    const name = parts.pop();
    if (name === undefined) {
      return { ok: false, kind: 'not-a-file', detail: 'the root is a directory' };
    }
    if (name.length > this.superblock.nameLen) {
      return {
        ok: false,
        kind: 'name-too-long',
        detail: `"${name}" is ${name.length} chars; this fs stores ${this.superblock.nameLen} — mangle upstream (brief §2)`,
      };
    }
    const parent = this.#resolvePath(parts.join('/'));
    if (!parent.ok) return parent;
    const st = this.statInode(parent.value);
    if (!st.ok) return st;
    if (st.value.type !== 'dir') {
      return {
        ok: false,
        kind: 'not-a-directory',
        detail: `/${parts.join('/')} is a ${st.value.type}, not a directory`,
      };
    }
    return { ok: true, value: { parentInode: parent.value, name } };
  }

  /* ---------------- internals ---------------- */

  #readInode(inodeNo: number): RawInode | null {
    if (!Number.isInteger(inodeNo) || inodeNo < 1 || inodeNo > this.superblock.ninodes) {
      return null;
    }
    const off = this.#inodeTableOffset + (inodeNo - 1) * INODE_SIZE;
    if (off + INODE_SIZE > this.#bytes.byteLength) return null;
    const v = this.#view;
    const zones: number[] = [];
    for (let i = 0; i < DIRECT_ZONES; i += 1) {
      zones.push(v.getUint16(off + 14 + i * 2, true));
    }
    return {
      mode: v.getUint16(off + 0, true),
      uid: v.getUint16(off + 2, true),
      size: v.getUint32(off + 4, true),
      time: v.getUint32(off + 8, true),
      gid: v.getUint8(off + 12),
      nlinks: v.getUint8(off + 13),
      zones,
      indirZone: v.getUint16(off + 28, true),
      dblIndirZone: v.getUint16(off + 30, true),
    };
  }

  /**
   * File block index → absolute zone number (mfs ino_zone). 0 means a
   * hole; a string is a corruption detail. Order: 7 direct, 512 via
   * the indirect block, 512×512 via the double-indirect chain.
   */
  #zoneForFileBlock(ino: RawInode, blk: number): number | string {
    if (blk < DIRECT_ZONES) {
      return this.#checkZone(ino.zones[blk] ?? 0);
    }
    let rest = blk - DIRECT_ZONES;
    if (rest < ZONES_PER_INDIRECT) {
      if (ino.indirZone === 0) return 0;
      return this.#readZonePointer(ino.indirZone, rest, 'indirect');
    }
    rest -= ZONES_PER_INDIRECT;
    if (rest < ZONES_PER_INDIRECT * ZONES_PER_INDIRECT) {
      if (ino.dblIndirZone === 0) return 0;
      const mid = this.#readZonePointer(
        ino.dblIndirZone,
        Math.floor(rest / ZONES_PER_INDIRECT),
        'double-indirect',
      );
      if (typeof mid === 'string' || mid === 0) return mid;
      return this.#readZonePointer(mid, rest % ZONES_PER_INDIRECT, 'double-indirect inner');
    }
    return `file block ${blk} exceeds the v1 maximum (7 + 512 + 512×512 blocks)`;
  }

  /** Read entry `index` of the u16 zone-pointer block at `zoneBlk`. */
  #readZonePointer(zoneBlk: number, index: number, level: string): number | string {
    const checked = this.#checkZone(zoneBlk);
    if (typeof checked === 'string') return `${level} block: ${checked}`;
    const off = zoneBlk * MINIX_BLOCK_SIZE + index * 2;
    if (off + 2 > this.#bytes.byteLength) {
      return `${level} block ${zoneBlk} points past the end of the image`;
    }
    return this.#checkZone(this.#view.getUint16(off, true));
  }

  /** Zone sanity: 0 (hole) passes through; data zones must be in range. */
  #checkZone(zone: number): number | string {
    if (zone === 0) return 0;
    if (zone < this.superblock.firstDataZone || zone >= this.superblock.nzones) {
      return `zone pointer ${zone} outside data area [${this.superblock.firstDataZone}, ${this.superblock.nzones})`;
    }
    return zone;
  }

  #listInode(inodeNo: number, pathForErrors: string): MinixResult<MinixDirEntry[]> {
    const ino = this.#readInode(inodeNo);
    if (ino === null) {
      return { ok: false, kind: 'corrupt', detail: `inode ${inodeNo} is outside the inode table` };
    }
    if ((ino.mode & S_IFMT) !== 0o040000) {
      return {
        ok: false,
        kind: 'not-a-directory',
        detail: `${pathForErrors} is a ${typeOfMode(ino.mode)}, not a directory`,
      };
    }
    const dirEntrySize = 2 + this.superblock.nameLen;
    const entries: MinixDirEntry[] = [];
    for (let off = 0; off < ino.size; off += MINIX_BLOCK_SIZE) {
      const zone = this.#zoneForFileBlock(ino, off / MINIX_BLOCK_SIZE);
      if (typeof zone === 'string') return { ok: false, kind: 'corrupt', detail: zone };
      if (zone === 0) continue; // sparse directory block: nothing stored
      const blockBytes = Math.min(MINIX_BLOCK_SIZE, ino.size - off);
      const base = zone * MINIX_BLOCK_SIZE;
      if (base + blockBytes > this.#bytes.byteLength) {
        return { ok: false, kind: 'corrupt', detail: `zone ${zone} points past the end of the image` };
      }
      for (let j = 0; j + dirEntrySize <= blockBytes; j += dirEntrySize) {
        const entryInode = this.#view.getUint16(base + j, true);
        if (entryInode === 0) continue; // deleted slot
        const name = this.#decodeName(base + j + 2);
        const st = this.statInode(entryInode);
        if (!st.ok) {
          return {
            ok: false,
            kind: 'corrupt',
            detail: `directory entry "${name}" points at bad inode ${entryInode}: ${st.detail}`,
          };
        }
        entries.push({ name, stat: st.value });
      }
    }
    return { ok: true, value: entries };
  }

  /** Name bytes: NUL-terminated unless all nameLen chars are used. */
  #decodeName(off: number): string {
    let out = '';
    for (let i = 0; i < this.superblock.nameLen; i += 1) {
      const c = this.#bytes[off + i] ?? 0;
      if (c === 0) break;
      out += String.fromCharCode(c); // latin1 — ELKS names are ASCII
    }
    return out;
  }

  /**
   * Path → inode number (mfs find_inode). '/', '', and '.' resolve to
   * the root; repeated separators collapse. Components longer than
   * nameLen are honestly not-found (they cannot exist on this fs).
   */
  #resolvePath(path: string): MinixResult<number> {
    const parts = path.split('/').filter((p) => p.length > 0);
    let current = MINIX_ROOT_INODE;
    let walked = '';
    for (const part of parts) {
      walked += `/${part}`;
      const listed = this.#listInode(current, walked);
      if (!listed.ok) return listed;
      const hit = listed.value.find((e) => e.name === part);
      if (hit === undefined) {
        return { ok: false, kind: 'not-found', detail: `${walked}: not found` };
      }
      current = hit.stat.inode;
    }
    return { ok: true, value: current };
  }
}

function typeOfMode(mode: number): MinixFileType {
  return TYPE_BY_IFMT.get(mode & S_IFMT) ?? 'unknown';
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
