/**
 * ELKS ramdisk-over-serial integration test (Phase 11.6).
 *
 * Demonstrates the value of `fd1440-minix-serial.img`: a ramdisk
 * round-trip exercised over the UART rather than via keyboard
 * scancode injection. The FAT-serial image (Phase 8) cannot run this
 * test because FAT12 has no `/dev/rd0` device node; the MINIX-CGA
 * harness (Phase 11.5's `elks-ramdisk.test.ts`) can run the round-trip
 * but pays the keyboard-injection cost. The MINIX-serial image (this
 * brief, Phase 11.6) unifies the two: device nodes from MINIX, clean
 * UART TX transcript from the serial console.
 *
 * Sequence, run interactively from a `# ` shell:
 *
 *     ramdisk /dev/rd0 make 64    # 64 KB ramdisk
 *     mkfs /dev/rd0 64            # MINIX V1 filesystem
 *     mount /dev/rd0 /mnt
 *     echo hello-serial-ramdisk > /mnt/test
 *     cat /mnt/test               # → "hello-serial-ramdisk"
 *     umount /mnt
 *
 * Each command goes in via the UART RX FIFO (kernel tty line discipline
 * echoes raw bytes back through TX); the shell consumes them
 * sequentially. The kernel's `cat` writes the file content back to
 * /dev/console which is aliased to /dev/ttyS0, so the round-trip
 * payload appears in the TX byte stream.
 *
 * Why the in-place /bootopts edit at test setup time (rather than
 * loading a pre-built `fd1440-minix-serial.img`): the existing
 * `elks-serial.test.ts` does the same — the test stays runnable
 * without requiring a prior `npm run build:elks-serial-image-minix`,
 * and the edit logic is shared in spirit (same 1024-byte block, same
 * `## /bootopts` header lookup) with `tools/elks-build/build-serial-
 * image.ts`. Drift between the two would surface as either the build
 * tool or the test failing first; both wrap the same
 * `BOOTOPTS_HEADER` / `BOOTOPTS_SIZE` constants and the same content
 * lines.
 *
 * Instruction caps:
 *   - Phase 1 boot to `# ` prompt over UART: 8M (mirrors the FAT
 *     serial test's empirical ~3.6M with margin for the slightly
 *     different MINIX userland mount step).
 *   - Phase 2 ramdisk sequence: 60M. Generous, as in the keyboard-
 *     injection sibling test (which uses 50M for the same six
 *     commands); UART byte-by-byte feeding through line discipline
 *     adds a small overhead per character.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';

const FD1440 = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

/**
 * Build a /bootopts buffer that activates serial console + sh-as-init.
 * Must stay in sync with `tools/elks-build/build-serial-image.ts`'s
 * `buildBootopts()`; both produce identical bytes.
 */
function buildBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 serial console build',
    'hma=kernel',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

/**
 * Load `fd1440-minix.img` and apply the same in-place /bootopts edit
 * the build tool does, returning the modified image as an
 * `InMemoryDisk`. Returns null if the upstream image isn't present.
 */
function loadMinixSerialImage(): InMemoryDisk | null {
  const path = resolve('reference/elks-images', 'fd1440-minix.img');
  if (!existsSync(path)) return null;
  const original = readFileSync(path);
  const bootoptsOffset = original.indexOf(Buffer.from(BOOTOPTS_HEADER, 'ascii'));
  if (bootoptsOffset < 0) {
    throw new Error(`No /bootopts header found in fd1440-minix.img`);
  }
  // Copy + overwrite the 1K /bootopts in place. MINIX V1 inode
  // metadata (size, zone pointers) is unchanged because the file size
  // stays exactly 1024 bytes — same shape as the FAT case.
  const modified = Buffer.from(original);
  buildBootopts().copy(modified, bootoptsOffset);
  return new InMemoryDisk({ geometry: FD1440, contents: modified });
}

describe('ELKS Phase 11.6 — /dev/rd0 ramdisk round-trip over UART', () => {
  it('boots fd1440-minix-serial to # prompt and round-trips a file through ramdisk via UART', () => {
    const disk = loadMinixSerialImage();
    if (disk === null) {
      throw new Error(
        'reference/elks-images/fd1440-minix.img not found. Place ELKS images in that directory before running.',
      );
    }

    /** Captures every byte the UART transmits (the kernel's view of "TX"). */
    const txBytes: number[] = [];

    const m = new IBMPCMachine({
      disk,
      console: new InMemoryConsole(),
      hostClock: new InMemoryHostClock(),
      cyclesPerPitTick: 4,
      uartTransmit: (byte: number) => txBytes.push(byte),
    });

    m.reset();

    // ---- Phase 1: boot until the # prompt appears in TX -------------
    const tracer = new Tracer({
      capacity: 50_000,
      kinds: ['intService', 'trap'],
    });
    const r1 = traceRun(m, { tracer, maxInstructions: 8_000_000 });
    expect(r1.reason).not.toBe('error');
    expect(r1.reason).not.toBe('halt-spin-exhausted');

    const txAfterBoot = String.fromCharCode(...txBytes);

    // The post-set_console marker that confirms printk reaches /dev/ttyS0
    // (same invariant as elks-serial.test.ts; the kernel binary is
    // upstream-shared between the FAT and MINIX images).
    expect(txAfterBoot).toContain('Direct console, scan kbd');

    // The kernel mounted the MINIX root.
    expect(txAfterBoot).toContain('VFS: Mounted root device');

    // The `# ` shell prompt appears (init=/bin/sh prints `# ` before
    // the first read).
    expect(txAfterBoot).toMatch(/# *$/);

    // ---- Phase 2: ramdisk sequence over UART ------------------------
    //
    // The UART RX FIFO holds 16 bytes (`uart-16550.ts:63`). Injecting
    // an entire 150-byte sequence in one tight loop would overflow,
    // and any bytes beyond the 16th are silently dropped (matching
    // real 16550A behaviour). We feed one command at a time, then run
    // the emulator long enough for the kernel's tty line discipline
    // to consume the line, fork+exec the binary, run it, and emit a
    // fresh `# ` prompt — same shape as `run-serial.ts`'s pump-then-
    // run interval, just bounded by `traceRun` budgets instead of a
    // wall-clock interval.
    const txLenBeforeSequence = txBytes.length;

    const commands: readonly { line: string; budget: number }[] = [
      // ramdisk make: ~25 chars, then ioctl + reply.
      { line: 'ramdisk /dev/rd0 make 64\n', budget: 6_000_000 },
      // mkfs writes blocks; the larger budget covers the I/O.
      { line: 'mkfs /dev/rd0 64\n',         budget: 12_000_000 },
      // mount: superblock read + minor bookkeeping.
      { line: 'mount /dev/rd0 /mnt\n',      budget: 8_000_000 },
      // echo writes one block to the freshly-mounted ramdisk.
      { line: 'echo hello-serial-ramdisk > /mnt/test\n', budget: 8_000_000 },
      // cat: open + read + write back through tty.
      { line: 'cat /mnt/test\n',            budget: 8_000_000 },
      // umount: sync + release.
      { line: 'umount /mnt\n',              budget: 8_000_000 },
    ];

    for (const { line, budget } of commands) {
      // Feed the command in ≤16-byte chunks so the RX FIFO never
      // overflows. Between chunks we run a small slice of the
      // emulator; the kernel's serfast handler drains the entire FIFO
      // per IRQ 4 delivery, so we don't accumulate a backlog.
      for (let off = 0; off < line.length; off += 12) {
        const chunk = line.slice(off, off + 12);
        for (let i = 0; i < chunk.length; i++) {
          m.uart.injectByte(chunk.charCodeAt(i));
        }
        const rChunk = traceRun(m, { tracer, maxInstructions: 200_000 });
        expect(rChunk.reason).not.toBe('error');
        expect(rChunk.reason).not.toBe('halt-spin-exhausted');
      }
      const rCmd = traceRun(m, { tracer, maxInstructions: budget });
      expect(rCmd.reason).not.toBe('error');
      expect(rCmd.reason).not.toBe('halt-spin-exhausted');
    }

    const phase2Tx = String.fromCharCode(...txBytes.slice(txLenBeforeSequence));

    // The `ramdisk` userland tool's success message:
    //   "ramdisk: 64Kb ramdisk created on /dev/rd0\n"
    // (see `elkscmd/disk_utils/ramdisk.c:48-52`).
    expect(phase2Tx).toContain('Kb ramdisk created on /dev/rd0');

    // The round-trip payload — `cat` reads from /mnt/test (which lives
    // on the freshly-formatted, freshly-mounted in-RAM filesystem) and
    // writes back to /dev/console aka /dev/ttyS0.
    expect(phase2Tx).toContain('hello-serial-ramdisk');

    // No allocator / generic-error surface.
    expect(phase2Tx).not.toContain('Cannot allocate memory');
    expect(phase2Tx).not.toContain('out of memory');
  }, 60_000);
});
