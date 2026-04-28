/**
 * Probe-harness end-to-end smoke test (Phase 12).
 *
 * Boots `fd1440-minix-serial.img` as the primary, attaches a freshly-
 * built FAT12 probe disk as `/dev/fd1`, mounts it, runs a one-line
 * shell script, and checks the captured stdout. The whole pipeline is
 * exercised — image build, machine construction, boot-to-prompt,
 * UART command injection, sentinel-bounded output capture, and result
 * parsing.
 *
 * If this test passes, Phase 13's toolchain survey (and every future
 * probe-style investigation) has a working harness to call.
 *
 * If `fd1440-minix-serial.img` isn't present at the expected path, the
 * test calls out the fix (run `npm run build:elks-serial-image-minix`)
 * and skips. Same skip pattern Phase 11.5 / 11.6 use.
 *
 * Why MINIX-serial is the canonical primary:
 *   - Serial console means the probe's output reaches the harness via
 *     a clean UART TX path (Phase 11.6's payoff). No CGA-mirror scraping.
 *   - MINIX root means /dev/fd1 exists as a device node; FAT12 root would
 *     have no /dev/* nodes and `mount /dev/fd1` would fail with -ENOENT
 *     before reaching the FAT driver (RAMDISK_REPORT.md:97-129).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runProbe } from '../probe/probe-harness.js';

const MINIX_SERIAL_PATH = resolve(
  'reference/elks-images-serial/fd1440-minix-serial.img',
);
const MINIX_BASE_PATH = resolve('reference/elks-images/fd1440-minix.img');

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

/**
 * If `fd1440-minix-serial.img` doesn't exist but the upstream
 * `fd1440-minix.img` does, build it on the fly with the same in-place
 * /bootopts edit Phase 11.6 ships in `tools/elks-build/build-serial-
 * image.ts`. Keeps this test self-sufficient: a fresh checkout that has
 * the upstream image but not the serial variant still runs.
 */
function ensureMinixSerialImage(): boolean {
  if (existsSync(MINIX_SERIAL_PATH)) return true;
  if (!existsSync(MINIX_BASE_PATH)) return false;
  const original = readFileSync(MINIX_BASE_PATH);
  const offset = original.indexOf(Buffer.from(BOOTOPTS_HEADER, 'ascii'));
  if (offset < 0) return false;
  const text = [
    '## /bootopts emu86 serial console build',
    'hma=kernel',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '',
  ].join('\n');
  const bootopts = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  bootopts.write(text, 0, 'ascii');
  const out = Buffer.from(original);
  bootopts.copy(out, offset);
  mkdirSync(dirname(MINIX_SERIAL_PATH), { recursive: true });
  writeFileSync(MINIX_SERIAL_PATH, out);
  return true;
}

describe('Phase 12 — probe-harness trivial round-trip', () => {
  it('runs `echo hello-from-probe` via runProbe and captures the line', async () => {
    if (!ensureMinixSerialImage()) {
      console.warn(
        `[skip] ${MINIX_SERIAL_PATH} (and upstream ${MINIX_BASE_PATH}) not ` +
          `found. Run \`npm run build:elks-serial-image-minix\` first.`,
      );
      return;
    }

    const result = await runProbe({
      primaryImage: MINIX_SERIAL_PATH,
      probe: {
        filename: 'hello.sh',
        script: 'echo hello-from-probe\n',
      },
      // 60M is comfortable: Phase 11.6's six-command ramdisk-over-UART
      // sequence runs in ~50M; a one-command echo + mount is well under
      // that envelope.
      timeoutInstructions: 60_000_000,
    });

    // Boot must have reached the # prompt and produced the standard
    // post-set_console marker (same invariant as Phase 11.6).
    expect(result.bootStdout).toContain('Direct console, scan kbd');
    expect(result.bootStdout).toContain('VFS: Mounted root device');

    // The probe completed (sentinel observed).
    expect(result.timedOut).toBe(false);
    expect(result.kernelPanicked).toBe(false);
    expect(result.truncated).toBe(false);

    // The probe's stdout is the captured line.
    expect(result.stdout).toContain('hello-from-probe');

    // The full transcript contains both the boot output and the sentinel.
    expect(result.fullTranscript).toContain('__PROBE_DONE__');
    expect(result.fullTranscript).toContain('hello-from-probe');

    // Sanity: instruction count is positive and below the budget.
    expect(result.instructionsUsed).toBeGreaterThan(1_000_000);
    expect(result.instructionsUsed).toBeLessThanOrEqual(60_000_000);
  }, 90_000);
});
