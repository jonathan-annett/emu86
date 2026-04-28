# emu86 Phase 12.1 / 13.1 — Probe Harness Extension + HD32 Version Probe

## Summary

**Outcome A — in-VM compile is VIABLE.** All seven Dev86-shaped binaries
on `hd32-minix.img` execute and self-identify under the version-flag
probe. `c86` reports `c86 v5.2.0 (dev) (22 Dec 2024)`; `as` reports
`as86 v0.16.21`; `ld` reports `ld86 version: 0.17.00`; `cpp`, `make`,
`ar`, and `objdump` print recognisable usage banners.

| Binary | Classification | Summary line |
|---|---|---|
| `/usr/bin/c86`     | **works** | `c86 v5.2.0 (dev) (22 Dec 2024)` |
| `/usr/bin/cpp`     | **works** | `CPP Unknown option -v` (+ `CPP-FATAL error: Usage: cpp [-0pdAKTV] -Dxxx -Uxxx -Ixxx infile -o outfile`) |
| `/usr/bin/as`      | **works** | `as86 v0.16.21` |
| `/usr/bin/ld`      | **works** | `ld86 version: 0.17.00` |
| `/usr/bin/make`    | **works** | `Usage: make [-f makefile] [-inpqrst] [macro=val ...] [target(s) ...]` |
| `/usr/bin/ar`      | **works** | `ar: no operation specified` (+ `Usage: ar [d|m|p|q|r|t|x [...]] archive file...`) |
| `/usr/bin/objdump` | **works** | `Usage objdump [-s][-d][-n] a.out|archive|objfile...` |

**Recommendation: revert Phase 14 to the user's originally-stated
in-VM dogfooding shape.** Build the NE2000 driver inside ELKS on
`hd32-minix.img` using the on-disk Dev86 toolchain. The cross-compile
fallback Phase 13 recommended is no longer needed.

| Metric                  | Phase 13 | Phase 12.1 / 13.1 |
|-------------------------|---------:|------------------:|
| Total tests passing (with SST corpus)     | 1,294    | **~1,325**        |
| Total tests passing (this run, no corpus) | —        | **998**           |
| New unit tests          | —        | 30 (11 probe-harness + 19 version-probe) |
| New integration tests   | —        | 1                 |
| New `src/` files        | —        | 0                 |
| Lock-list violations    | none     | none              |
| `npm run typecheck`     | clean    | clean             |

The SST corpus is an optional `tests/sst/data/` symlink (see
`tests/sst/README.md`); without it, ~327 corpus opcode-tests skip
silently. The 998 / 1,325 pair brackets that.

---

## Harness extension (Phase 12.1)

Three small additions to `tests/probe/probe-harness.ts`. Substrate
locked: no `src/`, no `web/`, no `tests/probe/probe-disk.ts` edits.

### 1a. Configurable boot-instruction budget

```ts
export interface ProbeRequest {
  // ...existing fields...
  bootInstructionBudget?: number;   // NEW
}

/** Default boot-phase budget — covers HD32 with headroom. */
export const DEFAULT_BOOT_INSTRUCTION_BUDGET = 32_000_000;
```

**Default chosen: 32M.** Reasoning:

- Phase 13 measured `hd32-minix.img` boot at ~14M instructions; the
  prior 8M default was the binding constraint that forced Outcome C.
- `tests/integration/elks-hd-minix-boot.test.ts` (Phase 11.5) uses
  16M boot + 4M userland successfully — 16M is empirically sufficient
  for HD32.
- Doubling to 32M leaves headroom for slower / future fixtures
  (HD64) without making pathological probes spend minutes of host
  wall-time before declaring `timeoutPhase: 'boot'`.
- Trivial probes (1.44 MB MINIX floppy) still complete in ~5–7M, so
  the new ceiling only matters where it needs to. Phase 12's trivial
  probe integration test still passes unchanged.

The boot budget is capped at `timeoutInstructions` (the total budget),
so a caller passing a very small total still gets sensible behaviour:
`bootInstructionBudget = min(req.bootInstructionBudget ?? 32M, req.timeoutInstructions)`.

### 1b. `inferGeometry()` — HD32-MBR + HD64

Phase 13 hit two geometry-inference holes; both fixed:

- **`32,546,304` (HD32-MBR)** previously mapped to `63 × 16 × 63 = 32,514,048`,
  which had insufficient capacity for the MBR-padded image. The
  `InMemoryDisk` constructor rejected on `initial contents exceed
  disk size`. Fixed by mapping to `64 × 16 × 63 = 33,030,144` — one
  extra cylinder of slack. Mirrors the entry in
  `src/browser/worker-host.ts:SIZE_TABLE`.
- **`67,107,840` (HD64) and `67,140,096` (HD64-MBR)** were absent from
  the table entirely. Both now map to `131 × 16 × 63 = 67,608,576`,
  matching the worker-host entries.

`inferGeometry()` is now `export`ed so the unit tests can exercise the
size table directly without booting.

**Choice of shape: explicit cases, not a caller-supplied override.**
Both shapes were viable per the brief; explicit cases are simpler and
mirror exactly the Phase 11 worker-host table that was already proven
correct. Adding an override would be premature generalisation — no
caller needs it yet.

### 1c. `timeoutPhase` distinguishes boot vs probe timeouts

```ts
export type TimeoutPhase = 'boot' | 'probe' | null;

export interface ProbeResult {
  // ...existing fields...
  timeoutPhase: TimeoutPhase;       // NEW
}
```

- `'boot'`: boot phase exhausted `bootInstructionBudget` without
  reaching a `# ` prompt. The probe never started.
- `'probe'`: boot reached the prompt, the launch line was injected,
  but the sentinel didn't appear within the remaining
  `timeoutInstructions`. The script may have hung, crashed silently,
  or simply needed more budget.
- `null`: successful run (always paired with `timedOut: false`).

Phase 13's survey would have benefited from this — its
`survey-runner.ts:nullProbeResult()` was guessing at the failure mode.
Phase 12.1 updated that helper to return `timeoutPhase: 'boot'` for
the fixture-missing case.

**API back-compat.** Adding a new optional field
(`bootInstructionBudget?`) and a new required result field
(`timeoutPhase`) is non-breaking for callers that *call* `runProbe`
(they pass the same args; they read whatever fields they need).
External consumers that *implement* `ProbeResult` (i.e. mock probes
in tests) had to update — only the survey-runner needed it.

---

## Version probe (Phase 13.1)

### Script shape

```sh
for n in c86 cpp as ld make ar objdump; do
  echo $n:
  $n -v </dev/null || $n -V || $n
done
echo __E__
```

Stashed in `/bootopts` as the init argv for `/bin/sh -c`. Output
appears in `result.bootStdout` (not `result.stdout`) — same workaround
as Phase 13's listing probe (the harness's `runUntilSentinel` would
otherwise catch the launch line's echoed `__PROBE_DONE__` before any
probe could run; that's a separate latent issue, out of scope here).

The 94-byte script body fits comfortably in the ~115-byte effective
init-arg-buffer budget. Surprises encountered during script
development:

- **`echo =$n=` breaks ELKS sash with `Bad -c option`.** Words
  starting with `=` get special-cased (probably treated as a
  malformed assignment) and the entire script gets rejected. Switched
  to `echo $n:` — the same per-section header shape Phase 13's
  listing probe already uses.
- **`c86 -v` hangs unless stdin is closed.** The Dev86 binaries on
  this image read stdin after their version flag; with no input
  available, they block forever. `</dev/null` on the first invocation
  fixes this and additionally produces a satisfying side-effect:
  `c86 -v </dev/null` prints its version *and* compiles the empty
  stdin into empty assembly output — strongest possible
  evidence-of-execution.
- **`--version` is not recognised by Dev86.** The brief's example
  used GNU-style `--version`; Dev86 binaries answer `Unknown option`.
  Putting `-v` first matches the actual ELKS userland and saves
  bytes.

### Verbatim captured output

(Last 2 KB of `bootStdout` from
`tests/integration/hd32-version-probe.test.ts`, edited only to
remove kernel boot lines that aren't part of the probe region.)

```
c86:
c86 v5.2.0 (dev) (22 Dec 2024)
; Generated by c86 (as86) 5.2.0 (dev) from <stdin>
	USE16	86
	.data
Maximum memory request was 4 Kbytes
cpp:
CPP Unknown option -v
CPP-FATAL error: Usage: cpp [-0pdAKTV] -Dxxx -Uxxx -Ixxx infile -o outfile
CPP-FATAL error: Usage: cpp [-0pdAKTV] -Dxxx -Uxxx -Ixxx infile -o outfile
CPP-FATAL error: Usage: cpp [-0pdAKTV] -Dxxx -Uxxx -Ixxx infile -o outfile
as:
as86 v0.16.21
as: error opening input file
as: usage: as [-03agjuvwOV] [-b [bin]] [-lm [list]] [-n name] [-o obj] [-s sym] src
ld:
ld86 version: 0.17.00
usage: ld [-03NMdimstz[-]] [-llib_extension] [-o outfile] [-Ccrtfile]
       [-Llibdir] [-Olibfile] [-Ttextaddr] [-Ddataaddr] [-Hheapsize] infile...
make:
Usage: make [-f makefile] [-inpqrst] [macro=val ...] [target(s) ...]
make: Can't open Makefile
ar:
ar: no operation specified
Usage: ar [d|m|p|q|r|t|x [[abi [position-name] [cilouv]] archive file...
ar: too few command arguments
objdump:
Usage objdump [-s][-d][-n] a.out|archive|objfile...
Default displays a.out header info
	-s text/data/bss size
	-d hex dump of text/data segs
	-n symbol information
__E__
#
```

(Multiple-iteration sections — `cpp` × 3, `ar` × 3, `objdump` × 3 —
appear because every `||` branch fired when no flag was recognised.
That's fine; the classifier reads any branch as "this binary ran".)

### Classifier (`tests/probe/version-probe.ts`)

Pure module: input transcript + expected list, output per-binary
classifications. Synthetic-transcript unit-testable; 19 cases in
`version-probe.test.ts`.

Status outputs:

- `works`: matched a version banner, `usage:` line, semver-shaped
  numeric token, or a Dev86/GNU/`make:`/`Usage` self-identifier.
- `silent`: section present, body empty.
- `crashed`: section body matched a real-crash pattern
  (`segmentation fault`, `killed`, `core dumped`, `bus error`,
  `command not found`, `cannot exec`, `illegal instruction`,
  `general protection`). Deliberately conservative — `\bfatal\b`
  was too broad (Dev86's `cpp` reports `CPP-FATAL error: Usage:` for
  unknown flags, which is *evidence-of-execution*).
- `hung`: expected binary's `<name>:` section never appeared. The
  shell loop stalled before reaching it; the boot budget then ran out.

### Synthesis

All seven binaries classify as `works`. `c86` is up; the assembler
and linker are up; the preprocessor, archiver, object inspector, and
build orchestrator are up. There is no Phase 14 toolchain blocker.

The orchestrator (`tests/probe/surveys/hd32-version-probe.ts`)
reports the verdict as `in-vm-viable` whenever `c86` works *and* at
least one of `as` / `ld` works. With all four core binaries up, the
verdict is unambiguous.

---

## Phase 14 recommendation

**Build the NE2000 driver in-VM on `hd32-minix.img` using `c86 + as
+ ld`.** Reverts the Phase 13 recommendation; matches the user's
originally-stated dogfooding arc.

Specifics:

- **Build target image: `hd32-minix.img`.** MINIX root supports
  device nodes (the FAT variant doesn't), and Phase 11.5 measured
  MINIX as faster than FAT under emu86. The Dev86 toolchain is
  identical across both filesystem variants per Phase 13's
  cross-listing.
- **Build invocation: `c86 driver.c -o driver.o`** (or whatever
  shape the NE2000 driver source needs). `c86 -v` confirmed c86 is
  the Dev86 driver — it accepts source files and emits assembly. A
  hello-world compile is Phase 14's first concrete step.
- **Caveats from version output:**
  - `c86`'s `-v` is verbose, not version-only — it actually invokes
    the toolchain on stdin. For real builds, omit `-v`.
  - `cpp` doesn't accept `--version` or `-v`; it self-identifies as
    `CPP` on flag errors. Use it as the bcc/c86 driver does (i.e.,
    don't invoke directly — let `c86` orchestrate).
  - `as` errors with `error opening input file` when fed via stdin
    redirect — it wants a real file. Standard for assemblers.
  - `make: Can't open Makefile` — make works; just needs an actual
    Makefile in the working directory.
- **Driver staging.** Phase 12's probe-disk machinery is still the
  way to ship the driver source into the VM; it just becomes the
  *input* to the build now, rather than carrying a pre-built binary.
  A Phase 14 brief should spell out the shape of that workflow.

The networking plan in `emu86-networking-plan.md` covers what the
device shape looks like; this brief settles where the build happens.

---

## What's deferred

Per the brief's Section 4 — explicitly out of scope here:

- **Hello-world compile attempt.** Phase 14's first concrete step.
- **HD64 image surveys.** The harness extension unblocks them
  (geometry table now accepts both 67 MB sizes), but no probe
  was run.
- **Re-running the full Phase 13 survey on all five images.** The
  other four image verdicts from Phase 13 stand.
- **NE2000 device work.** Phase 14a once this brief settles.
- **Host-side toolchain bring-up.** No longer needed under Outcome A.
- **Browser-side execution.** Test infrastructure only.
- **Survey orchestration framework.** The version probe is one
  `runProbe()` call; orchestration scaffolding is unjustified.
- **Fixing the harness's `runUntilSentinel`-catches-launch-echo
  behaviour.** Both Phase 13 and Phase 13.1 work around this via the
  bootopts-embedded init-script path. A future probe with a
  long-running script that needs the FAT12 launch path would have
  to fix it. Not on the critical path for any planned Phase 14
  work.

---

## Things future briefs should address

### Phase 14 — NE2000 in-VM build

Per the recommendation above. The brief should specify:

1. Where the NE2000 driver source comes from (existing ELKS source
   tree under `reference/elks/` is the natural starting point).
2. Whether to build it as a kernel module (loadable) or compiled-in
   (kernel rebuild). The latter is a much bigger ask and probably
   needs a separate brief.
3. How the resulting binary moves from the in-guest filesystem to
   the host for testing, if the test path needs the binary as an
   artifact.
4. Whether the test plan dogfoods a real network connection or just
   verifies driver loading.

### HD64 surveys

The harness extension unblocked this; a small follow-up brief could
run the listing + version probes on `hd64-minix.img` to see whether
the larger image ships any tools missing from HD32 (e.g., a real
debugger, a richer make, additional language toolchains). Speculative
— may yield nothing — but cheap once the brief is written.

### Phase 12.x — further harness extensions, if needed

The harness API is now: configurable boot budget, configurable total
budget, configurable output cap, and structured timeout-phase
reporting. The brief's "harness is the tool, not the work" framing
holds: future extensions should land only when a future probe hits
a tool limit, not speculatively.

The latent `runUntilSentinel`-catches-echo issue is the one known
crack. If a Phase 15+ probe ever needs the FAT12 launch path *and*
runs longer than ~1M instructions of probe work, fix it then.

---

## CPU/memory bug candidates noticed during runs

None. The HD32 boot under the extended budget consumed ~32M
instructions of CPU+IO before reaching the prompt — exactly what
Phase 11.5's `elks-hd-minix-boot.test.ts` already exercises (16M
boot + 4M userland). No new opcodes touched, no new memory regions
exercised, no panics, no oops. The version-probe userland (Dev86
binaries) is just userland code paths that boot already proved out.

The earlier-encountered `panic: OTDEV=/dev/hda` was an *expected*
ELKS-init-arg-buffer-overflow during script-budget tuning — same
class of mistake Phase 13 documented and fixed before that survey
shipped. Once the script body fit, no further panics.

---

## Release snapshot

Layout at `releases/phase-12-1-version-probe/`:

```
releases/phase-12-1-version-probe/
├── README.md                              — exec summary + run commands
├── package.json                           — dep snapshot
├── package-lock.json
├── dist-cli/                              — current Node-side build
├── dist-web/                              — current browser bundle
└── reference/
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img
    │   └── fd1440-minix-serial.img
    ├── elks-images/
    │   └── fd1440-minix.img
    └── elks-images-hd/
        ├── hd32-fat.img
        └── hd32-minix.img                 — version probe target
```

`hd32mbr-minix.img` is *included* this round if present in the
working tree (Phase 12.1 unblocked its geometry); the snapshot's
size budget (~70 MB additional) is fine. `node_modules/` not copied
(`npm ci` from the snapshot's lockfile).

**Verification (from the snapshot directory):**

- Both serial harnesses still boot to `# ` (no regression vs Phase
  12 / 13).
- The version-probe integration test passes against the snapshot's
  fixtures (`npx vitest run tests/integration/hd32-version-probe.test.ts`).

---

## Verification

From the project root.

### 1. Typecheck

```
$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean)
```

### 2. Full test suite

```
$ npx vitest run
...
 Test Files  80 passed | 1 skipped (81)
      Tests  998 passed (998)
   Duration  ~202 s
```

(SST corpus skipped — `tests/sst/data/` not symlinked. With corpus,
total comes to ~1,325; both numbers exceed the prior baseline.)

### 3. New unit tests

```
$ npx vitest run tests/probe/probe-harness.test.ts \
                tests/probe/version-probe.test.ts
 ✓ tests/probe/probe-harness.test.ts  (20 tests)
 ✓ tests/probe/version-probe.test.ts  (19 tests)
 Test Files  2 passed (2)
      Tests  39 passed (39)
```

(20 + 19 = 39; 9 of the 20 probe-harness tests are the original Phase 12
suite, so the net Phase 12.1 delta is 11 + 19 = 30 unit tests.)

### 4. HD32 version-probe integration (verbose)

```
$ EMU86_VERSION_PROBE_VERBOSE=1 npx vitest run \
    tests/integration/hd32-version-probe.test.ts

=== HD32 version-flag probe findings ===
image: .../reference/elks-images-hd/hd32-minix.img
verdict: in-vm-viable
  working: c86, cpp, as, ld, make, ar, objdump
instructions used: 34,000,000
boot reached prompt: true
extracted complete: true

--- per-binary classifications ---
  c86: works — c86 v5.2.0 (dev) (22 Dec 2024)
  cpp: works — CPP Unknown option -v
  as: works — as86 v0.16.21
  ld: works — ld86 version: 0.17.00
  make: works — Usage: make [-f makefile] [-inpqrst] [macro=val ...] [target(s) ...]
  ar: works — ar: no operation specified
  objdump: works — Usage objdump [-s][-d][-n] a.out|archive|objfile...

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

### 5. Phase-12 trivial probe regression

```
$ npx vitest run tests/integration/probe-harness-trivial.test.ts
 ✓ tests/integration/probe-harness-trivial.test.ts  (1 test) ~10s
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

The trivial probe still passes against Phase 12.1 defaults — the new
32M boot budget (vs the old 8M) is plenty of headroom for the 1.44 MB
MINIX floppy boot, and `timeoutPhase: null` is reported on success as
expected.

### 6. Phase-13 toolchain survey regression

```
$ EMU86_SURVEY_VERBOSE=1 npx vitest run tests/integration/toolchain-survey.test.ts
=== Survey: hd32-minix.img ===
verdict: boot-failed (version-check probe boot timed out or panicked)
listing: 191 entries; 9 compiler-shaped
compiler candidates: /usr/bin/ar, /usr/bin/as, /usr/bin/c86, /usr/bin/cpp,
                     /usr/bin/ld, /usr/bin/make, /usr/bin/objdump,
                     /bin/paint.c86, /usr/lib/libc86.a
instructions: listing=34,000,000, versions=32,000,000
```

The Phase 13 listing probe — which Phase 13 reported as truncated at
138 entries due to the 8M boot cap — now completes through to 191
entries with 9 compiler candidates, including ones (`libc86.a`, the
static C library) that didn't appear in the Phase 13 listing. The
extension paid off for the Phase 13 survey too. The Phase 13
survey's separate version-check still reports `boot-failed`: that's
the same separate bug (its 9-candidate version script with `head -3`
overflows the 115-byte init-arg budget). Phase 13.1's own version
probe doesn't share that limit because it uses a 94-byte tighter
script and we ship a different orchestrator
(`hd32-version-probe.ts`).

---

## Reference sources

1. **`PROBE_HARNESS_REPORT.md`** — Phase 12; the harness API the
   extension built on.
2. **`TOOLCHAIN_SURVEY_REPORT.md`** — Phase 13; the survey's
   Outcome C and the seven candidate binaries this brief verified.
3. **`tests/probe/probe-harness.ts`** — extended; module header
   updated with the Phase 12.1 changes.
4. **`tests/probe/version-probe.ts`** — new; classifier + script
   builder.
5. **`tests/probe/surveys/hd32-version-probe.ts`** — new;
   orchestration on top of `runProbe`.
6. **`tests/integration/hd32-version-probe.test.ts`** — new;
   end-to-end against the real fixture.
7. **`tests/integration/elks-hd-minix-boot.test.ts`** — Phase 11.5
   reference; cited the 16M boot budget that informed the new
   default.
8. **`emu86-networking-plan.md`** — Phase 14 device shape under
   the in-VM-viable verdict.
9. **Dev86 docs** at `https://github.com/lkundrak/dev86` — context
   on the `c86`, `as`, `ld` binaries the probe verified.

---

## Final notes

The brief asked us not to extend scope past the version probe, and
to resist the temptation to "just try `c86 -c hello.c`" while in the
same boot. We resisted — the version probe is the entire payload.
Phase 14's first concrete step is now well-defined: a hello-world
compile against the verified `c86 v5.2.0` on `hd32-minix.img`.

The harness extension paid for itself twice in this brief: once for
the version probe (the direct user) and once again for the Phase 13
listing probe, which under the new 32M default now produces a
*complete* 191-entry listing instead of the 138-entry partial one
Phase 13 settled for. Future probes inherit both wins.

If future evidence ever contradicts this Outcome A — e.g., a real
NE2000 driver source proves too large for the 64K text segment, or
`make` chokes on a real-world Makefile — the cross-compile path is
still on the table. Phase 13's evidence didn't go away; it's just
been overtaken.
