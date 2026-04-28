/**
 * Shared CLI helpers for the ELKS Node harnesses (Phase 11).
 *
 * Both `run.ts` and `run-serial.ts` need the same image-loading logic and
 * the same `--hdb` / `--fd1` / `--secondary-class` flag parser. They live
 * here so the two harnesses stay in lockstep.
 *
 * Loading:
 *   - `loadDiskFromPath(path)` reads an image file and returns an
 *     {@link InMemoryDisk} with geometry inferred from file size. Falls
 *     through the same size table the worker host uses (floppy 1.44/1.2,
 *     ELKS HD 32/64) — keeps every Node harness and the browser
 *     consistent.
 *   - `loadDiskFromPathWithClass(path, classOverride?)` does the same and
 *     also returns the disk class, optionally overridden.
 *
 * Argv parsing:
 *   - `parseSecondaryFlags(argv)` returns the secondary disk spec (if any)
 *     plus the residual positional arguments. The harness still owns the
 *     positional args (image path, max instructions). The flags accepted
 *     are `--hdb <path>`, `--fd1 <path>`, and `--secondary-class <c>`.
 */
import { readFileSync } from 'node:fs';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { inferFromSize, classFromGeometry, } from '../../src/browser/worker-host.js';
/**
 * Load `path` and infer a {@link DiskGeometry} from its byte size. Throws
 * with a helpful message when the size doesn't match a known shape.
 */
export function loadDiskFromPath(path) {
    return loadDiskFromPathWithClass(path).disk;
}
export function loadDiskFromPathWithClass(path, classOverride) {
    const bytes = new Uint8Array(readFileSync(path));
    const inferred = inferFromSize(bytes.length);
    if (!inferred) {
        throw new Error(`Unrecognised image size ${bytes.length} bytes for ${path}. ` +
            `Supported sizes: 1.44M (1474560), 1.2M (1228800), ELKS hd32 ` +
            `(32514048 / 32546304), ELKS hd64 (67107840 / 67140096).`);
    }
    const disk = new InMemoryDisk({ geometry: inferred.geometry, contents: bytes });
    const diskClass = classOverride ?? inferred.diskClass ?? classFromGeometry(inferred.geometry);
    return { disk, diskClass };
}
/**
 * Strip our recognised flags out of `argv` (the raw input slice — typically
 * `process.argv.slice(2)`). Anything not in our flag set is forwarded as
 * a positional, in original order.
 *
 * Recognised flags:
 *   --hdb <path>            secondary as hard-disk
 *   --fd1 <path>            secondary as floppy
 *   --secondary-class <c>   override class detection
 *
 * Throws on duplicate `--hdb` / `--fd1`, on a missing argument, or on an
 * unknown class string. Throws on `--hdb` and `--fd1` both being present
 * (only one secondary slot exists).
 */
export function parseSecondaryFlags(argv) {
    const positional = [];
    let path = null;
    let diskClass = null;
    let classOverride = null;
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--hdb' || a === '--fd1') {
            if (path !== null) {
                throw new Error(`Only one of --hdb / --fd1 may be set (got both).`);
            }
            const next = argv[i + 1];
            if (next === undefined) {
                throw new Error(`${a} requires a path argument.`);
            }
            path = next;
            diskClass = a === '--hdb' ? 'hard-disk' : 'floppy';
            i += 2;
            continue;
        }
        if (a === '--secondary-class') {
            const next = argv[i + 1];
            if (next === 'floppy' || next === 'hard-disk') {
                classOverride = next;
                i += 2;
                continue;
            }
            throw new Error(`--secondary-class requires "floppy" or "hard-disk" (got ${next ?? '(none)'}).`);
        }
        positional.push(a);
        i++;
    }
    if (path === null)
        return { positional, secondary: null };
    return {
        positional,
        secondary: {
            path,
            diskClass: classOverride ?? diskClass,
        },
    };
}
