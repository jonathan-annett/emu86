/**
 * Phase 11 — ELKS multi-disk boot end-to-end.
 *
 * Boots `hd32-fat.img` as primary (with the serial-console /bootopts
 * patch from `elks-hd-boot.test.ts`) and `hd32-minix.img` as a secondary.
 * The kernel's HD probe loop iterates DL=0x80, 0x81... at INT 13h AH=08h
 * (cite: ELKS arch/i86/drivers/block/bios.c:205-250). With both slots
 * filled we expect the boot banner to mention `hda:` and `hdb:`.
 *
 * The pair-up choice (`hd32-fat.img` + `hd32-minix.img`) follows the
 * brief's guidance — both fixtures already exist as Phase 10/10.2
 * artifacts; no new fetches.
 *
 * Skips when fixtures are absent (CI without `npm run build:elks-hd-image`).
 *
 * What this test pins:
 *
 *   1. The BIOS reports drive count = 2 to AH=08h DL=0x80.
 *   2. The BIOS routes DL=0x81 INT 13h reads to the secondary disk's
 *      bytes (verified indirectly by the kernel reading both disks'
 *      partition tables / superblocks during probe — kernel banner
 *      mentions both).
 *   3. The single-disk boot path remains unchanged (the second test
 *      below boots the same primary alone and asserts the same prompt).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';

const HD32_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD32_FAT_PATH = resolve('reference/elks-images-hd', 'hd32-fat.img');
const HD32_MINIX_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

function buildBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 hd32 multi-disk serial console build',
    'hma=kernel',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

function loadHdFatPrimary(): InMemoryDisk | null {
  if (!existsSync(HD32_FAT_PATH)) return null;
  const original = readFileSync(HD32_FAT_PATH);
  const offset = original.indexOf(Buffer.from(BOOTOPTS_HEADER, 'ascii'));
  if (offset < 0) {
    throw new Error(
      `No /bootopts header found in ${HD32_FAT_PATH}; image format may have changed.`,
    );
  }
  const modified = Buffer.from(original);
  buildBootopts().copy(modified, offset);
  return new InMemoryDisk({ geometry: HD32_GEOMETRY, contents: modified });
}

function loadHdMinixSecondary(): InMemoryDisk | null {
  if (!existsSync(HD32_MINIX_PATH)) return null;
  const bytes = readFileSync(HD32_MINIX_PATH);
  return new InMemoryDisk({ geometry: HD32_GEOMETRY, contents: bytes });
}

describe('ELKS Phase 11 — multi-disk boot end-to-end', () => {
  it('boots hd32-fat (primary) + hd32-minix (secondary), kernel sees both as hda + hdb', () => {
    const primary = loadHdFatPrimary();
    const secondary = loadHdMinixSecondary();
    if (primary === null || secondary === null) {
      console.warn(
        `[skip] ${HD32_FAT_PATH} or ${HD32_MINIX_PATH} not found. ` +
        `Run \`npm run build:elks-hd-image\` and \`npm run build:elks-hd-minix\` to fetch.`,
      );
      return;
    }

    const txBytes: number[] = [];
    const m = new IBMPCMachine({
      disk: primary,
      diskClass: 'hard-disk',
      secondaryDisk: secondary,
      secondaryDiskClass: 'hard-disk',
      console: new InMemoryConsole(),
      hostClock: new InMemoryHostClock(),
      cyclesPerPitTick: 4,
      uartTransmit: (byte: number) => txBytes.push(byte),
    });

    m.reset();

    const tracer = new Tracer({
      capacity: 50_000,
      kinds: ['intService', 'trap'],
    });
    const r1 = traceRun(m, { tracer, maxInstructions: 16_000_000 });
    expect(r1.reason).not.toBe('error');
    expect(r1.reason).not.toBe('halt-spin-exhausted');

    const txAfterBoot = String.fromCharCode(...txBytes);

    // VFS root mount confirms primary boots normally — the multi-disk path
    // didn't break the single-disk root-device flow.
    expect(txAfterBoot).toContain('VFS: Mounted root device');

    // Both drives must surface in the kernel HD probe banner. The kernel
    // calls AH=08h with DL=0x80 to get count, then iterates 0x80/0x81 to
    // pull each drive's CHS. With both attached, both `hda:` and `hdb:`
    // print.
    expect(txAfterBoot).toMatch(/hda:/);
    expect(txAfterBoot).toMatch(/hdb:/);

    // /bin/sh prompt.
    expect(txAfterBoot).toMatch(/# *$/);
  });

  it('boots hd32-fat (primary alone, no secondary) — single-disk regression', () => {
    // Same primary, NO secondary attached. The pre-Phase-11 single-disk
    // path must still reach the prompt. This guards against the multi-disk
    // refactor accidentally changing the behaviour when only one slot is
    // filled.
    const primary = loadHdFatPrimary();
    if (primary === null) {
      console.warn(
        `[skip] ${HD32_FAT_PATH} not found. Run \`npm run build:elks-hd-image\` to fetch.`,
      );
      return;
    }

    const txBytes: number[] = [];
    const m = new IBMPCMachine({
      disk: primary,
      diskClass: 'hard-disk',
      console: new InMemoryConsole(),
      hostClock: new InMemoryHostClock(),
      cyclesPerPitTick: 4,
      uartTransmit: (byte: number) => txBytes.push(byte),
    });

    m.reset();

    const tracer = new Tracer({ capacity: 50_000, kinds: ['intService', 'trap'] });
    const r = traceRun(m, { tracer, maxInstructions: 16_000_000 });
    expect(r.reason).not.toBe('error');
    expect(r.reason).not.toBe('halt-spin-exhausted');

    const tx = String.fromCharCode(...txBytes);
    expect(tx).toContain('VFS: Mounted root device');
    expect(tx).toMatch(/hda:/);
    // hdb: must NOT appear when only primary is attached.
    expect(tx).not.toMatch(/hdb:/);
    expect(tx).toMatch(/# *$/);
  });
});
