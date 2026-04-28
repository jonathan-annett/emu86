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
  DEFAULT_BOOT_INSTRUCTION_BUDGET,
  extractProbeStdout,
  inferGeometry,
  PROBE_SENTINEL,
  runProbe,
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

describe('probe-harness — DEFAULT_BOOT_INSTRUCTION_BUDGET (Phase 12.1)', () => {
  it('is large enough for HD images (≥ 16M)', () => {
    // hd32-minix.img boots in ~14M; the default must clear that with
    // headroom. Phase 12 used 8M which was not enough.
    expect(DEFAULT_BOOT_INSTRUCTION_BUDGET).toBeGreaterThanOrEqual(16_000_000);
  });

  it('is bounded — won\'t silently waste minutes on a hung probe', () => {
    // Pathological probes that never reach a prompt should fail in seconds
    // of host wall-time, not minutes. 100M is a comfortable upper bound.
    expect(DEFAULT_BOOT_INSTRUCTION_BUDGET).toBeLessThanOrEqual(100_000_000);
  });
});

describe('probe-harness — bootInstructionBudget (Phase 12.1)', () => {
  it('reports timeoutPhase: "boot" when the boot phase exhausts its budget', async () => {
    // Construct a 1.44 MB image of zeros — no bootloader, no kernel.
    // Reset jumps to FFFF:0 → reset vector reads zeroes → execution wanders
    // through random instructions but never produces a `# ` prompt.
    // With a tiny budget the boot phase should declare itself timed out.
    const garbage = new Uint8Array(1474560);
    const result = await runProbe({
      primaryImage: garbage,
      probe: { filename: 'noop.sh', script: 'true\n' },
      bootInstructionBudget: 50_000,
      timeoutInstructions: 200_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.timeoutPhase).toBe('boot');
    expect(result.stdout).toBe('');
    expect(result.bootStdout).toBe('');
  }, 30_000);

  it('caps boot budget at timeoutInstructions when smaller', async () => {
    // bootInstructionBudget=10M, timeoutInstructions=1M → effective boot
    // budget is min(10M, 1M) = 1M. Must still time out at boot.
    const garbage = new Uint8Array(1474560);
    const result = await runProbe({
      primaryImage: garbage,
      probe: { filename: 'noop.sh', script: 'true\n' },
      bootInstructionBudget: 10_000_000,
      timeoutInstructions: 1_000_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.timeoutPhase).toBe('boot');
    expect(result.instructionsUsed).toBeLessThanOrEqual(1_000_000);
  }, 30_000);
});

describe('probe-harness — inferGeometry (Phase 12.1)', () => {
  it('1.44 MB floppy → 80×2×18', () => {
    expect(inferGeometry(1474560)).toEqual({
      cylinders: 80, heads: 2, sectorsPerTrack: 18,
    });
  });

  it('1.2 MB floppy → 80×2×15', () => {
    expect(inferGeometry(1228800)).toEqual({
      cylinders: 80, heads: 2, sectorsPerTrack: 15,
    });
  });

  it('hd32 partitionless (32,514,048) → 63×16×63 exact fit', () => {
    const g = inferGeometry(32514048);
    expect(g).toEqual({ cylinders: 63, heads: 16, sectorsPerTrack: 63 });
    // Capacity must be ≥ image size — the InMemoryDisk constructor
    // rejects images that don't fit.
    expect(g.cylinders * g.heads * g.sectorsPerTrack * 512).toBe(32514048);
  });

  it('hd32 MBR (32,546,304) → 64×16×63 (one extra cylinder of slack)', () => {
    // Phase 12.1 fixed the geometry for this size — Phase 12 mapped it
    // to 63×16×63 which had insufficient capacity, causing
    // InMemoryDisk's "initial contents exceed disk size" rejection.
    const g = inferGeometry(32546304);
    expect(g).toEqual({ cylinders: 64, heads: 16, sectorsPerTrack: 63 });
    expect(g.cylinders * g.heads * g.sectorsPerTrack * 512).toBeGreaterThanOrEqual(32546304);
  });

  it('hd64 partitionless (67,107,840) → 131×16×63', () => {
    const g = inferGeometry(67107840);
    expect(g).toEqual({ cylinders: 131, heads: 16, sectorsPerTrack: 63 });
    expect(g.cylinders * g.heads * g.sectorsPerTrack * 512).toBeGreaterThanOrEqual(67107840);
  });

  it('hd64 MBR (67,140,096) → 131×16×63', () => {
    const g = inferGeometry(67140096);
    expect(g).toEqual({ cylinders: 131, heads: 16, sectorsPerTrack: 63 });
    expect(g.cylinders * g.heads * g.sectorsPerTrack * 512).toBeGreaterThanOrEqual(67140096);
  });

  it('rejects unknown sizes with a helpful error', () => {
    expect(() => inferGeometry(123456)).toThrow(/Unsupported primary image size/);
    expect(() => inferGeometry(0)).toThrow();
  });
});
