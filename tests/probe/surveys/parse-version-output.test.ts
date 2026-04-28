/**
 * Unit tests for the version-output parser (Phase 13).
 */

import { describe, it, expect } from 'vitest';
import { parseVersionOutput } from './parse-version-output.js';

describe('parseVersionOutput', () => {
  it('classifies a working compiler with a version string', () => {
    const transcript = [
      '=== bcc ===',
      'bcc: version 0.16.21',
      'usage: bcc [-options] file.c',
      '',
    ].join('\n');

    const result = parseVersionOutput(transcript);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('bcc');
    expect(result[0]?.status).toBe('working');
    expect(result[0]?.summary).toBe('bcc: version 0.16.21');
  });

  it('classifies multiple compilers across `=== name ===` sections', () => {
    const transcript = [
      '=== bcc ===',
      'bcc: version 0.16.21',
      '=== as86 ===',
      'as86 1.0',
      '=== ld86 ===',
      'ld86 not found',
      '=== mystery ===',
      'segfault',
    ].join('\n');

    const result = parseVersionOutput(transcript);
    expect(result.map((r) => r.name)).toEqual(['bcc', 'as86', 'ld86', 'mystery']);
    expect(result.map((r) => r.status)).toEqual([
      'working',
      'working',
      'missing',
      'broken',
    ]);
  });

  it('classifies an empty section as broken', () => {
    const transcript = [
      '=== broken_one ===',
      '',
      '=== other ===',
      'usage: other [opts]',
    ].join('\n');

    const result = parseVersionOutput(transcript);
    expect(result[0]?.status).toBe('broken');
    expect(result[0]?.summary).toBe('');
    expect(result[1]?.status).toBe('working');
  });

  it('detects "command not found" as missing across phrasings', () => {
    const transcript = [
      '=== gcc ===',
      'gcc: not found',
      '=== fortran ===',
      'sh: fortran: command not found',
      '=== cc ===',
      'No such file or directory',
    ].join('\n');

    const result = parseVersionOutput(transcript);
    expect(result.map((r) => r.status)).toEqual(['missing', 'missing', 'missing']);
  });

  it('returns an empty list when no `=== ===` sections are present', () => {
    const transcript = 'random shell noise without any section markers\n';
    const result = parseVersionOutput(transcript);
    expect(result).toEqual([]);
  });
});
