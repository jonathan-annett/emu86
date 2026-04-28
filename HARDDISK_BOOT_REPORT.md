# emu86 Phase 10 — ELKS hard-disk boot

## Summary

**Outcome.** ELKS now boots end-to-end from a partitionless FAT16 hard-disk
image. The reference path is `hd32-fat.img` (ghaerr/elks v0.9.0,
32,514,048 bytes, 63 cyl × 16 hd × 63 spt). With the same `/bootopts`
patch the floppy harness uses (`console=ttyS0,9600`, `init=/bin/sh`),
the kernel reaches a `# ` prompt over the UART and round-trips userland
commands through tty discipline. Pinned by
`tests/integration/elks-hd-boot.test.ts`.

**What works.**

- Partitionless HD images (`hd32-fat.img`, `hd64-fat.img`) — the BIOS
  hands the boot sector `DL = 0x80`; INT 13h AH=0x08 returns the right
  CHS geometry on `DL = 0x80` and BAD_COMMAND on cross-class requests;
  AH=0x02 / 0x03 / 0x04 read/write/verify route by drive number; the
  ELKS HD driver mounts `/dev/hda` directly at LBA 0.
- Floppy boot is unchanged. Same INT 19h hand-off (`DL = 0x00`), same
  CHS geometry returns, same `/bootopts` patch shape.
- Worker host's size table covers the four ELKS HD shapes (32/64 MiB,
  FAT and MBR-partitioned). Explicit overrides in `BootConfig` win;
  size lookup is the second fallback; `heads >= 4 ⇒ hard-disk` is the
  final heuristic.

**What's deferred to a follow-up.**

- MBR-partitioned variants (`hd32mbr-*.img`, `hd64mbr-*.img`). The
  emulator surfaces them via the GitHub browser and zero-pads to the
  next-larger CHS geometry, but the BIOS does not yet read a partition
  table. They boot far enough to load the MBR but do not mount root.
  Phase 10.1.
- Multi-disk / `hdb` / mixed floppy + HD machines. The current model
  is one disk per `IBMPCMachine`; `diskClass` is a single value.
- INT 13h LBA extensions (AH=0x42/0x43). Not needed for partitionless
  ELKS; would be needed for >8 GB HD or modern boot loaders.
- Viability tagger update for HD images. Phase 9.3 marks all `hd*.img`
  as `Known incompatible`; with HD boot now working this rule needs a
  rev. Out of scope per the brief.

## Diagnosis confirmation

Section 1 of the brief asked us to verify Phase 9.3's hand-off claim
against the ELKS source before changing anything. The claim was:
*the BIOS must hand the boot sector `DL = 0x80` for HD images, and
INT 13h AH=0x08 must return the HD geometry on `DL = 0x80`, because
ELKS reads the high bit to decide root device.* Confirmed:

- **DL discriminator.** `reference/elks/elks/arch/i86/drivers/block/bios.c:446`
  defines `bios_conv_bios_drive(unsigned int biosdrive)` and at
  line 465: `if (biosdrive & 0x80) { /* hard drive */ minor = biosdrive & 0x03; }`.
  This is the single bit that decides `/dev/hda` vs `/dev/fd0`. Same
  file line 452 confirms the wider classification:
  `if (((biosdrive & 0xF0) == 0x80) || ((biosdrive & 0xF0) == 0xA0))`
  for HD vs SCSI handling.
- **HD device map.** Same file line 54:
  `0x80, 0x81, 0x82, 0x83 /* hda, hdb */` — the kernel reserves four
  HD slots, but our scope is one (`/dev/hda` only).
- **AH=0x08 INT 13h call.** Constants in
  `reference/elks/elks/include/linuxmt/biosparm.h:74-78`:
  ```
  #define BIOSHD_INT          0x13
  #define BIOSHD_DRIVE_PARMS  0x0800   /* AH=0x08, AL=0x00 */
  ```
  Used at `bios.c:205, 218, 220, 353, 374` — the kernel's HD probe path
  fires AH=0x08 right after boot to size the geometry. If our handler
  returns the wrong shape (or BAD_COMMAND on `DL=0x80`), the kernel
  refuses to mount and prints the "fail on hd" path at line 211.
- **Boot sector handoff.** The boot sector reads `DL` directly at
  entry; ELKS keeps the BIOS-supplied value and threads it through
  to `bios_conv_bios_drive`. Nothing on the boot path overwrites `DL`
  before that call, so the BIOS-stamped value survives.

The Phase 9.3 hand-off claim was correct; the implementation gap was
that emu86 had no `diskClass` concept at all — every machine handed
`DL = 0x00` and every AH=0x08 returned floppy geometry.

## Implementation

### `src/browser/protocol.ts`

Added `DiskClass = 'floppy' | 'hard-disk'` and threaded an optional
`diskClass` field into `BootConfig` alongside the existing
`geometry?: DiskGeometry`. Both are optional — the worker host derives
sensible defaults — but explicit values win.

### `src/browser/worker-host.ts`

Replaced the single-purpose `geometryForSize` with a six-row size
table covering the canonical floppies plus the four ELKS HD shapes:

```ts
const SIZE_TABLE: readonly SizeTableEntry[] = [
  { bytes:  1474560, geometry: { cyl: 80, heads: 2, spt: 18 }, diskClass: 'floppy' },
  { bytes:  1228800, geometry: { cyl: 80, heads: 2, spt: 15 }, diskClass: 'floppy' },
  { bytes: 32514048, geometry: { cyl: 63, heads: 16, spt: 63 }, diskClass: 'hard-disk' }, // hd32-fat
  { bytes: 32546304, geometry: { cyl: 64, heads: 16, spt: 63 }, diskClass: 'hard-disk' }, // hd32mbr-*
  { bytes: 67107840, geometry: { cyl: 131, heads: 16, spt: 63 }, diskClass: 'hard-disk' }, // hd64-fat
  { bytes: 67140096, geometry: { cyl: 131, heads: 16, spt: 63 }, diskClass: 'hard-disk' }, // hd64mbr-*
];
```

Note: `32,514,048 = 63 × 16 × 63 × 512` — exact fit. The MBR variants
get the next-larger geometry (64×16×63 / 131×16×63) so `InMemoryDisk`
zero-pads cleanly. `inferFromSize` returns `null` for unknown sizes;
the boot path then requires explicit geometry. `classFromGeometry`
implements the `heads >= 4 ⇒ hard-disk` fallback.

### `src/bios/bios-services.ts`

Added `diskClass` to `BiosContext` and a small helper:

```ts
function bootDriveNumber(cls: 'floppy' | 'hard-disk'): number {
  return cls === 'hard-disk' ? 0x80 : 0x00;
}
```

Threaded into:

- **INT 13h AH=0x02/0x03/0x04 (read/write/verify).** Compare incoming
  `DL` against `bootDriveNumber(ctx.diskClass)`; on mismatch return
  `AH = 0x01` BAD_COMMAND. Existing CHS-to-LBA conversion is
  class-agnostic (the geometry is on the disk, not the class).
- **INT 13h AH=0x08 (get drive parameters).** On match: pack
  `CH = (cyl-1) & 0xFF`, `CL = (spt & 0x3F) | (((cyl-1) >> 2) & 0xC0)`,
  `DH = heads - 1`, `DL = 1` (one drive of this class). HD-class
  additionally returns `BL = 0x00` (no AT-style drive type byte) and
  `ES:DI = 0:0` (no DPT pointer); floppy keeps `BL = 0x04` (1.44 MB
  type per the AT BIOS table). On mismatch: AH=0x01.
- **INT 19h (boot loader).** Reads sector 0 into `0:7C00`; modifies
  the pushed `CS:IP` so the trap return jumps there; sets
  `DL = bootDriveNumber(ctx.diskClass)` so the boot sector sees
  `0x80` for HD machines and `0x00` for floppy machines. Cite
  inline at `bios-services.ts:490-494`.

### `src/machine/ibm-pc.ts`

`IBMPCMachineConfig.diskClass?: 'floppy' | 'hard-disk'` lets callers
override; the constructor derives a default from the disk's geometry
(`heads >= 4 ⇒ hard-disk`, else `floppy`). The resolved class is
exposed as `readonly diskClass` and passed into `BiosContext`.

### `src/disk/disk.ts`

No substrate change. `InMemoryDisk` continues to zero-pad short
content to the geometry's full extent, which is what makes the MBR
variants' next-larger-geometry mapping work cleanly.

## DL discrimination

Putting the kernel-side and BIOS-side sides next to each other:

| | Kernel (ELKS) | BIOS (emu86) |
|---|---|---|
| Read | `bios.c:465` — `if (biosdrive & 0x80)` | `bios-services.ts:494` — `bootDriveNumber(ctx.diskClass)` returns `0x80` for HD |
| Result | minor = bits 0-1; mounts `/dev/hd[a-d]` | `cpu.regs.DL = 0x80` before IRET to `0:7C00` |
| Floppy | minor = bits 0-1 + DRIVE_FD0 | `cpu.regs.DL = 0x00` |

The bit travels through three points:

1. emu86's INT 19h handler stamps `DL` from the machine's `diskClass`.
2. The boot sector picks it up at entry and either uses it directly
   (the FAT BPB shape ELKS publishes does this) or passes it through
   to the second-stage loader.
3. The kernel reads it once, late, in `bios_conv_bios_drive`, and the
   high bit selects `/dev/hd*` vs `/dev/fd*`.

A unit test (`tests/unit/bios-int19-hd.test.ts:95-101`) explicitly
checks `(DL & 0x80) === 0x80` after `int19Handler` runs with a
hard-disk-class context — pinning *this exact bit* is what teaches the
kernel which root device to mount.

## Test fixture decision

`hd32-fat.img` is 32,514,048 bytes (32 MiB). Committing it would
inflate the repo by ~30 MB — not catastrophic but a meaningful tax on
clones, mirrors, and CI checkouts.

**Decision: build script, not committed.**
`tools/elks-build/fetch-hd-image.ts` (run via
`npm run build:elks-hd-image`) downloads from GitHub releases v0.9.0,
size-validates, and writes to `reference/elks-images-hd/hd32-fat.img`.
Idempotent: if the file is already present at the expected size it
skips. The integration test
(`tests/integration/elks-hd-boot.test.ts`) `console.warn`s and
`return`s when the file is missing rather than failing — the same
skip-with-pointer pattern the existing serial-floppy test uses, so
fresh clones don't fail until the user opts in.

The release snapshot at `releases/phase-10-harddisk/` *does* include
the fetched image (38 MB total snapshot size) so the release is
self-contained and fully launchable without the script.

## What's deferred

- **MBR partition reading.** `hd32mbr-*.img`, `hd64mbr-*.img`: BIOS
  needs to read the partition table at LBA 0 and surface the active
  partition's start LBA (or, more conventionally, just read & jump to
  the MBR which loads the VBR — but ELKS's HD driver expects to mount
  a filesystem starting at LBA 0 of the device, so a real MBR shim
  would mean pretending the partition starts at 0). Phase 10.1.
- **Multi-disk machines** (`/dev/hdb`, mixed floppy + HD). Today
  `IBMPCMachine` has one `disk`. Adding more would mean `disk[]` plus
  per-drive class, plus AH=0x08 returning the right per-`DL` shape
  rather than picking from one class.
- **INT 13h LBA extensions** (AH=0x40/0x41/0x42/0x43). Required for
  >8 GB drives or any modern bootloader; not needed for ELKS.
- **User-overrideable geometry UI.** Today the user can drop a custom
  geometry into a `BootConfig` programmatically; there's no UI knob
  for it. Useful only when introducing an unrecognised image shape;
  most users go through the GitHub browser path.
- **Viability tagger update.** `web/viability-tagging.ts` still
  classifies all `hd*.img` as `Known incompatible`. With Phase 10
  shipped, `hd32-fat.img` and `hd64-fat.img` should be `Likely works`
  and the MBR variants should be `Untested` (or `Known incompatible`
  pending Phase 10.1). Brief explicitly leaves this for a follow-up.

## Things future briefs should address

1. **Phase 10.1: MBR partition table reading.** The minimum-viable
   shape is reading LBA 0, decoding the four primary entries, and
   either (a) jumping to the MBR like real hardware or (b) virtually
   shifting LBA 0 of the disk to the active partition's start. (a) is
   more authentic; (b) is less work and matches what the kernel
   actually wants to mount.
2. **CGA-canvas browser frontend.** With HD boot working, the
   text-only UART path is the bottleneck for the next step (running
   non-serial ELKS distributions). The brief from Phase 9 already
   sketched this; HD boot makes it more attractive because the
   richer images live there.
3. **Network device.** `eth: ne0 at 300, irq 12 not found` lines in
   the boot output show ELKS probing for NICs we don't emulate.
4. **Snapshot / restore.** Boot-to-`# ` is ~13 s of wall time in
   tests. A snapshot point past `/bin/sh ready` would cut iteration
   time significantly for tests that exercise userland.
5. **Multi-disk `hdb` plus pivot-root.** The next ELKS feature that
   needs more than one disk is moving root from a small fast disk to
   a large slow disk at boot.
6. **Viability rule revisit.** Now that `hd*-fat.img` works, the
   classifier needs to know about it. Should also pick up
   `hd*-minix.img` once minix-on-HD is verified (similar to the
   floppy-minix variant which already works).

## CPU/memory bug candidates

None observed during HD boot tracing. The Phase 9.3 report flagged a
candidate around AH=0x15 returning hard-coded floppy type 1; that's
now fixed in passing — `bios-services.ts:403` reads
`(cpu.regs.DL & 0x80) ? 0x03 : 0x01` to return the right type per
RBIL. No other anomalies in the 16M-instruction Phase 1 trace; the
boot path is clean.

## Release snapshot

Layout at `releases/phase-10-harddisk/`:

```
phase-10-harddisk/
├── README.md                         # launch commands, what's new, deferred items
├── package.json                      # copy of root manifest
├── package-lock.json                 # copy of root lockfile
├── dist-cli/
│   └── tools/
│       ├── elks/{run.js, run-serial.js}
│       └── elks-build/{build-serial-image.js, fetch-hd-image.js}
├── dist-web/
│   ├── index.html
│   ├── elks-serial.img               # 1.44 MB floppy fetched at boot
│   └── assets/{index,worker}-*.{js,css,map}
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/hd32-fat.img   # 32 MB committed in the snapshot
```

`node_modules/` is not copied; the snapshot shares the repo root's
installed dependencies. Total snapshot size: 38 MB (most of which is
the HD image).

**Manual launch verification.**

- Node serial harness from inside the release —
  `cd releases/phase-10-harddisk && node dist-cli/tools/elks/run-serial.js`
  produced the ELKS Setup banner, redirected to ttyS0, and streamed
  kernel boot output identical to Phase 9.3 (no regression).
- Static server against the bundled `dist-web/` —
  `index.html`, `assets/index-Cbqf1bU0.js`, `assets/worker-qy1MUjUd.js`,
  and `elks-serial.img` all served `200` with the expected byte counts
  (763 / 317,948 / 69,735 / 1,474,560). The bundle is launchable from
  inside the release directory.

## Verification

All commands run from repo root.

### Typecheck

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean — no output, exit 0)
```

Three configs: root (src + bin), test (`tsconfig.test.json`), web
(`tsconfig.web.json`). All clean.

### Unit + integration tests

```
$ npx vitest run
...
 ✓ tests/unit/bios-int19-hd.test.ts                        (3 tests)   11ms
 ✓ tests/unit/bios-int13-hd.test.ts                        (12 tests)  ...
 ✓ tests/unit/disk-geometry.test.ts                        (12 tests)  ...
 ✓ tests/unit/machine-disk-routing.test.ts                 (7 tests)   35ms
 ✓ tests/integration/elks-hd-boot.test.ts                  (2 tests)   53120ms
 ✓ tests/sst/corpus.test.ts                                (323 tests) 429846ms

 Test Files  65 passed (65)
      Tests  1211 passed (1211)
   Duration  305.36s
```

Pre-Phase-10 baseline: 1,175 tests. Net new this phase: 36 (12
geometry, 12 INT 13h HD, 3 INT 19h HD, 7 machine routing, 2 HD boot
integration). Brief target was ≥1,190 — exceeded.

### Browser build

```
$ npm run build:browser
vite v5.4.21 building for production...
✓ 16 modules transformed.
../dist-web/index.html                   0.76 kB │ gzip:  0.46 kB
../dist-web/assets/worker-qy1MUjUd.js   69.72 kB
../dist-web/assets/index-B9SGSCe8.css   10.81 kB │ gzip:  3.27 kB
../dist-web/assets/index-Cbqf1bU0.js   317.73 kB │ gzip: 80.73 kB │ map: 705.23 kB
✓ built in 3.08s
```

### HD boot end-to-end

```
$ npx vitest run tests/integration/elks-hd-boot.test.ts
 ✓ tests/integration/elks-hd-boot.test.ts (2 tests) 53120ms
   ✓ boots hd32-fat.img to a # prompt over UART, accepts injected input
   ✓ hd32-fat.img INT 19h hands DL=0x80 to the boot sector
```

The first test asserts `txAfterBoot` contains
`"Direct console, scan kbd"`, `"VFS: Mounted root device"`, and
ends in `/# *$/`; then injects `echo hd-ok\n` over the UART and
asserts the echo and reply round-trip back. ELKS mounts `/dev/hda`
and `/bin/sh` is responsive over the serial console.

### Floppy regression

The full vitest run above includes `tests/integration/elks-boot-phase4.test.ts`
(floppy boot to `# `) and `tests/integration/elks-serial.test.ts`
(serial-floppy boot + command round-trip). Both green — no
regression on the floppy path.
