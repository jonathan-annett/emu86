/**
 * Unit tests for the version-flag probe classifier (Phase 13.1).
 *
 * Synthetic transcripts only — no booting. The integration test in
 * `tests/integration/hd32-version-probe.test.ts` exercises the full
 * pipeline against the real `hd32-minix.img` fixture.
 */

import { describe, it, expect } from 'vitest';
import {
  buildVersionProbeScript,
  classifyVersionTranscript,
  extractVersionRegion,
  HD32_VERSION_CANDIDATES,
  VERSION_PROBE_END,
} from './version-probe.js';

describe('version-probe — buildVersionProbeScript', () => {
  it('emits a for-loop with $n: section headers and the END marker', () => {
    const script = buildVersionProbeScript(['c86', 'as']);
    expect(script).toContain('for n in c86 as;');
    expect(script).toContain('echo $n:;');
    expect(script).toContain('-v </dev/null');
    expect(script).toContain('-V');
    expect(script.endsWith(`echo ${VERSION_PROBE_END}`)).toBe(true);
  });

  it('redirects stdin from /dev/null on the first invocation to prevent hangs', () => {
    // dev86 binaries on hd32-minix.img read stdin after their version
    // flag — without `</dev/null` they hang waiting for EOF that never
    // comes from the bootopts shell.
    const script = buildVersionProbeScript(['c86']);
    expect(script).toContain('-v </dev/null');
  });

  it('fits the seven HD32 candidates inside the ~115-byte init-arg budget', () => {
    // ELKS init's argv string buffer is 160 bytes; after argv overhead
    // the script body has ~115 effective bytes. Overflow causes a
    // truncation panic ("OTDEV=" — `RO` of `ROOTDEV=` got clobbered).
    const script = buildVersionProbeScript(HD32_VERSION_CANDIDATES);
    expect(script.length).toBeLessThanOrEqual(105);
  });

  it('rejects candidate names containing shell metacharacters', () => {
    expect(() => buildVersionProbeScript(['c86;rm'])).toThrow(/disallowed/);
    expect(() => buildVersionProbeScript(['c$86'])).toThrow(/disallowed/);
    expect(() => buildVersionProbeScript(['a b'])).toThrow(/disallowed/);
  });

  it('throws on an empty candidate list', () => {
    expect(() => buildVersionProbeScript([])).toThrow(/empty/);
  });

  it('de-duplicates candidates while preserving first-occurrence order', () => {
    const script = buildVersionProbeScript(['c86', 'cpp', 'c86', 'as']);
    expect(script).toContain('for n in c86 cpp as;');
  });
});

describe('version-probe — classifyVersionTranscript', () => {
  it('classifies a binary that printed a version string as `works`', () => {
    const transcript = ['c86:', 'c86 v5.2.0 (dev) (22 Dec 2024)'].join('\n');
    const result = classifyVersionTranscript(transcript, ['c86']);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('c86');
    expect(result[0]?.status).toBe('works');
    expect(result[0]?.summary).toBe('c86 v5.2.0 (dev) (22 Dec 2024)');
  });

  it('classifies a binary that printed only a usage banner as `works`', () => {
    const transcript = [
      'make:',
      'Usage: make [-f makefile] [-inpqrst] [macro=val ...] [target(s) ...]',
    ].join('\n');
    const result = classifyVersionTranscript(transcript, ['make']);
    expect(result[0]?.status).toBe('works');
  });

  it('classifies an empty section as `silent`', () => {
    const transcript = ['cpp:', '', 'as:', 'usage: as'].join('\n');
    const result = classifyVersionTranscript(transcript, ['cpp', 'as']);
    expect(result[0]?.status).toBe('silent');
    expect(result[1]?.status).toBe('works');
  });

  it('classifies crash signatures as `crashed` even when output looks numeric', () => {
    // A segfault message with a stack address looks "numeric" — we want
    // CRASHED_PATTERNS to win over the version-shape heuristic.
    const transcript = ['ld:', 'segmentation fault at 0x1234'].join('\n');
    const result = classifyVersionTranscript(transcript, ['ld']);
    expect(result[0]?.status).toBe('crashed');
    expect(result[0]?.summary).toMatch(/segmentation fault/i);
  });

  it('classifies "not found" / "command not found" as `crashed`', () => {
    const transcript = ['gcc:', 'sh: gcc: not found'].join('\n');
    const result = classifyVersionTranscript(transcript, ['gcc']);
    expect(result[0]?.status).toBe('crashed');
  });

  it('classifies an expected binary whose section never appeared as `hung`', () => {
    // The shell loop produced sections for c86 and cpp; ld's section
    // never appeared. Most likely the loop stalled at cpp until the
    // boot budget ran out.
    const transcript = [
      'c86:',
      'c86 v5.2.0',
      'cpp:',
      'usage: cpp',
      // (loop stalls here — no `ld:`)
    ].join('\n');
    const result = classifyVersionTranscript(transcript, ['c86', 'cpp', 'ld']);
    expect(result.map((r) => r.status)).toEqual(['works', 'works', 'hung']);
    expect(result[2]?.summary).toBe('');
    expect(result[2]?.raw).toBe('');
  });

  it('parses multiple consecutive sections and preserves order', () => {
    const transcript = [
      'leading shell noise we ignore',
      'c86:',
      'c86 v5.2.0 (dev)',
      'cpp:',
      'usage: cpp [-options]',
      'as:',
      'as86 version 1.0',
      'ld:',
      'ld86 version 1.0',
    ].join('\n');
    const result = classifyVersionTranscript(transcript, ['c86', 'cpp', 'as', 'ld']);
    expect(result.map((r) => r.name)).toEqual(['c86', 'cpp', 'as', 'ld']);
    expect(result.map((r) => r.status)).toEqual(['works', 'works', 'works', 'works']);
  });

  it('does not classify "FATAL" as crashed when the binary was clearly executing', () => {
    // Real cpp output on hd32-minix.img: it reports "CPP-FATAL error: Usage:"
    // for unrecognized flags. That's *evidence-of-execution*, not a crash —
    // the conservative crashed-patterns ignore generic `fatal`.
    const transcript = [
      'cpp:',
      'CPP Unknown option -v',
      'CPP-FATAL error: Usage: cpp [-0pdAKTV] -Dxxx -Uxxx -Ixxx infile -o outfile',
    ].join('\n');
    const result = classifyVersionTranscript(transcript, ['cpp']);
    expect(result[0]?.status).toBe('works');
  });

  it('does not mistake a colon-line inside a binary\'s body for a new section', () => {
    // Some Dev86 binaries print `Usage:` (lowercase u) on bare invocation.
    // The classifier restricts section anchors to `expected` names, so a
    // `Usage:` or `archive:` body line doesn't get treated as a section
    // boundary.
    const transcript = [
      'c86:',
      'c86 v5.2.0',
      'Usage: c86 ...',
      'options:',
      'cpp:',
      'usage: cpp [opts]',
    ].join('\n');
    const result = classifyVersionTranscript(transcript, ['c86', 'cpp']);
    expect(result).toHaveLength(2);
    // c86's body contains the Usage:/options: lines — not split out.
    expect(result[0]?.raw).toContain('Usage: c86');
    expect(result[0]?.raw).toContain('options:');
    expect(result[1]?.raw).toContain('usage: cpp [opts]');
  });
});

describe('version-probe — extractVersionRegion', () => {
  it('extracts the region from first <name>: line through the END marker', () => {
    const bootStdout = [
      'kernel boot output',
      '# ',
      'c86:',
      'c86 v5.2.0',
      VERSION_PROBE_END,
      '# ',
    ].join('\n');
    const result = extractVersionRegion(bootStdout, ['c86']);
    expect(result.complete).toBe(true);
    expect(result.text).toContain('c86:');
    expect(result.text).toContain('c86 v5.2.0');
    expect(result.text).not.toContain(VERSION_PROBE_END);
  });

  it('returns the tail when END marker is missing (boot timed out mid-probe)', () => {
    const bootStdout = [
      'kernel boot output',
      'c86:',
      'c86 v5.2.0',
      // (boot timed out before END marker)
    ].join('\n');
    const result = extractVersionRegion(bootStdout, ['c86']);
    expect(result.complete).toBe(false);
    expect(result.text).toContain('c86:');
    expect(result.text).toContain('c86 v5.2.0');
  });

  it('returns empty when no <name>: line appears (probe never ran)', () => {
    const bootStdout = 'kernel boot output\n# \n';
    const result = extractVersionRegion(bootStdout, ['c86']);
    expect(result.complete).toBe(false);
    expect(result.text).toBe('');
  });

  it('uses the default candidate list when none is provided', () => {
    const bootStdout = ['boot stuff', 'objdump:', 'Usage objdump'].join('\n');
    const result = extractVersionRegion(bootStdout);
    expect(result.text).toContain('objdump:');
  });
});
