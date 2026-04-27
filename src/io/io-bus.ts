import type { Byte, Word } from '../core/types.js';
import type { IOBus, PortHandler, PortRange } from '../core/io.js';

/**
 * Real IOBus with port-handler registration.
 *
 * Storage strategy: a single sorted array of `{range, handler}` entries,
 * kept sorted by `range.start`. For the device counts we expect
 * (a handful per machine — PIC, PIT, keyboard, maybe a video controller)
 * a linear scan on every CPU IN/OUT is well below the cost of the
 * surrounding fetch/dispatch. We could binary-search if profiling later
 * shows the scan dominating, but until then simpler is better.
 *
 * Behavioural rules (see brief):
 *
 *   - Read with no handler covering the port: return 0xFF (byte) or
 *     0xFFFF (word), matching `NullIOBus` open-bus semantics.
 *   - Write with no handler: silently drop.
 *   - Word access at a port whose handler defines the word method: call
 *     the word method directly.
 *   - Word access at a port whose handler defines only the byte method:
 *     fall back to two byte accesses at `port` and `port+1`. Each byte
 *     is routed independently through the bus, so the high byte may go
 *     to a different handler (or to open-bus) than the low byte. This
 *     mirrors the real hardware behaviour where word I/O is two bus
 *     cycles and a "word port" doesn't exist at the bus level.
 *   - Overlapping registrations throw on `register()`. Two devices
 *     claiming the same port is a configuration bug and we want it
 *     loud, not silent.
 *   - Unregistering a handler that isn't currently registered throws.
 *     Symmetric with the overlap check: handler bookkeeping mistakes
 *     should fail loudly.
 */
interface Entry {
  range: PortRange;
  handler: PortHandler;
}

export class BasicIOBus implements IOBus {
  private readonly entries: Entry[] = [];

  // ---------------- CPU side ----------------

  inByte(port: number): Byte {
    const e = this.find(port);
    if (!e || !e.handler.readByte) return 0xFF;
    return e.handler.readByte(port) & 0xFF;
  }

  inWord(port: number): Word {
    const e = this.find(port);
    if (e?.handler.readWord) {
      return e.handler.readWord(port) & 0xFFFF;
    }
    // Word access without a word handler: split into two byte reads. Each
    // byte routes independently — the high byte may land on a different
    // handler or on open-bus.
    const lo = this.inByte(port);
    const hi = this.inByte((port + 1) & 0xFFFF);
    return ((hi << 8) | lo) & 0xFFFF;
  }

  outByte(port: number, value: Byte): void {
    const e = this.find(port);
    if (!e || !e.handler.writeByte) return; // open-bus: drop
    e.handler.writeByte(port, value & 0xFF);
  }

  outWord(port: number, value: Word): void {
    const e = this.find(port);
    if (e?.handler.writeWord) {
      e.handler.writeWord(port, value & 0xFFFF);
      return;
    }
    // Split into two byte writes; each routes independently.
    this.outByte(port, value & 0xFF);
    this.outByte((port + 1) & 0xFFFF, (value >> 8) & 0xFF);
  }

  // ---------------- Device side ----------------

  register(range: PortRange, handler: PortHandler): void {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
      throw new Error(`PortRange bounds must be integers (got start=${range.start}, end=${range.end})`);
    }
    if (range.start < 0 || range.end > 0xFFFF) {
      throw new Error(`PortRange out of bounds [${range.start}, ${range.end}]; must lie within 0..0xFFFF`);
    }
    if (range.start > range.end) {
      throw new Error(`PortRange.start (${range.start}) must be <= end (${range.end})`);
    }
    // Find insertion point and verify no overlap with neighbours. Cheap
    // because `entries` is small.
    let i = 0;
    while (i < this.entries.length) {
      const cur = this.entries[i];
      if (!cur || cur.range.start >= range.start) break;
      i++;
    }
    const prev = i > 0 ? this.entries[i - 1] : undefined;
    const next = i < this.entries.length ? this.entries[i] : undefined;
    if (prev && prev.range.end >= range.start) {
      throw new Error(
        `Port range [0x${hex(range.start)}..0x${hex(range.end)}] overlaps existing ` +
        `[0x${hex(prev.range.start)}..0x${hex(prev.range.end)}]`,
      );
    }
    if (next && next.range.start <= range.end) {
      throw new Error(
        `Port range [0x${hex(range.start)}..0x${hex(range.end)}] overlaps existing ` +
        `[0x${hex(next.range.start)}..0x${hex(next.range.end)}]`,
      );
    }
    this.entries.splice(i, 0, { range, handler });
  }

  unregister(handler: PortHandler): void {
    const i = this.entries.findIndex((e) => e.handler === handler);
    if (i < 0) {
      throw new Error('unregister(): handler is not currently registered on this bus');
    }
    this.entries.splice(i, 1);
  }

  // ---------------- Internals ----------------

  /** Linear scan for the entry covering `port`, or undefined. */
  private find(port: number): Entry | undefined {
    for (const e of this.entries) {
      if (port < e.range.start) return undefined; // sorted: no later entry can match
      if (port <= e.range.end) return e;
    }
    return undefined;
  }
}

function hex(n: number): string {
  return n.toString(16).toUpperCase();
}
