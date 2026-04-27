import type { Byte, Word } from './types.js';

/**
 * I/O port bus. 8086 has a 64 KiB I/O address space accessed via IN/OUT
 * instructions. Devices register port handlers; the CPU calls through here
 * on IN/OUT.
 *
 * The interface has two halves:
 *
 *   - **CPU side**: `inByte` / `inWord` / `outByte` / `outWord`. The CPU's
 *     IN/OUT opcode handlers call these. The four signatures are part of
 *     the CPU's contract and must not change.
 *   - **Device side**: `register` / `unregister`. Devices reserve port
 *     ranges at machine setup; reads and writes to those ports route to
 *     their handlers. A read with no registered handler returns the
 *     "open bus" value (0xFF / 0xFFFF) and writes are silently dropped —
 *     same semantics as the placeholder {@link NullIOBus}.
 *
 * Implementations: {@link NullIOBus} (placeholder; reads return open bus,
 * writes drop, register/unregister throw because there's no registry to
 * write into), and `BasicIOBus` from `../io/io-bus.js` (the real bus with
 * a registry of port-range handlers).
 */
export interface IOBus {
  // ---- CPU side: called by IN/OUT opcode handlers ----
  inByte(port: number): Byte;
  inWord(port: number): Word;
  outByte(port: number, value: Byte): void;
  outWord(port: number, value: Word): void;

  // ---- Device side: called by devices at machine setup ----
  /**
   * Reserve a port range for the given handler. Throws if the range
   * overlaps an already-registered range, or if `range.start` / `range.end`
   * is out of the 0..0xFFFF window or `start > end`.
   */
  register(range: PortRange, handler: PortHandler): void;
  /**
   * Remove a previously-registered handler. Throws if the handler is not
   * currently registered.
   */
  unregister(handler: PortHandler): void;
}

/**
 * Inclusive port range. A single-port handler uses `start === end`.
 *
 * Both bounds are 16-bit unsigned (0..0xFFFF). The bus does not support
 * ranges that wrap past 0xFFFF — split them into two registrations.
 */
export interface PortRange {
  /** Inclusive start port (0..0xFFFF). */
  readonly start: number;
  /** Inclusive end port (0..0xFFFF, must be >= start). */
  readonly end: number;
}

/**
 * A device's port handler. All four methods are optional — a device that
 * only services byte access can omit the word methods, and the bus will
 * fall back to two byte accesses for word reads/writes (see `BasicIOBus`).
 *
 * Conversely a device that only handles writes can omit the read methods,
 * and reads to its ports return open-bus values.
 */
export interface PortHandler {
  readByte?(port: number): Byte;
  readWord?(port: number): Word;
  writeByte?(port: number, value: Byte): void;
  writeWord?(port: number, value: Word): void;
}

/**
 * Placeholder bus. Reads return open-bus values (0xFF/0xFFFF), writes are
 * dropped, and any attempt to `register()` / `unregister()` throws — there
 * is no registry to write into. Use this only for tests and CPU defaults
 * that explicitly want a no-op bus; for anything that wires real devices,
 * use `BasicIOBus` from `../io/io-bus.js`.
 */
export class NullIOBus implements IOBus {
  inByte(_port: number): Byte { return 0xFF; }
  inWord(_port: number): Word { return 0xFFFF; }
  outByte(_port: number, _value: Byte): void { /* drop */ }
  outWord(_port: number, _value: Word): void { /* drop */ }
  register(_range: PortRange, _handler: PortHandler): never {
    throw new Error('NullIOBus has no registry; use BasicIOBus to register port handlers');
  }
  unregister(_handler: PortHandler): never {
    throw new Error('NullIOBus has no registry; use BasicIOBus to register port handlers');
  }
}
