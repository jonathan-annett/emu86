/**
 * The debug trace (field ask 2026-07-17) — injected-channel tests:
 * message shape, identity flow, and the one hard rule (tracing must
 * never break the machine it narrates).
 */

import { describe, expect, it } from 'vitest';
import { createDebugTrace, type DebugTraceMsg } from '../../web/debug-log.js';

describe('createDebugTrace', () => {
  it('posts the trace shape, carrying identity once set', () => {
    const posted: DebugTraceMsg[] = [];
    const trace = createDebugTrace('pc-1', {
      postMessage: (d) => posted.push(d as DebugTraceMsg),
    });
    trace('booting');
    trace.setIdentity(16, 'mouse');
    trace('frozen for cat');
    expect(posted).toEqual([
      { dbg: 'trace', octet: null, name: null, pc: 'pc-1', text: 'booting' },
      { dbg: 'trace', octet: 16, name: 'mouse', pc: 'pc-1', text: 'frozen for cat' },
    ]);
  });

  it('defaults to a standalone (null pc) sender', () => {
    const posted: DebugTraceMsg[] = [];
    const trace = createDebugTrace(null, {
      postMessage: (d) => posted.push(d as DebugTraceMsg),
    });
    trace('hello');
    expect(posted[0]?.pc).toBeNull();
  });

  it('never throws — not on a dead channel, not on a broken one', () => {
    const silent = createDebugTrace('pc-1', null); // no channel at all
    expect(() => silent('into the void')).not.toThrow();
    const broken = createDebugTrace('pc-1', {
      postMessage: () => {
        throw new Error('channel detached');
      },
    });
    expect(() => broken('still fine')).not.toThrow();
  });
});
