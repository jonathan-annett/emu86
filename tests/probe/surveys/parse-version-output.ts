/**
 * Parse the transcript of the "version-check" probe (Phase 13).
 *
 * The probe iterates over candidate compilers found by the
 * binary-listing probe, invoking `--version`, `-V`, `-v`, then bare,
 * separated by `=== <name> ===` markers. This module classifies each
 * compiler's response as one of:
 *
 *   - `working`: the binary printed something that looks like a version
 *     string or a recognisable usage banner (proves it executed).
 *   - `broken`: the binary ran but produced no useful output (empty,
 *     pure error, segfault chatter).
 *   - `missing`: the shell reported `not found` / `command not found`.
 *
 * The output of this probe is the survey's primary evidence. A
 * compiler that classifies as `working` is a candidate for Phase 14;
 * `broken` is documented as "present-but-unusable"; `missing` shouldn't
 * happen if the binary listing was honest, but is recorded for
 * defensive completeness.
 */

export type VersionStatus = 'working' | 'broken' | 'missing';

export interface VersionResult {
  /** Compiler name, e.g. `bcc`. Case as the probe issued it. */
  readonly name: string;
  readonly status: VersionStatus;
  /** First non-empty line of the captured output, trimmed. Useful for the report. */
  readonly summary: string;
  /** Full captured output for the section. */
  readonly raw: string;
}

/**
 * Section markers inserted by the version-check probe.
 *
 * Both forms are accepted on parse:
 *
 *   - `=<name>=` — the compact form used by the bootopts-embedded probe
 *     (Phase 13). Required because ELKS's init has a 160-byte argv
 *     buffer; saving 6 bytes per call site lets us probe more
 *     candidates per boot.
 *
 *   - `=== <name> ===` — the legacy form used by earlier survey
 *     probes that ran via the FAT12 disk path. Kept for the unit-test
 *     fixtures that predate the compact form.
 *
 * Both anchor to line starts; surrounding whitespace is tolerated.
 */
export const VERSION_SECTION_PREFIX = '=== ';
export const VERSION_SECTION_SUFFIX = ' ===';

/**
 * Patterns that signal "this binary executed and reported something
 * useful". A version-string match is the strongest signal; a usage
 * banner the next strongest. Both are consistent with the binary
 * actually being a compiler/assembler/linker rather than a coincidence
 * of filename.
 */
const WORKING_PATTERNS: readonly RegExp[] = [
  /\bversion\b/i,
  /\busage:/i,
  /\b\d+\.\d+(\.\d+)?\b/, // any "1.2" or "1.2.3" semver-ish token
  /^Bruce/m, // bcc identifies itself
  /^Dev86\b/im,
  /\bGNU\b/i,
  /^as86\b/im,
  /^ld86\b/im,
  /^cpp\b/im,
  /^make:/im, // GNU make's bare-invocation banner
];

/**
 * Patterns that signal "shell could not find this binary". The probe
 * iterates over compiler-shaped names found by the listing probe, so
 * a missing-binary outcome means the listing parser disagreed with
 * what's actually on PATH (rare, but worth flagging).
 */
const MISSING_PATTERNS: readonly RegExp[] = [
  /not found/i,
  /no such file/i,
  /command not found/i,
  /cannot find/i,
];

/**
 * Parse a version-check probe transcript into per-compiler results.
 *
 * Input shape (the probe emits this verbatim, after the harness has
 * already stripped the launch echo and the trailing sentinel):
 *
 *   === bcc ===
 *   bcc: version 0.16.21
 *   ...
 *   === ld86 ===
 *   ld86 not found
 *   ...
 *
 * The parser is tolerant of leading shell noise (the shell may print
 * the `for` loop's expansion before the first `===` marker) and of
 * trailing whitespace.
 */
export function parseVersionOutput(transcript: string): readonly VersionResult[] {
  const sections = splitSections(transcript);
  const out: VersionResult[] = [];
  for (const s of sections) {
    out.push({
      name: s.name,
      status: classify(s.text),
      summary: firstUsefulLine(s.text),
      raw: s.text,
    });
  }
  return out;
}

interface RawSection {
  readonly name: string;
  readonly text: string;
}

function splitSections(transcript: string): readonly RawSection[] {
  // Match either `=== <name> ===` (legacy) or `=<name>=` (compact).
  // The compact form requires the `=` characters to be at line starts
  // and the body to contain only word-chars (no spaces) so we don't
  // accidentally match lines like `=foo bar=` from compiler output.
  const re = /^(?:=== (\S+) ===|=([\w+\-.]+)=)$/gm;
  const out: RawSection[] = [];
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  let lastName: string | null = null;
  while ((match = re.exec(transcript)) !== null) {
    const name = match[1] ?? match[2] ?? '';
    if (lastName !== null) {
      const text = transcript.slice(lastEnd, match.index).replace(/^\n/, '').replace(/\n$/, '');
      out.push({ name: lastName, text });
    }
    lastName = name;
    lastEnd = match.index + match[0].length;
  }
  if (lastName !== null) {
    const text = transcript.slice(lastEnd).replace(/^\n/, '').replace(/\n$/, '');
    out.push({ name: lastName, text });
  }
  return out;
}

function classify(text: string): VersionStatus {
  const trimmed = text.trim();
  if (trimmed === '') return 'broken';
  if (MISSING_PATTERNS.some((re) => re.test(trimmed))) return 'missing';
  if (WORKING_PATTERNS.some((re) => re.test(trimmed))) return 'working';
  // If we got >0 chars but nothing matched a "working" pattern, it
  // executed but didn't identify itself as a compiler. Treat as broken
  // — the binary may be real but it's not telling us anything we can
  // build on.
  return 'broken';
}

function firstUsefulLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    return t;
  }
  return '';
}
