/**
 * Phase 18 field fix #5 — sticky terminal modes across restore.
 *
 * The restored screen replays the last ~48 KiB of raw serial TX through
 * xterm (main.ts), which reproduces everything the tail CONTAINS — but a
 * terminal mode set once, before the tail window, is invisible to the
 * replay: term.reset() puts it back to its default and nothing in the
 * tail corrects it. Field case (Jonathan, 2026-07-17): invaders hides
 * the cursor with `ESC[?25l` at startup; seconds of redraw traffic
 * later the sequence has scrolled out of the 48 KiB tail, and the
 * resumed game plays a fat cursor riding every bullet.
 *
 * This tracker watches the same TX stream the tail is cut from and
 * remembers the final h/l state of the DEC private modes that are both
 * sticky (nothing in a game's redraw loop re-sends them) and
 * side-effect-free to re-assert (setting them again moves no cursor and
 * clears no screen): DECCKM (?1, application cursor keys), DECAWM (?7,
 * autowrap), DECTCEM (?25, cursor visibility). Deliberately NOT
 * tracked: the alternate screen (?47/?1047/?1049 — re-entering clears
 * it) and origin mode (?6 — set/reset homes the cursor), both of which
 * would fight the just-replayed screen; nothing on the ELKS serial
 * console emits them today.
 *
 * The parser is incremental — TX arrives in whatever chunks the worker
 * posts, so a sequence can split anywhere, including mid-parameter.
 * Scope: ESC [ ... sequences only (no 8-bit 0x9B CSI, no OSC payload
 * awareness); the ELKS serial console emits neither.
 */

const TRACKED_MODES: readonly number[] = [1, 7, 25];

/** One tracked mode's final state: `set` true = `h`, false = `l`. */
export interface TxModeState {
  mode: number;
  set: boolean;
}

const enum ParseState {
  Ground,
  Esc, // saw ESC
  Csi, // saw ESC [ — collecting parameter/intermediate bytes
}

export class TxModeTracker {
  private modes = new Map<number, boolean>();
  private state = ParseState.Ground;
  private params = '';

  feed(bytes: Uint8Array): void {
    for (const b of bytes) {
      switch (this.state) {
        case ParseState.Ground:
          if (b === 0x1b) this.state = ParseState.Esc;
          break;
        case ParseState.Esc:
          if (b === 0x5b /* [ */) {
            this.state = ParseState.Csi;
            this.params = '';
          } else if (b !== 0x1b) {
            // Some other escape (charset, keypad, OSC…) — not ours.
            this.state = ParseState.Ground;
          }
          break;
        case ParseState.Csi:
          if (b >= 0x40 && b <= 0x7e) {
            // Final byte terminates the sequence.
            this.finishCsi(b);
            this.state = ParseState.Ground;
          } else if (b >= 0x20 && b <= 0x3f) {
            // Parameter/intermediate bytes. Cap the buffer so a
            // degenerate stream can't grow it without bound.
            if (this.params.length < 64) this.params += String.fromCharCode(b);
          } else if (b === 0x1b) {
            this.state = ParseState.Esc; // restart — aborted sequence
          } else if (b === 0x18 || b === 0x1a) {
            this.state = ParseState.Ground; // CAN/SUB abort
          }
          // Other C0 controls execute inside a CSI sequence without
          // cancelling it (xterm semantics) — ignore and keep parsing.
          break;
      }
    }
  }

  private finishCsi(finalByte: number): void {
    if (finalByte !== 0x68 /* h */ && finalByte !== 0x6c /* l */) return;
    if (!this.params.startsWith('?')) return;
    const set = finalByte === 0x68;
    for (const p of this.params.slice(1).split(';')) {
      if (!/^\d+$/.test(p)) continue;
      const mode = Number(p);
      if (TRACKED_MODES.includes(mode)) this.modes.set(mode, set);
    }
  }

  /** The final observed state of every tracked mode the stream touched. */
  snapshot(): TxModeState[] {
    return [...this.modes.entries()].map(([mode, set]) => ({ mode, set }));
  }

  /** Replace the tracked state wholesale (after a restore replay). */
  seed(modes: readonly TxModeState[]): void {
    this.modes = new Map(modes.map((m) => [m.mode, m.set]));
    this.state = ParseState.Ground;
    this.params = '';
  }
}

/** The escape sequence that re-asserts a captured mode snapshot. */
export function modeSequence(modes: readonly TxModeState[]): string {
  return modes.map((m) => `\x1b[?${m.mode}${m.set ? 'h' : 'l'}`).join('');
}
