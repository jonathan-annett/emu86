# emu86 Phase 11 — Multi-disk machine substrate

## Summary

**Outcome A — full success.** `IBMPCMachine` accepts an optional second
disk; the BIOS routes INT 13h calls per slot/class; ELKS boots with two
HDs and reports both `hda:` and `hdb:` in the kernel banner. Single-
disk paths (floppy, HD, MBR-HD, FAT, MINIX, multi-disk-with-only-
primary) are unchanged — every Phase 1-10 test passes unmodified
because the new fields are additive optionals and the legacy `disk`
field still works.

**What works.**

- Two simultaneously-mounted disks: floppy+floppy, HD+HD, mixed
  HD+floppy. Routing follows the BIOS convention — DL=0x80/0x81 for
  HDs, DL=0x00/0x01 for floppies, with per-slot CHS geometry returned
  from AH=08h.
- Per-class drive count: AH=08h returns the count of drives in the
  caller's class (HDs for DL≥0x80, floppies for DL<0x80). With two
  HDs, the kernel HD probe sees `count=2` and iterates
  DL=0x80, 0x81.
- Drive-not-present cases return CF=1, AH=0x01 — the kernel
  silently skips, no panic.
- Browser settings modal exposes a "Secondary disk (optional)"
  picker. Default is **None** (single-disk operation, no behavioural
  change). Stored in the same `localStorage` schema; library
  validation drops a stale id back to None.
- Node CLI accepts `--hdb`, `--fd1`, and `--secondary-class`. Class
  is inferred from filename flag; `--secondary-class` overrides.
- Total tests: **1253 passing**, exceeding the brief's threshold
  (≥1245). Net new: 25 (15 BIOS unit + 6 machine unit + 2 ELKS
  integration + 2 settings).

## Diagnosis (Section 1)

The brief's six diagnosis questions, with citations:

1. **How does the kernel probe `hdb`?** ELKS calls INT 13h AH=08h
   with `DL=0x80` to read the HD count, then iterates DL=0x80+i for
   each detected drive. Citations: `arch/i86/drivers/block/bios.c:205-
   250` (per Phase 10.2's report). The probe loop continues while
   AH==0 (success); CF=1 is treated as "drive absent" — the slot is
   skipped without panicking.
2. **How does the kernel probe `fd1`?** Same pattern, but for floppies
   the kernel uses the BIOS data area drive count at 0040:0010
   (equipment word, bits 6-7 + 1) rather than INT 13h AH=08h. We
   currently return AH=08h count for both classes; the BDA path is
   driven by `bios_data_area` and is independent.
3. **AH=08h drive-count semantics.** Per OSDev "BIOS" and Ralf
   Brown's Interrupt List: when called with `DL≥0x80` the BIOS
   returns `DL = number of HDs`; with `DL<0x80` it returns `DL =
   number of floppies`. Off-by-one is tempting — the count is *per
   class*, not the total drives in the machine. The implementation
   uses a `classCount(ctx, cls)` helper to compute this from the
   slot list.
4. **"Drive not present" return shape.** CF=1, AH=0x01 (invalid
   command / drive-not-present). The kernel tolerates this and
   skips the drive — see ELKS bios.c probe loop.
5. **ELKS device-node mapping.** `/dev/fd0` ↔ DL=0x00, `/dev/fd1` ↔
   DL=0x01, `/dev/hda` ↔ DL=0x80, `/dev/hdb` ↔ DL=0x81. From
   `bios_conv_bios_drive` (Phase 10 citation).
6. **Auto-mount?** No. The kernel probes and reports presence; only
   the boot device is auto-mounted as `/`. Userland mounts via
   `mount /dev/hdb /mnt`.

No surprises surfaced — substrate work proceeded without scope drift.

## Implementation

### Back-compat strategy (Section 2 choice)

The brief offered two shapes:
- **A.** Union type — accept `disk` (legacy) and normalise.
- **B.** Update all callers; provide a helper.

The brief recommended A; the actual choice is a **simpler additive
variant of A**: keep the existing `disk` / `diskClass` fields exactly
as Phase 10 left them; add new optional `secondaryDisk` /
`secondaryDiskClass` fields alongside. No union, no normalisation step.
Every Phase 1-10 test that constructed `IBMPCMachine` with the legacy
shape compiles and passes unmodified.

The same additive shape applies to `BootConfig`: legacy
`imageUrl/imageBytes/geometry/diskClass` describe the primary; a new
optional `secondary?: DiskSlotSpec` carries the second slot.

### Per-file changes

- **`src/bios/bios-services.ts`** — added `secondaryDisk` +
  `secondaryDiskClass` to `BiosContext`. Refactored AH=02/03/04 (read/
  write/verify) and AH=08h to dispatch through three new helpers:
  `routeDrive(ctx, dl)` resolves a DL byte to a slot+class via per-
  class indexing in primary-first order; `classBase(cls)` maps class
  to its DL base (0x00 for floppy, 0x80 for HD); `classCount(ctx,
  cls)` reports the count for AH=08h. Drive-not-present returns CF=1,
  AH=0x01.

- **`src/machine/ibm-pc.ts`** — added `secondaryDisk?` and
  `secondaryDiskClass?` to `IBMPCMachineConfig`. The machine wires
  these through to `BiosContext` with the same precedence as the
  primary (explicit class > geometry inference > floppy default).
  Exposes them as readonly `secondaryDisk` and `secondaryDiskClass`.

- **`src/browser/protocol.ts`** — added `DiskSlotSpec` and
  `BootConfig.secondary?: DiskSlotSpec`. Both back-compat — every
  existing `BootConfig` literal still type-checks.

- **`src/browser/worker-host.ts`** — extracted the per-slot bytes/
  geometry/class resolution into `#resolveSlot(slotName, spec)`.
  Boot path resolves primary, then optionally secondary, and passes
  both to `IBMPCMachine`. Error message format preserves the existing
  "unrecognised image size" regex an integration test depends on.

- **`tools/elks/secondary-disk.ts`** — new shared helper module.
  Hosts `loadDiskFromPath`, `loadDiskFromPathWithClass`, and
  `parseSecondaryFlags(argv)`. The two harnesses delegate so they
  stay in lockstep.

- **`tools/elks/run.ts`** + **`tools/elks/run-serial.ts`** — both call
  `parseSecondaryFlags` and wire the secondary into the machine.
  Banner shows secondary path when set.

- **`web/settings.ts`** — added `secondaryImageSource: { kind:
  'library'; id: string } | null`. Validates per-field on load (null
  preserved, library id checked); `validateImageSourceAgainstLibrary`
  drops a stale secondary back to null and persists the corrected
  value.

- **`web/main.ts`** — `buildBootMessage` now accepts a secondary
  ref; reads its bytes from the IDB library and adds
  `config.secondary = { imageBytes }`. Boot banner shows secondary
  source when set. Modal receives `bootedSecondary` for "reload to
  apply" notices.

- **`web/settings-modal.ts`** — added a "Secondary disk (optional)"
  section after the primary picker. UI mirrors the primary picker's
  row layout; rows omit rename/delete (those live on the primary
  picker, no need to duplicate side-effects). Default row is "None"
  — selecting it turns the secondary off. ~80 lines of vanilla DOM,
  matches the brief's "60-100 lines" target.

### Routing rationale

The route function builds an in-memory list of slots in primary-first
order, filters to the caller's class, and indexes by `dl - classBase`.
This handles the mixed-class case naturally: with HD primary + floppy
secondary, DL=0x00 finds the secondary (only floppy in the list,
index 0), DL=0x80 finds the primary (only HD, index 0), DL=0x01 and
DL=0x81 both return null. Off-by-one and class-conflation bugs are
structurally avoided.

## UI surface

The settings modal's gear icon (top-right) opens a panel with sections
in this order:

1. Font size
2. Theme
3. **Boot image** — primary picker (bundled + library entries)
4. **Secondary disk (optional)** *(new)* — None + library entries
5. Storage usage

The secondary section's lead-in line:

> Mounts as /dev/hdb (HD-class image) or /dev/fd1 (floppy-class image).
> Primary still boots; mount via the kernel after boot.

The "None" row is selected by default. Picking a library entry shows
"Secondary-disk change takes effect on next reload." The secondary
list omits viability tags — the user is choosing a data disk, not a
boot disk; viability doesn't apply.

## Test fixture decisions

Integration tests reuse Phase 10/10.2 fixtures pair-wise:

- **Primary**: `hd32-fat.img` (Phase 10 fixture, 32 MiB partitionless
  FAT) — patched in-memory with the same `/bootopts` serial-console
  override that `elks-hd-boot.test.ts` pioneered.
- **Secondary**: `hd32-minix.img` (Phase 10.2 fixture, 32 MiB
  partitionless MINIX). Both fixtures already exist; no new fetches
  required.

The pair was chosen because:
- Both are HD class → exercises the "two HDs at 0x80/0x81" path.
- Different filesystem types → kernel readily distinguishes them in
  the boot banner (`hda:` vs `hdb:` lines, no false-equivalence
  matching).
- The MINIX secondary's filesystem header is unambiguous, so a
  routing mistake (kernel reading the wrong disk's superblock) would
  surface as a banner mismatch.

A second test in the same file boots only the primary (no secondary),
asserts `hda:` present and `hdb:` *not* present — single-disk
regression guard.

## What's deferred

Per the brief's Section 8, intentionally out of scope:

- Third disk slot.
- Hot-swap of the secondary at runtime.
- Cross-disk operations from the harness UI (kernel handles
  userland natively).
- Multi-boot menu / per-reload boot-drive selection.
- LBA extensions (AH=0x40-0x43) — Phase 10.1 confirmed CHS-only.
- ELKS image rebuilds — published images already include `/dev/hdb`
  and `/dev/fd1` device nodes.

## Things future briefs should address

1. **Phase 12 — toolchain survey.** Now that multi-disk is here, the
   next brief should be a *pure diagnosis* arc: list `/usr/bin/` of
   each large ELKS HD image, attempt a hello-world compile under the
   in-image toolchain, and recommend the best image for dogfooding
   the NE2000 driver build. No substrate change.
2. **NE2000 device.** Substrate work to model an NE2000 NIC (port
   I/O at 0x300 + IRQ 9). Out of scope here.
3. **Host-side network bridge.** Once the NE2000 exists, glue Node
   net + host loopback + pcap to it. Far future.
4. **Authentic-vs-virtual-shift MBR toggle.** Carried forward from
   Phase 10.1 — toggle for emulator-only MBR shapes vs real BIOS.
5. **Snapshot / restore.** Save the full machine state to disk
   between sessions. Substrate-friendly because the disk shape now
   covers two slots cleanly.
6. **CGA-canvas browser frontend.** Render the CGA framebuffer to a
   `<canvas>` instead of stream-to-xterm. Independent of multi-disk.

## CPU/memory bug candidates

None observed. The two-disk integration runs do not stress the CPU
or memory subsystems beyond what single-disk runs already do — INT
13h is a trap-handled instruction that returns to host code without
re-entering the CPU pipeline. The `traceRun` harness with the
multi-disk integration test completed within the same instruction
budget (16M) as the single-disk variant.

## Release snapshot

Layout: `releases/phase-11-multi-disk/`

```
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/                      # 693K — compiled Node CLI
├── dist-web/                      # 3.0M — Vite production bundle
└── reference/                     # 65M — fixtures
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    ├── elks-images-hd/hd32-fat.img
    └── elks-images-hd/hd32-minix.img
```

Verified by:
- Re-importing `parseSecondaryFlags` from the dist-cli copy and
  confirming flag parsing works.
- Constructing an `IBMPCMachine` from the dist-cli with both fixtures
  attached and confirming `machine.disk.geometry` and
  `machine.secondaryDisk.geometry` resolve correctly.
- Inspecting the dist-web bundle for the strings `Secondary disk`,
  `secondaryImageSource`, and `/dev/hdb` — all present.

## Verification

From the repo root:

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean)

$ npm test
…
Test Files  71 passed (71)
     Tests  1253 passed (1253)
  Duration  210.60s

$ npx vitest run tests/integration/elks-multi-disk-boot.test.ts
✓ tests/integration/elks-multi-disk-boot.test.ts  (2 tests) 20100ms
   Tests  2 passed (2)
```

SST corpus: 323/323 passing within the full-suite run.

## Reference sources

1. `HARDDISK_BOOT_REPORT.md` — Phase 10's `diskClass` substrate.
2. `MBR_PARTITION_REPORT.md` — Phase 10.1 single-disk shape.
3. `MINIX_HD_REPORT.md` — Phase 10.2 kernel probe trace.
4. `arch/i86/drivers/block/bios.c:205-250` — kernel HD probe.
5. OSDev "BIOS" — INT 13h functions, drive-count semantics.
6. `src/machine/ibm-pc.ts`, `src/bios/bios-services.ts`,
   `src/browser/{protocol,worker-host}.ts`,
   `tools/elks/secondary-disk.ts`, `web/settings.ts`,
   `web/settings-modal.ts`, `web/main.ts` — implementation.
