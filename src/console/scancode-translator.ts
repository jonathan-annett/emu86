/**
 * Translate host stdin bytes into PC/AT scancode set 1 events that the
 * 8042 keyboard controller can deliver to the guest as if a real keyboard
 * had been pressed and released.
 *
 * Why set 1: ELKS's `kbd-scancode.c` (the `console-direct` keyboard driver)
 * masks the high bit to detect releases (`code & 0x80`) and indexes a
 * `tb_state[]` table starting at scancode 0x1C — the canonical XT/AT set 1
 * layout. The Minix-derived keymap tables (`KeyMaps/keys-us.h` etc.) match
 * the standard PC/XT scancode-to-character mapping. No other set is
 * accepted by the driver; the controller doesn't honour 0xF0 (set 2 break
 * prefix) or 0xAB queries from the kernel.
 *
 * Translation strategy: keep one ASCII-to-scancode table for the unshifted
 * keymap and a second for the shifted keymap. When a stdin byte has a
 * shifted entry, wrap the press-release pair in a Shift-down/Shift-up pair
 * so ELKS's ModeState picks up SHIFT exactly during the keystroke. Ctrl-A
 * through Ctrl-Z arrive as bytes 0x01-0x1A and become Ctrl-down, letter,
 * Ctrl-up. Backspace, Tab, Enter, Esc map by direct byte lookup; Backspace
 * accepts both 0x08 and 0x7F so terminals using DEL as the erase byte
 * (xterm default) work alongside terminals sending BS. Carriage return and
 * line feed both map to scancode 0x1C — terminals that send only CR (Mac
 * line endings) or only LF (raw mode on Linux TTYs) both produce Enter.
 *
 * What is NOT translated:
 *
 *   - Arrow keys / function keys. Terminals send these as ESC-prefixed
 *     CSI sequences (`ESC [ A` etc.); without a multi-byte state machine
 *     we forward the bytes individually so the user sees Esc, then `[`,
 *     then `A`. ELKS expects extended scancodes (0xE0 0x48 for up arrow)
 *     for these — defer to a follow-up brief if the shell line editor
 *     turns out to need them. For now the user can reach the shell with
 *     ASCII alone, which is what the brief targets.
 *   - F1-F12. Same reasoning.
 *   - Caps Lock / Num Lock / Scroll Lock. The translator never holds
 *     state between calls to `translate()`; modifier keys are pulsed
 *     around individual characters rather than latched.
 *   - Mouse, keypad-specific scancodes, international keys. Defer.
 *
 * Output is a flat array of bytes the host can pass to
 * `KeyboardController8042.injectScancodes()`. Empty result means "no
 * recognised key event from this byte" — the byte is silently dropped
 * rather than warned about, since that's the friendliest behaviour for
 * paste-of-arbitrary-text use cases.
 */

const SCAN_LSHIFT = 0x2A;
const SCAN_LSHIFT_RELEASE = 0xAA;
const SCAN_LCTRL = 0x1D;
const SCAN_LCTRL_RELEASE = 0x9D;
const SCAN_BACKSPACE = 0x0E;
const SCAN_TAB = 0x0F;
const SCAN_ENTER = 0x1C;
const SCAN_ESC = 0x01;
const SCAN_SPACE = 0x39;

/**
 * Direct byte → scancode for the unshifted ASCII characters that have a
 * single-key scancode in set 1. Lower-case letters and digits live here;
 * uppercase letters and shifted symbols go through the shifted table.
 */
const UNSHIFTED: Readonly<Record<string, number>> = {
  '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06,
  '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0A, '0': 0x0B,
  '-': 0x0C, '=': 0x0D,
  'q': 0x10, 'w': 0x11, 'e': 0x12, 'r': 0x13, 't': 0x14,
  'y': 0x15, 'u': 0x16, 'i': 0x17, 'o': 0x18, 'p': 0x19,
  '[': 0x1A, ']': 0x1B,
  'a': 0x1E, 's': 0x1F, 'd': 0x20, 'f': 0x21, 'g': 0x22,
  'h': 0x23, 'j': 0x24, 'k': 0x25, 'l': 0x26,
  ';': 0x27, '\'': 0x28, '`': 0x29, '\\': 0x2B,
  'z': 0x2C, 'x': 0x2D, 'c': 0x2E, 'v': 0x2F, 'b': 0x30,
  'n': 0x31, 'm': 0x32,
  ',': 0x33, '.': 0x34, '/': 0x35,
};

/**
 * Direct byte → scancode for ASCII characters that need Shift held to
 * type (uppercase letters, the digit-row symbols, etc). The scancode is
 * the same as the unshifted version of the same physical key — the
 * difference is the surrounding Shift-down / Shift-up wrapper that
 * `translateByte()` adds.
 */
const SHIFTED: Readonly<Record<string, number>> = {
  '!': 0x02, '@': 0x03, '#': 0x04, '$': 0x05, '%': 0x06,
  '^': 0x07, '&': 0x08, '*': 0x09, '(': 0x0A, ')': 0x0B,
  '_': 0x0C, '+': 0x0D,
  'Q': 0x10, 'W': 0x11, 'E': 0x12, 'R': 0x13, 'T': 0x14,
  'Y': 0x15, 'U': 0x16, 'I': 0x17, 'O': 0x18, 'P': 0x19,
  '{': 0x1A, '}': 0x1B,
  'A': 0x1E, 'S': 0x1F, 'D': 0x20, 'F': 0x21, 'G': 0x22,
  'H': 0x23, 'J': 0x24, 'K': 0x25, 'L': 0x26,
  ':': 0x27, '"': 0x28, '~': 0x29, '|': 0x2B,
  'Z': 0x2C, 'X': 0x2D, 'C': 0x2E, 'V': 0x2F, 'B': 0x30,
  'N': 0x31, 'M': 0x32,
  '<': 0x33, '>': 0x34, '?': 0x35,
};

function pressRelease(scan: number): number[] {
  return [scan & 0x7F, (scan & 0x7F) | 0x80];
}

function withShift(scan: number): number[] {
  return [
    SCAN_LSHIFT,
    scan & 0x7F,
    (scan & 0x7F) | 0x80,
    SCAN_LSHIFT_RELEASE,
  ];
}

function withCtrl(scan: number): number[] {
  return [
    SCAN_LCTRL,
    scan & 0x7F,
    (scan & 0x7F) | 0x80,
    SCAN_LCTRL_RELEASE,
  ];
}

/**
 * Translate a single stdin byte to zero or more scancodes (in delivery
 * order). Returns an empty array if the byte has no scancode mapping in
 * the v0 table — the caller is expected to drop unknown bytes silently.
 *
 * Pure function: no internal state, idempotent, safe to call from any
 * context. Multi-byte stdin sequences are translated one byte at a time;
 * the caller (or `ScancodeTranslator`) is responsible for stitching the
 * outputs together in arrival order.
 */
export function translateByte(byte: number): number[] {
  const b = byte & 0xFF;

  // Control bytes: handle the ones with single-key scancodes first so
  // they win over the Ctrl-letter range (0x08 = Ctrl-H but we want
  // Backspace; 0x09 = Ctrl-I but we want Tab; 0x0D = Ctrl-M but we want
  // Enter). The remaining 0x01-0x1A range becomes Ctrl-letter.
  if (b === 0x08 || b === 0x7F) return pressRelease(SCAN_BACKSPACE);
  if (b === 0x09) return pressRelease(SCAN_TAB);
  if (b === 0x0A || b === 0x0D) return pressRelease(SCAN_ENTER);
  if (b === 0x1B) return pressRelease(SCAN_ESC);
  if (b === 0x20) return pressRelease(SCAN_SPACE);

  // Ctrl-A (0x01) … Ctrl-Z (0x1A): emit Ctrl-down + letter + Ctrl-up so
  // ELKS's `keyboard_irq` sees `(ModeState & (CTRL|ALT)) == CTRL` and
  // applies the `key &= 0x1F` step. The letter scancode comes from the
  // unshifted table for the corresponding lower-case letter.
  if (b >= 0x01 && b <= 0x1A) {
    const letter = String.fromCharCode(b + 0x60);   // 0x01 → 'a', 0x1A → 'z'
    const scan = UNSHIFTED[letter];
    if (scan === undefined) return [];
    return withCtrl(scan);
  }

  if (b < 0x20 || b > 0x7E) return [];                // unprintable / non-ASCII

  const ch = String.fromCharCode(b);
  const direct = UNSHIFTED[ch];
  if (direct !== undefined) return pressRelease(direct);
  const shifted = SHIFTED[ch];
  if (shifted !== undefined) return withShift(shifted);
  return [];
}

/**
 * Stateless wrapper that translates a buffer of stdin bytes in one call.
 * Convenience for the harness: `translator.feed(chunk)` returns a flat
 * scancode stream the caller hands straight to the keyboard controller.
 */
export class ScancodeTranslator {
  feed(bytes: Iterable<number>): number[] {
    const out: number[] = [];
    for (const b of bytes) {
      const scans = translateByte(b);
      for (const s of scans) out.push(s);
    }
    return out;
  }
}
