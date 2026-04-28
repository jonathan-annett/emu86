# emu86 — Phase 10.1 release: ELKS MBR-partitioned HD boot

Self-contained snapshot of the Phase 10.1 deliverable. Phase 10 landed
partitionless hard-disk boot; this phase verifies that the **MBR-
partitioned** variants ELKS publishes (`hd32mbr-fat.img`,
`hd32mbr-minix.img`, etc.) boot end-to-end on the existing substrate via
**authentic chain-load** — the BIOS reads sector 0 (the MBR), loads it
at `0:7C00`, and jumps to it; the MBR's own bytecode parses the
partition table, loads the VBR from the active partition's start LBA,
and chain-loads it. No source changes were required.

```
phase-10-1-mbr/
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
    └── elks-images-hd/hd32mbr-fat.img     # Phase 10.1 — MBR-partitioned FAT16
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies; run from inside the release folder once the
root has `npm install`-ed.

## Launch — Node serial harness (floppy, unchanged)

```
cd releases/phase-10-1-mbr
node dist-cli/tools/elks/run-serial.js
```

The ELKS Setup banner prints first, then the kernel redirects to ttyS0
and the rest of the boot streams via the UART. `Ctrl-A x` quits.

## Launch — Browser harness

```
# Option A: vite preview (uses the project's installed Vite)
cd releases/phase-10-1-mbr
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-10-1-mbr/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/` in Firefox or Chrome. The default boot
still pulls `elks-serial.img`. To boot the bundled MBR HD image:

1. Click the **⚙ gear** in the top-right corner.
2. Open the **ELKS releases (GitHub)** disclosure under Settings → Boot image.
3. Find `hd32mbr-fat.img` in the v0.9.0 release. The viability tag now
   reads **Likely works** (Phase 9.3 marked it `Known incompatible`;
   Phase 10 left it `Untested`; Phase 10.1's verification promotes it).
4. Click **Download**, set as active boot image, and reload. The MBR's
   "Welcome to ELKS MBR Boot Manager" prompt scrolls past, the
   3-second timeout elapses, the VBR loads from LBA 63, the kernel
   parses the MBR partition table, and `# ` appears over the UART.

`file://` will not work — `fetch('/elks-serial.img')` fails on a
non-HTTP origin. Use one of the two server commands above.

## What's new in Phase 10.1

- **MBR chain-load verified end-to-end.** Two new integration tests
  (`tests/integration/elks-mbr-boot.test.ts`) boot
  `hd32mbr-fat.img` and `hd32mbr-minix.img` to a `#  ` prompt; the FAT
  variant additionally round-trips `echo mbr-ok` through tty
  discipline. **No source-code changes were needed** — every BIOS call
  the MBR makes (INT 10h AH=0Eh, INT 13h AH=00 / AH=02, INT 16h
  AH=00 / AH=01, INT 1Ah AH=00) was already implemented for floppy and
  partitionless HD boot.
- **Diagnosis pinning.** A new `tests/unit/mbr-fixture-diagnosis.test.ts`
  asserts the on-disk layout of `hd32mbr-fat.img` byte-for-byte: boot
  signature, active partition entry (start LBA = 63), CHS-vs-LBA
  consistency, and that the MBR bootstrap uses INT 13h AH=02h (CHS
  read) rather than AH=42h (LBA extensions). If upstream switches MBR
  codebases this test fires loudly; otherwise it confirms our Outcome A
  diagnosis stays valid.
- **Viability tagger refresh.** `web/viability-tagging.ts` now reflects
  what genuinely boots: `hd*-fat.img` and `hd*mbr-*.img` are
  `Likely works`; `hd*-minix.img` (partitionless MINIX, not covered by
  an integration test) is `Untested`; the `Known incompatible` blanket
  rule for `hd*` is retired. The size-threshold defensive rule still
  catches large, unrecognised-shape images.
- **Multi-image fetch script.** `tools/elks-build/fetch-hd-image.ts`
  now accepts arguments to fetch the MBR variants on demand:

  ```
  npm run build:elks-hd-image                      # default: hd32-fat.img
  npm run build:elks-hd-mbr-images                 # all variants
  node dist-cli/tools/elks-build/fetch-hd-image.js hd32mbr-minix.img
  ```

  Idempotent and size-validated, same as Phase 10's hd32-fat fetch.

## What's deferred (Phase 10.2+)

- **User toggle: authentic vs virtual-shift MBR boot.** The user has
  expressed interest in eventually offering both shapes. Phase 10.1
  commits to authentic chain-load only — the spec the user explicitly
  selected. A future brief adds virtual-shift as a second path with a
  setting to choose.
- **INT 13h LBA extensions** (AH=0x40 / 0x41 / 0x42 / 0x43). Not needed
  for any current ELKS image (Phase 10.1 diagnosis confirmed neither
  the partitionless nor MBR HD MBR uses them); would unblock modern
  bootloaders or images > 8 GB.
- **GPT (GUID Partition Table) and extended / logical partitions.**
  Out of scope; ELKS hasn't published images that use them.
- **Multi-disk machines** (`/dev/hdb`, mixed floppy + HD). Still one
  disk per `IBMPCMachine`.
- **CGA-canvas browser frontend.** Most of the rich ELKS distributions
  expect a CGA console rather than a serial console. The next
  capability step.
- **Snapshot / restore.** Boot-to-`# ` is now ~10-15 s for HD images
  (≤ 30 s for MBR variants because of the manager's auto-boot timeout).
  A snapshot point past `/bin/sh ready` would shorten test iterations
  significantly.

See `MBR_PARTITION_REPORT.md` at the repo root for the full diagnosis,
byte-level citations, and verification outputs.
