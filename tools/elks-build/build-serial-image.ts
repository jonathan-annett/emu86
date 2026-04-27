/**
 * Build a serial-console-enabled ELKS floppy image (Phase 8).
 *
 * Takes `reference/elks-images/fd1440-fat.img` (the FAT12 distribution
 * image with a bootable kernel and a 1024-byte `/bootopts` file at a
 * known cluster), edits the in-place /bootopts content to:
 *
 *   - Uncomment `console=ttyS0,9600` so set_console() in printk.c picks
 *     /dev/ttyS0 as the active console for both kernel printk and the
 *     /dev/console alias the shell opens.
 *   - Keep `hma=kernel` and any other previously-active settings intact.
 *
 * The /bootopts file is a fixed-length 1024-byte text file at a known
 * cluster (the build script that produces the distribution image
 * deliberately allocates 1K so later edits stay contiguous — see
 * `setup.S:961-962`). The boot loader copies the first 1024 bytes into
 * `DEF_OPTSEG:0` and `parse_options` reads from there, so as long as we
 * keep the file 1024 bytes total and starting with `##` (per
 * `init/main.c:535` validation), the kernel will accept it.
 *
 * The edit is byte-for-byte: we read the source image into a buffer,
 * locate the `## /bootopts` header by string search, replace the 1024
 * bytes that follow with a freshly-built /bootopts, and write the
 * modified buffer to the destination path. FAT directory entries and
 * cluster chains are untouched.
 *
 * Usage:
 *   npx tsc -p tsconfig.cli.json
 *   node dist-cli/tools/elks-build/build-serial-image.js [src] [dst]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const DEFAULT_SRC = 'reference/elks-images/fd1440-fat.img';
const DEFAULT_DST = 'reference/elks-images-serial/fd1440-fat-serial.img';

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

/**
 * The replacement /bootopts content. Starts with the required `##` marker,
 * keeps `hma=kernel` (matches the source), uncomments `console=ttyS0,9600`,
 * and pads to exactly `BOOTOPTS_SIZE` bytes with spaces.
 *
 * We use 9600 baud rather than 19200 because the divisor table in
 * `serial-8250.c:75` defines both, and 9600 has the simplest divisor
 * (D = 12) — though our UART ignores the divisor for timing purposes,
 * so any supported baud works. The trailing `3` (multiuser serial
 * runlevel marker from the source's commented sample) is omitted; the
 * existing image already reaches a `login:` prompt without it.
 */
function buildBootopts(): Buffer {
  // We set:
  //   - hma=kernel: same as the source image; tells the boot loader to
  //     load the kernel into HMA. Without this we'd have a different
  //     kernel layout that may or may not boot.
  //   - console=ttyS0,9600: directs printk and /dev/console to /dev/ttyS0.
  //   - init=/bin/sh: bypass /sbin/init (and the inittab/getty chain
  //     that, in the source distribution image, spawns getty on
  //     /dev/tty1 only — never on ttyS0). With init=/bin/sh, /bin/sh
  //     runs directly on /dev/console (which is now /dev/ttyS0) and we
  //     get an interactive `# ` prompt over the UART without any
  //     serial-aware getty involved.
  const lines: string[] = [
    '## /bootopts emu86 serial console build',
    'hma=kernel',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '',
  ];
  const text = lines.join('\n');
  if (text.length > BOOTOPTS_SIZE - 1) {
    throw new Error(`/bootopts content (${text.length} bytes) exceeds ${BOOTOPTS_SIZE - 1} bytes`);
  }
  // Pad with NUL bytes. `init/main.c:535-537` rejects the file if
  // BOTH byte[511] and byte[1023] are non-zero (the "one or two
  // sectors, max 1023 or 511" validation). NUL-padding makes both
  // bytes 0, which passes; the original distribution image also
  // uses NUL padding for the trailing slack region.
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function main(): void {
  const srcPath = process.argv[2] ?? DEFAULT_SRC;
  const dstPath = process.argv[3] ?? DEFAULT_DST;
  const srcAbs = resolve(srcPath);
  const dstAbs = resolve(dstPath);

  const image = readFileSync(srcAbs);

  // Locate the existing /bootopts content. Searching by header is robust
  // to floppy-image layout changes (cluster size, root directory size)
  // that would otherwise hard-code an offset.
  const headerOffset = image.indexOf(Buffer.from(BOOTOPTS_HEADER, 'ascii'));
  if (headerOffset < 0) {
    throw new Error(`Could not find "${BOOTOPTS_HEADER}" in ${srcAbs}`);
  }
  if (headerOffset + BOOTOPTS_SIZE > image.length) {
    throw new Error(`/bootopts at offset ${headerOffset} would extend past image end`);
  }

  const newBootopts = buildBootopts();
  const out = Buffer.from(image); // copy
  newBootopts.copy(out, headerOffset);

  ensureDir(dstAbs);
  writeFileSync(dstAbs, out);

  process.stdout.write(
    `Wrote serial-console image: ${dstAbs}\n` +
    `Source: ${srcAbs}\n` +
    `/bootopts replaced at offset 0x${headerOffset.toString(16)} (${BOOTOPTS_SIZE} bytes)\n`,
  );
}

main();
