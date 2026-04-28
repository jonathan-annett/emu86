/**
 * xterm.js theme presets for the browser harness.
 *
 * Five fixed presets — Section 3 of the Phase 9.2 brief explicitly limits us
 * to presets (no per-color customisation) so the modal stays a dropdown and
 * the type union acts as the validation surface.
 *
 * Each preset is a complete `ITheme`: 16 ANSI colours plus foreground,
 * background, cursor, and a couple of selection slots. xterm.js falls back
 * to defaults for any field we omit, but we list everything explicitly so
 * the rendered terminal looks coherent regardless of which renderer xterm
 * picks (DOM vs canvas vs webgl all read from the same theme dict).
 *
 * Citations:
 *   - solarized-dark / solarized-light: Ethan Schoonover's published palette
 *     (https://ethanschoonover.com/solarized/).
 *   - default-dark / default-light: approximations of xterm.js's stock dark
 *     and light themes — values cross-checked against
 *     `vscode/extensions/theme-defaults` colour groups.
 *   - amber-crt: the brief's "additional preset of your choice" slot. A
 *     homage to amber-phosphor monochrome terminals (e.g. Wyse 60). Single
 *     hue at varying intensity for the ANSI table; the goal is the look of
 *     a CRT, not faithful colour mapping.
 */

import type { ITheme } from '@xterm/xterm';

export type ThemePresetName =
  | 'default-dark'
  | 'default-light'
  | 'solarized-dark'
  | 'solarized-light'
  | 'amber-crt';

export const THEME_PRESET_NAMES: readonly ThemePresetName[] = [
  'default-dark',
  'default-light',
  'solarized-dark',
  'solarized-light',
  'amber-crt',
] as const;

const defaultDark: ITheme = {
  foreground: '#e0e0e0',
  background: '#000000',
  cursor: '#e0e0e0',
  cursorAccent: '#000000',
  selectionBackground: '#3a3d41',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const defaultLight: ITheme = {
  foreground: '#333333',
  background: '#ffffff',
  cursor: '#333333',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

// Solarized base colours are documented in
// https://ethanschoonover.com/solarized/ (table "L*ab values"). The 8 ANSI
// colours map to the accent palette; bright variants reuse the base tones
// so the contrast across them is intentionally subtle, matching the spec.
const solarizedDark: ITheme = {
  foreground: '#839496',           // base0
  background: '#002b36',           // base03
  cursor: '#93a1a1',               // base1
  cursorAccent: '#002b36',
  selectionBackground: '#073642',  // base02
  black: '#073642',                // base02
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',                // base2
  brightBlack: '#002b36',          // base03
  brightRed: '#cb4b16',            // orange
  brightGreen: '#586e75',          // base01
  brightYellow: '#657b83',         // base00
  brightBlue: '#839496',           // base0
  brightMagenta: '#6c71c4',        // violet
  brightCyan: '#93a1a1',           // base1
  brightWhite: '#fdf6e3',          // base3
};

const solarizedLight: ITheme = {
  foreground: '#657b83',           // base00
  background: '#fdf6e3',           // base3
  cursor: '#586e75',               // base01
  cursorAccent: '#fdf6e3',
  selectionBackground: '#eee8d5',  // base2
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
};

// Amber CRT homage. A single hue at varying intensity. ANSI red/green/etc
// don't map naturally to a monochrome screen, so we tint each toward amber
// with luminance differences carrying the contrast. Background is a very
// dark brown to suggest phosphor afterglow rather than pure black.
const amberCRT: ITheme = {
  foreground: '#ffb000',           // amber primary
  background: '#1a0f00',           // dark brown-black
  cursor: '#ffd070',               // brighter amber
  cursorAccent: '#1a0f00',
  selectionBackground: '#403010',
  black: '#1a0f00',
  red: '#a05000',
  green: '#c07000',
  yellow: '#ffb000',
  blue: '#704000',
  magenta: '#905000',
  cyan: '#a06000',
  white: '#ffb000',
  brightBlack: '#604010',
  brightRed: '#d07000',
  brightGreen: '#e08000',
  brightYellow: '#ffd070',
  brightBlue: '#a06000',
  brightMagenta: '#c08000',
  brightCyan: '#d09000',
  brightWhite: '#ffe0a0',
};

export const THEMES: Readonly<Record<ThemePresetName, ITheme>> = {
  'default-dark': defaultDark,
  'default-light': defaultLight,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  'amber-crt': amberCRT,
};

/** Human-friendly labels for the dropdown. Order is intentional: dark first. */
export const THEME_LABELS: Readonly<Record<ThemePresetName, string>> = {
  'default-dark': 'Default (dark)',
  'default-light': 'Default (light)',
  'solarized-dark': 'Solarized dark',
  'solarized-light': 'Solarized light',
  'amber-crt': 'Amber CRT',
};

export function isThemePresetName(s: unknown): s is ThemePresetName {
  return typeof s === 'string'
    && (THEME_PRESET_NAMES as readonly string[]).includes(s);
}
