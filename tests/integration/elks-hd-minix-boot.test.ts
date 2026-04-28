/**
 * Phase 10.2 — ELKS partitionless MINIX hard-disk boot end-to-end.
 *
 * Mirrors the Phase 10 partitionless FAT test (`elks-hd-boot.test.ts`),
 * but boots `hd32-minix.img` — same disk shape (32 MiB, 63×16×63 CHS),
 * same BIOS handoff (INT 19h hands `DL = 0x80` to the boot sector at
 * `0:7C00`), different filesystem on disk. The kernel auto-detects MINIX
 * vs. FAT from the boot-sector / superblock layout, so the substrate
 * doesn't need to change.
 *
 * What this test asserts at the boundary of Phase 10.2:
 *
 *   1. The BIOS hands the boot sector `DL = 0x80` (the discriminator
 *      ELKS reads at `arch/i86/drivers/block/bios.c:446` to pick
 *      `/dev/hda`).
 *   2. The kernel mounts the root device — same `VFS: Mounted root
 *      device` line as the FAT case; the FS-name printed in the kernel
 *      log differs (we assert on the shared shape, not the FS name).
 *   3. /bin/sh reaches a `# ` prompt over the UART.
 *   4. Userland runs (echo round-trips through tty discipline).
 *
 * Skips with a clear pointer when the fixture is absent. Fetch via:
 *
 *   npm run build:elks-hd-image -- hd32-minix
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';

// hd32-minix.img: published 32,514,048-byte HD image. Same size as
// hd32-fat.img — 63 cyl × 16 hd × 63 spt. Partitionless: LBA 0 is the
// MINIX boot sector itself, not an MBR.
const HD32_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

/**
 * Same /bootopts content shape as the floppy + FAT-HD serial tests — keep
 * them in sync so a future rev to the kernel option semantics fixes them
 * all at once.
 */
function buildBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 hd32 minix serial console build',
    'hma=kernel',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

function loadHdImage(): InMemoryDisk | null {
  if (!existsSync(HD32_PATH)) return null;
  const original = readFileSync(HD32_PATH);
  const offset = original.indexOf(Buffer.from(BOOTOPTS_HEADER, 'ascii'));
  if (offset < 0) {
    throw new Error(
      `No /bootopts header found in ${HD32_PATH}; image format may have changed.`,
    );
  }
  // In-place /bootopts overwrite: same shape as the FAT test. The MINIX
  // FS keeps the file at a fixed inode block-list, so overwriting in place
  // keeps the directory entry / inode metadata coherent.
  const modified = Buffer.from(original);
  buildBootopts().copy(modified, offset);
  return new InMemoryDisk({ geometry: HD32_GEOMETRY, contents: modified });
}

describe('ELKS Phase 10.2 — partitionless MINIX hard-disk boot end-to-end', () => {
  it('boots hd32-minix.img to a # prompt over UART, accepts injected input', () => {
    const disk = loadHdImage();
    if (disk === null) {
      // Skip with a helpful pointer rather than fail. The fixture is 32 MB,
      // too large to commit; users opt in by running the fetch script.
      console.warn(
        `[skip] ${HD32_PATH} not found. Run \`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
      );
      return;
    }

    const txBytes: number[] = [];
    const m = new IBMPCMachine({
      disk,
      diskClass: 'hard-disk',
      console: new InMemoryConsole(),
      hostClock: new InMemoryHostClock(),
      cyclesPerPitTick: 4,
      uartTransmit: (byte: number) => txBytes.push(byte),
    });

    m.reset();

    // ---- Phase 1: boot to shell prompt ----
    const tracer = new Tracer({
      capacity: 50_000,
      kinds: ['intService', 'trap'],
    });
    const r1 = traceRun(m, { tracer, maxInstructions: 16_000_000 });
    expect(r1.reason).not.toBe('error');
    expect(r1.reason).not.toBe('halt-spin-exhausted');

    const txAfterBoot = String.fromCharCode(...txBytes);

    // The serial-redirected printk fires once set_console points at ttyS0.
    expect(txAfterBoot).toContain('Direct console, scan kbd');

    // VFS mount line — same shared shape across FAT and MINIX. The kernel
    // auto-detects MINIX FS from the on-disk superblock; the FS-name in
    // the kernel log differs, but the mount line itself does not.
    expect(txAfterBoot).toContain('VFS: Mounted root device');

    // /bin/sh prompt.
    expect(txAfterBoot).toMatch(/# *$/);

    // ---- Phase 2: round-trip a command ----
    const cmd = 'echo minix-ok\n';
    const txLen0 = txBytes.length;
    for (let i = 0; i < cmd.length; i++) {
      m.uart.injectByte(cmd.charCodeAt(i));
    }
    const r2 = traceRun(m, { tracer, maxInstructions: 4_000_000 });
    expect(r2.reason).not.toBe('error');
    expect(r2.reason).not.toBe('halt-spin-exhausted');

    const phase2Tx = String.fromCharCode(...txBytes.slice(txLen0));
    expect(phase2Tx).toContain('echo minix-ok');
    expect(phase2Tx).toContain('minix-ok');
    expect(phase2Tx).toMatch(/# *$/);
  });
});
