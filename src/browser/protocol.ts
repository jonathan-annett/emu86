/**
 * Message protocol between the main thread and the emulator worker.
 *
 * Both sides import these types from one source of truth so the channel
 * stays type-safe. Nothing here is coupled to `postMessage` — the worker
 * host consumes and produces messages through an abstraction. In tests we
 * substitute the channel with two arrays.
 *
 * Bytes ride as `Uint8Array`. xterm.js's `write()` accepts either string or
 * `Uint8Array`; main → worker `rx` messages encode keystrokes via
 * `TextEncoder`. We never use string for terminal traffic — control bytes
 * round-trip cleanly as raw octets.
 */

import type { CpuSpeedMode } from './pacing.js';
import type { OverlayChunk } from '../disk/overlay.js';
import type { MachineState } from '../machine/machine-state.js';

export type { CpuSpeedMode, OverlayChunk, MachineState };

/**
 * CHS geometries we recognise when inferring from image size. Mirrors
 * `tools/elks/run-serial.ts`'s floppy table, plus ELKS HD shapes added in
 * Phase 10. The set is deliberately narrow — explicit geometry in
 * BootConfig is the override path for anything we don't recognise.
 */
export interface DiskGeometry {
  cylinders: number;
  heads: number;
  sectorsPerTrack: number;
}

/**
 * Disk class — picked up by the BIOS to choose the boot drive number
 * (0x00 for floppy, 0x80 for HD) and the AH=0x08 return shape.
 *
 * The worker host derives this from geometry today (heads ≥ 4 → HD), but
 * exposing it on BootConfig lets a future caller pin it explicitly when
 * the size table can't infer (e.g., user-uploaded image with bespoke
 * geometry).
 */
export type DiskClass = 'floppy' | 'hard-disk';

/**
 * Source spec for one disk slot. Exactly one of `imageUrl` / `imageBytes`
 * is required; if both are set, `imageBytes` wins. Geometry and class
 * are optional and inferred from image size when omitted.
 */
export interface DiskSlotSpec {
  imageUrl?: string;
  imageBytes?: Uint8Array;
  geometry?: DiskGeometry;
  diskClass?: DiskClass;
}

/**
 * Boot configuration. The flat `imageUrl/imageBytes/geometry/diskClass`
 * fields describe the primary disk (back-compat with the pre-Phase-11
 * single-disk shape — every test that constructs a BootConfig the old
 * way keeps working unmodified). The optional `secondary` field adds a
 * second mounted disk surfaced to the kernel as `/dev/hdb` (or `/dev/fd1`)
 * — userland mounts it on demand; the BIOS does not auto-boot from it.
 *
 * Either `imageUrl` (worker fetches via HTTP) or `imageBytes` (main thread
 * already has the bytes — useful for tests and uploads). If both are set,
 * `imageBytes` wins.
 */
export interface BootConfig {
  imageUrl?: string;
  imageBytes?: Uint8Array;
  /**
   * Machine memory in bytes — a power of two (XMS brief M2). Default
   * 1 MiB (the canonical 8086 PC; tests and CLI unchanged). The
   * browser boots 4 MiB: memory above 1 MiB is reachable ONLY through
   * the BIOS INT 15h block move (the CPU's segment arithmetic tops
   * out at the HMA), which is exactly ELKS's XMS_INT15 model. When
   * >1 MiB the worker stamps `xms=int15` (+ `hma=off` — INT15 XMS and
   * an HMA kernel are mutually exclusive in stock ELKS, and the
   * tunable XMS buffer pool is worth more than the fixed 64 K of HMA).
   */
  memorySize?: number;
  /**
   * Optional explicit geometry. If absent, the worker infers from the
   * image size against its built-in floppy + ELKS HD table; anything
   * else needs an explicit geometry.
   */
  geometry?: DiskGeometry;
  /**
   * Optional explicit disk class. If absent, derived from the (explicit
   * or inferred) geometry — heads ≥ 4 means hard-disk, else floppy.
   */
  diskClass?: DiskClass;
  /**
   * Optional secondary disk (Phase 11). When set, the worker constructs
   * an `IBMPCMachine` with both disks attached and the BIOS routes INT
   * 13h calls per slot/class. Same geometry-inference rules as the
   * primary apply.
   */
  secondary?: DiskSlotSpec;
  /**
   * Preferred TAN host octet (sticky IP). Main thread reads it from the
   * tab's session store and the TAN lease tries it first — full
   * defend/repick semantics still apply, so a duplicated tab offering
   * a live octet repicks. The settled octet flows back via
   * {@link TanIdentityMessage}.
   */
  tanPreferredOctet?: number;
  /**
   * Initial CPU speed (pacing milestone). `'authentic'` caps execution
   * at a real 4.77 MHz 8086; `'turbo'` uncaps instructions while the
   * clock stays wall-true. Default authentic. Live changes ride
   * {@link SetSpeedMessage}.
   */
  cpuSpeed?: CpuSpeedMode;
  /**
   * Boot-disk overlay to fold (Phase 17 M2). Main loads the tab's
   * chunks from `emu86-overlays` pre-boot; the worker folds them into
   * the primary's bytes ONLY if `fingerprint` matches the SHA-256 it
   * computes over the pristine base this boot (mismatch ⇒ not
   * applied, reported via {@link OverlayIdentityMessage} — a silently
   * mis-applied overlay is a corrupt root fs). Fold happens before
   * the per-boot bootopts stamp: base → overlay → stamps.
   */
  overlay?: {
    chunks: OverlayChunk[];
    /** Aligned span the chunks were swept under (self-describing). */
    chunkSizeBytes: number;
    /** SHA-256 hex of the base these chunks were written against. */
    fingerprint: string;
  };
  /**
   * Phase 17 M3: apply the load-time stamp set to the primary —
   * inittab autologin ('off' restores the stock getty), passwd home
   * moves, /etc/home.sh + skel seeds, mount.cfg marker. ABSENT means
   * no M3 stamps at all: tests and CLI boots keep untouched images.
   */
  autologin?: 'off' | 'root' | 'user1';
  /**
   * Phase 17 M3: stamp `net=ne0` into bootopts so rc.sys starts the
   * NIC with nothing typed. Suppressed by the worker while the
   * first-boot show is pending on the secondary — the recorded 640K
   * constraint (ktcp+telnetd+ftpd vs c86 compiling), and the show
   * compiles. Meaningless without `autologin`.
   */
  autoNet?: boolean;
  /**
   * Phase 18 M2: boot as a RESTORE — reset is the clean baseline,
   * then the captured machine state overwrites it (brief §1.1). Two
   * disk shapes, one per D2 branch:
   *
   *   - `embedded` (named saves, D2(a)): the captured disk bytes ride
   *     here VERBATIM and replace the whole resolve pipeline — no
   *     overlay fold, no bootopts patch, no M3 stamps. Re-stamping
   *     would fight the captured RAM's buffer cache (§1.4).
   *   - `expected` (the reload-resume slot, D2(b) reference): the
   *     NORMAL pipeline runs (base → overlay fold → patch → stamps)
   *     and the result must hash to `primarySha` (secondary to
   *     `secondarySha`) or the restore is REFUSED — the machine
   *     cold-boots the resolved disk instead and a
   *     {@link RestoreResultMessage} says so honestly. Any drift
   *     (lost final sweep, changed autologin, different octet's
   *     stamps) lands here by construction.
   *
   * Exactly one of `embedded` / `expected` should be set.
   */
  restore?: RestoreSpec;
}

/** See {@link BootConfig.restore}. */
export interface RestoreSpec {
  /** The captured whole-machine state (M1's structured form). */
  state: MachineState;
  /** Date.now() at capture — restore compares age for the honesty notice. */
  capturedAt: number;
  /** D2(a): captured disk bytes, verbatim. */
  embedded?: {
    primary: DiskSlotSpec & { imageBytes: Uint8Array };
    secondary?: (DiskSlotSpec & { imageBytes: Uint8Array }) | null;
  };
  /**
   * D2(b): SHA-256 hexes the reference reconstruction must match.
   *
   * Field fix #3 (the reconstruction law): the reference rebuild is
   * PURE `base + overlay fold` — no bootopts patch, no M3 stamps.
   * The boot deltas (patch + stamp sectors) are seeded into the
   * overlay hot map at boot time and ride the store like any guest
   * write, so the fold reproduces the captured image byte-for-byte
   * by construction. Re-applying them at restore can never be
   * byte-stable: minix-fs writes stamp wall-clock mtimes, and the
   * block allocator runs against a different filesystem state than
   * the boot did (both found live, Jonathan's field pass).
   */
  expected?: {
    primarySha: string;
    /** null = no secondary was attached at capture. */
    secondarySha: string | null;
  };
  /**
   * Field fix #4 (the torn resume pair) — the slot row's carried
   * primary delta: the final overlay epoch of the capture that wrote
   * the slot, folded AFTER the store's chunks (base → store fold →
   * carried). Whatever half of the capture's IDB writes survived a
   * teardown, slot + store reconstructs: carried covers everything
   * the store might be missing. `fingerprint` must match the base
   * this boot (the store-fold rule) or the resume is refused.
   * Reference (`expected`) restores only.
   */
  carriedPrimary?: {
    chunkSizeBytes: number;
    fingerprint: string;
    chunks: OverlayChunk[];
  } | null;
  /**
   * Field fix #4 — the carried secondary delta: the sectors dirty at
   * capture (unconfirmed against the fork row), bytes from the
   * capture's own snapshot. Applied over the resolved secondary
   * before the `secondarySha` check; written through the tracker on
   * success so they re-enter the persistence chain. Reference
   * restores only.
   */
  carriedSecondary?: Array<{ lba: number; bytes: Uint8Array }> | null;
}

// ============================================================
// Main → Worker
// ============================================================

export interface BootMessage {
  type: 'boot';
  config: BootConfig;
}

export interface RxMessage {
  type: 'rx';
  bytes: Uint8Array;
}

export interface ResetMessage {
  type: 'reset';
}

/** Live CPU-speed toggle from the settings modal (pacing milestone). */
export interface SetSpeedMessage {
  type: 'set-speed';
  mode: CpuSpeedMode;
}

/**
 * Ask the worker for the secondary disk's current bytes (Phase 15 M2 —
 * virtual drives). The reply is {@link SecondarySnapshotMessage}. Save
 * is explicit and main-thread-driven: the worker never persists.
 */
export interface SnapshotSecondaryMessage {
  type: 'snapshot-secondary';
  /**
   * Phase 16 M3: when true this is a PEEK — the snapshot does NOT
   * mark the disk clean. The editor panel's read path must use it:
   * a clean-marking read would zero the dirty counter and starve the
   * M0 auto-persist that keeps the tab's fork reload-safe. Absent /
   * false = Phase 15 semantics (Save and auto-persist mark clean).
   */
  keepDirty?: boolean;
}

/**
 * Phase 16 M3: replace the RUNNING secondary's bytes wholesale — the
 * editor panel's write. The machine keeps running; coherence is
 * floppy-passing (brief §1): the guest must (re)mount to see the new
 * bytes, and we cannot detect mounts, so the UI shows a notice, not a
 * guard. Reply is {@link SecondaryWrittenMessage}. `bytes` must match
 * the drive's size exactly — anything else is a caller bug and nacks.
 */
export interface WriteSecondaryMessage {
  type: 'write-secondary';
  bytes: Uint8Array;
}

/**
 * Reply to {@link ControlRequestMessage} (substrate API v1). `text` is
 * shown verbatim in the guest's terminal by the control endpoint.
 */
export interface ControlResponseMessage {
  type: 'control-response';
  id: number;
  text: string;
}

/**
 * Phase 17 M1: ack/nack for one boot-disk overlay sweep epoch. `ok:
 * false` (the main thread's IDB write failed) — like the worker's own
 * ack timeout — folds the epoch back into the hot map, where newer
 * writes win, and a later tick retries. Stale epoch ids (a reply that
 * outlived a reset) are ignored by the worker.
 */
export interface OverlaySweptMessage {
  type: 'overlay-swept';
  epochId: number;
  ok: boolean;
  detail?: string;
}

/**
 * Phase 17 M1: sweep the boot-disk hot map NOW, past the throttle —
 * the main thread sends it on visibilitychange-hidden (the best
 * predictor of a close/reload we get). If an epoch is already in
 * flight the worker sweeps the remainder the moment that epoch
 * settles. No-op when the hot map is clean.
 */
export interface OverlayFlushMessage {
  type: 'overlay-flush';
}

/**
 * Phase 18 M2: capture the running machine's complete state. The
 * worker's synchronous part (machine + disk copies + the final
 * overlay epoch) happens at the message boundary — coherent for free;
 * hashing and the {@link StateCapturedMessage} reply complete async
 * over the copies while the machine keeps running.
 *
 * Field fix #4 (the torn resume pair): a 'reference' capture no
 * longer posts `overlay-sweep` — its final epoch rides INSIDE the
 * reply (`overlayEpoch`) and stays pending worker-side until main
 * acks with {@link OverlaySweptMessage} AFTER the store write
 * commits. Main's write order is slot row → fork row → overlay
 * chunks → acks, so nothing newer than the committed slot can reach
 * the store. 'embedded' captures don't sweep at all (their bytes are
 * self-contained; a flush would only advance the store past the
 * resume slot).
 */
export interface CaptureStateMessage {
  type: 'capture-state';
  /** Correlates the {@link StateCapturedMessage} reply. */
  requestId: number;
  /**
   * 'embedded' (named saves): the reply carries full primary bytes.
   * 'reference' (reload-resume slot): hashes only — the primary is
   * reconstructed at restore from base + overlay + stamps. Secondary
   * bytes ride in BOTH modes (they feed the fork row).
   */
  disks: 'embedded' | 'reference';
  /**
   * Phase 18 M2 field fix (the F5 race), REVISED by field fix #4:
   * when true this capture IS the persistence path — the worker
   * BEGINS a two-phase clean (the dirty set moves to pending, the
   * reply carries its LBAs in `secondaryDirtyLbas`) and main must
   * confirm the fork-row write with {@link SecondaryPersistedMessage}
   * before the sectors count as durable. Absent/false = peek (named
   * saves — the fork auto-persist keeps its own trigger).
   */
  markSecondaryClean?: boolean;
}

/**
 * Field fix #4: main's confirmation of the fork-row write a
 * reference capture's `markSecondaryClean` began. `ok: true` after
 * the IDB write commits (or when there was nothing to persist) drops
 * the worker's pending-clean set; `ok: false` folds it back so the
 * next capture re-carries those sectors. Stale requestIds (a reply
 * that outlived a reset or a newer capture) are ignored.
 */
export interface SecondaryPersistedMessage {
  type: 'secondary-persisted';
  /** The capture whose clean epoch this confirms. */
  requestId: number;
  ok: boolean;
}

/**
 * Phase 18 field-loop UI: freeze the CPU (the inspect popup's law —
 * "freezes the cpu until popup dismissed"). While paused the paced
 * loop steps nothing and skips the pacer every turn, so frozen wall
 * time never becomes guest time; the network fabric stays live
 * (frames keep injecting — only the CPU clock is ever gated).
 */
export interface SetPausedMessage {
  type: 'set-paused';
  paused: boolean;
}

/**
 * Phase 18 field-loop UI: one coherent machine inspection — registers,
 * code/stack windows, device summaries. Machine state is coherent at
 * every message boundary; pair with {@link SetPausedMessage} to hold
 * it still while the popup is open.
 */
export interface InspectMachineMessage {
  type: 'inspect-machine';
  requestId: number;
}

export type MainToWorkerMessage =
  | BootMessage
  | RxMessage
  | ResetMessage
  | SetSpeedMessage
  | SnapshotSecondaryMessage
  | WriteSecondaryMessage
  | ControlResponseMessage
  | OverlaySweptMessage
  | OverlayFlushMessage
  | CaptureStateMessage
  | SecondaryPersistedMessage
  | SetPausedMessage
  | InspectMachineMessage;

// ============================================================
// Worker → Main
// ============================================================

export interface ReadyMessage {
  type: 'ready';
}

export interface TxMessage {
  type: 'tx';
  bytes: Uint8Array;
}

export interface HaltedMessage {
  type: 'halted';
  reason: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  stack?: string;
}

/**
 * Settled TAN identity for this boot (Phase 14 — sticky IPs). Sent
 * after the lease resolves so the main thread can persist the octet in
 * the tab's session store for the next page load.
 */
export interface TanIdentityMessage {
  type: 'tan-identity';
  hostOctet: number;
  /**
   * The tab's name in the `.tabs` namespace (Phase 15 M4) — `mouse`,
   * `cat`, `dog`… A pure function of the octet, so the main thread
   * could derive it, but sending it keeps the mapping in one place.
   */
  name?: string;
}

/**
 * Rolling throughput stats, ~1/sec while the paced loop runs (pacing
 * milestone). `realTimeRatio` = instrPerSec / 4.77M — 1.0 means a full
 * authentic 8086's worth of CPU delivered; `cyclesPerSec` should sit
 * near 4.77M whenever the clock is keeping wall pace.
 */
export interface StatsMessage {
  type: 'stats';
  instrPerSec: number;
  cyclesPerSec: number;
  realTimeRatio: number;
  mode: CpuSpeedMode;
  /** Current adaptive per-turn instruction batch. */
  batch: number;
  /**
   * Distinct secondary-disk sectors the guest has written since boot or
   * the last snapshot (Phase 15 M2). Present only while a secondary is
   * mounted; drives the main thread's "unsaved changes" indicator.
   */
  secondaryDirtySectors?: number;
  /**
   * Distinct boot-disk sectors currently in the overlay hot map —
   * written but not yet swept (Phase 17 M1). Tuning telemetry for the
   * chunk-size / throttle / threshold constants (§4.2: retune from
   * data, not taste). Present whenever the overlay engine is attached.
   */
  overlayHotSectors?: number;
  /**
   * Cumulative NIC frame counters since boot (Phase 18 field-loop UI —
   * the NET LED blinks on deltas). rx = frames accepted into the ring;
   * tx = frames the guest transmitted onto the fabric.
   */
  nicRxFrames?: number;
  nicTxFrames?: number;
}

/**
 * Reply to {@link SnapshotSecondaryMessage}. `bytes` is null when no
 * secondary disk is mounted. Taking the snapshot resets the worker's
 * dirty count — the main thread owns persistence from here.
 */
export interface SecondarySnapshotMessage {
  type: 'secondary-snapshot';
  bytes: Uint8Array | null;
  /** Dirty-sector count at snapshot time (diagnostic). */
  dirtySectors: number;
}

/**
 * Substrate API v1 (the guest ran `urlget http://10.0.2.2/?mkdrive=…`):
 * the action needs main-thread state (Phase 16 M0: the per-tab session
 * store — mkdrive queues a swap of the tab's own drive fork), so
 * the worker asks and the answer returns as
 * {@link ControlResponseMessage} with the same id. Queue-and-complete;
 * the machine keeps running meanwhile (two postMessages, not a fetch —
 * no run-loop stall involved).
 */
export interface ControlRequestMessage {
  type: 'control-request';
  id: number;
  action: 'mkdrive';
  kb: number;
}

/**
 * Reply to {@link WriteSecondaryMessage}. `ok: false` carries the
 * reason (no drive attached; size mismatch) — the panel surfaces it.
 */
export interface SecondaryWrittenMessage {
  type: 'secondary-written';
  ok: boolean;
  detail?: string;
}

/**
 * Phase 17 M1: one epoch of boot-disk overlay writes, coalesced into
 * aligned chunks. The worker never persists (Phase 15 rule) — the
 * main thread writes all chunks in ONE IndexedDB transaction and
 * answers with {@link OverlaySweptMessage} carrying the same epochId.
 * Chunk records are idempotent (a chunkIndex overwrites its prior
 * stored version) and self-contained (each carries its full aligned
 * span, RAM-filled at sweep time; the tail chunk may be short). Chunk
 * buffers are freshly allocated per sweep — the worker entry transfers
 * them.
 */
export interface OverlaySweepMessage {
  type: 'overlay-sweep';
  epochId: number;
  /** The engine's aligned span (§4.2: 32 KB) — recorded in the store's meta row. */
  chunkSizeBytes: number;
  chunks: OverlayChunk[];
}

/**
 * Phase 17 M2: the primary base's identity, computed and posted every
 * boot (before `ready`). Main stamps `fingerprint` into the overlay
 * meta row on future sweeps; `applied:false` with `chunksOffered > 0`
 * means the offered overlay did NOT match this base — the worker
 * refused the fold and main must move the tab's sweeps to a fresh
 * overlayId so the kept rows aren't clobbered.
 */
export interface OverlayIdentityMessage {
  type: 'overlay-identity';
  /** SHA-256 hex of the pristine primary bytes, this boot. */
  fingerprint: string;
  /** Whether offered chunks were folded into the base. */
  applied: boolean;
  /** How many chunks BootConfig.overlay offered (0 = none offered). */
  chunksOffered: number;
}

/** One captured disk: bytes + enough identity to reconstruct the slot. */
export interface CapturedDisk {
  bytes: Uint8Array;
  geometry: DiskGeometry;
  diskClass: DiskClass;
}

/**
 * Reply to {@link CaptureStateMessage}. `ok: false` (no machine, or a
 * capture error) carries `reason`. On success: the machine state, the
 * capture timestamp, this boot's base fingerprint (pairs the snapshot
 * with its overlay era), SHA-256 of the primary/secondary images at
 * capture, the secondary bytes (both modes — the fork row's truth),
 * and — 'embedded' mode only — the primary bytes.
 */
export interface StateCapturedMessage {
  type: 'state-captured';
  requestId: number;
  ok: boolean;
  reason?: string;
  state?: MachineState;
  capturedAt?: number;
  /** SHA-256 of the PRISTINE base this boot (the overlay identity), or null (no primary fingerprint era). */
  baseFingerprint?: string | null;
  /** SHA-256 of the primary's CURRENT image at capture (stamps + writes included). */
  primarySha?: string;
  /** SHA-256 of the secondary at capture, or null when none attached. */
  secondarySha?: string | null;
  /** 'embedded' mode only. */
  primary?: CapturedDisk;
  /** Both modes; null when no secondary is attached. */
  secondary?: CapturedDisk | null;
  /**
   * Dirty-sector count at capture (before any markSecondaryClean) —
   * lets the resume flow skip the fork-row IDB write when the guest
   * hasn't touched the drive since the last persist.
   */
  secondaryDirtySectors?: number;
  /**
   * True when a reference (base + overlay fold) reconstruction can
   * reproduce this session's disk — i.e. this boot's image derives
   * from the library base with every delta in the overlay store.
   * False for embedded-restore sessions (verbatim disks): the resume
   * flow must skip slot updates rather than store a slot that is
   * guaranteed to refuse.
   */
  referenceValid?: boolean;
  /**
   * Field fix #4, 'reference' mode: the capture's final overlay
   * epoch — every boot-disk write since the last acked sweep. Main
   * stores these chunks IN the slot row (the carried delta), then
   * writes them to the overlay store, then acks `epochId` via
   * {@link OverlaySweptMessage}. Null = the hot map was clean (the
   * slot needs no carried delta). The worker holds the epoch pending
   * until the ack/nack; its ack timeout self-heals an abandoned one.
   */
  overlayEpoch?: {
    epochId: number;
    chunkSizeBytes: number;
    chunks: OverlayChunk[];
  } | null;
  /**
   * Field fix #4, with `markSecondaryClean`: the unconfirmed
   * secondary sectors at capture (the pending-clean set). Main
   * slices their bytes from `secondary.bytes` into the slot row's
   * carried delta and confirms the fork write with
   * {@link SecondaryPersistedMessage}.
   */
  secondaryDirtyLbas?: number[];
}

/**
 * Phase 18 M2: the outcome of a {@link BootConfig.restore}, posted
 * just before `ready`. `ok: false` means the machine COLD-BOOTED the
 * resolved disk instead (hash mismatch, state schema mismatch, or a
 * restore error) — `reason` says why, main surfaces it honestly.
 */
export interface RestoreResultMessage {
  type: 'restore-result';
  ok: boolean;
  /** Echo of the restored capture's timestamp (age = now - capturedAt). */
  capturedAt?: number;
  reason?: string;
}

/** One coherent machine inspection (the freeze-and-inspect popup). */
export interface InspectSnapshot {
  regs: {
    ax: number; bx: number; cx: number; dx: number;
    si: number; di: number; bp: number; sp: number;
    ip: number; cs: number; ds: number; es: number; ss: number;
  };
  flags: number;
  halted: boolean;
  /** Instantaneous speed context (mode; ratio rides the stats LED). */
  mode: CpuSpeedMode;
  /** Code window: bytes starting at linear CS:IP. */
  code: { linear: number; bytes: Uint8Array };
  /** Stack window: bytes starting at linear SS:SP (little-endian words). */
  stack: { linear: number; bytes: Uint8Array };
  devices: {
    pic: { irr: number; isr: number; imr: number; vectorBase: number };
    pit: { counter: number; divisor: number; mode: number };
    uart: { ier: number; lcr: number; mcr: number; rxQueued: number };
    nic: { isr: number; imr: number; curr: number; bnry: number; running: boolean };
  };
}

/** Reply to {@link InspectMachineMessage}. */
export interface MachineInspectedMessage {
  type: 'machine-inspected';
  requestId: number;
  ok: boolean;
  reason?: string;
  snapshot?: InspectSnapshot;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | TxMessage
  | HaltedMessage
  | ErrorMessage
  | TanIdentityMessage
  | StatsMessage
  | SecondarySnapshotMessage
  | SecondaryWrittenMessage
  | ControlRequestMessage
  | OverlaySweepMessage
  | OverlayIdentityMessage
  | StateCapturedMessage
  | RestoreResultMessage
  | MachineInspectedMessage;
