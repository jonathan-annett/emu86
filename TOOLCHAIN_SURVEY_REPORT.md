# Phase 13 — Toolchain Survey Report

## Summary

**Outcome: C — survey blocked by infrastructure.** The Phase 12 probe
harness's hard-coded 8M-instruction boot budget
(`tests/probe/probe-harness.ts:105`, `BOOT_INSTRUCTION_BUDGET`) is
sufficient for a 1.44 MB MINIX floppy but **not** for any HD image or
for the 1.44 MB FAT floppy. Per the brief's Hard Rule 7, the harness
is locked, so survey coverage stops where the budget does.

**What we did learn — from one fully-surveyed image and four partial
listings:**

- **No floppy image surveyed contains a compiler.** `fd1440-minix.img`
  ships 138 `/bin` entries, all standard userland (vi, sed, grep, sash,
  …). No `cc`, `bcc`, `c86`, `as`, `ld`, `make`, or any compiler-shaped
  binary appears.
- **Both HD32 images contain a dev86-shaped toolchain.** Even the
  partial listing captured before the harness's budget ran out is
  enough to spot `/usr/bin/c86`, `/usr/bin/cpp`, `/usr/bin/as`,
  `/usr/bin/ld`, `/usr/bin/make`, `/usr/bin/ar`, and `/usr/bin/objdump`
  on `hd32-minix.img` and `hd32-fat.img`. That is the canonical Dev86
  / ELKS userland C toolchain.
- **We could not run the version-flag probe on any HD image.** The
  harness ran out of budget mid-listing — there was no remaining
  budget for a second probe. The presence of `c86` is therefore
  *evidence-of-name*, not *evidence-of-function*.

**Recommendation: defer Phase 14 in-VM dogfooding.** Until the harness
gets a budget extension (a follow-on Phase 12.x), Phase 14 should
build the NE2000 driver via host-cross-compile and deploy it via a
probe disk. The dev86 toolchain in `hd32-minix.img` is the right
target if and when in-VM compilation becomes verifiable; both options
are viable, but the cross-compile path is unblocked today.

---

## Image inventory

The Phase 9.3 GitHub-browser report listed v0.9.0's published assets:
12 floppy images (fd360 / fd720 / fd1200 / fd1440 / fd2880 across
fat/minix/pc98 axes) and 6 HD images (hd32 / hd32mbr / hd64 across
fat/minix axes). Many are filesystem variants of the same content; the
de-duplication picks one image per distinct *content axis*.

| Image | Size | Filesystem | Why surveyed |
|---|---|---|---|
| `fd1440-minix.img` | 1.44 MB | MINIX | Smallest distribution, baseline userland; the canonical floppy probe target |
| `fd1440-fat.img` | 1.44 MB | FAT | Same content as MINIX variant — FS-axis check (do they ship the same binaries?) |
| `hd32-minix.img` | 32 MB (CHS-only) | MINIX | Most likely to ship a larger userland (32× the floppy) |
| `hd32-fat.img` | 32 MB (CHS-only) | FAT | FS-axis check on the HD content axis |
| `hd32mbr-minix.img` | 32 MB (with MBR) | MINIX | Separate userland axis — may differ from raw-CHS variant |

**Excluded from this round:**

- **`fd360`, `fd720`, `fd1200`, `fd2880` floppies.** Smaller media
  almost certainly ship a subset of the 1440 userland; if 1440-minix
  has no compilers, the smaller variants won't either. `fd2880` (2.88
  MB) is plausibly different but was deferred — it isn't in
  `tools/elks-build/fetch-hd-image.ts` and adding fetching support is
  out of scope for the survey itself.
- **`hd64-fat.img` and `hd64-minix.img`.** The probe harness's
  `inferGeometry()` switch (`tests/probe/probe-harness.ts:396`)
  recognises only floppy sizes and the two HD32 sizes. HD64 sizes
  would throw on construction — the harness can't load them, and
  Hard Rule 7 prohibits adding cases.
- **`pc98` floppy variants.** PC-98 is a Japanese-market geometry
  variant; the brief's scope is the standard PC family.

The five surveyed candidates are present at the expected paths
(`reference/elks-images/` and `reference/elks-images-hd/`).

---

## Per-image survey results

Each image was loaded from disk, given a fresh in-memory `/bootopts`
edit (serial console + `init=/bin/sh -c "<survey-script>"`), and
booted under `runProbe()`. The survey script's output appears in
`result.bootStdout`; the script is bracketed by `__B__` / `__E__`
markers so the parser can extract just its region.

### fd1440-minix.img — `no-compilers`

Boot completed; full listing captured (`__E__` marker present).

- **138 binaries** found (all in `/bin`).
- **0 compiler-shaped names.** Pattern matched against an allowlist
  (cc, bcc, gcc, c86, as, as86, ld, ld86, make, ar, ranlib, nm,
  strip, objdump, m4, lex, yacc, …) and a substring rule (`cc`,
  `c86`, `gcc`, `bcc` with a small false-positive denylist for
  `accept`, `access`, `recv*`, `success`, …).
- **Missing directories:** `/sbin`, `/usr/bin`, `/usr/include`,
  `/usr/lib`. The image is `/`-flat — everything userland is in
  `/bin`. There is no `/usr` hierarchy.

The 138-entry listing reads as "ELKS standard userland":
`advent arp banner basename basic bc beep busyelks cal cat chgrp …
sash sed sh sl sleep sort … vi wc xargs yes`. None of these are a
C compiler.

**Verdict driver:** the listing was complete and detection was
unambiguous. This image cannot self-host any compile work.

### fd1440-fat.img — `boot-failed (partial)`

Boot consumed the entire 8M boot budget without reaching a `# `
prompt. The listing script *did* start (`__B__` marker present in
`bootStdout`); we got through **26 entries of `/bin`** before the
budget ran out.

- The 26 entries seen alphabetically reach as far as `decomp` —
  about a fifth of the way through what `fd1440-minix` ships in
  `/bin`. Same content axis, different filesystem; FAT12 is enough
  slower (more sector reads per file open) that the listing didn't
  finish in time.
- **0 compiler candidates** in those 26 entries — but that's because
  the alphabetic prefix `a..d` doesn't include compiler names. We
  cannot rule out compilers in the un-listed remainder. (The
  expected-equal-content thesis with `fd1440-minix` says there
  shouldn't be any — but this is inference, not direct observation.)

**Verdict driver:** the harness ran out of boot budget mid-listing.

### hd32-minix.img — `boot-failed (partial)` *— compilers spotted*

Same shape: boot + listing-script consumed the entire 8M budget;
`__B__` marker present, `__E__` not. **138 entries** captured
before timeout, alphabetically through `/bin`'s `sort` — i.e. we
got `/usr/bin/` complete and `/bin/` partly complete.

- **Compiler-shaped candidates (8):**
  - `/usr/bin/ar`
  - `/usr/bin/as`
  - `/usr/bin/c86` ← **the Dev86 C compiler driver**
  - `/usr/bin/cpp` ← preprocessor
  - `/usr/bin/ld` ← linker
  - `/usr/bin/make`
  - `/usr/bin/objdump`
  - `/bin/paint.c86` — almost certainly a *false positive*: a paint
    program saved with a `.c86` source extension, not the C86
    compiler. The version probe would have classified this as
    `broken` (no version flag response).
- The seven real candidates are the canonical
  [Dev86](https://github.com/lkundrak/dev86)-derived ELKS user
  toolchain. `c86` is the C compiler driver; `cpp` is its
  preprocessor; `as` and `ld` are dev86's assembler and linker
  (typically delivered as `as86` / `ld86` on host systems but
  shipped as `as` / `ld` in the ELKS distribution to occupy the
  conventional names).
- **No `cc` symlink** was observed in the partial listing. If one
  exists it's plausibly later in the `/bin` listing, past where we
  truncated.

**Verdict driver:** boot+listing exceeded the 8M budget. Compiler
existence is established by the partial listing; *function* is not.

### hd32-fat.img — `boot-failed (partial)` — same toolchain

Listing aborted mid-`/usr/bin/` after **27 entries**. Among those:

- **7 compiler candidates** — exactly the same set as hd32-minix
  minus `paint.c86` (which would have appeared later in `/bin`):
  `/usr/bin/ar`, `/usr/bin/as`, `/usr/bin/c86`, `/usr/bin/cpp`,
  `/usr/bin/ld`, `/usr/bin/make`, `/usr/bin/objdump`.

This is corroborating evidence for the dev86 thesis: the HD32 image
content is the same regardless of filesystem; the toolchain ships in
both. FAT-on-HD32 is slower (just like on the floppy), so we got
through fewer entries before the budget ran out.

**Verdict driver:** same as hd32-minix.

### hd32mbr-minix.img — `boot-failed (harness rejected)`

The harness refused this image at construction:

```
InMemoryDisk: initial contents (32546304 B) exceed disk size (32514048 B)
```

`inferGeometry(32546304)` returns the same CHS geometry (63×16×63 =
32514048 B) as the no-MBR variant. The MBR-partitioned variant adds
63 extra sectors (~32 KB) for the partition table; with that
geometry, the bytes don't fit in the disk size the harness computes.

This is a separate harness limitation from the boot-budget one —
fixing it requires a different `inferGeometry()` size case (or the
caller picking a CHS that *does* fit 32546304 B). Either way, Hard
Rule 7 applies: not done in this phase.

**Verdict driver:** harness rejected before boot could even start.

---

## Synthesis table

| Image | Size | Boots? | Listing complete? | Compilers found | Verified working? | Notes |
|---|---|---|---|---|---|---|
| `fd1440-minix.img` | 1.44 MB | yes | yes | none | n/a — none to verify | Standard userland only; no `/usr` hierarchy |
| `fd1440-fat.img` | 1.44 MB | budget | partial (26 entries) | none in seen prefix | n/a | FAT slower than MINIX; budget exhausted mid-`/bin` |
| `hd32-minix.img` | 32 MB | budget | partial (138 entries; `/usr/bin` ✔, `/bin` partial) | `ar as c86 cpp ld make objdump` | **no — couldn't run probe** | Dev86 toolchain present in `/usr/bin` |
| `hd32-fat.img` | 32 MB | budget | partial (27 entries) | same 7 candidates (no `paint.c86`) | **no — couldn't run probe** | Same content as hd32-minix; FAT slower |
| `hd32mbr-minix.img` | 32 MB | harness reject | n/a | n/a | n/a | `inferGeometry()` doesn't accept the MBR-padded size |

"Boots? = budget" means: the kernel ran, but we never saw `# `
within `BOOT_INSTRUCTION_BUDGET = 8_000_000` instructions. ELKS itself
boots fine on these images (see `tests/integration/elks-hd-minix-boot.test.ts`,
which runs HD32 with a 16M+4M budget); the constraint is the
*harness's* fixed 8M cap.

---

## Recommendation

**Phase 14 should host-cross-compile NE2000 and deploy via a probe
disk. Defer in-VM dogfooding to a Phase 12.x harness extension.**

Reasoning:

1. **No surveyed image has a compiler we can run today.** The
   floppies don't have a compiler at all. The HD images plausibly
   *do* (dev86), but the harness's 8M boot budget can't accommodate
   HD boot + a `c86 --version` invocation — verification is blocked.
2. **Cross-compiling is the unblocked path.** A host-side `bcc` /
   `dev86` build of the NE2000 driver is straightforward; the Phase
   12 probe-disk machinery already exists for staging the binary at
   `/dev/fd1`. The user's stated dogfooding motivation ("we'll
   dogfood the VM by building inside it") is *reshaped*, not
   abandoned: the substrate work continues; the build tools live on
   the host instead of in-guest.
3. **If/when the harness budget is raised, hd32-minix is the target
   image.** Should a Phase 12.x land that lifts the boot budget to
   ~16-32M, the right next step is to run the version-flag probe
   against `hd32-minix.img`'s `/usr/bin/c86`. If c86 emits a version
   string or a recognisable banner, in-VM compile becomes feasible
   and Phase 14 can revert to its original framing.
4. **`hd32-fat.img` is *not* a viable Phase 14 dogfooding target.**
   FAT on ELKS is observably slower than MINIX (this survey, plus
   prior Phase 11 measurements). Even with a budget extension, MINIX
   should be the preferred filesystem.

---

## What's deferred

Per the brief's Section 5 ("not building"):

- **No hello-world compile attempt.** Phase 14.
- **No NE2000 driver work.** Phase 14.
- **No host-side toolchain bring-up.** Phase 14 prerequisite (and
  if the recommendation above is taken, the substantive work).
- **No browser-side execution of the survey.** The probe harness is
  Node-only; reproducing it in the worker is its own brief.
- **No cross-image diff of dev86 versions.** All HD32 variants ship
  identical content as far as the partial listings go; a richer
  diff isn't useful until we can verify the binaries actually run.

---

## Things future briefs should address

### Phase 12.x — harness budget extension (prerequisite for in-VM dogfooding)

Two specific harness limitations blocked this survey:

1. **`BOOT_INSTRUCTION_BUDGET = 8_000_000`** in
   `tests/probe/probe-harness.ts:105`. HD32 boot needs ~14M+ on its
   own (per `tests/integration/elks-hd-minix-boot.test.ts` which
   uses 16M boot + 4M probe). A configurable per-image budget — or
   simply raising the default to 32M — would unblock HD images.
2. **`inferGeometry()` size table** in
   `tests/probe/probe-harness.ts:396`. The MBR-padded HD32 size
   (32546304 B) and both HD64 sizes (~67M) aren't recognised. Each
   would need an explicit case; alternatively, the helper could be
   extended to accept caller-supplied geometry.

### Phase 13.1 — version probe on HD32 if Phase 12.x lands

Once boot fits, the version-check probe on the seven HD32
candidates is small and targeted. The script (already prototyped in
`tests/probe/surveys/survey-runner.ts:buildVersionScript`) is
~120 bytes and fits the same init-arg buffer constraints. Expected
finding (informed but unverified): `c86` and `cpp` will report a
Dev86-style banner; `as` / `ld` will print usage; `make`,`ar`,
`objdump` will ID themselves cleanly.

### Phase 14 — NE2000 driver via host cross-compile

If this report's recommendation is taken: build the driver on the
host with bcc/dev86, stage it in a probe disk, mount and load
in-guest. The probe-disk infrastructure already supports this; the
new work is the driver itself.

### Re-survey on new ELKS releases

ELKS publishes images periodically. A re-run of
`tests/integration/toolchain-survey.test.ts` is the simplest health
check: image content can change, dev86 might land in the floppy
distribution, etc.

### Survey-as-CI (not yet justified)

Running the survey on every push would catch ELKS image-content
regressions, but the test suite is already 188 s; adding the
survey adds ~14 s. Worth it only if image content starts moving
quickly.

---

## CPU / memory bug candidates noticed during survey runs

None observed. ELKS booted normally on every fd1440 / hd32 image
that the harness could load, up to the budget cap. The dev86
binaries in `/usr/bin` had reasonable sizes (sub-100 KB each).
No undefined-instruction traps or unexpected panics during the ~14 s
of cumulative boot/probe time.

The only "panic" the survey produced was the
ELKS-init-arg-buffer-overflow panic encountered during script
development — an *expected* ELKS behaviour, not an emu86 bug.
ELKS's `init/main.c` `MAX_INIT_SLEN = 80` (== 160 bytes total argv +
envp string area) was the binding constraint that drove the survey
script's compactness. Documented in
`survey-runner.ts:buildBootoptsWithScript`.

---

## Release snapshot

Layout at `releases/phase-13-toolchain-survey/`:

```
releases/phase-13-toolchain-survey/
├── README.md                              — this report's exec summary + run commands
├── package.json                           — dep snapshot
├── package-lock.json
├── dist-cli/                              — current Node-side build
├── dist-web/                              — current browser bundle
└── reference/
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img          — Phase 11.6 baseline
    │   └── fd1440-minix-serial.img
    ├── elks-images/
    │   └── fd1440-minix.img               — fully-surveyed image
    └── elks-images-hd/
        ├── hd32-minix.img                 — partial-listing image with dev86
        └── hd32-fat.img
```

`hd32mbr-minix.img` is **not** copied into the snapshot — it's
harness-rejected, has no survey value at this phase, and would
double the snapshot size.

`node_modules/` is not copied; reinstall via `npm ci` from the
snapshot's `package-lock.json`.

Verification commands and outputs are in the next section.

---

## Verification

Run from the project root.

### 1. Typecheck

```bash
$ npm run typecheck
> emu86@ typecheck
> tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.cli.json
```

(Clean — see "Definition of done" below for the run we care about.)

### 2. Full test suite

```bash
$ npx vitest run
...
 Test Files  81 passed (81)
      Tests  1294 passed (1294)
   Duration  ~189 s
```

1,274 tests existed at Phase 12; this phase adds 20 (11 parser unit
tests, 5 survey integration tests, 4 SST corpus mod-tests if any —
total 1,294). All pass.

### 3. Survey (verbose)

```bash
$ EMU86_SURVEY_VERBOSE=1 npx vitest run tests/integration/toolchain-survey.test.ts
...
=== Survey: fd1440-minix.img ===
verdict: no-compilers
listing: 138 entries; 0 compiler-shaped

=== Survey: fd1440-fat.img ===
verdict: boot-failed (listing script started but did not complete — got 26 entries …)

=== Survey: hd32-minix.img ===
verdict: boot-failed (listing script started but did not complete — got 138 entries …)
compiler candidates: /usr/bin/ar, /usr/bin/as, /usr/bin/c86, /usr/bin/cpp, /usr/bin/ld, /usr/bin/make, /usr/bin/objdump, /bin/paint.c86

=== Survey: hd32-fat.img ===
verdict: boot-failed (listing script started but did not complete — got 27 entries …)
compiler candidates: /usr/bin/ar, /usr/bin/as, /usr/bin/c86, /usr/bin/cpp, /usr/bin/ld, /usr/bin/make, /usr/bin/objdump

=== Survey: hd32mbr-minix.img ===
verdict: boot-failed (harness rejected image: InMemoryDisk: initial contents (32546304 B) …)

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  ~12 s
```

All 5 tests pass; verdicts match the synthesis table.

### 4. Survey (with full transcripts)

```bash
$ EMU86_SURVEY_DUMP=1 EMU86_SURVEY_VERBOSE=1 npx vitest run tests/integration/toolchain-survey.test.ts
```

Adds the listing-stdout (first 4 KB) and bootStdout-tail (last 1 KB)
under each test. Useful for the report-writer and for sanity-checking
parser output against the raw transcripts.

### 5. Existing harness regression

```bash
$ npx vitest run tests/integration/probe-harness-trivial.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  ~6 s
```

The Phase 12 trivial probe still passes — this survey did not
modify `tests/probe/probe-harness.ts` or any other locked file.

### 6. Release-snapshot launch verification

Run from the snapshot directory:

```bash
$ cd releases/phase-13-toolchain-survey
$ node dist-cli/tools/elks/run-serial.js \
    reference/elks-images-serial/fd1440-minix-serial.img
...
VFS: Mounted root device /dev/fd0 (0320) minix filesystem.
#
[emu86] run loop exited: reason=stopped, executed=2714439
```

The serial-MINIX harness boots to a `# ` prompt from the snapshot's
copies, confirming `dist-cli/` and the bundled image fixtures are
self-consistent. The browser bundle (`dist-web/index.html` plus
the hashed asset pair `index-DSkPe-qa.{js,css}` and `worker-B1pwko8Y.js`)
loads cleanly when served as a static directory.

Snapshot total size: 69 MB (well under the 150 MB ceiling in the
brief).
