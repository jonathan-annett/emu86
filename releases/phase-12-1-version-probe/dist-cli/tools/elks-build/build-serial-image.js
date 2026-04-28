/**
 * Build a serial-console-enabled ELKS floppy image (Phase 8, extended in
 * Phase 11.6 with a `--filesystem` flag).
 *
 * Phase 8 took `reference/elks-images/fd1440-fat.img` (the FAT12
 * distribution image), edited the in-place 1024-byte `/bootopts` file to
 * activate `console=ttyS0,9600` and `init=/bin/sh`, and wrote the result
 * to `reference/elks-images-serial/fd1440-fat-serial.img`. The edit was
 * byte-for-byte: locate the `## /bootopts` header by string search,
 * replace the 1024 bytes that follow.
 *
 * Phase 11.6 generalises this so we can produce a *MINIX* serial image
 * alongside the FAT one. The key observation is that the in-place
 * hex-edit approach is filesystem-agnostic: both upstream images use a
 * 1024-byte `/bootopts` block, both place a unique `## /bootopts`
 * marker at the start of the file's data extent, and the FAT
 * directory-entry / MINIX inode metadata that records the file's size
 * and content blocks is unchanged because the file size stays exactly
 * 1024 bytes. Same edit, different source image.
 *
 * The `--filesystem` flag selects which upstream image to edit:
 *
 *   --filesystem fat   (default, back-compat)  → fd1440-fat-serial.img
 *   --filesystem minix                          → fd1440-minix-serial.img
 *
 * Why the MINIX variant exists: FAT12 cannot store device nodes, so
 * the FAT serial image's `/dev` is empty. Tests that need device-node-
 * dependent features (ramdisk, hd partitions, ...) over the cleaner
 * UART transcript path require a MINIX root with `/dev/rd0` etc.
 * baked in plus `console=ttyS0` in `/bootopts`. See
 * SERIAL_MINIX_REPORT.md for the rationale and RAMDISK_REPORT.md
 * "Why the MINIX floppy image" for the device-node finding.
 *
 * Usage:
 *   npx tsc -p tsconfig.cli.json
 *   node dist-cli/tools/elks-build/build-serial-image.js                    # FAT
 *   node dist-cli/tools/elks-build/build-serial-image.js --filesystem minix # MINIX
 *
 * Or via npm scripts:
 *   npm run build:elks-serial-image
 *   npm run build:elks-serial-image-minix
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
const IMAGE_SPECS = {
    fat: {
        src: 'reference/elks-images/fd1440-fat.img',
        dst: 'reference/elks-images-serial/fd1440-fat-serial.img',
    },
    minix: {
        src: 'reference/elks-images/fd1440-minix.img',
        dst: 'reference/elks-images-serial/fd1440-minix-serial.img',
    },
};
const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;
/**
 * The replacement /bootopts content. Identical for FAT and MINIX
 * variants because the kernel binary (and therefore its boot-parameter
 * parser) is essentially the same across both upstream images — the
 * difference is the root filesystem driver, not the boot path.
 *
 * Starts with the required `##` marker (validated by `init/main.c:535`),
 * keeps `hma=kernel` (matches both source images), uncomments
 * `console=ttyS0,9600`, and pads to exactly `BOOTOPTS_SIZE` bytes with
 * NULs.
 *
 * Why `init=/bin/sh` rather than the default `/sbin/init` chain: the
 * FAT image's `/etc/inittab` only spawns getty on `/dev/tty1`, so
 * without `init=/bin/sh` the FAT serial harness never reaches an
 * interactive prompt over UART. The MINIX image's userland is more
 * complete but verifying its serial-getty behaviour would require
 * either kernel-rebuild discipline (out of scope per the brief) or
 * tolerance for a different prompt path. Using `init=/bin/sh` gives
 * both variants identical observable behaviour at the harness level —
 * one `# ` prompt over /dev/console, /dev/console aliased to
 * /dev/ttyS0 via `console=`. The MINIX image's /dev nodes are visible
 * to the shell regardless of init choice because they live on the
 * mounted root, not in /etc/inittab's sphere of influence.
 */
function buildBootopts() {
    const lines = [
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
function ensureDir(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
}
/**
 * Parse `--filesystem fat|minix` plus optional positional [src] [dst]
 * overrides. Back-compat note: when no `--filesystem` is given, the
 * default is `fat`, and the positional defaults match Phase 8 exactly,
 * so existing invocations keep working unchanged.
 */
function parseArgs(argv) {
    let filesystem = 'fat';
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--filesystem') {
            const v = argv[i + 1];
            if (v !== 'fat' && v !== 'minix') {
                throw new Error(`--filesystem must be 'fat' or 'minix' (got ${String(v)})`);
            }
            filesystem = v;
            i++;
            continue;
        }
        if (a !== undefined && a.startsWith('--filesystem=')) {
            const v = a.slice('--filesystem='.length);
            if (v !== 'fat' && v !== 'minix') {
                throw new Error(`--filesystem must be 'fat' or 'minix' (got ${v})`);
            }
            filesystem = v;
            continue;
        }
        if (a !== undefined) {
            positional.push(a);
        }
    }
    return {
        filesystem,
        src: positional[0] ?? null,
        dst: positional[1] ?? null,
    };
}
function buildVariant(filesystem, srcOverride, dstOverride) {
    const spec = IMAGE_SPECS[filesystem];
    const srcPath = srcOverride ?? spec.src;
    const dstPath = dstOverride ?? spec.dst;
    const srcAbs = resolve(srcPath);
    const dstAbs = resolve(dstPath);
    const image = readFileSync(srcAbs);
    // Locate the existing /bootopts content. Searching by header is robust
    // to layout differences between FAT and MINIX (cluster size, root
    // directory size, inode/zone offsets) that would otherwise hard-code
    // an offset per filesystem. Both upstream images contain exactly one
    // occurrence of `## /bootopts` — at the start of the file's data —
    // so the same lookup works for both.
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
    process.stdout.write(`Wrote serial-console image (${filesystem}): ${dstAbs}\n` +
        `Source: ${srcAbs}\n` +
        `/bootopts replaced at offset 0x${headerOffset.toString(16)} (${BOOTOPTS_SIZE} bytes)\n`);
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    buildVariant(args.filesystem, args.src, args.dst);
}
main();
