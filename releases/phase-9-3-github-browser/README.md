# emu86 — Phase 9.3 release: GitHub releases browser + viability tags

Self-contained snapshot of the Phase 9.3 deliverable. Builds on Phase 9.2
(settings + local image upload) by adding a GitHub releases browser that
fetches `ghaerr/elks` releases at runtime, lists `.img` assets across the
latest stable + the most recent prereleases (toggle), and downloads
selected assets straight into the IDB image library with a viability tag
(`Likely works` / `Untested` / `Known incompatible`).

```
phase-9-3-github-browser/
├── README.md                    # this file
├── package.json                 # copy of root manifest
├── package-lock.json            # copy of root lockfile
├── dist-cli/                    # compiled Node CLI tools
│   └── tools/elks/{run.js, run-serial.js}
├── dist-web/                    # Vite production bundle (gear + modal + GitHub pane)
│   ├── index.html
│   ├── elks-serial.img          # 1.44 MB floppy fetched at boot (default)
│   └── assets/{index,worker}-*.{js,css}
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies; run from inside the release folder once the root
has `npm install`-ed.

## Launch — Node serial harness

```
cd releases/phase-9-3-github-browser
node dist-cli/tools/elks/run-serial.js
```

Unchanged from Phase 9.2. The ELKS Setup banner prints first, then the
kernel redirects to ttyS0 and the rest of the boot streams via the
UART. `Ctrl-A x` quits.

## Launch — Browser harness

The bundle is plain static assets; any HTTP server works.

```
# Option A: vite preview (uses the project's installed Vite)
cd releases/phase-9-3-github-browser
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-9-3-github-browser/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/` in Firefox or Chrome. Click the **⚙ gear**
in the top-right corner. Inside the **Boot image** section there is now
an **ELKS releases (GitHub)** disclosure — open it to fetch the live
release list, browse `.img` assets, and download one into the local
image library.

`file://` will not work — `fetch('/elks-serial.img')` fails on a
non-HTTP origin. Use one of the two server commands above.

## What's new in Phase 9.3

- **GitHub releases pane.** Disclosure inside Settings → Boot image. On
  open, fetches `https://api.github.com/repos/ghaerr/elks/releases` and
  caches the parsed list in `localStorage` for 10 minutes. Lists the
  latest stable release plus (when toggled on) the 5 most-recent
  prereleases. Each release card shows tag, date, optional notes, and an
  asset list filtered to `*.img`.
- **Viability tags.** Each asset is classified by filename and size:
  - `Likely works` — `fd*-fat-serial.img` (the harness's known-good shape).
  - `Known incompatible` — `hd*.img` *or* anything > 10 MB (the floppy
    geometry table caps out there; see hard-disk diagnosis in
    `GITHUB_BROWSER_REPORT.md`).
  - `Untested` — everything else (other `fd*` shapes, unknown filenames).
- **Per-asset download.** Streams via `fetch().body.getReader()` with a
  throttled progress callback (≥64 KB or ≥100 ms between updates). On
  success the bytes are written into the existing `emu86-images` IDB
  store with `source: 'github'` and the resolved viability tag.
- **Quota guard.** Before download, checks `navigator.storage.estimate`
  and warns if the new asset would push usage past 80 % of the quota.
- **Size cap.** A confirmation prompt at 100 MB (the asset metadata is
  visible before the prompt fires, so the user always sees the size
  ahead of clicking through).
- **Image library row sub-line** now shows `source · uploaded date · tag`
  for github-sourced entries; upload entries are unchanged.
- **No emulator-side changes.** CPU loop, BIOS, devices, machine
  wiring, worker host, and BrowserConsole are untouched. The IDB
  schema added one optional field (`viability`); a github-sourced
  entry round-trips through `addImage` / `listImages` / `getImageBytes`
  identically to an upload.

## Hard-disk note

`hd*.img` assets are present in the upstream releases and are surfaced
in the list, but they are tagged **Known incompatible** because the
emulator's harness today cannot boot them. The *why* and the shape of
the work needed to support them is documented in detail in
`GITHUB_BROWSER_REPORT.md` (Section 4). The summary: the BIOS boot
path (INT 19h), INT 13h disk-info return values, and the worker
host's geometry table all assume floppy and would need coordinated
changes in source areas that are outside the scope of this phase.

See `GITHUB_BROWSER_REPORT.md` at the repo root for the full design
notes, test plan, and verification outputs.
