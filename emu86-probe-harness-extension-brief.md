# emu86 — Agent Brief: Probe Harness Extension + HD32 Version Probe (Phase 12.1 / 13.1)

## TL;DR

Two tightly-coupled small pieces:

1. **Harness extension** (Phase 12.1). Raise the probe harness's
   hard-coded boot budget and unbreak the geometry inference for
   HD images the survey couldn't load. The Phase 13 toolchain
   survey ran into both: 8M boot instructions wasn't enough for
   any HD image; `inferGeometry()` rejected MBR-padded HD32
   (32,546,304 bytes) and HD64 sizes outright.

2. **HD32 version probe** (Phase 13.1). Once the harness fits,
   run version-flag probes against the seven Dev86-shaped
   binaries Phase 13 spotted on `hd32-minix.img`: `c86`, `cpp`,
   `as`, `ld`, `make`, `ar`, `objdump`. Determine whether the
   in-VM toolchain actually *runs* — not just whether the names
   exist. Phase 13's Outcome C is settled by this probe.

These ride together because they're each too small to deserve
their own brief and they're sequentially dependent.

The output is a definitive answer to "can ELKS dogfood the
NE2000 driver build?" If the answer is yes, Phase 14 reverts to
the user's originally-stated arc (build in-VM). If no, Phase 14
takes the host-cross-compile path Phase 13 recommended.

Document everything in `PROBE_HARNESS_EXTENSION_REPORT.md`.

You are working in `emu86/`. Read `PROBE_HARNESS_REPORT.md`
(Phase 12; the harness API and structure) and
`TOOLCHAIN_SURVEY_REPORT.md` (Phase 13; the survey's Outcome C
findings and the seven candidate compiler binaries on HD32). The
networking plan at `emu86-networking-plan.md` is context for what
Phase 14 looks like under each outcome.

## Hard rules

1. **Don't break existing tests.** 1,294 passing as of Phase 13.
   All must stay green, including the Phase 12 trivial probe
   integration test and the five Phase 13 survey integration
   tests.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **No substrate changes.** This brief touches the probe harness
   (`tests/probe/`) and survey scripts (`tests/probe/surveys/`)
   only. The substrate (`src/`, `web/`) stays locked. Phase 12's
   "harness is the tool, not the work" discipline applies — we're
   *extending* the tool here precisely because Phase 13 hit a
   tool limit, not a workflow limit.
6. **You may modify** `tests/probe/probe-harness.ts` (boot budget,
   `inferGeometry`), files in `tests/probe/surveys/` (the new
   version probe), and any test files that benefit. You may add
   one or two new integration tests for the version probe.
7. **You may NOT modify** anything in `src/`, `web/`, or
   `tests/probe/probe-disk.ts`. The FAT12 writer is fixed
   infrastructure.
8. **Version probe only.** No hello-world compile attempt — that's
   Phase 14 territory if the verdict is "compilers work." This
   brief's depth ceiling is "binary responds to a version flag
   without crashing or hanging."
9. **No fix-and-pray.** If a compiler binary crashes, hangs, or
   produces no useful output under any version flag, document the
   finding. Don't try to coax it into working — that itself is
   evidence about the in-VM toolchain's state.

## Background

Phase 13's Outcome C was definitive: the harness's 8M boot budget
caps survey coverage on any HD image. Phase 13's writeup cited:

> `BOOT_INSTRUCTION_BUDGET = 8_000_000` in
> `tests/probe/probe-harness.ts:105`. HD32 boot needs ~14M+ on its
> own (per `tests/integration/elks-hd-minix-boot.test.ts` which
> uses 16M boot + 4M probe).

Phase 13 also identified the geometry-inference rejection:

> `inferGeometry()` size table in
> `tests/probe/probe-harness.ts:396`. The MBR-padded HD32 size
> (32546304 B) and both HD64 sizes (~67M) aren't recognised.

These are pure-test-infrastructure constraints. Lifting them
unblocks the deferred verification work without touching anything
load-bearing in the substrate.

The Phase 13 survey identified seven `/usr/bin/` entries on
`hd32-minix.img` that are compiler-shaped:

```
/usr/bin/c86      (Dev86 C compiler driver)
/usr/bin/cpp      (preprocessor)
/usr/bin/as       (Dev86 assembler — typically 'as86' on host)
/usr/bin/ld       (Dev86 linker — typically 'ld86' on host)
/usr/bin/make     (build orchestrator)
/usr/bin/ar       (archiver)
/usr/bin/objdump  (binary inspector)
```

Plus `/bin/paint.c86` which Phase 13 flagged as almost certainly a
false positive (a paint program with a `.c86` source-file
extension, not the C86 compiler).

This brief verifies which of those seven actually run.

## Scope

### Section 1 — harness extension (Phase 12.1 portion)

**1a. Boot budget configurability.**

The current Phase 12 API has `timeoutInstructions` for the probe
phase. The boot phase has a separate hard-coded budget. Make the
boot budget caller-configurable in the same shape:

```ts
export interface ProbeRequest {
  primaryImage: string | Uint8Array;
  probe: ProbeScript;
  timeoutInstructions?: number;       // probe phase, existing
  bootInstructionBudget?: number;     // NEW — boot phase
  maxOutputBytes?: number;
}
```

Default `bootInstructionBudget` should accommodate HD images.
Phase 11.5's HD-MINIX integration test used a 16M boot budget
successfully; doubling to 32M leaves headroom for slower images
without risking test wall-time blowing up. Document the chosen
default and reasoning.

The trivial probe (1.44 MB MINIX floppy) doesn't need 32M; it's
fine at the new default. Existing Phase 12 tests stay green.

**1b. `inferGeometry()` extension.**

Add cases for the sizes Phase 13 hit:

- 32,546,304 bytes (MBR-padded HD32: same 63×16×63 CHS as
  un-padded HD32, but with one extra track of MBR overhead).
- ~67 MB sizes for HD64 variants. Phase 11's worker-host size
  table already handles these; mirror the entries in the probe
  harness's table.

Alternative shape to consider (the agent decides): generalise
`inferGeometry()` to accept a caller-supplied geometry override
when an image's size doesn't match a known case. Both shapes are
acceptable; pick whichever is simpler. Document the choice.

**1c. Make the harness budget visible to callers.**

When a probe times out at boot (the new failure mode), the result
should distinguish "boot didn't finish" from "probe didn't
finish." Today's `result.timedOut` doesn't differentiate. Add a
field — e.g., `result.timeoutPhase: 'boot' | 'probe' | null` —
or fold the distinction into the existing field's documentation.
Pick the cleanest API addition.

This isn't decorative: Phase 13's survey would have benefited
from knowing *why* a probe didn't return useful output.

### Section 2 — HD32 version probe (Phase 13.1 portion)

A new survey case. Boot `hd32-minix.img` with the extended
budget, run a version-flag probe against each of the seven
candidate binaries.

Per-binary probe logic:

```sh
for cmd in /usr/bin/c86 /usr/bin/cpp /usr/bin/as \
           /usr/bin/ld /usr/bin/make /usr/bin/ar \
           /usr/bin/objdump; do
  echo "=== $cmd ==="
  $cmd --version 2>&1 || $cmd -V 2>&1 || $cmd -v 2>&1 || $cmd 2>&1
  echo "=== exit $? ==="
done
echo __PROBE_DONE__
```

Notes:

- Multiple version flags tried in sequence. Different compilers
  respond to different flags; this maximises the chance of
  getting *some* useful output.
- A bare invocation (final `||`) is the last fallback — many
  Unix tools print usage on no-args, which is at least
  evidence-of-execution.
- The exit-code marker after each invocation lets the parser
  classify outcomes.

For each binary, classify the result:

- **`works`**: produced recognisable version output, any banner,
  or a usage message. Binary executes.
- **`silent`**: produced nothing under any flag, exit 0. Probably
  needs a different flag; binary executes but unhelpfully.
- **`crashed`**: produced a crash message ("segmentation fault",
  "killed", panic-shaped output) or non-zero exit code under all
  flags. Binary doesn't execute usefully.
- **`hung`**: never returned within the per-command instruction
  slice. Binary entered a wait state we can't escape.

The classifier is small (probably ~30 lines) and unit-testable
against synthetic transcripts.

### Section 3 — synthesise findings

Per-binary table in the report, plus an overall verdict:

| Binary | Classification | Notes |
|---|---|---|
| /usr/bin/c86 | works / silent / crashed / hung | exact output captured |
| /usr/bin/cpp | … | … |
| ... | ... | ... |

Overall verdict — one of:

- **In-VM compile is viable.** `c86` and at least one of
  `as`/`ld` work. Phase 14 reverts to the user's originally-stated
  in-VM dogfooding. The brief recommends `hd32-minix.img` as the
  build target and notes any gotchas (specific flags, missing
  headers, etc.) the version output revealed.

- **In-VM compile is not viable.** Critical binaries crash, hang,
  or otherwise can't run. Phase 14 takes the host-cross-compile
  path Phase 13 recommended.

- **In-VM compile is partially viable.** Some binaries work,
  others don't. Phase 14 needs a hybrid approach (e.g.,
  cross-compile assembly, link in-VM) — call this out
  specifically. Probably the messiest outcome to take action on;
  document concretely.

### Section 4 — what you are NOT building

- A hello-world compile. Even after `c86 --version` works, an
  actual compile attempt is Phase 14's first step. The bound
  here is rigid: "binary responds to a version flag" — nothing
  more.
- HD64 image surveys. The harness extension unblocks them, but
  this brief doesn't run them. If Phase 14 (or a follow-up) wants
  HD64 evidence, that's a small follow-up brief.
- Re-running the full Phase 13 survey on all five images. Just
  the HD32-MINIX version probe. The other four images' verdicts
  from Phase 13 stand.
- A "survey orchestration" framework. The version probe is one
  more `runProbe()` call with one specific script.
- Host-side toolchain bring-up. Phase 14 territory regardless of
  outcome.
- Browser-side execution of any of this. Test infrastructure
  only.
- NE2000 device work. Phase 14a once this brief settles the
  dogfooding question.

## Tests

### Unit tests

- **`tests/probe/version-probe.test.ts`** *(new, ~5-7 cases).*
  Synthetic-transcript classifier:
  - Recognise dev86-style banner → `works`.
  - Recognise `Usage:` output → `works`.
  - Recognise crash signatures → `crashed`.
  - Recognise empty output + exit 0 → `silent`.
  - Recognise truncation-without-marker → `hung` (caller-driven).
  - Multiple-binary parsing (the `=== $cmd ===` separator).

- **`tests/probe/probe-harness.test.ts`** *(extend, ~2-3 new
  cases).*
  - `bootInstructionBudget` is honoured (small budget = boot
    timeout).
  - `timeoutPhase` (or whatever shape) distinguishes boot vs
    probe timeout correctly.
  - `inferGeometry` accepts the new sizes (or accepts override
    if that's the chosen shape).

### Integration tests

- **`tests/integration/hd32-version-probe.test.ts`** *(new, 1
  case).* Boot `hd32-minix.img`, run the version probe, assert on
  the captured output's structure (e.g., "we got version output
  for at least one binary"). The test should be tolerant of
  different verdict outcomes — it asserts the *probe ran*, not
  what it found. The findings are in the report.

  Skip-with-reason if the fixture isn't available.

### Smoke tests

All Phase 1-13 tests must keep passing. The Phase 12 trivial
probe integration test still runs against the new defaults
(probably still completes well within the new boot budget).

## Watch out for

- **The boot budget extension changes the trivial probe's
  resource cost.** A 32M default budget means a probe that *would*
  hang now runs longer before timing out. The trivial probe
  shouldn't hit this — it boots a 1.44 MB MINIX floppy, well
  under any reasonable budget — but a future probe with a
  pathological boot path would. Document the trade.
- **`paint.c86` is still a false positive.** It's in `/bin/`,
  not `/usr/bin/`, and Phase 13 already flagged it. Don't include
  it in the version-probe candidate list. The seven candidates
  above are the working set.
- **Some binaries may not honour any of `--version`, `-V`, or
  `-v`.** Dev86's `cpp` historically prints to stderr on
  bare-invocation help; `as` may want different flags entirely.
  The fallback-to-bare-invocation is intentional. Don't get
  clever about format-detecting; just capture the bytes.
- **The per-binary instruction budget within the probe.** The
  harness's `timeoutInstructions` is for the *whole probe*. With
  seven binaries × multiple version flags each, the probe phase
  needs enough budget. Calculate generously; a 50M probe budget
  on top of the 32M boot budget is fine.
- **Output volume.** Seven binaries × multiple version flag
  attempts × possibly verbose banners could push past the
  default 256K output cap. Probably won't, but bump the cap for
  this specific probe if needed (`maxOutputBytes` is already
  caller-configurable).
- **Exit-code capture.** ELKS's shell may not export `$?`
  identically to bash; verify by inspecting the captured output.
  If the exit-code marker doesn't fire, fall back to
  output-presence as the classification signal.
- **`make` is not strictly a compiler** but it's in the candidate
  list because it's a critical part of any real build flow. If
  `c86` works but `make` doesn't, the in-VM compile is
  still viable for one-file builds (which is plausibly enough for
  an NE2000 driver if it's small). Document this nuance.
- **`c86`'s name suggests it might be the compiler driver, not
  the underlying compiler.** Real Dev86 has both `bcc` (the
  driver) and `cc1` (the underlying C compiler). What ELKS ships
  as `c86` is plausibly a renamed `bcc` driver. The version
  output will tell us; don't pre-judge.

## Definition of done

**Outcome A (in-VM compile viable):**
- Harness extension shipped: budget configurable, geometries
  unblocked.
- HD32 version probe ran end-to-end.
- At least `c86` plus one of `as`/`ld` classified as `works`.
- Recommendation paragraph: revert Phase 14 to the in-VM
  dogfooding shape; cite specific compiler version output as
  evidence.
- All prior tests still pass.
- Total tests ≥ 1,300.

**Outcome B (in-VM compile not viable):**
- Harness extension shipped.
- HD32 version probe ran end-to-end.
- Critical binaries classified as `crashed`/`hung`/`silent`;
  evidence concrete (exact output captured).
- Recommendation paragraph: confirm Phase 13's host-cross-compile
  path.
- All prior tests still pass.
- Total tests ≥ 1,300.

**Outcome C (in-VM compile partially viable):**
- Same as A/B but findings are mixed.
- Recommendation describes the hybrid approach concretely.
- All prior tests still pass.
- Total tests ≥ 1,300.

**Outcome D (harness extension fine, version probe blocked by
something new):**
- Harness extension shipped (the 12.1 portion is independently
  useful regardless).
- 13.1 portion is documented as deferred with the new blocker
  spelled out.
- Phase 14 still proceeds on the cross-compile path.
- Same test floor.

In all cases:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean.
- Release snapshot at `releases/phase-12-1-version-probe/`
  populated and manually launch-verified.

## Release snapshot

Layout:

```
releases/phase-12-1-version-probe/
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
        ├── hd32-fat.img
        └── hd32-minix.img
```

`node_modules/` not copied. Same fixtures as Phase 13.

Verify the snapshot is launchable manually:
- Both serial harnesses still boot to `# ` (no regression).
- Browser harness still loads.
- The version-probe integration test passes against the release's
  fixtures.

The report at `PROBE_HARNESS_EXTENSION_REPORT.md` has these
sections:

- **Summary**: outcome (A / B / C / D), key recommendation.
- **Harness extension (12.1)**: API additions; default boot
  budget + reasoning; geometry inference shape; timeout-phase
  field; back-compat with Phase 12 callers.
- **Version probe (13.1)**: per-binary table; exact output
  captured for each; classifier outputs.
- **Synthesis**: viability verdict; recommendation for Phase 14.
- **What's deferred**: per Section 4; HD64 surveys; hello-world
  compile; etc.
- **Things future briefs should address**:
  - Phase 14 — concrete shape per the verdict.
  - HD64 surveys if richer toolchains are plausible there.
  - The Phase 12.x harness extension complete; further extensions
    only as future probes need them.
- **CPU/memory bug candidates**: anything noticed during HD32
  boot under the extended budget.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`PROBE_HARNESS_REPORT.md`** — Phase 12; the harness API
   you're extending.
2. **`TOOLCHAIN_SURVEY_REPORT.md`** — Phase 13; the survey's
   Outcome C and the seven candidate binaries.
3. **`tests/probe/probe-harness.ts`** — the file to extend.
4. **`tests/integration/elks-hd-minix-boot.test.ts`** — Phase 11.5
   reference; cites the 16M boot budget that worked there.
5. **`tests/probe/surveys/survey-runner.ts`** — Phase 13 survey
   harness; template for the new version probe.
6. **`emu86-networking-plan.md`** — Phase 14 shape under each
   verdict.
7. **Dev86 docs** at https://github.com/lkundrak/dev86 — context
   on what `c86`, `as`, `ld` are and what version output to
   expect (informational; don't depend on specific banner text).

## Final notes

This brief settles a real architectural question: in-VM dogfood
vs host cross-compile. The verdict isn't the brief's choice;
it's evidence-driven, and the evidence is whatever the version
probe captures.

The discipline this brief asks for: **don't extend scope past
the version probe**. If `c86` reports a sensible version, the
agent will be tempted to "just try `c86 -c hello.c`" while in
the same boot. Resist — that's Phase 14's first step under
Outcome A, and bundling weakens both briefs. Stop at version
output.

After this lands, Phase 14's brief writes itself: either it's
"build NE2000 in-VM via c86 on hd32-minix.img" (Outcome A) or
"build NE2000 via host bcc, deploy via probe disk" (Outcome B).
The networking plan in `emu86-networking-plan.md` covers what
the device shape looks like; this brief settles where the build
happens.

If Outcome D — the harness extension lands but the version
probe hits a new infrastructure issue — that's still progress.
The harness improvements are valuable for future probes
regardless, and Phase 14 takes the cross-compile path with no
worse information than Phase 13 produced.
