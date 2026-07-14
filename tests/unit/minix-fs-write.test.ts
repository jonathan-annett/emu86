/**
 * MINIX v1 write path (Phase 16 M2) — every test starts from a fresh
 * copy of the guest-written fixture, mutates it, REOPENS the bytes
 * (so assertions see the on-disk truth, not module state), and runs
 * `fsckLite` — an independent TS re-derivation of the invariants the
 * guest's fsck checks:
 *
 *   - zone bitmap ⟺ the set of zones reachable from in-use inodes
 *     (data zones + indirect tables + double-indirect chains), no
 *     zone referenced twice, none out of range;
 *   - inode bitmap ⟺ inodes reachable from the root walk;
 *   - nlinks == dirent references (dirs: 2 + subdirs).
 *
 * fsckLite reads the image with its own raw parsing (not the module
 * under test) wherever bits and inodes are concerned — a checker that
 * trusted the module would vouch for its own bugs. The REAL judge is
 * the guest's fsck in tests/integration/minix-write-guest.test.ts;
 * this one just runs on every unit case.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MINIX_MAX_WRITE_BYTES,
  openMinixImage,
  type MinixFileSystem,
} from '../../src/disk/minix-fs.js';

const FIXTURE_PATH = resolve('tests/fixtures', 'minix-v1-2048.img');
const BLOCK = 1024;

const fixturePresent = existsSync(FIXTURE_PATH);
const withFixture = fixturePresent ? describe : describe.skip;
if (!fixturePresent) {
  console.warn(`[skip] ${FIXTURE_PATH} missing — see tests/fixtures/README.md`);
}

const ascii = (s: string): Uint8Array =>
  new Uint8Array([...s].map((c) => c.charCodeAt(0)));

/** Distinct-per-block filler so chain-indexing bugs can't hide. */
function patterned(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = (i + Math.floor(i / BLOCK) * 7 + 1) & 0xff || 1; // never 0 → no holes
  }
  return out;
}

function freshImage(): Uint8Array {
  const raw = readFileSync(FIXTURE_PATH);
  return new Uint8Array(raw); // fresh copy — tests mutate
}

function open(bytes: Uint8Array): MinixFileSystem {
  const r = openMinixImage(bytes);
  if (!r.ok) throw new Error(`open failed: ${r.kind} — ${r.detail}`);
  return r.fs;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------------- fsck-lite ---------------- */

interface SbRaw {
  ninodes: number;
  nzones: number;
  imapBlocks: number;
  zmapBlocks: number;
  firstDataZone: number;
}

function readSb(bytes: Uint8Array): SbRaw {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ninodes: v.getUint16(1024 + 0, true),
    nzones: v.getUint16(1024 + 2, true),
    imapBlocks: v.getUint16(1024 + 4, true),
    zmapBlocks: v.getUint16(1024 + 6, true),
    firstDataZone: v.getUint16(1024 + 8, true),
  };
}

function bitAt(bytes: Uint8Array, mapOffset: number, n: number): boolean {
  return ((bytes[mapOffset + (n >> 3)] ?? 0) & (1 << (n & 7))) !== 0;
}

/** Raw inode reader — independent of the module under test. */
function rawInode(bytes: Uint8Array, sb: SbRaw, n: number): {
  mode: number; size: number; nlinks: number;
  zones: number[]; indir: number; dbl: number;
} {
  const inodeBlocks = Math.ceil(sb.ninodes / 32);
  void inodeBlocks;
  const tableOff = (2 + sb.imapBlocks + sb.zmapBlocks) * BLOCK;
  const off = tableOff + (n - 1) * 32;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const zones: number[] = [];
  for (let i = 0; i < 7; i += 1) zones.push(v.getUint16(off + 14 + i * 2, true));
  return {
    mode: v.getUint16(off, true),
    size: v.getUint32(off + 4, true),
    nlinks: v.getUint8(off + 13),
    zones,
    indir: v.getUint16(off + 28, true),
    dbl: v.getUint16(off + 30, true),
  };
}

/** Independent invariant check. Returns complaints; [] = clean. */
function fsckLite(bytes: Uint8Array): string[] {
  const complaints: string[] = [];
  const sb = readSb(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fs = open(bytes); // used ONLY for the directory walk

  // Reachability walk: inode → number of dirent references.
  const refs = new Map<number, number>();
  const dirInodes = new Set<number>();
  const stack = ['/'];
  const rootStat = fs.stat('/');
  if (!rootStat.ok) return [`root unstatable: ${rootStat.detail}`];
  while (stack.length > 0) {
    const path = stack.pop() as string;
    const listed = fs.list(path);
    if (!listed.ok) {
      complaints.push(`list(${path}): ${listed.kind} ${listed.detail}`);
      continue;
    }
    const dirSelf = fs.stat(path);
    if (dirSelf.ok) dirInodes.add(dirSelf.value.inode);
    for (const e of listed.value) {
      refs.set(e.stat.inode, (refs.get(e.stat.inode) ?? 0) + 1);
      if (e.name === '.' || e.name === '..') continue;
      if (e.stat.type === 'dir') stack.push(path === '/' ? `/${e.name}` : `${path}/${e.name}`);
    }
  }

  // Zone collection from RAW inodes of every referenced inode.
  const zoneRefs = new Map<number, number>();
  const takeZone = (z: number, what: string): void => {
    if (z === 0) return;
    if (z < sb.firstDataZone || z >= sb.nzones) {
      complaints.push(`${what}: zone ${z} out of range`);
      return;
    }
    zoneRefs.set(z, (zoneRefs.get(z) ?? 0) + 1);
  };
  for (const inodeNo of refs.keys()) {
    const ino = rawInode(bytes, sb, inodeNo);
    const isDev = (ino.mode & 0o170000) === 0o020000 || (ino.mode & 0o170000) === 0o060000;
    if (isDev) continue; // zone[0] is a device number, not a zone
    for (const z of ino.zones) takeZone(z, `inode ${inodeNo} direct`);
    if (ino.indir !== 0) {
      takeZone(ino.indir, `inode ${inodeNo} indirect table`);
      for (let i = 0; i < 512; i += 1) {
        takeZone(v.getUint16(ino.indir * BLOCK + i * 2, true), `inode ${inodeNo} indirect[${i}]`);
      }
    }
    if (ino.dbl !== 0) {
      takeZone(ino.dbl, `inode ${inodeNo} dbl table`);
      for (let i = 0; i < 512; i += 1) {
        const mid = v.getUint16(ino.dbl * BLOCK + i * 2, true);
        if (mid === 0) continue;
        takeZone(mid, `inode ${inodeNo} dbl[${i}] table`);
        for (let k = 0; k < 512; k += 1) {
          takeZone(v.getUint16(mid * BLOCK + k * 2, true), `inode ${inodeNo} dbl[${i}][${k}]`);
        }
      }
    }
    // nlinks vs dirent references.
    if (ino.nlinks !== (refs.get(inodeNo) ?? 0)) {
      complaints.push(
        `inode ${inodeNo}: nlinks=${ino.nlinks} but ${refs.get(inodeNo)} dirent refs`,
      );
    }
  }
  for (const [z, n] of zoneRefs) {
    if (n > 1) complaints.push(`zone ${z} referenced ${n} times`);
  }

  // Bitmaps, both directions.
  const imapOff = 2 * BLOCK;
  const zmapOff = (2 + sb.imapBlocks) * BLOCK;
  // n < ninodes, NOT <=: ELKS mkfs's clear loop is `i < INODES`, so
  // bit ninodes is never cleared — inode №ninodes is permanent
  // padding in every ELKS-formatted image (mkfs.c:253; the zone loop
  // has no such off-by-one). Found by this checker, 2026-07-15.
  for (let n = 1; n < sb.ninodes; n += 1) {
    const marked = bitAt(bytes, imapOff, n);
    const used = refs.has(n);
    if (marked && !used) complaints.push(`inode ${n} marked but unreachable`);
    if (!marked && used) complaints.push(`inode ${n} in use but unmarked`);
  }
  for (let z = sb.firstDataZone; z < sb.nzones; z += 1) {
    const marked = bitAt(bytes, zmapOff, z - sb.firstDataZone + 1);
    const used = zoneRefs.has(z);
    if (marked && !used) complaints.push(`zone ${z} marked but unreferenced`);
    if (!marked && used) complaints.push(`zone ${z} in use but unmarked`);
  }
  return complaints;
}

/* ---------------- tests ---------------- */

withFixture('minix-fs write path vs the guest-written fixture', () => {
  it('fsckLite itself passes on the pristine fixture (checker sanity)', () => {
    expect(fsckLite(freshImage())).toEqual([]);
  });

  it('creates a small file: reopen → byte-exact, listed, fsck-clean', () => {
    const bytes = freshImage();
    const content = ascii('written by the host, read by anyone\n');
    const w = open(bytes).writeFile('/host.txt', content);
    expect(w.ok, !w.ok ? `${w.kind} ${w.detail}` : '').toBe(true);

    const fs2 = open(bytes);
    const names = fs2.list('/');
    expect(names.ok && names.value.some((e) => e.name === 'host.txt')).toBe(true);
    const back = fs2.readFile('/host.txt');
    expect(back.ok && sameBytes(back.value, content)).toBe(true);
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('creates an indirect-sized file (10 KB, distinct blocks) byte-exactly', () => {
    const bytes = freshImage();
    const content = patterned(10 * 1024 + 137);
    const w = open(bytes).writeFile('/dir1/ten-kb.bin', content);
    expect(w.ok).toBe(true);
    const back = open(bytes).readFile('/dir1/ten-kb.bin');
    expect(back.ok && sameBytes(back.value, content)).toBe(true);
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('whole-file replace grows a small file across the indirect boundary', () => {
    const bytes = freshImage();
    const content = patterned(9 * 1024);
    const w = open(bytes).writeFile('/README.txt', content);
    expect(w.ok).toBe(true);
    const back = open(bytes).readFile('/README.txt');
    expect(back.ok && sameBytes(back.value, content)).toBe(true);
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('replacing the 976 KB double-indirect file with a line frees its chains', () => {
    const bytes = freshImage();
    const sb = readSb(bytes);
    const zmapOff = (2 + sb.imapBlocks) * BLOCK;
    const freeZones = (): number => {
      let n = 0;
      for (let z = sb.firstDataZone; z < sb.nzones; z += 1) {
        if (!bitAt(bytes, zmapOff, z - sb.firstDataZone + 1)) n += 1;
      }
      return n;
    };
    const freeBefore = freeZones();
    const content = ascii('tiny now\n');
    const w = open(bytes).writeFile('/huge.txt', content);
    expect(w.ok).toBe(true);
    // ~976 zones of data + indirect tables came back.
    expect(freeZones() - freeBefore).toBeGreaterThan(950);
    const back = open(bytes).readFile('/huge.txt');
    expect(back.ok && sameBytes(back.value, content)).toBe(true);
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('all-zero blocks are stored as holes and read back as zeros', () => {
    const bytes = freshImage();
    const content = new Uint8Array(3 * BLOCK);
    content.set(ascii('head'), 0);
    content.set(ascii('tail'), 2 * BLOCK + 100); // middle block all zeros
    const w = open(bytes).writeFile('/holey.bin', content);
    expect(w.ok).toBe(true);
    if (!w.ok) return;

    const back = open(bytes).readFile('/holey.bin');
    expect(back.ok && sameBytes(back.value, content)).toBe(true);
    // The middle block really is a hole: raw zones[1] === 0.
    const ino = rawInode(bytes, readSb(bytes), w.value.inode);
    expect(ino.zones[1]).toBe(0);
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('remove drops the file, frees its inode, and the slot is reusable', () => {
    const bytes = freshImage();
    const fs = open(bytes);
    const w = fs.writeFile('/gone.txt', ascii('soon gone\n'));
    expect(w.ok).toBe(true);
    const r = fs.remove('/gone.txt');
    expect(r.ok).toBe(true);

    const fs2 = open(bytes);
    const listed = fs2.list('/');
    expect(listed.ok && listed.value.every((e) => e.name !== 'gone.txt')).toBe(true);
    expect(fsckLite(bytes)).toEqual([]);

    // The freed slot is reusable — create again, fsck stays clean.
    const again = fs2.writeFile('/gone.txt', ascii('back\n'));
    expect(again.ok).toBe(true);
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('removing the last entry shrinks the directory (boundary path)', () => {
    const bytes = freshImage();
    const fs = open(bytes);
    // empty.txt is the last entry in /dir1/sub; add + remove after it.
    const w = fs.writeFile('/dir1/sub/last.txt', ascii('x\n'));
    expect(w.ok).toBe(true);
    expect(fs.remove('/dir1/sub/last.txt').ok).toBe(true);
    const listed = open(bytes).list('/dir1/sub');
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((e) => e.name).sort()).toEqual(['.', '..', 'empty.txt'].sort());
    }
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('mkdir creates . and .. and bumps the parent link count', () => {
    const bytes = freshImage();
    const fs = open(bytes);
    const rootBefore = fs.stat('/');
    expect(rootBefore.ok).toBe(true);
    const m = fs.mkdir('/dir2');
    expect(m.ok).toBe(true);
    const deep = fs.mkdir('/dir2/deep');
    expect(deep.ok).toBe(true);

    const fs2 = open(bytes);
    const listed = fs2.list('/dir2');
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((e) => e.name).sort()).toEqual(['.', '..', 'deep'].sort());
      const dot = listed.value.find((e) => e.name === '.');
      const dotdot = listed.value.find((e) => e.name === '..');
      expect(dot?.stat.inode).toBe(m.ok ? m.value.inode : -1);
      expect(dotdot?.stat.inode).toBe(1);
    }
    const rootAfter = fs2.stat('/');
    if (rootBefore.ok && rootAfter.ok) {
      expect(rootAfter.value.nlinks).toBe(rootBefore.value.nlinks + 1);
    }
    // A file can live in the fresh directory.
    expect(fs2.writeFile('/dir2/deep/note.txt', ascii('deep note\n')).ok).toBe(true);
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('writes at exactly the cap succeed; one byte over refuses honestly', () => {
    const bytes = freshImage();
    const fs = open(bytes);
    // Free room check: the fixture has ~900 free zones; the cap file
    // needs 519+1. Replace huge.txt first to free its ~980 zones.
    expect(fs.writeFile('/huge.txt', ascii('shrunk\n')).ok).toBe(true);

    const over = fs.writeFile('/cap.bin', new Uint8Array(MINIX_MAX_WRITE_BYTES + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.kind).toBe('too-large');

    const content = patterned(MINIX_MAX_WRITE_BYTES);
    const at = fs.writeFile('/cap.bin', content);
    expect(at.ok, !at.ok ? `${at.kind} ${at.detail}` : '').toBe(true);
    const back = open(bytes).readFile('/cap.bin');
    expect(back.ok && sameBytes(back.value, content)).toBe(true);
    expect(fsckLite(bytes)).toEqual([]);
  });

  it('write errors are values and leave the image fsck-clean', () => {
    const bytes = freshImage();
    const fs = open(bytes);

    const longName = fs.writeFile('/fifteen-chars-x', ascii('x'));
    expect(!longName.ok && longName.kind === 'name-too-long').toBe(true);

    const noParent = fs.writeFile('/missing/x.txt', ascii('x'));
    expect(!noParent.ok && noParent.kind === 'not-found').toBe(true);

    const ontoDir = fs.writeFile('/dir1', ascii('x'));
    expect(!ontoDir.ok && ontoDir.kind === 'not-a-file').toBe(true);

    const throughFile = fs.writeFile('/README.txt/x', ascii('x'));
    expect(!throughFile.ok && throughFile.kind === 'not-a-directory').toBe(true);

    const rmDir = fs.remove('/dir1');
    expect(!rmDir.ok && rmDir.kind === 'not-a-file').toBe(true);

    const rmMissing = fs.remove('/nope.txt');
    expect(!rmMissing.ok && rmMissing.kind === 'not-found').toBe(true);

    const mkdirExists = fs.mkdir('/dir1');
    expect(!mkdirExists.ok && mkdirExists.kind === 'exists').toBe(true);

    const mkdirOverFile = fs.mkdir('/README.txt');
    expect(!mkdirOverFile.ok && mkdirOverFile.kind === 'exists').toBe(true);

    const rootWrite = fs.writeFile('/', ascii('x'));
    expect(!rootWrite.ok && rootWrite.kind === 'not-a-file').toBe(true);

    expect(fsckLite(bytes)).toEqual([]);
  });
});
