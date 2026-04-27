import { describe, expect, it } from 'vitest';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import {
  CapturingCGASink,
  CGA_TEXT_BASE,
  CGA_TEXT_COLS,
  CLEAR_AND_HOME,
  OneShotPrefixSink,
  installCGAMirror,
} from '../../src/diagnostics/cga-mirror.js';

/**
 * Unit tests for the CGA-mirror diagnostic overlay.
 *
 * The mirror watches writes to 0xB8000-0xBFFFF, computes (row, col)
 * from each even-offset write address, and emits an ANSI cursor-position
 * prefix `ESC [ row+1 ; col+1 H` followed by the character byte. Odd
 * offsets (attribute bytes) are skipped. Consecutive writes at
 * (row, col+1) skip the positioning prefix — the host terminal cursor
 * is already there from the previous emit.
 *
 * Tests below cover:
 *
 *   - Position prefix at the corners of an 80x25 page (cell (0,0),
 *     (5,10), (24,79)).
 *   - The run-length optimisation (consecutive col, col+1 writes).
 *   - Word writes deliver one character per cell (low byte = char,
 *     high byte = attribute and ignored).
 *   - Writes outside the framebuffer range never reach the sink.
 *   - Tear-down restores the original `writeByte` so a test may
 *     install/remove cleanly across cases.
 *   - The `OneShotPrefixSink` wrapper emits its prefix exactly once
 *     on the first forwarded `writeChar`.
 *
 * Each test constructs a fresh `IBMPCMachine` with `loadBios: false` so
 * we don't depend on the BIOS ROM being installed at 0xF0000 (the mirror
 * lives below 0xC0000 so the BIOS region is irrelevant, but skipping
 * the ROM install is a strict-typing-friendly minimum config).
 */

/** Build the byte sequence for `ESC [ row ; col H` plus the character. */
function posPrefixThen(row: number, col: number, ch: string): string {
  return `\x1B[${row};${col}H${ch}`;
}

describe('CGA mirror — character emission with position prefix', () => {
  it('writeByte at cell (0,0) emits ESC [ 1 ; 1 H then the character', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });

    m.memory.writeByte(CGA_TEXT_BASE, 'H'.charCodeAt(0));

    expect(sink.text).toBe(posPrefixThen(1, 1, 'H'));
    teardown();
  });

  it('writeByte at cell (5,10) emits ESC [ 6 ; 11 H then the character', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });

    const offset = (5 * CGA_TEXT_COLS + 10) * 2;
    m.memory.writeByte(CGA_TEXT_BASE + offset, 'X'.charCodeAt(0));

    expect(sink.text).toBe(posPrefixThen(6, 11, 'X'));
    teardown();
  });

  it('writeByte at cell (24,79) emits ESC [ 25 ; 80 H then the character', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });

    const offset = (24 * CGA_TEXT_COLS + 79) * 2;
    m.memory.writeByte(CGA_TEXT_BASE + offset, '!'.charCodeAt(0));

    expect(sink.text).toBe(posPrefixThen(25, 80, '!'));
    teardown();
  });

  it('writeByte at odd (attribute) offsets is filtered out', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });

    m.memory.writeByte(CGA_TEXT_BASE, 'X'.charCodeAt(0));
    m.memory.writeByte(CGA_TEXT_BASE + 1, 0x07);          // attr (white on black)
    m.memory.writeByte(CGA_TEXT_BASE + 3, 0x70);          // attr (black on white)

    // Only the X is emitted (with its position prefix); the two attribute
    // writes produce nothing.
    expect(sink.text).toBe(posPrefixThen(1, 1, 'X'));
    teardown();
  });

  it('writeWord delivers low byte (char) and skips the high byte (attribute)', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });

    // 'A' with attribute 0x07: low='A' (0x41), high=0x07. 'B' at +2.
    // The two writes are at consecutive cells (0,0) and (0,1) — the
    // run-length optimisation should suppress the prefix on the second.
    m.memory.writeWord(CGA_TEXT_BASE, 0x0741);
    m.memory.writeWord(CGA_TEXT_BASE + 2, 0x0742);

    expect(sink.text).toBe(`${posPrefixThen(1, 1, 'A')}B`);
    teardown();
  });

  it('writes outside 0xB8000-0xBFFFF never reach the sink', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });

    m.memory.writeByte(0xB7FFE, 'A'.charCodeAt(0));        // before
    m.memory.writeByte(0xC0000, 'B'.charCodeAt(0));        // after
    m.memory.writeByte(0x10000, 'C'.charCodeAt(0));        // far below
    m.memory.writeByte(CGA_TEXT_BASE, 'D'.charCodeAt(0));  // inside

    expect(sink.text).toBe(posPrefixThen(1, 1, 'D'));
    teardown();
  });

  it('tear-down restores the original writeByte', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });

    m.memory.writeByte(CGA_TEXT_BASE, 'X'.charCodeAt(0));
    expect(sink.text).toBe(posPrefixThen(1, 1, 'X'));

    teardown();
    sink.clear();
    m.memory.writeByte(CGA_TEXT_BASE, 'Y'.charCodeAt(0));
    expect(sink.text).toBe('');                            // mirror gone
    expect(m.memory.readByte(CGA_TEXT_BASE)).toBe('Y'.charCodeAt(0));
  });

  it('tear-down callback is idempotent', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });
    teardown();
    teardown();                                            // must not throw
  });
});

describe('CGA mirror — run-length optimisation', () => {
  it('two consecutive writes at (5,10) and (5,11) emit positioning only for the first', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    installCGAMirror(m, { sink });

    const off10 = (5 * CGA_TEXT_COLS + 10) * 2;
    const off11 = (5 * CGA_TEXT_COLS + 11) * 2;
    m.memory.writeByte(CGA_TEXT_BASE + off10, 'A'.charCodeAt(0));
    m.memory.writeByte(CGA_TEXT_BASE + off11, 'B'.charCodeAt(0));

    expect(sink.text).toBe(`${posPrefixThen(6, 11, 'A')}B`);
  });

  it('two writes at (5,10) and (7,3) emit positioning for both (rows differ)', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    installCGAMirror(m, { sink });

    const offA = (5 * CGA_TEXT_COLS + 10) * 2;
    const offB = (7 * CGA_TEXT_COLS + 3) * 2;
    m.memory.writeByte(CGA_TEXT_BASE + offA, 'A'.charCodeAt(0));
    m.memory.writeByte(CGA_TEXT_BASE + offB, 'B'.charCodeAt(0));

    expect(sink.text).toBe(
      `${posPrefixThen(6, 11, 'A')}${posPrefixThen(8, 4, 'B')}`,
    );
  });

  it('non-adjacent same-row writes (gap) emit positioning for the second too', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    installCGAMirror(m, { sink });

    const offA = (3 * CGA_TEXT_COLS + 10) * 2;
    const offB = (3 * CGA_TEXT_COLS + 12) * 2;             // skips col 11
    m.memory.writeByte(CGA_TEXT_BASE + offA, 'A'.charCodeAt(0));
    m.memory.writeByte(CGA_TEXT_BASE + offB, 'B'.charCodeAt(0));

    expect(sink.text).toBe(
      `${posPrefixThen(4, 11, 'A')}${posPrefixThen(4, 13, 'B')}`,
    );
  });

  it('a sequential row of writes emits positioning once at the start', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const sink = new CapturingCGASink();
    installCGAMirror(m, { sink });

    const msg = 'Hello, ELKS!';
    for (let i = 0; i < msg.length; i++) {
      m.memory.writeByte(CGA_TEXT_BASE + i * 2, msg.charCodeAt(i));
      m.memory.writeByte(CGA_TEXT_BASE + i * 2 + 1, 0x07);    // attr
    }
    expect(sink.text).toBe(`${posPrefixThen(1, 1, '')}${msg}`);
  });
});

describe('OneShotPrefixSink', () => {
  it('emits the prefix exactly once on the first forwarded writeChar', () => {
    const inner = new CapturingCGASink();
    const wrapped = new OneShotPrefixSink(inner, CLEAR_AND_HOME);

    wrapped.writeChar('X'.charCodeAt(0));
    wrapped.writeChar('Y'.charCodeAt(0));
    wrapped.writeChar('Z'.charCodeAt(0));

    // CLEAR_AND_HOME is ESC [ 2 J ESC [ H, then XYZ.
    expect(inner.text).toBe('\x1B[2J\x1B[HXYZ');
  });

  it('the prefix does not fire if the wrapped sink never receives a write', () => {
    const inner = new CapturingCGASink();
    new OneShotPrefixSink(inner, CLEAR_AND_HOME);
    expect(inner.text).toBe('');                           // nothing emitted
  });

  it('forwards every byte (including bytes inside the prefix range) verbatim', () => {
    const inner = new CapturingCGASink();
    const wrapped = new OneShotPrefixSink(inner, [0x41]);   // prefix = "A"
    wrapped.writeChar(0x42);                                // "B"
    wrapped.writeChar(0x43);                                // "C"
    expect(inner.text).toBe('ABC');
  });

  it('end-to-end: harness-style wrapping inserts the clear before the first character', () => {
    const m = new IBMPCMachine({ loadBios: false });
    const inner = new CapturingCGASink();
    const wrapped = new OneShotPrefixSink(inner, CLEAR_AND_HOME);
    installCGAMirror(m, { sink: wrapped });

    m.memory.writeByte(CGA_TEXT_BASE, 'H'.charCodeAt(0));
    m.memory.writeByte(CGA_TEXT_BASE + 2, 'i'.charCodeAt(0));

    // Boundary clear, then position to (1,1), then 'H', then 'i' (no
    // re-position because (1,1) → (1,2) is consecutive).
    expect(inner.text).toBe(`\x1B[2J\x1B[H${posPrefixThen(1, 1, 'H')}i`);
  });
});
