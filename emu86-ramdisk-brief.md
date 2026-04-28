# emu86 — Agent Brief: Ramdisk Diagnosis (Phase 11.5)

## TL;DR

Diagnose whether ELKS's `/dev/rd0` ramdisk works in our emulator
out-of-the-box. The kernel ships with the driver compiled in (the
`/dev/rd0` and `/dev/rd1` device nodes appear in `ls /dev` per
Phase 7's interactive session). Whether the driver functions at
runtime — formatting, mounting, reading and writing — is the
question this brief answers.

This is a **research brief**. The expected outcome is "it works"
(Outcome A): document how to use it, add an integration test that
formats and mounts a ramdisk and round-trips a file, ship. If it
doesn't work (Outcome B/C), document the failure and a concrete
unblocking checklist for a future implementation brief.

No substrate changes anticipated. The lock list is restrictive.

Document in `RAMDISK_REPORT.md`.

You are working in `emu86/`. Read `MULTI_DISK_REPORT.md` (the
substrate this brief tests against) and Phase 7's
`KEYBOARD_HARNESS_REPORT.md` only if you need a refresher on the
interactive harness pattern. ELKS source at `reference/elks/`.

## Hard rules

1. **Don't break existing tests.** 1,253 passing as of Phase 11.
   All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **No substrate changes anticipated.** If diagnosis surfaces a
   need to modify locked directories, **stop and report**.
   Outcome C (diagnosis-only with unblocking checklist) is
   acceptable completion.
6. **You may add** unit tests if a userland-script-shape utility
   needs them; integration tests for the ramdisk round-trip; one
   test fixture (a tiny FAT or MINIX-FS image to copy onto the
   ramdisk, if that's part of the verification flow).
7. **You may NOT modify** anything in `src/cpu8086/`,
   `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`,
   `src/timing/`, `src/devices/`, `src/console/`, `src/disk/`,
   `src/bios/`, `src/host-clock/`, `src/diagnostics/`,
   `src/machine/ibm-pc.ts`, `src/browser/worker-host.ts`,
   `src/browser/browser-console.ts`, or `src/browser/protocol.ts`.
8. **Diagnose before any speculative implementation.** Phase 5 /
   8 / 9.3 / 10.1 discipline. If the ramdisk Just Works and only
   needs a documented usage flow, that *is* the deliverable.

## Background

The ELKS kernel ships with multiple block-device drivers. The
boot trace from Phase 10.2 confirms which are present and probed:

```
hda:   31M CHS  63,16,63
fd0:  360K CHS  40, 2,9
cf:  ATA at 300/31c xtide=3,1 probe fail (ff)
cfa: ATA at 300/31c xtide=3,0 not found (-6)
cfb: ATA at 300/31c xtide=3,0 not found (-6)
```

The ramdisk (`/dev/rd0`, `/dev/rd1`) is conspicuously absent from
the probe trace because it doesn't probe — it's a software-only
device that exists once allocated. The device nodes are present
in `/dev/`; the question is whether userland can `mkfs.minix`
(or equivalent), `mount`, read, write, and unmount it.

The `xms: 34816K, disabled, A20 error. 64K ext buffers, 8K cache,
15 req hdrs` line on the kernel banner is the **buffer cache**
init — separate from ramdisk. Don't conflate.

Phase 11's substrate doesn't change ramdisk behavior. The ramdisk
lives in conventional or extended RAM under kernel management; we
neither block it nor enable it. If it works, it's because the
kernel-side driver runs without depending on anything we don't
emulate.

## Scope

### Section 1 — diagnosis (the deliverable)

Answer concretely in the report:

1. **What's the ELKS ramdisk driver source?** Cite file paths.
   Likely under `arch/i86/drivers/block/` or `drivers/block/` —
   the same area as the BIOS HD driver. Identify the driver
   shape: how it allocates memory, what device numbers it serves,
   whether it has a probe / init function, and what userland
   interactions it supports (open / read / write / ioctl).
2. **What memory does it use?** Conventional (the 640K below
   0xA0000) or extended (the XMS region above 1MB which the
   kernel banner says is "disabled, A20 error")? If extended:
   it won't work, because XMS is disabled. If conventional: it
   should work, because we model the conventional region
   correctly.
3. **What's the userland configuration mechanism?** Does ELKS
   require an `mkrd` / `RAMDISK` ioctl to allocate the ramdisk
   before first use? Does it auto-allocate on first access?
   What's the size limit? Cite source.
4. **Is there an `mkfs` or equivalent format step?** Probably
   yes — a freshly allocated ramdisk has no filesystem; the
   user runs `mkfs.minix /dev/rd0` (or equivalent) before
   `mount`-ing.
5. **Does the published `fd1440-fat-serial.img` contain the
   tools needed?** Check `/usr/bin/`, `/bin/`, `/sbin/` for
   `mkfs.minix`, `mkfs`, `mkfs.fat`, `mount`, `umount`,
   `mkrd`. If the tools aren't in the working image, the
   diagnosis answer might be "ramdisk works but isn't usable
   from the harness without a different image" — that's a
   useful answer for Phase 12 / 13 planning.

### Section 2 — verification (if Section 1 yields encouraging answers)

If Section 1 indicates the ramdisk should work and the published
image has the tools:

1. Boot the Node serial harness with the existing
   `fd1440-fat-serial.img` (or whichever image gets you to a `# `
   prompt with the right tools).
2. Inject keystrokes that:
   - Allocate / format a ramdisk (sequence depends on Section
     1's answers).
   - Mount it at `/mnt/rd` (or similar).
   - Write a file (`echo hello > /mnt/rd/test`).
   - Read it back (`cat /mnt/rd/test`).
   - Unmount.
3. Capture the UART transcript. Assert on the round-trip via
   the `echo hello` reflection plus the `cat` output.

This is Phase 7's interactive-injection pattern, applied to
ramdisk verification. The integration test framework already
handles this.

### Section 3 — outcomes

**Outcome A: ramdisk works.** Section 2 succeeds.
- One integration test pinning the round-trip.
- Documented usage flow in the report (the exact command
  sequence; what works, what doesn't).
- Brief is complete; no substrate changes.

**Outcome B: ramdisk doesn't work due to a missing piece in our
substrate.** Section 2 fails because:
- The driver depends on extended memory we don't emulate (XMS).
- The driver depends on a kernel feature that wasn't compiled in.
- The driver works but the published image lacks the userland
  tools.
- Some other gap surfaces.

If the gap is in the **substrate** (not ELKS or the image), document
the gap concretely with an unblocking checklist. Don't try to
implement; that's a future brief. The lock list says "no" and
this brief honours it.

If the gap is in **ELKS / image** (driver compiled out, tools
missing), document and recommend either (a) using a different
image (Phase 12's probe-harness might want a different image
anyway), or (b) a future "ELKS image with ramdisk tools" brief.

**Outcome C: diagnosis is inconclusive.** The driver appears to
exist; the tools appear to exist; userland calls return without
panic but the round-trip doesn't verify cleanly. Document what
was tried, what was observed, and what the next step would be.

### Section 4 — what you are NOT building

- A new ramdisk *device* in `src/devices/`. ELKS's ramdisk is
  software-only; there's no hardware to model.
- A new browser UI for ramdisk allocation. Out of scope.
- A snapshot / restore mechanism that captures ramdisk contents.
  Snapshot is its own future brief.
- A "ramdisk is the secondary disk" path. Phase 11's secondary-
  disk is a real disk image; ramdisk is a kernel-internal
  device. Different concerns.
- Modifying the published ELKS image to add ramdisk tools. If
  the tools are missing, that's a finding, not a fix in this
  brief.
- Probe-harness work. Phase 12.
- Toolchain survey. Phase 13.

## Tests

### Unit tests

Unlikely to need any. If a small userland-script-shape helper
gets added (e.g., a `tools/elks/ramdisk-script.ts` that produces
a probe transcript), unit-test the helper. Otherwise skip.

### Integration tests

If Outcome A:
- **`tests/integration/elks-ramdisk.test.ts`** *(new, 1 case).*
  Boot the serial harness with the existing image. Inject the
  Section 2 sequence. Assert on the captured UART transcript.

If Outcome B or C: no integration test (the round-trip didn't
verify; an asserting test would be misleading).

### Smoke tests

All Phase 11 tests must keep passing. Multi-disk integration
tests (HD+HD, HD+floppy) must stay green. The boot serial
harness must continue to work unchanged for single-disk and
multi-disk configurations.

## Watch out for

- **The XMS / A20 question.** The kernel banner literally says
  `xms: ... disabled, A20 error` — extended memory isn't usable
  in our emulator. If the ramdisk driver tries to allocate from
  XMS, it'll fail at runtime. The diagnosis must determine
  whether the driver is XMS-aware or conventional-only.
- **`mkrd` may not exist.** Some ELKS distributions have a
  `mkrd` userland tool to allocate the ramdisk. Others auto-
  allocate on first access. Don't assume one or the other; read
  the source.
- **`mkfs.minix` or `mkfs`?** ELKS may have either or both. The
  published image's `/sbin/` and `/bin/` will tell you.
- **Ramdisk size limits matter.** A 16K ramdisk holds a few
  files; a 64K ramdisk fits more; a 1MB ramdisk would be useful
  for the toolchain-build use case but probably exceeds what
  ELKS's conventional-RAM driver supports. Document the
  observed limit.
- **The `ssd` device is separate.** From Phase 7's `ls /dev`
  output: `ssd` is the solid-state disk driver, a different
  block device. Don't conflate with `rd0`/`rd1`.
- **Don't speculate about what would unblock Outcome B/C.** The
  unblocking checklist is the deliverable; the implementation
  is a *future* brief. The discipline this brief asks for is
  reading carefully, documenting honestly, and stopping at the
  diagnosis.
- **Keystroke timing.** The integration test framework injects
  keystrokes at a rate the kernel can consume. Don't rush —
  Phase 7's pattern of waiting for a prompt before sending the
  next command is the right shape.

## Definition of done

**Outcome A (verified working):**
- Diagnosis section in the report fully populated with
  citations.
- Integration test passes; round-trip verified.
- Documented usage flow.
- All prior tests still pass.
- Total tests ≥ 1,254.

**Outcome B (gap surfaced):**
- Diagnosis section populated.
- Concrete unblocking checklist for a future implementation
  brief.
- No integration test (or one that's `.skip`ed with a clear
  reason, plus a TODO referring to the unblocking checklist).
- All prior tests still pass.

**Outcome C (inconclusive):**
- Diagnosis section populated with what was tried.
- Specific next-step questions for follow-up.
- No integration test.
- All prior tests still pass.

In all cases:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean.
- Release snapshot at `releases/phase-11-5-ramdisk/` populated
  and manually launch-verified.

## Release snapshot

Layout:

```
releases/phase-11-5-ramdisk/
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

`node_modules/` not copied. Same fixtures as Phase 11.

Verify the snapshot is launchable manually:
- Node serial harness boots floppy (no regression).
- Browser harness boots primary, with optional secondary
  picker still working (no regression).

The report at `RAMDISK_REPORT.md` has these sections:

- **Summary**: outcome (A / B / C), one-paragraph finding.
- **Diagnosis**: answers to all Section 1 questions with file:line
  citations from the ELKS source.
- **Verification (if Outcome A)**: command sequence, captured
  UART transcript excerpts, integration test results.
- **Unblocking checklist (if Outcome B)**: what's needed for
  ramdisk to work, file-level specificity.
- **What's deferred**: Phase 12 / 13 work, NE2000, snapshot,
  CGA-canvas, anything tangentially adjacent.
- **Things future briefs should address**: pulled from the
  diagnosis if relevant.
- **CPU/memory bug candidates**: anything noticed.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`MULTI_DISK_REPORT.md`** — Phase 11; the substrate this
   brief tests against.
2. **`reference/elks/elks/arch/i86/drivers/block/`** — kernel
   block drivers including the ramdisk source.
3. **`reference/elks/elks/Documentation/`** if it exists — ELKS
   docs may describe ramdisk usage explicitly.
4. **`tests/integration/elks-interactive.test.ts`** — Phase 7's
   keystroke-injection pattern, the template for Section 2's
   verification.
5. **OSDev wiki "RAM disk"** for general background on how
   ramdisks work in real-mode operating systems; ELKS-specific
   details still come from ELKS source.

## Final notes

This brief's expected outcome is A — a clean verification that
ramdisk works, documented for future use. The substrate's
discipline of "don't model what doesn't need modeling" pays off
here: the ramdisk is kernel-managed, our emulator just provides
RAM, and that's enough for it to work.

If diagnosis surfaces Outcome B — for example, the driver wants
extended memory we don't emulate — that's a finding worth knowing
before we plan dogfooding workflows that assume ramdisk
availability. The unblocking checklist becomes input for a future
brief if the user wants to pursue ramdisk-as-large-scratch-space.

After this lands, Phase 12 (probe harness) is the next brief.
The probe-harness use case doesn't strictly require ramdisk — the
secondary-disk pattern already supports "scripts in, output out" —
but having ramdisk available as an option opens use cases for
scripts that produce a lot of intermediate output without
inflating an in-memory image.
