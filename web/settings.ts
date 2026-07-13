/**
 * User settings for the browser harness.
 *
 * Three settings, all small key-value scalars/objects: font size (number),
 * theme (string from a fixed enum), default image source (small discriminated
 * union). `localStorage` is the right tool for this — synchronous reads,
 * trivial JSON encoding, no async lifecycle. We intentionally do NOT reach
 * for IndexedDB; the image library is the IDB tenant (see image-library.ts).
 *
 * Validation is per-field on load: a value that fails the schema falls back
 * to that field's default while preserving any other valid fields. This
 * makes a future schema change (adding a new setting in 9.3) survive an
 * old localStorage value without crashing.
 *
 * The image library reference is validated separately via
 * `validateImageSourceAgainstLibrary` because it requires async IDB lookup.
 * The synchronous `loadSettings()` path doesn't need that — main.ts runs
 * the async validation right before it boots, which is when staleness
 * actually matters.
 *
 * Live updates: callers post a `settings-changed` `CustomEvent` on
 * `document` after `saveSettings`. The terminal listener picks it up to
 * re-apply font size and theme without a reload. Image source changes
 * take effect on next reload (don't try to hot-swap the running disk).
 */

import {
  THEME_PRESET_NAMES,
  isThemePresetName,
  type ThemePresetName,
} from './themes.js';

/**
 * Discriminated union so adding new sources later (e.g. github in 9.3) is
 * a TypeScript-tracked widening, not an unconstrained string.
 */
export type ImageSource =
  | { kind: 'bundled' }
  | { kind: 'library'; id: string };

/**
 * A named boot script (Phase 14 — autoexec). `text` is the keystroke
 * script `web/autoexec.ts` runs at boot; see that module for the line
 * format. Small editable text — localStorage-sized by construction.
 */
export interface BootScript {
  id: string;
  name: string;
  text: string;
}

export interface Settings {
  /** Pixels. xterm.js takes a number. */
  fontSize: number;
  themeName: ThemePresetName;
  imageSource: ImageSource;
  /**
   * Optional secondary-disk source (Phase 11 — multi-disk substrate).
   * `null` ⇒ single-disk operation, no behavioral change vs Phase 10.
   * Typically resolves to /dev/hdb or /dev/fd1 in ELKS depending on
   * geometry; the worker host infers the class from the image bytes.
   *
   * Cannot reference 'bundled' — the bundled image is the boot image,
   * not a secondary. Stored as `null` (no secondary) or
   * `{ kind: 'library', id }`.
   */
  secondaryImageSource: { kind: 'library'; id: string } | null;
  /** Named autoexec scripts (Phase 14 — boot scripts). */
  bootScripts: BootScript[];
  /**
   * Script to run at boot, or null for none. Applies on next reload,
   * like image-source changes. Default null — booting stays silent
   * until the user opts in.
   */
  activeBootScriptId: string | null;
  /**
   * CPU speed (pacing milestone): 'authentic' caps execution at a real
   * 4.77 MHz 8086; 'turbo' uncaps instructions (clock stays wall-true)
   * for in-VM compile workloads. Applies live — the modal also posts a
   * set-speed message to the running worker.
   */
  cpuSpeed: 'authentic' | 'turbo';
}

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

/**
 * Seeded example script (editable/deletable like any other): logs in
 * and joins the LAN — the testing-loop boilerplate the feature exists
 * to eliminate. Not active by default.
 */
export const SEED_BOOT_SCRIPT: BootScript = {
  id: 'seed-network',
  name: 'network (root + net start ne0)',
  text: 'root\nnet start ne0\n',
};

/**
 * The landing showcase (2026-07-15): logs in, joins the LAN, then
 * clackety-types a C program and builds it with the guest's own
 * cpp→c86→as→ld toolchain (exact flags from the image's
 * /usr/src/Makefile — see HELLO_WORLD_COMPILE_REPORT.md). Compiles in
 * turbo, reveals in authentic. "hello human" is an homage to
 * retro.sophtwhere.com, the eldest sibling, whose DOS demo types into
 * `debug` — this one types into a compiler. Editable like any script.
 */
export const SEED_DEMO_SCRIPT: BootScript = {
  id: 'seed-demo-hello-human',
  name: 'the show (compile "hello human")',
  text: [
    'root',
    'net start ne0',
    '@turbo',
    '@type',
    "cat > hello.c << 'EOF'",
    '@here',
    '#include <stdio.h>',
    '',
    'int main(void)',
    '{',
    '    printf("hello human\\n");',
    '    return 0;',
    '}',
    'EOF',
    '@end',
    'cpp -0 -I/usr/include -I/usr/include/c86 hello.c -o hello.i',
    'c86 -g -O -bas86 -separate=yes -warn=4 -lang=c99 -align=yes -stackopt=minimum -peep=all -stackcheck=no hello.i hello.as',
    'as -0 -j hello.as -o hello.o',
    'ld -0 -i -L/usr/lib -o hello hello.o -lc86',
    '@authentic',
    './hello',
    '',
  ].join('\n'),
};

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  themeName: 'default-dark',
  imageSource: { kind: 'bundled' },
  secondaryImageSource: null,
  bootScripts: [SEED_BOOT_SCRIPT, SEED_DEMO_SCRIPT],
  activeBootScriptId: null,
  cpuSpeed: 'authentic',
};

const STORAGE_KEY = 'emu86.settings.v1';

/** Custom DOM event name for live-updates. Detail carries the new Settings. */
export const SETTINGS_CHANGED_EVENT = 'emu86:settings-changed';

function isValidFontSize(v: unknown): v is number {
  return typeof v === 'number'
    && Number.isFinite(v)
    && v >= FONT_SIZE_MIN
    && v <= FONT_SIZE_MAX;
}

function isValidImageSource(v: unknown): v is ImageSource {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as { kind?: unknown; id?: unknown };
  if (obj.kind === 'bundled') return true;
  if (obj.kind === 'library' && typeof obj.id === 'string' && obj.id.length > 0) {
    return true;
  }
  return false;
}

function isValidSecondarySource(
  v: unknown,
): v is { kind: 'library'; id: string } | null {
  if (v === null) return true;
  if (typeof v !== 'object') return false;
  const obj = v as { kind?: unknown; id?: unknown };
  return obj.kind === 'library'
    && typeof obj.id === 'string'
    && obj.id.length > 0;
}

function isValidBootScripts(v: unknown): v is BootScript[] {
  if (!Array.isArray(v)) return false;
  return v.every((s) => {
    if (s === null || typeof s !== 'object') return false;
    const obj = s as { id?: unknown; name?: unknown; text?: unknown };
    return typeof obj.id === 'string' && obj.id.length > 0
      && typeof obj.name === 'string'
      && typeof obj.text === 'string';
  });
}

/**
 * Read settings from localStorage. Synchronous. Returns DEFAULT_SETTINGS if
 * nothing stored or stored value isn't an object. For an object that's
 * partially valid, each field independently falls back to its default —
 * so a future schema addition won't blow up on an old stored value.
 *
 * Note: this does NOT validate that `imageSource.id` exists in the IDB
 * library. That lookup is async and lives in
 * `validateImageSourceAgainstLibrary` below; main.ts runs it before boot.
 */
export function loadSettings(): Settings {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage may throw in private modes / sandboxed iframes. Fail open.
    return { ...DEFAULT_SETTINGS };
  }
  if (raw === null) return { ...DEFAULT_SETTINGS };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }
  const obj = parsed as Record<string, unknown>;

  // Per-field fallback. Each field is independent so partial corruption
  // (or a stored value that predates a new field) doesn't reset everything.
  const fontSize = isValidFontSize(obj.fontSize)
    ? obj.fontSize
    : DEFAULT_SETTINGS.fontSize;
  const themeName = isThemePresetName(obj.themeName)
    ? obj.themeName
    : DEFAULT_SETTINGS.themeName;
  const imageSource = isValidImageSource(obj.imageSource)
    ? obj.imageSource
    : { ...DEFAULT_SETTINGS.imageSource };
  const secondaryImageSource = isValidSecondarySource(obj.secondaryImageSource)
    ? obj.secondaryImageSource
    : DEFAULT_SETTINGS.secondaryImageSource;
  const bootScripts = isValidBootScripts(obj.bootScripts)
    ? obj.bootScripts
    : DEFAULT_SETTINGS.bootScripts.map((s) => ({ ...s }));
  // The active id must reference an existing script; a dangling id
  // (deleted script) degrades to "no script" rather than a boot error.
  const activeBootScriptId =
    typeof obj.activeBootScriptId === 'string'
      && bootScripts.some((s) => s.id === obj.activeBootScriptId)
      ? obj.activeBootScriptId
      : null;
  const cpuSpeed =
    obj.cpuSpeed === 'authentic' || obj.cpuSpeed === 'turbo'
      ? obj.cpuSpeed
      : DEFAULT_SETTINGS.cpuSpeed;

  return {
    fontSize,
    themeName,
    imageSource,
    secondaryImageSource,
    bootScripts,
    activeBootScriptId,
    cpuSpeed,
  };
}

/**
 * Persist settings to localStorage and dispatch a `settings-changed` event
 * on `document` so the terminal listener can re-apply font/theme live.
 *
 * Best-effort: storage quota / private-mode failures are swallowed (the
 * user's session keeps running). The event still fires with the in-memory
 * value so live-update doesn't depend on persistence succeeding.
 */
export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota / private-mode. Continue: dispatch the event regardless so the
    // current session reflects the user's choice even if it won't survive a
    // reload.
  }
  if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
    document.dispatchEvent(
      new CustomEvent<Settings>(SETTINGS_CHANGED_EVENT, { detail: { ...s } }),
    );
  }
}

/**
 * Resolve a stored library reference against the live image library. If the
 * id no longer exists (user deleted it; library was wiped; storage evicted),
 * silently fall back to the bundled image and persist the corrected value
 * so we don't ask the same question on every load.
 *
 * Async because the library lookup is IDB-backed. Caller awaits this before
 * using `imageSource` for boot.
 */
export async function validateImageSourceAgainstLibrary(
  s: Settings,
  hasImage: (id: string) => Promise<boolean>,
): Promise<Settings> {
  let imageSource = s.imageSource;
  let secondaryImageSource = s.secondaryImageSource;
  let dirty = false;

  if (imageSource.kind === 'library') {
    if (!(await hasImage(imageSource.id))) {
      imageSource = { kind: 'bundled' };
      dirty = true;
    }
  }
  if (secondaryImageSource !== null) {
    if (!(await hasImage(secondaryImageSource.id))) {
      secondaryImageSource = null;
      dirty = true;
    }
  }
  if (!dirty) return s;
  const fixed: Settings = { ...s, imageSource, secondaryImageSource };
  // Persist quietly. Don't dispatch settings-changed — the user didn't take
  // an action and the visible state didn't change (image source applies on
  // next reload anyway). This avoids redundant listener work at startup.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fixed));
  } catch {
    // ignore
  }
  return fixed;
}

// Re-export for callers building UIs over the schema.
export { THEME_PRESET_NAMES };
export type { ThemePresetName };
