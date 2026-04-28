# emu86 — Phase 10.2 release: ELKS partitionless MINIX HD boot

Self-contained snapshot of the Phase 10.2 deliverable. Phase 10 verified
the partitionless **FAT** hard-disk path; Phase 10.1 verified MBR-
partitioned **FAT** and **MINIX**; this phase fills the remaining cell
in the matrix — partitionless **MINIX** (`hd32-minix.img`) — using the
same substrate, with no source-code changes.

```
phase-10-2-minix-hd/
├── README.md                              # this file
├── package.json                           # copy of root manifest
├── package-lock.json                      # copy of root lockfile
├── dist-cli/                              # compiled Node CLI tools
│   └── tools/
│       ├── elks/{run.js, run-serial.js}
│       └── elks-build/{build-serial-image.js, fetch-hd-image.js}
├── dist-web/                              # Vite production bundle
│   ├── index.html
│   ├── elks-serial.img                    # 1.44 MB floppy (default boot)
│   └── assets/{index,worker}-*.{js,css}
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    ├── elks-images-hd/hd32-fat.img        # Phase 10 — partitionless FAT16
    ├── elks-images-hd/hd32mbr-fat.img     # Phase 10.1 — MBR-partitioned FAT16
    └── elks-images-hd/hd32-minix.img      # Phase 10.2 — partitionless MINIX
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies; run from inside the release folder once the
root has `npm install`-ed.

The MBR-MINIX fixture (`hd32mbr-minix.img`) is omitted from this
snapshot to keep size manageable; users who want it can fetch via
`npm run build:elks-hd-mbr-images` from the repo root.

## Launch — Node serial harness (floppy, unchanged)

```
cd releases/phase-10-2-minix-hd
node dist-cli/tools/elks/run-serial.js
```

The ELKS Setup banner prints first, then the kernel redirects to ttyS0
and the rest of the boot streams via the UART. `Ctrl-A x` quits.

## Launch — Browser harness

```
# Option A: vite preview (uses the project's installed Vite)
cd releases/phase-10-2-minix-hd
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-10-2-minix-hd/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/` in Firefox or Chrome. The default boot
still pulls `elks-serial.img`. To boot the bundled partitionless MINIX
HD image:

1. Click the **⚙ gear** in the top-right corner.
2. Open the **ELKS releases (GitHub)** disclosure under Settings → Boot image.
3. Find `hd32-minix.img` in the v0.9.0 release. The viability tag now
   reads **Likely works** (Phase 10 / 10.1 left it `Untested`; Phase
   10.2's verification promotes it).
4. Click **Download**, set as active boot image, and reload. The MINIX
   boot sector loads at `0:7C00`, the kernel loader picks up the chain,
   the kernel mounts `/dev/hda` as a partitionless MINIX volume, and
   `# ` appears over the UART.

`file://` will not work — `fetch('/elks-serial.img')` fails on a
non-HTTP origin. Use one of the two server commands above.

## What's new in Phase 10.2

- **Partitionless MINIX HD boot verified end-to-end.** A new integration
  test (`tests/integration/elks-hd-minix-boot.test.ts`) boots
  `hd32-minix.img` to a `# ` prompt and round-trips `echo minix-ok`
  through tty discipline. **No source-code changes were needed** — the
  substrate already serves a 32 MiB partitionless HD image (Phase 10)
  and the kernel auto-detects MINIX vs. FAT from the on-disk
  superblock.
- **Viability tagger refresh.** `web/viability-tagging.ts` now tags
  `hd*-minix.img` as `Likely works` (was `Untested` in Phase 10 / 10.1).
  All four HD shapes ELKS publishes — `hd*-fat.img`, `hd*-minix.img`,
  `hd*mbr-fat.img`, `hd*mbr-minix.img` — are now `Likely works`. The
  `Known incompatible` size-threshold fallback for unrecognised large
  images is unchanged.
- **Multi-image fetch script.** `tools/elks-build/fetch-hd-image.ts`
  gains `hd32-minix.img` as a known fixture:

  ```
  npm run build:elks-hd-image                        # default: hd32-fat.img
  npm run build:elks-hd-image -- hd32-minix          # partitionless MINIX
  npm run build:elks-hd-mbr-images                   # all variants
  ```

  Idempotent and size-validated, same as Phases 10 / 10.1.

## What's deferred (Phase 10.3+)

- **User toggle: authentic vs virtual-shift MBR boot.** Carried forward
  from Phase 10.1.
- **INT 13h LBA extensions** (AH=0x40 / 0x41 / 0x42 / 0x43). Not needed
  for any current ELKS image.
- **Multi-disk machines** (`/dev/hdb`, mixed floppy + HD). Still one
  disk per `IBMPCMachine`.
- **CGA-canvas browser frontend.** Carried forward — most rich ELKS
  distributions expect CGA.
- **Snapshot / restore.** Carried forward.
- **Network device** (NE2000 / similar). Carried forward.

See `MINIX_HD_REPORT.md` at the repo root for the verification
outputs.
