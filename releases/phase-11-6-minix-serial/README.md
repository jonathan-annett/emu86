# emu86 — Phase 11.6 release: MINIX serial floppy image

Self-contained snapshot of the Phase 11.6 deliverable. This phase
unifies two existing strands of the harness — Phase 8's serial
console (`console=ttyS0` in `/bootopts`) and Phase 11.5's MINIX-on-
floppy device-node availability — by producing a single image that
has both. The build script gained a `--filesystem fat|minix` flag;
one new integration test demonstrates the new image's value by
running the Phase 11.5 ramdisk round-trip over UART instead of
keyboard injection.

For the full diagnosis (in-place editing rationale, byte offsets,
test-design notes, future-brief follow-ups), see
`SERIAL_MINIX_REPORT.md` in the repo root.

```
phase-11-6-minix-serial/
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
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img          # Phase 8 default (unchanged)
    │   └── fd1440-minix-serial.img        # NEW — serial + device nodes
    ├── elks-images/fd1440-minix.img       # source for the new image
    └── elks-images-hd/{hd32-fat.img, hd32-minix.img}
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies; run from inside the release folder once the
root has `npm install`-ed.

## Launch — Node serial harness, FAT (regression check)

```
cd releases/phase-11-6-minix-serial
node dist-cli/tools/elks/run-serial.js
```

`Ctrl-A x` quits. The default 1.44 MB FAT serial floppy boots; same
shape as Phase 8-11.5 shipped, included here as a no-regression
check.

## Launch — Node serial harness, MINIX (the new path)

```
cd releases/phase-11-6-minix-serial
node dist-cli/tools/elks/run-serial.js \
  reference/elks-images-serial/fd1440-minix-serial.img
```

After the kernel banner streams to stdout and `# ` appears, the
shell can use device nodes the FAT serial image cannot:

```
# ls /dev | head
console
fd0
fd1
hda
hda1
hdb
rd0
rd1
ssd
tty1
# ramdisk /dev/rd0 make 64
ramdisk: 64Kb ramdisk created on /dev/rd0
# mkfs /dev/rd0 64
[mkfs banner + block counts]
# mount /dev/rd0 /mnt
# echo hello > /mnt/note
# cat /mnt/note
hello
# umount /mnt
```

## Launch — Node CGA harness (regression check)

The keyboard-injected harness still boots the upstream MINIX floppy:

```
cd releases/phase-11-6-minix-serial
node dist-cli/tools/elks/run.js \
  reference/elks-images/fd1440-minix.img
```

## Build the MINIX serial image yourself

If you want to regenerate `fd1440-minix-serial.img` from the upstream
`fd1440-minix.img`:

```
cd <repo root>      # not the release folder — the build tool reads
                    # source images from `reference/elks-images/`
npm run build:elks-serial-image-minix
```

The build is deterministic byte-for-byte: it locates `## /bootopts`
in the source image and replaces the 1024 bytes that follow with the
serial-console `/bootopts` content (NUL-padded). FAT directory entries
and MINIX inode pointers are unchanged because the file size stays
exactly 1024 bytes.

## Test counts

- Total: **1,255 passing** (1,254 baseline + 1 new ramdisk-serial).
- New test: `tests/integration/elks-ramdisk-serial.test.ts`.
- SST corpus: 323/323 passing within the full-suite run.
- Typecheck: clean.
