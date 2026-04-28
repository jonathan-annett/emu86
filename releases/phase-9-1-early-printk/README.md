# emu86 — Phase 9.1 release: early-printk to xterm

Self-contained snapshot of the Phase 9.1 deliverable. Same artefacts as
Phase 9, with the early-printk window now visible in the browser
harness from the first batch of boot output rather than reappearing
after a multi-second blank.

```
phase-9-1-early-printk/
├── README.md                    # this file
├── package.json                 # copy of root manifest
├── package-lock.json            # copy of root lockfile
├── dist-cli/                    # compiled Node CLI tools
│   └── tools/elks/{run.js, run-serial.js}
├── dist-web/                    # Vite production bundle
│   ├── index.html
│   ├── elks-serial.img          # 1.44 MB floppy fetched at boot
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
cd releases/phase-9-1-early-printk
node dist-cli/tools/elks/run-serial.js
```

Boots `reference/elks-images-serial/fd1440-fat-serial.img` with
`console=ttyS0` and `init=/bin/sh`. UART TX → stdout, stdin → UART RX.
The ELKS Setup banner prints first (BIOS INT 10h teletype path through
`NodeConsole.writeChar`), then the kernel redirects to ttyS0 and the
rest of the boot streams via the UART. `Ctrl-A x` quits.

## Launch — Browser harness

The bundle is plain static assets; any HTTP server works.

```
# Option A: vite preview (uses the project's installed Vite)
cd releases/phase-9-1-early-printk
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-9-1-early-printk/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/` in Firefox or Chrome. The ELKS Setup
banner now appears almost immediately (no 3-second blank window): the
worker host's shared TX buffer carries both the BIOS console
`writeChar` stream and the post-`set_console` UART TX stream into the
same `tx` postMessage channel that xterm.js renders. Type a command and
hit Enter — keystrokes flow as raw UART RX bytes through the kernel's
tty line discipline.

`file://` will not work — `fetch('/elks-serial.img')` fails on a
non-HTTP origin. Use one of the two server commands above.

## What changed in Phase 9.1

- **Closed the early-printk dead window.** ELKS's `early_putchar`
  (crt0.S) uses BIOS INT 10h AH=0x0E for IBM PC; the worker host's
  Phase 9 wiring already routed `BrowserConsole.writeChar` into the
  shared TX buffer, but no test asserted the invariant and the welcome
  message in `web/main.ts` still warned users about a window that no
  longer existed. Phase 9.1 pins down the wiring with unit + integration
  tests and refreshes the welcome text.
- **No new emulator behaviour.** The CPU loop, BIOS, devices, machine
  wiring, and worker-host plumbing are untouched. The only source
  change beyond tests is `web/main.ts` (welcome text).

See `EARLY_PRINTK_REPORT.md` at the repo root for the diagnosis and
verification details.
