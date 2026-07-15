import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SEED_PING_SCRIPT,
  SETTINGS_CHANGED_EVENT,
  loadSettings,
  reconcileSeededScripts,
  saveSettings,
  validateImageSourceAgainstLibrary,
  type BootScript,
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

const STORAGE_KEY = 'emu86.settings.v2';
// The v1 key belongs to the pre-key-versioning era (its live reader is the
// archived 9728bb6 build — see RELEASE_PROCEDURE.md, "Settings are
// key-versioned per semantic era").
const LEGACY_STORAGE_KEY = 'emu86.settings.v1';

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
      autologin: 'user1',
      autoNet: true,
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
      autologin: 'user1',
      autoNet: true,
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
      autologin: 'user1',
      autoNet: true,
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
      autologin: 'user1',
      autoNet: true,
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

describe('v1 → v2 migration — archives own the old key (RELEASE_PROCEDURE.md)', () => {
  it('adopts v1 once, and defuses v1 secondary so the 9728bb6 archive attaches nothing', () => {
    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        fontSize: 22,
        themeName: 'solarized-light',
        secondaryImageSource: { kind: 'library', id: 'fork-template' },
        someFutureField: 'must survive in v1', // unknown to BOTH eras' loaders
      }),
    );

    const s = loadSettings();
    // The adopted values are this load's values…
    expect(s.fontSize).toBe(22);
    expect(s.themeName).toBe('solarized-light');
    expect(s.secondaryImageSource).toEqual({ kind: 'library', id: 'fork-template' });
    // …and are now persisted under v2.
    const v2 = JSON.parse(storage.getItem(STORAGE_KEY)!);
    expect(v2.secondaryImageSource).toEqual({ kind: 'library', id: 'fork-template' });

    // v1 keeps everything AS STORED — unknown fields included — except the
    // secondary, which is nulled so the archived build boots without one.
    const v1 = JSON.parse(storage.getItem(LEGACY_STORAGE_KEY)!);
    expect(v1.secondaryImageSource).toBeNull();
    expect(v1.fontSize).toBe(22);
    expect(v1.someFutureField).toBe('must survive in v1');
  });

  it('is one-shot: once v2 exists, v1 is the archive era\'s and is never read or touched', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 18 }));
    const v1Blob = JSON.stringify({
      fontSize: 30,
      secondaryImageSource: { kind: 'library', id: 'set-inside-the-archive' },
    });
    storage.setItem(LEGACY_STORAGE_KEY, v1Blob);

    const s = loadSettings();
    expect(s.fontSize).toBe(18); // v2 wins
    expect(s.secondaryImageSource).toBeNull(); // v1's choice is invisible here
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBe(v1Blob); // byte-untouched
  });

  it('saves land only in v2; v1 never learns the new era\'s values', () => {
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: 20 });
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).fontSize).toBe(20);
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('unusable v1 (garbage, non-object) migrates nothing and does not throw', () => {
    storage.setItem(LEGACY_STORAGE_KEY, 'not-json{');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBe('not-json{'); // left alone

    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify('a string'));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('neither key present: defaults, and nothing is written', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});

describe('reconcileSeededScripts — seeded scripts must be able to receive fixes', () => {
  it('refreshes a legacy stored copy (no seedRev) of a seed we have since fixed', () => {
    // Exactly Jonathan's case: a copy of the ping installer saved before
    // revisions existed, holding text we have already fixed twice. The
    // old absent-only seeding left it shadowing every fix, and he had to
    // delete it by hand to see one.
    const stale: BootScript = {
      id: SEED_PING_SCRIPT.id,
      name: SEED_PING_SCRIPT.name,
      text: 'root\nthe old broken text\n',
    };
    const [got] = reconcileSeededScripts([stale]);
    expect(got?.text).toBe(SEED_PING_SCRIPT.text);
    expect(got?.seedRev).toBe(SEED_PING_SCRIPT.seedRev);
  });

  it('refreshes a stored copy at an older rev', () => {
    const older: BootScript = { ...SEED_PING_SCRIPT, text: 'stale', seedRev: 1 };
    const [got] = reconcileSeededScripts([older]);
    expect(got?.text).toBe(SEED_PING_SCRIPT.text);
  });

  it('NEVER touches a script the user has edited', () => {
    const mine: BootScript = {
      id: SEED_PING_SCRIPT.id,
      name: 'my ping installer',
      text: 'root\nmy own careful edits\n',
      userEdited: true,
    };
    const [got] = reconcileSeededScripts([mine]);
    expect(got).toEqual(mine); // byte-for-byte, forever
  });

  it('leaves a current copy alone and adds seeds the profile has never seen', () => {
    const current: BootScript = { ...SEED_PING_SCRIPT };
    const out = reconcileSeededScripts([current]);
    expect(out.find((s) => s.id === SEED_PING_SCRIPT.id)).toEqual(current);
    // The other seeds are absent from this profile — they get added.
    for (const seed of DEFAULT_SETTINGS.bootScripts) {
      expect(out.some((s) => s.id === seed.id)).toBe(true);
    }
  });

  it("does not touch the user's own scripts", () => {
    const mine: BootScript = { id: 'mine-1', name: 'mine', text: 'root\n' };
    const out = reconcileSeededScripts([mine]);
    expect(out.find((s) => s.id === 'mine-1')).toEqual(mine);
  });
});
