/**
 * Editor panel file-walk + binary policy (Phase 16 M4) against the
 * guest-written fixture. The DOM half of the panel has no unit
 * coverage (the repo has no DOM test environment — recorded in the
 * M4 report); everything decision-shaped lives in these pure
 * functions instead, exactly so it CAN be tested here.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openMinixImage } from '../../src/disk/minix-fs.js';
import {
  EDITOR_MAX_FILE_BYTES,
  bytesToLatin1,
  isProbablyBinary,
  latin1ToBytes,
  listEditableFiles,
} from '../../web/editor-files.js';

const FIXTURE_PATH = resolve('tests/fixtures', 'minix-v1-2048.img');
const fixturePresent = existsSync(FIXTURE_PATH);
const withFixture = fixturePresent ? describe : describe.skip;
if (!fixturePresent) {
  console.warn(`[skip] ${FIXTURE_PATH} missing — see tests/fixtures/README.md`);
}

function fixtureFs() {
  const raw = readFileSync(FIXTURE_PATH);
  const r = openMinixImage(new Uint8Array(raw));
  if (!r.ok) throw new Error(`${r.kind}: ${r.detail}`);
  return r.fs;
}

describe('binary sniff + latin1 round-trip', () => {
  it('NUL in the first 512 bytes means binary; clean text does not', () => {
    expect(isProbablyBinary(new Uint8Array([0x68, 0x69, 0x00]))).toBe(true);
    expect(isProbablyBinary(latin1ToBytes('int main(void) { return 0; }\n'))).toBe(false);
    // A NUL past the sniff window is not seen — policy, documented.
    const lateNul = new Uint8Array(600).fill(0x61);
    lateNul[550] = 0;
    expect(isProbablyBinary(lateNul)).toBe(false);
    expect(isProbablyBinary(new Uint8Array(0))).toBe(false);
  });

  it('latin1 helpers round-trip every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect(latin1ToBytes(bytesToLatin1(all))).toEqual(all);
  });
});

withFixture('listEditableFiles on the guest-written fixture', () => {
  it('finds the text tree; skips the blob and the oversized file, listed', () => {
    const { files, skipped } = listEditableFiles(fixtureFs());
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([
      '/README.txt',
      '/abcdefghijklmn',
      '/big.txt',
      '/dir1/nested.txt',
      '/dir1/sub/empty.txt', // zero bytes: no NULs, honestly text
      '/seed.txt',
    ]);
    // The real ELKS executable is skipped as binary; huge.txt (976 KB)
    // is over the 256 KB editor cap — both LISTED, not hidden.
    expect(skipped).toContainEqual({ path: '/binblob', reason: 'binary' });
    expect(skipped).toContainEqual({ path: '/huge.txt', reason: 'too-large' });
    expect(EDITOR_MAX_FILE_BYTES).toBe(256 * 1024);
  });
});
