/**
 * Unit tests for the FAT12 probe-disk builder (Phase 12).
 *
 * Exercises the construction directly: build a disk, verify the BPB
 * bytes, walk the FAT chain, read files back. No machine boot — these
 * tests are pure data-structure checks.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProbeDisk,
  readProbeDiskFile,
  getFat12,
  FD1440_GEOMETRY,
} from './probe-disk.js';

const SECTOR_SIZE = 512;

describe('probe-disk FAT12 builder', () => {
  it('produces a 1.44 MB image with a stock FAT12 BPB', () => {
    const { bytes, geometry } = buildProbeDisk([
      { name: 'probe.sh', content: 'echo hi\n' },
    ]);
    expect(bytes.byteLength).toBe(1474560);
    expect(geometry).toEqual(FD1440_GEOMETRY);

    // BPB sanity checks (offsets per the FAT12 spec).
    // bytes/sector at offset 11 — little-endian 16-bit.
    expect(bytes[11]! | (bytes[12]! << 8)).toBe(SECTOR_SIZE);
    // sectors/cluster at offset 13.
    expect(bytes[13]).toBe(1);
    // reserved sectors at offset 14.
    expect(bytes[14]! | (bytes[15]! << 8)).toBe(1);
    // num FATs at offset 16.
    expect(bytes[16]).toBe(2);
    // root entries at offset 17.
    expect(bytes[17]! | (bytes[18]! << 8)).toBe(224);
    // total sectors (16-bit) at offset 19.
    expect(bytes[19]! | (bytes[20]! << 8)).toBe(2880);
    // media descriptor at offset 21.
    expect(bytes[21]).toBe(0xf0);
    // sectors/FAT at offset 22.
    expect(bytes[22]! | (bytes[23]! << 8)).toBe(9);
    // boot signature at 510-511.
    expect(bytes[510]).toBe(0x55);
    expect(bytes[511]).toBe(0xaa);
  });

  it('lays the first FAT entries down per spec (media + EOC markers)', () => {
    const { bytes } = buildProbeDisk([{ name: 'probe.sh', content: 'echo\n' }]);
    const fat = bytes.subarray(SECTOR_SIZE, SECTOR_SIZE + 9 * SECTOR_SIZE);
    // Entry 0: media descriptor in the low byte → 0xFF0 for 0xF0 media.
    expect(getFat12(fat, 0)).toBe(0xff0);
    // Entry 1: end-of-clusterchain seed → 0xFFF.
    expect(getFat12(fat, 1)).toBe(0xfff);
    // Entry 2 is the script's first cluster; for a tiny script it's
    // also the last → terminator 0xFFF.
    expect(getFat12(fat, 2)).toBe(0xfff);
  });

  it('chains multi-cluster files correctly', () => {
    // 1500 bytes ≈ 3 sectors. So clusters 2 → 3 → 4 → EOC.
    const big = 'x'.repeat(1500);
    const { bytes } = buildProbeDisk([{ name: 'big.txt', content: big }]);
    const fat = bytes.subarray(SECTOR_SIZE, SECTOR_SIZE + 9 * SECTOR_SIZE);
    expect(getFat12(fat, 2)).toBe(3);
    expect(getFat12(fat, 3)).toBe(4);
    expect(getFat12(fat, 4)).toBe(0xfff);
    // FAT 1 and FAT 2 must be byte-identical.
    const fat2 = bytes.subarray(SECTOR_SIZE * 10, SECTOR_SIZE * 19);
    expect(Array.from(fat.subarray(0, 64))).toEqual(Array.from(fat2.subarray(0, 64)));
  });

  it('round-trips file content via readProbeDiskFile', () => {
    const script = '#!/bin/sh\necho hello-from-probe\n';
    const data = 'arbitrary text\nwith multiple lines\n';
    const { bytes } = buildProbeDisk([
      { name: 'probe.sh', content: script },
      { name: 'data.txt', content: data },
    ]);
    const r1 = readProbeDiskFile(bytes, 'probe.sh');
    expect(r1).not.toBeNull();
    expect(new TextDecoder().decode(r1!)).toBe(script);
    const r2 = readProbeDiskFile(bytes, 'data.txt');
    expect(r2).not.toBeNull();
    expect(new TextDecoder().decode(r2!)).toBe(data);
    // Case-sensitivity: the writer uppercases internally; readProbeDiskFile
    // does the same lookup, so callers can use either case.
    const r3 = readProbeDiskFile(bytes, 'PROBE.SH');
    expect(r3).not.toBeNull();
    expect(new TextDecoder().decode(r3!)).toBe(script);
  });

  it('places file data at the cluster offset reported by fileOffsets', () => {
    const script = 'echo placed-here\n';
    const { bytes, fileOffsets } = buildProbeDisk([
      { name: 'a.sh', content: script },
    ]);
    expect(fileOffsets).toHaveLength(1);
    const f = fileOffsets[0]!;
    expect(f.cluster).toBe(2);
    expect(f.size).toBe(script.length);
    // Data area starts at sector 33 (1 reserved + 2*9 FAT + 14 root dir).
    const dataSectorOffset = 33 * SECTOR_SIZE;
    const slice = bytes.subarray(dataSectorOffset, dataSectorOffset + script.length);
    expect(new TextDecoder().decode(slice)).toBe(script);
  });

  it('handles binary (Uint8Array) file content unchanged', () => {
    const binary = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x42]);
    const { bytes } = buildProbeDisk([
      { name: 'bin.dat', content: binary },
    ]);
    const back = readProbeDiskFile(bytes, 'bin.dat');
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(binary));
  });

  it('rejects malformed filenames with a useful error', () => {
    expect(() =>
      buildProbeDisk([{ name: '', content: 'x' }]),
    ).toThrow(/1-8 chars/);
    expect(() =>
      buildProbeDisk([{ name: 'toolongname.sh', content: 'x' }]),
    ).toThrow(/1-8 chars/);
    expect(() =>
      buildProbeDisk([{ name: 'a.toolong', content: 'x' }]),
    ).toThrow(/0-3 chars/);
    expect(() =>
      buildProbeDisk([{ name: 'a/b.sh', content: 'x' }]),
    ).toThrow(/Invalid character/);
    expect(() =>
      buildProbeDisk([{ name: 'a.b.c', content: 'x' }]),
    ).toThrow(/more than one/);
  });

  it('rejects an empty file list (a probe with no script makes no sense)', () => {
    expect(() => buildProbeDisk([])).toThrow(/at least one file/);
  });

  it('produces deterministic output for the same input', () => {
    const a = buildProbeDisk([{ name: 'p.sh', content: 'echo\n' }]);
    const b = buildProbeDisk([{ name: 'p.sh', content: 'echo\n' }]);
    expect(Array.from(a.bytes.subarray(0, 1024))).toEqual(
      Array.from(b.bytes.subarray(0, 1024)),
    );
  });
});
