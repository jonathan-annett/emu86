import { describe, expect, it } from 'vitest';
import { BasicIOBus } from '../../src/io/io-bus.js';
import type { PortHandler } from '../../src/core/io.js';

/**
 * Unit tests for the real IOBus. The CPU isn't involved — we drive the bus
 * directly through `inByte` / `outByte` / `inWord` / `outWord` and observe
 * what the registered handler sees.
 */

interface Recorder {
  reads: Array<{ port: number; width: 'byte' | 'word' }>;
  writes: Array<{ port: number; value: number; width: 'byte' | 'word' }>;
}

function makeHandler(opts: {
  readByte?: (port: number) => number;
  readWord?: (port: number) => number;
  writeByte?: boolean;
  writeWord?: boolean;
} = {}): PortHandler & { rec: Recorder } {
  const rec: Recorder = { reads: [], writes: [] };
  const h: PortHandler & { rec: Recorder } = { rec };
  if (opts.readByte) {
    h.readByte = (port: number) => {
      rec.reads.push({ port, width: 'byte' });
      return opts.readByte!(port);
    };
  }
  if (opts.readWord) {
    h.readWord = (port: number) => {
      rec.reads.push({ port, width: 'word' });
      return opts.readWord!(port);
    };
  }
  if (opts.writeByte) {
    h.writeByte = (port: number, value: number) => {
      rec.writes.push({ port, value, width: 'byte' });
    };
  }
  if (opts.writeWord) {
    h.writeWord = (port: number, value: number) => {
      rec.writes.push({ port, value, width: 'word' });
    };
  }
  return h;
}

describe('BasicIOBus — single-port handler', () => {
  it('routes byte read and write to the registered handler', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ readByte: () => 0x5A, writeByte: true });
    bus.register({ start: 0x42, end: 0x42 }, h);

    expect(bus.inByte(0x42)).toBe(0x5A);
    bus.outByte(0x42, 0xCD);
    expect(h.rec.writes).toEqual([{ port: 0x42, value: 0xCD, width: 'byte' }]);
  });

  it('reads outside the single port return open bus (0xFF / 0xFFFF)', () => {
    const bus = new BasicIOBus();
    bus.register({ start: 0x42, end: 0x42 }, makeHandler({ readByte: () => 0x5A }));

    expect(bus.inByte(0x41)).toBe(0xFF);
    expect(bus.inByte(0x43)).toBe(0xFF);
    expect(bus.inWord(0x100)).toBe(0xFFFF);
  });
});

describe('BasicIOBus — port range', () => {
  it('byte read inside the range routes to the handler with the actual port', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ readByte: (p) => p & 0xFF });
    bus.register({ start: 0x300, end: 0x30F }, h);

    expect(bus.inByte(0x300)).toBe(0x00);
    expect(bus.inByte(0x305)).toBe(0x05);
    expect(bus.inByte(0x30F)).toBe(0x0F);
    expect(h.rec.reads.map((r) => r.port)).toEqual([0x300, 0x305, 0x30F]);
  });

  it('reads outside the range return open bus', () => {
    const bus = new BasicIOBus();
    bus.register({ start: 0x300, end: 0x30F }, makeHandler({ readByte: () => 0xAA }));
    expect(bus.inByte(0x2FF)).toBe(0xFF);
    expect(bus.inByte(0x310)).toBe(0xFF);
  });
});

describe('BasicIOBus — word access', () => {
  it('uses readWord when the handler defines it', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ readWord: () => 0xCAFE });
    bus.register({ start: 0x80, end: 0x81 }, h);
    expect(bus.inWord(0x80)).toBe(0xCAFE);
    expect(h.rec.reads).toEqual([{ port: 0x80, width: 'word' }]);
  });

  it('falls back to two byte reads when the handler only defines readByte', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ readByte: (p) => p & 0xFF });
    bus.register({ start: 0x80, end: 0x81 }, h);

    // low byte from port 0x80, high byte from port 0x81
    expect(bus.inWord(0x80)).toBe((0x81 << 8) | 0x80);
    expect(h.rec.reads).toEqual([
      { port: 0x80, width: 'byte' },
      { port: 0x81, width: 'byte' },
    ]);
  });

  it('uses writeWord when the handler defines it', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ writeWord: true });
    bus.register({ start: 0x80, end: 0x81 }, h);
    bus.outWord(0x80, 0xBEEF);
    expect(h.rec.writes).toEqual([{ port: 0x80, value: 0xBEEF, width: 'word' }]);
  });

  it('falls back to two byte writes when the handler only defines writeByte', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ writeByte: true });
    bus.register({ start: 0x80, end: 0x81 }, h);
    bus.outWord(0x80, 0xBEEF);
    expect(h.rec.writes).toEqual([
      { port: 0x80, value: 0xEF, width: 'byte' },
      { port: 0x81, value: 0xBE, width: 'byte' },
    ]);
  });

  it('word read straddling registered handler and unregistered port: high byte is open-bus', () => {
    const bus = new BasicIOBus();
    // Register only port 0x80 as a single-port byte handler returning 0xAB.
    bus.register({ start: 0x80, end: 0x80 }, makeHandler({ readByte: () => 0xAB }));
    // Word read at 0x80: lo = 0xAB (handler), hi = 0xFF (open-bus at 0x81).
    expect(bus.inWord(0x80)).toBe((0xFF << 8) | 0xAB);
  });
});

describe('BasicIOBus — open-bus defaults', () => {
  it('byte read on unregistered port returns 0xFF', () => {
    const bus = new BasicIOBus();
    expect(bus.inByte(0x1234)).toBe(0xFF);
  });

  it('word read on unregistered port returns 0xFFFF', () => {
    const bus = new BasicIOBus();
    expect(bus.inWord(0x1234)).toBe(0xFFFF);
  });

  it('byte and word writes on unregistered ports are silently dropped', () => {
    const bus = new BasicIOBus();
    expect(() => bus.outByte(0x1234, 0xAA)).not.toThrow();
    expect(() => bus.outWord(0x1234, 0xBBCC)).not.toThrow();
  });

  it('write to a port whose handler defines only readByte is silently dropped', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ readByte: () => 0x11 });
    bus.register({ start: 0x40, end: 0x40 }, h);
    bus.outByte(0x40, 0x99);
    expect(h.rec.writes).toEqual([]);
  });

  it('read from a port whose handler defines only writeByte returns open bus', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ writeByte: true });
    bus.register({ start: 0x40, end: 0x40 }, h);
    expect(bus.inByte(0x40)).toBe(0xFF);
  });
});

describe('BasicIOBus — registration policy', () => {
  it('overlapping registration throws (exact same range)', () => {
    const bus = new BasicIOBus();
    bus.register({ start: 0x80, end: 0x8F }, makeHandler({ readByte: () => 0 }));
    expect(() => bus.register({ start: 0x80, end: 0x8F }, makeHandler({ readByte: () => 0 })))
      .toThrow(/overlap/i);
  });

  it('overlapping registration throws (right edge)', () => {
    const bus = new BasicIOBus();
    bus.register({ start: 0x80, end: 0x8F }, makeHandler({ readByte: () => 0 }));
    expect(() => bus.register({ start: 0x8F, end: 0x90 }, makeHandler({ readByte: () => 0 })))
      .toThrow(/overlap/i);
  });

  it('overlapping registration throws (left edge)', () => {
    const bus = new BasicIOBus();
    bus.register({ start: 0x80, end: 0x8F }, makeHandler({ readByte: () => 0 }));
    expect(() => bus.register({ start: 0x70, end: 0x80 }, makeHandler({ readByte: () => 0 })))
      .toThrow(/overlap/i);
  });

  it('adjacent (non-overlapping) ranges are allowed', () => {
    const bus = new BasicIOBus();
    const a = makeHandler({ readByte: () => 0xAA });
    const b = makeHandler({ readByte: () => 0xBB });
    bus.register({ start: 0x80, end: 0x8F }, a);
    bus.register({ start: 0x90, end: 0x9F }, b);
    expect(bus.inByte(0x8F)).toBe(0xAA);
    expect(bus.inByte(0x90)).toBe(0xBB);
  });

  it('rejects ranges with start > end', () => {
    const bus = new BasicIOBus();
    expect(() => bus.register({ start: 0x40, end: 0x30 }, makeHandler()))
      .toThrow(/start.*<= end/i);
  });

  it('rejects ranges outside 0..0xFFFF', () => {
    const bus = new BasicIOBus();
    expect(() => bus.register({ start: -1, end: 0 }, makeHandler())).toThrow(/bounds/i);
    expect(() => bus.register({ start: 0, end: 0x10000 }, makeHandler())).toThrow(/bounds/i);
  });

  it('rejects non-integer bounds', () => {
    const bus = new BasicIOBus();
    expect(() => bus.register({ start: 1.5, end: 2 }, makeHandler())).toThrow(/integer/i);
  });
});

describe('BasicIOBus — unregister', () => {
  it('removes a handler so subsequent reads return open bus', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ readByte: () => 0x5A });
    bus.register({ start: 0x42, end: 0x42 }, h);
    expect(bus.inByte(0x42)).toBe(0x5A);
    bus.unregister(h);
    expect(bus.inByte(0x42)).toBe(0xFF);
  });

  it('throws when given a handler not registered on this bus', () => {
    const bus = new BasicIOBus();
    const h = makeHandler({ readByte: () => 0 });
    expect(() => bus.unregister(h)).toThrow(/not currently registered/i);
  });

  it('after unregister the freed range can be re-registered without conflict', () => {
    const bus = new BasicIOBus();
    const a = makeHandler({ readByte: () => 0xAA });
    const b = makeHandler({ readByte: () => 0xBB });
    bus.register({ start: 0x80, end: 0x8F }, a);
    bus.unregister(a);
    bus.register({ start: 0x80, end: 0x8F }, b);
    expect(bus.inByte(0x80)).toBe(0xBB);
  });
});
