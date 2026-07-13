/**
 * HD32 hello-world compile probe (Phase 14, step 1).
 *
 * Boots `hd32-minix.img`, ships a C source file + driver script to the
 * guest on the FAT12 probe floppy, and drives the on-disk C86 native
 * toolchain (`cpp` → `c86` → `as` → `ld`, all verified working by the
 * Phase 13.1 version probe) to compile and RUN a hello-world inside the
 * VM. The runner captures the guest transcript and classifies how far
 * the pipeline got.
 *
 * # Launch path
 *
 * Same /bootopts init-script route as the Phase 13/13.1 surveys — the
 * FAT12 probe-launch path is still blocked by the `runUntilSentinel`
 * echo bug (see `survey-runner.ts` module header). The bootopts script
 * stays tiny (well under the ~120-byte `MAX_INIT_SLEN` ceiling):
 *
 *     mount /dev/fd0 /mnt;sh /mnt/go.sh
 *
 * and all real work lives in `go.sh` on the floppy, which has no size
 * limit.
 *
 * # /dev/fd0, not /dev/fd1
 *
 * The Phase 12 harness docs say the probe disk appears as `/dev/fd1` —
 * true for a *floppy* primary. Drive numbering is per-class in slot
 * order (`bios-services.ts:routeDrive`): with an HD primary the probe
 * floppy is the FIRST floppy, DL=0x00 → `/dev/fd0`.
 *
 * # Marker scheme
 *
 * `go.sh` brackets its whole output with the survey `__B__`/`__E__`
 * markers so `extractSurveyOutput()` can be reused, and separates
 * pipeline stages with `@@<name>@@` lines parsed by
 * {@link splitSections}. Because the markers are echoed by a script
 * *file* (not embedded in /bootopts or an injected command line),
 * nothing else in the transcript can collide with them.
 *
 * # Budget note
 *
 * The harness's boot phase always consumes its entire
 * `bootInstructionBudget` (traceRun has no early-exit at the prompt),
 * so the budget below directly sets wall-clock time. Tune with care.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  runProbe,
  type ProbeResult,
} from '../probe-harness.js';
import {
  applyBootopts,
  buildBootoptsWithScript,
  extractSurveyOutput,
} from './survey-runner.js';

/** Bootopts init payload: mount the probe floppy, run the driver script. */
export const HELLO_BOOTOPTS_SCRIPT = 'mount /dev/fd0 /mnt;sh /mnt/go.sh';

/**
 * Instruction budgets. HD32 boot needs ~14M; the compile pipeline
 * (make + cpp + c86 + as + ld + running the binary) is budgeted at
 * ~2x boot on top. The boot budget is always fully consumed (see
 * module header), so these numbers ARE the wall-clock cost.
 */
export const HELLO_BOOT_BUDGET = 48_000_000;
export const HELLO_TIMEOUT = 56_000_000;
export const HELLO_OUTPUT_CAP = 1024 * 1024;

/** The string the compiled guest binary must print. */
export const HELLO_EXPECTED_OUTPUT = 'hello from emu86 phase 14';

/**
 * The C source shipped to the guest. Plain C89-friendly hello-world
 * against the on-image `/usr/include/stdio.h` and `/usr/lib/libc86.a`.
 */
export const HELLO_C_SOURCE = [
  '#include <stdio.h>',
  '',
  'int main(void)',
  '{',
  `    printf("${HELLO_EXPECTED_OUTPUT}\\n");`,
  '    return 0;',
  '}',
  '',
].join('\n');

/**
 * Discovery-only driver script — lists the toolchain environment and
 * cats the image's native Makefile. This is how the build recipe in
 * {@link HD32_HELLO_BUILD_SCRIPT} was obtained; kept exported so the
 * recon can be re-run against future images
 * (`runHd32HelloWorld(path, { guestScript: HD32_HELLO_RECON_SCRIPT })`).
 */
export const HD32_HELLO_RECON_SCRIPT = [
  'echo __B__',
  'echo @@bin@@',
  'ls /usr/bin',
  'echo @@lib@@',
  'ls -l /usr/lib',
  'echo @@inc@@',
  'ls /usr/include',
  'echo @@src@@',
  'ls -l /usr/src',
  'echo @@mk@@',
  'cat /usr/src/Makefile',
  'echo @@done@@',
  'echo __E__',
  '',
].join('\n');

/**
 * The real build driver. Recipe read from the image's own
 * `/usr/src/Makefile` (captured by the recon probe on 2026-07-13; the
 * Makefile is `Makefile.elks` from ghaerr's 8086-toolchain examples,
 * installed by `reference/elks/copyc86.sh`):
 *
 *     CPP=cpp  CC=c86  AS=as  LD=ld
 *     CPPFLAGS=-0 -I/usr/include -I/usr/include/c86
 *     CFLAGS=-g -O -bas86 -separate=yes -warn=4 -lang=c99
 *            -align=yes -stackopt=minimum -peep=all -stackcheck=no
 *     ASFLAGS=-0 -j
 *     LDFLAGS=-0 -i -L/usr/lib   LDLIBS=-lc86
 *
 * Each stage is followed by `echo rc=$?` so the host-side parser can
 * attribute failures. Work happens in /tmp (MINIX root is rw; the
 * FAT12 probe mount is left read-only-in-spirit).
 */
export const HD32_HELLO_BUILD_SCRIPT = [
  'echo __B__',
  'echo @@copy@@',
  'cp /mnt/hello.c /tmp/hello.c',
  'echo rc=$?',
  'cd /tmp',
  'echo @@cpp@@',
  'cpp -0 -I/usr/include -I/usr/include/c86 hello.c -o hello.i',
  'echo rc=$?',
  'echo @@c86@@',
  'c86 -g -O -bas86 -separate=yes -warn=4 -lang=c99 -align=yes -stackopt=minimum -peep=all -stackcheck=no hello.i hello.as',
  'echo rc=$?',
  'echo @@as@@',
  'as -0 -j hello.as -o hello.o',
  'echo rc=$?',
  'echo @@ld@@',
  'ld -0 -i -L/usr/lib -o hello hello.o -lc86',
  'echo rc=$?',
  'echo @@run@@',
  './hello',
  'echo rc=$?',
  'echo @@artifacts@@',
  'ls -l /tmp',
  'echo __E__',
  '',
].join('\n');

/** Pipeline stages whose `rc=` lines the classifier checks, in order. */
export const HELLO_STAGES: readonly string[] = ['copy', 'cpp', 'c86', 'as', 'ld', 'run'];

export interface SectionMap {
  readonly [name: string]: string;
}

export interface StageStatus {
  readonly name: string;
  /** Exit code parsed from the section's last `rc=N` line, or null if absent. */
  readonly rc: number | null;
  /** Section output with the trailing `rc=N` line removed. */
  readonly output: string;
}

export interface Hd32HelloWorldResult {
  readonly imagePath: string;
  /** True if the image fixture was missing — caller should skip-with-reason. */
  readonly fixtureMissing: boolean;
  /** Underlying `runProbe` outcome (null only when fixture missing). */
  readonly probe: ProbeResult | null;
  /** Full text between the __B__/__E__ markers. */
  readonly extractedText: string;
  /** True if both markers appeared — the guest script ran to completion. */
  readonly extractedComplete: boolean;
  /** Per-`@@name@@` section contents. */
  readonly sections: SectionMap;
  /** Per-stage exit codes/outputs for the {@link HELLO_STAGES} pipeline. */
  readonly stages: readonly StageStatus[];
  /** True if the `run` section contains {@link HELLO_EXPECTED_OUTPUT}. */
  readonly helloRan: boolean;
}

interface RunOptions {
  /** Override the guest driver script (defaults to the build script). */
  readonly guestScript?: string;
  /**
   * Extra files staged on the probe floppy alongside go.sh. Defaults to
   * `hello.c` containing {@link HELLO_C_SOURCE}.
   */
  readonly extraFiles?: readonly { name: string; content: string }[];
  readonly bootInstructionBudget?: number;
  readonly timeoutInstructions?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Boot HD32-MINIX with `go.sh` (+ any extra files) on the probe floppy,
 * run it via the bootopts init path, and return the marker-extracted
 * transcript split into sections. Skip-with-reason when the fixture is
 * absent, mirroring the Phase 13.1 probe.
 */
export async function runHd32HelloWorld(
  imagePath: string,
  opts: RunOptions = {},
): Promise<Hd32HelloWorldResult> {
  if (!existsSync(imagePath)) {
    return {
      imagePath,
      fixtureMissing: true,
      probe: null,
      extractedText: '',
      extractedComplete: false,
      sections: {},
      stages: [],
      helloRan: false,
    };
  }

  const raw = readFileSync(imagePath);
  const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  const bootopts = buildBootoptsWithScript(HELLO_BOOTOPTS_SCRIPT);
  const primary = applyBootopts(rawBytes, bootopts);

  const probe = await runProbe({
    primaryImage: primary,
    probe: {
      filename: 'go.sh',
      script: opts.guestScript ?? HD32_HELLO_BUILD_SCRIPT,
      extraFiles: opts.extraFiles ?? [{ name: 'hello.c', content: HELLO_C_SOURCE }],
    },
    bootInstructionBudget: opts.bootInstructionBudget ?? HELLO_BOOT_BUDGET,
    timeoutInstructions: opts.timeoutInstructions ?? HELLO_TIMEOUT,
    maxOutputBytes: opts.maxOutputBytes ?? HELLO_OUTPUT_CAP,
  });

  const region = extractSurveyOutput(probe.bootStdout);
  const sections = splitSections(region.text);
  const stages = classifyStages(sections);
  const runSection = sections['run'] ?? '';

  return {
    imagePath,
    fixtureMissing: false,
    probe,
    extractedText: region.text,
    extractedComplete: region.complete,
    sections,
    stages,
    helloRan: runSection.includes(HELLO_EXPECTED_OUTPUT),
  };
}

/**
 * Extract each pipeline stage's exit code from its section. The guest
 * script emits `rc=N` as the last line of every stage section; a
 * missing section or missing `rc=` line yields `rc: null` (stage never
 * ran — e.g. budget exhausted mid-pipeline).
 */
export function classifyStages(sections: SectionMap): readonly StageStatus[] {
  return HELLO_STAGES.map((name) => {
    const body = sections[name];
    if (body === undefined) return { name, rc: null, output: '' };
    const lines = body.split('\n');
    let rc: number | null = null;
    let rcLine = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^rc=(\d+)$/.exec((lines[i] ?? '').trim());
      if (m !== null && m[1] !== undefined) {
        rc = Number(m[1]);
        rcLine = i;
        break;
      }
    }
    const output = (rcLine >= 0 ? lines.slice(0, rcLine) : lines).join('\n').trim();
    return { name, rc, output };
  });
}

/**
 * Split marker-delimited text into named sections. A line consisting of
 * `@@name@@` starts section `name`; subsequent lines belong to it until
 * the next marker. Text before the first marker is discarded (it's the
 * mount chatter). Lines arrive with ELKS's CRLF tty discipline — CRs
 * are stripped.
 */
export function splitSections(text: string): SectionMap {
  const out: Record<string, string> = {};
  let current: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (current !== null) out[current] = buf.join('\n').trim();
    buf = [];
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r+$/, '');
    const m = /^@@([a-z0-9_-]+)@@$/.exec(line.trim());
    if (m !== null && m[1] !== undefined) {
      flush();
      current = m[1];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}
