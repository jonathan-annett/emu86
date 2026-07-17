/**
 * TxModeTracker unit tests (Phase 18 field fix #5 — sticky terminal
 * modes across restore).
 *
 * Pure bytes-in/state-out: feed simulated guest TX, assert which DEC
 * private modes the tracker remembers. The field case: invaders hides
 * the cursor (`ESC[?25l`) once at startup, then emits far more than the
 * 48 KiB tail cap of redraw traffic — the tracker, not the tail, must
 * carry the hidden cursor across a restore.
 */

import { describe, it, expect } from 'vitest';
import { modeSequence, TxModeTracker } from '../../web/tx-modes.js';

const enc = new TextEncoder();

function fed(...chunks: string[]): TxModeTracker {
  const tracker = new TxModeTracker();
  for (const chunk of chunks) tracker.feed(enc.encode(chunk));
  return tracker;
}

describe('TxModeTracker', () => {
  it('remembers a hidden cursor (the invaders case)', () => {
    const tracker = fed('\x1b[2J\x1b[?25l\x1b[5;10H*');
    expect(tracker.snapshot()).toEqual([{ mode: 25, set: false }]);
  });

  it('keeps only the final state when a mode toggles', () => {
    const tracker = fed('\x1b[?25l', 'redraw redraw', '\x1b[?25h');
    expect(tracker.snapshot()).toEqual([{ mode: 25, set: true }]);
  });

  it('parses sequences split at every possible chunk boundary', () => {
    const seq = 'text\x1b[?25lmore';
    for (let cut = 1; cut < seq.length; cut++) {
      const tracker = fed(seq.slice(0, cut), seq.slice(cut));
      expect(tracker.snapshot()).toEqual([{ mode: 25, set: false }]);
    }
  });

  it('survives byte-at-a-time delivery', () => {
    const tracker = fed(...'\x1b[?1h\x1b[?7l'.split(''));
    expect(tracker.snapshot()).toEqual([
      { mode: 1, set: true },
      { mode: 7, set: false },
    ]);
  });

  it('handles multiple parameters in one sequence', () => {
    const tracker = fed('\x1b[?1;25h');
    expect(tracker.snapshot()).toEqual([
      { mode: 1, set: true },
      { mode: 25, set: true },
    ]);
  });

  it('ignores untracked private modes (alt screen stays hands-off)', () => {
    const tracker = fed('\x1b[?1049h\x1b[?6h\x1b[?1000h');
    expect(tracker.snapshot()).toEqual([]);
  });

  it('ignores non-private CSI with the same numbers', () => {
    // `CSI 25 l` (RM, no `?`) is not DECTCEM; nor are SGR/movement.
    const tracker = fed('\x1b[25l\x1b[25;1H\x1b[1;25m');
    expect(tracker.snapshot()).toEqual([]);
  });

  it('is not fooled by plain text containing ?25l', () => {
    const tracker = fed('the string ?25l and [?25l appear in prose');
    expect(tracker.snapshot()).toEqual([]);
  });

  it('lets C0 controls execute inside a sequence without cancelling it', () => {
    // xterm semantics: a stray CR/LF inside CSI is executed, parsing continues.
    const tracker = fed('\x1b[?2\r\n5l');
    expect(tracker.snapshot()).toEqual([{ mode: 25, set: false }]);
  });

  it('aborts on CAN and on a restarting ESC', () => {
    const canceled = fed('\x1b[?25\x18l'); // CAN kills the sequence; `l` is text
    expect(canceled.snapshot()).toEqual([]);
    const restarted = fed('\x1b[?25\x1b[?7hl'); // ESC restarts mid-sequence
    expect(restarted.snapshot()).toEqual([{ mode: 7, set: true }]);
  });

  it('seed replaces the tracked state wholesale', () => {
    const tracker = fed('\x1b[?25h');
    tracker.seed([{ mode: 25, set: false }, { mode: 1, set: true }]);
    expect(tracker.snapshot()).toEqual([
      { mode: 25, set: false },
      { mode: 1, set: true },
    ]);
  });

  it('round-trips through modeSequence', () => {
    const original = fed('\x1b[?25l\x1b[?1h');
    const replayed = new TxModeTracker();
    replayed.feed(enc.encode(modeSequence(original.snapshot())));
    expect(replayed.snapshot()).toEqual(original.snapshot());
  });

  it('modeSequence emits the exact xterm escapes', () => {
    expect(modeSequence([{ mode: 25, set: false }, { mode: 1, set: true }]))
      .toBe('\x1b[?25l\x1b[?1h');
    expect(modeSequence([])).toBe('');
  });
});
