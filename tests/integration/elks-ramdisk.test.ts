/**
 * ELKS ramdisk integration test (Phase 11.5).
 *
 * Verifies that ELKS's `/dev/rd0` ramdisk works in our emulator. The
 * driver lives in the kernel (`arch/i86/drivers/block/rd.c`); the
 * userland tool is `/bin/ramdisk` (RDCREATE/RDDESTROY ioctls). Both
 * ship in the published `fd1440-minix.img` along with `/bin/mkfs`,
 * `/bin/mount`, `/bin/umount`, `/bin/echo`, and `/bin/cat` — see
 * RAMDISK_REPORT.md "Diagnosis" section for the driver-level details.
 *
 * Why the MINIX floppy image rather than the brief's `fd1440-fat-
 * serial.img`: FAT12 cannot store device nodes, so the FAT image's
 * `/dev` directory is empty (no `/dev/rd0`). The MINIX image's `/dev`
 * has all device nodes including `rd0` (1,0) and `rd1` (1,1). Per the
 * brief's "or whichever image gets you to a `# ` prompt with the right
 * tools", we pick the working one; this is also Phase 7's image, so
 * the keyboard-injection harness pattern applies unchanged.
 *
 * Sequence, run interactively from a `# ` shell:
 *
 *     ramdisk /dev/rd0 make 64    # 64 KB ramdisk
 *     mkfs /dev/rd0 64            # MINIX filesystem
 *     mount /dev/rd0 /mnt
 *     echo hello > /mnt/test
 *     cat /mnt/test               # → "hello"
 *     umount /mnt
 *
 * Each command is sent as ASCII via the same scancode-injection path
 * Phase 7 pioneered. Between commands we run the emulator long enough
 * for the kernel to consume the line, fork/exec the binary, run it,
 * print output, and redraw the prompt. The final assertion looks for
 * the round-trip evidence in the CGA framebuffer.
 *
 * If this test fails, the candidates (in likely order) are:
 *   1. `seg_alloc(SEG_FLAG_RAMDSK)` returning ENOMEM because the
 *      kernel heap is too small to carve out 64 KB. Symptom: the
 *      `ramdisk make` line prints an error.
 *   2. Block-device request queue mishandling for major=1 (RAM_MAJOR).
 *      Symptom: `mkfs` or `mount` hangs / errors.
 *   3. mkfs minimum-size constraints. The minimum viable MINIX
 *      filesystem is small (a few KB of metadata) so 64 KB is plenty,
 *      but a tighter constraint would surface as "filesystem too
 *      small".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';
import {
  installCGAMirror,
  CapturingCGASink,
} from '../../src/diagnostics/cga-mirror.js';
import { ScancodeTranslator } from '../../src/console/scancode-translator.js';

const FD1440 = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };

function loadImage(filename: string): InMemoryDisk | null {
  const path = resolve('reference/elks-images', filename);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return new InMemoryDisk({ geometry: FD1440, contents: bytes });
}

/** Read the 80x25 CGA text framebuffer at 0xB8000 as printable lines. */
function dumpVideoText(machine: IBMPCMachine): string {
  const lines: string[] = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
      const ch = machine.memory.readByte(0xB8000 + (row * 80 + col) * 2);
      line += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

describe('ELKS Phase 11.5 — /dev/rd0 ramdisk round-trip', () => {
  it('allocates, formats, mounts, writes, reads, unmounts a ramdisk', () => {
    const disk = loadImage('fd1440-minix.img');
    if (disk === null) {
      throw new Error(
        'reference/elks-images/fd1440-minix.img not found.',
      );
    }

    const console_ = new InMemoryConsole();
    const m = new IBMPCMachine({
      disk,
      console: console_,
      hostClock: new InMemoryHostClock(),
      cyclesPerPitTick: 4,
    });

    const sink = new CapturingCGASink();
    installCGAMirror(m, { sink });

    m.reset();

    const tracer = new Tracer({
      capacity: 50_000,
      kinds: ['intService', 'trap'],
    });
    const translator = new ScancodeTranslator();

    // ---- Phase 1: boot to login: prompt ------------------------------
    const r1 = traceRun(m, { tracer, maxInstructions: 8_000_000 });
    expect(r1.reason).not.toBe('error');
    expect(r1.reason).not.toBe('halt-spin-exhausted');
    expect(dumpVideoText(m)).toContain('login:');

    // ---- Phase 2: log in as root -------------------------------------
    m.keyboardController.injectScancodes(
      translator.feed(toBytes('root\n')),
    );
    const r2 = traceRun(m, { tracer, maxInstructions: 5_000_000 });
    expect(r2.reason).not.toBe('error');
    expect(r2.reason).not.toBe('halt-spin-exhausted');

    const screenAfterLogin = dumpVideoText(m);
    expect(screenAfterLogin).toContain('login: root');
    expect(
      screenAfterLogin.split('\n').some((line) => line.startsWith('# ')),
    ).toBe(true);

    // ---- Phase 3: ramdisk allocate + mkfs + mount + write + read -----
    //
    // Send all six commands in one batch. The 8042 keyboard controller's
    // host-side queue is unbounded, and ELKS's tty line-discipline buffers
    // up to a line at a time, so the shell consumes them sequentially as
    // each command exits. This is faster than a per-command run loop and
    // doesn't depend on us guessing per-command instruction budgets.
    const sequence =
      'ramdisk /dev/rd0 make 64\n' +
      'mkfs /dev/rd0 64\n' +
      'mount /dev/rd0 /mnt\n' +
      'echo hello-ramdisk > /mnt/test\n' +
      'cat /mnt/test\n' +
      'umount /mnt\n';
    m.keyboardController.injectScancodes(translator.feed(toBytes(sequence)));

    // 50M instructions is generous: each command's fork+exec+run is a
    // few million; six commands plus prompt redraws fit comfortably.
    const r3 = traceRun(m, { tracer, maxInstructions: 50_000_000 });
    expect(r3.reason).not.toBe('error');
    expect(r3.reason).not.toBe('halt-spin-exhausted');

    const screen = dumpVideoText(m);
    const captured = sink.text;

    // ----- Boot path didn't regress -----------------------------------
    expect(captured).toContain('Mounted root device');
    expect(captured).toContain('/dev/fd0');

    // ----- Round-trip evidence ----------------------------------------
    // The `cat` writes "hello-ramdisk" back to the tty; the CGA mirror
    // sees every byte the kernel writes to the framebuffer, even after
    // the screen scrolls past. Look in the captured stream rather than
    // the live framebuffer to avoid timing dependencies on which row
    // each command's output landed on.
    expect(captured).toContain('hello-ramdisk');

    // The `ramdisk` userland tool's success message is "Kb ramdisk
    // created on /dev/rd0\n" (see elkscmd/disk_utils/ramdisk.c:48-52).
    expect(captured).toContain('Kb ramdisk created on /dev/rd0');

    // No ENOMEM / EINVAL bubbling up — these would be present if
    // seg_alloc failed (Outcome B candidate).
    expect(captured).not.toContain('Cannot allocate memory');
    expect(captured).not.toContain('out of memory');

    // All injected scancodes consumed — the kernel kept up with input.
    const remaining =
      m.keyboardController.pendingScancodeCount +
      (m.keyboardController.outputBufferFull ? 1 : 0);
    expect(remaining).toBe(0);
  }, 60_000);
});

function toBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
  return out;
}
