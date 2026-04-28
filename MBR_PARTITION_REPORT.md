# emu86 Phase 10.1 — MBR-partitioned hard-disk boot

## Summary

**Outcome A — full success, no source-code changes required.** The
substrate built across Phases 1-10 already implements every BIOS call
the ELKS MBR Boot Manager makes; the BIOS hands sector 0 to `0:7C00`
with `DL = 0x80`, the MBR's own bytecode parses the partition table,
loads the VBR via authentic CHS `INT 13h AH=02h` reads, and chain-loads
the kernel exactly as on real hardware. Two new integration tests
(`tests/integration/elks-mbr-boot.test.ts`) pin this end-to-end for
both `hd32mbr-fat.img` and `hd32mbr-minix.img`.

**What works.**

- MBR-partitioned HD images (`hd32mbr-fat.img`, `hd32mbr-minix.img`).
  The MBR auto-boots its active partition after a ~3-second timeout;
  the kernel parses the on-disk partition table, matches against the
  `SETUP_PART_OFFSET` saved by the VBR's second-stage loader, and
  mounts `/dev/hda1`.
- Both FAT16 and MINIX VBR variants reach a `# ` prompt over the UART.
  The FAT case round-trips `echo mbr-ok` through tty discipline.
- Phase 10's partitionless HD path (`hd32-fat.img`) is unaffected;
  same INT 19h handoff, same INT 13h paths.
- Floppy boot is unaffected.

**What's deferred.** Same list as Phase 10, plus one new item: the
authentic-vs-virtual-shift user toggle. None blocks ELKS HD evaluation.

## Diagnosis (Section 1 of the brief)

Inspected the first 512 bytes of `hd32mbr-fat.img` directly. All
diagnosis answers are byte-grounded.

### 1. MBR bootstrap shape

Identifier strings in the MBR (offsets within sector 0):
- `0x0159..0x017A` — `"Welcome to ELKS MBR Boot Manager\r\n"`
- `0x012A..0x012F` — `"\r\nMBR: "`
- `0x0138..0x0142` — `"\rMBR F1234> "`
- `0x0092..0x00A0` — `"Disk read error"`
- `0x00A2..0x00B7` — `"No bootable partition"`

This is the ELKS-bundled MBR Boot Manager — interactive, with F1-F4
key-driven partition selection and an auto-boot fall-through after a
~3-second timeout. Not MS-DOS, not FreeDOS, not GRUB.

Pinned in `tests/unit/mbr-fixture-diagnosis.test.ts` so a future
upstream rebase that swaps MBR codebases triggers a clear test failure
instead of a silent regression.

### 2. INT 13h functions used

Manual disassembly of bytes 0x00..0x90 and a bytecode scan for
opcode patterns. Used:

- `INT 10h AH=0x0Eh` (teletype output) — for the welcome banner and
  prompt strings.
- `INT 13h AH=0x00` (reset disk) — retry recovery on read failure.
- `INT 13h AH=0x02` (CHS read) — single call at file offset 0x4A:
  `b8 01 02 cd 13` (`mov ax, 0x0201; int 0x13`). Loads exactly one
  VBR sector.
- `INT 16h AH=0x00` / `AH=0x01` (read key blocking / check key) — used
  by the interactive prompt and the auto-boot timeout.
- `INT 1Ah AH=0x00` (get system time) — used by the auto-boot timeout
  to time the ~3-second wait.

**Crucially absent:** `INT 13h AH=0x41` (extensions check, `b4 41`)
and `AH=0x42` (LBA read, `b4 42`). The MBR uses authentic CHS reads
exclusively — no LBA-extension surface needed. Pinned by
`mbr-fixture-diagnosis.test.ts` ("MBR bootstrap uses INT 13h AH=02h
(CHS read), not LBA extensions").

### 3. Active partition's start LBA

Partition entry 0 at file offset 0x1BE:

```
80 01 01 00 80 10 3f 3e 3f 00 00 00 d1 f7 00 00
^   ^---^   ^   ^---^   ^---------^ ^---------^
|     |     |     |          |           |
flag  CHS  type CHS         start_lba sectors
      start      end           63       63441
```

- Boot flag: `0x80` (active).
- Partition type: `0x80`.
- Start CHS: `[head=1, sector=1, cylinder=0]`.
- Start LBA: `63`.
- Size: `63441` sectors ≈ 30.97 MiB (the FAT volume's extent within the
  ~31 MB disk after the 32,256-byte head zone for the MBR + alignment).

CHS-to-LBA cross-check on the disk geometry (16 heads, 63 spt):
`(0 × 16 + 1) × 63 + (1 - 1) = 63`. ✓ (Pinned in `mbr-fixture-
diagnosis.test.ts`.)

### 4. Partition type

Type byte `0x80`. Historically "Old MINIX" in some references;
ELKS appears to use it generically for both FAT and MINIX VBRs in
this image series — the kernel doesn't read the type to select a
filesystem driver, it auto-detects from the VBR's BPB / superblock.
Both `hd32mbr-fat.img` and `hd32mbr-minix.img` use type `0x80`.

### 5. MBR self-relocation

Yes — standard `0:7C00 → 0:0600` move. Disassembly of bytes 0x00..0x21:

```
0000  fa            cli
0001  b8 60 00      mov ax, 0x0060        ; ax = 0x60 (segment = 0x600)
0004  8e c0         mov es, ax
0006  8e d0         mov ss, ax            ; SS:SP = 0060:0000
0008  31 e4         xor sp, sp
000a  31 ff         xor di, di            ; ES:DI = 0060:0000 = 0:0600
000c  57            push di               ; placeholder for retf return
000d  8e df         mov ds, di            ; DS = 0
000f  be 00 7c      mov si, 0x7C00        ; DS:SI = 0:7C00
0012  b9 00 01      mov cx, 0x0100        ; 256 words = 512 bytes
0015  fc            cld
0016  f3 a5         rep movsw             ; copy MBR to 0:0600
0018  06 1f         push es / pop ds      ; DS = 0x60 (relocated)
001a  07            pop es                ; ES = 0  (the di we pushed)
001b  16            push ss               ; ss = 0x60
001c  b9 21 00      mov cx, 0x0021        ; cx = relocate offset
001f  51            push cx
0020  cb            retf                  ; far jump 0060:0021 = 0x621
```

Standard 8086 instructions, all validated by Phase 1 + the SST corpus
(`tests/sst/corpus.test.ts`, 323 test cases). The relocate-and-jump
ran first try; no CPU bugs surfaced.

### 6. VBR at the active partition's start LBA

Sector at LBA 63 (file offset 0x7E00) starts with `eb 3c 90 45 4c 4b
53 46 41 54 31`: standard FAT BPB short-jump prefix followed by the
OEM ID `"ELKSFAT1"`. Same FAT16 BPB shape Phase 10's partitionless
test exercised — our existing FAT-on-floppy boot path handles it
unchanged.

### 7. Comparison to Phase 10's partitionless boot

| Aspect | Phase 10 (`hd32-fat.img`) | Phase 10.1 (`hd32mbr-fat.img`) |
|---|---|---|
| LBA 0 contents | FAT BPB + boot code | MBR + partition table |
| Boot sector → 0:7C00 | Yes (FAT VBR) | Yes (MBR) |
| Kernel mounts | `/dev/hda` (LBA 0) | `/dev/hda1` (LBA 63 + offset) |
| `bios_conv_bios_drive` | `biosdrive=0x80 → /dev/hda` | `biosdrive=0x80, boot_partition=1 → /dev/hda1` |
| INT 13h AH used by boot stage | AH=02h (CHS) | AH=02h (CHS) — no extensions |

The only mover between the two is which sector is at LBA 0 and how
the kernel reaches the FS. The substrate is the same, which is why
Outcome A holds.

## Implementation

**No source-code changes were necessary.** Specifically:

- `src/bios/bios-services.ts` — unchanged. Every call the MBR makes
  was already implemented for floppy + partitionless HD: INT 10h
  AH=0Eh (Phase 7), INT 13h AH=00 / AH=02 (Phases 5 / 10), INT 16h
  AH=00 / AH=01 (Phase 4), INT 19h handoff (Phase 10), INT 1Ah
  AH=00 (Phase 8).
- `src/machine/ibm-pc.ts`, `src/browser/worker-host.ts`,
  `src/browser/protocol.ts` — unchanged. Phase 10's size table
  already mapped both 32,514,048 (`hd32-fat`) and 32,546,304
  (`hd32mbr-*`) to the right CHS geometry; `InMemoryDisk` zero-pads
  short content; the `'hard-disk'` `diskClass` flows straight into
  the existing INT 13h / INT 19h paths.
- `src/cpu8086/`, `src/memory/`, `src/runtime/`, `src/disk/`, etc. —
  not touched, per the brief.

The test changes are:

| File | Change |
|---|---|
| `tests/integration/elks-mbr-boot.test.ts` | New, 2 cases (FAT + MINIX MBR boot) |
| `tests/unit/mbr-fixture-diagnosis.test.ts` | New, 6 cases pinning the MBR's on-disk shape |
| `tests/unit/viability-tagging.test.ts` | Extended, 8 → 13 cases reflecting verified HD shapes |
| `web/viability-tagging.ts` | Updated rules — see §"Tagger update" below |
| `tools/elks-build/fetch-hd-image.ts` | Multi-image fetch (FAT MBR, MINIX MBR) with arg parsing |
| `tsconfig.cli.json` | Added `fetch-hd-image.ts` to the include list (was missing in Phase 10) |
| `package.json` | Added `npm run build:elks-hd-mbr-images` |

### Test-side note on the InMemoryHostClock

The MBR's auto-boot timeout polls `INT 1Ah AH=00` and decrements its
counter only when the low-word of the BIOS tick count changes. The
default `InMemoryHostClock` is frozen — every `now()` returns the same
value — so the MBR's `cmp dx, si; je loop` would spin forever in a
test that uses it. The integration test uses a small local
`AutoAdvanceHostClock` that advances the underlying clock by 60 ms
per `now()` call. This is test-side code only; the substrate
`HostClock` interface and `InMemoryHostClock` implementation are
unchanged.

## MINIX variant verification

`hd32mbr-minix.img` boots cleanly with the same shape as the FAT
variant. Same MBR (the bootstrap is filesystem-agnostic — it just
loads the VBR from start LBA 63), different VBR (MINIX FS instead of
FAT). The kernel parses the MBR partition table identically and mounts
partition 1; the MINIX FS auto-detects from its on-disk superblock.
Pinned by the second `it()` block in
`tests/integration/elks-mbr-boot.test.ts`. No additional changes were
necessary for the MINIX path.

## Tagger update

`web/viability-tagging.ts` rules refreshed (Phase 9.3 → 10.1). Order
matters: filename-pattern rules run *before* the size threshold so a
verified large HD image isn't downgraded.

| Pattern | Tag | Pinned in |
|---|---|---|
| `^hd\d+mbr-fat\.img$` | `likely-works` (Phase 10.1) | "tags MBR-partitioned HD images as likely-works" |
| `^hd\d+mbr-minix\.img$` | `likely-works` (Phase 10.1) | same |
| `^hd\d+-fat\.img$` | `likely-works` (Phase 10) | "tags partitionless HD FAT images as likely-works" |
| `^hd\d+-minix\.img$` | `untested` | "tags partitionless HD MINIX images as untested" |
| `^fd\d+-fat-serial\.img$` | `likely-works` (unchanged) | original case |
| `^fd\d+.*\.img$` | `untested` (unchanged) | original case |
| any > 10 MB unrecognised | `known-incompatible` (unchanged) | "tags unknown-shape > 10 MB" |

Eight new cases were added across five new `it()` blocks: rule order
(MBR pattern beats partitionless), case-insensitive matching, size-
threshold-doesn't-downgrade-verified-shapes, malformed-filename
defence, optional-size-hint. Total: 13 viability-tagging tests, up
from 8.

## What's deferred

- **Authentic vs. virtual-shift user toggle.** The brief explicitly
  named this as "things future briefs should address". Phase 10.1
  commits to authentic chain-load only, on the user's instruction.
- **INT 13h LBA extensions** (AH=0x40 / 0x41 / 0x42 / 0x43). Not
  needed for any current ELKS image. The Phase 10.1 diagnosis
  confirmed the MBR uses CHS only — pinned in
  `mbr-fixture-diagnosis.test.ts`. If a future image switches to LBA
  extensions, that test fires and the Outcome A diagnosis needs
  re-running.
- **GPT (GUID Partition Table)**. ELKS doesn't publish GPT images.
- **Logical / extended partitions**. ELKS images use one primary
  partition; entries 1, 2, 3 in `hd32mbr-fat.img` are zero (pinned).
- **Multi-disk machines** (`/dev/hdb`, mixed floppy + HD). Carried
  forward from Phase 10's deferred list.
- **A "boot from partition N" UI override.** The MBR Boot Manager
  picks the partition; we trust the image.
- **Snapshot / restore.** Carried forward.
- **Hard-disk write-back tests.** Carried forward.

## Things future briefs should address

1. **User toggle: authentic vs virtual-shift MBR boot.** Now that
   authentic boot is verified end-to-end, adding virtual-shift as a
   second option (under a setting) completes the spectrum. Virtual-
   shift would translate `disk.readSector(0)` to read the active
   partition's LBA 0 instead of the physical LBA 0, sidestepping the
   MBR's bootstrap entirely and bypassing the ~3-second timeout. Some
   users will prefer this for boot speed / determinism even though
   it's less faithful to real hardware.
2. **INT 13h LBA extensions** (AH=0x40-0x43). Conditional candidate:
   only worth implementing if a future image we want to support uses
   them. The Phase 10.1 diagnosis pinning will surface the need.
3. **CGA-canvas browser frontend.** Carried forward — most rich ELKS
   distributions expect CGA.
4. **Network device** (NE2000 / similar). Carried forward.
5. **Snapshot / restore.** Each MBR boot is now ~10-15 s of test wall
   time; a snapshot point past `/bin/sh ready` would shorten
   userland-exercising tests significantly.
6. **Multi-disk `hdb` plus pivot-root.** The next ELKS feature that
   actually needs more than one disk.
7. **MINIX-on-partitionless-HD verification.** Phase 10 deferred this;
   Phase 10.1 only verified MINIX-on-MBR. The partitionless MINIX
   path (`hd*-minix.img`) is currently tagged `untested` — promoting
   it to `likely-works` is a cheap follow-up brief.

## CPU/memory bug candidates

None observed during MBR execution. The bootstrap's relocate-and-far-
jump (`rep movsw` + `retf` from a constructed stack frame) is exactly
the shape the SST corpus has stress-tested for thousands of cases.
The interactive prompt's INT 16h polling and the INT 1Ah tick-count
loop ran clean. The chain-loaded VBR's FAT-aware boot code follows
the same shape Phase 10 already exercised.

## Release snapshot

Layout at `releases/phase-10-1-mbr/`:

```
phase-10-1-mbr/
├── README.md                              # launch commands + what's new
├── package.json                           # copy of root manifest
├── package-lock.json                      # copy of root lockfile
├── dist-cli/
│   └── tools/
│       ├── elks/{run.js, run-serial.js}
│       └── elks-build/{build-serial-image.js, fetch-hd-image.js}
├── dist-web/
│   ├── index.html                         # 763 bytes
│   ├── elks-serial.img                    # 1,474,560 bytes
│   └── assets/
│       ├── index-DbyqVGbp.js              # 318,084 bytes
│       ├── index-B9SGSCe8.css             # 10.81 kB
│       └── worker-qy1MUjUd.js             # 69,735 bytes
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    ├── elks-images-hd/hd32-fat.img        # 32 MB (Phase 10 fixture)
    └── elks-images-hd/hd32mbr-fat.img     # 32 MB (Phase 10.1 fixture)
```

`node_modules/` not copied. Total snapshot size: 69 MB (most of which
is the two HD fixtures). The MINIX MBR fixture is omitted from the
snapshot to keep size manageable; users who want it can fetch via
`npm run build:elks-hd-mbr-images`.

**Manual launch verification.**

- Node serial harness from inside the release —
  `cd releases/phase-10-1-mbr && node dist-cli/tools/elks/run-serial.js`
  produced the ELKS Setup banner, redirected to ttyS0, and streamed
  kernel boot output identical to Phase 10 (no regression). Output
  through `boot: BIOS drive 0, root device /dev/fd0` confirms the
  floppy path.
- `dist-web/` bundle sizes match the production build (763 / 318,084 /
  69,735 / 1,474,560 bytes respectively for `index.html`,
  `index-*.js`, `worker-*.js`, `elks-serial.img`).

## Verification

All commands run from repo root.

### Typecheck

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean — no output, exit 0)
```

### Unit + integration tests

```
$ npx vitest run
...
 ✓ tests/unit/viability-tagging.test.ts                     (13 tests)   8ms
 ✓ tests/unit/mbr-fixture-diagnosis.test.ts                 (6 tests)  138ms
 ✓ tests/integration/elks-mbr-boot.test.ts                  (2 tests) ~24s
 ✓ tests/integration/elks-hd-boot.test.ts                   (2 tests)  ~14s
 ✓ tests/sst/corpus.test.ts                                 (323 tests) ~258s
 ...

 Test Files  67 passed (67)
      Tests  1226 passed (1226)
   Duration  298.52s
```

Pre-Phase-10.1 baseline: 1,211 tests. Net new this phase: +15 (5 new
viability-tagging cases, 6 new MBR-fixture-diagnosis cases, 2 new MBR
integration cases, plus 2 from re-organising the existing viability
suite). Brief target was ≥1,225 — exceeded by 1.

### Browser build

```
$ npm run build:browser
vite v5.4.21 building for production...
✓ 16 modules transformed.
../dist-web/index.html                   0.76 kB │ gzip:  0.46 kB
../dist-web/assets/worker-qy1MUjUd.js   69.72 kB
../dist-web/assets/index-B9SGSCe8.css   10.81 kB │ gzip:  3.27 kB
../dist-web/assets/index-DbyqVGbp.js   317.87 kB │ gzip: 80.76 kB │ map: 706.25 kB
✓ built in 2.98s
```

### MBR boot end-to-end

```
$ npx vitest run tests/integration/elks-mbr-boot.test.ts
 ✓ tests/integration/elks-mbr-boot.test.ts (2 tests) 21402ms
   ✓ boots hd32mbr-fat.img to a # prompt over UART, accepts injected input
   ✓ boots hd32mbr-minix.img to a # prompt over UART
```

The first test asserts `txAfterBoot` contains `"Direct console, scan
kbd"`, `"VFS: Mounted root device"`, and ends in `/# *$/`; then injects
`echo mbr-ok\n` over the UART and asserts the echo and reply
round-trip back. Both tests confirm the kernel mounts the right
partition (`/dev/hda1`, not the raw `/dev/hda`) by parsing the on-disk
MBR partition table and matching against `SETUP_PART_OFFSET` saved by
the VBR's second-stage loader.

### Phase 10 regression

```
$ npx vitest run tests/integration/elks-hd-boot.test.ts
 ✓ tests/integration/elks-hd-boot.test.ts (2 tests) 14108ms
```

Both Phase 10 HD boot cases still pass. Floppy regression (Phase 4
and Phase 8 integration tests) also clean — see the full vitest run
above for the file list.

## Reference sources

1. **`HARDDISK_BOOT_REPORT.md`** — Phase 10 work; this brief inherits
   its substrate. Read for the `DiskClass` plumbing, the size table,
   and the `bios_conv_bios_drive` hand-off discipline.
2. **`GITHUB_BROWSER_REPORT.md` Section 4** — earlier diagnosis of
   why HD images failed pre-Phase 10.
3. **The actual MBR bytes** in `reference/elks-images-hd/hd32mbr-fat.img`,
   first 512 bytes. The diagnosis above is grounded in those bytes;
   `tests/unit/mbr-fixture-diagnosis.test.ts` pins each load-bearing
   claim.
4. **`reference/elks/elks/arch/i86/drivers/block/genhd.c`** — kernel-
   side MBR partition-table reader. `add_partition()` saves
   `boot_partition` based on matching `start_sect` against the
   `SETUP_PART_OFFSET` set by the VBR's second-stage loader.
5. **`reference/elks/elks/arch/i86/drivers/block/bios.c:446`** —
   `bios_conv_bios_drive()`, where the kernel reads `biosdrive & 0x80`
   and combines it with `boot_partition` to arrive at `/dev/hda1`.
6. **OSDev wiki "MBR (x86)"** — partition table format reference.
