# emu86 — Phase 9.2 release: settings + local image upload

Self-contained snapshot of the Phase 9.2 deliverable. Same Node and
Vite-bundled browser artefacts as Phase 9.1, plus a settings modal
(font size, theme, default boot image) and an IDB-backed library of
user-uploaded floppy images.

```
phase-9-2-polish/
├── README.md                    # this file
├── package.json                 # copy of root manifest
├── package-lock.json            # copy of root lockfile
├── dist-cli/                    # compiled Node CLI tools
│   └── tools/elks/{run.js, run-serial.js}
├── dist-web/                    # Vite production bundle (gear + modal)
│   ├── index.html
│   ├── elks-serial.img          # 1.44 MB floppy fetched at boot (default)
│   └── assets/{index,worker}-*.js
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies; run from inside the release folder once the root
has `npm install`-ed.

## Launch — Node serial harness

```
cd releases/phase-9-2-polish
node dist-cli/tools/elks/run-serial.js
```

Unchanged from Phase 9.1. The ELKS Setup banner prints first, then the
kernel redirects to ttyS0 and the rest of the boot streams via the
UART. `Ctrl-A x` quits.

## Launch — Browser harness

The bundle is plain static assets; any HTTP server works.

```
# Option A: vite preview (uses the project's installed Vite)
cd releases/phase-9-2-polish
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-9-2-polish/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/` in Firefox or Chrome. The ELKS Setup
banner streams immediately into xterm.js. Click the **⚙ gear** in the
top-right corner to open the settings modal: change font size or theme
live, upload your own `.img`, and pick a different boot image for the
next reload.

`file://` will not work — `fetch('/elks-serial.img')` fails on a
non-HTTP origin. Use one of the two server commands above.

## What's new in Phase 9.2

- **Settings panel.** Top-right gear opens a modal: font size (8–32 px),
  theme (5 presets), default boot image. Font and theme update live;
  image source applies on next reload.
- **Theme presets.** `default-dark`, `default-light`, `solarized-dark`,
  `solarized-light`, `amber-crt`. Each is a complete `xterm.ITheme`.
- **Local image library.** Upload a floppy `.img`, give it a name,
  pick it as the boot source. Stored in IndexedDB (`emu86-images`,
  distinct from the Phase 6 page store at `emu86-pages`). Per-entry
  rename and delete. The bundled `/elks-serial.img` is always the
  fallback and cannot be deleted.
- **Storage usage.** A line in the modal shows
  `usedBytes / quotaBytes` from `navigator.storage.estimate`.
- **No emulator-side changes.** The CPU loop, BIOS, devices, machine
  wiring, worker host, and BrowserConsole are untouched. Phase 9.2 is
  main-thread UI plumbing only.

See `BROWSER_POLISH_REPORT.md` at the repo root for the design notes,
schema, and verification outputs.
