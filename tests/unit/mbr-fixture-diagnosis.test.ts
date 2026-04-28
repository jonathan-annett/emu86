/**
 * Phase 10.1 — pinning tests for the MBR fixture's on-disk structure.
 *
 * These tests assert the byte-level layout we relied on during diagnosis
 * (Section 1 of the brief): boot signature, active partition entry,
 * start LBA, partition type, and the MBR's own use of authentic CHS
 * INT 13h AH=02h reads (i.e., NO LBA extensions). If a future upstream
 * release of ghaerr/elks ships a re-shaped MBR — say one that switches
 * to AH=42h — these tests fail loudly instead of the integration test
 * silently failing in a hard-to-diagnose place.
 *
 * Skips when the fixture is absent. Fetch via:
 *
 *   npm run build:elks-hd-mbr-images
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FAT_PATH = resolve('reference/elks-images-hd', 'hd32mbr-fat.img');

describe('MBR fixture diagnosis (hd32mbr-fat.img)', () => {
  function loadMbrOrSkip(): Buffer | null {
    if (!existsSync(FAT_PATH)) {
      console.warn(
        `[skip] ${FAT_PATH} not found. Run \`npm run build:elks-hd-mbr-images\` to fetch it.`,
      );
      return null;
    }
    const buf = readFileSync(FAT_PATH);
    return buf.subarray(0, 512);
  }

  it('boot signature at 0x1FE is 0x55 0xAA', () => {
    const mbr = loadMbrOrSkip();
    if (mbr === null) return;
    expect(mbr[0x1FE]).toBe(0x55);
    expect(mbr[0x1FF]).toBe(0xAA);
  });

  it('partition table entry 0 is the active boot partition', () => {
    const mbr = loadMbrOrSkip();
    if (mbr === null) return;
    const e = 0x1BE;
    expect(mbr[e + 0]).toBe(0x80);                 // boot flag
    expect(mbr.readUInt32LE(e + 8)).toBe(63);      // start LBA
    expect(mbr.readUInt32LE(e + 12)).toBe(63441);  // sector count (~31 MB)
  });

  it('start CHS in the partition entry matches start LBA on the disk geometry', () => {
    // Disk geometry for hd32mbr-*.img in our worker host's table is
    // 64 cyl × 16 hd × 63 spt. Start CHS [head=1, sec=1, cyl=0]
    // converts to LBA = (cyl × heads + head) × spt + (sec - 1)
    //                 = (0 × 16 + 1) × 63 + (1 - 1) = 63.
    const mbr = loadMbrOrSkip();
    if (mbr === null) return;
    const e = 0x1BE;
    const head = mbr[e + 1]!;
    const cs = mbr[e + 2]!;
    const ch = mbr[e + 3]!;
    const sector = cs & 0x3F;
    const cylinder = ((cs & 0xC0) << 2) | ch;
    expect(head).toBe(1);
    expect(sector).toBe(1);
    expect(cylinder).toBe(0);
    const heads = 16, spt = 63;
    const lba = (cylinder * heads + head) * spt + (sector - 1);
    expect(lba).toBe(63);
    expect(mbr.readUInt32LE(e + 8)).toBe(lba);
  });

  it('partition entries 1, 2, 3 are zero (only one primary partition)', () => {
    const mbr = loadMbrOrSkip();
    if (mbr === null) return;
    for (let i = 1; i < 4; i++) {
      const e = 0x1BE + i * 16;
      for (let j = 0; j < 16; j++) {
        expect(mbr[e + j]).toBe(0);
      }
    }
  });

  it('MBR bootstrap uses INT 13h AH=02h (CHS read), not LBA extensions', () => {
    // We diagnose the MBR uses authentic CHS reads — this is the load-
    // bearing fact for Outcome A (no substrate change required). Pinning:
    // the bytecode contains `b8 01 02` (mov ax, 0x0201) but does NOT
    // contain `b4 41` (extensions check) or `b4 42` (LBA read).
    const mbr = loadMbrOrSkip();
    if (mbr === null) return;
    const code = mbr.subarray(0, 0x1BE);  // bootstrap region

    // Search for the AH=0x02 read setup (mov ax, 0x0201).
    let foundChsRead = false;
    for (let i = 0; i < code.length - 2; i++) {
      if (code[i] === 0xB8 && code[i + 1] === 0x01 && code[i + 2] === 0x02) {
        foundChsRead = true;
        break;
      }
    }
    expect(foundChsRead).toBe(true);

    // Search for AH=0x41 (mov ah, 0x41 = b4 41) and AH=0x42 (b4 42)
    // — must be absent.
    let foundExtensionsCheck = false;
    let foundLbaRead = false;
    for (let i = 0; i < code.length - 1; i++) {
      if (code[i] === 0xB4 && code[i + 1] === 0x41) foundExtensionsCheck = true;
      if (code[i] === 0xB4 && code[i + 1] === 0x42) foundLbaRead = true;
    }
    expect(foundExtensionsCheck).toBe(false);
    expect(foundLbaRead).toBe(false);
  });

  it('MBR boot manager strings are present (informational)', () => {
    // Strings let us identify this as the ELKS MBR Boot Manager rather
    // than a generic MS-DOS / FreeDOS / GRUB MBR. If upstream switches
    // MBR codebases, the integration test may need re-diagnosis.
    const mbr = loadMbrOrSkip();
    if (mbr === null) return;
    const ascii = mbr.toString('ascii');
    expect(ascii).toContain('Welcome to ELKS MBR Boot Manager');
    expect(ascii).toContain('Disk read error');
    expect(ascii).toContain('No bootable partition');
  });
});
