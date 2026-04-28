# emu86 — Agent Brief: Hard-disk Boot Support, Partitionless (Phase 10)

## TL;DR

Land the substrate work that Phase 9.3's diagnosis identified. ELKS
hard-disk images (specifically the partitionless `hd*-fat.img` and
`hd*-minix.img` variants) currently fail to boot in the browser
harness because the worker host doesn't recognise their geometry,
the BIOS hands the kernel a floppy drive number for any boot image,
and INT 13h AH=0x08 returns a floppy type unconditionally. This
brief authorises edits to those locked files to make HD boot work
end-to-end.

**Scope is partitionless only.** MBR-partitioned images
(`hd*mbr-*.img`) are deferred to a follow-up brief — the partition
table reading and offset arithmetic is a distinct concern, and
landing partitionless first validates the substrate-shape changes
without that surface.

The unblocking checklist from `GITHUB_BROWSER_REPORT.md` Section 4
is the diagnosis input for this brief. Re-read it before starting.

Document everything in `HARDDISK_BOOT_REPORT.md`.

You are working in `emu86/`. Read `GITHUB_BROWSER_REPORT.md` Section
4 (the unblocking checklist), and the touched files
(`src/browser/worker-host.ts`, `src/bios/bios-services.ts`,
`src/machine/ibm-pc.ts`, plus their tests). ELKS source at
`reference/elks/` for the kernel-side disk path.

## Hard rules

1. **Don't break existing tests.** 1,175 passing as of Phase 9.3.
   All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **MBR-partitioned images are out of scope.** This brief targets
   `hd32-fat.img` and `hd32-minix.img` shapes (FAT or MINIX volume
   at LBA 0, no partition table). MBR variants land in a follow-up.
6. **You are explicitly authorised** to modify
   `src/browser/worker-host.ts`, `src/bios/bios-services.ts`,
   `src/machine/ibm-pc.ts`, `src/disk/disk.ts`, `web/main.ts`, and
   `src/browser/protocol.ts`. The diagnosis identified these as
   needing changes.
7. **You may add** unit and integration tests for the new code paths.
   No new device design needed.
8. **You may NOT modify** `src/cpu8086/`, `src/memory/`,
   `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
   `src/devices/` (except the disk in src/disk/), `src/console/`,
   `src/host-clock/`, `src/diagnostics/`, or
   `src/browser/worker-host.ts`'s yield strategy / CPU loop.
   Disk-related and BIOS-disk-service changes only; the engine and
   non-disk devices stay untouched.
9. **No fix-and-pray.** The diagnosis is concrete and the change
   shape is mostly known. If something surfaces during
   implementation that the diagnosis didn't predict — and which
   isn't a small interpretation gap — stop, document, and ask.
10. **Verify against ELKS source.** Specifically: confirm what `DL`
    value the kernel reads to pick `/dev/fd0` vs `/dev/hda`, and
    where in the kernel that decision is made. The Phase 9.3
    diagnosis said the kernel keys off `DL`, but it didn't cite the
    line. Cite it in this brief's report.

## Background

Phase 9.3 traced the failure layer-by-layer for `hd32-fat.img`:

- **Layer 2 (worker-host)**: `geometryForSize` returns null for
  32 MB, the boot fails before any guest code runs.
- **Layer 3 (BIOS INT 19h handler)**: even if geometry were known,
  `driveNumber = 0x00` is hardcoded, and the kernel reads `DL` to
  decide `/dev/fd0` vs `/dev/hda`.
- **Layer 4 (BIOS INT 13h AH=0x08)**: `BL = 0x04` (1.44 MB type)
  is hardcoded, wrong for HD but only a correctness issue.
- **Layer 5 (ibm-pc.ts machine wiring)**: drive registration may
  assume drive 0; HD wants 0x80.
- **Layer 5b (disk.ts)**: `InMemoryDisk` reads sector-by-sector
  generically — already HD-ready, **no substrate change needed**.

This brief lands all of the above except the MBR-specific work.

## Scope

### Section 1 — verify the diagnosis (mandatory first step)

Before changing code, confirm the Phase 9.3 diagnosis still holds
and pin the kernel-side reference points the diagnosis cited but
didn't fully ground:

1. **Where in ELKS does the kernel read DL to pick the boot disk
   class?** Cite file and line. The Phase 9.3 report said the
   kernel "keys off DL"; the citation needs to live in this brief's
   report so future-you doesn't re-derive it.
2. **What does ELKS expect at `/dev/hda`?** Specifically, does the
   ELKS HD driver read sector zero as a FAT/MINIX volume directly,
   or does it expect an MBR with the volume in a partition?
   Important for distinguishing partitionless vs MBR boot paths.
3. **What CHS geometry does ELKS expect to see for `hd32-fat.img`?**
   The published image is 32,514,048 bytes. ELKS images are
   conventionally 16 heads × 63 sectors × N cylinders × 512;
   32,514,048 / (16 × 63 × 512) ≈ 63.0 cylinders. So 63 cyl × 16 hd
   × 63 spt × 512 = 32,514,048 exactly. Confirm this geometry by
   reading the ELKS HD driver or the image build scripts at
   `reference/elks/elks/Make.devices` or wherever the image
   geometry is declared. Cite.
4. **Does the kernel try INT 13h AH=0x08 to query geometry, or does
   it hardcode the geometry from the image type?** Determines how
   strict our AH=0x08 implementation needs to be for HD.

If section 1 turns up something that contradicts the Phase 9.3
diagnosis, stop and report. Otherwise proceed.

### Section 2 — DiskGeometry plumbing through the boot config

Today the worker-host infers geometry from the image size via a
hardcoded table. The diagnosis suggests passing geometry explicitly
through the boot config — this is cleaner and aligns with letting
the user's library entry carry the relevant context.

Implementation:

- Extend `BootConfig` (in `src/browser/protocol.ts`) with optional
  fields:
  - `diskClass?: 'floppy' | 'hard-disk'` — discriminator.
  - `geometry?: DiskGeometry` — optional explicit geometry. If
    provided, used directly; if not, the worker host falls back to
    the size-table.
- Extend the size-table in `worker-host.ts` to include the four
  ELKS HD shapes from Section 1 (32,514,048 / 32,546,304 /
  67,107,840 / 67,140,096 bytes). Map `hd*` sizes to a HD-class
  geometry. The 32,546,304 and 67,140,096 sizes are the *MBR*
  variants — they have an extra 32,256 bytes for the MBR/partition
  table. Map them to the same geometry as their partitionless
  cousins; the MBR variant boot path is out of scope but the
  geometry inference doesn't care.
- The worker host derives `diskClass` from geometry (or from an
  explicit `diskClass` field in BootConfig if provided): if the
  geometry's heads are large (≥ 4) and capacity exceeds, say,
  3 MB, it's HD; otherwise floppy. Pick a heuristic, document it.
- `web/main.ts` continues to call the worker host without
  explicitly setting `diskClass` for the bundled image; the
  size-table inference handles the existing path. For library
  entries, optionally pass through any stored geometry — this is
  forward-compat for a future "user-set geometry" UI.

The library schema doesn't need to change for this brief — the
viability tagger already classifies HD images correctly. A future
brief could let the user override geometry per-entry.

### Section 3 — INT 19h boot drive number

In `src/bios/bios-services.ts`, `int19Handler`:

- Replace `const driveNumber = 0x00;` with a value derived from the
  disk class. Floppy → `0x00`. Hard-disk → `0x80`.
- The `int19Handler` needs a way to know the class. Options:
  - The machine carries `diskClass` and the BIOS handler reads it
    from machine state.
  - The handler infers from the disk's geometry.
  - The boot config sets it on a field the BIOS reads at INT 19h.
- Pick the cleanest seam. The InMemoryDisk's geometry is already
  available to the BIOS via `ctx.disk.geometry`; deriving from
  that is probably the right move.

### Section 4 — INT 13h AH=0x08 (Get Drive Parameters)

In `src/bios/bios-services.ts`:

- For floppy drives (DL < 0x80): existing behaviour. `BL = 0x04`
  for 1.44 MB is fine for the current floppy paths.
- For hard-disk drives (DL ≥ 0x80): return appropriate values:
  - `AH = 0x00` (success).
  - `BL = 0` (or per-spec; consult OSDev / RBIL).
  - `CH = (cyl - 1) & 0xFF` (low 8 bits of last cylinder).
  - `CL = ((cyl - 1) >> 2) & 0xC0 | (spt & 0x3F)` (high 2 bits of
    cylinder + sectors per track).
  - `DH = heads - 1` (last head).
  - `DL = number of HD drives` (1 in our case, if we have one HD).
  - `ES:DI = 0` (no drive parameter table for fixed disks).
- The geometry comes from the disk attached to the requested drive.
  If the request is for a drive number we don't have, return the
  carry-flag-set error path (RBIL Table 00234 or similar).

### Section 5 — Machine wiring

In `src/machine/ibm-pc.ts`, the disk registration:

- Today, the disk is registered as drive 0 implicitly. For HD
  support, register HD images as drive `0x80`.
- The cleanest seam: the `IBMPCMachine` config gains a
  `diskClass` (or the disk registration itself accepts a drive
  number), and the BIOS-side INT 13h dispatcher routes by drive
  number to the right disk.
- For this brief, only one disk is mounted at a time
  (floppy *or* hard-disk), so the routing is simple: drive
  0x00 → the floppy disk if mounted; drive 0x80 → the HD disk if
  mounted; else error.
- Future work (out of scope) would let multiple disks mount
  simultaneously. The seam should accommodate it without forcing
  it now.

### Section 6 — Disk subsystem

`src/disk/disk.ts` should mostly be unchanged — the Phase 9.3
diagnosis confirmed `InMemoryDisk` is geometry-agnostic at the
read-sector level. The only possible adjustment: a constructor or
factory that constructs an HD-class disk from an image + geometry
without any floppy assumptions. If the existing constructor already
works, leave it. Document.

### Section 7 — What you are NOT building

- MBR partition table reading. Out of scope; follow-up brief.
- Multiple simultaneous disks (floppy and HD mounted at once).
- INT 13h extensions (AH=0x4x — large LBA addressing). Not needed
  for ELKS; the kernel uses CHS.
- Disk write path expansion. Reads are what the boot path needs;
  if writes already work for floppy, they work for HD via the same
  generic `InMemoryDisk`.
- IDE / ATA emulation. Our model is BIOS-services-only; ELKS uses
  BIOS for HD just as it does for floppy (no ATA driver in the
  image we're targeting).
- A "select disk class" UI affordance. The library list shows
  what's stored; `diskClass` is inferred from size/filename.
- Multiple HD drives.
- HD images larger than 67 MB.
- DOS boot support. Future brief if anyone wants it.

## Tests

### Unit tests

- **`tests/unit/disk-geometry.test.ts`** *(new or extend)*: 4-6
  cases. Size → geometry mapping for each ELKS HD shape; mapping
  for the MBR-variant sizes (geometry resolves; the MBR-vs-
  partitionless distinction lives elsewhere); unrecognised sizes
  return null; explicit BootConfig geometry overrides table.
- **`tests/unit/bios-int13-hd.test.ts`** *(new)*: ~6-8 cases. INT
  13h AH=0x08 for HD: geometry returns correctly in CH/CL/DH/DL
  registers; drive count in DL after the geometry; error path for
  invalid drive numbers; floppy path still returns the original
  values when DL < 0x80.
- **`tests/unit/bios-int19-hd.test.ts`** *(new or extend existing
  int19 tests)*: 2-3 cases. INT 19h for floppy disk class sets
  `DL = 0x00`. INT 19h for HD class sets `DL = 0x80`.
- **`tests/unit/machine-disk-routing.test.ts`** *(new)*: 2-3 cases.
  HD disk mounted as 0x80 routes correctly through INT 13h reads;
  floppy mounted as 0x00 routes correctly; missing-drive returns
  error.

### Integration tests

- **`tests/integration/elks-hd-boot.test.ts`** *(new)*: 1-2 cases.
  Construct an `IBMPCMachine` with a known-good `hd32-fat.img` (or
  `hd32-minix.img`) image — small enough to commit to test
  fixtures? **Decide based on size**: if the test image is small
  enough (< 5 MB) to commit, do so under
  `reference/elks-images-hd/`; otherwise build an `npm run
  build:elks-hd-image` script that fetches it on demand, with the
  test skipped if the fixture is absent. This pattern was used for
  the serial image in Phase 8.
  - Boot to the kernel banner.
  - Boot to the `# ` prompt (with `init=/bin/sh` if needed; check
    whether the HD image's userland reaches a prompt
    out-of-the-box).
  - Run a userland command, capture output, assert.

### Smoke tests

The existing floppy-boot integration tests (`elks-interactive`,
`elks-serial`, browser-worker-host) must keep passing. The
diskClass-derived `DL` value for floppy must continue to be
`0x00`; verify.

## Watch out for

- **DL is the linchpin.** The kernel's `/dev/fd0` vs `/dev/hda`
  decision keys off `DL` after boot sector load. If we set `DL =
  0x80` but the rest of the BIOS handler chain doesn't know about
  HD, the kernel will probe `/dev/hda` and find nothing because the
  INT 13h call for `DL = 0x80` returns the wrong values. Fix all
  the layers, not just one.
- **Geometry off-by-one.** CHS geometry is conventionally 0-indexed
  for sector count but 1-indexed in CHS-coordinate values for some
  BIOS calls. RBIL is the canonical reference: cylinders are
  0-indexed (so the value reported is `cyl - 1`); heads are
  0-indexed (value is `heads - 1`); **sectors are 1-indexed**
  (value is `spt`, not `spt - 1`). Easy to get wrong.
- **The 32,546,304-byte MBR variant has a 32,256-byte offset.**
  That's exactly 63 sectors (1 track × 63 spt × 512 = 32,256). The
  MBR variant uses track 0 for the partition table; the volume
  starts at track 1. This brief doesn't read MBRs but the geometry
  table needs to recognise the size — it's the same geometry as
  partitionless `hd32`, just with an MBR offset that's irrelevant
  to the size→geometry mapping. Make sure the mapping covers both
  sizes.
- **Two-disk machine config.** If `IBMPCMachine` config grows to
  accept both a floppy and an HD, ensure the existing single-disk
  path stays working. Forward-compat without breaking back-compat.
- **The ELKS HD driver may probe.** Read the kernel source to
  confirm what calls it makes during init. If it issues an INT 13h
  AH=0x10 (test drive ready) or AH=0x15 (get drive type) before
  AH=0x08, those need to return sensible values too. The Phase 9.3
  report's CPU/bug-candidates section flagged AH=0x15 returning
  `AH=0x03` unconditionally for `DL ≥ 0x80` — that's the right
  answer for "fixed disk present" so it's already fine.
- **CHS arithmetic for reads.** The disk's `read(cyl, head,
  sector)` already exists for floppy. For HD, the same call shape
  works with the new geometry, but the *valid range* is different
  (e.g., 63 spt vs 18 spt). Make sure the `InMemoryDisk` validates
  the request against the disk's own geometry, not against a
  hardcoded floppy assumption.
- **Test-fixture image size.** The `hd32-fat.img` is 32 MB. That's
  big to commit to a test repo. The Phase 8 pattern (build script
  fetches and skips the test if absent) is probably the right
  precedent.
- **Boot loader behaviour.** ELKS's boot sector for HD images may
  not be the same as for floppies. Confirm in Section 1 of the
  diagnosis. If the HD image's boot sector loads the kernel
  differently (e.g., expects to be at LBA 0 with absolute sector
  addresses), the BIOS INT 19h boot must hand off correctly.

## Definition of done

**Implementation success:**
- `npm test` includes the HD boot integration test, and it passes
  (boots to `# ` from a `hd*-fat.img` or `hd*-minix.img`).
- All prior tests green.
- Manual: in the browser harness, download `hd32-fat.img` from the
  GitHub library (or upload manually), set as boot, reload — the
  kernel mounts `/dev/hda` and reaches a prompt.
- The viability tag for HD images can be honestly relaxed in a
  follow-up brief (this brief leaves the tagger as-is; the report
  notes the tagging rule should be revisited after this lands).

**Test counts:**
- All 1,175 prior tests pass.
- Geometry: 4-6 new cases.
- INT 13h HD: 6-8 new cases.
- INT 19h HD: 2-3 new cases.
- Machine routing: 2-3 new cases.
- HD boot integration: 1-2 cases (skip if fixture absent).
- Total ≥ 1,190.

**Verification:**
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).
- Manual: Node serial harness boots floppy as before (no
  regression).
- Manual: browser harness boots HD image end-to-end.
- Release snapshot at `releases/phase-10-harddisk/` populated and
  manually launch-verified.

## Release snapshot

After all verification commands pass and before writing the report,
copy the working artefacts to a self-contained release folder.

Layout:

```
releases/phase-10-harddisk/
├── README.md                # launch commands + what's new
├── package.json             # copy of root manifest
├── package-lock.json        # copy of root lockfile
├── dist-cli/                # compiled Node CLI tools
├── dist-web/                # Vite production bundle
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/hd32-fat.img    # if committed; else absent
```

`node_modules/` is **not** copied.

Verify the snapshot is launchable manually:
- Launch the Node serial harness from within the release; confirm
  floppy boot to `# `.
- Launch a static server against `dist-web/`; open in a browser;
  verify the GitHub browser still works, and verify HD boot from a
  downloaded `hd32-fat.img`.

Document both verification outputs in the report.

The report at `HARDDISK_BOOT_REPORT.md` has these sections:

- **Summary**: outcome, what works, what's deferred to MBR brief.
- **Diagnosis confirmation**: answers to all section-1 questions
  with file:line citations.
- **Implementation**: changes per file with rationale; geometry
  table additions; INT 19h drive-number derivation; INT 13h AH=0x08
  HD branch; machine wiring; any disk-layer adjustments.
- **DL discrimination**: the kernel-side `/dev/fd0` vs `/dev/hda`
  decision pinpointed, the BIOS-side path that produces the right
  DL.
- **Test fixture decision**: committed image vs build script;
  rationale.
- **What's deferred**: MBR partition table reading; multi-disk
  machine config; INT 13h LBA extensions; user-overrideable
  geometry UI; viability tagger update for HD images.
- **Things future briefs should address**: MBR partition variant
  (Phase 10.1); CGA-canvas; network device; snapshot/restore;
  multi-disk; viability rule revisit.
- **CPU/memory bug candidates**: anything noticed during HD boot
  tracing.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`GITHUB_BROWSER_REPORT.md` Section 4** — the unblocking
   checklist that drives this brief.
2. **`reference/elks/elks/arch/i86/drivers/block/`** — kernel HD
   driver. Cite the DL-discrimination point.
3. **`reference/elks/elks/Make.devices`** (or wherever HD device
   nodes are declared) for confirming `/dev/hda` semantics.
4. **`src/browser/worker-host.ts`** — geometry inference and
   BootConfig consumption.
5. **`src/bios/bios-services.ts`** — INT 19h, INT 13h handlers.
6. **`src/machine/ibm-pc.ts`** — disk registration.
7. **`src/disk/disk.ts`** — the InMemoryDisk; mostly read-only
   reference, no substrate change expected.
8. **RBIL** (Ralf Brown's Interrupt List) — INT 13h AH=0x08 return
   values for hard-disk type. Any modern mirror works.
9. **OSDev wiki "ATA"** and "BIOS Boot" pages for context.

## Final notes

This brief lands the changes Phase 9.3's diagnosis lined up. The
work is concrete and the path is clear; the discipline this brief
asks for is **don't expand into MBR support**. The MBR variant has
its own surface (partition table parsing, offset arithmetic in
sector reads, possibly LBA mode considerations). It earns its own
brief, and that brief is much smaller because it inherits the DL /
geometry / drive-routing work from this one.

After this lands, the natural next briefs in priority order are:
(a) MBR partition variant — small, builds on this; (b) viability
tagger update — even smaller, web-only; (c) CGA-canvas renderer for
graphics-mode guests — broader scope; (d) network device toward
SSH-style; (e) snapshot/restore.

The user's stated motivation — evaluating large toolchain-bearing
ELKS images in our emulator — gets fully unblocked with (a). After
(a), every published ELKS image is a candidate.
