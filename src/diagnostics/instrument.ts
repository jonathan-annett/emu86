/**
 * Runtime instrumentation that wires a {@link Tracer} to the IO bus and
 * memory of an existing machine. Method-replacement is used (a bound
 * reference to the original is captured, the slot is reassigned to a
 * recorder/forwarder) so that:
 *
 *   - No CPU8086 / PagedMemory / BasicIOBus source is touched.
 *   - The CPU continues to call its `memory` / `io` references unchanged.
 *   - Tear-down restores the original method bindings, which lets the same
 *     machine be re-used after a traced run if a caller ever needs that
 *     (tests typically construct a fresh machine per assertion, but the
 *     symmetric tear-down is cheap insurance against state leaks).
 *
 * Method-replacement is the only form of reaching into the locked layers
 * we do — and it's a diagnostic-tool concern, not an architecture change,
 * which is exactly the carve-out the brief allows.
 */

import type { IBMPCMachine } from '../machine/ibm-pc.js';
import type { Tracer } from './tracer.js';

export interface InstrumentOptions {
  tracer: Tracer;
  /**
   * Wire IO-bus tracing. Default `true`. The bus is wrapped on its CPU-side
   * methods (in/out byte/word). Device-side `register()` / `unregister()` are
   * untouched — wrapping those isn't useful for boot tracing.
   */
  traceIo?: boolean;
  /**
   * Wire memory-write tracing. Default `true` if the tracer has any
   * `memWriteRanges` configured, otherwise effectively a no-op (the
   * recorder is still installed but every write tests as out-of-range).
   */
  traceMemWrites?: boolean;
}

/**
 * Install method wrappers; returns a tear-down function that restores the
 * originals. Calling the tear-down twice is safe — it's a one-shot
 * remove-references operation.
 */
export function instrumentMachine(
  machine: IBMPCMachine,
  opts: InstrumentOptions,
): () => void {
  const { tracer } = opts;
  const restorers: Array<() => void> = [];

  if (opts.traceIo !== false && tracer.enabled('io')) {
    const bus = machine.bus;
    // Capture the originals as bound references; the wrapper then forwards.
    const origInByte = bus.inByte.bind(bus);
    const origInWord = bus.inWord.bind(bus);
    const origOutByte = bus.outByte.bind(bus);
    const origOutWord = bus.outWord.bind(bus);
    bus.inByte = (port: number) => {
      const v = origInByte(port);
      tracer.record({ type: 'io', dir: 'in', size: 'b', port, value: v });
      return v;
    };
    bus.inWord = (port: number) => {
      const v = origInWord(port);
      tracer.record({ type: 'io', dir: 'in', size: 'w', port, value: v });
      return v;
    };
    bus.outByte = (port: number, value: number) => {
      tracer.record({ type: 'io', dir: 'out', size: 'b', port, value: value & 0xFF });
      origOutByte(port, value);
    };
    bus.outWord = (port: number, value: number) => {
      tracer.record({ type: 'io', dir: 'out', size: 'w', port, value: value & 0xFFFF });
      origOutWord(port, value);
    };
    restorers.push(() => {
      bus.inByte = origInByte;
      bus.inWord = origInWord;
      bus.outByte = origOutByte;
      bus.outWord = origOutWord;
    });
  }

  if (
    opts.traceMemWrites !== false &&
    tracer.enabled('memWrite') &&
    tracer.memWriteRanges.length > 0
  ) {
    const mem = machine.memory;
    const origWriteByte = mem.writeByte.bind(mem);
    const origWriteWord = mem.writeWord.bind(mem);
    mem.writeByte = (addr: number, v: number) => {
      origWriteByte(addr, v);
      // After the write so the recorded value reflects what's actually in
      // memory (ROM regions silently drop, but our ranges are RAM in
      // practice — video memory, BDA, IVT, boot sector area).
      if (tracer.inMemWriteRange(addr)) {
        tracer.record({ type: 'memWrite', addr, value: v & 0xFF, size: 'b' });
      }
    };
    mem.writeWord = (addr: number, v: number) => {
      origWriteWord(addr, v);
      // Word writes record once per word if either byte falls in a range.
      if (tracer.inMemWriteRange(addr) || tracer.inMemWriteRange(addr + 1)) {
        tracer.record({ type: 'memWrite', addr, value: v & 0xFFFF, size: 'w' });
      }
    };
    restorers.push(() => {
      mem.writeByte = origWriteByte;
      mem.writeWord = origWriteWord;
    });
  }

  let torn = false;
  return () => {
    if (torn) return;
    torn = true;
    for (const r of restorers) r();
  };
}
