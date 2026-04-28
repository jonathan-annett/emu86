# emu86 — Agent Brief: Partitionless MINIX HD Verification (Phase 10.2)

## TL;DR

Verify that `hd*-minix.img` (partitionless MINIX-FS hard-disk
images) boot end-to-end on the existing substrate. Phase 10
verified the FAT variant; Phase 10.1 verified MINIX-on-MBR but
not MINIX-on-partitionless. The viability tagger currently lists
`hd*-minix.img` as `untested`. After this brief, either it's
`likely-works` (verified) or it stays `untested` with a documented
reason.

This is a small brief. **Likely no source changes**, mirroring
Phase 10.1's Outcome A — the substrate handles partitionless and
MBR variants the same way, the FAT and MINIX paths differ only at
the kernel's filesystem-detection layer which already worked for
both in Phase 10.1.

Ride-along: a corresponding tagger update if verification passes.

Document in `MINIX_HD_REPORT.md`.

You are working in `emu86/`. Read `HARDDISK_BOOT_REPORT.md`
(Phase 10's substrate work) and `MBR_PARTITION_REPORT.md` (Phase
10.1's MINIX-on-MBR verification). The Phase 10 fixture-fetch
script `tools/elks-build/fetch-hd-image.ts` is the precedent for
how to acquire the test image.

## Hard rules

1. **Don't break existing tests.** 1,226 passing as of Phase 10.1.
   All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **Likely no source changes.** This brief is structured around
   that expectation. If something doesn't work and the fix
   demands a locked-directory edit, **stop and report** — the
   user decides whether to authorise it. Phase 10.1's discipline.
6. **You may add** an integration test for the MINIX HD path; you
   may extend `tools/elks-build/fetch-hd-image.ts` to fetch the
   `hd32-minix.img` fixture; you may extend
   `tests/unit/viability-tagging.test.ts` for the tag update; you
   may modify `web/viability-tagging.ts` for the rule update.
7. **You may NOT modify** anything in `src/cpu8086/`,
   `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`,
   `src/timing/`, `src/devices/`, `src/console/`, `src/disk/`,
   `src/bios/`, `src/host-clock/`, `src/diagnostics/`,
   `src/machine/ibm-pc.ts`, `src/browser/worker-host.ts`,
   `src/browser/browser-console.ts`, or `src/browser/protocol.ts`.

## Background

Phase 10 verified `hd32-fat.img` (partitionless FAT). Phase 10.1
verified `hd32mbr-fat.img` and `hd32mbr-minix.img` (both MBR
variants). What's left untested is `hd32-minix.img` (partitionless
MINIX) — a permutation that the kernel's filesystem driver should
handle identically to the MBR-MINIX case at the disk-read layer
because the BIOS handoff is the same as the FAT-partitionless
case.

In other words: the substrate has run partitionless boot (FAT) and
it has run MINIX-on-HD (MBR). This brief verifies the intersection.

## Scope

### Section 1 — fetch the fixture

Extend `tools/elks-build/fetch-hd-image.ts` (or its arg-parsing
shape) to support fetching `hd32-minix.img` from the latest
`ghaerr/elks` release. The Phase 10.1 multi-image pattern handles
this — the brief noted MBR fixtures were added; partitionless MINIX
just adds another asset name.

If the GitHub fetch is blocked or the release lacks
`hd32-minix.img` for the version we target, document that and stop;
this brief becomes "diagnosis only" with the tagger left at
`untested`.

### Section 2 — boot verification

Add an integration test, `tests/integration/elks-hd-minix-boot.test.ts`
(or extend `tests/integration/elks-hd-boot.test.ts` if it makes
sense to consolidate):

- Construct an `IBMPCMachine` with `hd32-minix.img` as the boot
  image, `diskClass = 'hard-disk'`.
- Boot to the kernel banner.
- Boot to the `# ` prompt.
- Inject a userland command (e.g., `echo minix-ok\n`); capture the
  echo round-trip from UART TX. Assert.

The test uses the same `AutoAdvanceHostClock` pattern from Phase
10.1 if needed (probably not — the partitionless boot has no MBR
auto-boot timeout to wait through).

Skip the test with a clear message if the fixture isn't present
(same skip-with-pointer pattern Phases 10 and 10.1 used).

### Section 3 — tagger update

If Section 2 passes, update `web/viability-tagging.ts`:

- The current rule: `^hd\d+-minix\.img$` → `untested`.
- After this brief: `^hd\d+-minix\.img$` → `likely-works`.

Update the corresponding test cases in
`tests/unit/viability-tagging.test.ts` (currently 13 cases per
Phase 10.1; will become 13 with one assertion changed, or 14 if a
new case feels distinct).

If Section 2 fails, **leave the tagger at `untested`** — the rule
remains honest. Document what failed and why in the report.

### Section 4 — what you are NOT building

- Multi-disk machine support. Out of scope; future brief.
- LBA extensions. The MINIX HD path uses the same INT 13h AH=0x02
  CHS reads as everything else.
- Larger MINIX HD variants (`hd64-minix.img` if it exists). Adding
  the 32 MB case is enough; if the user wants 64 MB later it's a
  one-line follow-up.
- Any UI surfacing of the tag change beyond the rule itself.
- Diagnosis depth comparable to Phase 10.1. The MBR diagnosis
  pinned the on-disk shape because the MBR was load-bearing
  bootstrap code. A partitionless MINIX image's first sector is
  the MINIX VBR — read by the kernel, not by the BIOS handoff —
  and doesn't need the same level of pinning. A short
  confirmation that the boot reaches the kernel and the kernel
  mounts MINIX is sufficient.

## Tests

### Unit tests

- **`tests/unit/viability-tagging.test.ts`** — update one
  assertion (or add one new case) for the partitionless MINIX
  rule.

### Integration tests

- **`tests/integration/elks-hd-minix-boot.test.ts`** (new) or
  added case in `elks-hd-boot.test.ts` — see Section 2.

### Smoke tests

All Phase 10 / 10.1 tests must keep passing. The fixture-fetch
script extension must not break the existing FAT and MBR fetches.

## Watch out for

- **The MINIX FS driver may behave differently from FAT under
  load.** Should be fine — Phase 10.1 verified MINIX-on-MBR — but
  if a probe fails, the failure mode is informative and worth
  documenting before reaching for a fix.
- **Fixture availability.** `hd32-minix.img` may not exist in
  every ELKS release. If the latest stable lacks it, check
  prereleases or document the absence. Don't fabricate a test
  fixture from the FAT image.
- **Tagger rule order.** The Phase 10.1 work pinned that
  filename-pattern rules run before the size threshold. Adding /
  changing a rule mustn't disturb the order.
- **Boot transcript assertion.** MINIX FS produces different
  on-mount output than FAT (`VFS: Mounted root device` is the
  same; the FS-name in the kernel log differs). Assert on shape,
  not exact bytes — same discipline as the FAT case.

## Definition of done

**Outcome A (verification passes):**
- Integration test boots `hd32-minix.img` to a `# ` prompt.
- Userland command round-trips.
- Tagger rule updated; corresponding unit test updated.
- All prior tests still pass.
- Total tests ≥ 1,228.

**Outcome B (verification fails, no source changes):**
- Integration test added but expected-to-fail or skipped with
  diagnosis.
- Tagger rule unchanged; remains `untested`.
- Report's diagnosis section explains the failure mode at the
  byte / instruction level.
- All prior tests still pass.

**Outcome C (verification needs a fix in a locked directory):**
- **Stop and report**. Don't implement. The user decides.
- Tagger rule unchanged; remains `untested`.
- Report's diagnosis section is concrete enough that a follow-up
  brief is straightforward.

In all cases:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).
- Release snapshot at `releases/phase-10-2-minix-hd/` populated
  and manually launch-verified.

## Release snapshot

Layout:

```
releases/phase-10-2-minix-hd/
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/
├── dist-web/
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/
        ├── hd32-fat.img
        ├── hd32mbr-fat.img
        └── hd32-minix.img    # if Outcome A
```

`node_modules/` not copied.

Verify:
- Node serial harness boots floppy.
- Browser harness boots the existing HD images (FAT,
  MBR-FAT, MBR-MINIX).
- Browser harness boots `hd32-minix.img` (if Outcome A).

The report at `MINIX_HD_REPORT.md` has these sections:

- **Summary**: outcome (A / B / C); tagger updated or not.
- **Fixture acquisition**: how the image was fetched; any
  GitHub-side notes.
- **Boot trace**: the kernel-side mount line, the partitionless
  MINIX-specific output if any, the prompt arrival.
- **Tagger update**: rule change and tests; or "no change,
  remains untested" with rationale.
- **What's deferred**: anything noticed but out of scope.
- **Things future briefs should address**: pulled from anything
  surfaced; otherwise the broader roadmap items.
- **CPU/memory bug candidates**: should be none.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`MBR_PARTITION_REPORT.md`** — Phase 10.1 work; this brief
   inherits its substrate. Read the MINIX MBR section
   specifically.
2. **`HARDDISK_BOOT_REPORT.md`** — Phase 10's substrate.
3. **`tools/elks-build/fetch-hd-image.ts`** — fetcher to extend.
4. **`web/viability-tagging.ts`** — the tagger rules.
5. **`reference/elks/elks/fs/minix/`** — kernel-side MINIX FS
   driver, if a failure mode needs investigation.

## Final notes

This is a small brief by design. The expected outcome is A —
clean verification, one tag rule flipped, one assertion updated.
If the substrate genuinely needed work to support partitionless
MINIX, that would be a surprise the project is structured to
surface gracefully (Outcome C, stop and report). The discipline
this brief asks for is the same as always: don't fabricate
problems, don't expand scope, don't silently relax the rules.

After this lands, the HD arc is fully verified: FAT and MINIX,
partitionless and MBR. The viability tagger tells the truth across
the matrix. The user's evaluation goal — "are these images viable
in our emulator" — is answered for every shape ELKS publishes.

Subsequent direction is open. The remaining candidates from the
Phase 10.1 close-out: CGA-canvas, network device, snapshot/restore,
authentic-vs-virtual-shift toggle, multi-disk machines.
