# emu86 — Agent Brief: Toolchain Survey (Phase 13)

## TL;DR

Use the Phase 12 probe harness to survey every published ELKS
image and report which ones contain a self-hosted compiler that
runs in our emulator. The output is **a recommendation grounded in
evidence**: which image (if any) is the right starting point for
the user's stated dogfooding arc — boot ELKS, mount source disk,
build the NE2000 driver from source.

This is the first real application of `runProbe()`. No new
infrastructure, no substrate change. The harness is the tool;
the survey is the work it does.

The Phase 9.3 GitHub-browser report inventoried v0.9.0's published
assets: 12 floppy images and 6 hard-disk images. Many are
filesystem variants of the same content (FAT vs MINIX, MBR-
partitioned vs not). The agent's first task is to identify the
**distinct** content axes (likely 4-6 images after de-duplication)
and survey each.

Per-image, the survey runs medium-depth probes: list `/usr/bin/`
and `/bin/`, identify any compiler-shaped binaries, invoke each
one's version flag and capture output. Hello-world compile is
explicitly **out of scope** — that's Phase 14's first step.

Document in `TOOLCHAIN_SURVEY_REPORT.md`.

You are working in `emu86/`. Read `PROBE_HARNESS_REPORT.md` (the
tool you're using) and `GITHUB_BROWSER_REPORT.md` Section about
asset listings (the candidate images). Phase 11.5's
`RAMDISK_REPORT.md` covers the published-image filesystem layout
useful for understanding what's likely where.

## Hard rules

1. **Don't break existing tests.** 1,274 passing as of Phase 12.
   All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **No new infrastructure.** This brief uses `runProbe()`
   exactly as Phase 12 shipped it. If the harness needs an
   extension, surface it and stop — that's a Phase 12.x
   follow-up brief, not part of this work.
6. **You may add** files under `tests/probe/surveys/` (the
   survey scripts), under `tools/elks-build/` (image-fetch
   extensions if needed), and one or more integration tests
   that exercise the surveys. You may add a single document
   (the report) under the project root.
7. **You may NOT modify** anything in `src/`, `web/`, or
   `tests/probe/probe-*.ts`. The probe harness is fixed
   infrastructure.
8. **Medium-depth probes only.** No hello-world compile attempts.
   Listing binaries and invoking version flags is the bound.
9. **No fix-and-pray.** If an image won't boot, an attempted
   probe times out, or a compiler-version invocation crashes —
   document the finding, don't try to "make it work."
10. **No image rebuilding.** Surveys run against the upstream
    images as published. The `/bootopts` edit pattern Phase 8 /
    11.6 used can apply if a serial-console version is needed
    for a specific image, but no kernel rebuilds, no userland
    changes.

## Background

The user's stated motivation, way back: "we'll dogfood the VM
by using c86 toolchain to build [the NE2000 driver]". That
motivated the substrate arc (Phase 11 multi-disk → 11.5 ramdisk
→ 11.6 MINIX serial → 12 probe harness). The substrate is now
ready; this brief is the first investigation it enables.

The honest open questions:

- **Does any published ELKS image actually ship a self-hosted
  compiler?** ELKS is small. Historically the toolchain has been
  `dev86`/`bcc` (host-side) or `ia16-elf-gcc` (host-side modern).
  Whether either runs as ELKS userspace, and whether any
  published image includes such a binary, is genuinely unknown
  to the planning instance. The user mentioned in passing that
  "some of the hd images have toolchains in the deploy" — this
  brief verifies that claim.
- **If a compiler is present, does it run?** A binary on disk
  isn't proof of execution. A version-flag invocation that
  returns sensible output is. The medium-depth probe answers
  this.
- **If multiple images have compilers, which is best?** Defined
  loosely as: the smallest image that contains a working
  compiler with the headers and tools needed for a non-trivial
  build. The survey produces ranked findings.

A clean negative answer ("no published image ships a working
self-hosted compiler") is also a valuable outcome — it tells the
dogfooding arc that the path is host-cross-compile, not VM-
self-host. The brief is structured to land cleanly either way.

## Scope

### Section 1 — image inventory and de-duplication (mandatory first step)

The Phase 9.3 report listed v0.9.0's published assets: 12 floppy
and 6 HD. Many are filesystem variants. List the distinct content
axes:

- **Boot media size.** 360 KB / 720 KB / 1.2 MB / 1.44 MB
  floppy; 32 MB / 64 MB hard-disk.
- **Filesystem.** FAT12 (FAT) vs MINIX V1 (MINIX).
- **Partition layout.** Partitionless vs MBR-partitioned (HD
  only).
- **Console config.** Serial-vs-CGA (a `/bootopts` distinction;
  Phase 11.6 applies the edit).
- **Userland set.** This is the axis of interest for toolchain
  presence — different images ship different userland mixes.
  This needs to be discovered, not pre-classified.

Produce a small table at the start of the survey: distinct image
candidates after de-duplication, why each was retained or
dropped. Aim for ~4-6 images to actually probe. The bigger the
image, the more likely it ships extras like compilers — so the
HD images and the larger floppies are higher-value candidates.

### Section 2 — fetch and prepare the candidates

For each image to be surveyed:

- If absent locally, fetch via the existing
  `tools/elks-build/fetch-hd-image.ts` infrastructure (extend
  with new image names if they're not already supported). The
  Phase 9.3 / 10.x precedent applies — script-driven fetch,
  skipped-with-pointer if the agent's environment can't reach
  GitHub.
- If the image is CGA-configured but a serial probe is desired,
  apply the Phase 11.6 `/bootopts` edit to produce a
  `*-serial` variant. Do this only if the image's MINIX/FAT
  filesystem is structured the same way as the existing
  variants (i.e., the same `## /bootopts` marker pattern).
- If a candidate image won't boot at all in our emulator —
  whatever the cause — record the finding and move on. Phase
  10.x covered most boot-failure modes; new failures are
  themselves data.

### Section 3 — survey probe set (per image)

For each surveyed image, run two probes:

**Probe 1: enumerate binaries.**

```sh
ls -la /usr/bin/ 2>&1
ls -la /bin/ 2>&1
ls -la /sbin/ 2>&1
echo __SECTION__
ls -la /usr/include/ 2>&1
ls -la /usr/lib/ 2>&1
echo __SECTION__
echo __PROBE_DONE__
```

The output is parsed for filenames matching compiler-shaped
patterns (`cc`, `gcc`, `bcc`, `cpp`, `as`, `as86`, `ld`,
`ld86`, `make`, `ar`, `ranlib`, anything with `cc` or `c86` in
its name). The harness's `runProbe()` returns the full
transcript; parsing the section markers is the agent's
responsibility.

**Probe 2: version checks for any compiler-shaped binaries
found.**

For each candidate found in probe 1, attempt a version flag.
Different compilers respond to different flags; try in order:

- `<binary> -V`
- `<binary> --version`
- `<binary> -v`
- `<binary>` (no args; many compilers print usage/version on
  bare invocation)

```sh
for cmd in cc bcc gcc as86 ld86; do
  echo "=== $cmd ==="
  $cmd --version 2>&1 || $cmd -V 2>&1 || $cmd -v 2>&1 || $cmd 2>&1 | head -5
done
echo __PROBE_DONE__
```

Capture each compiler's response. A binary that crashes the
shell, hangs, or produces nothing useful is a data point — not
a recommendation.

Don't go beyond version checks. **Don't try to compile anything.**
Phase 14 (whichever brief takes the dogfooding arc forward) does
that as its first step using the recommendation from this brief.

### Section 4 — synthesise findings

Produce a per-image table in the report:

| Image | Size | Boots? | Compilers found | Working? | Notes |
|---|---|---|---|---|---|
| `hd32-fat.img` | 32 MB | yes | — | — | empty `/usr/bin/`, no compilers |
| `hd64-fat.img` | 64 MB | ? | bcc, as86, ld86 | yes (bcc reports `0.16.21`) | likely candidate |
| ... | ... | ... | ... | ... | ... |

(Illustrative. Real values come from the survey.)

After the table, a recommendation paragraph: which image (if
any) is the right starting point for Phase 14, and what's the
first command Phase 14 would issue inside it.

If the recommendation is "no image works for self-host," the
report says so. The dogfooding narrative gets reshaped — Phase
14 becomes "host-cross-compile NE2000, deploy via probe disk"
rather than "build NE2000 inside the VM." That's a useful
finding.

### Section 5 — what you are NOT building

- A hello-world compile attempt. Phase 14.
- A reusable "image survey" framework beyond the per-survey
  scripts in `tests/probe/surveys/`. Each survey is just a
  few `runProbe()` calls; an abstraction layer is premature.
- A continuous-integration pattern that re-runs the survey on
  new ELKS releases. Future polish if the survey becomes
  outdated.
- Browser exposure of the survey results. Test-only.
- An attempt to *patch* an image to add a compiler if none is
  found. Out of scope absolutely.
- Multi-image probes that share state across boots. Each survey
  is one image, one boot.
- NE2000 driver-source acquisition or staging. Phase 14.
- An effort to identify `c86` specifically (the user's offhand
  phrase). The survey reports what's *actually* in each image;
  if `c86` exists somewhere, it'll surface; if not, the survey
  reports the alternatives.

## Tests

### Unit tests

- **`tests/probe/surveys/parse-binary-listing.test.ts`** *(new,
  ~4-6 cases).* The transcript parser that turns probe output
  into a structured list of binaries. Test against synthetic
  transcripts: simple `ls` output, output with errors, output
  with missing directories, output with sections.
- **`tests/probe/surveys/parse-version-output.test.ts`** *(new,
  ~3-5 cases).* The version-flag-output classifier. Synthetic
  transcripts of "a working compiler" vs "a broken binary" vs
  "no such command."

### Integration tests

- **`tests/integration/toolchain-survey.test.ts`** *(new, 1
  case per surveyed image).* Each test boots an image, runs
  the two probes, asserts on broad-stroke findings (e.g., "the
  64 MB HD image boots and at least one binary is in
  `/usr/bin/`" — without pinning specific compiler presence,
  which is the survey's *output*, not a precondition).
  
  Skip-with-reason if the image fixture isn't fetched.

### Smoke tests

All Phase 12 tests must keep passing. The trivial probe
integration test still runs. Phase 11 multi-disk tests still
work.

## Watch out for

- **The harness is the tool, not the work.** If a probe fails
  to capture output cleanly, the impulse will be "let me extend
  the harness to handle this case." Resist — that's a Phase
  12.x follow-up brief. If a survey can't run because the
  harness doesn't quite fit, document and stop.
- **Boot times for HD images.** Phase 10 measured ~14s for
  partitionless HD; ~24s for MBR. With per-image probes, total
  survey wall-time could be minutes. The integration tests
  will be slow. Consider a `survey:run` npm script that runs
  all surveys without going through vitest, plus tighter
  vitest tests that run fewer instructions.
- **Fixture availability.** Some images may not be fetchable
  (network blocked, GitHub asset URL CDN issues per Phase 9.3).
  The survey gracefully skips, doesn't fabricate.
- **Output-buffer overrun.** A `ls -la` of a populated `/usr/
  bin/` plus headers and libs could be tens of KB. The Phase
  12 default cap is 256 KB — should be plenty, but document if
  any probe truncates.
- **MBR-partitioned images need the partition selection.** Phase
  10.1 covered this for boot; the kernel mounts the active
  partition's filesystem as `/`. So a probe against an MBR
  image surveys the active partition's userland, which is
  what we want.
- **Some images may auto-run init scripts that interfere.** If
  an image runs a getty or a daemon at boot, the probe injection
  may race against it. The Phase 11.6 `/bootopts` edit forces
  `init=/bin/sh`, which sidesteps this. Apply it where useful.
- **Don't pre-judge.** If an image's manifest suggests "no
  compiler" but the actual `/usr/bin/` listing surfaces one,
  trust the data. The survey's value is empirical; don't
  shortcut to assumptions.
- **Naming the recommendation specifically.** "Image X" is more
  useful than "the 64 MB variant" — Phase 14 needs the exact
  filename to pick from the GitHub library or the local fixture
  set. Be specific.

## Definition of done

**Outcome A (one or more images have working compilers):**
- Survey table populated for all candidate images.
- At least one image identified as "compilers present and
  responsive to version flags."
- Recommendation paragraph names the image and the next step
  for Phase 14.
- All prior tests still pass.

**Outcome B (no image has a working self-hosted compiler):**
- Survey table populated.
- Recommendation paragraph reframes Phase 14 as host-cross-
  compile + deploy-via-probe-disk.
- Findings explain *why* (compilers absent / present-but-broken).
- All prior tests still pass.

**Outcome C (survey blocked by infrastructure):**
- Stop and report. Specific blockers documented.
- All prior tests still pass.

In all cases:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean.
- Release snapshot at `releases/phase-13-toolchain-survey/`
  populated and manually launch-verified.

## Release snapshot

Layout:

```
releases/phase-13-toolchain-survey/
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/
├── dist-web/
└── reference/
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img
    │   └── fd1440-minix-serial.img
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/
        └── (whichever HD images were surveyed)
```

`node_modules/` not copied. Surveyed images included only if
small enough to keep snapshot under ~150 MB; otherwise
documented in the README as fetchable.

Verify the snapshot is launchable manually:
- Both serial harnesses still boot to `# ` (no regression).
- Browser harness still loads.
- One representative survey integration test passes.

The report at `TOOLCHAIN_SURVEY_REPORT.md` has these sections:

- **Summary**: outcome, recommendation, key findings.
- **Image inventory**: the de-duplicated candidate list with
  rationale.
- **Per-image survey results**: one section per image, with
  the binary listing, the version-flag responses, and any
  notable findings.
- **Synthesis table**: the per-image summary table from
  Section 4.
- **Recommendation**: explicit naming of which image (if any)
  is the Phase 14 starting point, with reasoning.
- **What's deferred**: per Section 5 of the brief.
- **Things future briefs should address**:
  - Phase 14 — whichever direction the recommendation points.
  - Re-survey on new ELKS releases.
  - Survey-as-CI if useful.
  - Possible harness extensions if any survey hit a real wall.
- **CPU/memory bug candidates**: anything noticed during the
  many boot/probe runs.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`PROBE_HARNESS_REPORT.md`** — Phase 12; the tool this brief
   uses. Read its API section first.
2. **`GITHUB_BROWSER_REPORT.md`** — Phase 9.3; image inventory
   and asset-fetch details.
3. **`MULTI_DISK_REPORT.md`** — Phase 11; secondary-disk
   semantics the harness uses.
4. **`SERIAL_MINIX_REPORT.md`** — Phase 11.6; `/bootopts` edit
   pattern if applied to new images.
5. **ELKS userland documentation** at `reference/elks/elkscmd/`
   if needed for context on what binaries do what.
6. **`tools/elks-build/fetch-hd-image.ts`** — fixture fetcher.

## Final notes

This brief produces evidence and a recommendation. The
recommendation — whichever direction it points — shapes Phase 14.
The discipline is **report what's there, not what we hoped to
find**. A negative result ("no working self-host compilers in
any published image") is honest and actionable; a fabricated
positive would mislead the next brief.

The user's stated motivation was dogfooding via VM-self-host.
That motivation is preserved if the survey turns up a working
compiler; it's reshaped (not abandoned) if it doesn't —
host-cross-compile + deploy-via-probe-disk is still in the
spirit of the substrate work, just with the build tools on the
host side.

After this lands, Phase 14 is the next user-facing milestone:
either "boot ELKS, mount source disk, build NE2000 in-VM" or
"build NE2000 on host, deploy to VM, load it." Either way, the
NE2000 driver is closer.
