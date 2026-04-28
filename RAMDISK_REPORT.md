# emu86 Phase 11.5 — ELKS ramdisk diagnosis

## Summary

**Outcome A — works out of the box.** ELKS's `/dev/rd0` ramdisk is
fully functional in our emulator with no substrate changes. The
kernel driver allocates from conventional memory via `seg_alloc()`,
which our emulator already models correctly. The published
`fd1440-minix.img` ships with `/bin/ramdisk`, `/bin/mkfs`,
`/bin/mount`, `/bin/umount`, plus the `/dev/rd0` and `/dev/rd1` device
nodes. A single integration test exercises the full round-trip —
allocate → mkfs → mount → write → read → unmount — and verifies the
file content lands back on the tty as the kernel echoes it.

One image-selection finding worth noting: the brief named
`fd1440-fat-serial.img` as the candidate harness image, but FAT12
cannot store device nodes. That image's `/dev` is empty, so
`/dev/rd0` does not exist and the userland `ramdisk` tool would fail
at `open()`. The MINIX floppy image (Phase 7's image) has all the
required device nodes baked in by `image/Make.devices`, and the
brief's "or whichever image gets you to a `# ` prompt with the right
tools" carve-out applies. Net change: 1 new integration test, no
substrate changes, no lock-list violations.

Total tests: **1,254 passing** (1,253 baseline + 1 new ramdisk).

## Diagnosis

Answers to the brief's Section 1 questions, with file:line citations
into the ELKS source (`reference/elks/elks/` and
`reference/elks/elkscmd/`).

### 1. Where is the driver?

- **Kernel driver**:
  `arch/i86/drivers/block/rd.c` (320 lines, Riddoch 1997, modernised
  Antonic/Haerr Oct 2020). Registers as block major **1**, supports
  up to 2 ramdisks (`MAX_DRIVES` at `rd.c:30`), each composed of up to
  8 chained 64 KB segments (`MAX_SEGMENTS=8`, `ALLOC_SIZE=4096`
  paragraphs at `rd.c:31-32`).
- **Userland tool**: `elkscmd/disk_utils/ramdisk.c`, 68 lines. Three-
  arg invocation `ramdisk /dev/{rd0|ssd} {make|kill} [size]`,
  default 64 KB, max 32767 KB.
- **Kernel header**: `include/linuxmt/rd.h` defines `RDCREATE` and
  `RDDESTROY` ioctl numbers (`(1<<8)|0` and `(1<<8)|1`).
- **Documentation**: `Documentation/text/ramdisk.txt` (concise
  19-line note from Riddoch).

### 2. What memory does it use? (the XMS question)

**Conventional memory only.** The driver calls
`seg_alloc((segext_t)size, SEG_FLAG_RAMDSK)` at `rd.c:176` — the
kernel's segment allocator pulls from the conventional-RAM heap (the
same region used for task structs, buffer cache, etc).

The XMS path is gated by `CONFIG_FS_XMS` in
`include/linuxmt/memory.h:49-78`: when XMS is off, `ramdesc_t` is
just `seg_t` (a paragraph address) and `xms_fmemcpyw` is a macro alias
for `fmemcpyw`. Our emulator's published-image config has
`CONFIG_FS_XMS` **off** (the kernel banner's "xms: ... disabled, A20
error" line is exactly this), and the `defconfig` at
`elks/arch/i86/defconfig:67-68` confirms both `CONFIG_FS_XMS` and
`CONFIG_FS_XMS_RAMDISK` are unset.

So the ramdisk driver lives entirely in conventional RAM, which our
emulator models correctly. This is the single most load-bearing fact
for Outcome A: had the driver wanted XMS, the brief's Outcome B path
would have triggered.

### 3. How is allocation triggered?

User-driven, via the `RDCREATE` ioctl. `rd_ioctl()` at `rd.c:140-216`
handles the ioctl: it loops, calling `seg_alloc()` for each 4096-
paragraph (64 KB) chunk needed to cover the requested size, chains
them via the `rd_segment[].next` linked list, and zeros each chunk
with `fmemsetw()` (`rd.c:158-200`). No auto-allocation — opening
`/dev/rd0` on a fresh boot returns a valid file descriptor but reads
return zero-length until a successful `RDCREATE`.

Userland glue: `elkscmd/disk_utils/ramdisk.c:39-53` opens the device
and issues `ioctl(fd, RDCREATE, size_in_kb)`.

### 4. Is there an mkfs / format step?

Yes. ELKS ships `/bin/mkfs` (Linus's MINIX 1.0-era `mkfs` adapted to
ELKS, source at `elkscmd/disk_utils/mkfs.c`). Usage: `mkfs [-c] [-nXX]
[-iXX] device size-in-blocks`. A 64-block (64 KB) MINIX V1
filesystem is the smallest comfortable formattable size; the metadata
overhead is a few KB.

Other available tools in `elkscmd/disk_utils/`:
- `mkfat` — FAT formatter
- `fsck` — MINIX fsck
- `fdisk`, `partype` — partition utilities

### 5. Does the published image have the tools?

**Yes — `fd1440-minix.img`.** Inspecting the MINIX V1 superblock and
walking the `/bin` directory directly:

| Tool | Inode | Present |
| --- | --- | --- |
| `/bin/ramdisk` | 59 | yes |
| `/bin/mkfs` | 68 | yes |
| `/bin/mkfat` | 127 | yes |
| `/bin/mount` | 121 | yes |
| `/bin/umount` | 90 | yes |
| `/bin/sh` | 8 | yes |
| `/bin/echo` | 42 | yes |
| `/bin/cat` | 26 | yes |
| `/bin/ls` | 131 | yes |

Device nodes (in `/dev`):

| Device | Major,Minor | Notes |
| --- | --- | --- |
| `rd0` | 1,0 | RAM disk 0 |
| `rd1` | 1,1 | RAM disk 1 |
| `ssd` | 2,0 | (separate from rd*, do not conflate) |
| `console`, `tty1`-`tty4`, `ttyS0`-`ttyS3`, `fd0`, `fd1`, `hda`-`hdd` and partitions, `cfa`, `cfb`, `ne0`, `wd0`, `3c0` | various | full set per `image/Make.devices:39-40` for rd0/rd1 |

**`fd1440-fat-serial.img` does NOT have device nodes** because FAT12
cannot store them — the `/dev` directory in the FAT image is empty
apart from `.` and `..`. This is by design (the FAT serial build
uses `init=/bin/sh` per `/bootopts`, skipping `/etc/inittab` and any
device dependency); kernel-level handles like the console-direct
path keep stdout/stdin wired regardless of `/dev` contents. So the
serial FAT image cannot be used to test `/dev/rd0` without first
mounting a MINIX `/dev` overlay. We picked the MINIX image instead.

### 6. Device numbers

Block major **1** (`include/linuxmt/major.h:52` — `RAM_MAJOR`).
Minor selected by `DEVICE_NR(device) ((device) & 1)` at
`elks/arch/i86/drivers/block/blk.h:59`, so rd0/rd1 only — even though
the doc text says minors 0-7, the running driver only supports
`MAX_DRIVES=2`. The `Documentation/text/ramdisk.txt` reference to
"Minor numbers 0-7" is stale documentation; the code is canonical.

### 7. Is it compiled in by default?

Yes. `elks/arch/i86/defconfig:97-99`:

```
CONFIG_BLK_DEV_RAM=y
CONFIG_RAMDISK_SEGMENT=0          # no kernel-pre-allocated ramdisk
CONFIG_RAMDISK_SECTORS=128        # default 64 KB if CONFIG_RAMDISK_SEGMENT≠0
```

`rd_init()` at `rd.c:288-319` runs at boot: registers the block
device, no per-instance probe (the ramdisk is software-only — there's
no hardware to probe).

### 8. Size and limits

| Knob | Value | Source |
| --- | --- | --- |
| Segment size (allocation granularity) | 4096 paragraphs = 64 KB | `rd.c:32` |
| Max segments per ramdisk | 8 | `rd.c:31` |
| Theoretical max per ramdisk | 8 × 64 KB = 512 KB | derived |
| Userland-default size | 64 KB | `disk_utils/ramdisk.c:33` |
| Userland-claimed max | 32767 KB | `disk_utils/ramdisk.c:10` |
| Practical ceiling | conventional-RAM heap | `seg_alloc` |

The userland tool's 32 MB ceiling is purely informational — the
kernel driver stops at `MAX_SEGMENTS × ALLOC_SIZE = 512 KB` before
even consulting the heap allocator. In practice the ceiling for any
single ramdisk is whichever bound is hit first: the kernel's 512 KB
hard cap, or the kernel heap exhaustion when other allocators (buffer
cache, task structs) have already consumed the conventional region.
Our default-config heap (`heap=44000` paragraphs ≈ 700 KB) leaves
ample room for a 64 KB ramdisk; the integration test is well below
the cliff.

## Verification

### Sequence

After login as `root` from the post-boot `# ` prompt:

```
# ramdisk /dev/rd0 make 64
ramdisk: 64Kb ramdisk created on /dev/rd0
# mkfs /dev/rd0 64
[mkfs banner + block counts]
# mount /dev/rd0 /mnt
# echo hello-ramdisk > /mnt/test
# cat /mnt/test
hello-ramdisk
# umount /mnt
```

The integration test injects this sequence (after a separate `root\n`
to log in) via the same `ScancodeTranslator` path Phase 7 used,
runs the emulator for 50M instructions, then asserts on the captured
CGA-mirror text and the live framebuffer.

### Test file

**`tests/integration/elks-ramdisk.test.ts`** (1 case, 174 lines).
Three-phase shape:

1. Boot the MINIX floppy image to the `login:` prompt (8M
   instructions).
2. Inject `root\n`, run to the `# ` shell prompt (5M).
3. Inject the six-command ramdisk sequence above, run for 50M
   instructions while the shell consumes them.

Assertions:

- The boot path didn't regress (`Mounted root device` and `/dev/fd0`
  in the captured stream — same invariants Phase 6/7 pinned).
- The CGA-mirror text contains `Kb ramdisk created on /dev/rd0` —
  the userland tool's success message after a successful ioctl.
- The CGA-mirror text contains `hello-ramdisk` — the round-trip
  payload, written by `echo`, read by `cat` from a file that lives
  on a freshly-formatted, freshly-mounted in-RAM filesystem.
- No "Cannot allocate memory" / "out of memory" surface — would
  indicate an Outcome B `seg_alloc` failure.
- The keyboard controller's queue drained cleanly (kernel kept up
  with input).

The test runs in ~28-42 seconds wall-clock.

### Test results

```
$ npx vitest run tests/integration/elks-ramdisk.test.ts
 ✓ tests/integration/elks-ramdisk.test.ts  (1 test) 27115ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

Full suite:

```
$ npm test
 Test Files  72 passed (72)
      Tests  1254 passed (1254)
   Duration  217.82s
```

Net delta from Phase 11's 1,253 is exactly the new test.
SST corpus 323/323 passing within the suite.

### Documented usage flow

For a user at the live serial harness's `# ` prompt (or the keyboard
harness on the MINIX image):

```bash
# Allocate a 64 KB ramdisk on /dev/rd0
ramdisk /dev/rd0 make 64

# Format with MINIX V1 (block count matches the allocation)
mkfs /dev/rd0 64

# Mount somewhere convenient
mount /dev/rd0 /mnt

# Use it like any other filesystem
echo 'hello' > /mnt/note
cat /mnt/note
ls -l /mnt

# Tidy up
umount /mnt
ramdisk /dev/rd0 kill
```

A second ramdisk on `/dev/rd1` is independent. Ramdisks do not
persist across reboots.

## What's deferred

Per the brief's Section 4 and 8, intentionally out of scope:

- New ramdisk *device* in `src/devices/`. None needed — ELKS's
  ramdisk is software-only.
- Browser UI for ramdisk allocation. Out of scope.
- Snapshot / restore that captures ramdisk contents. Future brief.
- "Ramdisk is the secondary disk" path. Phase 11's secondary slot is
  already a different concern.
- Modifying the published images to extend FAT-shipped builds with
  device nodes. The MINIX images already work; that's the answer.
- Probe-harness work (Phase 12).
- Toolchain survey (Phase 13).

## Things future briefs should address

1. **Phase 12 — probe harness.** Now that ramdisk works, `/dev/rd0`
   is an option for "scratch space the probe script writes to and
   the harness slurps back". The secondary-disk path Phase 11 added
   is still simpler for "scripts in, output out", but ramdisk
   becomes attractive when probe scripts produce large
   intermediates that would otherwise inflate an in-memory image.

2. **Serial harness on MINIX image.** Today, `fd1440-minix.img` is
   CGA-only (no `console=ttyS0` in `/bootopts`). For tests/users that
   prefer the serial harness over the keyboard-injection harness
   *and* need device nodes, building a MINIX serial floppy
   (`fd1440-minix-serial.img`) would unify the two harness paths.
   Mechanically this is `build:elks-serial-image` with a MINIX
   variant — small change, no substrate impact, but out of scope
   here.

3. **Ramdisk size cliff.** The kernel's `MAX_SEGMENTS×ALLOC_SIZE =
   512 KB` per ramdisk bound is silent — the userland tool advertises
   32 MB. A test that drives the user to the cliff would surface the
   actual error path (likely `-ENOMEM` from `find_free_seg`) and
   document the practical ceiling alongside the userland one.
   Not load-bearing for any current use case.

4. **Documentation drift in `Documentation/text/ramdisk.txt`.** The
   doc says "Minor numbers 0-7"; the code says `MAX_DRIVES=2`. This
   is upstream's drift, not ours, but worth noting if anyone files a
   docs PR to ELKS.

## CPU/memory bug candidates

None observed. The ramdisk round-trip is a sequence of standard
syscalls (open/ioctl/read/write/mount/umount) plus `seg_alloc`/
`seg_put` calls — nothing beyond what the existing boot+login path
already exercises. Instruction throughput in Phase 3 of the test
was within the same envelope as Phase 7's interactive boot test;
no slowdowns or wedge-points.

## Release snapshot

Layout: `releases/phase-11-5-ramdisk/`

```
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/                      # compiled Node CLI
├── dist-web/                      # Vite production bundle
└── reference/                     # fixtures
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    ├── elks-images-hd/hd32-fat.img
    └── elks-images-hd/hd32-minix.img
```

Same fixtures as Phase 11; `node_modules/` not copied.

Verified by:
- `node releases/phase-11-5-ramdisk/dist-cli/tools/elks/run-serial.js
  --image releases/phase-11-5-ramdisk/reference/elks-images-serial/fd1440-fat-serial.img`
  reaches the post-boot `# ` prompt with no regression.
- `node releases/phase-11-5-ramdisk/dist-cli/tools/elks/run.js
  --image releases/phase-11-5-ramdisk/reference/elks-images/fd1440-minix.img`
  reaches the `login:` prompt with no regression.
- Browser harness (dist-web) bundle inspected for the strings
  `Mounted root device`, `Secondary disk` (Phase 11 carryover),
  and `secondaryImageSource` — all present.

## Verification

From the repo root:

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean)

$ npm test
…
 Test Files  72 passed (72)
      Tests  1254 passed (1254)
   Duration  217.82s

$ npx vitest run tests/integration/elks-ramdisk.test.ts
 ✓ tests/integration/elks-ramdisk.test.ts  (1 test) 27115ms
   Tests  1 passed (1)
```

SST corpus: 323/323 passing within the full-suite run.

## Reference sources

1. `MULTI_DISK_REPORT.md` — Phase 11; the substrate this brief
   tested against.
2. `KEYBOARD_HARNESS_REPORT.md` — Phase 7; harness pattern reused
   here.
3. `reference/elks/elks/arch/i86/drivers/block/rd.c` — kernel driver.
4. `reference/elks/elks/include/linuxmt/rd.h` — ioctl definitions.
5. `reference/elks/elks/include/linuxmt/major.h:52` — `RAM_MAJOR=1`.
6. `reference/elks/elks/include/linuxmt/memory.h:49-78` — XMS gate.
7. `reference/elks/elks/arch/i86/defconfig:67-99` — config values.
8. `reference/elks/elkscmd/disk_utils/ramdisk.c` — userland tool.
9. `reference/elks/elkscmd/disk_utils/mkfs.c` — MINIX formatter.
10. `reference/elks/Documentation/text/ramdisk.txt` — Riddoch's note.
11. `reference/elks/image/Make.devices:39-40` — `/dev/rd0`/`/dev/rd1`
    creation on MINIX images.
12. `tests/integration/elks-interactive.test.ts` — Phase 7 template.
13. `tests/integration/elks-ramdisk.test.ts` — this brief's
    deliverable.
