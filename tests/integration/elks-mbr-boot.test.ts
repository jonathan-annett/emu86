/**
 * Phase 10.1 — ELKS hard-disk boot via MBR-partitioned image.
 *
 * Mirrors the Phase 10 partitionless HD test but boots an MBR-partitioned
 * image: the BIOS reads sector 0 (the MBR) into 0:7C00, the MBR's own code
 * relocates itself to 0:0600, parses the partition table, loads the VBR
 * from the active partition's start LBA via INT 13h AH=02h, and chain-loads
 * the FAT/MINIX boot sector from there. The substrate handles all of that
 * unchanged — this test just confirms it.
 *
 * Inspect the actual MBR (`reference/elks-images-hd/hd32mbr-fat.img`,
 * first 512 bytes) for the bytecode this test exercises end-to-end:
 *
 *   - MBR relocates 0:7C00 → 0:0600 (rep movsw + retf 0:0021).
 *   - Optionally interactive: prints "Welcome to ELKS MBR Boot Manager",
 *     prompts "MBR: ", waits ~3 seconds via INT 16h AH=01h + INT 1Ah AH=00
 *     polling. With no key pressed it auto-boots the active partition.
 *   - Active partition entry 0: boot flag 0x80, type 0x80, start CHS
 *     [head=1, sector=1, cylinder=0] = LBA 63.
 *   - Reads VBR with INT 13h AH=02h to ES:BX = 0:7C00, verifies 0xAA55,
 *     restores DH and far-jumps to the VBR.
 *
 * The MBR's auto-boot timeout polls INT 1Ah AH=00 (ticks). The default
 * `InMemoryHostClock` is frozen, so the MBR's `cmp dx, si; je loop`
 * spins forever; we use an auto-advancing clock so virtual ticks do
 * elapse. This is local to the test, not a substrate change.
 *
 * Skips with a clear pointer when the fixture is absent. Fetch via:
 *
 *   npm run build:elks-hd-mbr-images
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import {
  InMemoryHostClock,
  type HostClock,
  type HostTime,
} from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';

// hd32mbr-*.img: 32,546,304 bytes (one extra cylinder of zero-padding vs.
// the partitionless variant) → 64 cyl × 16 hd × 63 spt = 32,514,048 used,
// rounded up to 64 × 16 × 63 × 512 = 32,514,048... actually the next-larger
// geometry allocates 64×16×63×512 = 32,514,048 bytes; the image's extra
// 32,256 bytes are exactly one cylinder (16 × 63 × 32 = 32,256). The disk
// zero-pads to 32,544,768 in the next-larger 65×16×63 layout — but Phase
// 10's worker host maps these to 64×16×63 and InMemoryDisk truncates the
// load to the geometry. We use the geometry the worker host uses.
const HD32MBR_GEOMETRY = { cylinders: 64, heads: 16, sectorsPerTrack: 63 };
const FAT_PATH = resolve('reference/elks-images-hd', 'hd32mbr-fat.img');
const MINIX_PATH = resolve('reference/elks-images-hd', 'hd32mbr-minix.img');

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

function buildBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 hd32-mbr serial console build',
    'hma=kernel',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

function loadImage(path: string): InMemoryDisk | null {
  if (!existsSync(path)) return null;
  const original = readFileSync(path);
  const offset = original.indexOf(Buffer.from(BOOTOPTS_HEADER, 'ascii'));
  if (offset < 0) {
    throw new Error(
      `No /bootopts header found in ${path}; image format may have changed.`,
    );
  }
  const modified = Buffer.from(original);
  buildBootopts().copy(modified, offset);
  return new InMemoryDisk({ geometry: HD32MBR_GEOMETRY, contents: modified });
}

/**
 * Auto-advancing clock — each `now()` call advances the underlying
 * InMemoryHostClock by `stepMs` milliseconds. Used to break the MBR's
 * tick-polling loop without spending real wall time waiting.
 *
 * The MBR loop reads ticks (INT 1Ah AH=00) and decrements its counter
 * only when the low word of the tick count changes. One tick is ~55 ms
 * (1 / 18.2 Hz). Stepping 60 ms per call ensures every read sees a
 * different tick value, so the 50-iteration counter completes in 50
 * `now()` calls — fractions of a second of test time.
 */
class AutoAdvanceHostClock implements HostClock {
  readonly #base = new InMemoryHostClock();
  readonly #stepMs: number;
  constructor(stepMs: number) {
    this.#stepMs = stepMs;
  }
  now(): HostTime {
    this.#base.advance(this.#stepMs);
    return this.#base.now();
  }
}

describe('ELKS Phase 10.1 — MBR-partitioned hard-disk boot', () => {
  it('boots hd32mbr-fat.img to a # prompt over UART, accepts injected input', () => {
    const disk = loadImage(FAT_PATH);
    if (disk === null) {
      console.warn(
        `[skip] ${FAT_PATH} not found. Run \`npm run build:elks-hd-mbr-images\` to fetch it.`,
      );
      return;
    }

    const txBytes: number[] = [];
    const m = new IBMPCMachine({
      disk,
      diskClass: 'hard-disk',
      console: new InMemoryConsole(),
      hostClock: new AutoAdvanceHostClock(60),
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

    // The serial-redirected printk fires once set_console points at ttyS0.
    expect(txAfterBoot).toContain('Direct console, scan kbd');

    // VFS mount line — confirms kernel parsed the MBR partition table,
    // matched the SETUP_PART_OFFSET against partition 1, and mounted that
    // partition rather than the raw disk.
    expect(txAfterBoot).toContain('VFS: Mounted root device');

    // /bin/sh prompt.
    expect(txAfterBoot).toMatch(/# *$/);

    // ---- round-trip a command ----
    const cmd = 'echo mbr-ok\n';
    const txLen0 = txBytes.length;
    for (let i = 0; i < cmd.length; i++) {
      m.uart.injectByte(cmd.charCodeAt(i));
    }
    const r2 = traceRun(m, { tracer, maxInstructions: 4_000_000 });
    expect(r2.reason).not.toBe('error');
    expect(r2.reason).not.toBe('halt-spin-exhausted');

    const phase2Tx = String.fromCharCode(...txBytes.slice(txLen0));
    expect(phase2Tx).toContain('echo mbr-ok');
    expect(phase2Tx).toContain('mbr-ok');
    expect(phase2Tx).toMatch(/# *$/);
  });

  it('boots hd32mbr-minix.img to a # prompt over UART', () => {
    const disk = loadImage(MINIX_PATH);
    if (disk === null) {
      console.warn(
        `[skip] ${MINIX_PATH} not found. Run \`npm run build:elks-hd-mbr-images\` to fetch it.`,
      );
      return;
    }

    const txBytes: number[] = [];
    const m = new IBMPCMachine({
      disk,
      diskClass: 'hard-disk',
      console: new InMemoryConsole(),
      hostClock: new AutoAdvanceHostClock(60),
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
    expect(txAfterBoot).toContain('Direct console, scan kbd');
    expect(txAfterBoot).toContain('VFS: Mounted root device');
    expect(txAfterBoot).toMatch(/# *$/);
  });
});
