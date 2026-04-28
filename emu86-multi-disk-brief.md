# emu86 — Agent Brief: Multi-disk Machines (Phase 11)

## TL;DR

Extend the substrate to support two simultaneously-mounted disks
on `IBMPCMachine`. The shape: a primary boot disk (floppy or HD)
plus an optional secondary data disk (typically a second HD at
`/dev/hdb` or a second floppy at `/dev/fd1`). The kernel sees
both at boot; userland mounts the secondary on demand
(`mount /dev/hdb /mnt`).

Phase 10's brief explicitly left the seam open: "future work would
let multiple disks mount simultaneously. The seam should
accommodate it without forcing it now." This brief closes that
seam. Extends `BootConfig` to carry an optional second disk,
extends BIOS INT 13h dispatch to route by drive number per class,
extends INT 13h AH=0x08 to report per-drive geometry, extends the
worker host's image-bytes plumbing to accept two payloads, and
adds a small UI surface in the browser for picking a secondary.

This is **substrate work, not a feature arc**. It's the foundation
the user wants for a future "boot ELKS, mount source disk, build
NE2000 driver from source" story. That story is its own arc; this
brief does not start it.

Document in `MULTI_DISK_REPORT.md`.

You are working in `emu86/`. Read `HARDDISK_BOOT_REPORT.md` (the
Phase 10 substrate this builds on) and `MBR_PARTITION_REPORT.md`
(current single-disk shape, end-to-end). The Phase 10 watch-out
about "two-disk machine config" being a forward-compat seam is the
exact seam this brief closes.

## Hard rules

1. **Don't break existing tests.** 1,228 passing as of Phase 10.2.
   All must stay green. Single-disk boot paths (floppy, HD,
   MBR-HD, MINIX, FAT) all keep working unchanged.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **Diagnose before implementing.** Read the kernel-side HD and
   floppy probe paths to confirm what we model for two disks.
   Phase 5 / 8 / 10.1 discipline.
6. **You may modify** `src/machine/ibm-pc.ts` (multi-disk wiring),
   `src/bios/bios-services.ts` (INT 13h dispatch by drive number,
   AH=08h per-drive geometry, INT 19h boot-drive selection),
   `src/disk/disk.ts` (only if a per-disk shape needs adjustment;
   not expected), `src/browser/protocol.ts` (extend `BootConfig`),
   `src/browser/worker-host.ts` (consume the extended config),
   `web/main.ts` and `web/settings-modal.ts` (UI surface), and
   `tools/elks/run.ts` / `tools/elks/run-serial.ts` (CLI flags).
7. **You may NOT modify** `src/cpu8086/`, `src/memory/`,
   `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
   `src/devices/`, `src/console/`, `src/host-clock/`,
   `src/diagnostics/`, or `src/browser/browser-console.ts`.
   Disk- and BIOS-disk-service-related changes only.
8. **No fix-and-pray.** If diagnosis surfaces something
   unexpected — kernel demands a probe response we don't supply,
   BIOS dispatch needs a structural change — stop and document.
   Outcome C (substrate seam closed but kernel doesn't detect the
   second disk) is acceptable completion.
9. **No NE2000, no toolchain work, no driver-build story.** All
   future-arc material. Out of scope absolutely.

## Background

Phase 10 introduced the `'floppy' | 'hard-disk'` `diskClass`
discriminator and routed BIOS INT 13h calls by drive class. The
single-disk-at-a-time constraint was a simplification, not an
architectural requirement.

The kernel boot trace from Phase 10.2's MINIX HD report shows
what ELKS does when probing:

```
hda:   31M CHS  63,16,63
fd0:  360K CHS  40, 2,9
cf:  ATA at 300/31c xtide=3,1 probe fail (ff)
cfa: ATA at 300/31c xtide=3,0 not found (-6)
cfb: ATA at 300/31c xtide=3,0 not found (-6)
```

Notable observations:
- The kernel probes `hda` (the HD it boots from) and `fd0` (the
  floppy controller's drive 0) regardless of whether they were
  specified at boot. With only an HD mounted, `fd0` shows as 360K
  (default geometry) but is unusable — no medium present.
- The probes for `cf*` come back "not found" because we don't
  model an XT-IDE controller.
- Section 1's diagnosis confirms what `hdb` and `fd1` look like.

## Scope

### Section 1 — diagnosis (mandatory first step)

Before implementing, confirm:

1. **How does the kernel probe for `hdb`?** Cite ELKS source.
   Likely INT 13h AH=08h with `DL=0x81`. What return values does
   it interpret as "drive present" vs "absent"?
2. **How does the kernel probe for `fd1`?** Likely AH=08h with
   `DL=0x01`. Same question.
3. **What's the AH=08h drive-count semantics?** When called with
   `DL >= 0x80`, the BIOS returns `DL = number of HD drives`.
   When called with `DL < 0x80`, returns `DL = number of floppy
   drives`. Cite OSDev / RBIL or equivalent.
4. **What's the kernel's behavior on "drive not present"?** Carry
   flag set, AH = error code (typically 0x01 invalid command, or
   0x07 drive parameter activity failed; depends on the function
   and the kernel's tolerance). The kernel skips the drive
   without panicking. Confirm.
5. **What's the ELKS device-node mapping?** `/dev/fd0` (DL=0x00),
   `/dev/fd1` (DL=0x01), `/dev/hda` (DL=0x80), `/dev/hdb`
   (DL=0x81). Confirm with `bios_conv_bios_drive` (Phase 10
   citation).
6. **Does the kernel mount any secondary disk automatically?**
   The expectation is no — it probes and reports presence; the
   user mounts via `mount /dev/hdb /mnt`. Confirm.

If diagnosis surfaces an unexpected probe shape (e.g., kernel
reads CMOS for the drive table), document and adjust scope.

### Section 2 — IBMPCMachine config extension

Today's shape:

```ts
interface IBMPCMachineConfig {
  ...
  disk: { bytes: Uint8Array, class: DiskClass, geometry?: DiskGeometry };
  ...
}
```

Extends to:

```ts
interface IBMPCMachineConfig {
  ...
  disks: {
    primary: DiskSlotConfig;
    secondary?: DiskSlotConfig;
  };
  ...
}

interface DiskSlotConfig {
  bytes: Uint8Array;
  class: DiskClass;
  geometry?: DiskGeometry;
}
```

A back-compat shim is mandatory: callers passing the old `disk`
field continue to work. Implementation choices:

- **A.** Accept `disk` (singular) at the type level via a union;
  normalize to `disks` internally.
- **B.** Update all call sites; provide a small helper for old
  shapes if needed.

Pick A — it minimises churn in tests. Document the choice.

### Section 3 — BIOS INT 13h dispatch

In `src/bios/bios-services.ts`, route by drive number:

| DL    | Floppy primary | Floppy secondary | HD primary | HD secondary |
|-------|----------------|------------------|------------|--------------|
| 0x00  | →primary       | not present      | not present | not present |
| 0x01  | not present    | →secondary       | not present | not present |
| 0x80  | not present    | not present      | →primary    | not present |
| 0x81  | not present    | not present      | not present | →secondary  |

For mixed configurations (HD primary + floppy secondary, etc.),
the routing is per-class — DL=0x80 → primary if it's HD, else not
present; DL=0x00 → primary if it's floppy, else secondary if
it's floppy, else not present. The diagnosis confirms semantics.

INT 13h AH=08h needs per-drive responses:
- For each present drive, return its own CHS geometry.
- Drive-count return field: per-class total. AH=08h with `DL=0x80`
  returns `DL = number of HDs in machine`. AH=08h with `DL=0x00`
  returns `DL = number of floppies in machine`.
- Calls for an absent drive return "drive not present" — carry
  flag set, AH set to error code per BIOS spec.

### Section 4 — INT 19h boot drive selection

INT 19h hands `DL = boot drive number` to the boot sector. By
default, primary disk is the boot source. The boot config can
specify "boot from secondary" — flow through whichever drive
number that ends up being.

Most cases are "primary boots, secondary is data." Don't
over-design.

### Section 5 — worker host + protocol

`src/browser/protocol.ts`:

```ts
interface BootConfig {
  ...
  primaryDisk: DiskBytes;
  secondaryDisk?: DiskBytes;
  ...
}

interface DiskBytes {
  bytes: Uint8Array;
  class: DiskClass;  // optional — derivable from size table
}
```

Old `BootConfig.imageBytes` (or whatever the Phase 9.2 shape was
named) gets the same back-compat treatment as `IBMPCMachineConfig.disk`.

`src/browser/worker-host.ts` — consume the extended config. If
`secondaryDisk` is undefined, behavior is identical to today.

### Section 6 — browser UI surface (small)

In `web/settings-modal.ts`, extend the image-source picker with a
"Secondary disk (optional)" row, mirroring the primary picker:

- Default: none (single-disk operation, no behavioral change).
- "Pick from library" → choose another stored image.
- "Upload" → upload a new image.
- "None" → set back to no secondary.

The secondary picker doesn't surface viability tagging
prominently — the user is choosing a data disk, not a boot disk.
Empty disk OK; complete filesystem OK; the kernel mounts what's
there.

The picker UI is small (~60-100 lines of vanilla DOM, mirroring
the primary's existing implementation). No framework adoption.

### Section 7 — Node harness CLI

`tools/elks/run-serial.ts` and `tools/elks/run.ts` get an
optional flag:

```
npm run start:elks-serial
npm run start:elks-serial -- --hdb path/to/data.img
npm run start:elks-serial -- --fd1 path/to/floppy2.img
```

Detect class from filename pattern (existing `viability-tagging`
heuristic, or the worker host's size-based table) or accept an
explicit `--secondary-class hard-disk` flag if needed. Pick
whatever's least surprising; document.

### Section 8 — what you are NOT building

- A third disk slot. Two max.
- Hot-swap of the secondary at runtime.
- Cross-disk operations in the harness UI (kernel handles
  userland natively).
- Multi-boot menu / "boot from this drive at next reload"
  beyond the simple primary/secondary choice.
- NE2000, networking, SSH, source-on-secondary workflows. All
  future arc.
- ELKS image rebuilds. Published images already include
  `/dev/hdb`, `/dev/fd1` device nodes.
- LBA extensions (AH=0x40-0x43). Phase 10.1 confirmed CHS-only.

## Tests

### Unit tests

- **`tests/unit/bios-int13-multi-disk.test.ts`** *(new, ~10-14
  cases).*
  - DL routing matrix per Section 3 (8 combinations).
  - AH=08h per-drive geometry (4 cases).
  - AH=08h drive-count for various configs (2-3 cases).
- **`tests/unit/machine-multi-disk.test.ts`** *(new, ~3-5
  cases).*
  - Construct with `disk` (legacy shape) — back-compat works.
  - Construct with `disks.primary` (new shape).
  - Construct with both `disks.primary` and `disks.secondary`.
  - Wiring verification: each disk reachable through its drive
    number.

### Integration tests

- **`tests/integration/elks-multi-disk-boot.test.ts`** *(new, 2-4
  cases).*
  - HD primary + floppy secondary; assert kernel banner mentions
    both drives.
  - HD primary + HD secondary; assert kernel banner mentions
    both `hda:` and `hdb:`.
  - Inject `mount /dev/hdb /mnt && ls /mnt && umount /mnt` (or
    similar) over UART; assert success in TX bytes.
  - Use existing fixtures pair-wise; no new fetches needed.

### Smoke tests

All single-disk tests must keep passing. The back-compat shim
is the load-bearing piece — every test that constructs
`IBMPCMachine` with the old shape must keep working unmodified.

## Watch out for

- **Back-compat is the load-bearing part.** All prior tests
  construct the machine with the pre-Phase-11 config. They cannot
  all be edited. The shim must accept both shapes transparently.
- **Drive-count return value is per-class.** Off-by-one
  tempting. AH=08h with DL=0x80 returns count of HDs. AH=08h with
  DL=0x00 returns count of floppies. Don't conflate.
- **Drive-not-present uses the BIOS error path.** Carry flag set,
  AH = error code. Returning success with bogus geometry is worse
  than failing; the kernel may proceed and read garbage.
- **The kernel's `fd0:` line shows up regardless** of whether a
  floppy is mounted. It's part of the floppy-controller probe.
  Don't suppress; just make reads return drive-not-present when
  no medium.
- **The XT-IDE / `cf*` probes are unrelated.** Those hit ports
  we don't model; they fail gracefully today and continue to.
  Don't get tempted.
- **Browser-side state.** A user with both primary and secondary
  set, who then deletes the secondary library entry, ends up
  with a stale reference. Validate at boot — if the secondary
  ID doesn't resolve, fall back to no-secondary (same pattern as
  the primary's library validation).
- **Booting from secondary is rare but should work.** A user
  picks "boot from secondary" → boot config sets boot_drive to
  the secondary's number. If the kernel banner shows the
  expected disk as boot device, good.
- **Test-fixture pair-up.** The integration tests use existing
  fixtures pair-wise. `hd32-fat.img` + `hd32-minix.img` is a
  reasonable pairing (both already fetched as Phase 10/10.2
  fixtures). Don't fetch new fixtures; this brief is substrate.

## Definition of done

**Outcome A (full success):**
- Multi-disk machine boots end-to-end with both disks visible
  to the kernel.
- Userland `mount /dev/hdb /mnt` works.
- Single-disk paths (floppy, HD, MBR-HD, FAT, MINIX) all
  unchanged.
- Browser UI offers secondary-disk picker; selection persists
  via existing settings substrate.
- Node CLI accepts secondary disk via flag.
- All 1,228 prior tests pass.
- New tests as listed.
- Total tests ≥ 1,245.

**Outcome B (substrate seam closed, kernel detects only one
disk):**
- BIOS routing works at the unit-test level.
- Kernel banner shows only the primary disk.
- Diagnosis section explains why (likely a kernel-side probe
  expectation we didn't anticipate).
- All prior tests pass.
- Outcome B is acceptable; the seam being closed unblocks
  future debugging.

**Outcome C (substrate change required outside the lock list):**
- Stop and report. The user decides whether to authorise.
- All prior tests pass.

In all cases:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean.
- Release snapshot at `releases/phase-11-multi-disk/` populated
  and manually launch-verified.

## Release snapshot

Layout:

```
releases/phase-11-multi-disk/
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/
├── dist-web/
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    ├── elks-images-hd/hd32-fat.img
    └── elks-images-hd/hd32-minix.img
```

`node_modules/` not copied. Verify both harnesses still launch
correctly, with and without secondary disk specified.

## Report

`MULTI_DISK_REPORT.md`:

- **Summary**: outcome, what works.
- **Diagnosis**: answers to all Section-1 questions with file:line
  citations.
- **Implementation**: per-file changes; back-compat shim shape;
  routing rationale.
- **UI surface**: screenshot or DOM description of the secondary
  picker.
- **Test fixture decisions**: which pairs were tested, why.
- **What's deferred**: third disk, hot-swap, multi-boot menu,
  cross-disk operations, NE2000 / network, source-on-secondary
  workflows.
- **Things future briefs should address**:
  - **Phase 12 (toolchain survey)**: now that multi-disk exists,
    a research brief surveys published ELKS images for self-
    hosted compilers — list `/usr/bin/` of each large image, try
    compiling a hello world, recommend the best image for
    dogfooding the NE2000 driver build. Pure diagnosis brief, no
    substrate change.
  - NE2000 device.
  - Host-side network bridge.
  - Authentic-vs-virtual-shift MBR toggle (carried forward from
    Phase 10.1).
  - Snapshot / restore.
  - CGA-canvas browser frontend.
- **CPU/memory bug candidates**: anything noticed during the
  multi-disk integration runs.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`HARDDISK_BOOT_REPORT.md`** — Phase 10's substrate; the
   `diskClass` plumbing this brief extends.
2. **`MBR_PARTITION_REPORT.md`** — Phase 10.1; current single-disk
   end-to-end shape.
3. **`MINIX_HD_REPORT.md`** — Phase 10.2; the kernel probe trace
   that motivates Section 1's diagnosis questions.
4. **`reference/elks/elks/arch/i86/drivers/block/bios.c`** — kernel
   HD probe path and `bios_conv_bios_drive`.
5. **OSDev wiki "BIOS"** — INT 13h functions, drive-count
   semantics, error codes.
6. **`src/machine/ibm-pc.ts`** — current single-disk wiring.
7. **`src/bios/bios-services.ts`** — current INT 13h dispatch.
8. **`src/browser/protocol.ts`** and **`src/browser/worker-host.ts`** —
   `BootConfig` consumption.

## Final notes

This is foundation work. The arc that motivated it — boot ELKS,
mount source disk, build NE2000 driver — depends on knowing what
toolchain works on which image, and that's the *next* brief
(Phase 12: toolchain survey, pure diagnosis, output is a
recommendation). This brief delivers the runway; the next one
flies the route.

The discipline this brief asks for: **don't speculate about NE2000
or driver-loading**. The substrate is the deliverable. Even when
the agent finds themselves wanting to "just check whether ELKS can
load a built driver," that's out of scope. The toolchain survey
brief will exercise that question deliberately.
