# emu86 — Phase 11.5 release: ELKS ramdisk verified

Self-contained snapshot of the Phase 11.5 deliverable. Phase 11
extended the substrate to two simultaneously-mounted disks; this
mini-phase is a pure-research diagnosis: **does ELKS's `/dev/rd0`
ramdisk work in our emulator out of the box?** The answer is **yes**
(Outcome A in the brief). No substrate changes were needed; the
release ships the same compiled bits as Phase 11 plus a single new
integration test that pins the round-trip.

For the full diagnosis (driver memory model, userland tool, image
selection rationale, future-brief follow-ups), see
`RAMDISK_REPORT.md` in the repo root.

```
phase-11-5-ramdisk/
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
    ├── elks-images/fd1440-minix.img       # has /dev/rd0, /bin/ramdisk, /bin/mkfs
    ├── elks-images-hd/hd32-fat.img
    └── elks-images-hd/hd32-minix.img
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies; run from inside the release folder once the
root has `npm install`-ed.

## Launch — Node serial harness (regression check)

```
cd releases/phase-11-5-ramdisk
node dist-cli/tools/elks/run-serial.js
```

`Ctrl-A x` quits. The default 1.44 MB FAT serial floppy boots; this
is the same single-disk path Phase 9-11 shipped, included here as a
no-regression check.

## Launch — Node CGA harness (the harness this phase verified against)

The MINIX floppy image — required for ramdisk testing because FAT12
cannot store device nodes — uses the CGA console:

```
cd releases/phase-11-5-ramdisk
node dist-cli/tools/elks/run.js \
  reference/elks-images/fd1440-minix.img
```

## Try the ramdisk by hand

After login as `root` from the `# ` prompt:

```bash
# Allocate 64 KB on /dev/rd0
ramdisk /dev/rd0 make 64

# Format MINIX V1 (block count matches allocation)
mkfs /dev/rd0 64

# Mount and use
mount /dev/rd0 /mnt
echo 'hello' > /mnt/note
cat /mnt/note
ls -l /mnt

# Tidy up
umount /mnt
ramdisk /dev/rd0 kill
```

Sizes 1-512 KB are valid; the kernel hard-caps each ramdisk at 512 KB
(`MAX_SEGMENTS × ALLOC_SIZE`). The userland tool advertises 32 MB,
but that's informational — the kernel is the canonical limit.

## Verification

```
$ npm test
…
 Test Files  72 passed (72)
      Tests  1254 passed (1254)
   Duration  217.82s

$ npx vitest run tests/integration/elks-ramdisk.test.ts
 ✓ tests/integration/elks-ramdisk.test.ts  (1 test) 27115ms
```

Phase 11's 1,253 baseline + 1 new ramdisk test = 1,254 total. SST
corpus 323/323 within the suite. `npm run typecheck` clean.
