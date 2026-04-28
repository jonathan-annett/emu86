# emu86 — Agent Brief: MBR Partition Variants (Phase 10.1)

## TL;DR

Land the partitioned hard-disk variants ELKS publishes
(`hd32mbr-fat.img`, `hd32mbr-minix.img`, `hd64mbr-fat.img`,
`hd64mbr-minix.img`) using **authentic chain-load** — the BIOS
reads sector 0 (the MBR), loads it at 0:7C00, and jumps to it
exactly as real PC hardware does. The MBR's own code parses its
partition table, loads the VBR from the active partition's start
LBA, and jumps to that. The substrate handles all of this naturally
because Phase 10 already gave us the BIOS handoff and the disk
read/geometry layers.

Phase 10 already mapped MBR-variant image sizes to the next-larger
geometry; the disk zero-pads cleanly. The geometry work is done.
This brief is mostly diagnosis ("does the MBR code work
out-of-the-box on our substrate?") plus whatever small fixes the
diagnosis surfaces.

A small tagger update rides along at the end: now that HD boot
works, `hd*-fat.img` should be `Likely works`, `hd*-minix.img`
should be `Untested`, and the MBR-tagged sizes should be `Likely
works` (or `Untested`) once their boot is verified by this brief.

Document everything in `MBR_PARTITION_REPORT.md`.

You are working in `emu86/`. Read `HARDDISK_BOOT_REPORT.md` (the
Phase 10 work) and `GITHUB_BROWSER_REPORT.md` Section 4 (the
broader hard-disk diagnosis). The touched files are
`src/bios/bios-services.ts` (possibly), `tests/integration/`,
`web/viability-tagging.ts`, and any new test files.

## Hard rules

1. **Don't break existing tests.** 1,211 passing as of Phase 10.
   All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **Authentic chain-load only.** No virtual-shift translation
   layer. The MBR's own code parses the partition table; the BIOS
   does not. The user has explicitly chosen this shape.
6. **Diagnose before implementing.** Inspect the actual MBR from
   `hd32mbr-fat.img`; identify which BIOS calls it makes; confirm
   whether LBA extensions are needed. Phase 5/8/9.3 discipline.
7. **You may modify** `src/bios/bios-services.ts` (only if the
   diagnosis shows specific gaps), `web/viability-tagging.ts`
   (the small tagger update), and any test files. You may add
   integration tests for MBR boot.
8. **You may NOT modify** `src/cpu8086/`, `src/memory/`,
   `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
   `src/devices/`, `src/console/`, `src/disk/`,
   `src/host-clock/`, `src/diagnostics/`, `src/machine/ibm-pc.ts`,
   `src/browser/worker-host.ts`, `src/browser/browser-console.ts`,
   or `src/browser/protocol.ts`. The geometry plumbing from Phase
   10 is complete and stays untouched.
9. **No fix-and-pray.** If diagnosis surfaces a substantial new
   surface (e.g., the MBR demands INT 13h AH=0x42 LBA extensions),
   stop and document. Outcome C (diagnosis-only) is acceptable
   completion.
10. **No virtual-shift fallback.** Even if the diagnosis suggests
    "this would be much smaller as virtual-shift", do not silently
    pivot. The architectural call has been made; deviating from it
    requires re-asking, not silently choosing.

## Background

Phase 10 landed partitionless HD boot. The unblocking work
included:

- Worker host's size table covers MBR variants (`hd32mbr-*` at
  32,546,304 bytes maps to 64×16×63; `hd64mbr-*` at 67,140,096
  bytes maps to 131×16×63 — an extra cylinder vs. the
  partitionless variants, with the disk zero-padding to fill).
- BIOS INT 19h hands `DL = 0x80` to the boot sector.
- INT 13h AH=0x02/0x03/0x04/0x08 route by drive class.

For an MBR-partitioned image, the sector at LBA 0 is the MBR — a
512-byte structure consisting of:

- Bootstrap code (typically ~440 bytes).
- Optional disk signature / timestamp (4 bytes).
- Partition table: 4 entries × 16 bytes at offset 0x1BE.
- Boot signature: `0x55 0xAA` at offset 0x1FE.

When real hardware boots from such a disk, the BIOS reads sector 0
into memory at `0:7C00` and jumps to it. The MBR's code:

1. Optionally relocates itself out of `0:7C00` (typically to
   `0:0600`) to make room for the VBR.
2. Reads the partition table, finds the entry with the active
   flag (`0x80` at byte 0).
3. Loads that partition's first sector — the VBR — to `0:7C00`
   using INT 13h.
4. Jumps to `0:7C00` to begin VBR execution.

The VBR then loads the OS kernel using its own knowledge of the
filesystem (FAT or MINIX in our case).

Our substrate already runs all of this code. Phase 10's BIOS
handoff puts the MBR at `0:7C00` with `DL = 0x80`. The CPU runs
the MBR's relocate-and-load routine. The MBR's INT 13h AH=0x02
read of the VBR uses the same BIOS handler we already implement.
The geometry conversion in INT 13h handles the partition's start
sector correctly because it operates on raw CHS coordinates from
the MBR's perspective, which is the same coordinate space the
disk lives in.

**So in principle, MBR boot should work without any code changes.**
This brief's job is to verify that and fix what doesn't.

## Scope

### Section 1 — diagnosis (mandatory first step)

Before attempting any boot, inspect the MBR. Use a small Node script
or hex dump (`xxd`, `od`) to look at the first 512 bytes of
`hd32mbr-fat.img` from the GitHub-fetched library or a freshly
downloaded copy:

1. **What's the MBR's bootstrap code shape?** Is it standard
   MS-DOS-style (`mbr.S` from the GNU `mbr` package or similar),
   FreeDOS, or ELKS-custom? Identifying the source helps
   anticipate behaviour. Disassemble the first ~50 instructions or
   so — even a partial trace tells you what BIOS calls it makes.
2. **Which INT 13h function does the MBR use?** Check whether the
   bytecode contains the literal `B4 02` (mov AH, 0x02 = legacy
   read), `B4 41` (extensions check), or `B4 42` (LBA read). If
   only AH=0x02, our substrate handles it. If AH=0x41 or AH=0x42
   appear, those need diagnosis: AH=0x41 returns "extensions
   present" or "not present"; AH=0x42 reads via a Disk Address
   Packet at DS:SI. Phase 10's handlers don't implement these.
3. **What's the active partition's start LBA?** Read the partition
   table; find the entry with `boot_flag = 0x80`; record its
   `start_lba` (offset 8 within the entry, little-endian 32-bit).
   Sanity-check against the image's geometry: start_lba should be
   well within the disk's sector count.
4. **What partition type is it?** Byte 4 of the active entry. For
   ELKS images expect `0x06` (FAT16) or some MINIX type
   (`0x80`/`0x81`?) for the MINIX variants. Confirm.
5. **Does the MBR relocate itself?** Standard MBRs do
   (`0:7C00 → 0:0600` or similar). Check the first few
   instructions for a `MOV CX, 0x100; REP MOVSW` pattern or
   equivalent. If it relocates, the CPU substrate must handle the
   memcpy and far jump correctly — these are basic 8086
   instructions that have been validated since Phase 1. Should
   work, but worth flagging.
6. **What's at the active partition's start LBA — the VBR?**
   Inspect those bytes too. The VBR is filesystem-specific. For a
   FAT16 partition, the first 512 bytes are the BPB (BIOS
   Parameter Block) which our existing FAT-on-floppy boot path
   already handles. The VBR's *boot code* may differ from the
   floppy boot code, though — verify it doesn't make demands our
   BIOS can't satisfy.
7. **Compare to the floppy/HD boot we already do.** The successful
   `hd32-fat.img` boot in Phase 10 jumps to LBA 0 directly because
   the FAT volume *is* at LBA 0. For MBR-partitioned images, the
   MBR is at LBA 0 and the FAT volume is at the active partition's
   start LBA. The kernel's `bios_conv_bios_drive` and root-mount
   logic doesn't care; the kernel mounts what's at the start of
   the device-as-it-knows-it, which for MBR images means the VBR's
   filesystem starts at `start_lba`.

If the diagnosis turns up that AH=0x42 (LBA extensions) is needed,
this becomes a meaningfully larger brief — implementing AH=0x41 /
0x42 / 0x43 is a measurable substrate addition. **Stop and report**
in that case; the user can decide whether to authorise the
extension or accept partial completion.

### Section 2 — implementation: confirm or close gaps

Three plausible outcomes from Section 1, each with a different
implementation footprint:

**Outcome A: it just works.** The MBR uses CHS-mode INT 13h
AH=0x02 only; our existing handlers serve it; the boot proceeds
through MBR → VBR → kernel cleanly.

Implementation:
- Add an integration test boot for `hd32mbr-fat.img`.
- Run the boot. Confirm a `# ` prompt appears.
- Inject a userland command, confirm round-trip.
- Repeat for `hd64mbr-fat.img` (sanity check on the larger
  geometry).
- No source-code changes required.

**Outcome B: small gap.** The MBR uses CHS but reveals a small
issue — e.g., it makes an INT 13h AH=0x00 (reset disk) call we
return wrong values for, or AH=0x15 (get drive type) needs slight
adjustment for HD, or some flag-register convention we're getting
slightly wrong. Self-contained, in `bios-services.ts`, fits in a
handful of lines.

Implementation:
- Identify the gap via tracing.
- Close the gap.
- Add a unit test for the new code path.
- Run the integration test as in Outcome A.

**Outcome C: substantial gap.** The MBR uses LBA extensions
(AH=0x41/0x42/0x43) or some other significant new BIOS surface
we haven't implemented. **Stop**. Document:
- What the MBR demands.
- A sketch of what implementing it would entail.
- Whether the user-facing alternative — virtual-shift — would be
  smaller in this specific case (this is *information* for a
  future decision, not a recommendation to switch).

### Section 3 — MINIX MBR variants

After (a) the FAT MBR variant boots, attempt the MINIX MBR variant
(`hd32mbr-minix.img`). The MBR is identical or near-identical
(it's an MBR, not a filesystem-specific structure). The VBR
differs (MINIX FS instead of FAT). The kernel mounts at the active
partition's start LBA in either case — the kernel's HD driver
isn't FAT-specific; it just reads sectors and the mount logic does
the filesystem detection.

If the FAT MBR variant boots cleanly in Outcome A or B, the MINIX
variant should too — but verify, don't assume. The Phase 10
deferred list noted MINIX-on-HD wasn't verified; this brief covers
both.

### Section 4 — viability tagger update

Now that HD boot works, the Phase 9.3 viability tagger
(`web/viability-tagging.ts`) is honestly stale. Update the rules:

- Filenames matching `/^hd\d+-fat\.img$/` (partitionless FAT HD,
  Phase 10-verified) → `likely-works`.
- Filenames matching `/^hd\d+-minix\.img$/` (partitionless MINIX
  HD; assume verified by this brief's MINIX-equivalent test, OR
  leave as `untested` if unverified).
- Filenames matching `/^hd\d+mbr-fat\.img$/` (MBR FAT HD, Phase
  10.1-verified iff Outcome A or B) → `likely-works`. If Outcome
  C, leave as `known-incompatible` and note in the report.
- Filenames matching `/^hd\d+mbr-minix\.img$/` (MBR MINIX HD) →
  same as above.

Add unit test cases pinning each new rule. The existing rule order
("first match wins") still applies.

### Section 5 — what you are NOT building

- INT 13h AH=0x41/0x42/0x43 (LBA extensions). Only if Outcome A or
  B, those stay deferred. If Outcome C reveals they're needed, the
  decision to implement them is the user's, post-brief.
- A virtual-shift translation layer. Architectural call already
  made.
- Multi-partition / non-active-partition selection. The MBR picks
  the active partition; we don't reinterpret.
- GPT (GUID Partition Table). MBR only.
- Logical / extended partitions. Primary partitions only.
- Hot-swapping disks at runtime.
- A "boot from partition N" UI override. The MBR decides; the user
  trusts the image.
- INT 13h AH=0x18 (set media type for format), AH=0x05 (format
  track), or other write-side BIOS services beyond what AH=0x03
  already covers.

## Tests

### Unit tests

- **`tests/unit/viability-tagging.test.ts`** *(extend, ~4-6 new
  cases).* Pin the new HD rules per Section 4.
- **`tests/unit/bios-int13-hd.test.ts`** *(extend, only if Outcome
  B).* Cases for whatever specific gap was closed.

### Integration tests

- **`tests/integration/elks-mbr-boot.test.ts`** *(new, 2-4 cases).*
  - Boot `hd32mbr-fat.img` to a `# ` prompt.
  - Inject a userland command, capture output, assert.
  - Boot `hd32mbr-minix.img` to a `# ` prompt (MINIX-FS variant).
  - Optional: boot one `hd64mbr-*.img` for the larger geometry.

  Use the same fixture pattern as the Phase 10 HD test
  (skip-with-pointer when the fixture is absent; build script
  fetches on demand).

### Smoke tests

All Phase 10 tests must keep passing. Floppy boot must keep
passing. The new MBR boot must not interfere with partitionless HD
boot (separate test files; the worker host's size table now
includes both).

## Watch out for

- **The MBR may relocate itself.** Standard MBR code copies itself
  from `0:7C00` to `0:0600` and jumps. Our CPU has run thousands
  of variants of memcpy + far jump in the corpus. If this fails,
  it's a CPU bug we need to know about — but it almost certainly
  won't.
- **The MBR's stack.** The BIOS leaves the stack pointer wherever
  it was at INT 19h time. Our INT 19h handler should set up a
  reasonable stack before jumping to `0:7C00`. Phase 10 verified
  this for the partitionless case; the MBR case uses the same
  handoff.
- **The active partition's start LBA must fit our CHS conversion.**
  For a partition at start LBA 63 on a 64×16×63 disk, the CHS is
  (0, 1, 1) — head 1, sector 1, cylinder 0. INT 13h AH=0x02 with
  these CHS values must read the right sector. Verify the
  conversion math is correct (Phase 10 verified for sequential HD
  reads; jump reads are the same code path).
- **Boot signature check.** The MBR ends with `0xAA55` at offset
  0x1FE. Some BIOSes refuse to boot if this isn't present. Our
  current INT 19h handler doesn't check (it just reads and jumps).
  If the diagnosis surfaces this as a real-world issue, mention it
  but don't add the check unless it affects ELKS boot.
- **The VBR may also expect `DL = 0x80`.** The MBR sets `DL`
  before jumping to the VBR (some MBRs preserve it; some
  re-stamp). Verify this isn't a gap.
- **Test fixture availability.** The MBR variants are larger than
  the `hd32-fat.img` Phase 10 used. The build script needs to be
  extended to fetch the MBR variants on demand. Same skip-with-
  pointer pattern.
- **Don't conflate MBR variants with hard-disk class.** Both
  `hd32-fat.img` (partitionless) and `hd32mbr-fat.img` (MBR) are
  hard-disk class — same DL=0x80 handoff, same INT 13h AH=0x08
  geometry response. Only the on-disk content differs.
- **The viability tagger update is not a new feature.** It's
  honest tagging refresh. If you find yourself adding tagger logic
  beyond what Section 4 spells out, you've expanded scope.

## Definition of done

**Outcome A or B (full success):**
- All Phase 10 tests pass.
- New integration tests for `hd32mbr-fat.img` and
  `hd32mbr-minix.img` pass — kernel mounts the right device, `# `
  prompt reachable, userland command round-trips.
- Manual: in the browser harness, download an MBR variant from the
  GitHub library, set as boot, reload — works.
- Tagger updated; HD images with verified shapes show
  `likely-works`.
- Total tests ≥ 1,225.

**Outcome C (diagnosis-only):**
- Diagnosis section in report fully populated with citations.
- Concrete sketch of what implementing the missing BIOS surface
  would entail.
- Tagger update happens regardless (the partitionless variants are
  still verified). MBR variants stay `known-incompatible`.
- All Phase 10 tests pass.

In any case:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).
- Release snapshot at `releases/phase-10-1-mbr/` populated and
  manually launch-verified.

## Release snapshot

After all verification passes and before writing the report, copy
the working artefacts to a self-contained release folder.

Layout:

```
releases/phase-10-1-mbr/
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/
├── dist-web/
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    ├── elks-images-hd/hd32-fat.img
    └── elks-images-hd/hd32mbr-fat.img       # if Outcome A or B
```

`node_modules/` not copied. Total snapshot size approximately
70 MB if both HD variants are bundled.

Verify the snapshot is launchable manually:
- Node serial harness still boots floppy.
- Browser harness still boots floppy and partitionless HD.
- Browser harness boots MBR HD (if Outcome A or B).

Document all verification outputs.

The report at `MBR_PARTITION_REPORT.md` has these sections:

- **Summary**: outcome (A, B, or C), what works.
- **Diagnosis**: answers to all Section-1 questions with byte-level
  citations from the actual MBR.
- **Implementation**: source changes if any (Outcome A: none;
  Outcome B: the gap closed; Outcome C: what would be needed).
- **MINIX variant verification**: separate trace if the FAT MBR
  worked.
- **Tagger update**: rules added, test cases.
- **What's deferred**: LBA extensions, GPT, multi-partition
  selection, user toggle for authentic vs virtual-shift, MBR
  variants in browser-friendly multi-partition UI.
- **Things future briefs should address**:
  - **User toggle: authentic vs virtual-shift**. The user has
    expressed interest in eventually offering both shapes as a
    setting. Phase 10.1 commits to authentic only. A future brief
    adds virtual-shift as a second path with a setting to choose.
  - LBA extensions (if Outcome C surfaces them, this becomes a
    candidate brief).
  - CGA-canvas browser frontend.
  - Network device.
  - Snapshot/restore.
  - Multi-disk machines.
- **CPU/memory bug candidates**: anything noticed during MBR
  execution.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`HARDDISK_BOOT_REPORT.md`** — Phase 10 work; this brief
   inherits its substrate.
2. **`GITHUB_BROWSER_REPORT.md` Section 4** — broader hard-disk
   diagnosis context.
3. **The actual MBR bytes** in `hd32mbr-fat.img`. Inspect with
   `xxd reference/elks-images-hd/hd32mbr-fat.img | head -32` or
   equivalent. The diagnosis is grounded in real bytes.
4. **OSDev wiki "MBR (x86)"** for the partition table format and
   typical bootstrap behaviour.
5. **RBIL** for any INT 13h functions that come up in diagnosis.
6. **`reference/elks/elks/arch/i86/drivers/block/bios.c`** if the
   kernel-side root-mount logic for MBR variants needs
   re-checking. Phase 10 confirmed `bios_conv_bios_drive` keys off
   the high bit of DL, which doesn't change for MBR variants.

## Final notes

This brief is structurally simple: most of the work is diagnosis,
and the implementation is "verify or close small gaps." The
substrate built across Phases 1-10 is doing the heavy lifting; the
agent's job is to confirm that and document where it does or
doesn't.

The discipline this brief asks for: **don't add LBA extensions on
spec**. If the diagnosis shows the MBR uses them, document and
stop — the user decides whether to authorise that work as a follow-
up brief. The user's preference for authentic emulation is
specifically about the MBR chain-load shape; LBA extensions are
their own architectural decision and shouldn't ride along.

The tagger update at the end is a closing courtesy: it stops the
GitHub browser from telling lies about images that now work.

After this lands, the user's "evaluate large toolchain-bearing
ELKS images" goal is fully unblocked — every published HD image
boots, partitioned or not, FAT or MINIX. The natural next briefs
are: CGA-canvas (graphics-mode rendering for non-serial guests);
network device (NE2000 toward SSH-style); snapshot/restore (to
skip the boot); user toggle for authentic vs virtual-shift MBR
boot (small, completes the spectrum); multi-disk machines.
