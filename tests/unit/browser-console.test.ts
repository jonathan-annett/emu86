/**
 * Unit tests for `BrowserConsole`.
 *
 * The class is small (writeChar → sink, readChar/hasInput → queue) so the
 * tests stay narrow:
 *   - sink receives writeChar bytes in order;
 *   - injectInput populates the queue and readChar drains it;
 *   - bytes are masked to 8 bits.
 */

import { describe, it, expect } from 'vitest';
import { BrowserConsole } from '../../src/browser/browser-console.js';

describe('BrowserConsole', () => {
  it('forwards writeChar bytes to the configured sink', () => {
    const captured: number[] = [];
    const c = new BrowserConsole({ txSink: (b) => captured.push(b) });
    for (const ch of 'hi') c.writeChar(ch.charCodeAt(0));
    expect(captured).toEqual([0x68, 0x69]);
  });

  it('masks writeChar to 8 bits', () => {
    const captured: number[] = [];
    const c = new BrowserConsole({ txSink: (b) => captured.push(b) });
    c.writeChar(0x141);                       // > 255
    c.writeChar(-1);                          // negative
    expect(captured).toEqual([0x41, 0xFF]);
  });

  it('queues injected input and drains via readChar', () => {
    const c = new BrowserConsole({ txSink: () => undefined });
    expect(c.hasInput()).toBe(false);
    c.injectInput(new Uint8Array([0x65, 0x63, 0x68, 0x6f]));
    expect(c.hasInput()).toBe(true);
    expect(c.readChar()).toBe(0x65);
    expect(c.readChar()).toBe(0x63);
    expect(c.readChar()).toBe(0x68);
    expect(c.readChar()).toBe(0x6f);
    expect(c.hasInput()).toBe(false);
    expect(c.readChar()).toBe(-1);
  });

  it('accepts plain number arrays as injected input', () => {
    const c = new BrowserConsole({ txSink: () => undefined });
    c.injectInput([0x41, 0x42, 0x43]);
    expect(c.readChar()).toBe(0x41);
    expect(c.readChar()).toBe(0x42);
    expect(c.readChar()).toBe(0x43);
  });

  it('masks injected input to 8 bits', () => {
    const c = new BrowserConsole({ txSink: () => undefined });
    c.injectInput([0x141, -1]);
    expect(c.readChar()).toBe(0x41);
    expect(c.readChar()).toBe(0xFF);
  });
});
