/**
 * HD32 version-flag probe integration test (Phase 13.1).
 *
 * Boots `hd32-minix.img` under the Phase 12.1 extended boot budget,
 * runs the seven-binary version-flag probe, and asserts on the
 * *structure* of the captured output — NOT on which binaries work.
 * The findings (per-binary classifications) are the report's payload;
 * the test's job is to confirm the probe ran end-to-end.
 *
 * Skips with a helpful pointer when the fixture is absent. Per the
 * Phase 13.1 brief: a missing fixture is data ("survey blocked by
 * infrastructure"), not a test failure.
 *
 * Verbose mode prints the classifications and trimmed transcripts
 * for the report-author to paste in:
 *
 *   EMU86_VERSION_PROBE_VERBOSE=1 npx vitest run \
 *     tests/integration/hd32-version-probe.test.ts
 *
 * Wall-clock budget: HD32 boot is ~14M instructions and version-flag
 * loop adds ~10-20M more under typical dev86 load. The vitest test
 * timeout is 5 minutes for headroom.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runHd32VersionProbe,
  type Hd32VersionProbeResult,
} from '../probe/surveys/hd32-version-probe.js';
import { HD32_VERSION_CANDIDATES } from '../probe/version-probe.js';

const HD32_MINIX_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const VERBOSE = process.env['EMU86_VERSION_PROBE_VERBOSE'] === '1';

const TEST_TIMEOUT_MS = 5 * 60 * 1000;

describe('Phase 13.1 — HD32 version-flag probe end-to-end', () => {
  it(
    'runs the version-flag probe against hd32-minix.img and classifies the seven candidates',
    async () => {
      if (!existsSync(HD32_MINIX_PATH)) {
        // Skip-with-reason. The fixture is 32 MB; users opt in by
        // running the fetch script.
        console.warn(
          `[skip] ${HD32_MINIX_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }

      const result = await runHd32VersionProbe(HD32_MINIX_PATH);

      if (VERBOSE) printVersionProbeFindings(result);

      // ---- structural assertions -----------------------------------------
      expect(result.fixtureMissing).toBe(false);
      expect(result.probe).not.toBeNull();

      // The expected list is the seven Dev86 candidates. We classified
      // each one — even if all came back hung/silent/crashed.
      expect(result.classifications).toHaveLength(HD32_VERSION_CANDIDATES.length);
      expect(result.classifications.map((c) => c.name)).toEqual(
        HD32_VERSION_CANDIDATES,
      );

      // Verdict is one of the expected kinds (no fixture-missing here —
      // we asserted the fixture is present above).
      expect([
        'boot-failed',
        'in-vm-viable',
        'in-vm-partial',
        'in-vm-broken',
      ]).toContain(result.verdict.kind);

      // Every classification has one of the four documented statuses.
      for (const c of result.classifications) {
        expect(['works', 'silent', 'crashed', 'hung']).toContain(c.status);
      }

      // No kernel panic — that would be a regression.
      expect(result.probe?.kernelPanicked).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

function printVersionProbeFindings(result: Hd32VersionProbeResult): void {
  const lines: string[] = [];
  lines.push('\n=== HD32 version-flag probe findings ===');
  lines.push(`image: ${result.imagePath}`);
  lines.push(`verdict: ${result.verdict.kind}`);
  if (result.verdict.kind === 'in-vm-viable') {
    lines.push(`  working: ${result.verdict.working.join(', ')}`);
  } else if (
    result.verdict.kind === 'in-vm-partial' ||
    result.verdict.kind === 'in-vm-broken'
  ) {
    lines.push(`  working: [${result.verdict.working.join(', ')}]`);
    lines.push(`  non-working: [${result.verdict.nonWorking.join(', ')}]`);
  } else if (result.verdict.kind === 'boot-failed') {
    lines.push(`  reason: ${result.verdict.reason}`);
  }

  if (result.probe !== null) {
    lines.push(
      `instructions used: ${result.probe.instructionsUsed.toLocaleString()}`,
    );
    lines.push(
      `boot reached prompt: ${result.probe.timeoutPhase !== 'boot'}`,
    );
    lines.push(`extracted complete: ${result.extractedComplete}`);
  }

  lines.push('');
  lines.push('--- per-binary classifications ---');
  for (const c of result.classifications) {
    lines.push(`  ${c.name}: ${c.status}` + (c.summary ? ` — ${c.summary}` : ''));
  }

  if (process.env['EMU86_VERSION_PROBE_DUMP'] === '1') {
    lines.push('');
    lines.push('--- extracted region ---');
    lines.push(result.extractedText.slice(0, 4096));
    if (result.probe !== null) {
      lines.push('--- bootStdout tail (last 2 KB) ---');
      lines.push(result.probe.bootStdout.slice(-2048));
    }
  }

  // Vitest's reporter captures console.log under each test.
  console.log(lines.join('\n'));
}
