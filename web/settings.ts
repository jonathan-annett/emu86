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
import { buildPingInstallerScript } from './ping-installer.js';

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
  /**
   * Revision of the seed this pristine copy came from. Bumping a seed's
   * rev in code makes existing profiles pick up the new text on next
   * load. Absent means the copy was stored before revisions existed
   * (legacy) — those refresh once and gain a rev.
   *
   * Without this, seeding was absent-only: a stored copy shadowed every
   * later fix to a seeded script, and the user had to know to delete it
   * by hand. Field-hit twice (2026-07-14), the second time on a script
   * I had already fixed.
   */
  seedRev?: number;
  /**
   * The user changed this script. It is theirs now: never refreshed,
   * never overwritten, whatever we ship. Set by the editor, and the
   * reason `seedRev: undefined` can safely mean "legacy, refresh me".
   */
  userEdited?: boolean;
}

export interface Settings {
  /** Pixels. xterm.js takes a number. */
  fontSize: number;
  themeName: ThemePresetName;
  imageSource: ImageSource;
  /**
   * The BASE drive image (Phase 16 M0 — meaning changed; the field and
   * its storage shape did not). This is the TEMPLATE every newly opened
   * tab forks its private /dev/hdb from; it is NOT what any tab mounts
   * directly. `null` no longer means "no drive" — it means new tabs get
   * a fresh blank 8086 KB fork. Written by the modal's picker and by
   * the main page's "Save as default" promote; running tabs' forks live
   * in sessionStorage + the image library ('fork' rows), not here.
   *
   * (History: Phase 11 introduced this as the directly-mounted
   * secondary; that origin-global attach is what made `?mkdrive` refuse
   * brand-new tabs — SUBSTRATE_API_REPORT.md §4, field 2026-07-15.)
   *
   * Cannot reference 'bundled' — the bundled image is the boot image,
   * not a data-drive template. Stored as `null` or
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
  /**
   * Phase 17 M3 (§4.6): who the serial console logs in as, with
   * NOTHING typed — the worker stamps the inittab ttyS0 line per
   * boot. 'off' restores the stock getty prompt. Default 'user1'
   * (Jonathan's Addendum A call). Applies on next reload.
   */
  autologin: 'off' | 'root' | 'user1';
  /**
   * Phase 17 M3: stamp `net=ne0` into bootopts so rc.sys brings the
   * NIC up untyped. The worker suppresses it for a first-boot-show
   * boot (the 640K ktcp-vs-c86 constraint). Default true. Applies on
   * next reload.
   */
  autoNet: boolean;
  /**
   * The demo has been played (field ask, 2026-07-17: the automatic
   * first-boot show "has been making things complicated to test" —
   * it now lives behind a ▶ button next to the gear, and once
   * clicked "it can go away forever"). True hides the button
   * permanently on this origin.
   */
  demoPlayed: boolean;
}

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

/**
 * Seeded example script (editable/deletable like any other): logs in
 * and joins the LAN — the testing-loop boilerplate the feature exists
 * to eliminate. Not active by default.
 *
 * The drive probe (Jonathan's design, field 2026-07-15): if /dev/hdb
 * is attached it mounts OVER /tmp — so /tmp itself persists, and the
 * workshop the ping installer keeps there survives reboots — and a
 * ping binary found on it goes straight to /bin. No network, no
 * compile, every boot. Deliberate limitation, recorded: the fast copy
 * cannot check the rev markers (a static seed can't know the current
 * rev), so a stale drive keeps its old ping until the installer
 * script is re-run — that one purges by marker and re-fetches.
 * Without a drive both lines fail quietly and the script is the old
 * two-liner.
 */
export const SEED_BOOT_SCRIPT: BootScript = {
  id: 'seed-network',
  name: 'network (root + net start ne0)',
  text: [
    'root',
    'net start ne0',
    '',
  ].join('\n'),
  // rev 3 (Phase 17 M3, §4.3 executed): the mount and ping-restore
  // lines are gone — /dev/hdb mounts at /home via the stamped
  // /etc/home.sh at sysinit, and the ping restore belongs in the
  // fork's own .profile now. This script only matters with
  // autologin off; the daily loop types nothing.
  seedRev: 3,
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
    // The c86 line types as shell-continuation multi-line — prettier
    // than scroll-wrapping 130 columns into 80 (and it exercises the
    // `> ` continuation prompt the runner now understands).
    'c86 -g -O -bas86 -separate=yes -warn=4 -lang=c99 \\',
    '    -align=yes -stackopt=minimum -peep=all \\',
    '    -stackcheck=no hello.i hello.as',
    'as -0 -j hello.as -o hello.o',
    'ld -0 -i -L/usr/lib -o hello hello.o -lc86',
    '@authentic',
    './hello',
    '',
  ].join('\n'),
  seedRev: 1,
};

/**
 * The ping installer (Phase 15 M3 follow-on, Jonathan's design): the
 * machine downloads its own tools. Three commands — join the LAN,
 * fetch a shell script from the public 8086-tab-tools repo through the
 * M3d HTTP gateway, run it — and the script fetches `ping.c` and builds
 * it with the compiler on the image. Replaced 722 lines of chunked
 * heredoc paste that kept losing to the ELKS shell's heap; see
 * `ping-installer.ts` for that whole sorry history. Sits in the picker
 * unactivated — for discovery.
 */
export const SEED_PING_SCRIPT: BootScript = {
  id: 'seed-ping-installer',
  name: 'ping installer (fetches + builds it in-VM)',
  text: buildPingInstallerScript(),
  // BUMP THIS whenever the script text changes, or existing profiles
  // keep running the copy they stored.
  //   rev 1: nested heredocs — died on the shell's heredoc heap
  //   rev 2: chunked source + `exec sh` to drop the fattened shell
  //   rev 3: ping.c gains /etc/hosts lookup + an honest ktcp diagnostic
  //   rev 4: ping.c gains the .tabs name table (ping cat / ping elk)
  //   rev 5: FETCH the source instead of pasting it — no more tty paste
  //   rev 6: start ktcp only (telnetd+ftpd starved the compiler of RAM)
  seedRev: 6,
};

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  themeName: 'default-dark',
  imageSource: { kind: 'bundled' },
  secondaryImageSource: null,
  bootScripts: [SEED_BOOT_SCRIPT, SEED_DEMO_SCRIPT, SEED_PING_SCRIPT],
  activeBootScriptId: null,
  cpuSpeed: 'authentic',
  autologin: 'user1',
  demoPlayed: false,
  autoNet: true,
};

/**
 * Key-versioned per SEMANTIC era (RELEASE_PROCEDURE.md, 2026-07-15).
 * Archived versions run on this same origin and read this same
 * localStorage, so a field whose MEANING changes under an unchanged
 * name poisons every archive that predates the change — field-hit the
 * day archives shipped: the 9728bb6 archive read the current
 * `secondaryImageSource` (a fork TEMPLATE since Phase 16 M0) and
 * attached it directly as its /dev/hdb (its era's semantics). The rule:
 * change what a persisted field means → bump this key. Each era then
 * owns its key; `migrateLegacyV1` below adopts v1 once and defuses it.
 */
const STORAGE_KEY = 'emu86.settings.v2';
const LEGACY_STORAGE_KEY = 'emu86.settings.v1';

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
    const obj = s as { id?: unknown; name?: unknown; text?: unknown; seedRev?: unknown };
    return typeof obj.id === 'string' && obj.id.length > 0
      && typeof obj.name === 'string'
      && typeof obj.text === 'string'
      && (obj.seedRev === undefined || typeof obj.seedRev === 'number');
  });
}

/**
 * Reconcile stored boot scripts against the seeds we ship.
 *
 *   user's own script (no seed id)  → untouched
 *   userEdited                      → untouched, forever. It is theirs.
 *   seed absent                     → added
 *   seed present, rev < ours        → name + text refreshed
 *   seed present, no rev (legacy)   → refreshed once, gains a rev
 *   seed present, rev current       → untouched (nothing changed)
 *
 * The bug this fixes: seeding was absent-only, so a stored copy of a
 * seeded script shadowed every later fix to it. Jonathan ran a boot
 * script I had already fixed — twice — and had to know to delete it by
 * hand to see the fix (2026-07-14).
 */
export function reconcileSeededScripts(scripts: readonly BootScript[]): BootScript[] {
  const seeds = DEFAULT_SETTINGS.bootScripts;
  const out: BootScript[] = scripts.map((script) => {
    if (script.userEdited === true) return script; // theirs — hands off
    const seed = seeds.find((s) => s.id === script.id);
    if (seed === undefined) return script; // a script of the user's own
    const storedRev = script.seedRev ?? 0; // absent = legacy = stale
    const seedRev = seed.seedRev ?? 0;
    if (storedRev >= seedRev) return script; // already current
    return { ...script, name: seed.name, text: seed.text, seedRev };
  });
  for (const seed of seeds) {
    if (!out.some((s) => s.id === seed.id)) out.push({ ...seed });
  }
  return out;
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
  if (raw === null) raw = migrateLegacyV1();
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
  // Phase 17 M3 — additive fields, per-field-tolerant (no key bump:
  // absent in older blobs means the defaults, and the v2 era rule
  // bites only on SEMANTIC changes to existing fields).
  const autologin =
    obj.autologin === 'off' || obj.autologin === 'root' || obj.autologin === 'user1'
      ? obj.autologin
      : DEFAULT_SETTINGS.autologin;
  const autoNet = typeof obj.autoNet === 'boolean' ? obj.autoNet : DEFAULT_SETTINGS.autoNet;
  const demoPlayed =
    typeof obj.demoPlayed === 'boolean' ? obj.demoPlayed : DEFAULT_SETTINGS.demoPlayed;

  return {
    fontSize,
    themeName,
    imageSource,
    secondaryImageSource,
    bootScripts,
    activeBootScriptId,
    cpuSpeed,
    autologin,
    autoNet,
    demoPlayed,
  };
}

/**
 * One-shot adoption of the v1 settings blob, run only when v2 is absent.
 * Copies the v1 JSON to the v2 key verbatim (per-field validation happens
 * on parse regardless), then rewrites v1 IN PLACE with
 * `secondaryImageSource: null` — every other field preserved as stored,
 * unknown fields included — so the archived 9728bb6-era build boots with
 * no secondary instead of directly attaching the fork template. From then
 * on each era owns its key: settings edits made inside an archive land in
 * v1 and are invisible here, and vice versa. Returns the adopted raw JSON,
 * or null if there is nothing usable to migrate (fail open, like every
 * other storage path in this module).
 */
function migrateLegacyV1(): string | null {
  try {
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw === null) return null;
    const legacy: unknown = JSON.parse(legacyRaw);
    if (legacy === null || typeof legacy !== 'object') return null;
    localStorage.setItem(STORAGE_KEY, legacyRaw);
    (legacy as Record<string, unknown>).secondaryImageSource = null;
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
    return legacyRaw;
  } catch {
    // Unparseable v1, or storage refused the writes (quota, private
    // mode). Nothing adopted this load; a later load may retry.
    return null;
  }
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
