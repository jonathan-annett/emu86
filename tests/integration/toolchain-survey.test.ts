/**
 * Toolchain-survey integration tests (Phase 13).
 *
 * One test per surveyed image. Each test boots the image (with the
 * in-memory /bootopts edit applied for serial console + shell-only
 * init), runs the binary-listing probe, then runs the version-check
 * probe if any compiler-shaped names were found, and asserts on
 * broad-stroke findings only — the actual presence of compilers is
 * the survey's *output*, not a precondition.
 *
 * The detailed transcripts captured by these tests feed the report
 * (`TOOLCHAIN_SURVEY_REPORT.md`). When `EMU86_SURVEY_VERBOSE=1` is set
 * each test prints its findings to stdout for the report-author to
 * paste in.
 *
 * Tests skip-with-reason if the image fixture is absent. Per the
 * brief: a missing fixture is data ("survey blocked by infrastructure"),
 * not a test failure.
 *
 * Wall-clock budget: ~14 s for HD32 boot in Phase 10 measurements;
 * each surveyed image runs two probes (~28 s upper bound). Six images
 * = ~3 minutes worst case. The vitest timeout is set generously per
 * test.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  runSurvey,
  type ImageCandidate,
  type SurveyResult,
} from '../probe/surveys/survey-runner.js';

const VERBOSE = process.env['EMU86_SURVEY_VERBOSE'] === '1';

const CANDIDATES: readonly ImageCandidate[] = [
  {
    name: 'fd1440-minix.img',
    path: resolve('reference/elks-images/fd1440-minix.img'),
    note: '1.44 MB MINIX floppy — small distribution, baseline userland',
  },
  {
    name: 'fd1440-fat.img',
    path: resolve('reference/elks-images/fd1440-fat.img'),
    note: '1.44 MB FAT floppy — same content as MINIX variant, different FS',
  },
  {
    name: 'hd32-minix.img',
    path: resolve('reference/elks-images-hd/hd32-minix.img'),
    note: '32 MB partitionless MINIX — most likely to ship larger userland',
  },
  {
    name: 'hd32-fat.img',
    path: resolve('reference/elks-images-hd/hd32-fat.img'),
    note: '32 MB partitionless FAT — checks for FS-axis differences vs MINIX',
  },
  {
    name: 'hd32mbr-minix.img',
    path: resolve('reference/elks-images-hd/hd32mbr-minix.img'),
    note: '32 MB MBR-partitioned MINIX — separate userland-axis check',
  },
];

/**
 * The vitest test timeout (in ms). Generous: each survey runs two
 * probes, an HD probe takes ~14 s wall-clock plus per-probe overhead.
 * Set 5 minutes to leave plenty of headroom for slower environments.
 */
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

describe('Phase 13 — toolchain survey per image', () => {
  for (const candidate of CANDIDATES) {
    it(
      `surveys ${candidate.name}`,
      async () => {
        const result = await runSurvey(candidate);

        if (result.verdict.kind === 'fixture-missing') {
          console.warn(
            `[skip] ${candidate.path} not found. ` +
              `For HD images: \`npm run build:elks-hd-image -- ${candidate.name.replace(/\.img$/, '')}\`. ` +
              `For floppies: see reference/elks-images/.`,
          );
          return;
        }

        if (VERBOSE) printSurveyFindings(result);

        // ---- broad-stroke assertions ---------------------------------------
        // The survey may legitimately reach any of the non-`fixture-missing`
        // verdicts: boot-failed, no-compilers, compilers-broken,
        // compilers-working. We assert only that we got far enough to
        // record *something* — the actual content is the report's body.
        expect(['boot-failed', 'no-compilers', 'compilers-broken', 'compilers-working'])
          .toContain(result.verdict.kind);

        // If the boot succeeded, we should have at least one binary
        // entry (every ELKS image ships some `/bin/sh`-class binaries
        // even on the smallest userland). A boot that produces zero
        // entries strongly suggests parser breakage, which would be a
        // bug — assert against it.
        if (result.verdict.kind !== 'boot-failed') {
          expect(result.listing.parsed.entries.length).toBeGreaterThan(0);
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});

function printSurveyFindings(result: SurveyResult): void {
  const { image, verdict, listing, versions } = result;
  const lines: string[] = [];
  lines.push(`\n=== Survey: ${image.name} ===`);
  lines.push(`note: ${image.note}`);
  lines.push(`verdict: ${verdict.kind}${verdict.kind === 'compilers-working' ? ' [' + verdict.working.join(', ') + ']' : verdict.kind === 'boot-failed' ? ` (${verdict.reason})` : ''}`);
  lines.push(`listing: ${listing.parsed.entries.length} entries; ${listing.parsed.compilerCandidates.length} compiler-shaped`);
  if (listing.parsed.missingDirs.length > 0) {
    lines.push(`missing dirs: ${listing.parsed.missingDirs.join(', ')}`);
  }
  if (listing.parsed.compilerCandidates.length > 0) {
    lines.push(`compiler candidates: ${listing.parsed.compilerCandidates.map((c) => `${c.dir}/${c.name}`).join(', ')}`);
  }
  if (versions !== null) {
    for (const v of versions.parsed) {
      lines.push(`  ${v.name}: ${v.status} — ${v.summary}`);
    }
  }
  lines.push(`instructions: listing=${listing.probe.instructionsUsed.toLocaleString()}${versions !== null ? `, versions=${versions.probe.instructionsUsed.toLocaleString()}` : ''}`);
  if (process.env['EMU86_SURVEY_DUMP'] === '1') {
    lines.push('--- listing stdout (first 4 KB) ---');
    lines.push(listing.probe.stdout.slice(0, 4096));
    lines.push('--- listing bootStdout tail (last 1 KB) ---');
    lines.push(listing.probe.bootStdout.slice(-1024));
    if (versions !== null) {
      lines.push('--- versions stdout (first 4 KB) ---');
      lines.push(versions.probe.stdout.slice(0, 4096));
    }
  }
  // Use console.log so vitest's reporter shows it; vitest captures
  // console output and prints it under the test.
  console.log(lines.join('\n'));
}
