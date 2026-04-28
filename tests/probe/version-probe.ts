/**
 * Version-flag probe — classifier and script builder (Phase 13.1).
 *
 * The version probe answers a narrow question: does each of the seven
 * Dev86-shaped binaries on `hd32-minix.img` actually *run* when we ask
 * it for a version banner? It is the second-tier follow-up to the Phase
 * 13 survey, which proved the names exist but couldn't run them under
 * the old 8M boot budget.
 *
 * # Output classification
 *
 * For each candidate binary, the classifier returns one of:
 *
 *   - `works`: the binary printed something that proves it executed —
 *     a version string, a usage banner, a Dev86 / GNU identifier, or
 *     anything containing a version-shaped numeric token. Phase 14
 *     in-VM compile is plausible if `c86` plus one of `as`/`ld` land
 *     here.
 *   - `silent`: the binary produced no output at all. Possibly a
 *     binary that needs different invocation flags; possibly a stub.
 *     Either way, it isn't useful evidence-of-function.
 *   - `crashed`: the binary printed a crash signature (segfault,
 *     killed, trap, fatal, "not found"). It does not run usefully.
 *   - `hung`: the binary's section header never appeared in the
 *     transcript. The shell loop stalled before reaching it — most
 *     likely because the previous binary hung the kernel/process
 *     until the boot budget ran out.
 *
 * The classifier is pure: input transcript + expected binary list,
 * output per-binary classifications. Synthetic-transcript unit-testable.
 *
 * # Script shape — why bootopts-embedded, not /dev/fd1
 *
 * Same workaround as Phase 13's listing probe: the harness's
 * `runUntilSentinel` would catch the launch line's echoed
 * `__PROBE_DONE__` before any non-trivial probe could run. So the
 * version-flag loop is stashed in `/bootopts` as the init argv and
 * runs during the boot phase. Output appears in `result.bootStdout`,
 * terminated by `__E__` — see {@link extractVersionRegion}.
 *
 * # Marker shape
 *
 * - `__E__`: trailing completion marker. Its presence means the script
 *   ran to completion; its absence (under timeout) means a binary in
 *   the loop hung before reaching the end.
 *
 * - `<name>:` per binary: section header. Same shape as the Phase 13
 *   listing probe's `echo $d:` per-directory header. Empirically
 *   tested: ELKS's shell parses `echo $n:` cleanly. (We initially
 *   tried `echo =$n=` — that broke ELKS sash with "Bad -c option";
 *   words starting with `=` get special-cased by the shell. The
 *   `<name>:` form is what survey-runner.ts already uses.)
 *
 * # Per-binary stdin handling — `</dev/null`
 *
 * Empirical finding: dev86 binaries on `hd32-minix.img` accept their
 * version flag and then *read stdin* before exiting. With no input
 * available, they hang forever. The first invocation (`$n -v`) gets
 * `</dev/null` redirected so a stdin-reading binary sees EOF and
 * exits cleanly — this is what unblocks `c86 -v` (which prints its
 * version *and* compiles the empty stdin into empty assembly).
 *
 * The `||` fallbacks (`$n -V` and bare `$n`) inherit the parent's
 * stdin. In practice — verified against the actual fixture — those
 * fallback invocations either error-out fast (`-V` unrecognized) or
 * print usage and exit; neither hangs on stdin.
 *
 * # Init-arg budget
 *
 * ELKS init's argv parser caps the parsed string buffer at 160 bytes
 * (`MAX_INIT_SLEN = 80` chars × 2 for argv+envp). After argv overhead
 * (`/bin/sh\0` + `-c\0` + `;exec /bin/sh` suffix + `ROOTDEV=/dev/hda`
 * env injection), argv[2] has ~115 effective bytes. Overflow is
 * fatal — ELKS init panics with a truncated `OTDEV=/dev/hda` message
 * (the `RO` of `ROOTDEV=` got clobbered by the overflow).
 *
 * The seven-binary version script lands at 94 bytes; with the
 * `;exec /bin/sh` shell-handoff suffix that's 107 bytes, comfortably
 * under the empirical 115-byte limit.
 *
 * Compactness choices:
 *   - Basenames (`c86`) instead of full paths (`/usr/bin/c86`) — saves
 *     63 bytes across 7 binaries.
 *   - `$n:` instead of `=== $n ===` — saves 6 bytes per call site
 *     and avoids the leading-`=` shell-parser hazard.
 *   - No leading `__B__` marker — the first `<name>:` line is the
 *     natural region start; saves 11 bytes (the `echo __B__;`).
 *   - Three flag attempts (`-v` first, then `-V`, then bare) instead
 *     of four (`--version` dropped) — Dev86 binaries don't accept
 *     `--version` and the wasted bytes pushed us over budget.
 *   - No `head -N` pipeline, no `2>&1` — the harness's 1 MB output
 *     cap is plenty and ELKS shell sends stderr to the same UART.
 */

/** The seven candidate binaries Phase 13 found on `hd32-minix.img`. */
export const HD32_VERSION_CANDIDATES: readonly string[] = [
  'c86',
  'cpp',
  'as',
  'ld',
  'make',
  'ar',
  'objdump',
];

/** Trailing completion marker — script reached its end. */
export const VERSION_PROBE_END = '__E__';

/**
 * Build the version-flag probe shell script for the given basenames.
 *
 * Shape:
 *
 *     for n in c86 cpp as ld make ar objdump;\
 *       do echo $n:;$n -v </dev/null||$n -V||$n;done;\
 *       echo __E__
 *
 * The chained `||` walks through version flags in order of how Dev86
 * binaries respond:
 *   1. `$n -v </dev/null` — Dev86's preferred verbose/version flag,
 *      with stdin closed so a stdin-reading binary sees EOF and exits.
 *   2. `$n -V` — System V style (`as`, `ld` historical convention).
 *   3. `$n` (bare) — last-resort: many tools print usage on no-args.
 *
 * Only the first successful invocation runs; later branches don't
 * fire when an earlier one exits 0.
 *
 * The trailing `echo __E__` is the only marker — the first
 * `<name>:` line is the natural region start. See
 * {@link extractVersionRegion}.
 *
 * Throws on names that contain shell metacharacters (defence in
 * depth — the seven Dev86 names are all `[A-Za-z0-9]+`).
 */
export function buildVersionProbeScript(candidates: readonly string[]): string {
  if (candidates.length === 0) {
    throw new Error('buildVersionProbeScript: candidates list is empty');
  }
  const unique = Array.from(new Set(candidates));
  // Validate names: must be safe for unquoted shell expansion. Reject
  // anything outside `[A-Za-z0-9._+-]` to keep the script safely
  // injectable. The seven Dev86 names all qualify.
  for (const name of unique) {
    if (!/^[A-Za-z0-9._+-]+$/.test(name)) {
      throw new Error(
        `buildVersionProbeScript: candidate name "${name}" contains ` +
          `disallowed characters (must match /^[A-Za-z0-9._+-]+$/)`,
      );
    }
  }
  return (
    `for n in ${unique.join(' ')};` +
    `do echo $n:;$n -v </dev/null||$n -V||$n;done;` +
    `echo ${VERSION_PROBE_END}`
  );
}

/** Per-binary classification of the version-flag probe's output. */
export type VersionStatus = 'works' | 'silent' | 'crashed' | 'hung';

export interface VersionClassification {
  /** Binary name as the probe issued it (e.g. `c86`). */
  readonly name: string;
  readonly status: VersionStatus;
  /**
   * One-line summary for the report. For `works`, the first non-empty
   * line of captured output. For `crashed`, the matched crash
   * signature line. For `silent`/`hung`, an empty string.
   */
  readonly summary: string;
  /** Full captured output for the section (verbatim, may be empty). */
  readonly raw: string;
}

/**
 * Patterns that signal "this binary executed and reported something
 * useful". A version-string match is the strongest signal; a
 * usage-banner the next strongest. Numeric `\d+\.\d+` is the
 * weakest-but-still-useful: it's how Dev86 / bcc stamp themselves
 * even when they don't say "version" explicitly.
 */
const WORKS_PATTERNS: readonly RegExp[] = [
  /\bversion\b/i,
  /\busage:?/i,
  /\b\d+\.\d+(\.\d+)?\b/,
  /^Bruce/m,                 // bcc / Bruce's C Compiler self-identifier
  /^Dev86\b/im,
  /\bGNU\b/,
  /^as86\b/im,
  /^ld86\b/im,
  /^make:/im,                // GNU make's bare-invocation banner
  /\boptions:/i,             // common help-output marker
  /\bcopyright\b/i,
  // c86's verbose-mode self-identifier: `c86 v5.2.0 (dev) (...)`. The
  // version-shape pattern above already catches this; pinning the
  // explicit token form keeps the classifier robust if c86's banner
  // ever changes its numeric format (e.g. drops the dot).
  /^c86\b/im,
  // Dev86 ar / objdump emit `Usage:` / `Usage` (no colon) banners.
  /^Usage\b/im,
];

/**
 * Patterns signalling "this binary did NOT run usefully" — i.e. the
 * binary couldn't be executed (shell-not-found, can't-exec) or the
 * kernel terminated it (segfault, killed). Detected before
 * WORKS_PATTERNS so a crash banner doesn't accidentally match the
 * `\d+\.\d+` heuristic via a stray frame address.
 *
 * Deliberately conservative — `fatal` was too broad (Dev86's `cpp`
 * reports `CPP-FATAL error: Usage:` for an unrecognized flag, which
 * is *evidence-of-execution*, not a crash). We require explicit
 * crash language: `segmentation fault`, `killed`, `core dumped`, etc.
 */
const CRASHED_PATTERNS: readonly RegExp[] = [
  /\bnot found\b/i,
  /\bno such file\b/i,
  /\bcommand not found\b/i,
  /\bsegmentation fault\b/i,
  /\bsegfault\b/i,
  /\bkilled\b/i,
  /\bcore dumped\b/i,
  /\bbus error\b/i,
  /\bunknown signal\b/i,
  /\bcannot exec\b/i,
  /\billegal instruction\b/i,
  /\bgeneral protection\b/i,
];

/**
 * Parse a version-flag probe transcript and classify each expected
 * candidate. The `expected` list must be the same names passed to
 * {@link buildVersionProbeScript}; binaries whose `<name>:` header
 * never appears are classified as `hung` (the loop stalled).
 *
 * Input transcript shape — what {@link extractVersionRegion} returns:
 *
 *     c86:
 *     c86 v5.2.0 (dev) (22 Dec 2024)
 *     cpp:
 *     ...
 *     objdump:
 *     <output for objdump>
 *
 * Tolerant of leading shell noise before the first `<name>:`. Each
 * `<name>:` must appear at the start of a line; trailing whitespace
 * is allowed. Section names must come from the `expected` list — we
 * only treat a `<name>:` line as a section header when `<name>` is a
 * known candidate, so a binary that prints `usage:` (lowercase) or
 * an `ar`-style `archive:` line in its body doesn't get misparsed
 * as a new section.
 */
export function classifyVersionTranscript(
  transcript: string,
  expected: readonly string[],
): readonly VersionClassification[] {
  const sections = splitVersionSections(transcript, expected);
  const byName = new Map<string, string>();
  for (const s of sections) byName.set(s.name, s.body);

  const out: VersionClassification[] = [];
  for (const name of expected) {
    const raw = byName.get(name);
    if (raw === undefined) {
      out.push({ name, status: 'hung', summary: '', raw: '' });
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
      out.push({ name, status: 'silent', summary: '', raw });
      continue;
    }
    const crashLine = matchAnyLine(raw, CRASHED_PATTERNS);
    if (crashLine !== null) {
      out.push({ name, status: 'crashed', summary: crashLine, raw });
      continue;
    }
    if (WORKS_PATTERNS.some((re) => re.test(raw))) {
      out.push({ name, status: 'works', summary: firstUsefulLine(raw), raw });
      continue;
    }
    // Output present but doesn't match any known signal. Surface the
    // first line so a human can spot-check; classify as `silent`
    // since we can't prove it's a working compiler.
    out.push({
      name,
      status: 'silent',
      summary: firstUsefulLine(raw),
      raw,
    });
  }
  return out;
}

interface VersionSection {
  readonly name: string;
  readonly body: string;
}

/**
 * Split a transcript into per-binary sections, anchoring on
 * `<name>:` lines where `<name>` is one of the expected candidates.
 * The `expected`-restriction prevents confusing colon-suffixed lines
 * inside a binary's output (e.g. `Usage:` from another tool, or a
 * permission line from `ls`) from being treated as section headers.
 */
function splitVersionSections(
  transcript: string,
  expected: readonly string[],
): readonly VersionSection[] {
  if (expected.length === 0) return [];
  // Build a regex that matches `<name>:` for any of the expected
  // candidates at line start. Names are pre-validated against
  // `/^[A-Za-z0-9._+-]+$/` so they're regex-safe to interpolate.
  const namesAlternation = expected
    .map((n) => n.replace(/[.+\-^$*?(){}|\\[\]]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`^(${namesAlternation}):\\s*$`, 'gm');
  const out: VersionSection[] = [];
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  let lastName: string | null = null;
  while ((match = re.exec(transcript)) !== null) {
    const name = match[1] ?? '';
    if (lastName !== null) {
      const body = transcript
        .slice(lastEnd, match.index)
        .replace(/^\n/, '')
        .replace(/\n$/, '');
      out.push({ name: lastName, body });
    }
    lastName = name;
    lastEnd = match.index + match[0].length;
  }
  if (lastName !== null) {
    const body = transcript
      .slice(lastEnd)
      .replace(/^\n/, '')
      .replace(/\n$/, '');
    out.push({ name: lastName, body });
  }
  return out;
}

function matchAnyLine(text: string, patterns: readonly RegExp[]): string | null {
  for (const line of text.split('\n')) {
    for (const re of patterns) {
      if (re.test(line)) return line.trim();
    }
  }
  return null;
}

function firstUsefulLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    return t;
  }
  return '';
}

export interface ExtractRegionResult {
  /**
   * Extracted region — from the first `<name>:` line up to the
   * `__E__` marker (or to EOF if the marker is missing).
   */
  readonly text: string;
  /** True iff the `__E__` marker appeared after a `<name>:` line. */
  readonly complete: boolean;
}

/**
 * Slice the version-probe region out of a `bootStdout`. Looks for the
 * first `<name>:` line where `<name>` is one of the expected
 * candidates (no separate BEGIN marker — the init-arg buffer is too
 * tight to afford one) and the `__E__` marker as the end. Returns
 * the tail-from-start when the END marker is missing (the boot
 * budget ran out mid-loop).
 */
export function extractVersionRegion(
  bootStdout: string,
  expected: readonly string[] = HD32_VERSION_CANDIDATES,
): ExtractRegionResult {
  if (expected.length === 0) return { text: '', complete: false };
  const namesAlternation = expected
    .map((n) => n.replace(/[.+\-^$*?(){}|\\[\]]/g, '\\$&'))
    .join('|');
  const startRe = new RegExp(`^(${namesAlternation}):\\s*$`, 'm');
  const startMatch = startRe.exec(bootStdout);
  if (startMatch === null) return { text: '', complete: false };
  const startIdx = startMatch.index;
  const endIdx = bootStdout.indexOf(VERSION_PROBE_END, startIdx);
  if (endIdx < 0) {
    return { text: bootStdout.slice(startIdx), complete: false };
  }
  return {
    text: bootStdout.slice(startIdx, endIdx),
    complete: true,
  };
}
