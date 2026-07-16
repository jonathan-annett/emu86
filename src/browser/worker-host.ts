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
  CaptureStateMessage,
  DiskClass,
  DiskGeometry,
  DiskSlotSpec,
  MainToWorkerMessage,
  WorkerToMainMessage,
} from './protocol.js';
import { BrowserConsole } from './browser-console.js';
import { IBMPCMachine } from '../machine/ibm-pc.js';
import {
  captureMachineState,
  restoreMachineState,
} from '../machine/machine-state.js';
import { InMemoryDisk, SECTOR_SIZE, WriteTrackingDisk, type Disk } from '../disk/disk.js';
import {
  FORCED_SWEEP_BYTES,
  OverlayDisk,
  foldOverlay,
  sha256Hex,
} from '../disk/overlay.js';
import {
  applyImageStamps,
  showPending,
  type ImageStampOptions,
} from './image-stamps.js';
import { NodeHostClock, type HostClock } from '../host-clock/host-clock.js';
import {
  installCGAMirror,
  type CGAMirrorSink,
} from '../diagnostics/cga-mirror.js';
import {
  hasSerialConsole,
  patchBootoptsForSerial,
} from './bootopts-patch.js';
import { EthernetSwitch, type SwitchPort } from '../net/switch.js';
import { LanGateway } from '../net/gateway.js';
import { DnsAnswerCache, DnsHost, dohResolve } from '../net/dns.js';
import { HttpGatewayHost, realGatewayFetch } from '../net/http.js';
import { ControlHost } from '../net/control.js';
import { TabAreaNetwork, type FrameChannel } from '../net/tan.js';
import { addressForName, nameForOctet } from '../net/tan-names.js';
import {
  AUTHENTIC_CYCLES_PER_MS,
  RealTimePacer,
  type CpuSpeedMode,
} from './pacing.js';

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
  /**
   * Join the Tab Area Network (Phase 14 M3-tabs): bridge this
   * machine's LAN onto `channel` (BroadcastChannel in the browser, a
   * stub in tests) and lease a unique host identity — the NIC MAC and
   * a `LOCALIP=10.0.2.<octet>` bootopts line both derive from it.
   * Omit for an isolated single-machine LAN (default; existing tests
   * and headless callers unchanged).
   */
  tan?: { channel: FrameChannel; hostOctet?: number };
  /**
   * Wall-time source for the real-time pacer (pacing milestone). Default
   * `() => performance.now()`. Tests inject a fake to drive paced turns
   * deterministically.
   */
  pacerTimeSource?: () => number;
  /**
   * Host clock served to the machine (RTC + INT 1Ah). Default
   * `NodeHostClock` (real wall time — the production truth). The
   * Phase 18 M2 protocol equivalence tests inject an
   * `InMemoryHostClock` so a straight run and a restored run can be
   * compared byte-for-byte (same ground rule as the M1 harness).
   */
  hostClock?: HostClock;
}

interface ResolvedSlot {
  disk: InMemoryDisk;
  diskClass: DiskClass;
  /** SHA-256 hex of the pristine bytes (primary slot only, Phase 17 M2). */
  overlayFingerprint?: string;
  /** Whether BootConfig.overlay chunks were folded in (primary only). */
  overlayApplied?: boolean;
  /**
   * Sectors the boot pipeline itself changed — the bootopts patch and
   * M3 stamps, diffed against the post-fold bytes (field fix #3).
   * The host seeds these into the overlay hot map so they sweep to the
   * store like guest writes, which is what makes the reference
   * reconstruction (pure base + fold) byte-exact.
   */
  bootDeltaLbas?: number[];
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

/**
 * Overlay sweep cadence (Phase 17 M1, §4.2 decisions): sweeps ride the
 * 1 Hz stats heartbeat, throttled to one per ~5 s — same rhythm as the
 * main thread's fork auto-persist. An epoch the main thread never
 * answers is nacked after 10 s so its writes fold back and retry.
 */
const OVERLAY_SWEEP_THROTTLE_MS = 5_000;
const OVERLAY_ACK_TIMEOUT_MS = 10_000;

/**
 * Phase 18 M2 field fix #2 (Jonathan's second report: "couldn't resume
 * saved state — boot disk reconstruction does not match the capture"):
 * while reference captures are flowing, THEY own the sweep cadence.
 * A maintenance sweep landing between captures puts the overlay store
 * AHEAD of the resume slot's hash — the reconstruction then honestly
 * refuses on every refresh of a disk-active guest, which during and
 * after an ELKS boot is most of the time. Suppression self-cancels:
 * if no reference capture arrives for this long (main degraded, tab
 * that never captures), maintenance sweeps resume and overlay
 * persistence is exactly the pre-M2 behaviour. The forced 4 MiB sweep
 * is NOT suppressed — it bounds hot-map RAM under heavy I/O, and the
 * ≤5 s window it can desync is healed by the next capture (an F5
 * inside it cold-boots honestly).
 */
const RESUME_SWEEP_SUPPRESS_MS = 15_000;

/** Full-image copy via the sector loop. Boot-time (Phase 17 M3 reads
 *  the secondary to decide the show/net stamps) and capture-time
 *  (Phase 18 M2 — works through the OverlayDisk wrapper too: overlay
 *  writes pass through to the inner disk, so this IS the current
 *  image). */
function snapshotDisk(disk: Disk): Uint8Array {
  const out = new Uint8Array(disk.sectorCount * SECTOR_SIZE);
  for (let lba = 0; lba < disk.sectorCount; lba++) {
    out.set(disk.readSector(lba), lba * SECTOR_SIZE);
  }
  return out;
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
  #network: EthernetSwitch | null = null;
  #nicPort: SwitchPort | null = null;
  #gateway: LanGateway | null = null;
  #dns: DnsHost | null = null;
  #control: ControlHost | null = null;
  /** Substrate API v1: mkdrive answers pending from the main thread. */
  readonly #controlPending = new Map<number, (text: string) => void>();
  #controlNextId = 1;
  #httpGateway: HttpGatewayHost | null = null;
  /** Secondary disk write tracker (Phase 15 M2 — virtual drives). */
  #secondaryDisk: WriteTrackingDisk | null = null;
  // ---- Boot-disk overlay engine (Phase 17 M1) ----
  #overlayDisk: OverlayDisk | null = null;
  /**
   * Epoch ids are host-owned and survive machine teardown, so a late
   * `overlay-swept` from before a reset can never match a fresh
   * machine's in-flight epoch.
   */
  #overlayEpochSeq = 1;
  /** Pacer-time when the in-flight epoch was posted (ack timeout). */
  #overlayPendingSince = 0;
  /** Pacer-time of the last sweep post (the ~5 s throttle). */
  #overlayLastSweepAt = 0;
  /** An overlay-flush arrived while an epoch was pending. */
  #overlayFlushWanted = false;
  #tanConfig: { channel: FrameChannel; hostOctet?: number } | null = null;
  #tan: TabAreaNetwork | null = null;
  /** This boot's pristine-primary SHA-256 (Phase 18 M2 pairs captures with it). */
  #bootFingerprint: string | null = null;
  /**
   * Capture sha cache (Phase 18 M2 field fix): the heartbeat resume
   * capture runs every ~5 s, and an idle machine's boot disk doesn't
   * change — `writesSeen` unchanged means the last hash (and for
   * reference captures, the skipped 32 MB copy) still holds.
   */
  #captureShaCache: { writesSeen: number; sha: string } | null = null;
  /** Pacer-time of the last 'reference' capture — gates maintenance sweeps. */
  #lastReferenceCaptureAt = Number.NEGATIVE_INFINITY;
  /**
   * Whether a reference (base + fold) reconstruction can reproduce
   * this session's disk (field fix #3): false for embedded-restore
   * sessions (verbatim disks). Capture replies carry it so main never
   * stores a resume slot that is guaranteed to refuse.
   */
  #referenceValid = true;
  #stopping = false;
  /** Last in-flight async work — boot fetch + autoRun loop. */
  #pending: Promise<void> = Promise.resolve();

  readonly #hostClock: HostClock;

  // ---- Real-time pacing (pacing milestone) ----
  readonly #pacerNow: () => number;
  readonly #pacer: RealTimePacer;
  /** Adaptive per-turn instruction batch — targets ~4 ms of stepping. */
  #adaptiveBatch: number;
  // Rolling stats window (posted ~1/sec while the paced loop runs).
  #statsWindowStart = 0;
  #statsInstructions = 0;
  #statsCycles = 0;

  constructor(opts: WorkerHostOptions) {
    this.#post = opts.post;
    this.#fetchImage = opts.fetchImage;
    this.#autoRun = opts.autoRun ?? true;
    this.#batchSize = opts.batchSize ?? 5000;
    this.#haltSpinCycles = opts.haltSpinCycles ?? 1000;
    this.#maxHaltSpins = opts.maxHaltSpins ?? 1000;
    this.#tanConfig = opts.tan ?? null;
    this.#hostClock = opts.hostClock ?? new NodeHostClock();
    this.#pacerNow = opts.pacerTimeSource ?? (() => performance.now());
    this.#pacer = new RealTimePacer({ now: this.#pacerNow });
    this.#adaptiveBatch = this.#batchSize;
  }

  /** Underlying machine. Tests poke this for low-level inspection. */
  get machine(): IBMPCMachine | null {
    return this.#machine;
  }

  /**
   * The browser-side LAN (Phase 14 M3a). The machine's NE2000 is
   * attached as a port; pseudo-hosts (ARP, DNS, gateway — later
   * milestones) attach here too. Null before the first boot.
   */
  get network(): EthernetSwitch | null {
    return this.#network;
  }

  /**
   * The LAN's gateway pseudo-host at 10.0.2.2 (Phase 14 M3b) —
   * answers ARP and ICMP echo at the address /etc/net.cfg already
   * points the guest at. Null before the first boot.
   */
  get gateway(): LanGateway | null {
    return this.#gateway;
  }

  /**
   * The LAN's DNS pseudo-host at 10.0.2.3 (Phase 14 M3c) — answers
   * the guest's DNS-over-TCP queries via DoH pass-through. Null
   * before the first boot.
   */
  get dns(): DnsHost | null {
    return this.#dns;
  }

  /** The Tab Area Network membership (M3-tabs), if configured. */
  get tan(): TabAreaNetwork | null {
    return this.#tan;
  }

  /** The boot disk's overlay engine (Phase 17 M1). Null before boot. */
  get overlayDisk(): OverlayDisk | null {
    return this.#overlayDisk;
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
    if (msg.type === 'set-speed') {
      // Live toggle from the settings modal — takes effect next turn.
      this.#pacer.setMode(msg.mode);
      return;
    }
    if (msg.type === 'snapshot-secondary') {
      // Synchronous with respect to the machine: messages land between
      // run batches, never mid-step. Taking the snapshot marks the disk
      // clean — persistence is the main thread's job from here; if its
      // IDB write fails the user simply saves again. EXCEPT when
      // keepDirty is set (Phase 16 M3): the editor's read is a PEEK,
      // and marking clean here would starve the M0 auto-persist.
      const disk = this.#secondaryDisk;
      if (disk === null) {
        this.#post({ type: 'secondary-snapshot', bytes: null, dirtySectors: 0 });
        return;
      }
      const dirtySectors = disk.dirtySectorCount;
      const bytes = disk.snapshot();
      if (msg.keepDirty !== true) disk.markClean();
      this.#post({ type: 'secondary-snapshot', bytes, dirtySectors });
      return;
    }
    if (msg.type === 'write-secondary') {
      // Phase 16 M3: the editor panel replaces the running drive's
      // bytes wholesale. The machine keeps running — floppy-passing
      // coherence: the guest must (re)mount to see this, and the main
      // thread shows that notice. replaceContents marks the disk clean
      // (the sender persisted these very bytes before posting).
      const disk = this.#secondaryDisk;
      if (disk === null) {
        this.#post({
          type: 'secondary-written',
          ok: false,
          detail: 'no secondary drive attached',
        });
        return;
      }
      try {
        disk.replaceContents(msg.bytes);
        this.#post({ type: 'secondary-written', ok: true });
      } catch (err) {
        this.#post({ type: 'secondary-written', ok: false, detail: String(err) });
      }
      return;
    }
    if (msg.type === 'control-response') {
      // Substrate API v1: the main thread's answer to a control-request.
      const resolve = this.#controlPending.get(msg.id);
      if (resolve !== undefined) {
        this.#controlPending.delete(msg.id);
        resolve(msg.text);
      }
      return;
    }
    if (msg.type === 'overlay-swept') {
      // Phase 17 M1: the main thread's answer to an overlay-sweep.
      // Late replies — after a reset tore the engine down, or after
      // our own ack timeout already nacked the epoch — miss the id
      // and no-op inside the engine.
      const overlay = this.#overlayDisk;
      if (overlay !== null) {
        if (msg.ok) overlay.ackSweep(msg.epochId);
        else overlay.nackSweep(msg.epochId);
        if (this.#overlayFlushWanted) {
          this.#overlayFlushWanted = false;
          this.#emitOverlaySweep(this.#pacerNow());
        }
      }
      return;
    }
    if (msg.type === 'overlay-flush') {
      // Phase 17 M1: sweep NOW, past the throttle (visibilitychange-
      // hidden). With an epoch in flight, the remainder sweeps the
      // moment that epoch settles (see overlay-swept above).
      const overlay = this.#overlayDisk;
      if (overlay === null) return;
      if (overlay.sweepPending) {
        this.#overlayFlushWanted = true;
        return;
      }
      this.#emitOverlaySweep(this.#pacerNow());
      return;
    }
    if (msg.type === 'capture-state') {
      // Phase 18 M2. The machine-touching part runs synchronously right
      // here — messages land between run turns, so the machine is
      // coherent (the snapshot-secondary precedent). Hashing + the
      // reply complete async over the copies; the machine keeps running.
      this.#captureState(msg);
      return;
    }
    if (msg.type === 'reset') {
      this.#stopping = true;
      // Phase 17 M1: teardown must not eat an epoch — post whatever
      // the overlay holds before the machine dies. A pending epoch
      // folds back first (its sectors merge under any newer ones) so
      // the final sweep is complete; if the main thread also persists
      // the folded epoch, chunk records are idempotent and arrive in
      // post order, so the newer transaction lands last. No more
      // instructions run after this handler: the paced loop re-checks
      // #stopping before its next turn.
      this.#overlayFlushNow();
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

  // ============================================================
  // Substrate API v1 — the control endpoint's injected actions
  // ============================================================

  #whoamiText(): string {
    const id = this.#tan?.identity ?? null;
    if (id === null) return '10.0.2.15 (solo -- no tab area network)';
    return `${id.name ?? `octet-${id.hostOctet}`} 10.0.2.${id.hostOctet}`;
  }

  #peersText(): string {
    const tan = this.#tan;
    if (tan === null) return 'no tab area network -- solo machine';
    const self = tan.identity?.hostOctet ?? -1;
    const lines = tan.memberOctets.map((o) => {
      const name = nameForOctet(o) ?? `octet-${o}`;
      return `${name} 10.0.2.${o}${o === self ? '  <- you' : ''}`;
    });
    return lines.length > 0 ? lines.join('\n') : 'nobody here yet';
  }

  #mkdriveRequest(kb: number): Promise<string> {
    const id = this.#controlNextId++;
    return new Promise<string>((resolve) => {
      this.#controlPending.set(id, resolve);
      this.#post({ type: 'control-request', id, action: 'mkdrive', kb });
      // Headless hosts (tests, Node) may have nobody on the other end:
      // answer honestly instead of leaving urlget to its own timeout.
      setTimeout(() => {
        if (this.#controlPending.has(id)) {
          this.#controlPending.delete(id);
          resolve('mkdrive: nobody answered on the main thread (headless host?)');
        }
      }, 10_000);
    });
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
    await this.#runPacedLoop();
  }

  /**
   * Production run loop (pacing milestone, 2026-07-14). Real time, not
   * instruction count, drives the virtual clock: each turn converts wall
   * elapsed into a cycle budget at 4.77 MHz, executes instructions
   * against it (authentic mode: at most one instruction per cycle, so
   * the CPU never outruns a real 8086; turbo: adaptive batch regardless,
   * clock still wall-true), then advances the clock by the elapsed
   * cycles in PIT-safe slices. Field impetus: `sleep 30` completed in
   * ~1 wall second under instruction pacing (idle halt spins race), and
   * games ran at a fraction of speed under load. After this, guest
   * seconds are wall seconds in both directions.
   *
   * Idle (HLT with IF set) is legitimate here — no halt-spin budget or
   * bail; the clock keeps wall pace and the next PIT edge wakes the CPU
   * on a later turn. HLT with interrupts hard-disabled is a dead
   * machine and posts `halted`.
   *
   * The network fabric is never gated by any of this (Jonathan: "only
   * the CPU clock gets capped — never the networking"): frames inject
   * and pseudo-hosts answer whenever they fire, including during the
   * DNS stall and between turns.
   *
   * Yields between turns use a MessageChannel ping (unclamped, immune
   * to background-tab timer throttling — TAN servers in hidden tabs
   * stay live), so inbound RX/frames keep flowing.
   */
  async #runPacedLoop(): Promise<void> {
    this.#pacer.skip(); // boot/fetch wall time is not guest time
    this.#statsWindowStart = this.#pacerNow();
    this.#statsInstructions = 0;
    this.#statsCycles = 0;

    while (!this.#stopping && this.#machine !== null && this.#console !== null) {
      const machine = this.#machine;

      // DNS resolve or gateway fetch in flight: stall the machine (and
      // its clock) until it settles — with honest pacing this is
      // bounded belt-and-braces (a slow fetch can still outlast the
      // guest's own timeouts: in_resolv's 2 s alarm, urlget's read).
      // Stalled wall time must not become guest time.
      if (
        (this.#dns !== null && this.#dns.pendingResolves > 0) ||
        (this.#httpGateway !== null && this.#httpGateway.pendingFetches > 0)
      ) {
        this.#pacer.skip();
        await yieldMacrotask();
        continue;
      }

      this.#drainRx(this.#console, machine);

      const cycles = this.#pacer.cyclesDue();
      const budget = Math.min(
        this.#adaptiveBatch,
        this.#pacer.instructionBudget(cycles),
      );

      const t0 = this.#pacerNow();
      const turn = this.#stepInstructions(machine, budget);
      const stepMs = this.#pacerNow() - t0;

      if (turn.reason === 'error') {
        this.#flushTx();
        this.#post({ type: 'halted', reason: 'error' });
        return;
      }
      if (turn.reason === 'dead') {
        this.#flushTx();
        this.#post({ type: 'halted', reason: 'halted' });
        return;
      }

      this.#pacer.advanceClock(machine.clock, cycles);
      this.#flushTx();

      // Adaptive batch: target ~4 ms of stepping per budget-bound turn so
      // yields stay frequent without macrotask overhead dominating.
      if (budget > 0 && turn.executed >= budget) {
        if (stepMs < 2 && this.#adaptiveBatch < 250_000) {
          this.#adaptiveBatch = Math.min(250_000, Math.ceil(this.#adaptiveBatch * 1.25));
        } else if (stepMs > 6 && this.#adaptiveBatch > 2_000) {
          this.#adaptiveBatch = Math.max(2_000, Math.floor(this.#adaptiveBatch / 1.25));
        }
      }

      this.#statsInstructions += turn.executed;
      this.#statsCycles += cycles;
      const now = this.#pacerNow();

      // Phase 17 M1: forced sweep — checked every turn (cheap integer
      // compare) so a guest dd'ing the whole disk can't balloon the
      // hot map past the threshold while waiting for the heartbeat.
      if (
        this.#overlayDisk !== null &&
        !this.#overlayDisk.sweepPending &&
        this.#overlayDisk.hotByteCount >= FORCED_SWEEP_BYTES
      ) {
        this.#emitOverlaySweep(now);
      }

      const windowMs = now - this.#statsWindowStart;
      if (windowMs >= 1000) {
        const instrPerSec = Math.round((this.#statsInstructions / windowMs) * 1000);
        this.#post({
          type: 'stats',
          instrPerSec,
          cyclesPerSec: Math.round((this.#statsCycles / windowMs) * 1000),
          realTimeRatio: instrPerSec / (AUTHENTIC_CYCLES_PER_MS * 1000),
          mode: this.#pacer.mode,
          batch: this.#adaptiveBatch,
          ...(this.#secondaryDisk !== null
            ? { secondaryDirtySectors: this.#secondaryDisk.dirtySectorCount }
            : {}),
          ...(this.#overlayDisk !== null
            ? { overlayHotSectors: this.#overlayDisk.hotSectorCount }
            : {}),
        });
        // Overlay upkeep rides the same heartbeat: nack a timed-out
        // epoch (its writes fold back, newer wins), then sweep under
        // the ~5 s throttle if there is anything to sweep.
        this.#overlayMaintenance(now);
        this.#statsWindowStart = now;
        this.#statsInstructions = 0;
        this.#statsCycles = 0;
      }

      await yieldMacrotask();
    }
  }

  /**
   * Execute up to `budget` instructions. Returns early on idle (HLT
   * awaiting an interrupt — the caller's clock advance will bring the
   * next PIT edge), dead (HLT with IF clear and no NMI pending: nothing
   * can ever wake it; no device generates NMIs today), or error (posted
   * before returning). Never advances the clock — that's the pacer's.
   */
  #stepInstructions(
    machine: IBMPCMachine,
    budget: number,
  ): { executed: number; reason: 'ok' | 'idle' | 'dead' | 'error' } {
    const cpu = machine.cpu;
    let executed = 0;
    try {
      while (executed < budget) {
        if (cpu.halted) {
          const ctrl = cpu.intCtrl;
          const canService =
            ctrl.hasNMI() ||
            (ctrl.hasMaskable() && cpu.flags.IF && !cpu.interruptInhibit);
          if (!canService) {
            return cpu.flags.IF || ctrl.hasNMI()
              ? { executed, reason: 'idle' }
              : { executed, reason: 'dead' };
          }
        }
        cpu.step();
        executed++;
      }
    } catch (err: unknown) {
      this.#postError(err);
      return { executed, reason: 'error' };
    }
    return { executed, reason: 'ok' };
  }

  async #boot(config: BootConfig): Promise<void> {
    this.#teardownMachine();
    this.#stopping = false;

    // Pacing: initial CPU speed from settings (live changes arrive via
    // the set-speed message).
    if (config.cpuSpeed !== undefined) this.#pacer.setMode(config.cpuSpeed);

    // TAN identity first (Phase 14 M3-tabs) — the bootopts patch below
    // stamps LOCALIP from it and the NIC MAC derives from it. Created
    // once and kept across reboots: the tab keeps its address, and the
    // lease keeps defending it while the machine restarts.
    if (this.#tanConfig !== null && this.#tan === null) {
      this.#tan = new TabAreaNetwork(this.#tanConfig.channel, {
        ...(this.#tanConfig.hostOctet !== undefined
          ? { hostOctet: this.#tanConfig.hostOctet }
          : {}),
        // Sticky IP (session store): the last session's octet gets
        // first shot; defend/repick still applies.
        ...(config.tanPreferredOctet !== undefined
          ? { preferredOctet: config.tanPreferredOctet }
          : {}),
      });
    }
    const tanIdentity = this.#tan !== null ? await this.#tan.acquire() : null;
    if (tanIdentity !== null) {
      // Report the settled identity so the main thread can persist it
      // for the next page load (and show the address to the user).
      this.#post({
        type: 'tan-identity',
        hostOctet: tanIdentity.hostOctet,
        ...(nameForOctet(tanIdentity.hostOctet) !== null
          ? { name: nameForOctet(tanIdentity.hostOctet) as string }
          : {}),
      });
    }

    // Phase 18 M2: an EMBEDDED restore (named save) replaces the whole
    // resolve pipeline — captured bytes verbatim, no overlay fold, no
    // bootopts patch, no M3 stamps (§1.4: re-stamping would fight the
    // captured RAM's buffer cache). A REFERENCE restore (reload-resume
    // slot) runs the normal pipeline below and hash-verifies after.
    const embeddedRestore = config.restore?.embedded;

    // Phase 17 M3: the secondary resolves FIRST — the primary's stamp
    // set needs to know the drive (mkfs block count for /etc/home.sh)
    // and whether the first-boot show is pending on it (net=ne0 is
    // suppressed for the show boot: ktcp+telnetd+ftpd are the
    // recorded difference between c86 compiling and not).
    let secondary: ResolvedSlot | null = null;
    if (embeddedRestore !== undefined) {
      if (embeddedRestore.secondary != null) {
        secondary = await this.#resolveSlot('secondary', embeddedRestore.secondary);
      }
    } else if (config.secondary) {
      secondary = await this.#resolveSlot('secondary', config.secondary);
    }

    // Per-boot image inputs — what a normal boot applies (and what a
    // refused reference restore falls back to).
    let stamps: ImageStampOptions | undefined;
    let netLine: string[] = [];
    if (config.autologin !== undefined && embeddedRestore === undefined) {
      const secondaryBytes =
        secondary !== null ? snapshotDisk(secondary.disk) : null;
      stamps = {
        autologin: config.autologin,
        secondaryBlocks:
          secondary !== null
            ? (secondary.disk.sectorCount * SECTOR_SIZE) / 1024
            : null,
      };
      if (config.autoNet === true && !showPending(secondaryBytes)) {
        netLine = ['net=ne0'];
      }
    }
    const bootLines: string[] = [
      ...(tanIdentity !== null && embeddedRestore === undefined
        ? [
            tanIdentity.localipLine,
            // The shell's who-am-I (API v1): stock /etc/profile does
            // PS1="$HOSTNAME$PS1", so the prompt becomes `mouse# ` too.
            ...(tanIdentity.hostnameLine !== null ? [tanIdentity.hostnameLine] : []),
          ]
        : []),
      ...netLine,
    ];

    const primarySpec: DiskSlotSpec =
      embeddedRestore !== undefined
        ? embeddedRestore.primary
        : {
            imageUrl: config.imageUrl,
            imageBytes: config.imageBytes,
            geometry: config.geometry,
            diskClass: config.diskClass,
          };

    // Field fix #3 — the reconstruction law: a REFERENCE restore is
    // rebuilt as PURE base + overlay fold (no patch, no stamps — this
    // boot's deltas already live in the store, seeded at the capture
    // boot; see the bootDeltaLbas seeding below) and must hash to the
    // capture. A refusal falls back to the normal pipeline: the cold
    // boot gets fresh identity lines and stamps like any other boot.
    const expected = config.restore?.expected;
    let primary: ResolvedSlot;
    let restoreRefusal: string | null = null;
    if (embeddedRestore !== undefined) {
      primary = await this.#resolveSlot(
        'primary', primarySpec, [], undefined, undefined, /* verbatim: */ true,
      );
    } else if (expected !== undefined) {
      primary = await this.#resolveSlot(
        'primary', primarySpec, [], config.overlay, undefined, /* verbatim: */ true,
      );
      const primarySha = await sha256Hex(snapshotDisk(primary.disk));
      if (primarySha !== expected.primarySha) {
        restoreRefusal = 'boot disk reconstruction does not match the capture';
      } else {
        const secondarySha =
          secondary !== null ? await sha256Hex(snapshotDisk(secondary.disk)) : null;
        if (secondarySha !== expected.secondarySha) {
          restoreRefusal = 'secondary drive does not match the capture';
        }
      }
      if (restoreRefusal !== null) {
        primary = await this.#resolveSlot(
          'primary', primarySpec, bootLines, config.overlay, stamps,
        );
      }
    } else {
      primary = await this.#resolveSlot(
        'primary', primarySpec, bootLines, config.overlay, stamps,
      );
    }

    // Reference reconstructability of THIS session (the capture reply
    // carries it): true unless the disks were applied verbatim.
    this.#referenceValid = embeddedRestore === undefined;

    // Phase 17 M2: report the base's identity every boot. Main stamps
    // the fingerprint into the overlay meta on future sweeps; applied
    // false with chunks offered = the fold was REFUSED (base changed
    // under the tab's machine state) and main moves sweeps to a fresh
    // overlayId.
    this.#bootFingerprint = primary.overlayFingerprint ?? null;
    // A fresh boot's OverlayDisk restarts writesSeen at 0 over a
    // possibly-different image — a stale cache entry would falsely hit.
    this.#captureShaCache = null;
    // Fresh boot: maintenance sweeps run normally until captures start.
    this.#lastReferenceCaptureAt = Number.NEGATIVE_INFINITY;
    if (primary.overlayFingerprint !== undefined) {
      this.#post({
        type: 'overlay-identity',
        fingerprint: primary.overlayFingerprint,
        applied: primary.overlayApplied === true,
        chunksOffered: config.overlay?.chunks.length ?? 0,
      });
    }

    const browserConsole = new BrowserConsole({
      txSink: (byte: number) => this.#txBuffer.push(byte),
    });
    this.#console = browserConsole;

    // Browser-side LAN (Phase 14 M3a): one switch per boot, with the
    // machine's NE2000 as its first port. Frames the guest transmits
    // enter the switch; frames other ports send arrive via
    // `nic.injectFrame`. No pseudo-hosts attach yet — the fabric
    // exists so later milestones only add ports.
    const network = new EthernetSwitch();
    this.#network = network;
    const nicPort = network.attach({
      name: 'ne2000',
      onFrame: (frame) => {
        this.#machine?.nic.injectFrame(frame);
      },
    });
    this.#nicPort = nicPort;
    // M3b: the gateway lives at 10.0.2.2 — the address the guest's
    // /etc/net.cfg already routes to. ARP + ICMP echo for now; DNS
    // and the HTTP gateway grow onto the same LAN later. welcomePing
    // makes `netstat` show life immediately after `net start ne0`
    // (ELKS has no ping client of its own).
    const gateway = new LanGateway({ welcomePing: true });
    gateway.attachTo(network);
    this.#gateway = gateway;
    // M3c: the DNS pseudo-host at 10.0.2.3 — the guest's DNS-over-TCP
    // queries (nslookup, telnet-by-hostname) resolve through DoH. The
    // bootopts patch stamps DNSIP=10.0.2.3 so the stock resolver finds
    // it without an explicit server argument. The answer cache feeds
    // the HTTP gateway's IP→name reverse map (Phase 15 M1).
    const answerCache = new DnsAnswerCache();
    // M4: the `.tabs` zone is answered locally — `cat.tabs`, `elk`,
    // `owl` never leave the LAN. Anything else falls through to DoH.
    const dns = new DnsHost({
      resolve: dohResolve(),
      cache: answerCache,
      localZone: (name) => addressForName(name),
    });
    dns.attachTo(network);
    this.#dns = dns;
    // Phase 15 M1 (M3d): terminate off-subnet TCP at the gateway —
    // `urlget http://…` fetches the real internet (HTTP + CORS bounds
    // apply), and off-subnet :53 (OpenDNS, the resolver's no-DNSIP
    // default) answers via the same DoH path as the DNS host.
    const httpGateway = new HttpGatewayHost({
      fetchFn: realGatewayFetch(),
      reverseLookup: (ip) => answerCache.lookup(ip),
      dnsResolve: dohResolve(),
    });
    httpGateway.attachTo(gateway);
    this.#httpGateway = httpGateway;

    // Substrate API v1 (post-close addendum F): the machine talks to
    // its own substrate with the tool it already has — urlget against
    // the gateway's own address. whoami/peers answer here from TAN
    // state; mkdrive round-trips to the main thread (Phase 16 M0: it
    // queues a swap of THIS tab's drive fork in the session store).
    const control = new ControlHost({
      whoami: () => this.#whoamiText(),
      peers: () => this.#peersText(),
      mkdrive: (kb) => this.#mkdriveRequest(kb),
    });
    control.attachTo(gateway);
    this.#control = control;

    // M3-tabs: bridge this LAN onto the Tab Area Network.
    if (this.#tan !== null) this.#tan.attach(network);

    // Phase 15 M2: the secondary rides behind a write tracker so guest
    // writes can be counted (unsaved-changes indicator) and snapshotted
    // out for explicit save-back to the image library.
    const trackedSecondary = secondary !== null ? new WriteTrackingDisk(secondary.disk) : null;
    this.#secondaryDisk = trackedSecondary;

    // Phase 17 M1: the PRIMARY rides behind the overlay engine — every
    // guest write is captured (bytes copied at write time) and swept
    // to the main thread as coalesced chunks; reads never leave RAM.
    // Always on (§4.1: overlay defaults ON; main-side factory reset is
    // the escape hatch). The secondary keeps its Phase 15 tracker —
    // the field-accepted M0 fork system stays untouched (brief §0).
    const overlayPrimary = new OverlayDisk(primary.disk);
    this.#overlayDisk = overlayPrimary;
    // Field fix #3: seed this boot's patch/stamp deltas into the hot
    // map — content is already on the disk (write-through is a
    // same-bytes no-op), but hot-mapping them makes the next sweep
    // carry them to the store, so a reference reconstruction (pure
    // base + fold) reproduces this boot's image byte-for-byte.
    // Reference-restored boots have no deltas (their store already
    // carries the capture boot's); embedded boots never reconstruct.
    for (const lba of primary.bootDeltaLbas ?? []) {
      overlayPrimary.writeSector(lba, primary.disk.readSector(lba));
    }

    const machine = new IBMPCMachine({
      disk: overlayPrimary,
      diskClass: primary.diskClass,
      ...(secondary && trackedSecondary
        ? {
            secondaryDisk: trackedSecondary,
            secondaryDiskClass: secondary.diskClass,
          }
        : {}),
      console: browserConsole,
      hostClock: this.#hostClock,
      cyclesPerPitTick: 4,
      uartTransmit: (byte: number) => this.#txBuffer.push(byte),
      nicTransmit: (frame: Uint8Array) => nicPort.transmit(frame),
      // On the TAN every tab needs a unique MAC; solo machines keep
      // the fixed default.
      ...(tanIdentity !== null ? { nicMac: tanIdentity.mac } : {}),
    });

    // Silent CGA sink — Phase 9 has no canvas. Without a sink the kernel's
    // early-printk writes to 0xB8000 still land in memory; the mirror is
    // only here to satisfy the same wiring shape `tools/elks/run-serial.ts`
    // uses and to absorb any future serial-mode-with-tee experiment.
    this.#teardownMirror = installCGAMirror(machine, { sink: new NullCGASink() });

    this.#machine = machine;
    machine.reset();

    // Phase 18 M2: apply the captured state over the reset baseline
    // (§1.1: reset-then-overwrite; RAM/devices/clock/CPU order lives in
    // restoreMachineState). Refusals and failures COLD-BOOT the
    // resolved disk instead — the machine the user gets is always a
    // working one, and the restore-result message says which. The
    // paced loop's opening pacer.skip() covers "stalled wall time must
    // not become guest time" for the restore path exactly as for boot.
    if (config.restore !== undefined) {
      let outcome: { ok: boolean; reason?: string };
      if (restoreRefusal !== null) {
        outcome = { ok: false, reason: restoreRefusal };
      } else {
        try {
          restoreMachineState(machine, config.restore.state);
          outcome = { ok: true };
        } catch (err) {
          machine.reset(); // back to the clean cold-boot baseline
          outcome = { ok: false, reason: String(err) };
        }
      }
      this.#post({
        type: 'restore-result',
        ok: outcome.ok,
        capturedAt: config.restore.capturedAt,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      });
    }

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
  async #resolveSlot(
    slotName: 'primary' | 'secondary',
    spec: DiskSlotSpec,
    extraBootoptsLines: readonly string[] = [],
    overlay?: BootConfig['overlay'],
    stamps?: ImageStampOptions,
    verbatim = false,
  ): Promise<ResolvedSlot> {
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

    // Phase 17 M2 — overlay identity + fold, primary only. The
    // fingerprint hashes the PRISTINE bytes every boot (identity is
    // the exact base, not our per-boot stamps); offered chunks fold
    // in ONLY on a match — a silently mis-applied overlay is a
    // corrupt root fs (brief §1.3, hard invariant). Order below is
    // base → overlay → stamps (§1.4).
    let overlayFingerprint: string | undefined;
    let overlayApplied = false;
    if (slotName === 'primary') {
      overlayFingerprint = await sha256Hex(bytes);
      if (overlay !== undefined && overlay.chunks.length > 0) {
        if (overlay.fingerprint === overlayFingerprint) {
          const diskSizeBytes =
            geometry.cylinders * geometry.heads * geometry.sectorsPerTrack * SECTOR_SIZE;
          bytes = foldOverlay(bytes, diskSizeBytes, overlay);
          overlayApplied = true;
        }
      }
    }

    // Field fix #3: remember the post-fold bytes so the patch + stamp
    // deltas below can be diffed out and seeded into the overlay hot
    // map (sector granularity; boot-time only, one 32 MB compare).
    const preDeltaBytes =
      slotName === 'primary' && !verbatim && (diskClass === 'hard-disk' || stamps !== undefined)
        ? new Uint8Array(bytes)
        : null;

    // Phase 14 M2: HD images default to the CGA console, which the
    // browser can't render — auto-patch /bootopts to console=ttyS0 so
    // the xterm terminal works. In-memory copy only (the stored library
    // image is untouched); floppies and already-serial images pass
    // through unchanged; images without a /bootopts block boot as-is.
    // Phase 17 M2: after a fold the patch runs UNCONDITIONALLY — the
    // folded image carries the PREVIOUS session's stamped block
    // (console= present, stale LOCALIP), and the patch is idempotent
    // by construction (drops active claims, re-appends ours), so this
    // is what keeps the bootopts stamp region ours-per-boot (brief
    // §1.4: guest edits to /bootopts don't survive, fold or no fold).
    // A guest-mangled block that can't be patched (crammed past 1023
    // bytes) boots unpatched with a warning — stamps are conveniences,
    // never gates; factory reset is the escape hatch.
    if (
      slotName === 'primary' &&
      !verbatim &&
      diskClass === 'hard-disk' &&
      (overlayApplied || !hasSerialConsole(bytes))
    ) {
      try {
        const patched = patchBootoptsForSerial(bytes, extraBootoptsLines);
        if (patched !== null) bytes = patched;
      } catch (err) {
        console.warn(`WorkerHost: /bootopts stamp skipped — ${String(err)}`);
      }
    }
    // Phase 17 M3: the load-time stamp set — AFTER the bootopts patch
    // so the minix-fs writes land in the final buffer, per-boot and
    // pre-wrapper (stamps never enter the overlay hot map). Failures
    // are per-stamp skips, never boot gates.
    if (slotName === 'primary' && stamps !== undefined) {
      const result = applyImageStamps(bytes, stamps);
      for (const s of result.skipped) {
        console.warn(`WorkerHost: image stamp skipped — ${s}`);
      }
    }
    // Diff the boot deltas (patch + stamps) against the post-fold
    // bytes — the sectors a reference reconstruction cannot re-derive.
    let bootDeltaLbas: number[] | undefined;
    if (preDeltaBytes !== null) {
      bootDeltaLbas = [];
      const sectors = Math.floor(Math.min(preDeltaBytes.length, bytes.length) / SECTOR_SIZE);
      for (let lba = 0; lba < sectors; lba++) {
        const off = lba * SECTOR_SIZE;
        for (let i = 0; i < SECTOR_SIZE; i++) {
          if (preDeltaBytes[off + i] !== bytes[off + i]) {
            bootDeltaLbas.push(lba);
            break;
          }
        }
      }
    }

    const disk = new InMemoryDisk({ geometry, contents: bytes });
    return {
      disk,
      diskClass,
      ...(overlayFingerprint !== undefined ? { overlayFingerprint } : {}),
      ...(slotName === 'primary' ? { overlayApplied } : {}),
      ...(bootDeltaLbas !== undefined ? { bootDeltaLbas } : {}),
    };
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

  // ============================================================
  // Boot-disk overlay sweeps (Phase 17 M1)
  // ============================================================

  /**
   * Begin an epoch and post it. No-op when the engine is absent, an
   * epoch is already in flight, or the hot map is clean.
   */
  #emitOverlaySweep(now: number): void {
    const overlay = this.#overlayDisk;
    if (overlay === null || overlay.sweepPending || overlay.hotSectorCount === 0) return;
    const epochId = this.#overlayEpochSeq++;
    const chunks = overlay.beginSweep(epochId);
    if (chunks === null) return;
    this.#overlayLastSweepAt = now;
    this.#overlayPendingSince = now;
    this.#post({
      type: 'overlay-sweep',
      epochId,
      chunkSizeBytes: overlay.chunkBytes,
      chunks,
    });
  }

  /** Heartbeat upkeep: ack-timeout nack, then the throttled sweep. */
  #overlayMaintenance(now: number): void {
    const overlay = this.#overlayDisk;
    if (overlay === null) return;
    const pendingId = overlay.pendingEpochId;
    if (pendingId !== null && now - this.#overlayPendingSince >= OVERLAY_ACK_TIMEOUT_MS) {
      overlay.nackSweep(pendingId);
    }
    // Reference captures own the sweep cadence while they flow — see
    // RESUME_SWEEP_SUPPRESS_MS. Post-capture writes stay hot until the
    // next capture's own flush, so store == slot-hash between captures.
    if (now - this.#lastReferenceCaptureAt < RESUME_SWEEP_SUPPRESS_MS) return;
    if (
      !overlay.sweepPending &&
      overlay.hotSectorCount > 0 &&
      now - this.#overlayLastSweepAt >= OVERLAY_SWEEP_THROTTLE_MS
    ) {
      this.#emitOverlaySweep(now);
    }
  }

  /**
   * Immediate, complete flush (the reset path): fold any pending epoch
   * back under the hot map and sweep everything in one final epoch.
   */
  #overlayFlushNow(): void {
    const overlay = this.#overlayDisk;
    if (overlay === null) return;
    const pendingId = overlay.pendingEpochId;
    if (pendingId !== null) overlay.nackSweep(pendingId);
    this.#emitOverlaySweep(this.#pacerNow());
  }

  // ============================================================
  // Whole-machine capture (Phase 18 M2)
  // ============================================================

  /**
   * Capture the running machine (brief §1.4, two-phase): first flush
   * the overlay hot map as one final epoch — the store plus that sweep
   * then hold every boot-disk write up to this boundary, which is what
   * makes the 'reference' reconstruction (base → fold → stamps) land on
   * `primarySha` — then copy machine state + disk images synchronously.
   * Hashes and the reply complete async over the copies.
   *
   * Secondary dirty-tracking: the snapshot here is a PEEK (keepDirty
   * semantics) — main writes the fork row from these very bytes, but if
   * that write loses a teardown race the dirty count must still drive
   * the next auto-persist.
   */
  #captureState(msg: CaptureStateMessage): void {
    const machine = this.#machine;
    if (machine === null) {
      this.#post({
        type: 'state-captured',
        requestId: msg.requestId,
        ok: false,
        reason: 'no machine is running',
      });
      return;
    }
    const primaryDisk = machine.disk;
    if (primaryDisk === null) {
      this.#post({
        type: 'state-captured',
        requestId: msg.requestId,
        ok: false,
        reason: 'machine has no primary disk',
      });
      return;
    }
    if (msg.disks === 'reference') {
      this.#lastReferenceCaptureAt = this.#pacerNow();
    }
    try {
      // Phase 1: the final overlay sweep (a pending epoch folds back
      // first so the sweep is complete — the reset-path precedent).
      this.#overlayFlushNow();

      // Phase 2, synchronous copies at this message boundary. The
      // primary copy+hash is skipped when nothing wrote the boot disk
      // since the last capture (the heartbeat-idle case — see the
      // cache field); embedded captures always copy (bytes must ride).
      const state = captureMachineState(machine);
      const capturedAt = Date.now();
      const embedded = msg.disks === 'embedded';
      const writesSeen = this.#overlayDisk?.writesSeen ?? -1;
      const cached =
        this.#captureShaCache !== null &&
        writesSeen >= 0 &&
        this.#captureShaCache.writesSeen === writesSeen
          ? this.#captureShaCache.sha
          : null;
      const primaryBytes = embedded || cached === null ? snapshotDisk(primaryDisk) : null;
      const primaryGeometry = primaryDisk.geometry;
      const secondaryDisk = this.#secondaryDisk;
      const secondaryDirtySectors = secondaryDisk !== null ? secondaryDisk.dirtySectorCount : 0;
      const secondaryBytes = secondaryDisk !== null ? secondaryDisk.snapshot() : null;
      if (secondaryDisk !== null && msg.markSecondaryClean === true) {
        // This capture IS the persistence path (heartbeat resume) —
        // snapshot-secondary semantics: main writes the fork row from
        // these very bytes.
        secondaryDisk.markClean();
      }
      const secondaryGeometry = secondaryDisk !== null ? secondaryDisk.geometry : null;
      const baseFingerprint = this.#bootFingerprint;
      const diskClass = machine.diskClass;
      const secondaryDiskClass = machine.secondaryDiskClass;
      const referenceValid = this.#referenceValid;

      // Async completion: hashes over the copies, then the reply.
      void (async () => {
        try {
          let primarySha: string;
          if (primaryBytes !== null) {
            primarySha = await sha256Hex(primaryBytes);
          } else if (cached !== null) {
            primarySha = cached;
          } else {
            // Unreachable: primaryBytes is only skipped when cached hit.
            throw new Error('capture: no primary bytes and no cached sha');
          }
          if (writesSeen >= 0) {
            this.#captureShaCache = { writesSeen, sha: primarySha };
          }
          const secondarySha =
            secondaryBytes !== null ? await sha256Hex(secondaryBytes) : null;
          this.#post({
            type: 'state-captured',
            requestId: msg.requestId,
            ok: true,
            state,
            capturedAt,
            baseFingerprint,
            primarySha,
            secondarySha,
            secondaryDirtySectors,
            referenceValid,
            ...(embedded && primaryBytes !== null
              ? {
                  primary: {
                    bytes: primaryBytes,
                    geometry: primaryGeometry,
                    diskClass,
                  },
                }
              : {}),
            secondary:
              secondaryBytes !== null && secondaryGeometry !== null
                ? {
                    bytes: secondaryBytes,
                    geometry: secondaryGeometry,
                    diskClass: secondaryDiskClass,
                  }
                : null,
          });
        } catch (err) {
          this.#post({
            type: 'state-captured',
            requestId: msg.requestId,
            ok: false,
            reason: String(err),
          });
        }
      })();
    } catch (err) {
      this.#post({
        type: 'state-captured',
        requestId: msg.requestId,
        ok: false,
        reason: String(err),
      });
    }
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
    if (this.#nicPort) {
      this.#nicPort.detach();
      this.#nicPort = null;
    }
    if (this.#gateway) {
      this.#gateway.detach();
      this.#gateway = null;
    }
    // The HTTP gateway has no switch port of its own — it dies with
    // the gateway it was plugged into. Same for the control endpoint.
    this.#httpGateway = null;
    this.#control = null;
    // Unsaved secondary writes die with the machine — save is explicit
    // by design (the settings UI says so before the user reloads).
    this.#secondaryDisk = null;
    // The overlay engine dies with the machine; the reset handler
    // already posted a final sweep before chaining this teardown.
    // (#overlayEpochSeq survives on purpose — see its declaration.)
    this.#overlayDisk = null;
    this.#overlayFlushWanted = false;
    if (this.#dns) {
      this.#dns.detach();
      this.#dns = null;
    }
    // TAN survives teardown (identity + defence persist across
    // reboots); only the trunk into the dying switch unplugs.
    this.#tan?.detachLan();
    this.#network = null;
    this.#machine = null;
    this.#console = null;
    this.#txBuffer.length = 0;
  }
}

/**
 * Yield to the macrotask queue. Workers process inbound `message` events as
 * macrotasks, so a microtask yield (queueMicrotask) would starve them.
 *
 * Pacing milestone: in a REAL web worker the yield is a MessageChannel
 * ping instead of `setTimeout(0)` — browsers clamp nested timeouts to
 * ≥1 ms (and throttle them hard in background tabs, which would starve
 * TAN servers in hidden tabs); a port message is an unclamped macrotask.
 * Everywhere else (Node tests, CLI) it stays `setTimeout(0)`: Node
 * doesn't clamp it meaningfully, and — found the hard way — a
 * continuously ping-ponging MessageChannel wedges vitest's worker
 * teardown so hard the whole run hangs with no output (both thread and
 * fork pools; see BROWSER_PACING_REPORT.md). `importScripts` is the
 * real-dedicated-worker discriminator: absent in Node and on the main
 * thread.
 */
const yieldMacrotask: () => Promise<void> = (() => {
  const isRealWorker =
    typeof (globalThis as { importScripts?: unknown }).importScripts === 'function';
  if (!isRealWorker || typeof MessageChannel === 'undefined') {
    return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const channel = new MessageChannel();
  const waiters: Array<() => void> = [];
  channel.port1.onmessage = () => waiters.shift()?.();
  return () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
      channel.port2.postMessage(null);
    });
})();
