# emu86 — Phase 10 release: ELKS hard-disk boot

Self-contained snapshot of the Phase 10 deliverable. Builds on Phase 9.3
(GitHub releases browser + viability tags) by teaching the BIOS, the
worker host, and `IBMPCMachine` to recognise hard-disk-class images and
boot them. The reference path is the upstream
`hd32-fat.img` (32 MiB partitionless FAT16 volume) from the ELKS v0.9.0
release; it boots end-to-end to a `# ` prompt over the UART and accepts
injected userland commands.

```
phase-10-harddisk/
├── README.md                         # this file
├── package.json                      # copy of root manifest
├── package-lock.json                 # copy of root lockfile
├── dist-cli/                         # compiled Node CLI tools
│   └── tools/
│       ├── elks/{run.js, run-serial.js}
│       └── elks-build/{build-serial-image.js, fetch-hd-image.js}
├── dist-web/                         # Vite production bundle
│   ├── index.html
│   ├── elks-serial.img               # 1.44 MB floppy fetched at boot (default)
│   └── assets/{index,worker}-*.{js,css}
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/hd32-fat.img   # 32 MiB partitionless FAT16 HD image
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies; run from inside the release folder once the root
has `npm install`-ed.

## Launch — Node serial harness (floppy, unchanged)

```
cd releases/phase-10-harddisk
node dist-cli/tools/elks/run-serial.js
```

The ELKS Setup banner prints first, then the kernel redirects to ttyS0
and the rest of the boot streams via the UART. `Ctrl-A x` quits.

## Launch — Browser harness

The bundle is plain static assets; any HTTP server works.

```
# Option A: vite preview (uses the project's installed Vite)
cd releases/phase-10-harddisk
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-10-harddisk/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/` in Firefox or Chrome. The default boot
still pulls `elks-serial.img` (the 1.44 MB serial-floppy) so the
zero-config path is unchanged. To boot a hard-disk image:

1. Click the **⚙ gear** in the top-right corner.
2. Open the **ELKS releases (GitHub)** disclosure inside Settings →
   Boot image.
3. Find an `hd*.img` asset in the v0.9.0 (or newer) release and click
   **Download**. The viability tag now reports `Likely works` for
   `hd32-fat.img` / `hd64-fat.img` and `Untested` for the MBR-partitioned
   variants (`hd32mbr-*.img`, `hd64mbr-*.img`) — see "What's deferred"
   below for why.
4. Select the downloaded image as the active boot image and reboot the
   emulator. The kernel will mount `/dev/hda` and reach `# ` exactly
   like the floppy path.

`file://` will not work — `fetch('/elks-serial.img')` fails on a
non-HTTP origin. Use one of the two server commands above.

## What's new in Phase 10

- **`DiskGeometry` + `diskClass` plumbed through the boot config.**
  `BootConfig` now carries an explicit `diskClass: 'floppy' | 'hard-disk'`
  alongside the optional `geometry`. The worker host derives both from a
  size table covering the four ELKS HD shapes (32 MiB / 64 MiB; FAT vs
  MBR-partitioned) plus the existing 1.2 MB / 1.44 MB floppies, and
  falls back to a `heads >= 4 ⇒ hard-disk` heuristic for unrecognised
  sizes.
- **INT 19h boot-drive derivation.** The bootstrap loader now hands
  `DL = 0x80` for hard-disk-class machines and `DL = 0x00` for
  floppy-class machines. ELKS reads `biosdrive & 0x80` at
  `arch/i86/drivers/block/bios.c:446` to pick `/dev/hda` vs `/dev/fd0`,
  so this single bit is what teaches the kernel to mount the right
  root device.
- **INT 13h AH=0x08 HD branch.** Returns the correct CHS geometry for
  HD requests on `DL=0x80` (CH = low cyl, CL[7:6] = high cyl bits,
  CL[5:0] = sectors/track, DH = heads-1, DL = drive count). HD-class
  responses additionally clear `BL` and `ES:DI` per the AT-era contract.
  Cross-class requests (HD command on a floppy machine, or vice versa)
  return `AH=0x01` BAD_COMMAND so misrouted guest code fails fast
  instead of silently reading the wrong device.
- **AH=0x02 / 0x03 / 0x04 drive filtering.** Existing read/write/verify
  paths now consult the machine's `diskClass` and reject the
  wrong-drive-number request with BAD_COMMAND, matching the real BIOS
  behaviour.
- **`IBMPCMachine` exposes `diskClass`.** Default derivation is:
  explicit constructor option > `heads >= 4 ⇒ hard-disk` >
  `'floppy'`. Threaded into the `BiosContext` so every BIOS handler
  sees the same source of truth.
- **HD test fixture fetch.** A new
  `npm run build:elks-hd-image` script fetches `hd32-fat.img` from the
  ELKS v0.9.0 GitHub release into
  `reference/elks-images-hd/hd32-fat.img` (32,514,048 bytes; idempotent
  + size-validated). The Phase 10 integration test skips with a
  helpful pointer when the fixture is absent — the file is too large
  to commit.

## Hard-disk boot end-to-end

`tests/integration/elks-hd-boot.test.ts` mirrors the Phase 8
serial-floppy test but boots `hd32-fat.img` instead. It patches
`/bootopts` in place with `console=ttyS0,9600` + `init=/bin/sh`,
runs to a `# ` prompt over the UART, and round-trips `echo hd-ok`
through tty discipline. Same boot-to-prompt + injected-command shape
as the floppy harness; same assertions; just a different image and a
different drive number on the wire.

## What's deferred

- **MBR-partitioned HD images.** `hd32mbr-fat.img`, `hd32mbr-minix.img`,
  `hd64mbr-fat.img`, `hd64mbr-minix.img` are surfaced by the GitHub
  browser and tagged `Untested`. The size-table maps them to the
  next-larger CHS geometry so `InMemoryDisk` zero-pads cleanly, but
  the BIOS does not yet read a partition table — the kernel will see
  LBA 0 as the MBR rather than a filesystem boot record. Adding
  partition-aware `INT 13h` reads is a Phase 10.1 problem.
- **Hard-disk write-back.** The integration test only exercises the
  read path. The HD write path goes through `disk.writeSector` like the
  floppy path, so functionally it works — but no fixture-anchored test
  pins it yet.

See `HARDDISK_BOOT_REPORT.md` at the repo root for the full design
notes, file-level citations, and verification outputs.
