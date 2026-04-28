/**
 * Parse the transcript of the "binary-listing" probe (Phase 13).
 *
 * The probe script (in `survey-probes.ts`) emits a series of `ls -la`
 * outputs, separated by `__SECTION__` markers, then a final
 * `__PROBE_DONE__` line. This module turns that text into a structured
 * list of binaries and a list of compiler-shaped candidates.
 *
 * The probe transcript is what `runProbe()` returns as `result.stdout`,
 * after the harness has already stripped the launch echo and the
 * sentinel echo.
 *
 * # Why this lives in the survey module, not the probe harness
 *
 * The harness's job is "boot, run, capture". The transcript shape is
 * survey-specific: a different probe (a hello-world compile attempt,
 * say) would parse different markers. Keeping the parser here means
 * the harness stays generic.
 *
 * # Compiler-shape detection
 *
 * The brief lists the candidate names: `cc`, `gcc`, `bcc`, `cpp`, `as`,
 * `as86`, `ld`, `ld86`, `make`, `ar`, `ranlib`, anything with `cc` or
 * `c86` in its name. We match against an allowlist plus two
 * substring rules. The allowlist is exhaustive across what dev86 / bcc
 * / ELKS userland historically ship; the substring rules catch
 * variants like `tcc`, `pcc`, `c86` and similar.
 */

/** A single binary discovered by an `ls -la` listing. */
export interface BinaryEntry {
  /** Just the filename, e.g. `bcc`. */
  readonly name: string;
  /** Directory the listing was rooted at, e.g. `/usr/bin`. */
  readonly dir: string;
  /** Permissions string from `ls -la` (e.g. `-rwxr-xr-x`); null if unparseable. */
  readonly perms: string | null;
  /** Size in bytes (parsed from column 5 of `ls -la`); null if unparseable. */
  readonly sizeBytes: number | null;
}

/** Result of parsing a binary-listing probe transcript. */
export interface BinaryListing {
  /** All binary-shaped entries found, across all `ls` sections. */
  readonly entries: readonly BinaryEntry[];
  /** Compiler-shaped candidates (subset of `entries`). */
  readonly compilerCandidates: readonly BinaryEntry[];
  /** Sections that produced no output (e.g. `ls: /usr/include: No such file or directory`). */
  readonly missingDirs: readonly string[];
  /** True if the trailing `__PROBE_DONE__` sentinel appeared in the input. */
  readonly hasSentinel: boolean;
}

/** Section marker emitted between `ls` invocations. Same string in shell + parser. */
export const SECTION_MARKER = '__SECTION__';

/**
 * Compiler-name allowlist (case-insensitive). Drawn from the brief plus
 * dev86 / bcc / GNU toolchain conventions. Matched against bare
 * filenames, not full paths.
 */
const COMPILER_NAMES: ReadonlySet<string> = new Set([
  'cc', 'gcc', 'bcc', 'tcc', 'pcc', 'cpp', 'g++', 'c++',
  'as', 'as86', 'gas', 'nasm',
  'ld', 'ld86', 'gld',
  'make', 'gmake',
  'ar', 'ranlib', 'nm', 'strip', 'objcopy', 'objdump', 'size',
  'm4', 'lex', 'yacc', 'flex', 'bison',
]);

/**
 * Substring rules: any filename containing one of these tokens is
 * a compiler-shape candidate even if it isn't on the explicit list.
 * Lowercase comparison.
 */
const COMPILER_SUBSTRINGS: readonly string[] = ['cc', 'c86', 'gcc', 'bcc'];

/**
 * Filenames that incidentally contain `cc` but aren't compilers.
 * Without this denylist, `accept`, `access`, `bcheck` and similar
 * would be flagged. The list is small and conservative.
 */
const COMPILER_SUBSTRING_FALSE_POSITIVES: ReadonlySet<string> = new Set([
  'access', 'accept', 'recv', 'recvfrom', 'recvmsg', 'recvmmsg',
  'occur', 'success', 'recctl',
]);

/**
 * Parse a probe transcript into a structured listing.
 *
 * The transcript is either the body of `result.stdout` (legacy probe
 * path) or the survey-script region of `result.bootStdout` (Phase 13
 * /bootopts-embedded path). Two section-delimiting strategies are
 * supported, used in tandem on the same transcript:
 *
 *   1. **Explicit markers** — `__SECTION__` lines emitted by the script
 *      between `ls` invocations (one ls per section). The caller passes
 *      a directory list; section index → directory.
 *
 *   2. **Implicit headers** — when a single `ls -la <dir1> <dir2> …`
 *      command is used, both BusyBox and coreutils emit a `<dir>:`
 *      header line before each dir's listing. We recognise these and
 *      switch the current section's directory to the header's path.
 *
 * Strategy 2 was added when ELKS's tight init-arg buffer (160 bytes
 * total for argv/envp strings, see `init/main.c:MAX_INIT_SLEN`) made
 * multi-`ls` scripts overflow. A single `ls /bin /sbin /usr/bin …`
 * fits in ~80 bytes and produces the same data with header demarcation.
 *
 * If neither markers nor headers are present, the entire transcript is
 * treated as one section attributed to `directories[0]` (or
 * `<section-0>` if `directories` is empty).
 */
export function parseBinaryListing(
  transcript: string,
  directories: readonly string[],
): BinaryListing {
  const hasSentinel = transcript.includes('__PROBE_DONE__');
  const sansSentinel = transcript.replace(/__PROBE_DONE__\s*$/m, '').replace(/__PROBE_DONE__/g, '');
  const lines = sansSentinel.split('\n');

  const entries: BinaryEntry[] = [];
  const missingSet = new Set<string>();

  let sectionIndex = 0;
  let currentDir = directories[0] ?? '<section-0>';
  // Track whether the current section has had its dir overridden by a
  // header line — affects which directory we credit a missing-dir error to.
  let headerSeenInSection = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').trimEnd();
    if (line === '') continue;

    if (line === SECTION_MARKER) {
      sectionIndex += 1;
      currentDir = directories[sectionIndex] ?? `<section-${sectionIndex}>`;
      headerSeenInSection = false;
      continue;
    }

    const headerMatch = HEADER_RE.exec(line);
    if (headerMatch !== null) {
      const dir = headerMatch[1];
      if (dir !== undefined) {
        currentDir = dir;
        headerSeenInSection = true;
      }
      continue;
    }

    if (looksLikeMissingDirLine(line)) {
      // Try to extract the offending dir from the error message; fall
      // back to the current dir if extraction fails (e.g. `ls: foo: not found`).
      const m = /ls:\s*['"]?([^\s'":]+)/i.exec(line);
      // Strip trailing slash so `/usr/include/` and `/usr/include`
      // record as the same missing dir; ELKS busybox prints the former,
      // GNU coreutils sometimes the latter.
      const raw = m?.[1] ?? currentDir;
      const dir = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
      missingSet.add(dir);
      continue;
    }

    if (/^total\s/.test(line)) continue;

    const entry = parseLsLine(line, currentDir);
    if (entry !== null) {
      entries.push(entry);
    }
  }

  const compilerCandidates = entries.filter((e) => isCompilerShaped(e.name));
  // Used to satisfy noUnusedLocals — `headerSeenInSection` is currently
  // tracked for future error-attribution refinement, not exposed yet.
  void headerSeenInSection;

  return {
    entries,
    compilerCandidates,
    missingDirs: Array.from(missingSet),
    hasSentinel,
  };
}

/**
 * Header line emitted by `ls -la <dir1> <dir2>` between sections. We
 * accept absolute paths (starting `/`) ending with `:`; e.g. `/bin:`,
 * `/usr/include:`. Restricting to absolute paths avoids matching
 * unrelated `:` lines from compiler output, etc.
 */
const HEADER_RE = /^(\/[^\s:]*):$/;

function looksLikeMissingDirLine(line: string): boolean {
  return /\bls:\s.*\b(No such file|cannot access|not found)\b/i.test(line);
}

/**
 * Parse a single `ls -la` line into a {@link BinaryEntry}, or `null` if
 * the line isn't a recognisable file/symlink entry.
 *
 * Recognised shape: `<type><9 perm chars> <links> <user> <group> <size>
 * <date> <name>` where the date is exactly 3 whitespace-separated
 * fields (`Mar 21 12:34` or `Mar 21 2026`). BusyBox and GNU coreutils
 * both emit this shape under `ls -la`. Symlinks have ` -> target`
 * appended; we keep just the source name.
 *
 * Type filter: `-` (regular file) and `l` (symlink) only — we skip
 * directories, character / block devices, fifos, sockets.
 */
function parseLsLine(line: string, dir: string): BinaryEntry | null {
  const m = LS_RE.exec(line);
  if (m === null || m.groups === undefined) return null;
  const perms = (m.groups['type'] ?? '') + (m.groups['perms'] ?? '');
  const sizeTok = m.groups['size'];
  const sizeBytes = sizeTok !== undefined && /^\d+$/.test(sizeTok) ? Number(sizeTok) : null;
  const tail = (m.groups['tail'] ?? '').trim();
  const arrowIdx = tail.indexOf(' -> ');
  const name = arrowIdx >= 0 ? tail.slice(0, arrowIdx).trim() : tail;
  if (name === '' || name === '.' || name === '..') return null;
  return { name, dir, perms, sizeBytes };
}

const LS_RE =
  /^(?<type>[\-l])(?<perms>[rwxstST\-]{9})\s+(?<links>\d+)\s+(?<user>\S+)\s+(?<group>\S+)\s+(?<size>\d+)\s+(?<date>\S+\s+\S+\s+\S+)\s+(?<tail>.+)$/;

function isCompilerShaped(name: string): boolean {
  const lower = name.toLowerCase();
  if (COMPILER_NAMES.has(lower)) return true;
  if (COMPILER_SUBSTRING_FALSE_POSITIVES.has(lower)) return false;
  for (const sub of COMPILER_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  return false;
}
