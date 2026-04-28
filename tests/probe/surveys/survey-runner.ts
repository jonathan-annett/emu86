/**
 * Toolchain-survey runner (Phase 13).
 *
 * One image, two probes, structured findings. Built on top of
 * `runProbe()` from the Phase 12 harness — no harness changes; this
 * module is just the per-survey orchestration.
 *
 * The survey runs two probes per image:
 *
 *   1. **Binary listing** — `ls -la` of `/usr/bin`, `/bin`, `/sbin`,
 *      `/usr/include`, `/usr/lib`, with `__SECTION__` markers between.
 *      Parsed by {@link parseBinaryListing}.
 *
 *   2. **Version checks** — for each compiler-shaped name found, try
 *      `--version`, `-V`, `-v`, then bare invocation, in a single
 *      `for` loop. Output is wrapped with `=== name ===` markers and
 *      parsed by {@link parseVersionOutput}.
 *
 * # Why we use /bootopts-embedded init scripts (not the probe disk)
 *
 * The Phase 12 harness echoes its launch line `mount /dev/fd1 /mnt &&
 * sh /mnt/<probe>; echo __PROBE_DONE__\n` to RX, and the kernel's tty
 * line discipline echoes the bytes back over TX. The harness's
 * `runUntilSentinel` then reads from `txCursor=0` on its first slice,
 * sees the `__PROBE_DONE__` substring in the echoed launch line, and
 * exits before any non-trivial probe script can run.
 *
 * Hard rule 7 of the Phase 13 brief forbids modifying the harness, so
 * we work around it by stashing the survey script *in /bootopts* as
 * `init=` arguments. The script runs during boot — its output appears
 * in `result.bootStdout` (which the harness captures up to the first
 * `# ` prompt). We append `exec /bin/sh` so the prompt appears after
 * the script finishes, satisfying the harness's boot-detection.
 *
 * This means the harness's broken probe-launch path runs *after* our
 * script has finished — its `result.stdout` is whatever it managed to
 * capture in the post-prompt window, which we ignore.
 *
 * # In-memory /bootopts edit
 *
 * We don't write modified images to disk — every survey image is
 * derived in memory from the upstream original. The 1024-byte
 * /bootopts region is located via the `## /bootopts` marker (Phase
 * 11.6 pattern) and overwritten with a freshly-built header + init
 * arguments.
 *
 * # 1024-byte budget
 *
 * After the bootopts header (`hma=kernel`, `console=ttyS0,9600`,
 * `init=/bin/sh`, `-c`, `"<script>"`) we have ~960 bytes for the
 * script. The listing script for 5 directories fits in ~250 bytes; the
 * version script for up to 10 candidates fits in ~850 bytes. If a
 * future survey needs more, we can fall back to a multi-probe sequence
 * or graduate to a real harness extension.
 */

import { readFileSync, existsSync } from 'node:fs';
import {
  runProbe,
  type ProbeResult,
  type ProbeRequest,
} from '../probe-harness.js';
import {
  parseBinaryListing,
  type BinaryListing,
  SECTION_MARKER,
} from './parse-binary-listing.js';
import {
  parseVersionOutput,
  type VersionResult,
} from './parse-version-output.js';

/** The directories the binary-listing probe enumerates, in order. */
export const PROBE_DIRECTORIES: readonly string[] = [
  '/usr/bin',
  '/bin',
  '/sbin',
  '/usr/include',
  '/usr/lib',
];

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

/**
 * Markers bracketing the survey script's output inside `result.bootStdout`.
 *
 * The script itself emits these so we can extract the relevant region
 * cleanly — kernel boot logs, mount messages, and ELKS init banners
 * surround the output, and we don't want any of that bleeding into the
 * parser.
 *
 * **Why so short?** ELKS's init parses `init=` argv into a 160-byte
 * fixed buffer (see `init/main.c:MAX_INIT_SLEN`). After overhead — 12
 * bytes for the argv pointer table, 8 for `/bin/sh\0`, 3 for `-c\0`,
 * ~17 for the `ROOTDEV=` env that init injects — we have ~120 bytes
 * for the script payload. Ten characters of marker overhead per
 * begin/end pair adds up. Use 5-char markers and accept the slight
 * collision risk vs `ls` output (no entry will be exactly `__B__`).
 *
 * Distinct from `__PROBE_DONE__` (the harness's sentinel; we don't
 * use it on this path) and from `__SECTION__` (no longer used; the
 * for-loop emits `<dir>:` headers and the parser detects those).
 */
const SURVEY_BEGIN = '__B__';
const SURVEY_END = '__E__';

export interface ImageCandidate {
  /** Filename of the upstream image, e.g. `hd32-minix.img`. */
  readonly name: string;
  /** Absolute or repo-relative path to the upstream image. */
  readonly path: string;
  /** Short note for the report. */
  readonly note: string;
}

export interface SurveyResult {
  readonly image: ImageCandidate;
  /** Outcome of the binary-listing probe. */
  readonly listing: ProbeOutcome<BinaryListing>;
  /** Outcome of the version-check probe (skipped if no candidates). */
  readonly versions: ProbeOutcome<readonly VersionResult[]> | null;
  /** Summary verdict for the synthesis table. */
  readonly verdict: SurveyVerdict;
}

export interface ProbeOutcome<T> {
  readonly probe: ProbeResult;
  readonly parsed: T;
}

export type SurveyVerdict =
  | { readonly kind: 'fixture-missing' }
  | { readonly kind: 'boot-failed'; readonly reason: string }
  | { readonly kind: 'no-compilers' }
  | { readonly kind: 'compilers-broken' }
  | { readonly kind: 'compilers-working'; readonly working: readonly string[] };

/**
 * Build a /bootopts buffer that runs `script` via `/bin/sh -c` as the
 * init process, then execs an interactive `/bin/sh` so the harness sees
 * a `# ` prompt.
 *
 * Layout (LF-separated lines):
 *
 *   ## /bootopts emu86 toolchain survey
 *   hma=kernel
 *   console=ttyS0,9600
 *   init=/bin/sh
 *   -c
 *   "<script>; exec /bin/sh"
 *
 * ELKS's init-arg parser (init/main.c, `option()`) recognises lines
 * after `init=` as additional argv values until the 1024-byte region
 * ends or `MAX_INIT_ARGS=6` is reached. Quoted strings tokenise as one
 * argument, with the quotes stripped — exactly what we need to pass a
 * compound shell command in.
 *
 * Throws if the resulting text is too long for the 1024-byte region.
 */
export function buildBootoptsWithScript(script: string): Buffer {
  // The script must not contain `"` since we wrap it in `"…"` for the
  // bootopts tokenizer. Survey scripts only use single-quotes, so this
  // is a guardrail rather than an active concern.
  if (script.includes('"')) {
    throw new Error('Survey script contains a `"` character; not supported');
  }
  // Note: `hma=kernel` is intentionally *omitted*. ELKS would treat it
  // as an env var (`hma=kernel\0` = 11 bytes), which is enough to push
  // `argv_slen` past the 160-byte limit and trigger an init panic.
  // The default kernel placement is fine for survey purposes.
  const text = [
    '## /bootopts emu86 toolchain survey',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '-c',
    `"${script};exec /bin/sh"`,
    '',
  ].join('\n');
  if (text.length > BOOTOPTS_SIZE - 1) {
    throw new Error(
      `bootopts text too long: ${text.length} bytes (max ${BOOTOPTS_SIZE - 1}); ` +
        `shorten the survey script.`,
    );
  }
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

/**
 * Apply a /bootopts edit to the supplied image bytes, returning a fresh
 * `Uint8Array`. Throws if the marker isn't present; ELKS images without
 * `## /bootopts` are out of scope for the survey.
 */
export function applyBootopts(image: Uint8Array, bootopts: Buffer): Uint8Array {
  const buf = Buffer.from(image.buffer, image.byteOffset, image.byteLength);
  const offset = buf.indexOf(BOOTOPTS_HEADER, 0, 'ascii');
  if (offset < 0) {
    throw new Error(`No "${BOOTOPTS_HEADER}" marker in image`);
  }
  if (offset + BOOTOPTS_SIZE > buf.length) {
    throw new Error(`/bootopts at offset ${offset} would extend past image end`);
  }
  const out = new Uint8Array(buf.length);
  out.set(image);
  for (let i = 0; i < bootopts.length; i++) {
    out[offset + i] = bootopts[i] ?? 0;
  }
  return out;
}

/**
 * Build the listing-probe shell script.
 *
 * Shape:
 *
 *     echo __B__;for d in /usr/bin /bin /sbin /usr/include /usr/lib;\
 *       do echo $d:;ls -la $d;done;echo __E__
 *
 * Why this shape:
 *
 *   - **Per-dir loop, not multi-arg `ls`.** ELKS's `ls` doesn't honour
 *     multiple directory arguments — `ls -la /bin /sbin` emits a single
 *     error line and skips the rest. A `for` loop sidesteps this.
 *
 *   - **`echo $d:` before each `ls`.** The `<dir>:` header is what the
 *     parser uses to attribute each entry to its directory. `ls` itself
 *     doesn't emit one when given a single dir.
 *
 *   - **No `2>&1`.** Saves 5 bytes — barely matters, but every byte
 *     counts in the 120-byte init-arg budget. Errors still appear on
 *     the console (TTY = same UART) since ELKS init has stderr=stdout
 *     by default.
 *
 *   - **Compact markers.** `__B__` / `__E__` instead of
 *     `__SURVEY_BEGIN__` / `__SURVEY_END__` — saves 22 bytes total.
 */
export function buildListingScript(): string {
  return (
    `echo ${SURVEY_BEGIN};` +
    `for d in ${PROBE_DIRECTORIES.join(' ')};` +
    `do echo $d:;ls -la $d;done;` +
    `echo ${SURVEY_END}`
  );
}

/**
 * Build the version-check shell script for the given binaries.
 *
 * Shape (`for` loop again to fit in the 120-byte init-arg budget):
 *
 *     echo __B__;for n in cc bcc as86 ld86;do echo =$n=;\
 *       ($n --version||$n -V||$n -v||$n)|head -3;done;echo __E__
 *
 * Constraints:
 *
 *   - **Number of candidates is bounded by string length.** Each name
 *     adds `<name>` (often 2-4 chars) plus a separating space to the
 *     `for n in …;` clause. With our typical compiler-shaped names
 *     (cc, bcc, as, as86, ld, ld86, make, ar) the budget supports ~8.
 *     The caller truncates if listing produced more.
 *
 *   - **`=$n=` instead of `=== $n ===`.** Saves 6 bytes per call site.
 *     The version-output parser doesn't need a specific marker pattern;
 *     it just needs *something* the binary itself wouldn't emit, and
 *     `=cc=` etc. fits that.
 *
 *   - **`head -3` instead of `-5`.** Compilers that produce useful
 *     output do so in the first 1-2 lines. Three is plenty and the
 *     literal is one byte shorter.
 *
 *   - No `2>&1` — errors still go to console (see listing script).
 */
export function buildVersionScript(candidates: readonly string[]): string {
  const unique = Array.from(new Set(candidates));
  return (
    `echo ${SURVEY_BEGIN};` +
    `for n in ${unique.join(' ')};` +
    `do echo =$n=;($n --version||$n -V||$n -v||$n)|head -3;done;` +
    `echo ${SURVEY_END}`
  );
}

export interface ExtractResult {
  /** Extracted survey-script output (between begin/end markers). */
  readonly text: string;
  /** True if the END marker was found — the script ran to completion. */
  readonly complete: boolean;
}

/**
 * Extract the survey-script output from a `result.bootStdout`.
 *
 * - **Both markers present:** returns the substring between them and
 *   `complete: true`.
 * - **Only the BEGIN marker present:** returns the substring from the
 *   marker to the end of `bootStdout` and `complete: false`. This
 *   happens when the harness's 8M boot budget runs out mid-listing
 *   (FAT filesystem on 1.44 MB media is right at the edge); the
 *   transcript captured before the timeout is still useful.
 * - **No BEGIN marker:** returns `{ text: '', complete: false }`. The
 *   init script never ran (or its output was clobbered).
 */
export function extractSurveyOutput(bootStdout: string): ExtractResult {
  const beginIdx = bootStdout.lastIndexOf(SURVEY_BEGIN);
  if (beginIdx < 0) return { text: '', complete: false };
  const beginLineEnd = bootStdout.indexOf('\n', beginIdx);
  if (beginLineEnd < 0) return { text: '', complete: false };
  const endIdx = bootStdout.indexOf(SURVEY_END, beginLineEnd);
  if (endIdx < 0) {
    return { text: bootStdout.slice(beginLineEnd + 1), complete: false };
  }
  return { text: bootStdout.slice(beginLineEnd + 1, endIdx), complete: true };
}

interface RunSurveyOptions {
  /**
   * Override default per-probe instruction budget. Default is
   * 80M; HD images may need more time but the harness's
   * `BOOT_INSTRUCTION_BUDGET` (8M) caps the boot phase regardless.
   */
  readonly timeoutInstructions?: number;
}

const DEFAULT_TIMEOUT_INSTRUCTIONS = 80_000_000;

/**
 * Run the two probes against a single candidate image. The image is
 * loaded from disk (skip-with-reason if absent), a fresh /bootopts is
 * built embedding the listing script, and `runProbe()` is invoked. The
 * output is read from `result.bootStdout` (not `result.stdout`) per the
 * workaround documented at the top of this file.
 */
export async function runSurvey(
  image: ImageCandidate,
  opts: RunSurveyOptions = {},
): Promise<SurveyResult> {
  if (!existsSync(image.path)) {
    return {
      image,
      listing: nullListingOutcome(),
      versions: null,
      verdict: { kind: 'fixture-missing' },
    };
  }

  const raw = readFileSync(image.path);
  const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  // ---- Probe 1: binary listing ------------------------------------------
  const listingScript = buildListingScript();
  const listingBootopts = buildBootoptsWithScript(listingScript);
  const listingPrimary = applyBootopts(rawBytes, listingBootopts);
  let listingProbe: ProbeResult;
  try {
    listingProbe = await runProbe({
      primaryImage: listingPrimary,
      // The probe disk is unused (we ignore result.stdout) but runProbe
      // requires a probe filename + script. Use a no-op.
      probe: { filename: 'noop.sh', script: 'true\n' },
      ...buildProbeOpts(opts),
    });
  } catch (err) {
    // Some images aren't supported by the harness's `inferGeometry()`
    // — e.g. hd32mbr (32546304 B) maps to the same CHS as hd32
    // (32514048 B), and the resulting size mismatch is thrown from
    // InMemoryDisk's constructor. We can't extend the harness (Rule 7),
    // so this surfaces as a `boot-failed` verdict.
    return {
      image,
      listing: nullListingOutcome(),
      versions: null,
      verdict: {
        kind: 'boot-failed',
        reason: `harness rejected image: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (listingProbe.kernelPanicked) {
    return {
      image,
      listing: { probe: listingProbe, parsed: emptyListing() },
      versions: null,
      verdict: {
        kind: 'boot-failed',
        reason: 'kernel panic during boot or init script',
      },
    };
  }

  const extracted = extractSurveyOutput(listingProbe.bootStdout);
  if (extracted.text === '') {
    return {
      image,
      listing: { probe: listingProbe, parsed: emptyListing() },
      versions: null,
      verdict: {
        kind: 'boot-failed',
        reason: listingProbe.timedOut
          ? `boot did not reach a # prompt or survey-begin marker within ` +
            `${listingProbe.instructionsUsed.toLocaleString()} instructions ` +
            `(harness BOOT_INSTRUCTION_BUDGET = 8M is fixed)`
          : 'survey markers missing in bootStdout — init script did not ' +
            'execute or output was clobbered before the prompt',
      },
    };
  }

  const listing = parseBinaryListing(extracted.text, PROBE_DIRECTORIES);

  // If the listing is incomplete (timed out mid-scan) but we got useful
  // data, surface it as `partial-listing-only`-style boot-failed: the
  // verdict is honest ("we couldn't finish"), but the caller (and the
  // report) gets the entries we did capture, and any compiler-shaped
  // names we did spot.
  if (!extracted.complete) {
    return {
      image,
      listing: { probe: listingProbe, parsed: listing },
      versions: null,
      verdict: {
        kind: 'boot-failed',
        reason:
          `listing script started but did not complete — got ` +
          `${listing.entries.length} entries before the harness's 8M ` +
          `boot budget ran out. Compiler-shape detection ran on the ` +
          `partial transcript: ${listing.compilerCandidates.length} ` +
          `candidate(s) found in what we saw.`,
      },
    };
  }

  if (listing.compilerCandidates.length === 0) {
    return {
      image,
      listing: { probe: listingProbe, parsed: listing },
      versions: null,
      verdict: { kind: 'no-compilers' },
    };
  }

  // ---- Probe 2: version checks ------------------------------------------
  const candidateNames = listing.compilerCandidates.map((c) => c.name);
  const versionScript = buildVersionScript(candidateNames);
  let versionBootopts: Buffer;
  try {
    versionBootopts = buildBootoptsWithScript(versionScript);
  } catch (err) {
    // Too many candidates to fit the version script in 1024 bytes.
    // Truncate to what fits — pick the most-likely-real compilers.
    const truncated = candidateNames.slice(0, 6);
    versionBootopts = buildBootoptsWithScript(buildVersionScript(truncated));
  }
  const versionPrimary = applyBootopts(rawBytes, versionBootopts);
  const versionProbe = await runProbe({
    primaryImage: versionPrimary,
    probe: { filename: 'noop.sh', script: 'true\n' },
    ...buildProbeOpts(opts),
  });

  let verdict: SurveyVerdict;
  let versions: ProbeOutcome<readonly VersionResult[]> | null;
  if (versionProbe.timedOut || versionProbe.kernelPanicked) {
    versions = { probe: versionProbe, parsed: [] };
    verdict = {
      kind: 'boot-failed',
      reason: 'version-check probe boot timed out or panicked',
    };
  } else {
    const versionTranscript = extractSurveyOutput(versionProbe.bootStdout);
    const parsed = parseVersionOutput(versionTranscript.text);
    versions = { probe: versionProbe, parsed };
    const working = parsed.filter((v) => v.status === 'working').map((v) => v.name);
    if (working.length === 0) {
      verdict = { kind: 'compilers-broken' };
    } else {
      verdict = { kind: 'compilers-working', working };
    }
  }

  return {
    image,
    listing: { probe: listingProbe, parsed: listing },
    versions,
    verdict,
  };
}

function buildProbeOpts(opts: RunSurveyOptions): Partial<ProbeRequest> {
  const out: { timeoutInstructions?: number } = {};
  out.timeoutInstructions = opts.timeoutInstructions ?? DEFAULT_TIMEOUT_INSTRUCTIONS;
  return out;
}

function nullListingOutcome(): ProbeOutcome<BinaryListing> {
  return {
    probe: nullProbeResult(),
    parsed: emptyListing(),
  };
}

function nullProbeResult(): ProbeResult {
  return {
    stdout: '',
    fullTranscript: '',
    bootStdout: '',
    timedOut: true,
    kernelPanicked: false,
    truncated: false,
    instructionsUsed: 0,
  };
}

function emptyListing(): BinaryListing {
  return {
    entries: [],
    compilerCandidates: [],
    missingDirs: [],
    hasSentinel: false,
  };
}

