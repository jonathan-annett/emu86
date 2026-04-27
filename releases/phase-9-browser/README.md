# emu86 — Phase 9 release: browser harness

Self-contained snapshot of the Phase 9 deliverables. Both Node and browser
harnesses ship together; choose your launch from the table below.

```
phase-9-browser/
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

## Launch — Node CGA harness (Phase 7)

```
cd releases/phase-9-browser
node dist-cli/tools/elks/run.js
```

Boots `reference/elks-images/fd1440-minix.img` with the CGA framebuffer
mirrored to stdout. ANSI-styled. `Ctrl-A x` quits.

## Launch — Node serial harness (Phase 8)

```
cd releases/phase-9-browser
node dist-cli/tools/elks/run-serial.js
```

Boots `reference/elks-images-serial/fd1440-fat-serial.img` with
`console=ttyS0` and `init=/bin/sh`. UART TX → stdout, stdin → UART RX.
`Ctrl-A x` quits.

## Launch — Browser harness (Phase 9)

The bundle is plain static assets; any HTTP server works. Two known-
working invocations:

```
# Option A: vite preview (uses the project's installed Vite)
cd releases/phase-9-browser
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-9-browser/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/` in Firefox or Chrome. Wait a few seconds
(early-printk runs before the kernel redirects to ttyS0; nothing prints
during that window). Once the kernel banner streams, the `# ` prompt
follows. Type a command and hit Enter — keystrokes flow as raw UART RX
bytes through the kernel's tty line discipline.

`file://` will not work — `fetch('/elks-serial.img')` fails on a
non-HTTP origin. Use one of the two server commands above.

## What changed in Phase 9

- **First runnable browser deployment.** xterm.js terminal on the main
  thread; emulator running in a Web Worker. UART TX bytes coalesced into
  postMessage chunks; keystrokes routed straight to the UART RX FIFO.
- **No CGA-canvas renderer.** Phase 9 is serial-only. A graphics-mode
  display in the browser is a future brief.
- **No new emulator behaviour.** The CPU loop, BIOS, devices, and
  machine wiring are untouched from Phase 8. Phase 9 added plumbing only.

See `BROWSER_HARNESS_REPORT.md` at the repo root for the architecture and
verification details.
