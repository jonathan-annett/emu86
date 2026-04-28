/**
 * HD32 version-flag probe orchestration (Phase 13.1).
 *
 * Wraps `runProbe()` with the version-flag script (Phase 12.1's
 * extended boot budget makes HD32 boots possible) and produces a
 * structured per-binary classification suitable for the report.
 *
 * The path here mirrors the Phase 13 survey-runner: bootopts-embedded
 * init script, so the harness's `runUntilSentinel` (which would catch
 * the launch line's echoed `__PROBE_DONE__` before the real script
 * could run) doesn't get in the way. The output appears in
 * `result.bootStdout` between `__B__` / `__E__` markers.
 *
 * # What this is NOT
 *
 *   - A hello-world compile attempt — Phase 14 territory.
 *   - A re-run of Phase 13's listing probe — we trust Phase 13's
 *     finding that the seven binaries exist on `hd32-minix.img`.
 *   - An HD64 probe — different briefs.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  runProbe,
  type ProbeResult,
  type ProbeRequest,
} from '../probe-harness.js';
import {
  buildVersionProbeScript,
  classifyVersionTranscript,
  extractVersionRegion,
  HD32_VERSION_CANDIDATES,
  type VersionClassification,
  type VersionStatus,
} from '../version-probe.js';
import {
  applyBootopts,
  buildBootoptsWithScript,
} from './survey-runner.js';

/**
 * Boot-phase budget for HD32 + the version-flag script. Phase 12.1's
 * default is 32M; the version-flag script adds ~7 dev86 invocations.
 * Each dev86 binary takes ~1-2M instructions to load + print + exit.
 * Worst case: 32M boot + 14M probe ≈ 46M total. We set 64M to leave
 * comfortable headroom — a probe that actually hangs hits the boot-phase
 * cap (32M) regardless.
 */
export const HD32_VERSION_PROBE_TIMEOUT = 64_000_000;
export const HD32_VERSION_PROBE_BOOT_BUDGET = 32_000_000;

/**
 * Bump the captured-TX cap from the harness default (256K). Seven
 * binaries × multiple flag attempts × dev86 banner verbosity could
 * push past the default if any binary is unexpectedly chatty;
 * 1 MB is generous and still bounded.
 */
export const HD32_VERSION_PROBE_OUTPUT_CAP = 1024 * 1024;

export interface Hd32VersionProbeResult {
  /** Path to the image that was probed (or attempted). */
  readonly imagePath: string;
  /** True if the image fixture was missing — caller should skip-with-reason. */
  readonly fixtureMissing: boolean;
  /** Underlying `runProbe` outcome (only meaningful when fixture is present). */
  readonly probe: ProbeResult | null;
  /** Per-binary classifications, in the same order as `expected`. */
  readonly classifications: readonly VersionClassification[];
  /** The expected-candidate list passed to the classifier. */
  readonly expected: readonly string[];
  /** The text region extracted from `bootStdout` (between BEGIN/END markers). */
  readonly extractedText: string;
  /** True if the BEGIN+END markers both appeared (script ran to completion). */
  readonly extractedComplete: boolean;
  /** High-level verdict for the report's synthesis section. */
  readonly verdict: Hd32Verdict;
}

export type Hd32Verdict =
  /** Image fixture not present — neither viable nor non-viable; no data. */
  | { readonly kind: 'fixture-missing' }
  /** Boot didn't reach a `# ` prompt within `bootInstructionBudget`. */
  | { readonly kind: 'boot-failed'; readonly reason: string }
  /** `c86` works AND at least one of `as`/`ld` works. */
  | { readonly kind: 'in-vm-viable'; readonly working: readonly string[] }
  /** Mixed: some binaries work, some don't. Phase 14 needs a hybrid plan. */
  | { readonly kind: 'in-vm-partial'; readonly working: readonly string[]; readonly nonWorking: readonly string[] }
  /** Critical binaries crashed/hung/silent. Cross-compile required. */
  | { readonly kind: 'in-vm-broken'; readonly working: readonly string[]; readonly nonWorking: readonly string[] };

interface RunOptions {
  /** Override the candidate list. Defaults to {@link HD32_VERSION_CANDIDATES}. */
  readonly candidates?: readonly string[];
  /** Override `timeoutInstructions`. Default {@link HD32_VERSION_PROBE_TIMEOUT}. */
  readonly timeoutInstructions?: number;
  /** Override `bootInstructionBudget`. Default {@link HD32_VERSION_PROBE_BOOT_BUDGET}. */
  readonly bootInstructionBudget?: number;
  /** Override the captured-TX cap. Default {@link HD32_VERSION_PROBE_OUTPUT_CAP}. */
  readonly maxOutputBytes?: number;
}

/**
 * Run the version-flag probe against an HD32-MINIX image.
 *
 * `imagePath` should point at `hd32-minix.img` (any 32 MB ELKS HD
 * image with the dev86 toolchain in `/usr/bin/`). Skip-with-reason
 * if the file is missing — the function returns
 * `{ fixtureMissing: true }` rather than throwing.
 *
 * The result's `verdict` field summarises Phase 14's options:
 *
 *   - `in-vm-viable`: Phase 14 reverts to in-VM dogfooding.
 *   - `in-vm-broken`: Phase 14 takes the host-cross-compile path.
 *   - `in-vm-partial`: hybrid — typically cross-compile assembly,
 *     link in-VM, but the specific shape depends on which
 *     binaries failed.
 *   - `boot-failed`: probe didn't run to completion. Treat as
 *     `in-vm-broken` for Phase 14 planning, but the report should
 *     spell out what went wrong.
 */
export async function runHd32VersionProbe(
  imagePath: string,
  opts: RunOptions = {},
): Promise<Hd32VersionProbeResult> {
  const expected = opts.candidates ?? HD32_VERSION_CANDIDATES;

  if (!existsSync(imagePath)) {
    return emptyResult(imagePath, expected, { kind: 'fixture-missing' });
  }

  const raw = readFileSync(imagePath);
  const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  const script = buildVersionProbeScript(expected);
  const bootopts = buildBootoptsWithScript(script);
  const primary = applyBootopts(rawBytes, bootopts);

  const probeReq: ProbeRequest = {
    primaryImage: primary,
    // Probe disk is unused on this path (we ignore result.stdout) — the
    // harness still requires a probe filename + script. Use a no-op.
    probe: { filename: 'noop.sh', script: 'true\n' },
    timeoutInstructions: opts.timeoutInstructions ?? HD32_VERSION_PROBE_TIMEOUT,
    bootInstructionBudget: opts.bootInstructionBudget ?? HD32_VERSION_PROBE_BOOT_BUDGET,
    maxOutputBytes: opts.maxOutputBytes ?? HD32_VERSION_PROBE_OUTPUT_CAP,
  };

  const probe = await runProbe(probeReq);

  // ---- early-exit on boot timeout / panic --------------------------------
  if (probe.timeoutPhase === 'boot') {
    const region = extractVersionRegion(probe.bootStdout, expected);
    const classifications = classifyVersionTranscript(region.text, expected);
    return {
      imagePath,
      fixtureMissing: false,
      probe,
      classifications,
      expected,
      extractedText: region.text,
      extractedComplete: region.complete,
      verdict: {
        kind: 'boot-failed',
        reason:
          `boot phase exhausted ${probeReq.bootInstructionBudget!.toLocaleString()} ` +
          `instructions without reaching a # prompt. ` +
          (region.complete
            ? 'Script ran to completion via init, but the trailing ' +
              '`exec /bin/sh` never produced the prompt.'
            : 'Script did not reach the END marker — likely a binary ' +
              'hung early in the loop.'),
      },
    };
  }

  if (probe.kernelPanicked) {
    return {
      imagePath,
      fixtureMissing: false,
      probe,
      classifications: expected.map((name) => ({
        name,
        status: 'hung' as VersionStatus,
        summary: '',
        raw: '',
      })),
      expected,
      extractedText: '',
      extractedComplete: false,
      verdict: {
        kind: 'boot-failed',
        reason: 'kernel panic during boot or version-flag script',
      },
    };
  }

  // ---- normal path: parse + classify --------------------------------------
  const region = extractVersionRegion(probe.bootStdout, expected);
  const classifications = classifyVersionTranscript(region.text, expected);

  const working = classifications.filter((c) => c.status === 'works').map((c) => c.name);
  const nonWorking = classifications.filter((c) => c.status !== 'works').map((c) => c.name);

  let verdict: Hd32Verdict;
  // Phase 14 viability: c86 must work AND at least one of as/ld.
  const c86Works = working.includes('c86');
  const asLdWorks = working.includes('as') || working.includes('ld');
  if (c86Works && asLdWorks) {
    verdict = { kind: 'in-vm-viable', working };
  } else if (working.length === 0) {
    verdict = { kind: 'in-vm-broken', working, nonWorking };
  } else {
    verdict = { kind: 'in-vm-partial', working, nonWorking };
  }

  return {
    imagePath,
    fixtureMissing: false,
    probe,
    classifications,
    expected,
    extractedText: region.text,
    extractedComplete: region.complete,
    verdict,
  };
}

function emptyResult(
  imagePath: string,
  expected: readonly string[],
  verdict: Hd32Verdict,
): Hd32VersionProbeResult {
  return {
    imagePath,
    fixtureMissing: verdict.kind === 'fixture-missing',
    probe: null,
    classifications: expected.map((name) => ({
      name,
      status: 'hung' as VersionStatus,
      summary: '',
      raw: '',
    })),
    expected,
    extractedText: '',
    extractedComplete: false,
    verdict,
  };
}
