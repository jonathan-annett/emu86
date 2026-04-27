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

/**
 * Floppy geometries we recognise when inferring from image size. Mirrors
 * `tools/elks/run-serial.ts`'s table; we keep the union narrow because the
 * canonical browser image is the 1.44 MB serial-console build.
 */
export interface DiskGeometry {
  cylinders: number;
  heads: number;
  sectorsPerTrack: number;
}

/**
 * Boot configuration. Either `imageUrl` (worker fetches via HTTP) or
 * `imageBytes` (main thread already has the bytes — useful for tests and
 * for any future "upload your own image" affordance).
 *
 * If both are set, `imageBytes` wins.
 */
export interface BootConfig {
  imageUrl?: string;
  imageBytes?: Uint8Array;
  /**
   * Optional explicit geometry. If absent, the worker infers from the
   * image size. The serial harness only recognises 1.44 MB (1474560) and
   * 1.2 MB (1228800); anything else needs an explicit geometry.
   */
  geometry?: DiskGeometry;
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

export type MainToWorkerMessage = BootMessage | RxMessage | ResetMessage;

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

export type WorkerToMainMessage =
  | ReadyMessage
  | TxMessage
  | HaltedMessage
  | ErrorMessage;
