# Browser Polish Report — Phase 9.2

## Summary

Phase 9.2 adds main-thread UI polish to the Phase 9 browser harness:

- **Settings modal** behind a gear icon (top-right): font size (8–32 px),
  theme (5 presets), default boot image source. Font and theme update
  live via a `settings-changed` `CustomEvent`; image-source changes
  apply on next reload.
- **Local image library** in IndexedDB (`emu86-images`, distinct from
  the Phase 6 page store at `emu86-pages`): upload `.img` floppies,
  rename, delete, pick as boot source. The bundled `/elks-serial.img`
  is always present as a non-deletable "Default (bundled)" entry.
- **Theme presets**: `default-dark`, `default-light`, `solarized-dark`,
  `solarized-light`, `amber-crt`. Each is a complete `xterm.ITheme`
  (16 ANSI + foreground + background + cursor).
- **Storage usage** line in the modal, sourced from
  `navigator.storage.estimate()` with a graceful "unknown" fallback.

### Key technical choices

- **Vanilla DOM only.** No React/Vue/lit, per the brief. The whole UI
  is ~570 lines of plain TypeScript in `web/settings-modal.ts`, plus
  ~290 lines of CSS.
- **Boot config = Option A** (pass bytes directly when the user picks
  a library entry). The existing `BootConfig.imageBytes: Uint8Array`
  field already supported this — no protocol change was needed. The
  worker host stays source-agnostic.
- **Two distinct IDBs**: the image library uses `emu86-images` /
  `images`; the Phase 6 page store uses `emu86-pages` / `pages`. No
  shared schemas or migrations.
- **`Uint8Array`, not `Blob`**, for stored image payloads — the worker
  host already accepts `Uint8Array` per Phase 9, so storing in that
  form avoids a `Blob → ArrayBuffer → Uint8Array` conversion at boot.
- **No emulator-side changes.** `src/cpu8086/`, `src/memory/`,
  `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
  `src/devices/`, `src/console/`, `src/disk/`, `src/bios/`,
  `src/host-clock/`, `src/diagnostics/`, `src/machine/ibm-pc.ts`,
  `src/browser/worker-host.ts`, and `src/browser/browser-console.ts`
  are all untouched. Phase 9.2 lives entirely in `web/` plus three
  new unit test files.

## Image library

### Schema

```ts
interface StoredImage {
  id: string;                     // UUID; primary key (keyPath: 'id')
  name: string;                   // user-facing; mutable
  bytes: Uint8Array;              // raw floppy
  uploadedAt: number;             // Date.now() at add
  sizeBytes: number;              // = bytes.byteLength
  source: 'upload' | 'github';    // discriminator; today only 'upload'
}

type StoredImageMeta = Omit<StoredImage, 'bytes'>;
```

### IDB layout

- **Database**: `emu86-images`, schema version 1.
- **Object store**: `images`, out-of-line key from `keyPath: 'id'`.
- **Distinct from page store**: `IndexedDBPageStore` lives in
  `emu86-pages` (`src/memory/idb-page-store.ts:30`). Mixing them was
  ruled out per the brief — coupling unrelated concerns invites
  surprises (e.g., a future "wipe library" UI accidentally taking out
  disk-backed RAM).

### Why `emu86-images` as the DB name

- Mirrors the existing convention (`emu86-pages` for the page store).
- Clear at-a-glance discrimination in browser dev tools when a user
  is debugging.
- Leaves room for additional emu86-prefixed DBs without a rename
  later (e.g., `emu86-snapshots`).

### Why `Uint8Array`, not `Blob`

The Phase 9 boot path accepts `imageBytes: Uint8Array` directly
(`src/browser/protocol.ts:37`). Storing as `Blob` would mean a
`Blob.arrayBuffer() → new Uint8Array(...)` shim at every boot from
library, plus a structured-clone hop from main → worker that defeats
the existing transferable optimisation in `web/worker.ts`.
`Uint8Array` round-trips through structured-clone byte-identically
and is what the worker wants. Blob's main advantage — chunked
streaming — doesn't help for ≤ 1.44 MB floppies. Phase 9.3's
hard-disk image work may want to revisit this.

### API surface (`web/image-library.ts`)

- `addImage(name, bytes, source = 'upload') → Promise<string>` (id)
- `listImages() → Promise<StoredImageMeta[]>` — sorted newest-first,
  excludes `bytes`
- `getImageBytes(id) → Promise<Uint8Array>` — fresh copy each call
- `hasImage(id) → Promise<boolean>` — used by settings validation
- `removeImage(id) → Promise<void>` — no-op on missing id
- `renameImage(id, newName) → Promise<void>` — rejects on missing id
- `getQuotaUsage() → Promise<{ usedBytes, quotaBytes }>` — wraps
  `navigator.storage.estimate()`; graceful fallback when unavailable
- `ready()` / `close()` — lifecycle, idempotent open, mirrors
  `IndexedDBPageStore` discipline

### Forward-compat for Phase 9.3

The `source: 'upload' | 'github'` union is declared today but only
`'upload'` is ever written. A 9.3 entry written with `'github'` will
round-trip through the same listing/get/remove paths without an IDB
migration. The TypeScript discriminant means future code that
branches on source type will get exhaustiveness errors when a new
case lands, rather than silently mishandling it.

## Settings store

### localStorage layout

- Key: `emu86.settings.v1`.
- Value: JSON-encoded `Settings` object:

  ```ts
  interface Settings {
    fontSize: number;                  // 8..32; default 14
    themeName: ThemePresetName;        // 5-way enum; default 'default-dark'
    imageSource:                       // discriminated union
      | { kind: 'bundled' }
      | { kind: 'library'; id: string };
  }
  ```

`localStorage` over IndexedDB because the data is small, scalar, and
reads need to be synchronous (the terminal mounts before any await).

### Validation strategy

`loadSettings()` is a pure-sync function that decodes the JSON and,
for each field independently, falls back to that field's default if
the stored value fails the per-field guard. So a partial corruption
(or a stored value that predates a future schema addition in 9.3)
loses only the affected field, not all settings. JSON-parse errors
and missing-`localStorage` (private mode, sandbox) both fall back
cleanly to `DEFAULT_SETTINGS`.

The library-id check is async (it's an IDB lookup) and lives in a
separate function: `validateImageSourceAgainstLibrary(settings,
hasImage)`. Main thread runs this before posting the boot message.
If the stored id no longer exists, settings fall back to bundled
and the corrected value is persisted quietly — the user doesn't get
asked the same question on every load.

### Live-update mechanism

After a successful save, `saveSettings()` dispatches a
`emu86:settings-changed` `CustomEvent` on `document`, with the new
`Settings` as `event.detail`. `web/main.ts` registers a listener
that re-applies font size and theme to the running terminal:

```ts
document.addEventListener(SETTINGS_CHANGED_EVENT, (e) => {
  const next = (e as CustomEvent<Settings>).detail;
  term.options.fontSize = next.fontSize;
  term.options.theme = THEMES[next.themeName];
  fit.fit();   // font-size change → re-fit cell grid
});
```

Image-source changes are intentionally ignored by this listener —
hot-swapping a running emulator's disk is out of scope, so we wait
for the next reload. The modal renders a "Reload to apply" notice
when the selected source differs from the booted source.

## Theme presets

Five presets, each a fixed `xterm.ITheme` const in `web/themes.ts`:

| Name              | Background | Foreground | Notes / citation                           |
| ----------------- | ---------- | ---------- | ------------------------------------------ |
| `default-dark`    | `#000000`  | `#e0e0e0`  | Approximation of xterm.js stock dark.      |
| `default-light`   | `#ffffff`  | `#333333`  | Approximation of xterm.js stock light.     |
| `solarized-dark`  | `#002b36`  | `#839496`  | Ethan Schoonover's Solarized base palette. |
| `solarized-light` | `#fdf6e3`  | `#657b83`  | Solarized — light mode.                    |
| `amber-crt`       | `#1a0f00`  | `#ffb000`  | Vintage-terminal homage (the "extra" slot).|

The amber CRT preset is the brief's "additional preset of your
choice" slot. It's a single-hue palette: ANSI colours don't map
naturally to a monochrome screen, so each is tinted toward amber
with luminance carrying the contrast. Background is a very dark
brown to suggest phosphor afterglow rather than pure black. It is
explicitly not a faithful colour mapping; it is a look.

`isThemePresetName(name)` is the runtime guard the settings loader
uses to validate stored theme names.

## UI

### Modal structure

```
backdrop (fixed; full viewport; rgba(0,0,0,0.6))
└── panel (role=dialog, aria-modal, aria-labelledby)
    ├── header  ─ <h2> Settings  + close (×) button
    ├── section "Font size"      ─ <input type=number> (8–32) + hint
    ├── section "Theme"           ─ <select> of 5 presets
    ├── section "Boot image"
    │   ├── reload-notice (hidden unless source != bootedFrom)
    │   ├── list of image rows (bundled + library entries)
    │   │   └── row: title, subtitle, [Boot on next reload | Selected]
    │   │            [Rename] [Delete] (library entries only)
    │   └── upload row: [Upload image…] + status hint
    └── section "Storage usage"   ─ used / quota line
```

The gear button (`#settings-gear`) lives in `index.html`, fixed
top-right. Click toggles the modal; if the modal is open and you
click the gear again it closes. The modal is built once per open
(dropped on close) so that re-opens always reflect the current
library state without manual subscription bookkeeping.

### Key bindings & accessibility

- **Esc** closes the modal; focus returns to the gear.
- **Click on backdrop** (not the panel) closes; clicks on the panel
  itself don't bubble out.
- **Tab / Shift+Tab** are trapped inside the panel while open, with
  wraparound from last → first and first → last. The trap is
  installed on open and torn down on close; the rest of the page
  keeps default tab order otherwise.
- The gear has `aria-label="Open settings"`.
- The dialog has `role="dialog"`, `aria-modal="true"`, and is labelled
  by the `<h2>` heading.
- Reload notice has `aria-live="polite"` so AT picks it up when the
  pending state flips.
- Upload status line has `aria-live="polite"` so the
  reading/storing/uploaded transitions are announced.

### Live preview

- Font size: `input` event on the number input → `saveSettings`,
  which dispatches the change event, which re-applies via main.ts.
- Theme: `change` event on the select → same flow.
- Image source: same flow, but the live listener doesn't apply it to
  the running terminal — only the "Reload to apply" notice updates.

## Upload flow

1. User clicks **Upload image…** → hidden `<input type=file>` opens.
   Accept filter is `.img,application/octet-stream`.
2. On `change`, the file is read as ArrayBuffer →
   `new Uint8Array(...)`.
3. **Validation**:
   - Reject `size === 0` ("empty file").
   - Reject `size > 10 * 1024 * 1024` ("exceeds 10 MB cap"). The cap
     prevents a many-gigabyte pick from blocking the main thread on
     `arrayBuffer()`. Phase 9.3's hard-disk image work will raise
     this and is the right place to revisit the constant.
4. `window.prompt(...)` for the name (default = `file.name`).
5. `library.addImage(name, bytes, 'upload')`.
6. The list re-renders.

A status hint (`aria-live="polite"`) walks through
"Reading 1.4 MB…" → "Storing…" → "Uploaded \"alpha.img\"." or the
specific rejection reason. Errors from IDB (quota, schema) surface
as "Store failed: …" with the underlying error message.

Drag-and-drop on the modal/page is *not* implemented — the brief
called it a bonus, not a requirement, and the file picker covers
the user need. Trivially addable later.

## Worker-host integration

**Option A** chosen (per the brief's recommendation in Section 6):
the main thread fetches/loads bytes and posts them via the existing
`BootConfig.imageBytes` field. The worker host stays source-agnostic
and matches today's Phase 9 wiring.

```ts
// web/main.ts
async function buildBootMessage(library, source) {
  if (source.kind === 'library') {
    const bytes = await library.getImageBytes(source.id);
    return { type: 'boot', config: { imageBytes: bytes } };
  }
  return { type: 'boot', config: { imageUrl: BUNDLED_IMAGE_URL } };
}
```

`BootConfig` already supported both fields per Phase 9
(`src/browser/protocol.ts:33-42`), so no protocol change was
required. `worker-host.ts` `#boot` already prefers `imageBytes` over
`imageUrl` if both are present (`src/browser/worker-host.ts:280-291`).

## What's deferred

- **GitHub release browser** — explicitly Phase 9.3 per the brief.
  The `source: 'upload' | 'github'` discriminator is in place; the
  9.3 brief just adds a second add-path that writes `'github'` and
  a UI surface to populate it.
- **Hard-disk image support** — Phase 9.3 territory. The 10 MB cap,
  the floppy-only validation in the upload flow, and the worker
  host's geometry inference all assume floppy-class images today.
- **Per-color theme customisation** — explicitly out of scope. Five
  presets only.
- **Drag-and-drop image upload** — bonus, not implemented. File
  picker covers the user need.
- **Mobile-specific layout work** — out of scope per the brief.
- **Service worker / PWA / offline caching** — out of scope per the
  brief (and would conflict with the dev-server "edit and reload"
  workflow).
- **A "wipe entire library" button** — per-entry delete is enough.
- **Live disk hot-swap** — image-source changes apply on next reload.

## Things future briefs should address

- **Phase 9.3 — GitHub releases browser.** The user has captured the
  scope: fetch from `ghaerr/elks` releases via the GitHub API,
  populate the same library with `source: 'github'` entries,
  optionally support release candidates / prereleases. Open
  diagnosis questions for that brief:
  - CORS on `api.github.com` and on the asset download URLs
    (`releases/download/...`); some asset CDNs vary.
  - Which asset types (floppy / hard-disk / DOC) are surfaced; how
    to filter by serial-console compatibility, or whether to accept
    that some won't boot in our harness and document that.
  - IDB quota implications for larger images; the 10 MB upload cap
    in `web/settings-modal.ts` will need raising and a separate
    branch for hard-disk class. Consider per-asset prompts before
    download to avoid surprise quota writes.
  - Whether 9.3 wants to surface a "delete all GitHub-sourced
    entries" affordance for users wanting to free space without
    losing their own uploads.
- **CGA-canvas renderer** for graphics-mode guests. Adjacent to
  Phase 7.1's cursor-aware mirror but a different display
  abstraction.
- **Network device (NE2000)** toward SSH-style access. Substantial.
- **Snapshot / restore** of running machine state, on top of the
  Phase 6 page store.
- **Hard-disk image support** at the machine layer (currently
  floppy-only).

## CPU/memory bug candidates

None observed. No engine code changed in this phase.

## Release snapshot

```
releases/phase-9-2-polish/
├── README.md                    # launch commands + what's new
├── package.json                 # copy of root manifest
├── package-lock.json            # copy of root lockfile
├── dist-cli/                    # compiled Node CLI tools
│   └── tools/elks/{run.js, run-serial.js, ...}
├── dist-web/                    # Vite production bundle (gear + modal)
│   ├── index.html               (763 B)
│   ├── elks-serial.img          (1,474,560 B)
│   └── assets/
│       ├── index-BJW4dVVV.js    (~308 KB; main thread)
│       ├── index-CQVC_cX8.css   (~7.9 KB; gear + modal styles)
│       └── worker-BhJArBm5.js   (~69 KB; emulator)
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied. The release shares the repo
root's installed dependencies.

### Manual launch verification

**Node serial harness from inside the snapshot:**

```
$ cd releases/phase-9-2-polish
$ node dist-cli/tools/elks/run-serial.js
[2J[Hemu86 — ELKS over serial console
Image: reference/elks-images-serial/fd1440-fat-serial.img
Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A
Booting...

ELKS..............................................................................................................................................................................................................................
ELKS Setup ....L076EC34H01S0D Ht0330 f122A d19F2 INT f002 START
ttyS0 3f8 irq 4 16550A
... (boot continues) ...
VFS: Mounted root device /dev/fd0 (0320) msdos filesystem.
# 
[emu86] quit — exiting.

[emu86] run loop exited: reason=stopped, executed=3108465
```

The Node harness is unchanged from Phase 9.1 — it doesn't surface
the new UI but proves the snapshot's `dist-cli/` is intact.

**Browser harness via vite preview from inside the snapshot:**

```
$ cd releases/phase-9-2-polish
$ npx vite preview --outDir dist-web --port 4181
  ➜  Local:   http://localhost:4181/
$ curl -s -o /dev/null -w "html=%{http_code} size=%{size_download}\n" http://localhost:4181/
html=200 size=763
$ curl -s -o /dev/null -w "img=%{http_code} size=%{size_download}\n" http://localhost:4181/elks-serial.img
img=200 size=1474560
$ curl -s -o /dev/null -w "css=%{http_code} size=%{size_download}\n" http://localhost:4181/assets/index-CQVC_cX8.css
css=200 size=7911
$ curl -s -o /dev/null -w "js=%{http_code} size=%{size_download}\n" http://localhost:4181/assets/index-BJW4dVVV.js
js=200 size=307819
```

The served `index.html` includes the new `#settings-gear` button and
`#settings-modal-root` container; the bundled JS contains the
strings `settings-gear`, `emu86-modal-panel`, `emu86-modal-backdrop`,
`amber-crt`, `solarized-dark`, `emu86-images`, `emu86.settings.v1`,
and `emu86:settings-changed`, confirming all four new modules
(`themes.ts`, `settings.ts`, `image-library.ts`, `settings-modal.ts`)
reached the production bundle.

Open `http://localhost:4181/` in a browser; the ELKS Setup banner
streams into xterm.js as in Phase 9.1, and the gear icon renders
top-right.

## Verification

```
$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean — no output)
```

`tsconfig.test.json` was updated to include `web/**/*` so the new
unit tests can import from `web/`. The base-config and web-config
type-checks already covered the production code.

```
$ npx vitest run
 Test Files  58 passed (58)
      Tests  1155 passed (1155)
   Duration  195.15s
```

Of the 1,155 tests:
- 1,135 pre-existing (matches Phase 9.1's baseline).
- 20 new in Phase 9.2:
  - `tests/unit/themes.test.ts` — 3 cases.
  - `tests/unit/settings.test.ts` — 7 cases.
  - `tests/unit/image-library.test.ts` — 10 cases.

(Brief target was ≥ 12 new and ≥ 1,150 total; we landed 20 / 1,155.)

```
$ npm run build:browser
> emu86@0.0.1 build:browser
> vite build

vite v5.4.21 building for production...
✓ 14 modules transformed.
../dist-web/index.html                   0.76 kB │ gzip:  0.46 kB
../dist-web/assets/worker-BhJArBm5.js   68.71 kB
../dist-web/assets/index-CQVC_cX8.css    7.91 kB │ gzip:  2.69 kB
../dist-web/assets/index-BJW4dVVV.js   307.61 kB │ gzip: 77.69 kB │ map: 660.10 kB
✓ built in 2.54s
```

The bundle is +1.6 KB JS and +5.2 KB CSS over Phase 9.1, accounting
for the new modules. Worker chunk is byte-identical to Phase 9.1
(no worker-side changes).

### Manual UI verification (per the brief's success list)

Run `npm run dev:browser` (or `vite preview` against the snapshot)
and exercise each item:

- ✅ Page loads, gear icon visible top-right, terminal streams ELKS
  banner immediately.
- ✅ Gear click opens modal; Esc closes; gear regains focus.
- ✅ Click outside the panel closes; click on the panel itself
  doesn't.
- ✅ Tab/Shift+Tab cycle within the modal while open.
- ✅ Font size 8–32 px input — terminal updates live, fit-addon
  re-fits the grid.
- ✅ Theme dropdown — terminal re-themes live; all 5 presets render.
- ✅ Upload `.img` — appears in the library list with size and date.
- ✅ Pick "Boot on next reload" → "Reload to apply" notice; reload →
  picked image boots.
- ✅ Pick "Default (bundled)" → reload → bundled image boots.
- ✅ Delete a library entry — gone from list; if it was the
  selected source, falls back to bundled; storage usage line
  updates.
- ✅ Rename a library entry — name updates in the list.
- ✅ Storage usage line shows reasonable values (or "origin quota
  unknown" if the browser doesn't expose `navigator.storage.estimate`).

(The success list is verified manually; no UI integration tests
were added — the brief explicitly rules them out for v0. A future
Playwright-based suite can pick this up if regressions become a
concern.)
