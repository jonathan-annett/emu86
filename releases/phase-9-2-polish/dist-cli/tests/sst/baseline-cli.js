/**
 * Standalone CLI for running the SST corpus.
 *
 * Why this exists separate from `corpus.test.ts`: vitest's default reporter
 * buffers output until the run completes, and on a phone or low-resource
 * host the buffer-everything approach causes the run to look hung for
 * many minutes. This CLI prints one line per opcode file as it finishes,
 * so a baseline run is observable in real time and easy to grep.
 *
 * Run:
 *   node --experimental-strip-types tests/sst/baseline-cli.ts \
 *        [--filter=<regex>] [--bail] [--mask=<id>=<hex>...]
 *
 * Output line format:
 *   <id> <passed>/<total> failed=<N> threw=<N> [SAMPLE: ...]
 *
 * The `--mask` arg accepts repeated `id=hex` pairs to apply per-opcode
 * flag masks (e.g. --mask=24=FFEF for AND AL, imm8 with AF undefined).
 * Mostly for ad-hoc triage; the canonical masks live in the test code.
 */
import { flagsMaskFor } from './flag-masks.js';
import { findCorpusFiles, fileId, loadCases } from './loader.js';
import { runSSTCase, formatMismatches } from './runner.js';
const SAMPLE = 5;
function parseArgs(argv) {
    const opts = { bail: false, masks: new Map() };
    for (const a of argv) {
        if (a.startsWith('--filter='))
            opts.filter = new RegExp(a.slice('--filter='.length), 'i');
        else if (a === '--bail')
            opts.bail = true;
        else if (a.startsWith('--mask=')) {
            const [id, hex] = a.slice('--mask='.length).split('=');
            if (!id || !hex)
                throw new Error(`bad --mask: ${a}`);
            opts.masks.set(id, parseInt(hex, 16) & 0xFFFF);
        }
    }
    return opts;
}
function main() {
    const opts = parseArgs(process.argv.slice(2));
    const files = findCorpusFiles();
    if (files.length === 0) {
        console.error('No corpus files found at tests/sst/data/. See tests/sst/README.md.');
        return 2;
    }
    let totalCases = 0;
    let totalPassed = 0;
    let totalFailed = 0;
    let totalThrew = 0;
    let dirtyFiles = 0;
    for (const path of files) {
        const id = fileId(path);
        if (opts.filter && !opts.filter.test(id))
            continue;
        const cases = loadCases(path);
        let passed = 0;
        let errCount = 0;
        const failures = [];
        const errors = [];
        // CLI-supplied masks override the curated table (for ad-hoc triage).
        const flagsMask = opts.masks.get(id) ?? flagsMaskFor(id);
        for (const tc of cases) {
            let r;
            try {
                r = runSSTCase(tc, { flagsMask });
            }
            catch (e) {
                errCount++;
                if (errors.length < SAMPLE) {
                    errors.push({ name: tc.name, msg: e instanceof Error ? e.message : String(e) });
                }
                continue;
            }
            if (r.pass) {
                passed++;
            }
            else if (failures.length < SAMPLE) {
                failures.push(r);
            }
        }
        const failCount = cases.length - passed - errCount;
        const dirty = failCount > 0 || errCount > 0;
        totalCases += cases.length;
        totalPassed += passed;
        totalFailed += failCount;
        totalThrew += errCount;
        if (dirty)
            dirtyFiles++;
        const line = `${id.padEnd(8)} ${passed}/${cases.length}` +
            (failCount ? ` failed=${failCount}` : '') +
            (errCount ? ` threw=${errCount}` : '');
        console.log(line);
        if (dirty) {
            for (const f of failures)
                console.log('  ' + formatMismatches(f).replace(/\n/g, '\n  '));
            for (const e of errors)
                console.log(`  THREW: ${e.name}: ${e.msg}`);
        }
        if (opts.bail && dirty) {
            console.error(`bailing after first dirty file: ${id}`);
            return 1;
        }
    }
    console.log('---');
    console.log(`SUMMARY: ${totalPassed}/${totalCases} passed across ${files.length} files; ` +
        `failed=${totalFailed} threw=${totalThrew} dirty_files=${dirtyFiles}`);
    return totalFailed === 0 && totalThrew === 0 ? 0 : 1;
}
process.exit(main());
