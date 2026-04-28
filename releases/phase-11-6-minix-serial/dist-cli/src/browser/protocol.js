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
export {};
