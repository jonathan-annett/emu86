# emu86 — orientation for an agent picking this up

Written 2026-07-13, when the project was consolidated onto `claude-dev-box` from
three machines. Read this before `README.md`. **`README.md` is stale and will
actively mislead you** — see §1.

## 0. What this project is

A **pure-TypeScript 8086 emulator** — no WASM, no bundler magic, no runtime deps
beyond TypeScript + vitest. It boots real **ELKS** and **MINIX** images.

It exists to answer a question for a *different* project: the **huxley / lite**
browser code editor (convscan #172) needed an 8086 emulator, and the choice was
*pure-TS* vs *8086tiny-compiled-to-WASM*. emu86 is the pure-TS arm of that
evaluation — the bet being that it's fast enough, and that no-WASM is a real
fallback. Keep that in mind: this is a **means to an end**, not a general-purpose
emulator project. "Understandable first, fast second" is the stated principle.

## 1. ⚠️ The docs lie about the project's state. Trust this order.

The repo accumulated 29 `*-brief.md` / `*_REPORT.md` pairs — one per phase — and
**nothing ever went back and updated the top-level docs.** So:

| Doc | Claims | Reality |
|---|---|---|
| `README.md` | "v0. 6-opcode slice. 103 tests. No interrupts, devices, machine, UI." | **Wildly stale.** All of that exists now. |
| `SESSION_REPORT.md` | "353 tests. v0→v1 complete." | Stale — that was ~Phase 2. |
| `emu86-agent-brief.md` | "Extend from the 6-opcode v0 slice." | Stale — it's the *first* brief. |

**The truth is in the newest reports.** Current frontier, in order:

1. `PROBE_HARNESS_REPORT.md` — Phase 12: the probe harness API/structure.
2. `TOOLCHAIN_SURVEY_REPORT.md` — Phase 13: surveyed compilers on the HD32 image.
3. `PROBE_HARNESS_EXTENSION_REPORT.md` — **the latest** (commit `b0ed610`). Extended
   the harness, then used it to verify **`c86` v5.2.0 exists and runs on
   `hd32-minix.img`**.

**Where you are:** that last report settled the big architectural question —
**in-VM dogfood beats host cross-compile** ("Outcome A"). It states the next step
explicitly:

> *"Phase 14's first concrete step is now well-defined: a hello-world compile
> against the verified `c86 v5.2.0` on `hd32-minix.img`."*

**Phase 14 = build an NE2000 network driver, in-VM, using the on-disk `c86`/`as`/`ld`.**
Start there unless Jonathan says otherwise.

## 2. Test baseline — read this before you think you broke something

```
npm install
npm run build     # tsc --noEmit (typecheck)
npx vitest run    # → 998 passed, 80 files, 1 skipped
```

**998 passing is correct and green on this box.** But **the briefs say "1,294
passing as of Phase 13"** — that is *not* a regression you introduced. The gap is
`tests/sst/corpus.test.ts`, which is **skipped** here: it needs the
[SingleStepTests/8088](https://github.com/SingleStepTests/8088) corpus, and
`tests/sst/loader.ts` expects the corpus's `v2/` directory symlinked at
`tests/sst/data/`. It isn't fetched on this machine. Fetch it if you're touching
CPU/opcode semantics — **the SST corpus is the real correctness oracle** — otherwise
leave it and know that 998 is your baseline.

Disk images are likewise not all present (only `dist-web/elks-serial.img` is
committed). `hd32-minix.img` and friends are built/fetched on demand:
`npm run build:elks-hd-image`, `build:elks-serial-image`, `build:elks-hd-mbr-images`.
Phase 14 needs the HD32 MINIX image.

## 3. The fractured origin — the thing you must not get wrong

**There are TWO emu86 lineages. This repo is only one of them.**

| | **This repo** (canonical) | **huxley / lite** `packages/emu86` |
|---|---|---|
| Where | `~/Projects/emu86` → `github.com/jonathan-annett/emu86` (private) | `whisperx-server:~/projects/lite` → `github.com/jonathan-annett/huxley` (public) |
| Life | Apr 27–29, fresh repo | Mar 23 – Apr 22 (the **origin**) |
| Shape | 66 src files: `cpu8086/ memory/ devices/ disk/ interrupts/ machine/ bios/ browser/ …` + `web/` + vite | 23 src files: `src/{emulator,hosts}` |
| **Has** | the TS emulator, probe harness, ELKS/MINIX boot | 🔑 **the C co-simulation harness**: `harness/*.c` (`control.c`, `overrides.c`, `patch-reference.js`), `bios/`, `elks-driver/`, `Makefile` |

The standalone repo was started fresh on Apr 27 and **did not carry over the C
co-simulation harness.** That harness is how emu86 was validated *bit-for-bit
against the C 8086tiny reference*, and **it exists only in the huxley repo.**

**So:**
- If you need to co-simulate against the 8086tiny reference — **do not rebuild it.**
  It's in huxley. Ask Jonathan to bring it over. (`reference/8086tiny` is a submodule
  here, so the *reference source* is present; the *harness that drives it* is not.)
- **Do NOT merge the two lines on your own initiative.** Jonathan's triage note says
  emu86 must eventually merge back into `lite/packages/emu86` for the editor
  integration — that's a **pending decision, not a task.** He explicitly chose
  (2026-07-13) to bring only the standalone repo to this box for now.

## 4. How work happens here (the brief/report loop)

This project is **brief-driven**, and the briefs are **not written by the coding
agent**:

1. A **planning chat on claude.ai** (Fable) reviews the last report and writes the
   next brief — e.g. convscan chat #94 *"Phase 7 completion and next brief proposal"*.
2. The brief lands in the repo as `emu86-<topic>-brief.md`.
3. An agent (**you**) executes it in the repo.
4. You write `<TOPIC>_REPORT.md` — findings, decisions, what you verified, what you
   deliberately did *not* do.

**Follow this.** The reports are the project's actual memory; the code alone doesn't
carry the reasoning. Match the existing reports' depth and honesty (they record
negative results and abandoned approaches — that's a feature).

⚠️ **`emu86-networking-plan.md` is cited by the Phase 13/13.5 briefs as the Phase 14
device-shape context — and it is NOT in this repo.** It was never committed, and it
isn't on any host. It was authored in a planning chat. **Don't hunt for it in the
code and don't assume it's lost work** — ask Jonathan, or recover it from the chats
(convscan #94 / #82 discuss the NE2000 phase). Phase 14's *first step* is well
defined without it.

## 5. Hard rules (constant across every brief — treat as locked)

1. **`cpu.step()` stays pure synchronous.** No awaits, no promises. Memory access is
   sync and infallible — `PagedMemory` never faults.
2. **No new dependencies.** TypeScript + vitest only. If you reach for something
   else, stop and ask.
3. **No architectural changes.** If the existing structure makes something hard,
   that's a *finding to surface in your report*, not a licence to refactor.
4. **Strict TypeScript stays strict.** No `any`, no `as unknown as` to silence the
   compiler. `noUncheckedIndexedAccess` is intentional — work with it.
5. **No custom CPU opcodes.** Locked.
6. **Don't break green tests.** Run the suite after every meaningful change.

## 6. Repo gotchas that will waste your time

- **Commit your work.** In this repo's entire history, **no agent has ever run
  `git commit` or `git push`** — all 7 commits are hand-authored by Jonathan. That
  cost real time during consolidation (nobody could tell from the transcripts whether
  the phone's work was safe). Don't repeat it: commit, and say so.
- **`.gitmodules` lists a top-level `elks` submodule that is not in the index.**
  Only `reference/8086tiny` and `reference/elks` are real. Leftover from the "fixed
  submodules" commit. Don't chase it.
- **Build outputs are committed**: `dist-cli` (83 files), `dist-cli-src-tmp` (66),
  `dist-web` (7), `releases` (**1,219 files**). They're tracked. Regenerate them with
  the npm scripts; don't hand-edit.
- Root is littered with `corpus-baseline*.txt`, `diag-out*.txt` — scratch artifacts
  from old phases, not inputs.
- Remote is `github.com/jonathan-annett/emu86` (**private**), branch `main`, currently
  at `b0ed610`.

## 7. How to work in this repo

**The reports are the project's memory.** The code alone doesn't carry the
reasoning — 29 `*_REPORT.md` files do, including the negative results and the
approaches that were tried and abandoned. Read them before concluding something
is undone; write one when you finish a phase. If you learn something that would
have saved you an hour, it belongs in a report, not just in your answer.

**Delegate breadth.** This repo is wide (66 source files, 29 reports, two
submodules, a web harness, an ELKS/MINIX toolchain). When a task fans out across
independent areas — read many reports, check many subsystems, verify many claims
— spawn subagents in parallel rather than walking it serially. Intervene if one
goes off track or is missing context.

**Commit what you do.** No agent has ever committed here (§6) and it cost real
time. Commit, and say so.

**Your final message is not a continuation of your working thread.** After a long
session the shorthand you built up — phase numbers, file abbreviations, arrow
chains — means nothing to a reader who wasn't watching. Write the summary for
someone picking this up cold: outcome first, then what you need from them, in
complete sentences with the terms spelled out.

## 8. If you were asked to audit or assess (not change) the code

The deliverable is **your assessment**. Report findings and stop. Do not apply
fixes, refactor, tidy, or "improve while you're in there" until you're asked — a
question about the code is not a request to change it.

**Ground every claim in evidence from this session.** Before reporting a finding
or a status, point to the tool result that supports it — a file you actually
read, a command you actually ran, a test that actually passed. If something is
inferred but unverified, say so explicitly. Report outcomes faithfully: if tests
fail, say so with the output; if you skipped a step, say that. An audit whose
findings are plausible but unchecked is worse than no audit, because it gets
believed.

Note the docs in this repo are **stale and will contradict the code** (§1) — when
they disagree, the code and the newest reports win, and the contradiction itself
is a finding worth reporting.

## 9. Provenance

Consolidated 2026-07-13 from three machines (fold7 phone = canonical, buenos-rent
VPS, whisperx-server). The phone and VPS checkouts were verified identical to
`origin/main` and deleted. Nothing was lost. Facts in this file were read off the
repo and the reports, not remembered.
