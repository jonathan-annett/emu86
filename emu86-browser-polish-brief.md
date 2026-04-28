# emu86 — Agent Brief: Browser Polish — Settings + Local Upload (Phase 9.2)

## TL;DR

Browser-side UX polish. Two related features in one brief because
they share UI surface and IDB persistence:

1. **Settings panel** — modal triggered by a gear icon, persisted.
   Three settings: font size, theme (presets only), default image
   source.
2. **Local image library** — IDB-persisted store of user-uploaded
   floppy images. Drop a `.img` on the page, name it, pick it as
   the boot source. The bundled `/elks-serial.img` is implicit and
   always available.

A future Phase 9.3 brief will add a GitHub-releases browser that
populates the same library from `ghaerr/elks` releases. This brief
builds the library substrate; that brief adds a second source.

No emulator, machine, worker-host, or BrowserConsole changes. This
brief is main-thread UI plumbing on top of the existing harness.

Document in `BROWSER_POLISH_REPORT.md`.

You are working in `emu86/`. Read `BROWSER_HARNESS_REPORT.md` for
the existing main-thread / worker split, message protocol, and Vite
shape. Phase 9.1 (`EARLY_PRINTK_REPORT.md`) is context but not
required reading.

## Hard rules

1. **Don't break existing tests.** 1,135 passing as of Phase 9.1.
   All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **No emulator-side changes.** This is main-thread UI only. The
   worker-host accepts image bytes via the existing config message;
   the worker side does not change.
6. **You may add** files under `web/` (UI, IDB helpers, styles) and
   under `src/browser/` only if a shared type or protocol addition
   is genuinely required. Unit tests for IDB helpers and any
   protocol-shape additions; no UI integration tests (manual
   verification suffices for v0).
7. **You may modify** `web/main.ts`, `web/index.html`, the Vite
   config, `package.json`, and `src/browser/protocol.ts` only if
   the existing config-message can't carry image bytes (most
   likely it already can — check).
8. **You may NOT modify** `src/cpu8086/`, `src/memory/`,
   `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
   `src/devices/`, `src/console/`, `src/disk/`, `src/bios/`,
   `src/host-clock/`, `src/diagnostics/`, `src/machine/ibm-pc.ts`,
   `src/browser/worker-host.ts`, or `src/browser/browser-console.ts`.
   Locks held.
9. **No service worker, no offline caching.** Out of scope.
10. **No framework adoption.** No React, Vue, Svelte, lit, or
    similar. Plain TypeScript + DOM. The current `web/` is
    framework-free; keep it that way. The UI is small enough that
    vanilla DOM is correct here. If you find yourself wanting a
    framework, you've expanded scope.
11. **No GitHub release browser.** Explicitly Phase 9.3. The image
    library should be designed so a second source can be added
    later without restructuring, but this brief implements only
    the local-upload source.

## Background

The Phase 9 browser harness fetches `/elks-serial.img` (a hardcoded
URL served by Vite) and boots ELKS. Phase 9.1 verified the wiring
and removed misleading welcome text. The harness now boots cleanly
but is missing two pieces of basic polish:

- The user can't change anything (font size, colours, image source).
- The user can't try a different floppy without rebuilding.

Both fit into a single brief because they share IndexedDB persistence,
share the same modal UI shell, and the "default image source"
setting is the seam where they meet.

The IDB page store from Phase 6 is unrelated to this brief's IDB
usage. Page store and image library are separate IDB databases —
do not share schemas. Page store holds disk *sectors* mid-session;
image library holds *whole image files* the user uploaded.

## Scope

### Section 1 — IndexedDB image library

A new IDB database, separate from the page store. Confirm the page
store's DB name in `src/disk/idb-page-store.ts` and pick a distinct
one — recommend `emu86-images`.

Object store: `images`. Schema:

```ts
interface StoredImage {
  id: string            // UUID; primary key
  name: string          // user-facing; user-editable
  bytes: Uint8Array     // the floppy image
  uploadedAt: number    // Date.now() at upload
  sizeBytes: number     // = bytes.byteLength; redundant but cheap
  source: 'upload'      // discriminator for Phase 9.3 ('upload' | 'github')
}
```

The `source` field is added now to make Phase 9.3 a non-migration
change. Today it's always `'upload'`; the type union exists so the
compiler reminds future-you that GitHub-sourced entries need
handling.

API surface (in `web/image-library.ts`):

- `listImages(): Promise<StoredImageMeta[]>` — list all, sorted by
  `uploadedAt` descending. **Don't include `bytes` in the listing
  result** — fetch separately. Define `StoredImageMeta` as
  `Omit<StoredImage, 'bytes'>`.
- `addImage(name: string, bytes: Uint8Array, source: 'upload'):
  Promise<string>` — store, return the new id.
- `removeImage(id: string): Promise<void>`.
- `getImageBytes(id: string): Promise<Uint8Array>`.
- `renameImage(id: string, newName: string): Promise<void>`.
- `getQuotaUsage(): Promise<{ usedBytes: number, quotaBytes: number
  | null }>` — wraps `navigator.storage.estimate()`. Used by the
  settings UI to show the user how much space is in use.

Notes:

- The bundled `/elks-serial.img` is **not** stored in IDB. It's the
  implicit "always available" entry. The picker UI shows
  "Default (bundled)" alongside the library list.
- IDB writes are async. If a quota error occurs (a 1.44 MB image
  is small but a user uploading multiple large hard-disk images
  could hit limits — relevant once 9.3's GitHub browser lands),
  surface a user-readable error.
- Consider whether `bytes: Uint8Array` should be `bytes: Blob`
  instead. Blobs may stream-store more efficiently in IDB; Uint8Array
  is simpler for the worker-host to consume. Pick Uint8Array unless
  there's a clear reason — the worker host accepts Uint8Array today
  per Phase 9's protocol. Document the choice.

### Section 2 — Settings store

Settings are small key-value: font size (number), theme name
(string), image source (small object). `localStorage` is the
right tool. Don't reach for IDB.

Settings schema:

```ts
interface Settings {
  fontSize: number              // pixels; default 14
  themeName: ThemePresetName    // see Section 3
  imageSource: ImageSource      // bundled | library:<id>
}

type ImageSource =
  | { kind: 'bundled' }
  | { kind: 'library', id: string }
```

API surface (in `web/settings.ts`):

- `loadSettings(): Settings` — synchronous. Returns defaults if
  none stored, validates stored values against the schema, falls
  back to default for any field that's unrecognised (forward-
  compat: a future setting added in 9.3 won't crash an old
  localStorage value).
- `saveSettings(s: Settings): void`.
- A live-update mechanism so xterm.js can re-apply font/theme
  without reload: emit a custom DOM event (e.g.,
  `settings-changed`) on `document` after save. Main thread listens
  and re-applies. Simple, no external deps. Image source change
  takes effect on next reload (don't try to hot-swap the running
  emulator's disk).

Validation: when loading, if `imageSource.kind === 'library'`,
verify the id exists in the library *before* using it for boot. If
not, fall back to bundled and quietly fix the stored value.

### Section 3 — Theme presets

5 presets, each a fixed `xterm.ITheme` const in `web/themes.ts`:

- `default-dark` — matches today's xterm default (or close).
- `default-light`.
- `solarized-dark`.
- `solarized-light`.
- One additional preset of your choice (`monokai`-ish, `dracula`-
  ish, or a homage to a vintage terminal). The choice is yours;
  document it.

Each preset is a complete `ITheme` (16 ANSI colors + foreground +
background + cursor). Reference the xterm.js docs for the field
list.

Apply via `term.options.theme = themes[name]` in the live-update
listener.

### Section 4 — Settings panel UI

A modal triggered by a gear icon fixed to a corner of the viewport
(top-right recommended; doesn't interfere with the terminal scrollback
indicator). Click the gear → modal opens. Click outside or press Esc
→ modal closes.

Modal contents (vanilla DOM, no framework):

- **Font size**: a numeric input or +/- buttons, range 8-32. Live
  preview as the user changes it.
- **Theme**: a dropdown of preset names. Live preview.
- **Image source**: a section showing the current selection. Below
  it, the library: an "Upload image" button (file picker), and a
  list of stored images with name, size, upload date, and per-row
  actions (rename, delete, "Boot this on next reload"). The
  bundled image appears at the top as a non-deletable entry
  labelled "Default (bundled)".
- **Storage usage**: a small line showing
  `usedBytes / quotaBytes` (formatted as MB or GB), so the user
  can see how full their library is.

Styling: minimal CSS. A solid background, padding, sensible font.
Mobile-friendliness is nice-to-have, not required. Don't reach for
component libraries.

### Section 5 — Upload flow

User clicks "Upload image":
1. File picker opens, accept filter `.img,application/octet-stream`.
2. User selects a file. Read as ArrayBuffer (`file.arrayBuffer()`).
3. Convert to Uint8Array.
4. Prompt for a name (default to `file.name`).
5. Validate: size > 0; size < some sanity limit (10 MB is fine for
   floppies; the 9.3 brief will raise this for hard-disk images).
   Reject with a user-readable message if not.
6. Call `addImage(name, bytes, 'upload')`.
7. List refreshes; new entry visible.

The user separately clicks "Boot this on next reload" on a list
entry. That action sets `imageSource = { kind: 'library', id }`,
saves, and shows a "Reload to apply" notice. Don't auto-reload.

Drag-and-drop on the modal (or on the page) is a bonus if it's
small. Otherwise the file picker is fine.

### Section 6 — Worker-host integration

The existing `BootMessage` (or whatever Phase 9 named it) carries an
image source — currently a URL to `/elks-serial.img`. Two ways to
extend:

- **A. Pass bytes directly.** `BootMessage` gains a `imageBytes:
  Uint8Array` field; main thread, before posting the boot message,
  fetches the bundled image OR pulls bytes from IDB based on the
  setting, then posts. Worker-host treats both sources uniformly.
- **B. Pass a URL or bytes (discriminated union).** Worker-host
  fetches itself if URL, uses bytes directly if bytes.

A is simpler and keeps the worker-host source-agnostic. Recommend A.
If `BootMessage` already accepts bytes (worth checking — Phase 9's
report mentioned both URL and bytes as supported), no protocol
change needed.

### Section 7 — What you are NOT building

- GitHub release browser — explicitly Phase 9.3.
- Hard-disk image support — Phase 9.3 will surface this; out of
  scope here. Validate uploaded files are roughly floppy-sized.
- Per-color theme customisation. 5 presets only.
- Drag-and-drop OS-level file integration beyond the file picker
  (unless trivial).
- Service worker, PWA manifest, install prompts.
- Multi-user / sharing of library entries.
- Image format conversion (e.g., zip → img). User uploads raw
  `.img` files only.
- Reset / wipe-IDB UI for the page store. The page store is its own
  concern.
- A "wipe entire library" button. Per-entry delete is enough.
- Live-swapping the running emulator's disk. Image source change
  takes effect on next reload.
- Mobile-specific layout work.

## Tests

### Unit tests

- **`tests/unit/image-library.test.ts`** *(new, ~6-10 cases)*. Use
  `fake-indexeddb` (already a dev-dep per Phase 6). Cover:
  add/list/get/remove/rename round-trip; listing excludes `bytes`;
  multiple entries sort correctly; remove of nonexistent id is a
  no-op; rename of nonexistent id rejects; quota query returns a
  sensible shape (the underlying `storage.estimate` may be absent
  in the test env — handle gracefully).
- **`tests/unit/settings.test.ts`** *(new, ~4-6 cases)*. Use a
  `localStorage` polyfill or jsdom-style mock. Cover: defaults
  returned when empty; round-trip preserves all fields; invalid
  stored value falls back to defaults per-field; library-id
  validation when the id doesn't exist; settings-changed event
  fires.
- **`tests/unit/themes.test.ts`** *(new, ~2-3 cases)*. Trivial:
  every preset has all required `ITheme` fields; preset names match
  the type union.

### No UI integration tests

Setting up Playwright or a JSDOM-based xterm test for v0 is out of
scope. Manual verification of the modal, upload, and boot-from-
library flows is sufficient. A future brief can add Playwright if
UI regressions become a concern.

### Smoke tests

The existing browser-worker-host integration tests must keep
passing. Verify after your changes.

## Watch out for

- **Don't share IDB databases with the page store.** Phase 6 owns
  `emu86-disk` (or whatever name); use a distinct DB. Mixing them
  introduces coupling that has no upside and a clear failure mode
  (a "wipe library" feature later accidentally wiping the page
  store).
- **Settings validation matters.** A user who edits localStorage
  manually, or whose stored settings predate a schema change,
  shouldn't crash the app on load. Per-field fallback to default
  is the discipline.
- **Live theme preview without reload.** If you implement settings-
  changed events, the listener has to be defensive — applying a
  theme to xterm.js while the worker is mid-boot must not break
  the boot. The theme applies to the *terminal*, not the worker;
  this should be safe but verify.
- **Upload size validation.** Without a sanity limit, a user
  uploading a multi-gigabyte file blocks the main thread on
  ArrayBuffer conversion. 10 MB cap (configurable as a constant for
  9.3's hard-disk images) prevents accidents.
- **Phase 9.3 forward-compat.** The `source: 'upload' | 'github'`
  type union exists so 9.3 doesn't need a migration. Don't widen
  the union prematurely; just declare it as a discriminator and
  let TypeScript track it.
- **The bundled image must always be selectable.** If a user
  deletes all library entries while their setting points to one of
  them, fallback to bundled cleanly. The Section 2 validation step
  handles this; verify it.
- **Modal accessibility.** Esc to close, focus trapped inside the
  modal while open, focus returns to the gear button on close. Not
  optional even for a v0 — these are 10 lines of code and fixing
  them later is harder.
- **xterm.js font sizing.** Changing `term.options.fontSize`
  doesn't auto-fit the terminal to the container. Call
  `term.fit()` (from `@xterm/addon-fit`) after font changes if the
  fit addon is in use; otherwise the terminal stays at its previous
  cell grid and the text overflows. Check Phase 9's xterm setup.
- **`navigator.storage.estimate()` availability.** Not in all
  browsers / environments (older Safari, some private modes). Code
  defensively; show "unknown" if unavailable.

## Definition of done

**Implementation success:**

- `npm run dev:browser` — open the page, click the gear, modal
  opens.
- Change font size — terminal updates live.
- Change theme — terminal updates live.
- Upload a `.img` — appears in the library list.
- Pick "Boot this on next reload" on the upload — reload — the new
  image boots in xterm.
- Pick "Default (bundled)" — reload — bundled image boots.
- Delete a library entry — gone from list, IDB freed.
- Rename a library entry — name updates.
- Storage usage shows reasonable values.
- Esc closes the modal; gear button regains focus.

**Test counts:**

- All 1,135 prior tests pass.
- Image library: ~6-10 new cases.
- Settings: ~4-6 new cases.
- Themes: ~2-3 new cases.
- Total ≥ 1,150.

**Verification:**

- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).
- Manual UI verification per the success list above.
- Release snapshot at `releases/phase-9-2-polish/` populated and
  manually launch-verified.

The report at `BROWSER_POLISH_REPORT.md` has these sections:

- **Summary**: outcome, key technical choices.
- **Image library**: schema, IDB layout, why this DB name, why
  Uint8Array vs Blob.
- **Settings store**: localStorage layout, validation strategy,
  live-update mechanism.
- **Theme presets**: which 5, the ITheme for each, citation if any
  preset comes from a published theme.
- **UI**: modal structure, key bindings, accessibility notes.
- **Upload flow**: validation rules, size cap, error UX.
- **Worker-host integration**: which option (A or B) was chosen
  and why.
- **What's deferred**: GitHub browser (9.3), hard-disk image
  support (9.3), per-color customisation, mobile layout, drag-and-
  drop if not implemented.
- **Things future briefs should address**:
  - **Phase 9.3: GitHub release browser** — the user has captured
    scope: fetch from `ghaerr/elks` releases via GitHub API,
    populate the same library with `source: 'github'` entries,
    optionally support release candidates / prereleases. Diagnosis
    questions for that brief: CORS on `api.github.com` and asset
    download URLs; which asset types (floppy / hard-disk / DOC) are
    surfaced; how to filter by serial-console compatibility (or
    accept that some won't boot in our harness and document); IDB
    quota implications for larger images including hard-disk
    builds. Phase 9.2's library schema includes `source` to allow
    this without a migration.
  - CGA-canvas renderer for graphics-mode guests.
  - Network device (NE2000) toward SSH-style access.
  - Snapshot / restore of running machine state.
  - Hard-disk image support (currently floppy-only at the machine
    layer).
- **CPU/memory bug candidates**: should be none — no engine code
  changed. Note if anything surfaced.
- **Release snapshot**: layout, launch commands, verification
  outputs.
- **Verification**: exact commands and outputs.

## Release snapshot

After all verification commands pass and before writing the report,
copy the working artefacts to a self-contained release folder.

Layout:

```
releases/phase-9-2-polish/
├── README.md                # launch commands + what's new
├── package.json             # copy of root manifest
├── package-lock.json        # copy of root lockfile
├── dist-cli/                # compiled Node CLI tools
├── dist-web/                # Vite production bundle
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied. The release shares the repo
root's installed dependencies.

Verify the snapshot is launchable manually:
- Launch the Node serial harness from within the release folder;
  confirm it boots to `# `.
- Launch a static server against `dist-web/`; open in browser;
  verify the gear icon, modal, upload, and boot-from-library all
  work.

Document both verification outputs in the report.

## Reference sources

1. **`web/main.ts`** — current main-thread bootstrap. You'll
   modify it to wire the gear icon, settings load, image source
   resolution.
2. **`web/index.html`** — current minimal HTML. Add the gear, modal
   container, basic styling.
3. **`src/browser/protocol.ts`** — current message types. Check
   what `BootMessage` accepts; extend only if necessary.
4. **`src/disk/idb-page-store.ts`** — reference for IDB usage
   patterns and to confirm the page store's DB name (so you pick a
   distinct one for the library).
5. **xterm.js docs** at https://xtermjs.org — `Terminal.options`
   for font/theme, `ITheme` interface, the fit addon if present.
6. **MDN IndexedDB** for the library implementation; **MDN
   Storage Quota** for the usage estimate.

## Final notes

The discipline this brief asks for: **don't expand into the GitHub
browser**. It's the obvious adjacent feature and it's been
explicitly scoped to Phase 9.3 because it has its own diagnosis
questions (CORS, asset filtering, format compatibility). Get the
library substrate right with one source first; the second source
slots in cleanly when its time comes.

Also: **don't reach for a UI framework**. Vanilla DOM is correct
for this size of UI. The temptation to "just add React for the
modal" is real and would expand bundle size, dependency footprint,
and the learning surface for anyone reading the code later. The
modal is ~200 lines of TypeScript. Plain DOM.

After this lands, Phase 9.3 takes the library substrate built here
and adds the GitHub releases source. The user's interest is
specifically in evaluating whether large ELKS images with inbuilt
toolchains are viable in our emulator — that evaluation begins once
the library can hold them.
