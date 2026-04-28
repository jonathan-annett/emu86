# emu86 — Phase 11 release: multi-disk substrate

Self-contained snapshot of the Phase 11 deliverable. Phase 10 closed the
single-HD path; this phase extends the substrate to support **two
simultaneously-mounted disks** on `IBMPCMachine`. The kernel boot banner
now reports both `hda:` + `hdb:` (or `fd0:` + `fd1:`) when two disks are
attached. Userland mounts the secondary on demand:

```
# /dev/hdb   (kernel auto-mounts only the boot device)
mount /dev/hdb /mnt
```

Single-disk callers are unchanged — every Phase 1-10 test still
passes unmodified.

```
phase-11-multi-disk/
├── README.md                              # this file
├── package.json                           # copy of root manifest
├── package-lock.json                      # copy of root lockfile
├── dist-cli/                              # compiled Node CLI tools
│   └── tools/
│       ├── elks/{run.js, run-serial.js, secondary-disk.js}
│       └── elks-build/{build-serial-image.js, fetch-hd-image.js}
├── dist-web/                              # Vite production bundle
│   ├── index.html
│   ├── elks-serial.img                    # 1.44 MB floppy (default boot)
│   └── assets/{index,worker}-*.{js,css}
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    ├── elks-images-hd/hd32-fat.img        # multi-disk primary fixture
    └── elks-images-hd/hd32-minix.img      # multi-disk secondary fixture
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies; run from inside the release folder once the root
has `npm install`-ed.

## Launch — Node serial harness (single disk, unchanged)

```
cd releases/phase-11-multi-disk
node dist-cli/tools/elks/run-serial.js
```

`Ctrl-A x` quits. The default 1.44 MB floppy boots; the legacy single-
disk path is the same as Phase 9-10.

## Launch — Node serial harness with secondary disk (Phase 11)

Attach a second hard disk as `/dev/hdb`:

```
cd releases/phase-11-multi-disk
node dist-cli/tools/elks/run-serial.js \
  reference/elks-images-hd/hd32-fat.img \
  --hdb reference/elks-images-hd/hd32-minix.img
```

Or attach a second floppy as `/dev/fd1`:

```
node dist-cli/tools/elks/run-serial.js \
  reference/elks-images/fd1440-minix.img \
  --fd1 reference/elks-images/fd1440-minix.img
```

The boot banner shows `Secondary: <path>`. Once the kernel reaches a
prompt, mount the secondary:

```
# /
mount /dev/hdb /mnt
ls /mnt
```

Override class detection with `--secondary-class hard-disk` (or
`floppy`) when the size table guesses wrong.

## Launch — Browser harness

```
# Option A: vite preview
cd releases/phase-11-multi-disk
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-11-multi-disk/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/`. The Settings modal (gear icon, top-
right) gains a **"Secondary disk (optional)"** section below the
primary boot-image picker. Default is **None** (no behavioural
change). Pick any image from the IDB library to attach as a secondary;
the change takes effect on next reload.

## What's new vs Phase 10.2

- `IBMPCMachineConfig` accepts an optional `secondaryDisk` (additive,
  back-compat).
- `BiosContext` extended with `secondaryDisk` + `secondaryDiskClass`;
  INT 13h dispatch routes by drive number per class.
- `BootConfig.secondary?: DiskSlotSpec` for the worker host protocol.
- Browser settings modal gains a secondary-disk picker.
- Node CLI gains `--hdb`, `--fd1`, `--secondary-class` flags.
- New tests: `bios-int13-multi-disk` (15), `machine-multi-disk` (6),
  `elks-multi-disk-boot` integration (2), settings (2 new). Total
  1253 tests pass.

## Verification

From the repo root:

```
npm run typecheck
npm test
```

Both clean as of this release.
