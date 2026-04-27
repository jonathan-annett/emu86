import { describe, expect, it } from 'vitest';
import { flagsMaskFor } from './flag-masks.js';
import { corpusAvailable, fileId, findCorpusFiles, loadCases } from './loader.js';
import { formatMismatches, runSSTCase, type SSTResult } from './runner.js';

/**
 * Drive the SingleStepTests/8088 corpus through our CPU.
 *
 * The whole block is gated on {@link corpusAvailable}: without the data
 * directory present, the suite skips silently. When data is installed
 * (per `tests/sst/README.md`), every `*.json` file becomes one `it()`
 * that runs all of its cases and reports aggregate pass/fail.
 *
 * Why one test per file rather than per case: a single corpus file holds
 * thousands of cases. Calling `expect()` per case would blow the test
 * count to millions. Aggregating per-file gives a useful signal — "0xF6
 * subop 4 has 12 failures out of 10000" — without drowning the reporter.
 *
 * Failures are surfaced via a sample of mismatches in the assertion
 * message; the full list is too large to display by default.
 */

const SAMPLE_FAILURES = 5;

describe.skipIf(!corpusAvailable())('SST corpus', () => {
  const files = findCorpusFiles();

  for (const path of files) {
    const id = fileId(path);
    it(`opcode ${id}`, () => {
      const cases = loadCases(path);
      let passed = 0;
      const failures: SSTResult[] = [];
      const errors: Array<{ name: string; error: unknown }> = [];

      const flagsMask = flagsMaskFor(id);
      let errorCount = 0;
      for (const tc of cases) {
        let result: SSTResult;
        try {
          result = runSSTCase(tc, { flagsMask });
        } catch (e) {
          errorCount++;
          if (errors.length < SAMPLE_FAILURES) {
            errors.push({ name: tc.name, error: e });
          }
          continue;
        }
        if (result.pass) {
          passed++;
        } else if (failures.length < SAMPLE_FAILURES) {
          failures.push(result);
        }
      }

      const total = cases.length;
      const failed = total - passed - errorCount;
      const ok = failed === 0 && errorCount === 0;

      const message = buildMessage(id, total, passed, failed, errorCount, errors, failures);
      expect(ok, message).toBe(true);
    });
  }
});

function buildMessage(
  id: string,
  total: number,
  passed: number,
  failed: number,
  errorCount: number,
  errors: Array<{ name: string; error: unknown }>,
  failures: SSTResult[],
): string {
  const lines = [
    `${id}: ${passed}/${total} passed (${failed} failed, ${errorCount} threw)`,
  ];
  for (const f of failures) {
    lines.push(formatMismatches(f));
  }
  for (const e of errors) {
    const msg = e.error instanceof Error ? e.error.message : String(e.error);
    lines.push(`THREW: ${e.name}: ${msg}`);
  }
  return lines.join('\n');
}
