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

export type { CpuSpeedMode, OverlayChunk };

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

export type MainToWorkerMessage =
  | BootMessage
  | RxMessage
  | ResetMessage
  | SetSpeedMessage
  | SnapshotSecondaryMessage
  | WriteSecondaryMessage
  | ControlResponseMessage
  | OverlaySweptMessage
  | OverlayFlushMessage;

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
  | OverlaySweepMessage;
