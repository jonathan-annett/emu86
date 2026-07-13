/**
 * HD32 hello-world compile integration test (Phase 14, step 1).
 *
 * Boots `hd32-minix.img`, ships `hello.c` + a driver script on the
 * probe floppy, compiles it with the on-disk C86 native toolchain, and
 * runs the result inside the VM. Asserts the pipeline ran end-to-end
 * and the compiled binary printed the expected string.
 *
 * Skips with a helpful pointer when the fixture is absent (a missing
 * fixture is data, not a failure — Phase 13.1 convention).
 *
 * Verbose mode prints the per-stage transcript sections for the
 * report-author:
 *
 *   EMU86_HELLO_WORLD_VERBOSE=1 npx vitest run \
 *     tests/integration/hd32-hello-world.test.ts
 *
 * EMU86_HELLO_WORLD_DUMP=1 additionally dumps the raw extracted region
 * and the bootStdout tail.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runHd32HelloWorld,
  type Hd32HelloWorldResult,
} from '../probe/surveys/hd32-hello-world.js';

const HD32_MINIX_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const VERBOSE = process.env['EMU86_HELLO_WORLD_VERBOSE'] === '1';
const DUMP = process.env['EMU86_HELLO_WORLD_DUMP'] === '1';

const TEST_TIMEOUT_MS = 15 * 60 * 1000;

describe('Phase 14 step 1 — hello-world compile on hd32-minix', () => {
  it(
    'compiles and runs hello.c with the native C86 toolchain in-VM',
    async () => {
      if (!existsSync(HD32_MINIX_PATH)) {
        console.warn(
          `[skip] ${HD32_MINIX_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }

      const result = await runHd32HelloWorld(HD32_MINIX_PATH);

      if (VERBOSE) printFindings(result);

      // ---- structural assertions -----------------------------------------
      expect(result.fixtureMissing).toBe(false);
      expect(result.probe).not.toBeNull();
      expect(result.probe?.kernelPanicked).toBe(false);

      // The guest driver script ran to completion (both markers seen).
      expect(result.extractedComplete).toBe(true);

      // ---- pipeline assertions ---------------------------------------------
      // Every stage (copy, cpp, c86, as, ld, run) reported exit code 0.
      for (const stage of result.stages) {
        expect(stage.rc, `stage ${stage.name} rc (output: ${stage.output.slice(0, 400)})`).toBe(0);
      }

      // The compiled binary ran inside the VM and printed the goods.
      expect(result.helloRan).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

function printFindings(result: Hd32HelloWorldResult): void {
  const lines: string[] = [];
  lines.push('\n=== HD32 hello-world probe findings ===');
  lines.push(`image: ${result.imagePath}`);
  if (result.probe !== null) {
    lines.push(
      `instructions used: ${result.probe.instructionsUsed.toLocaleString()}`,
    );
    lines.push(`boot reached prompt: ${result.probe.timeoutPhase !== 'boot'}`);
    lines.push(`kernel panicked: ${result.probe.kernelPanicked}`);
    lines.push(`truncated: ${result.probe.truncated}`);
  }
  lines.push(`extracted complete: ${result.extractedComplete}`);
  lines.push(`hello ran: ${result.helloRan}`);
  lines.push('');
  lines.push('--- pipeline stages ---');
  for (const stage of result.stages) {
    lines.push(`  ${stage.name}: rc=${stage.rc === null ? 'missing' : stage.rc}`);
  }
  lines.push('');
  for (const [name, body] of Object.entries(result.sections)) {
    lines.push(`--- section @@${name}@@ ---`);
    lines.push(body);
    lines.push('');
  }
  if (DUMP) {
    lines.push('--- extracted region (first 8 KB) ---');
    lines.push(result.extractedText.slice(0, 8192));
    if (result.probe !== null) {
      lines.push('--- bootStdout tail (last 2 KB) ---');
      lines.push(result.probe.bootStdout.slice(-2048));
    }
  }
  console.log(lines.join('\n'));
}
