import { describe, expect, it } from 'vitest';
import {
  ScancodeTranslator,
  translateByte,
} from '../../src/console/scancode-translator.js';

/**
 * Unit tests for the host-stdin → PC/AT scancode set 1 translator.
 *
 * The shape of the translator is "byte → list of scancodes". A handful
 * of bytes need careful verification:
 *
 *   - Backspace: terminals send 0x7F (DEL), some send 0x08; both map to
 *     scancode 0x0E (set 1 BACKSPACE).
 *   - Enter: stdin gives 0x0A (LF) on Linux, 0x0D (CR) on Mac/raw mode;
 *     both map to scancode 0x1C.
 *   - Ctrl-letter combos must wrap the letter scancode in Ctrl-down /
 *     Ctrl-up so ELKS's keyboard_irq can pick CTRL out of ModeState.
 *   - Shifted symbols (uppercase, digit-row symbols) must wrap in
 *     Shift-down / Shift-up.
 *   - Multi-byte stdin sequences should produce ordered scancodes.
 */

describe('translateByte: ASCII printables', () => {
  it("'a' produces press + release", () => {
    expect(translateByte(0x61)).toEqual([0x1E, 0x9E]);
  });

  it("'1' produces press + release", () => {
    expect(translateByte(0x31)).toEqual([0x02, 0x82]);
  });

  it("' ' (space) produces press + release", () => {
    expect(translateByte(0x20)).toEqual([0x39, 0xB9]);
  });
});

describe('translateByte: control bytes', () => {
  it('0x7F (DEL) → backspace press + release', () => {
    expect(translateByte(0x7F)).toEqual([0x0E, 0x8E]);
  });

  it('0x08 (BS) → backspace press + release', () => {
    expect(translateByte(0x08)).toEqual([0x0E, 0x8E]);
  });

  it('0x09 (TAB) → tab scancode', () => {
    expect(translateByte(0x09)).toEqual([0x0F, 0x8F]);
  });

  it('0x0A (LF) → enter scancode', () => {
    expect(translateByte(0x0A)).toEqual([0x1C, 0x9C]);
  });

  it('0x0D (CR) → enter scancode', () => {
    expect(translateByte(0x0D)).toEqual([0x1C, 0x9C]);
  });

  it('0x1B (ESC) → escape scancode', () => {
    expect(translateByte(0x1B)).toEqual([0x01, 0x81]);
  });
});

describe('translateByte: Ctrl-letter combos', () => {
  it('Ctrl-A (0x01) emits Ctrl-down, a, a-release, Ctrl-up', () => {
    expect(translateByte(0x01)).toEqual([0x1D, 0x1E, 0x9E, 0x9D]);
  });

  it('Ctrl-C (0x03) emits Ctrl-down, c, c-release, Ctrl-up', () => {
    expect(translateByte(0x03)).toEqual([0x1D, 0x2E, 0xAE, 0x9D]);
  });

  it('Ctrl-Z (0x1A) emits Ctrl-down, z, z-release, Ctrl-up', () => {
    expect(translateByte(0x1A)).toEqual([0x1D, 0x2C, 0xAC, 0x9D]);
  });

  it('Ctrl-H (0x08) is consumed as Backspace, NOT Ctrl-letter', () => {
    expect(translateByte(0x08)).toEqual([0x0E, 0x8E]);
  });

  it('Ctrl-I (0x09) is consumed as Tab', () => {
    expect(translateByte(0x09)).toEqual([0x0F, 0x8F]);
  });

  it('Ctrl-M (0x0D) is consumed as Enter', () => {
    expect(translateByte(0x0D)).toEqual([0x1C, 0x9C]);
  });
});

describe('translateByte: shifted symbols', () => {
  it("'A' (0x41) emits Shift, a-press, a-release, Shift-up", () => {
    expect(translateByte(0x41)).toEqual([0x2A, 0x1E, 0x9E, 0xAA]);
  });

  it("'!' (0x21) emits Shift, 1-press, 1-release, Shift-up", () => {
    expect(translateByte(0x21)).toEqual([0x2A, 0x02, 0x82, 0xAA]);
  });

  it("'@' (0x40) emits Shift, 2-press, 2-release, Shift-up", () => {
    expect(translateByte(0x40)).toEqual([0x2A, 0x03, 0x83, 0xAA]);
  });

  it("'?' (0x3F) emits Shift, /-press, /-release, Shift-up", () => {
    expect(translateByte(0x3F)).toEqual([0x2A, 0x35, 0xB5, 0xAA]);
  });
});

describe('translateByte: out-of-table bytes', () => {
  it('returns empty for 0x00 (NUL)', () => {
    expect(translateByte(0x00)).toEqual([]);
  });

  it('returns empty for 0x80 (high bit, no mapping)', () => {
    expect(translateByte(0x80)).toEqual([]);
  });

  it('returns empty for 0xFF', () => {
    expect(translateByte(0xFF)).toEqual([]);
  });
});

describe('ScancodeTranslator.feed', () => {
  it('translates "ab\\n" to a, b, then Enter scancodes in order', () => {
    const t = new ScancodeTranslator();
    const out = t.feed([0x61, 0x62, 0x0A]);
    expect(out).toEqual([
      0x1E, 0x9E,           // a press, a release
      0x30, 0xB0,           // b press, b release
      0x1C, 0x9C,           // Enter
    ]);
  });

  it('Ctrl-A then "x" yields four Ctrl-A scancodes followed by x scancodes', () => {
    const t = new ScancodeTranslator();
    const out = t.feed([0x01, 0x78]);
    expect(out).toEqual([
      0x1D, 0x1E, 0x9E, 0x9D,  // Ctrl-A
      0x2D, 0xAD,              // x press + release
    ]);
  });

  it('"root\\n" produces a sensible non-empty stream', () => {
    const t = new ScancodeTranslator();
    const out = t.feed([0x72, 0x6F, 0x6F, 0x74, 0x0A]);
    // r, o, o, t each press+release plus enter
    expect(out).toEqual([
      0x13, 0x93,
      0x18, 0x98,
      0x18, 0x98,
      0x14, 0x94,
      0x1C, 0x9C,
    ]);
  });

  it('drops bytes with no mapping rather than throwing', () => {
    const t = new ScancodeTranslator();
    const out = t.feed([0x00, 0x80, 0xFF]);
    expect(out).toEqual([]);
  });
});
