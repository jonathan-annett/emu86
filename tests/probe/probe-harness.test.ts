/**
 * Unit tests for probe-harness pure logic (Phase 12).
 *
 * These tests exercise the harness's parsing, sentinel detection, and
 * launch-line construction without booting a VM. The end-to-end
 * boot-and-inject flow lives in `tests/integration/probe-harness-trivial.test.ts`
 * — that runs the actual machine.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLaunchLine,
  extractProbeStdout,
  PROBE_SENTINEL,
} from './probe-harness.js';

describe('probe-harness — buildLaunchLine', () => {
  it('produces a chained mount + sh + sentinel-echo line', () => {
    const line = buildLaunchLine('hello.sh');
    expect(line).toBe(
      'mount /dev/fd1 /mnt && sh /mnt/hello.sh; echo __PROBE_DONE__\n',
    );
  });

  it('uses the provided filename verbatim (case preserved for shell lookup)', () => {
    const line = buildLaunchLine('PROBE.SH');
    expect(line).toContain('sh /mnt/PROBE.SH');
  });

  it('always ends with a newline so the shell dispatches immediately', () => {
    expect(buildLaunchLine('p.sh').endsWith('\n')).toBe(true);
  });
});

describe('probe-harness — extractProbeStdout', () => {
  /**
   * Build a synthetic transcript that mirrors the real shape: kernel
   * banner, mount-and-prompt, the launch-line echo, the probe's output,
   * and the sentinel. Real ELKS transcripts include CRLF or LF — the
   * extractor uses LF only because the kernel's tty discipline emits
   * '\n' for keypress dispatch (the '\r' from injection is consumed).
   */
  function syntheticTranscript(probeFilename: string, probeStdout: string): string {
    return [
      'Linux ELKS v0.7.0 (build...)',
      'VFS: Mounted root device',
      '# ',
      `mount /dev/fd1 /mnt && sh /mnt/${probeFilename}; echo __PROBE_DONE__`,
      probeStdout,
      `${PROBE_SENTINEL}`,
      '# ',
    ].join('\n');
  }

  it('pulls out the probe stdout window cleanly', () => {
    const transcript = syntheticTranscript('hello.sh', 'hello-from-probe');
    expect(extractProbeStdout(transcript, 'hello.sh')).toBe('hello-from-probe');
  });

  it('handles multi-line probe output (preserves internal newlines)', () => {
    const out = 'line one\nline two\nline three';
    const transcript = syntheticTranscript('multi.sh', out);
    expect(extractProbeStdout(transcript, 'multi.sh')).toBe(out);
  });

  it('returns "" when the launch line is absent (probe never started)', () => {
    const transcript = 'kernel boot output only\n# \n';
    expect(extractProbeStdout(transcript, 'p.sh')).toBe('');
  });

  it('returns the tail when the sentinel is missing (timeout case)', () => {
    // Probe started but never reached the echo — output region runs to EOF.
    const transcript =
      'VFS: Mounted root device\n# \n' +
      'mount /dev/fd1 /mnt && sh /mnt/hang.sh; echo __PROBE_DONE__\n' +
      'partial output before hanging';
    expect(extractProbeStdout(transcript, 'hang.sh')).toBe(
      'partial output before hanging',
    );
  });

  it('finds the LAST launch-line occurrence (probe filename echoed in script too)', () => {
    // If the probe script itself prints the launch-line text (unlikely but
    // possible), we still want to anchor on the actual injected line, which
    // appears latest in the transcript. The sentinel is the unambiguous
    // boundary on the right; the launch line is unambiguous as the last
    // occurrence on the left because the shell echoes the injected line
    // exactly once.
    const transcript =
      'banner\n' +
      "echo 'mount /dev/fd1 /mnt && sh /mnt/p.sh' (literal, doesnt run)\n" +
      'mount /dev/fd1 /mnt && sh /mnt/p.sh; echo __PROBE_DONE__\n' +
      'real output\n' +
      `${PROBE_SENTINEL}\n# `;
    expect(extractProbeStdout(transcript, 'p.sh')).toBe('real output');
  });
});

describe('probe-harness — PROBE_SENTINEL', () => {
  it('is unambiguous against typical kernel/userland output', () => {
    // The sentinel uses leading/trailing double underscores plus all-caps,
    // a combination the ELKS kernel + userland never produces in normal
    // operation. We pin the exact value so future refactors can't
    // accidentally weaken it.
    expect(PROBE_SENTINEL).toBe('__PROBE_DONE__');
  });
});
