/**
 * MINIX v1 filesystem, read-only (Phase 16 M1 — the editor seam's
 * enabling piece).
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
