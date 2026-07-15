# emu86 — orientation for an agent picking this up

Written 2026-07-13, when the project was consolidated onto `claude-dev-box` from
three machines; **updated 2026-07-14** after Phase 14 landed (facts below
re-verified then — §§1, 2, 4, 6 changed). Read this before `README.md`.
**`README.md` is stale and will actively mislead you** — see §1.

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

**The truth is in the newest reports.** Current frontier (2026-07-14):

1. `emu86-phase14-brief.md` — **the living plan**: every Phase-14 scope
   addendum, plus the recorded back-burner ideas (golden boot overlays,
   shared IDB "NAS", Web Serial to real gadgets) and the pacing diagnosis.
2. Newest reports, newest first: `BOOT_SCRIPTS_REPORT.md`,
   `DNS_DOH_REPORT.md`, `TAN_REPORT.md`, then the rest of Phase 14
   (`ARP_ICMP`, `NE2K_SWITCH`, `AGENT_BRIDGE`, `BROWSER_HD_SESSION`,
   `ARTIFACT_EXTRACTION`, `HELLO_WORLD_COMPILE`).
3. `EMU86_AUDIT_REPORT.md` — 2026-07-13 ground truth for the whole repo.

**Where you are (updated 2026-07-15):** Phases 14–16 are DONE and
field-accepted — pacing, HTTP gateway, virtual drives, the .tabs
namespace, per-tab drive forks, host-side minix-fs read/write, the
/dev/hdb editor panel. **Stable (8086-tab.net) was PROMOTED
2026-07-15** to the fork-aware line; the outgoing version is archived
at /9728bb6-dirty/ per `RELEASE_PROCEDURE.md` (read it before any
promotion; settings are key-versioned per semantic era —
`SETTINGS_VERSIONING_REPORT.md`). Deploys: `npm run deploy:dev` (test
tier), `npm run deploy:prod` (stable); needs `~/cf-token.env`; the
FULL suite gates every deploy. **PHASE 17 IS DONE AND FIELD-ACCEPTED (2026-07-15)** — boot-disk COW
overlay (M1), fold + SHA-256 identity + lifecycle (M2), the un-typed
boot (M3: autologin user1, per-boot stamps, the native hello-human
show), and the M4 field loop (setuid passwd/login, stamped /bin/ping,
replay-proof show — `PHASE17_M4_REPORT.md` is the closing record; the
brief's §4.7 Addendum B carries the settled M3 design). The dev tier
carries the full line; **stable promotion is Jonathan's call** per
RELEASE_PROCEDURE.md. Next-phase candidates (his call): EMBEDDING.md
handover doc, §3.5 state capture, boot-script retirement. The old
list below stands as history.

## 2. Test baseline — read this before you think you broke something

```
npm install
npm run build      # tsc --noEmit (typecheck; `npm run typecheck` covers all configs)
npx vitest run     # → 1,339 passed, 2 skipped (as of 2026-07-15, Phase 17 complete; skips = SST corpus + the env-gated ping-binary generator)
```

The one **skipped** file is `tests/sst/corpus.test.ts`: it needs the
[SingleStepTests/8088](https://github.com/SingleStepTests/8088) corpus, and
`tests/sst/loader.ts` expects the corpus's `v2/` directory symlinked at
`tests/sst/data/`. It isn't fetched on this machine. Fetch it if you're touching
CPU/opcode semantics — **the SST corpus is the real correctness oracle** — otherwise
leave it and know that the full-suite count above is your baseline. (Old briefs
cite "1,294 passing as of Phase 13" — that number included the corpus; not a
regression.)

Disk images ARE committed in-tree (correction 2026-07-14; the audit confirmed
it): `reference/elks-images-hd/hd32-*.img` (all four) and
`dist-web/elks-serial.img`. The `build:elks-*` npm scripts regenerate/refetch
them if ever needed.

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

**Process update (2026-07-13): planning moved into the working session.** The
original loop — a separate planning chat on claude.ai writes the brief, a repo
agent executes it — is history. Now the agent drafts the brief (or a scope
addendum to the running phase brief) **in-session**, Jonathan reviews it there
(his terse approvals are real approvals), and then the agent implements. What is
UNCHANGED and load-bearing:

1. Scope lands in a brief/addendum **before** implementation.
2. You write `<TOPIC>_REPORT.md` when the work lands — findings, decisions, what
   you verified, what you deliberately did *not* do.

**Follow this.** The reports are the project's actual memory; the code alone doesn't
carry the reasoning. Match the existing reports' depth and honesty (they record
negative results and abandoned approaches — that's a feature).

(Historical note, resolved: `emu86-networking-plan.md` was once planning-chat-only
and this file warned it was unrecoverable from the repo. Jonathan recovered it on
2026-07-13; it is committed at the repo root and the Phase 14 M3 milestones were
built against it.)

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
6. **Don't break green tests.** Test cadence (Jonathan's ruling,
   2026-07-15): the FULL suite gates every deploy, no exceptions;
   between deploys use judgment — targeted tests + typecheck while
   developing, full run for shared-surface changes (worker, protocol,
   net, web mains) and milestone-closing commits whose reports quote
   the baseline; a leaf module + its own tests doesn't need the whole
   ~15 min ritual.

## 6. Repo gotchas that will waste your time

- **Commit your work.** (Updated 2026-07-14: agents DO commit now — routinely,
  per feature/milestone, with the brief/report discipline; ~30 of the 37 commits
  are agent-authored. `git push` remains Jonathan's.) The original warning stands
  as history: for the repo's first 7 commits no agent ever committed, and it cost
  real time during consolidation. Commit, and say so.
- **`.gitmodules` lists a top-level `elks` submodule that is not in the index.**
  Only `reference/8086tiny` and `reference/elks` are real. Leftover from the "fixed
  submodules" commit. Don't chase it.
- **Build outputs are committed**: `dist-cli` (83 files), `dist-cli-src-tmp` (66),
  `dist-web` (7), `releases` (**1,219 files**). They're tracked. Regenerate them with
  the npm scripts; don't hand-edit.
- Root is littered with `corpus-baseline*.txt`, `diag-out*.txt` — scratch artifacts
  from old phases, not inputs.
- Remote is `github.com/jonathan-annett/emu86` (**private**), branch `main`.
  Deployment is two-tier and NOT git-triggered (see `wrangler.jsonc`):
  `npm run deploy:dev` → emu86-dev.jonathan-max-annett.workers.dev (testing);
  `npm run deploy:prod` → https://8086-tab.net (stable — promote only after
  the dev tier is field-verified). Deploys are permission-gated for agents;
  Jonathan runs them.

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

**Commit what you do.** Per feature or milestone, with a message that carries the
why (§6 has the history of what NOT committing cost). Push stays with Jonathan.

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

Updated 2026-07-14 (the session that closed out Phase 14): §1 frontier, §2
baseline (1,101 tests; images in-tree), §4 process (planning in-session;
networking plan recovered), §6 (agents commit; deployment shape). Facts
re-verified against the repo at update time, same standard.
