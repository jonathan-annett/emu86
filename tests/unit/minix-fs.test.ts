/**
 * MINIX v1 read-only module vs the guest-written fixture (Phase 16 M1).
 *
 * The fixture (`tests/fixtures/minix-v1-2048.img`) was formatted and
 * populated by the REAL ELKS guest — its mkfs, its shell, its cp —
 * via the env-gated generator in
 * tests/integration/minix-fixture-gen.test.ts. Provenance and the
 * exact population script: tests/fixtures/README.md. Keep the
 * expected tree here in lockstep with that script.
 *
 * Acceptance (brief §3 M1): byte-exact readFile for every fixture
 * file including the indirect-zone one; list('/') matches the tree;
 * graceful verdicts on a FAT image and on zeros.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openMinixImage, type MinixFileSystem } from '../../src/disk/minix-fs.js';
import { buildProbeDisk } from '../probe/probe-disk.js';

const FIXTURE_PATH = resolve('tests/fixtures', 'minix-v1-2048.img');

/* The generator's population script, replayed as host-side bytes.
 * `echo X > f` writes X plus one newline. */
const SEED_LINE = '0123456789-emu86-minix-v1-fixture-seed-line-0123456789abcdef\n';
const SEED_CONTENT = SEED_LINE.repeat(16); // 4 in-guest doublings
const BIG_CONTENT = 'abcdefghijklmnop'
  .split('')
  .map((f) => `chunk-${f}\n${SEED_CONTENT}`)
  .join('');

const ascii = (s: string): Uint8Array =>
  new Uint8Array([...s].map((c) => c.charCodeAt(0)));

function openFixture(): MinixFileSystem {
  const raw = readFileSync(FIXTURE_PATH);
  const opened = openMinixImage(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  if (!opened.ok) {
    throw new Error(`fixture failed to open: ${opened.kind} — ${opened.detail}`);
  }
  return opened.fs;
}

const fixturePresent = existsSync(FIXTURE_PATH);
if (!fixturePresent) {
  console.warn(
    `[skip] ${FIXTURE_PATH} missing — regenerate with ` +
      'MINIX_FIXTURE_GEN=1 npx vitest run tests/integration/minix-fixture-gen.test.ts',
  );
}
const withFixture = fixturePresent ? describe : describe.skip;

withFixture('minix-fs vs the guest-written fixture', () => {
  it('opens with the superblock facts ELKS mkfs wrote', () => {
    const fs = openFixture();
    expect(fs.superblock.magic).toBe(0x137f);
    expect(fs.superblock.nameLen).toBe(14);
    expect(fs.superblock.nzones).toBe(2048);
    expect(fs.superblock.logZoneSize).toBe(0);
    expect(fs.superblock.firstDataZone).toBeGreaterThan(2);
  });

  it("list('/') matches the generated tree (deleted doomed.txt is gone)", () => {
    const fs = openFixture();
    const listed = fs.list('/');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const names = listed.value.map((e) => e.name).sort();
    expect(names).toEqual(
      [
        '.', '..', 'README.txt', 'abcdefghijklmn', 'big.txt', 'binblob',
        'dir1', 'huge.txt', 'seed.txt',
      ].sort(),
    );
    // Root's '.' and '..' both point at inode 1.
    const dot = listed.value.find((e) => e.name === '.');
    const dotdot = listed.value.find((e) => e.name === '..');
    expect(dot?.stat.inode).toBe(1);
    expect(dotdot?.stat.inode).toBe(1);
    const dir1 = listed.value.find((e) => e.name === 'dir1');
    expect(dir1?.stat.type).toBe('dir');
  });

  it('subdirectories list correctly (dir1, dir1/sub)', () => {
    const fs = openFixture();
    const dir1 = fs.list('/dir1');
    expect(dir1.ok).toBe(true);
    if (!dir1.ok) return;
    expect(dir1.value.map((e) => e.name).sort()).toEqual(
      ['.', '..', 'nested.txt', 'sub'].sort(),
    );
    const sub = fs.list('/dir1/sub');
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    expect(sub.value.map((e) => e.name).sort()).toEqual(['.', '..', 'empty.txt'].sort());
  });

  it('readFile is byte-exact for the small text files', () => {
    const fs = openFixture();
    for (const [path, content] of [
      ['/README.txt', 'emu86 minix-fs fixture rev 1\n'],
      ['/abcdefghijklmn', 'fourteen\n'],
      ['/dir1/nested.txt', 'nested file content\n'],
      ['/seed.txt', SEED_CONTENT],
    ] as const) {
      const read = fs.readFile(path);
      expect(read.ok, `${path} should read`).toBe(true);
      if (!read.ok) continue;
      expect(read.value, path).toEqual(ascii(content));
    }
  });

  it('readFile is byte-exact across the indirect-zone boundary (big.txt)', () => {
    const fs = openFixture();
    const st = fs.stat('/big.txt');
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    // > 7 KB means blocks 7+ resolve through the indirect table.
    expect(st.value.sizeBytes).toBe(BIG_CONTENT.length);
    expect(st.value.sizeBytes).toBeGreaterThan(7 * 1024);

    const read = fs.readFile('/big.txt');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const expected = ascii(BIG_CONTENT);
    expect(read.value.byteLength).toBe(expected.byteLength);
    // Byte loop, not toEqual — deep-equal on big typed arrays is ~90 s
    // per assert (see DRIVE_FORKS_REPORT.md §5).
    let firstDiff = -1;
    for (let i = 0; i < expected.byteLength; i += 1) {
      if (read.value[i] !== expected[i]) { firstDiff = i; break; }
    }
    expect(firstDiff, `first differing byte at ${firstDiff}`).toBe(-1);
  });

  it('readFile is byte-exact across the DOUBLE-indirect boundary (huge.txt)', () => {
    const fs = openFixture();
    // seed (976 B) doubled 10 more times in-guest: 976 × 1024 bytes —
    // past 7 KB direct + 512 KB indirect, into the double-indirect
    // chain. The 61-byte line is coprime with the 1 KB block, so each
    // block has a distinct phase — chain-indexing bugs can't hide.
    const expectedLen = SEED_LINE.length * 16 * 1024;
    expect(expectedLen).toBeGreaterThan((7 + 512) * 1024);

    const st = fs.stat('/huge.txt');
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    expect(st.value.sizeBytes).toBe(expectedLen);

    const read = fs.readFile('/huge.txt');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.byteLength).toBe(expectedLen);
    const line = ascii(SEED_LINE);
    let firstDiff = -1;
    for (let i = 0; i < expectedLen; i += 1) {
      if (read.value[i] !== line[i % line.byteLength]) { firstDiff = i; break; }
    }
    expect(firstDiff, `first differing byte at ${firstDiff}`).toBe(-1);
  });

  it('a zero-byte file reads as zero bytes', () => {
    const fs = openFixture();
    const read = fs.readFile('/dir1/sub/empty.txt');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.byteLength).toBe(0);
  });

  it('the binary blob (a real ELKS executable) round-trips', () => {
    const fs = openFixture();
    const st = fs.stat('/binblob');
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    expect(st.value.type).toBe('file');
    expect(st.value.sizeBytes).toBeGreaterThan(0);
    const read = fs.readFile('/binblob');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.byteLength).toBe(st.value.sizeBytes);
    // ELKS executables are a.out: first byte of the header magic.
    expect(read.value[0]).toBe(0x01);
    expect(read.value[1]).toBe(0x03);
  });

  it('stat carries mode/type/links; mtime is a plausible clock', () => {
    const fs = openFixture();
    const st = fs.stat('/dir1');
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    expect(st.value.type).toBe('dir');
    expect(st.value.nlinks).toBeGreaterThanOrEqual(2); // . and parent entry
    const f = fs.stat('/README.txt');
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.value.type).toBe('file');
    expect(f.value.mtime).toBeGreaterThan(0);
  });

  it('path errors are values: not-found / not-a-directory / not-a-file', () => {
    const fs = openFixture();

    const missing = fs.stat('/nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.kind).toBe('not-found');

    // 16 chars can never exist on a 14-char fs — honestly not-found.
    const tooLong = fs.stat('/abcdefghijklmnop');
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.kind).toBe('not-found');

    const notDir = fs.list('/README.txt');
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) expect(notDir.kind).toBe('not-a-directory');

    const notFile = fs.readFile('/dir1');
    expect(notFile.ok).toBe(false);
    if (!notFile.ok) expect(notFile.kind).toBe('not-a-file');

    const throughFile = fs.stat('/README.txt/x');
    expect(throughFile.ok).toBe(false);
    if (!throughFile.ok) expect(throughFile.kind).toBe('not-a-directory');
  });

  it('path normalization: //dir1///sub and dir1/sub resolve alike', () => {
    const fs = openFixture();
    const a = fs.stat('//dir1///sub');
    const b = fs.stat('/dir1/sub');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.inode).toBe(b.value.inode);
    const root = fs.stat('/');
    expect(root.ok).toBe(true);
    if (root.ok) expect(root.value.inode).toBe(1);
  });
});

describe('minix-fs graceful verdicts on non-MINIX bytes', () => {
  it('all-zeros: not-minix, not a throw', () => {
    const r = openMinixImage(new Uint8Array(64 * 1024));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('not-minix');
  });

  it('a real FAT12 image: not-minix', () => {
    const fat = buildProbeDisk([{ name: 'probe.sh', content: 'echo hi\n' }]);
    const r = openMinixImage(fat.bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('not-minix');
  });

  it('an image smaller than boot+super: not-minix', () => {
    const r = openMinixImage(new Uint8Array(100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('not-minix');
  });

  it('MINIX v2 magic: unsupported, named as such', () => {
    const bytes = new Uint8Array(4 * 1024);
    new DataView(bytes.buffer).setUint16(1024 + 16, 0x2468, true);
    const r = openMinixImage(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('unsupported');
      expect(r.detail).toContain('v2');
    }
  });

  it('a truncated image (superblock claims more blocks): corrupt', () => {
    if (!fixturePresent) return;
    const raw = readFileSync(FIXTURE_PATH);
    const truncated = new Uint8Array(raw.buffer, raw.byteOffset, 4 * 1024);
    const r = openMinixImage(truncated);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('corrupt');
  });

  it('a wiped inode table behind a valid superblock: corrupt at open', () => {
    if (!fixturePresent) return;
    const raw = readFileSync(FIXTURE_PATH);
    const copy = new Uint8Array(raw); // fresh copy — we mutate it
    // Zero everything past the superblock: maps + inode table + data.
    copy.fill(0, 2 * 1024);
    const r = openMinixImage(copy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('corrupt');
  });
});
