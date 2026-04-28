/**
 * Unit tests for the binary-listing parser (Phase 13).
 *
 * Synthetic transcripts exercise the parser without booting. Real
 * boot transcripts exercise it via the integration test
 * (`tests/integration/toolchain-survey.test.ts`), which lands data in
 * the report.
 */

import { describe, it, expect } from 'vitest';
import { parseBinaryListing, SECTION_MARKER } from './parse-binary-listing.js';

describe('parseBinaryListing', () => {
  it('parses a normal `ls -la` output and identifies compiler-shaped binaries', () => {
    const transcript = [
      'total 24',
      '-rwxr-xr-x   1 root     root         9876 Mar 21 12:34 bcc',
      '-rwxr-xr-x   1 root     root         5432 Mar 21 12:34 as86',
      '-rwxr-xr-x   1 root     root         4321 Mar 21 12:34 ls',
      'drwxr-xr-x   2 root     root           48 Mar 21 12:34 subdir',
      SECTION_MARKER,
      'total 4',
      '-rwxr-xr-x   1 root     root         1024 Mar 21 12:34 sh',
      SECTION_MARKER,
      '__PROBE_DONE__',
    ].join('\n');

    const result = parseBinaryListing(transcript, ['/usr/bin', '/bin', '/sbin']);

    expect(result.entries.map((e) => e.name)).toEqual(['bcc', 'as86', 'ls', 'sh']);
    expect(result.compilerCandidates.map((e) => e.name)).toEqual(['bcc', 'as86']);
    expect(result.entries[0]?.dir).toBe('/usr/bin');
    expect(result.entries[3]?.dir).toBe('/bin');
    expect(result.entries[0]?.sizeBytes).toBe(9876);
    expect(result.hasSentinel).toBe(true);
    expect(result.missingDirs).toEqual([]);
  });

  it('records missing directories without producing entries', () => {
    const transcript = [
      "ls: /usr/include/: No such file or directory",
      SECTION_MARKER,
      'total 1',
      '-rwxr-xr-x   1 root     root          512 Mar 21 12:34 cc',
      SECTION_MARKER,
    ].join('\n');

    const result = parseBinaryListing(transcript, ['/usr/include', '/usr/bin']);

    expect(result.missingDirs).toEqual(['/usr/include']);
    expect(result.entries.map((e) => e.name)).toEqual(['cc']);
    expect(result.compilerCandidates.map((e) => e.name)).toEqual(['cc']);
    expect(result.hasSentinel).toBe(false);
  });

  it('handles symlinks (preserves the source name, not the target)', () => {
    const transcript = [
      'total 8',
      'lrwxrwxrwx   1 root     root            7 Mar 21 12:34 cc -> bcc',
      '-rwxr-xr-x   1 root     root         9876 Mar 21 12:34 bcc',
      SECTION_MARKER,
    ].join('\n');

    const result = parseBinaryListing(transcript, ['/usr/bin']);

    expect(result.entries.map((e) => e.name)).toEqual(['cc', 'bcc']);
    expect(result.entries[0]?.perms?.startsWith('l')).toBe(true);
    expect(result.compilerCandidates.map((e) => e.name)).toEqual(['cc', 'bcc']);
  });

  it('detects c86 / cc / gcc / make / ld86 substring matches; skips false positives', () => {
    const transcript = [
      'total 8',
      '-rwxr-xr-x   1 root     root          100 Mar 21 12:34 c86',
      '-rwxr-xr-x   1 root     root          100 Mar 21 12:34 ld86',
      '-rwxr-xr-x   1 root     root          100 Mar 21 12:34 gccfront',
      '-rwxr-xr-x   1 root     root          100 Mar 21 12:34 access',
      '-rwxr-xr-x   1 root     root          100 Mar 21 12:34 unrelated',
      '-rwxr-xr-x   1 root     root          100 Mar 21 12:34 make',
      SECTION_MARKER,
    ].join('\n');

    const result = parseBinaryListing(transcript, ['/usr/bin']);
    const compilerNames = result.compilerCandidates.map((e) => e.name);

    expect(compilerNames).toContain('c86');
    expect(compilerNames).toContain('ld86');
    expect(compilerNames).toContain('gccfront');
    expect(compilerNames).toContain('make');
    expect(compilerNames).not.toContain('access');
    expect(compilerNames).not.toContain('unrelated');
  });

  it('returns empty entries for a totally empty transcript', () => {
    const result = parseBinaryListing('', ['/usr/bin']);
    expect(result.entries).toEqual([]);
    expect(result.compilerCandidates).toEqual([]);
    expect(result.missingDirs).toEqual([]);
    expect(result.hasSentinel).toBe(false);
  });

  it('survives mixed CRLF line endings and unusual whitespace', () => {
    const transcript = [
      'total 4\r',
      '-rwxr-xr-x   1 root     root         1024 Mar 21 12:34 cc\r',
      '-rwxr-xr-x   1 root     root         2048 Mar 21 12:34  spaced  \r',
      SECTION_MARKER,
    ].join('\n');

    const result = parseBinaryListing(transcript, ['/usr/bin']);
    expect(result.entries.map((e) => e.name)).toContain('cc');
    expect(result.entries[0]?.perms).toBe('-rwxr-xr-x');
  });
});
