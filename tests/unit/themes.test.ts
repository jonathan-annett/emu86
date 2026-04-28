import { describe, expect, it } from 'vitest';
import {
  THEMES,
  THEME_LABELS,
  THEME_PRESET_NAMES,
  isThemePresetName,
  type ThemePresetName,
} from '../../web/themes.js';

// xterm.js doesn't ship a runtime export for ITheme, so we hand-list the
// fields the brief specifies (16 ANSI + foreground + background + cursor).
// Keeping this constant in the test rather than importing back from
// themes.ts means any silent drift in the production constants is caught.
const REQUIRED_ITHEME_KEYS = [
  'foreground',
  'background',
  'cursor',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

describe('themes', () => {
  it('THEME_PRESET_NAMES matches the THEMES record keys exactly', () => {
    const themeKeys = Object.keys(THEMES).sort();
    const enumNames = [...THEME_PRESET_NAMES].sort();
    expect(themeKeys).toEqual(enumNames);
    expect(THEME_PRESET_NAMES).toHaveLength(5);
  });

  it('every preset declares all required ITheme fields with hex colour values', () => {
    for (const name of THEME_PRESET_NAMES) {
      const theme = THEMES[name];
      for (const key of REQUIRED_ITHEME_KEYS) {
        const v = (theme as Record<string, unknown>)[key];
        expect(typeof v, `${name}.${key}`).toBe('string');
        // Hex like #abc or #abcdef. xterm.js accepts other forms but our
        // presets all use hex so a regression to e.g. an `rgb(...)` value
        // worth flagging.
        expect(v as string, `${name}.${key}`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      }
    }
  });

  it('isThemePresetName guards: accepts every preset name, rejects garbage', () => {
    for (const name of THEME_PRESET_NAMES) {
      expect(isThemePresetName(name)).toBe(true);
    }
    expect(isThemePresetName('not-a-theme')).toBe(false);
    expect(isThemePresetName(undefined)).toBe(false);
    expect(isThemePresetName(42)).toBe(false);
    expect(isThemePresetName({})).toBe(false);

    // A name registered in THEME_LABELS but not THEMES would be a
    // schema mismatch — assert the labels record covers exactly the same
    // names.
    const labelKeys = Object.keys(THEME_LABELS).sort() as ThemePresetName[];
    expect(labelKeys).toEqual([...THEME_PRESET_NAMES].sort());
  });
});
