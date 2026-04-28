# emu86 Phase 10.2 — Partitionless MINIX hard-disk boot

## Summary

**Outcome A — full success, no source-code changes required.** The
substrate built across Phases 1-10.1 already serves a 32 MiB
partitionless HD image (Phase 10) and the kernel auto-detects MINIX
vs. FAT from the on-disk superblock — so `hd32-minix.img` boots end-to-
end on the unchanged substrate. A new integration test
(`tests/integration/elks-hd-minix-boot.test.ts`) pins the boot path:
to a `# ` prompt over UART, `echo minix-ok` round-tripped through tty
discipline. The viability tagger is updated: `hd*-minix.img` graduates
from `untested` to `likely-works`.

**What works.**

- Partitionless MINIX HD images (`hd32-minix.img`). The kernel
  recognises the disk as `hda: 31M CHS 63,16,63`, observes
  `hda:(0,63504) no mbr, no partitions`, and mounts `/dev/hda
  (0300) minix filesystem.` directly.
- `/bin/sh` reaches a `# ` prompt over the UART; userland round-trips
  `echo minix-ok` cleanly.
- Phase 10's partitionless FAT path (`hd32-fat.img`) and Phase 10.1's
  MBR-partitioned paths (`hd32mbr-fat.img`, `hd32mbr-minix.img`) are
  unaffected — same substrate, same regressions-must-be-zero
  discipline.
- Floppy boot is unaffected.

The HD matrix is now fully verified: FAT and MINIX, partitionless and
MBR. The viability tagger tells the truth across every shape ELKS
publishes for v0.9.0.

## Fixture acquisition

The image is published as a release asset on
`https://github.com/ghaerr/elks/releases/download/v0.9.0/hd32-minix.img`,
32,514,048 bytes — the same size as `hd32-fat.img` (the FAT
partitionless variant), so the existing `worker-host.ts` size table
maps it to the same `63 × 16 × 63` CHS geometry without modification.

`tools/elks-build/fetch-hd-image.ts` was extended with a fourth
`ImageSpec` entry; usage shape is unchanged:

```
npm run build:elks-hd-image -- hd32-minix
npm run build:elks-hd-image -- --all          # all four variants
```

The script is still idempotent and validates fetched size against the
expected byte count. No GitHub-side surprises — the asset is in the
same v0.9.0 release as Phases 10 and 10.1's fixtures.

## Boot trace

UART transcript (kernel-side, after `set_console` redirects to
`ttyS0`):

```
Direct console, scan kbd 80x25 emulating ANSI (2 virtual consoles)
xms: 34816K, disabled, A20 error. 64K ext buffers, 8K cache, 15 req hdrs
eth: ne0 at 300, irq 12 not found
...
hda:   31M CHS  63,16,63
fd0:  360K CHS  40, 2,9
cf:  ATA at 300/31c xtide=3,1 probe fail (ff)
cfa: ATA at 300/31c xtide=3,0 not found (-6)
cfb: ATA at 300/31c xtide=3,0 not found (-6)
hda:(0,63504) no mbr, no partitions
boot: BIOS drive 80, root device /dev/hda (0300)
PC/XT class cpu 2, syscaps 0, 640K base ram, 16 tasks, 64 files, 96 inodes
ELKS 0.9.0 (61344 text, 31872 ftext, 10240 data, 8128 bss, 47166 heap)
Kernel text 330 ftext 122a init 17a4 data 19f2 end 29f2 top a000 472+9+0K free
VFS: Mounted root device /dev/hda (0300) minix filesystem.
#
```

Three lines are the load-bearing evidence:

- `hda: 31M CHS 63,16,63` — kernel HD probe (INT 13h AH=08h) returns
  the geometry the substrate's `hard-disk` `diskClass` plumbing
  configured.
- `hda:(0,63504) no mbr, no partitions` — kernel's MBR scan finds no
  valid partition table at sector 0 (the MINIX boot sector lives there
  instead). It correctly falls back to treating the whole disk as
  `/dev/hda`.
- `VFS: Mounted root device /dev/hda (0300) minix filesystem.` — the
  MINIX FS driver auto-detects from the superblock at LBA 1 and mounts
  successfully.

The kernel banner shape is the same as the FAT partitionless case
verified in Phase 10; the differences are exactly where they should
be: the partition-scan line and the FS-name in the mount line. This
matches the brief's "assert on shape, not exact bytes" guidance —
the integration test asserts on `Direct console, scan kbd`, `VFS:
Mounted root device`, and the `# ` prompt regex, not on FS-name
strings.

## Tagger update

`web/viability-tagging.ts` rule for partitionless MINIX HD images:

| Phase | Rule | Tag |
|---|---|---|
| 9.3 — initial | (caught by `hd*` blanket) | `known-incompatible` |
| 10 | `^hd\d+-minix\.img$` | `untested` (Phase 10 verified FAT only) |
| 10.1 | `^hd\d+-minix\.img$` | `untested` (carried forward) |
| **10.2** | `^hd\d+-minix\.img$` | **`likely-works`** |

Rule order is unchanged — filename-pattern rules still run before the
size-threshold defensive rule, so a 64 MB MINIX HD image isn't
re-tagged `known-incompatible` on size alone.

`tests/unit/viability-tagging.test.ts` was updated:

- The "tags partitionless HD MINIX images as untested" test was
  retitled to "as likely-works (Phase 10.2)" with both assertions
  flipped (`hd32-minix.img`, `hd64-minix.img`).
- The "size hint optional" test had its `hd32-minix.img` assertion
  flipped from `untested` to `likely-works`.
- A new test case ("rule order: hd*mbr-minix.img matches the MBR rule,
  not the partitionless MINIX rule") was added. Both rules now return
  the same tag, so a regex regression that mismatched them would
  return the right answer by accident — the new test pins which rule
  matches, so a future demotion of one wouldn't silently leak into the
  other.

Net: 13 → 14 cases.

## What's deferred

- **Larger MINIX HD variants** (`hd64-minix.img` if upstream publishes
  it for v0.9.0). Not in the v0.9.0 release as of writing; adding it
  later is a one-line follow-up to the `IMAGES` table in
  `fetch-hd-image.ts`.
- **`hd32mbr-minix.img` in the release snapshot.** Omitted to keep the
  snapshot under 100 MB; users who want it can fetch via
  `npm run build:elks-hd-mbr-images`. Same discipline as Phase 10.1.
- All Phase 10.1 deferred items carry forward unchanged: authentic-vs-
  virtual-shift toggle, INT 13h LBA extensions, GPT, multi-disk
  machines, CGA-canvas frontend, snapshot/restore, network device.

## Things future briefs should address

1. **Authentic vs virtual-shift MBR boot toggle.** Carried forward
   from Phase 10.1 — top of the list.
2. **CGA-canvas browser frontend.** Carried forward — most of the rich
   ELKS distributions expect CGA.
3. **Network device** (NE2000 / similar). The kernel banner shows
   probes for `ne0`, `wd0`, `3c0` — all return "not found". Adding
   one would unlock TCP/IP demos.
4. **Snapshot / restore.** Each HD boot is now ~7-8 s of test wall
   time (~25 s for MBR variants because of the 3 s auto-boot timeout);
   a snapshot point past `/bin/sh ready` would shorten userland-
   exercising tests significantly.
5. **Multi-disk `hdb` plus pivot-root.** The next ELKS feature that
   actually needs more than one disk.
6. **INT 13h LBA extensions** (AH=0x40-0x43). Conditional candidate:
   only worth implementing if a future image we want to support uses
   them. Phase 10.1's MBR-fixture diagnosis pinning would surface the
   need.

## CPU/memory bug candidates

None observed. The MINIX boot sector and its second-stage loader use
the same set of opcodes the SST corpus has stress-tested for thousands
of cases (the corpus runs 323 tests per phase and is unchanged).
The kernel disk driver issues the same INT 13h AH=02h reads as in
the FAT case. No new CPU/memory paths were exercised.

## Release snapshot

Layout at `releases/phase-10-2-minix-hd/`:

```
phase-10-2-minix-hd/
├── README.md                              # launch commands + what's new
├── package.json                           # copy of root manifest
├── package-lock.json                      # copy of root lockfile
├── dist-cli/
│   ├── src/                               # compiled emulator core
│   └── tools/
│       ├── elks/{run.js, run-serial.js}
│       └── elks-build/{build-serial-image.js, fetch-hd-image.js}
├── dist-web/
│   ├── index.html                         # 763 bytes
│   ├── elks-serial.img                    # 1,474,560 bytes
│   └── assets/
│       ├── index-DIYcPqkH.js              # 318,060 bytes
│       ├── index-B9SGSCe8.css             # 10.81 kB (unchanged from 10.1)
│       └── worker-qy1MUjUd.js             # 69,735 bytes (unchanged from 10.1)
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    ├── elks-images-hd/hd32-fat.img        # Phase 10
    ├── elks-images-hd/hd32mbr-fat.img     # Phase 10.1
    └── elks-images-hd/hd32-minix.img      # Phase 10.2 (this brief)
```

Total snapshot size: 100 MB (most of which is the three HD fixtures).
The MBR-MINIX fixture is omitted to stay manageable; users fetch via
`npm run build:elks-hd-mbr-images`.

The web bundle hash changed (`index-DIYcPqkH.js` vs Phase 10.1's
`index-DbyqVGbp.js`) because `web/viability-tagging.ts` was updated;
the worker bundle and CSS hashes are unchanged because their inputs
weren't.

**Manual launch verification.**

- Node serial harness from inside the release —
  `cd releases/phase-10-2-minix-hd && node dist-cli/tools/elks/run-serial.js`
  produced the ELKS Setup banner, redirected to ttyS0, and streamed
  the kernel boot output through `boot: BIOS drive 0, root device
  /dev/fd0` confirming the floppy path is unaffected.
- `dist-web/` bundle hashes match the production build above.

## Verification

All commands run from repo root.

### Typecheck

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean — no output, exit 0)
```

### Phase 10.2 integration test

```
$ npx vitest run tests/integration/elks-hd-minix-boot.test.ts
 ✓ tests/integration/elks-hd-minix-boot.test.ts (1 test) 7385ms
   ✓ boots hd32-minix.img to a # prompt over UART, accepts injected input

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

The test asserts `txAfterBoot` contains `Direct console, scan kbd` and
`VFS: Mounted root device`, ends in `/# *$/`, then injects
`echo minix-ok\n` over the UART and asserts the echo + reply round-trip
back through tty discipline.

### Viability tagger unit test

```
$ npx vitest run tests/unit/viability-tagging.test.ts
 ✓ tests/unit/viability-tagging.test.ts  (14 tests) 8ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
```

13 → 14 cases (one new "rule order: hd*mbr-minix.img" case).

### Full unit + integration sweep (excluding SST corpus)

```
$ npx vitest run --exclude tests/sst
 Test Files  66 passed (66)
      Tests  899 passed (899)
   Duration  44.81s
```

### SST corpus regression

```
$ npx vitest run tests/sst
 ✓ tests/sst/runner.test.ts  (6 tests) 14ms
 ✓ tests/sst/corpus.test.ts  (323 tests) 199344ms

 Test Files  2 passed (2)
      Tests  329 passed (329)
```

### Total tests

`899 + 329 = 1,228`. Brief's Outcome-A target was `≥ 1,228`. ✓

Net new this phase: +2 (one new integration test, one new viability-
tagger case). One assertion flipped (the partitionless MINIX rule's
test was retitled and its expected tag changed from `untested` to
`likely-works`).

### Browser build

```
$ npm run build:browser
vite v5.4.21 building for production...
✓ 16 modules transformed.
../dist-web/index.html                   0.76 kB │ gzip:  0.46 kB
../dist-web/assets/worker-qy1MUjUd.js   69.72 kB
../dist-web/assets/index-B9SGSCe8.css   10.81 kB │ gzip:  3.27 kB
../dist-web/assets/index-DIYcPqkH.js   317.84 kB │ gzip: 80.76 kB │ map: 706.14 kB
✓ built in 2.98s
```

### Phase 10 / 10.1 regressions

Both prior-phase HD-boot suites still pass:

```
$ npx vitest run tests/integration/elks-hd-boot.test.ts
 ✓ tests/integration/elks-hd-boot.test.ts (2 tests) 8088ms

$ npx vitest run tests/integration/elks-mbr-boot.test.ts
 ✓ tests/integration/elks-mbr-boot.test.ts (2 tests) 14945ms
```

## Reference sources

1. **`HARDDISK_BOOT_REPORT.md`** — Phase 10 work; the partitionless HD
   substrate this brief inherits unchanged.
2. **`MBR_PARTITION_REPORT.md`** — Phase 10.1; the MBR-MINIX
   verification that proves the kernel-side MINIX FS driver is
   exercised on the same INT 13h CHS read paths.
3. **`tools/elks-build/fetch-hd-image.ts`** — fixture fetcher,
   extended with `hd32-minix.img`.
4. **`web/viability-tagging.ts`** — tagger rules, with the
   partitionless MINIX rule promoted to `likely-works`.
5. **`reference/elks/elks/fs/minix/`** — kernel-side MINIX FS driver,
   for reference (was not consulted for a fix; verification passed
   first-try).

## Final notes

This is the small brief it advertised itself as: one fixture added,
one integration test added, one tagger rule promoted, one new tagger
test case, one assertion flipped. Total net code change is < 60 lines.
The substrate's discipline — strict separation between BIOS handoff,
disk geometry, and filesystem detection — paid off again: the kernel
auto-detected MINIX vs. FAT exactly where it was supposed to, the
partitionless vs. MBR distinction was already absorbed by Phase 10's
worker-host size table, and the chain of layers Just Worked.

After this lands, the HD arc is fully verified across the four-cell
matrix (FAT × MINIX × partitionless × MBR), and the viability tagger
tells the truth for every HD shape ELKS publishes. The user's
evaluation goal — "are these images viable in our emulator" — is
answered.
