import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SETTINGS_CHANGED_EVENT,
  loadSettings,
  saveSettings,
  validateImageSourceAgainstLibrary,
  type Settings,
} from '../../web/settings.js';

/**
 * The settings module touches three browser globals: `localStorage`,
 * `document`, and `CustomEvent`. The test environment is Node, so we install
 * minimal shims:
 *   - `localStorage`: a Map-backed Web Storage substitute. Only the four
 *     methods the module uses are wired (getItem/setItem/removeItem/clear).
 *   - `document`: a tiny EventTarget proxy. We don't need a full DOM — only
 *     `addEventListener`/`removeEventListener`/`dispatchEvent`.
 *   - `CustomEvent`: Node 19+ ships a global; we polyfill it if missing.
 *
 * The shims are installed per test and torn down after, so other tests
 * sharing this process don't see the patched globals.
 */

interface StorageShim extends Storage {
  __raw: Map<string, string>;
}

function makeStorageShim(): StorageShim {
  const map = new Map<string, string>();
  const shim = {
    __raw: map,
    get length(): number { return map.size; },
    clear(): void { map.clear(); },
    getItem(k: string): string | null { return map.has(k) ? map.get(k)! : null; },
    key(i: number): string | null { return Array.from(map.keys())[i] ?? null; },
    removeItem(k: string): void { map.delete(k); },
    setItem(k: string, v: string): void { map.set(k, String(v)); },
  } satisfies StorageShim;
  return shim;
}

const STORAGE_KEY = 'emu86.settings.v1';

let originalLocalStorage: Storage | undefined;
let originalDocument: Document | undefined;
let storage: StorageShim;
let docTarget: EventTarget;

beforeEach(() => {
  originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  originalDocument = (globalThis as { document?: Document }).document;
  storage = makeStorageShim();
  (globalThis as { localStorage: Storage }).localStorage = storage;
  docTarget = new EventTarget();
  // The settings module narrows on `typeof document !== 'undefined'`. A bare
  // EventTarget works for the addEventListener/dispatchEvent surface we test.
  (globalThis as { document?: unknown }).document = docTarget;
});

afterEach(() => {
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    (globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
  }
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    (globalThis as { document: Document }).document = originalDocument;
  }
});

describe('settings', () => {
  it('loadSettings returns DEFAULT_SETTINGS when storage is empty', () => {
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    // Guard against the module returning the constant by reference — a caller
    // mutating its result must not poison defaults for future calls.
    expect(s).not.toBe(DEFAULT_SETTINGS);
  });

  it('save → load round-trips every field intact', () => {
    const target: Settings = {
      fontSize: 18,
      themeName: 'solarized-dark',
      imageSource: { kind: 'library', id: 'image-id-1' },
      secondaryImageSource: { kind: 'library', id: 'secondary-id-1' },
      bootScripts: [{ id: 'bs-1', name: 'network', text: 'root\nnet start ne0\n' }],
      activeBootScriptId: 'bs-1',
      cpuSpeed: 'authentic',
    };
    saveSettings(target);
    const loaded = loadSettings();
    expect(loaded).toEqual(target);
  });

  it('boot scripts: malformed list falls back to the seed; dangling active id degrades to null', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        bootScripts: [{ id: 'x' }],       // missing name/text → invalid list
        activeBootScriptId: 'x',
      }),
    );
    const loaded = loadSettings();
    expect(loaded.bootScripts).toEqual(DEFAULT_SETTINGS.bootScripts);
    expect(loaded.activeBootScriptId).toBeNull();

    // Valid list, but the active id references a deleted script → null,
    // not a boot error.
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        bootScripts: [{ id: 'a', name: 'one', text: 'ls\n' }],
        activeBootScriptId: 'gone',
      }),
    );
    const loaded2 = loadSettings();
    expect(loaded2.bootScripts).toHaveLength(1);
    expect(loaded2.activeBootScriptId).toBeNull();
  });

  it('per-field fallback: invalid field reverts to default, others preserved', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontSize: 999,                    // out of range → default
        themeName: 'solarized-light',     // valid → preserved
        imageSource: { kind: 'library', id: 'kept-id' }, // valid → preserved
      }),
    );
    const s = loadSettings();
    expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(s.themeName).toBe('solarized-light');
    expect(s.imageSource).toEqual({ kind: 'library', id: 'kept-id' });

    // And vice versa — bogus theme / image with valid font.
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontSize: 22,
        themeName: 'not-a-real-theme',
        imageSource: { kind: 'library' /* missing id */ },
      }),
    );
    const t = loadSettings();
    expect(t.fontSize).toBe(22);
    expect(t.themeName).toBe(DEFAULT_SETTINGS.themeName);
    expect(t.imageSource).toEqual(DEFAULT_SETTINGS.imageSource);
  });

  it('font size clamps: values outside FONT_SIZE_MIN..MAX fall back', () => {
    for (const bad of [FONT_SIZE_MIN - 1, FONT_SIZE_MAX + 1, NaN, Infinity, -1, '14']) {
      storage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: bad }));
      expect(loadSettings().fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    }
    for (const ok of [FONT_SIZE_MIN, FONT_SIZE_MAX, 14]) {
      storage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: ok }));
      expect(loadSettings().fontSize).toBe(ok);
    }
  });

  it('saveSettings dispatches a SETTINGS_CHANGED_EVENT with the new value', () => {
    const seen: Settings[] = [];
    const handler = (e: Event): void => {
      seen.push((e as CustomEvent<Settings>).detail);
    };
    docTarget.addEventListener(SETTINGS_CHANGED_EVENT, handler);
    const target: Settings = {
      fontSize: 20,
      themeName: 'amber-crt',
      imageSource: { kind: 'bundled' },
      secondaryImageSource: null,
      bootScripts: [],
      activeBootScriptId: null,
      cpuSpeed: 'authentic',
    };
    saveSettings(target);
    docTarget.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(target);
  });

  it('validateImageSourceAgainstLibrary keeps a valid id, falls back & rewrites if missing', async () => {
    saveSettings({
      fontSize: 14,
      themeName: 'default-dark',
      imageSource: { kind: 'library', id: 'present-id' },
      secondaryImageSource: null,
      bootScripts: [],
      activeBootScriptId: null,
      cpuSpeed: 'authentic',
    });
    const original = loadSettings();

    // Library reports the id is present → settings unchanged.
    const kept = await validateImageSourceAgainstLibrary(
      original,
      async (id) => id === 'present-id',
    );
    expect(kept).toBe(original);
    // Storage didn't get rewritten.
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).imageSource).toEqual({
      kind: 'library', id: 'present-id',
    });

    // Library reports the id is missing → fallback to bundled, persist.
    saveSettings({
      ...original,
      imageSource: { kind: 'library', id: 'gone-id' },
    });
    const stale = loadSettings();
    const fixed = await validateImageSourceAgainstLibrary(
      stale,
      async () => false,
    );
    expect(fixed.imageSource).toEqual({ kind: 'bundled' });
    // Storage now reflects the corrected value.
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).imageSource).toEqual({
      kind: 'bundled',
    });

    // Bundled sources are always kept — the lookup callback must not even fire.
    let lookups = 0;
    const bundled = await validateImageSourceAgainstLibrary(
      { ...original, imageSource: { kind: 'bundled' } },
      async () => { lookups++; return true; },
    );
    expect(bundled.imageSource).toEqual({ kind: 'bundled' });
    expect(lookups).toBe(0);
  });

  it('secondaryImageSource: invalid stored value falls back to null', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontSize: 14,
        themeName: 'default-dark',
        imageSource: { kind: 'bundled' },
        secondaryImageSource: { kind: 'bundled' }, // invalid — secondary cannot be bundled
      }),
    );
    expect(loadSettings().secondaryImageSource).toBeNull();

    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        secondaryImageSource: { kind: 'library' /* missing id */ },
      }),
    );
    expect(loadSettings().secondaryImageSource).toBeNull();

    // Explicit null is preserved.
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ secondaryImageSource: null }),
    );
    expect(loadSettings().secondaryImageSource).toBeNull();
  });

  it('validateImageSourceAgainstLibrary drops a stale secondary', async () => {
    saveSettings({
      fontSize: 14,
      themeName: 'default-dark',
      imageSource: { kind: 'bundled' },
      secondaryImageSource: { kind: 'library', id: 'gone-secondary' },
      bootScripts: [],
      activeBootScriptId: null,
      cpuSpeed: 'authentic',
    });
    const stale = loadSettings();
    const fixed = await validateImageSourceAgainstLibrary(
      stale,
      async () => false, // nothing exists
    );
    expect(fixed.secondaryImageSource).toBeNull();
    // Primary was bundled (not library) so it's untouched.
    expect(fixed.imageSource).toEqual({ kind: 'bundled' });
    // Storage now reflects the corrected value.
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).secondaryImageSource).toBeNull();
  });

  it('garbage in storage falls back cleanly without throwing', () => {
    storage.setItem(STORAGE_KEY, 'not-json{');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

    storage.setItem(STORAGE_KEY, JSON.stringify('a string instead of an object'));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

    storage.setItem(STORAGE_KEY, JSON.stringify(null));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
