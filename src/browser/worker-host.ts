/**
 * Worker-side host for the browser harness.
 *
 * Wraps an `IBMPCMachine` in a message-driven shell:
 *
 *   - Inbound: `boot` (fetch image + construct), `rx` (push keystrokes),
 *     `reset` (tear down + re-construct).
 *   - Outbound: `ready` (constructed and ready to run), `tx` (coalesced
 *     UART TX bytes), `halted` (run loop exited cleanly), `error` (uncaught
 *     exception during boot or run).
 *
 * Two execution modes:
 *
 *   - **Async (production)**: `handleMessage({type:'boot'})` constructs the
 *     machine, posts `ready`, and starts an async run loop that yields
 *     between batches via `setTimeout(0)` so the worker's inbound message
 *     queue gets drained between chunks. Without that yield, RX messages
 *     pile up and never reach the UART.
 *   - **Sync (tests)**: `runUntil(maxInstructions)` drives the same chunked
 *     loop with no yield. Tests construct the host with `autoRun: false`
 *     so `boot` doesn't spawn the async loop, then call `runUntil` directly
 *     to drive the boot to a checkpoint and inspect collected TX messages.
 *
 * TX coalescing: the UART TX callback and BrowserConsole's `writeChar` both
 * push onto a shared byte buffer. Each batch ends with a flush — one `tx`
 * postMessage per batch (5000 instructions by default), not per byte. A
 * per-byte channel would saturate postMessage on a kernel banner. Chunk
 * size 5000 was picked from the brief's recommendation; empirically it
 * gives smooth UART output without starving the postMessage channel.
 *
 * Halt-spin handling: matches `tools/elks/run-serial.ts` and the existing
 * Phase 8 integration test. ELKS HLT-waits for PIT IRQ 0 during boot; the
 * loop has to advance the virtual clock during halt-spins so that wake
 * happens. Default cap of 1000 spins × 1000 cycles = 1e6 virtual cycles
 * matches `traceRun`'s defaults — enough for the kernel's deepest HLT
 * window without letting an actually-stuck boot spin forever.
 */

import type {
  BootConfig,
  DiskClass,
  DiskGeometry,
  DiskSlotSpec,
  MainToWorkerMessage,
  WorkerToMainMessage,
} from './protocol.js';
import { BrowserConsole } from './browser-console.js';
import { IBMPCMachine } from '../machine/ibm-pc.js';
import { InMemoryDisk } from '../disk/disk.js';
import { NodeHostClock } from '../host-clock/host-clock.js';
import {
  installCGAMirror,
  type CGAMirrorSink,
} from '../diagnostics/cga-mirror.js';
import {
  hasSerialConsole,
  patchBootoptsForSerial,
} from './bootopts-patch.js';

/**
 * Size → (geometry, diskClass) lookup. The published-ELKS HD shapes were
 * traced in Phase 10:
 *
 *   - 32,514,048 / 32,546,304 — `hd32-{fat,minix}.img` and `hd32mbr-*.img`
 *   - 67,107,840 / 67,140,096 — `hd64-minix.img` and `hd64mbr-*.img`
 *
 * The "mbr" variants are 32,256 bytes (1 track of 63 spt × 512) larger —
 * one extra track for the MBR. They ship in this brief because the
 * geometry table doesn't care about boot semantics; the MBR boot path
 * is a separate concern (Phase 10.1). For sizes that don't fit a clean
 * 16-head × 63-spt CHS shape, we round up the cylinder count so the
 * image fits inside the disk's sector capacity (`InMemoryDisk` zero-pads
 * the trailing region — invisible to a kernel that reads only the
 * filesystem region).
 *
 * Floppy sizes use 80 × 2 × {15,18} as before (matches
 * `tools/elks/run-serial.ts`).
 */
interface SizeTableEntry {
  bytes: number;
  geometry: DiskGeometry;
  diskClass: DiskClass;
}

const SIZE_TABLE: readonly SizeTableEntry[] = [
  // ---- Floppies ----
  { bytes: 1474560, geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 }, diskClass: 'floppy' },     // 1.44 MB
  { bytes: 1228800, geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 15 }, diskClass: 'floppy' },     // 1.2 MB
  // ---- ELKS hard disks ----
  // 32 MB partitionless: exact fit at 63 × 16 × 63.
  { bytes: 32514048, geometry: { cylinders: 63, heads: 16, sectorsPerTrack: 63 }, diskClass: 'hard-disk' },
  // 32 MB MBR variant: +1 track. 64 × 16 × 63 = 33,030,144 ≥ 32,546,304.
  { bytes: 32546304, geometry: { cylinders: 64, heads: 16, sectorsPerTrack: 63 }, diskClass: 'hard-disk' },
  // 64 MB partitionless: 130 × 16 × 63 = 67,092,480 < image; round up to 131.
  { bytes: 67107840, geometry: { cylinders: 131, heads: 16, sectorsPerTrack: 63 }, diskClass: 'hard-disk' },
  // 64 MB MBR variant: 131 × 16 × 63 = 67,608,576 ≥ 67,140,096.
  { bytes: 67140096, geometry: { cylinders: 131, heads: 16, sectorsPerTrack: 63 }, diskClass: 'hard-disk' },
];

export interface SizeInference {
  geometry: DiskGeometry;
  diskClass: DiskClass;
}

/**
 * Match an image byte-count against the size table. Returns null on miss —
 * callers must then fall back to an explicit `BootConfig.geometry`.
 *
 * Exported for `tests/unit/disk-geometry.test.ts`.
 */
export function inferFromSize(bytes: number): SizeInference | null {
  for (const entry of SIZE_TABLE) {
    if (entry.bytes === bytes) {
      return { geometry: entry.geometry, diskClass: entry.diskClass };
    }
  }
  return null;
}

/**
 * Heuristic: heads ≥ 4 means hard-disk class, else floppy. Floppy formats
 * top out at 2 heads (3.5"/5.25" double-sided); HDs start at 4 heads on
 * the small end (early ST-225 had 4) and only grow from there. Documented
 * in the brief.
 *
 * Exported for `tests/unit/disk-geometry.test.ts`.
 */
export function classFromGeometry(g: DiskGeometry): DiskClass {
  return g.heads >= 4 ? 'hard-disk' : 'floppy';
}

/** Drop-everything sink for the CGA mirror — Phase 9 doesn't render it. */
class NullCGASink implements CGAMirrorSink {
  writeChar(_byte: number): void { /* discard */ }
}

export interface WorkerHostOptions {
  /** Channel out: usually `(m) => self.postMessage(m)` in the worker. */
  post: (msg: WorkerToMainMessage) => void;
  /**
   * Image URL → bytes. The worker's `boot` handler calls this when the
   * config carries a URL. In tests we pass a stub that returns the
   * already-loaded image bytes synchronously.
   */
  fetchImage?: (url: string) => Promise<Uint8Array>;
  /**
   * Auto-start the chunked async run loop once `boot` constructs the
   * machine. Default `true` — the production path. Tests set `false` and
   * drive the loop synchronously via `runUntil`.
   */
  autoRun?: boolean;
  /**
   * Instructions per batch. Default 5000. Tuning notes in the module
   * docstring.
   */
  batchSize?: number;
  /**
   * Halt-spin tuning. Defaults match `traceRun`'s defaults (1000 cycles
   * per spin, 1000 max spins). Exposed for tests that want to provoke
   * `halt-spin-exhausted` on a kernel that never wakes.
   */
  haltSpinCycles?: number;
  maxHaltSpins?: number;
}

interface ResolvedSlot {
  disk: InMemoryDisk;
  diskClass: DiskClass;
}

export interface RunResult {
  executed: number;
  reason:
    | 'instruction-limit'
    | 'halted'
    | 'halt-spin-exhausted'
    | 'stopped'
    | 'error';
}

export class WorkerHost {
  readonly #post: (msg: WorkerToMainMessage) => void;
  readonly #fetchImage: ((url: string) => Promise<Uint8Array>) | undefined;
  readonly #autoRun: boolean;
  readonly #batchSize: number;
  readonly #haltSpinCycles: number;
  readonly #maxHaltSpins: number;

  #machine: IBMPCMachine | null = null;
  #console: BrowserConsole | null = null;
  #teardownMirror: (() => void) | null = null;
  #txBuffer: number[] = [];
  #stopping = false;
  /** Last in-flight async work — boot fetch + autoRun loop. */
  #pending: Promise<void> = Promise.resolve();

  constructor(opts: WorkerHostOptions) {
    this.#post = opts.post;
    this.#fetchImage = opts.fetchImage;
    this.#autoRun = opts.autoRun ?? true;
    this.#batchSize = opts.batchSize ?? 5000;
    this.#haltSpinCycles = opts.haltSpinCycles ?? 1000;
    this.#maxHaltSpins = opts.maxHaltSpins ?? 1000;
  }

  /** Underlying machine. Tests poke this for low-level inspection. */
  get machine(): IBMPCMachine | null {
    return this.#machine;
  }

  /**
   * Inbound message handler — call from the worker's `message` event
   * listener. Returns immediately; async work (fetch + run loop) is
   * tracked via `whenIdle()` so tests can await it.
   */
  handleMessage(msg: MainToWorkerMessage): void {
    if (msg.type === 'boot') {
      this.#pending = this.#pending.then(() => this.#bootAndMaybeRun(msg.config));
      return;
    }
    if (msg.type === 'rx') {
      if (this.#console) this.#console.injectInput(msg.bytes);
      return;
    }
    if (msg.type === 'reset') {
      this.#stopping = true;
      // The reset semantics for v0: ask the current run to bail; the next
      // boot reconstructs. The IDB page store is preserved across reset
      // because we don't touch the store; reloading the page yields the
      // same persistence behaviour. A separate "wipe" affordance is out
      // of scope.
      this.#pending = this.#pending.then(() => {
        this.#teardownMachine();
      });
      return;
    }
  }

  /**
   * Resolves once all in-flight boot/run work has settled. Tests await
   * this between message sends. Production callers don't need it.
   */
  async whenIdle(): Promise<void> {
    await this.#pending;
  }

  /**
   * Synchronous run driver — the body of the async loop, but with no
   * `setTimeout` yields between batches. Tests call this directly after
   * `boot` to drive the kernel to a checkpoint within an instruction cap.
   *
   * Drains the BrowserConsole RX queue into the UART before each batch,
   * runs `cpu.step()` up to `batchSize` instructions, advances the virtual
   * clock, then flushes accumulated TX bytes as a `tx` message.
   *
   * Halt handling mirrors `traceRun`: when the CPU halts and no interrupt
   * is currently serviceable, advance the clock to give the PIT a chance
   * to fire IRQ 0; if `maxHaltSpins` ticks pass with no wake, return
   * `halt-spin-exhausted`.
   */
  runUntil(maxInstructions: number): RunResult {
    if (!this.#machine || !this.#console) {
      throw new Error('WorkerHost.runUntil: boot has not completed');
    }
    const machine = this.#machine;
    const browserConsole = this.#console;
    const cpu = machine.cpu;

    let executed = 0;
    let haltSpins = 0;

    while (executed < maxInstructions && !this.#stopping) {
      this.#drainRx(browserConsole, machine);

      if (cpu.halted) {
        const ctrl = cpu.intCtrl;
        const canService =
          ctrl.hasNMI() ||
          (ctrl.hasMaskable() && cpu.flags.IF && !cpu.interruptInhibit);
        if (canService) {
          cpu.step();
          executed++;
          haltSpins = 0;
          continue;
        }
        if (haltSpins >= this.#maxHaltSpins) {
          this.#flushTx();
          return { executed, reason: 'halt-spin-exhausted' };
        }
        machine.clock.advance(this.#haltSpinCycles);
        haltSpins++;
        continue;
      }

      const budget = Math.min(this.#batchSize, maxInstructions - executed);
      let executedThisBatch = 0;
      try {
        for (let i = 0; i < budget; i++) {
          if (cpu.halted) break;
          cpu.step();
          executedThisBatch++;
        }
      } catch (err: unknown) {
        executed += executedThisBatch;
        this.#flushTx();
        this.#postError(err);
        return { executed, reason: 'error' };
      }
      executed += executedThisBatch;
      haltSpins = 0;
      if (executedThisBatch > 0) machine.clock.advance(executedThisBatch);
      this.#flushTx();
    }

    this.#flushTx();
    if (this.#stopping) return { executed, reason: 'stopped' };
    return { executed, reason: 'instruction-limit' };
  }

  // ============================================================
  // Internal
  // ============================================================

  async #bootAndMaybeRun(config: BootConfig): Promise<void> {
    try {
      await this.#boot(config);
    } catch (err: unknown) {
      this.#postError(err);
      return;
    }
    if (!this.#autoRun) return;
    // Production async loop. Yields to the worker's macrotask queue between
    // batches so inbound RX messages can be delivered. Without the yield,
    // postMessage events would queue forever behind a synchronous run loop.
    while (!this.#stopping && this.#machine !== null) {
      const result = this.runUntil(this.#batchSize);
      if (
        result.reason !== 'instruction-limit' &&
        result.reason !== 'stopped'
      ) {
        this.#post({ type: 'halted', reason: result.reason });
        return;
      }
      if (result.reason === 'stopped') return;
      await yieldMacrotask();
    }
  }

  async #boot(config: BootConfig): Promise<void> {
    this.#teardownMachine();
    this.#stopping = false;

    const primary = await this.#resolveSlot('primary', {
      imageUrl: config.imageUrl,
      imageBytes: config.imageBytes,
      geometry: config.geometry,
      diskClass: config.diskClass,
    });

    let secondary: ResolvedSlot | null = null;
    if (config.secondary) {
      secondary = await this.#resolveSlot('secondary', config.secondary);
    }

    const browserConsole = new BrowserConsole({
      txSink: (byte: number) => this.#txBuffer.push(byte),
    });
    this.#console = browserConsole;

    const machine = new IBMPCMachine({
      disk: primary.disk,
      diskClass: primary.diskClass,
      ...(secondary
        ? {
            secondaryDisk: secondary.disk,
            secondaryDiskClass: secondary.diskClass,
          }
        : {}),
      console: browserConsole,
      hostClock: new NodeHostClock(),
      cyclesPerPitTick: 4,
      uartTransmit: (byte: number) => this.#txBuffer.push(byte),
    });

    // Silent CGA sink — Phase 9 has no canvas. Without a sink the kernel's
    // early-printk writes to 0xB8000 still land in memory; the mirror is
    // only here to satisfy the same wiring shape `tools/elks/run-serial.ts`
    // uses and to absorb any future serial-mode-with-tee experiment.
    this.#teardownMirror = installCGAMirror(machine, { sink: new NullCGASink() });

    this.#machine = machine;
    machine.reset();
    this.#post({ type: 'ready' });
  }

  /**
   * Resolve one disk slot's spec into a constructed InMemoryDisk plus
   * its derived class. Centralises the fetch / size-infer / explicit-
   * override logic shared between primary and secondary slots.
   *
   * `slotName` is purely diagnostic — it surfaces in error messages so
   * a failing secondary slot doesn't masquerade as a broken primary.
   */
  async #resolveSlot(slotName: 'primary' | 'secondary', spec: DiskSlotSpec): Promise<ResolvedSlot> {
    let bytes: Uint8Array;
    if (spec.imageBytes) {
      bytes = spec.imageBytes;
    } else if (spec.imageUrl) {
      if (!this.#fetchImage) {
        throw new Error(
          `WorkerHost: ${slotName} disk imageUrl supplied but no fetchImage callback configured`,
        );
      }
      bytes = await this.#fetchImage(spec.imageUrl);
    } else {
      throw new Error(
        `WorkerHost: ${slotName} disk spec must carry imageBytes or imageUrl`,
      );
    }
    let geometry: DiskGeometry | undefined = spec.geometry;
    let diskClass: DiskClass | undefined = spec.diskClass;
    if (!geometry) {
      const inferred = inferFromSize(bytes.length);
      if (!inferred) {
        throw new Error(
          `WorkerHost: ${slotName} disk: unrecognised image size ${bytes.length} bytes. ` +
          `Pass an explicit geometry (and optionally diskClass) in the spec to override.`,
        );
      }
      geometry = inferred.geometry;
      diskClass ??= inferred.diskClass;
    }
    diskClass ??= classFromGeometry(geometry);
    // Phase 14 M2: HD images default to the CGA console, which the
    // browser can't render — auto-patch /bootopts to console=ttyS0 so
    // the xterm terminal works. In-memory copy only (the stored library
    // image is untouched); floppies and already-serial images pass
    // through unchanged; images without a /bootopts block boot as-is.
    if (
      slotName === 'primary' &&
      diskClass === 'hard-disk' &&
      !hasSerialConsole(bytes)
    ) {
      const patched = patchBootoptsForSerial(bytes);
      if (patched !== null) bytes = patched;
    }
    const disk = new InMemoryDisk({ geometry, contents: bytes });
    return { disk, diskClass };
  }

  /**
   * Feed queued console input to the UART, paced against its actual RX
   * capacity — `injectByte` DROPS bytes once the FIFO is full (real
   * 16550 overrun semantics; in non-FIFO mode it OVERWRITES the 1-byte
   * holding register), which silently truncated any >16-byte input
   * burst (a paste into the xterm, or agent-bridge POSTs) to 16 chars.
   * Keep ≤12 in flight per batch when the guest has enabled the FIFO
   * (the probe harness's margin, `probe-harness.ts:RX_CHUNK_SIZE`),
   * one byte otherwise, and leave the rest queued in BrowserConsole;
   * the kernel drains between batches. Found by Phase 14 M2.5's first
   * >16-char injection.
   */
  #drainRx(browserConsole: BrowserConsole, machine: IBMPCMachine): void {
    const RX_INFLIGHT_LIMIT = 12;
    const limit = machine.uart.inspect().fifoEnabled ? RX_INFLIGHT_LIMIT : 1;
    while (
      browserConsole.hasInput() &&
      machine.uart.pendingRxCount < limit
    ) {
      const b = browserConsole.readChar();
      if (b < 0) break;
      machine.uart.injectByte(b);
    }
  }

  #flushTx(): void {
    if (this.#txBuffer.length === 0) return;
    const bytes = new Uint8Array(this.#txBuffer);
    this.#txBuffer.length = 0;
    this.#post({ type: 'tx', bytes });
  }

  #postError(err: unknown): void {
    if (err instanceof Error) {
      this.#post({
        type: 'error',
        message: err.message,
        ...(err.stack ? { stack: err.stack } : {}),
      });
      return;
    }
    this.#post({ type: 'error', message: String(err) });
  }

  #teardownMachine(): void {
    if (this.#teardownMirror) {
      this.#teardownMirror();
      this.#teardownMirror = null;
    }
    if (this.#machine) {
      this.#machine.stop();
    }
    this.#machine = null;
    this.#console = null;
    this.#txBuffer.length = 0;
  }
}

/**
 * Yield to the macrotask queue. Workers process inbound `message` events as
 * macrotasks, so a microtask yield (queueMicrotask) would starve them. The
 * `setTimeout(0)` form costs ~1ms in browsers and ~0.05ms in Node — both
 * negligible compared to the ~5000-instruction batch we just executed.
 */
function yieldMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
