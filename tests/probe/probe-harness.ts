/**
 * Probe harness (Phase 12).
 *
 * Reusable infrastructure for "boot ELKS, run a script, capture its
 * output". Each future investigation (Phase 13 toolchain survey, kernel-
 * feature probes, bug repros) becomes a small `runProbe()` call with a
 * different shell-script payload.
 *
 * # End-to-end pipeline
 *
 *   1. Build a FAT12 floppy containing the probe script (and any extra
 *      files), via {@link buildProbeDisk}.
 *   2. Construct an {@link IBMPCMachine} with the primary serial-console
 *      image and the probe disk attached as the secondary slot
 *      (`/dev/fd1`, floppy class).
 *   3. Run the boot loop until a `# ` shell prompt appears in the UART
 *      TX byte stream.
 *   4. Inject the command line:
 *
 *          mount /dev/fd1 /mnt && sh /mnt/<probe.sh>; echo __PROBE_DONE__\n
 *
 *      The chained `;` after the `&&` means the sentinel-echo always
 *      fires — even if mount or the script itself fails — so the harness
 *      always sees terminal output rather than hanging on a partial
 *      transcript.
 *   5. Run until `__PROBE_DONE__` appears in TX or the instruction
 *      budget is exhausted.
 *   6. Slice the captured transcript into `bootStdout`, the probe-launch
 *      command-echo region, the probe's stdout window, and return.
 *
 * The harness is a pure function: input config in, result out, no
 * filesystem writes, no global state. Unit tests can exercise its
 * parsing logic without booting; integration tests can run it against
 * real ELKS images.
 *
 * # Sentinel choice
 *
 * `__PROBE_DONE__` is intentionally weird — leading double-underscore +
 * uppercase + trailing double-underscore. ELKS's normal kernel banner,
 * mount messages, and shell prompts produce nothing matching this
 * pattern. (We grep `txAfterBoot` for the string in unit tests against
 * real boot transcripts to confirm.) If a probe script wants to print
 * `__PROBE_DONE__` itself, the harness's split rule (everything up to
 * but not including the LAST occurrence of the sentinel) is what kicks
 * in — but in practice no probe needs to embed the sentinel in its
 * output.
 *
 * # Boot vs probe stdout boundary
 *
 * The full UART transcript contains, in order:
 *
 *   1. Kernel banner / mount messages / `# ` initial prompt — `bootStdout`.
 *   2. The shell echoing the injected command line back through the tty
 *      line discipline, ending with `\n`.
 *   3. Any output produced by the script before its trailing
 *      `echo __PROBE_DONE__`.
 *   4. The line `__PROBE_DONE__\n`.
 *   5. A trailing `# ` prompt as the shell waits for more input.
 *
 * `stdout` is the substring between the end of the injected command-
 * line echo and the start of the sentinel — i.e. region 3 above. We
 * find region 2 by looking for the marker `mount /dev/fd1 /mnt &&`
 * followed by a newline; everything after that line and before
 * `__PROBE_DONE__` is the probe's output.
 *
 * # Why floppy class for the probe disk
 *
 * `/dev/fd1` works on a generic floppy-class secondary slot without
 * partition-table probing. Using HD class would force the kernel
 * through MBR-detection paths (Phase 10.1) which our small FAT12
 * volume isn't equipped for. Floppy class has no such probe — the
 * kernel just opens the device when userland calls `mount`.
 *
 * # UART RX FIFO chunking
 *
 * The 16550A FIFO holds 16 bytes (`uart-16550.ts:62-63`). Phase 11.6
 * solved this by feeding ≤12-byte chunks then running ~200K
 * instructions to drain. We reuse the same pattern via
 * {@link injectLine}. The slightly-smaller chunk (12 vs 16) is a
 * paranoia margin for edge cases where the line discipline hasn't
 * quite caught up.
 */

import {
  buildProbeDisk,
  FD1440_GEOMETRY,
  type ProbeDiskFile,
} from './probe-disk.js';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';

/** Sentinel string echoed by the probe-launch line; marks "probe done". */
export const PROBE_SENTINEL = '__PROBE_DONE__';

/** Default instruction budget for the entire probe run (boot + probe). */
export const DEFAULT_TIMEOUT_INSTRUCTIONS = 100_000_000;

/** Default cap on captured TX bytes — protects against megabyte-output probes. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Default instruction budget for the boot phase (until the first `# ` prompt).
 *
 * Phase 12 shipped this hard-coded at 8M, sufficient for a 1.44 MB MINIX
 * floppy. Phase 13's HD32 survey hit the wall — `hd32-minix.img` boots in
 * ~14M instructions on its own (`elks-integration/elks-hd-minix-boot.test.ts`
 * uses 16M boot + 4M userland). Phase 12.1 raises the default to 32M:
 *
 *   - 16M is empirically sufficient for HD32 boot.
 *   - 32M doubles that for headroom (slower fixtures, future HD64 work).
 *   - Trivial probes (1.44 MB MINIX floppy) still complete in ~5-6M, so the
 *     larger ceiling only changes wall-time on probes that actually need it.
 *   - A pathological probe that hangs in early boot now spends at most ~32M
 *     instructions (a few seconds of host wall-time at typical emulation
 *     rates) before being declared `timeoutPhase: 'boot'`. Caller-tunable
 *     for tighter or looser bounds.
 */
export const DEFAULT_BOOT_INSTRUCTION_BUDGET = 32_000_000;

/** Per-chunk drain budget while injecting bytes over UART RX. */
const RX_CHUNK_DRAIN_INSTRUCTIONS = 200_000;

/** Chunk size for UART RX feeding (≤16 to fit the FIFO; 12 = paranoia margin). */
const RX_CHUNK_SIZE = 12;

export interface ProbeScript {
  /** 8.3 filename, e.g. `probe.sh`. Lives in the root of the probe disk. */
  readonly filename: string;
  /**
   * Shell script body. No shebang required — the harness invokes it via
   * `sh /mnt/<filename>`. Strings are written as ASCII (LF preserved).
   */
  readonly script: string;
  /** Additional files staged at the FAT12 root alongside the script. */
  readonly extraFiles?: readonly ProbeDiskFile[];
}

export interface ProbeRequest {
  /**
   * Primary boot image. Either a path on disk (read at call time) or
   * the bytes directly. The image must be configured for serial console
   * (`console=ttyS0` in `/bootopts`) and reach a `# ` prompt; today the
   * canonical such image is `fd1440-minix-serial.img`.
   *
   * The brief calls out: probe scripts that need device nodes
   * (`/dev/rd0`, `/dev/hd*`) require a MINIX root, because FAT12 can't
   * store device nodes. The MINIX serial floppy (Phase 11.6) is the
   * standard primary.
   */
  readonly primaryImage: string | Uint8Array;
  readonly probe: ProbeScript;
  /** Default {@link DEFAULT_TIMEOUT_INSTRUCTIONS}. */
  readonly timeoutInstructions?: number;
  /**
   * Instruction budget for the boot phase only — until the first `# `
   * prompt. Default {@link DEFAULT_BOOT_INSTRUCTION_BUDGET}. Capped by
   * `timeoutInstructions` (the boot budget can't exceed the total).
   *
   * Floppy primaries fit comfortably in the 8M Phase 12 default; HD
   * primaries need 16-32M. Phase 12.1 raised the default so most
   * callers don't need to set this explicitly.
   */
  readonly bootInstructionBudget?: number;
  /** Default {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  readonly maxOutputBytes?: number;
}

/**
 * Which phase a timeout occurred in. `null` on a successful run.
 *
 * - `'boot'`: the boot phase consumed `bootInstructionBudget` without
 *   reaching a `# ` prompt. The probe never started.
 * - `'probe'`: boot reached the prompt and the launch line was injected,
 *   but the sentinel didn't appear within the remaining
 *   `timeoutInstructions`. The script may have hung, crashed silently, or
 *   simply needed more budget.
 */
export type TimeoutPhase = 'boot' | 'probe' | null;

export interface ProbeResult {
  /** Probe stdout — the bytes the script wrote between launch and sentinel. */
  readonly stdout: string;
  /** Entire UART TX transcript since boot — verbatim. */
  readonly fullTranscript: string;
  /** Pre-probe boot output: kernel banner, mount messages, prompt. */
  readonly bootStdout: string;
  /** True if the sentinel never appeared and the budget ran out. */
  readonly timedOut: boolean;
  /**
   * Which phase the timeout happened in, or `null` on success. Lets
   * callers distinguish "boot didn't finish" (the probe never ran)
   * from "probe didn't finish" (the script hung or needed more budget).
   * Phase 12.1 addition. Always `null` when `timedOut === false`.
   */
  readonly timeoutPhase: TimeoutPhase;
  /** True if the transcript contained a kernel panic / oops. */
  readonly kernelPanicked: boolean;
  /** True if the captured TX hit `maxOutputBytes` and was truncated. */
  readonly truncated: boolean;
  /** Total instructions consumed across boot and probe phases. */
  readonly instructionsUsed: number;
  /**
   * Post-run snapshot of the probe disk (Phase 14 M1). The guest can
   * write build artifacts onto the mounted probe floppy; this captures
   * whatever it flushed by the time the run ended (`sync` in the guest
   * script before the sentinel/prompt is the caller's responsibility).
   * Read files back with {@link readProbeDiskFile}.
   */
  readonly probeDiskFinal: Uint8Array;
}

/** Boot the VM, run a probe, capture its output. See module header for details. */
export async function runProbe(req: ProbeRequest): Promise<ProbeResult> {
  // Resolve primary bytes synchronously. The async signature is for
  // forward compatibility (e.g. fetch-based image loading in a future
  // browser variant) — today the work is purely sync.
  const primaryBytes = await resolvePrimaryBytes(req.primaryImage);
  const timeoutInstructions = req.timeoutInstructions ?? DEFAULT_TIMEOUT_INSTRUCTIONS;
  const bootInstructionBudget = req.bootInstructionBudget ?? DEFAULT_BOOT_INSTRUCTION_BUDGET;
  const maxOutputBytes = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  // ---- build probe disk -------------------------------------------------
  const files: ProbeDiskFile[] = [
    { name: req.probe.filename, content: req.probe.script },
    ...(req.probe.extraFiles ?? []),
  ];
  const probeDisk = buildProbeDisk(files);

  // ---- construct machine ------------------------------------------------
  const txBytes: number[] = [];
  let truncated = false;

  const primaryDisk = new InMemoryDisk({
    geometry: inferGeometry(primaryBytes.length),
    contents: primaryBytes,
  });
  const probeInMemDisk = new InMemoryDisk({
    geometry: probeDisk.geometry,
    contents: probeDisk.bytes,
  });

  const m = new IBMPCMachine({
    disk: primaryDisk,
    secondaryDisk: probeInMemDisk,
    secondaryDiskClass: 'floppy',
    console: new InMemoryConsole(),
    hostClock: new InMemoryHostClock(),
    cyclesPerPitTick: 4,
    uartTransmit: (byte: number) => {
      if (txBytes.length >= maxOutputBytes) {
        truncated = true;
        return;
      }
      txBytes.push(byte);
    },
  });
  m.reset();

  const tracer = new Tracer({ capacity: 50_000, kinds: ['intService', 'trap'] });
  let instructionsUsed = 0;

  // ---- phase 1: boot to # prompt ----------------------------------------
  const bootBudget = Math.min(bootInstructionBudget, timeoutInstructions);
  const r1 = traceRun(m, { tracer, maxInstructions: bootBudget });
  instructionsUsed += r1.executed;
  const txAfterBoot = bytesToString(txBytes);
  const reachedPrompt = /# *$/.test(txAfterBoot);
  if (!reachedPrompt) {
    return {
      stdout: '',
      fullTranscript: txAfterBoot,
      bootStdout: txAfterBoot,
      timedOut: true,
      timeoutPhase: 'boot',
      kernelPanicked: detectKernelPanic(txAfterBoot),
      truncated,
      instructionsUsed,
      // Snapshot even on boot timeout — bootopts-path probes do all
      // their work (including guest writes) during the boot phase.
      probeDiskFinal: snapshotDisk(probeInMemDisk),
    };
  }
  const bootStdoutLength = txBytes.length;

  // ---- phase 2: inject the probe-launch line ----------------------------
  const launchLine = buildLaunchLine(req.probe.filename);
  injectLine(m, tracer, launchLine, (used) => {
    instructionsUsed += used;
  });

  // ---- phase 3: run until sentinel or timeout ---------------------------
  const remainingBudget = Math.max(0, timeoutInstructions - instructionsUsed);
  const sentinelOutcome = runUntilSentinel(m, tracer, txBytes, remainingBudget);
  instructionsUsed += sentinelOutcome.instructionsUsed;

  // ---- assemble result --------------------------------------------------
  const fullTranscript = bytesToString(txBytes);
  const bootStdout = bytesToString(txBytes.slice(0, bootStdoutLength));
  const stdout = extractProbeStdout(fullTranscript, req.probe.filename);
  const timedOut = !sentinelOutcome.sawSentinel;

  return {
    stdout,
    fullTranscript,
    bootStdout,
    timedOut,
    timeoutPhase: timedOut ? 'probe' : null,
    kernelPanicked: detectKernelPanic(fullTranscript),
    truncated,
    instructionsUsed,
    probeDiskFinal: snapshotDisk(probeInMemDisk),
  };
}

/**
 * Copy a disk's full contents out through its public `readSector` API.
 * `InMemoryDisk` deliberately has no bulk accessor (its backing store is
 * private and `readSector` returns copies), so a sector loop is the
 * supported way to snapshot it. 2,880 sectors × 512 B for the probe
 * floppy — cheap relative to a boot.
 */
function snapshotDisk(disk: InMemoryDisk): Uint8Array {
  const sectorSize = 512; // Disk contract: readSector returns 512-byte sectors.
  const out = new Uint8Array(disk.sectorCount * sectorSize);
  for (let lba = 0; lba < disk.sectorCount; lba++) {
    out.set(disk.readSector(lba), lba * sectorSize);
  }
  return out;
}

/**
 * Build the probe-launch shell line. The `&&` between mount and `sh`
 * means the script only runs if mount succeeded; the `;` before
 * `echo __PROBE_DONE__` means the sentinel always fires regardless.
 *
 * The trailing `\n` is the line terminator the shell needs to dispatch.
 */
export function buildLaunchLine(probeFilename: string): string {
  // Filenames are 8.3-uppercased on disk, but ELKS's FAT driver returns
  // lowercase by default for entries that have no name-case bits set —
  // the original-case bits in NT-reserved are an outside-spec extension
  // we don't use. So `probe.sh` written → mounted as `probe.sh`. To be
  // robust against FAT case differences, we pass the original input
  // filename verbatim — ELKS's FAT driver matches case-insensitively
  // when looking up files.
  return `mount /dev/fd1 /mnt && sh /mnt/${probeFilename}; echo ${PROBE_SENTINEL}\n`;
}

/**
 * Slice the captured transcript to extract the probe's stdout. See the
 * module header for the boundary rules.
 *
 * Algorithm:
 *   1. Find the LAST occurrence of the launch-command's `mount /dev/fd1`
 *      prefix in the transcript (the kernel echoes the injected line back
 *      through the tty discipline). The line we want is the echo line
 *      right after the boot-time `# ` prompt.
 *   2. From that position, advance to the end of the line (next `\n`).
 *   3. Find the LAST occurrence of `__PROBE_DONE__` after the launch.
 *   4. Return the slice between (2) and (3), with one trailing `\n`
 *      stripped if present (it's the boundary between the probe's last
 *      line and the sentinel echo).
 *
 * If the sentinel is missing (timeout case), return everything from
 * end-of-launch-line to end-of-transcript.
 */
export function extractProbeStdout(transcript: string, probeFilename: string): string {
  const launchPrefix = `mount /dev/fd1 /mnt && sh /mnt/${probeFilename}`;
  const launchIdx = transcript.lastIndexOf(launchPrefix);
  if (launchIdx < 0) return '';
  const launchLineEnd = transcript.indexOf('\n', launchIdx);
  if (launchLineEnd < 0) return '';
  const stdoutStart = launchLineEnd + 1;
  const sentinelIdx = transcript.lastIndexOf(PROBE_SENTINEL);
  const stdoutEnd = sentinelIdx >= stdoutStart ? sentinelIdx : transcript.length;
  let slice = transcript.slice(stdoutStart, stdoutEnd);
  // Strip one trailing newline if present (it separates the probe's last
  // line from the sentinel-echo line; not part of the probe's output).
  if (slice.endsWith('\n')) slice = slice.slice(0, -1);
  return slice;
}

/**
 * Inject `line` into the UART RX FIFO in ≤RX_CHUNK_SIZE-byte chunks,
 * draining the kernel's tty line discipline between chunks. Mirrors the
 * Phase 11.6 pattern from `elks-ramdisk-serial.test.ts`.
 */
function injectLine(
  m: IBMPCMachine,
  tracer: Tracer,
  line: string,
  onInstructions: (used: number) => void,
): void {
  for (let off = 0; off < line.length; off += RX_CHUNK_SIZE) {
    const chunk = line.slice(off, off + RX_CHUNK_SIZE);
    for (let i = 0; i < chunk.length; i++) {
      m.uart.injectByte(chunk.charCodeAt(i));
    }
    const r = traceRun(m, { tracer, maxInstructions: RX_CHUNK_DRAIN_INSTRUCTIONS });
    onInstructions(r.executed);
  }
}

interface SentinelRunOutcome {
  sawSentinel: boolean;
  instructionsUsed: number;
}

/**
 * Run the machine in slices, checking after each slice for the sentinel
 * in the captured TX bytes. Slicing keeps the check cheap (only re-scan
 * the new bytes) and bounds latency to the per-slice budget.
 */
function runUntilSentinel(
  m: IBMPCMachine,
  tracer: Tracer,
  txBytes: number[],
  totalBudget: number,
): SentinelRunOutcome {
  const SLICE = 1_000_000;
  let used = 0;
  let txCursor = 0;
  let pending = '';
  while (used < totalBudget) {
    const slice = Math.min(SLICE, totalBudget - used);
    const r = traceRun(m, { tracer, maxInstructions: slice });
    used += r.executed;
    // Append new TX bytes to a rolling string and check for the sentinel.
    if (txBytes.length > txCursor) {
      pending += bytesToString(txBytes.slice(txCursor));
      txCursor = txBytes.length;
      if (pending.includes(PROBE_SENTINEL)) {
        return { sawSentinel: true, instructionsUsed: used };
      }
      // Cap the rolling buffer — only keep enough tail to detect a
      // sentinel that crosses slice boundaries.
      const keep = PROBE_SENTINEL.length;
      if (pending.length > keep) {
        pending = pending.slice(-keep);
      }
    }
    // If the run loop hit a hard error, no further progress is possible.
    if (r.reason === 'error') break;
  }
  return { sawSentinel: false, instructionsUsed: used };
}

/**
 * Detect a kernel panic / oops in the transcript. ELKS's panic path
 * prints `panic:` (lowercase) — see `elks/init/main.c`'s panic helper.
 * "Oops" appears for unhandled exceptions. We treat either as a hard
 * failure so the harness can surface it explicitly.
 */
function detectKernelPanic(transcript: string): boolean {
  return /\bpanic:|\bOops\b|kernel panic/i.test(transcript);
}

async function resolvePrimaryBytes(image: string | Uint8Array): Promise<Uint8Array> {
  if (typeof image !== 'string') return image;
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(image);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Map a primary-image byte length to a known floppy/HD geometry.
 *
 * Mirrors the entries in `src/browser/worker-host.ts:SIZE_TABLE` — kept
 * local to avoid pulling browser-side code into a Node test path. When
 * adding a new size, mirror the entry in both places.
 *
 * Phase 12.1 unblocked the HD32-MBR variant (whose 32,546,304 bytes needs
 * `64×16×63 = 33,030,144` capacity, not the `63×16×63 = 32,514,048` of
 * the no-MBR variant — sharing the smaller geometry caused
 * `InMemoryDisk` to reject the larger image at construction). Same phase
 * added the two HD64 sizes.
 *
 * Exported for unit tests; also useful for callers that want to validate
 * an image's size before calling `runProbe`.
 */
export function inferGeometry(byteLength: number): { cylinders: number; heads: number; sectorsPerTrack: number } {
  switch (byteLength) {
    case 1474560: // 1.44 MB floppy
      return { cylinders: 80, heads: 2, sectorsPerTrack: 18 };
    case 1228800: // 1.2 MB floppy
      return { cylinders: 80, heads: 2, sectorsPerTrack: 15 };
    case 32514048: // ELKS hd32 partitionless (no MBR) — 63×16×63 exact fit.
      return { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
    case 32546304: // ELKS hd32 MBR variant — +1 track of MBR overhead.
      // 64 × 16 × 63 = 33,030,144 ≥ 32,546,304 (one track of slack).
      return { cylinders: 64, heads: 16, sectorsPerTrack: 63 };
    case 67107840: // ELKS hd64 partitionless — round up to 131 cylinders.
      // 130 × 16 × 63 = 67,092,480 < image; 131 × 16 × 63 = 67,608,576 ≥ image.
      return { cylinders: 131, heads: 16, sectorsPerTrack: 63 };
    case 67140096: // ELKS hd64 MBR variant — same 131×16×63 fits.
      return { cylinders: 131, heads: 16, sectorsPerTrack: 63 };
    default:
      throw new Error(
        `Unsupported primary image size ${byteLength} bytes — runProbe ` +
          `expects a 1.44 MB floppy, 1.2 MB floppy, ELKS hd32, or ELKS hd64 image.`,
      );
  }
}

function bytesToString(bytes: readonly number[] | Uint8Array): string {
  // Caller passes ASCII bytes; using fromCharCode is faster than
  // TextDecoder for the typical-sized transcripts we deal with.
  let s = '';
  const CHUNK = 0x4000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = Array.from(bytes.slice(i, i + CHUNK) as ArrayLike<number>);
    s += String.fromCharCode(...slice);
  }
  return s;
}

// Re-export probe-disk types/helpers so callers only import from the
// harness module. `readProbeDiskFile` pairs with `ProbeResult.probeDiskFinal`
// for guest→host artifact extraction (Phase 14 M1).
export type { ProbeDiskFile } from './probe-disk.js';
export { FD1440_GEOMETRY };
export { readProbeDiskFile } from './probe-disk.js';
