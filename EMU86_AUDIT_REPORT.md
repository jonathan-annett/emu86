# emu86 Repository Audit Report

**Date:** 2026-07-13
**Commit audited:** `b0ed610` ("harness extension"), branch `main`, in sync with `origin/main`
**Tree state at audit start and end:** clean except one untracked file, `CLAUDE.md` (this audit modified nothing; `git status` verified before and after)
**Brief:** verbal, from Jonathan — full read-only audit after ~10 weeks away. "Assume nothing. What is actually true about this repository — not what the docs claim, not what I remember, and not what the last report asserts."

**Method.** Six parallel read-only auditors, each with a slice: (1) the full brief/report corpus (all 58 documents read in full), (2) source-code capability (`src/`, `tools/`, `tests/`), (3) live verification — typecheck and full test suite actually run, (4) top-level docs vs reality, (5) committed build outputs and the web harness, (6) the Phase 12/13 frontier and Phase 14 readiness. Every claim below traces to a file read or a command run **this session**; where something is inferred rather than observed it is marked **[INFERRED]**. Deviations from strict read-only: `npx vitest run` (full suite) and one deliberate re-run of the version-probe integration test — both write only to gitignored caches; nothing tracked was touched.

---

## 1. Headline verdict

**The frontier is real, and it was reproduced live on this machine during this audit.** The central claim of the newest report (PROBE_HARNESS_EXTENSION_REPORT.md) — that `c86 v5.2.0` exists and executes on `hd32-minix.img` — was re-run today: the image booted under the probe harness and all seven Dev86 toolchain binaries (`c86`, `cpp`, `as`, `ld`, `make`, `ar`, `objdump`) executed, producing output byte-identical to the report's transcript, including the instruction count (34,000,000). ~80 seconds wall-clock, no network, no build step.

**Phase 14's first step is unblocked right now** — and more unblocked than CLAUDE.md believes, because `hd32-minix.img` is not "fetched on demand": it is **committed to git and sitting in the checkout** at `reference/elks-images-hd/hd32-minix.img` (32,514,048 bytes, exactly the size the fetch script expects). See §4.2.

**The baseline is green and matches CLAUDE.md §2 verbatim:** 998 tests passed, 80 files passed, 1 file skipped, zero failures (363s wall); all four tsconfigs typecheck clean. No regression exists anywhere.

**The codebase is dramatically more complete than any top-level doc claims** — and healthier than the paper trail suggests: 255/256 CPU opcodes, zero TODO/FIXME markers in `src/`, every one of 15 subsystems tested, all five CLAUDE.md §5 hard rules verifiably held.

The rest of this report is the fine print: where docs and code contradict each other (§4), what's fragile (§6), what's dead weight (§7), what can't be known from the repo (§8), and the things worth knowing before they're rediscovered the hard way (§9).

---

## 2. Verified this session (commands actually run)

| Check | Command | Result |
|---|---|---|
| Base typecheck | `npm run build` (`tsc --noEmit`) | exit 0, clean |
| Full typecheck | `npm run typecheck` (base + test + web tsconfigs) | exit 0, all clean |
| CLI tsconfig | `npx tsc --noEmit -p tsconfig.cli.json` (extra; not in the routine gate — see §6.8) | exit 0, clean |
| Full test suite | `npx vitest run` | **`Test Files 80 passed | 1 skipped (81)` · `Tests 998 passed (998)` · Duration 363.20s** |
| Frontier reproduction | `EMU86_VERSION_PROBE_VERBOSE=1 npx vitest run tests/integration/hd32-version-probe.test.ts tests/integration/probe-harness-trivial.test.ts` | 2 passed. Verdict `in-vm-viable`; `c86: works — c86 v5.2.0 (dev) (22 Dec 2024)`, `as86 v0.16.21`, `ld86 0.17.00`, + cpp/make/ar/objdump all `works`. 78s |
| Tree integrity | `git status --porcelain` before/after | only `?? CLAUDE.md`, both submodules internally clean |

The one skipped test file is `tests/sst/corpus.test.ts` (0 tests registered) — the SingleStepTests corpus gate. The mechanism is nastier than documented: see §6.1.

**Environment note:** this box runs the emulator roughly **10× slower** than wherever Phase 12 ran — the trivial probe test took 74s here vs the 6.5s recorded in PROBE_HARNESS_REPORT.md. Budget Phase 14 in-VM compile wall-times accordingly. [INFERRED from the two durations; same test, same code.]

---

## 3. Capability map — what actually works

Per-subsystem verdicts from full reads of `src/` (15 subdirectories + `index.ts`, 66 files, ~11,100 LOC). **No subsystem is a stub and none are dead** (one dead *file*, §7.4). CLAUDE.md's own directory list omits 7 of the 15 (`console`, `core`, `diagnostics`, `host-clock`, `io`, `runtime`, `timing`) — all real, all solid.

### 3.1 Works (verified in code, exercised by the green suite)

- **CPU (`cpu8086/`, 21 files):** flat 256-slot dispatch table; **255/256 opcodes implemented — the only empty slot is 0xF1** (undocumented on real 8086; throws `InvalidOpcodeError`). Undocumented-opcode coverage is deliberate and silicon-faithful: POP CS, 0x60–0x6F jump aliases, 0xC0/C1/C8/C9 RET aliases, SALC, ESC as ModR/M no-op, LOCK pass-through, PUSH SP quirk, REP-IDIV negate quirk. Remaining gaps are sub-opcode throws that are *undefined on real 8086 anyway* (LEA/LES/LDS with register operand; 0xFE /2–/7; 0xFF far-call/jmp with register operand).
- **BIOS (`bios/`):** INT 10h (9 subfunctions), INT 11h/12h, INT 13h (00–05/08/15/16 with real sector I/O, CHS→LBA, two-drive routing), INT 16h (00–02), INT 19h full bootstrap, INT 1Ah (00/02/04), INT 8 timer tick + EOI. Real ROM init code including PIC ICW programming. Unhandled services warn-and-proceed rather than fail silently.
- **Devices:** PIC 8259 (single master — see §6.5), PIT 8254 (modes 0/2/3/4, latch, read-back), 8042 keyboard controller (full command state machine), UART 16550 (8 registers, FIFO, loopback). All four have dedicated unit tests.
- **Machine (`machine/ibm-pc.ts`):** full wiring — PIC@0x20, PIT@0x40→IRQ0, 8042@0x60→IRQ1, UART@0x3F8→IRQ4, BIOS ROM, trap handlers, primary + secondary disk.
- **Memory:** `PagedMemory` sync and infallible as the hard rule requires (address wrap, auto-materialized pages, ROM writes silently dropped — no throw path). IndexedDB page store with fake-indexeddb tests.
- **OS boot:** ELKS from floppy, hard disk, MBR-partitioned disk, and serial console; MINIX-filesystem images; reaches `login:` and runs interactive shells. 16 integration test files exercise these paths in the green suite.
- **Probe harness (`tests/probe/`):** `runProbe()` boots a serial ELKS image, injects a script via an in-memory FAT12 floppy built by a pure-TS FAT12 writer, captures transcripts to a sentinel. The `/bootopts` init-injection path (`buildBootoptsWithScript`/`applyBootopts`) patches the image **in memory only**. Verified matching the reports' API descriptions, and exercised live today (§2).
- **Browser harness (`web/` + `src/browser/`):** xterm.js terminal, Web Worker host, settings modal, themes, IndexedDB image library, GitHub-releases image browser with viability tagging. Structurally verified (all files exist, import chains match the three browser reports' claims); **not exercised in a browser this session** — see §10.
- **CLI tools (`tools/`):** interactive CGA and serial ELKS runners, secondary-disk flags, serial-image builder (offline, byte-patches `/bootopts`), HD-image fetcher (idempotent; skips download when files exist at expected size — which they do). All five npm-script targets exist and compile.

### 3.2 Half-works / scoped-out (deliberate, documented in code, but guest-observable)

1. **INT 16h AH=00 is non-blocking** (returns AX=0 on empty buffer; real BIOS blocks) — `bios-services.ts:521-526`.
2. **INT 8 does not chain INT 1Ch** — bites DOS-style guests (`bios-services.ts:654-656`).
3. **INT 13h AH=15 ignores DL routing** — answers for the primary disk only, unlike AH=02/08 which route correctly; un-flagged inconsistency for two-disk setups (`bios-services.ts:472-477`).
4. **8042 A20 flag is accepted but never enforced** in address masking (`keyboard-controller.ts:25-32`).
5. **PIT delivers at most one IRQ-0 edge per clock batch** — tick undercount at large batch sizes; interacts with the default 10,000-instruction batch (§6.6).
6. **UART has no baud timing** (instant TX) and never raises RLSI/MSI interrupts.
7. **Scancode translator is ASCII-only** — no arrows, F-keys, keypad; unknown bytes silently dropped.
8. **PIT modes 1/5 and BCD counting** warn and go dead.
9. **Invalid opcodes throw a JS exception out of `step()`** instead of behaving like silicon (no #UD on 8086; real hardware executes garbage). A misbehaving guest halts the emulator rather than misbehaving authentically.
10. **REP string ops run to completion inside a single `step()`** — not interruptible mid-iteration like real silicon (documented at `opcodes-string.ts:41-44`).

### 3.3 Absent (relevant absences, verified by grep/ls)

- **No NE2000 or any network code, in any form** — `grep -ri 'ne2000|ne2k|ethernet' src/` finds nothing. Phase 14 starts from zero on the device itself.
- **No slave PIC** — IRQ 8–15 architecturally unreachable (§6.5).
- **No DMA (8237), no RTC/CMOS (0x70/71), no PPI (0x61), no FDC ports, no video device** (the CGA "display" is a diagnostics mirror on memory writes, which is sufficient for ELKS).
- **No guest→host file extraction** — the probe harness can inject files into the guest but cannot read the FAT12 image back; compile outputs can only return as text on stdout (§6.3).
- **No 286/protected mode** — consistent with the roadmap; the only README roadmap item still undone.

---

## 4. Contradictions: documentation vs reality

Each row states which side is right. All checks are from this session.

### 4.1 README.md — wrong about essentially everything (reality wins on every row)

| README claim | Reality |
|---|---|
| "v0 — 6-opcode slice (NOP, HLT, MOV imm, JMP short, ADD imm)" | 255/256 opcodes across 13 opcode modules |
| "103 unit tests" | 998 passing today (81 test files) |
| "Not yet: rest of ISA, interrupts, devices, machine, UI, IndexedDB page store" | **Every listed item exists and is tested** |
| "IOBus (stub)" / "Machine (not yet)" | Real `BasicIOBus` + 4 devices; full `ibm-pc.ts` |
| "no bundler magic, no dependencies beyond TypeScript and vitest" | Runtime deps `@xterm/xterm` + `@xterm/addon-fit`; vite is the web build |
| File map | Covers ~30% of the tree; 11 src directories missing from it |
| Roadmap "next likely commits" 1–8 | Items 1–5, 7, 8 all shipped; only 80286 remains |

### 4.2 CLAUDE.md — mostly accurate, but wrong where it matters most for Phase 14

CLAUDE.md's checkable claims were audited individually. Confirmed exactly right: 66 src files, 29 brief/report pairs (1:1, no orphans), 7 commits all authored by Jonathan's identities, 1,219 tracked files under `releases/`, dist file counts (83/66/7), the dead `elks` stanza in `.gitmodules`, submodules at their recorded commits, the 998 baseline. Wrong or materially imprecise:

1. **"Only `dist-web/elks-serial.img` is committed. `hd32-minix.img` and friends are built/fetched on demand" — WRONG, in the favorable direction.** `git ls-files '*.img'` → **74 tracked images**, including all four HD32 variants at `reference/elks-images-hd/` and both serial floppies. `hd32-minix.img` is present, tracked (since commit `e8a1299`), clean, and verified bootable today. **Phase 14 needs no fetch and no build.** The header comment in `tools/elks-build/fetch-hd-image.ts` ("too large to commit to the repo") is contradicted by the git index the same way.
2. **The SST corpus story is incomplete.** It isn't that the corpus "isn't fetched" — `tests/sst/data` is a **git-tracked symlink to `/data/data/com.termux/files/home/sst-corpus/v2`**, the fold7 phone's Termux home, dangling on this box. Consequences in §6.1.
3. **"No runtime deps beyond TypeScript + vitest"** — two runtime `dependencies` exist (xterm packages, web-only), plus vite/fake-indexeddb as devDeps. Pre-existing, not rule violations, but the sentence is false as written.
4. **"Root is littered with scratch artifacts"** understates: `corpus-baseline*`, `diag-out2.txt`, and `breif.sh` are all **git-tracked**. Removing them is a commit, not a tidy-up.
5. Minor: the src-directory list omits 7 of 15 dirs; "Phase 13/13.5 briefs" should read "the Phase 12.1/13.1 brief/report" ("13.5" appears nowhere in the repo); 81 test files exist on disk (80 run + 1 skipped).

### 4.3 Other stale documentation (reality wins in each)

- **SESSION_REPORT.md** ("353 tests, v0→v1 complete") — accurate *for its moment*, ~27 phases ago. Its claim "corpus is gitignored" is now wrong: a tracked symlink sits at that path.
- **`tests/sst/README.md`** — says to symlink the corpus's `v1/` directory and that "the loader doesn't exist yet". The loader exists (`tests/sst/loader.ts`) and both it and the committed symlink use `v2/`.
- **Stale in-code comments (the comment is the defect in each):** `ibm-pc.ts:158-161` claims "entire address space is RAM… ROM regions are a future brief" — contradicted by the ROM load at `ibm-pc.ts:349`. `page-store.ts:7-8` names `FetchROMStore`/`CompositePageStore` classes that exist nowhere. `console.ts:13` ("Browser implementations come later") and `src/index.ts:31-32` ("BIOS handlers live in a later brief") — both shipped long ago.

### 4.4 Contradictions between reports (the paper trail arguing with itself)

1. **Phase 9 vs 9.1:** BROWSER_HARNESS_REPORT claims a ~3-second blank early-printk window; EARLY_PRINTK_REPORT demonstrates the premise "does not reproduce" and calls the Phase 9 text "both wrong and user-confusing". **9.1 wins** — Phase 9's report contains a false behavioral claim that was never edited.
2. **Phase 13 vs 12.1/13.1:** TOOLCHAIN_SURVEY recommended host-cross-compile for the NE2000; PROBE_HARNESS_EXTENSION explicitly reverses it ("the cross-compile fallback Phase 13 recommended is no longer needed"). **The newest report wins** — but a reader of Phase 13 alone gets the reversed advice.
3. **Phase 4 vs 5:** PS2_A20's stuck-point diagnosis (EOI-related) was overturned by Phase 5's actual root cause (PIC vector-base delivery). Documented correction; PS2_A20_REPORT alone tells a wrong causal story.
4. **8042 bit-4 inversion:** the ps2-a20 *brief* has Disable/Enable backwards (`emu86-ps2-a20-brief.md:160-161`); the *report* (`PS2_A20_REPORT.md:58-59`) matches real hardware. Report wins.
5. **Accumulating misattributions:** PROBE_HARNESS_EXTENSION_REPORT:63 dates `elks-hd-minix-boot.test.ts` to Phase 11.5 (actually Phase 10.2); ELKS_DIAGNOSIS_REPORT:267 says "Phase 4 stubbed" INT 13h (landed in Phase 2); Phase 13's transcript misquotes the `typecheck` script. Small, but the reports are the project's memory and the errors are compounding.

---

## 5. The test-count ledger

The brief→report chain reconciles at **every** link from 353 (v1) through 1,294 (Phase 13) to today's 998 — including the corpus-present/absent hops. Full chronology: 353 → 380 → 395 → 422 → 477 → 519 → 533 → 602 → 997ᶜ → 668 → 700 → 1,028ᶜ → 1,029ᶜ → 747 → 756 → 790 → 806 → 1,135ᶜ → 1,155ᶜ → 1,175ᶜ → 1,211ᶜ → 1,226ᶜ → 1,228ᶜ → 1,253ᶜ → 1,254ᶜ → 1,255ᶜ → 1,274ᶜ → 1,294ᶜ → **998 today** (ᶜ = corpus present in that run). Phase numbering restarts partway through (seven un-numbered sessions precede "Phase 1") — confusing but gapless.

Three anomalies, none a regression:

1. **The corpus contribution drifts 329 → 323 → "~327" across reports and is never explained** (probably corpus-file/mask handling evolution — [INFERRED]).
2. **Four tests are unaccounted for.** Phase 13's 1,294 minus its 323 corpus tests = 971 non-corpus; Phase 12.1/13.1 added 31 tests → expected 1,002; observed (then and today) is **998**. The latest report papers over this with the "~327" estimate (998 + 327 = 1,325). Nobody has run the reconciliation. Worth one deliberate with-corpus run if test infrastructure is ever touched.
3. **Corpus availability silently flips with the machine** (absent Phases 7–9, present 9.1–13, absent since) — an artifact of the three-machine history that the reports never call out.

**Correct expectations today:** 998 without corpus; **~1,325 with corpus** (not 1,294 — that number is two phases stale).

---

## 6. Load-bearing and fragile

Ranked by how much they'll hurt.

1. **The correctness oracle is disabled by a committed phone artifact.** `tests/sst/data` is a tracked symlink (git mode 120000) to a Termux path that exists only on the fold7 phone. On this box it dangles, `corpusAvailable()` returns false, and the whole SST corpus — "the real correctness oracle" per CLAUDE.md — silently skips. Sharp edges: `.gitignore`'s `tests/sst/data/` entry does **not** cover it (trailing-slash patterns match directories only, and gitignore never applies to already-tracked paths); wiring up a local corpus therefore **modifies a tracked file**; a second tracked symlink (`dist-cli/tests/sst/data`) chains to it; and it crashes naive directory walkers (one of this audit's own scanners hit ENOENT on it). Decision needed: commit a new symlink, or `git rm --cached` it so the ignore rule takes over.
2. **The probe harness's FAT12 launch path has a known latent bug** — `runUntilSentinel` catches the launch command's own echoed sentinel. Both toolchain surveys bypassed it via the `/bootopts` init-script path, which is capped at **~115 effective bytes of script** (ELKS `MAX_INIT_SLEN`; the Phase 13 overflow panic came from exceeding it). A Phase 14 hello-world fits in the budget; anything bigger means fixing the sentinel bug first. Documented in `hd32-version-probe.ts:7-12`; fix explicitly deferred by the extension report.
3. **No guest→host file extraction.** `buildProbeDisk()` injects files in; nothing reads the FAT12 back out (deferred in Phase 12). A hello-world can prove itself by *running in-guest* and printing; **extracting a compiled NE2000 binary as an artifact cannot be done today.** This is Phase 14's first real infrastructure gap.
4. **Hardcoded image-geometry table:** exactly 6 recognized image byte-sizes (`worker-host.ts:81-94`), heads≥4→HD heuristic duplicated in `ibm-pc.ts:317-329`, and `tools/` reaches into `src/browser/worker-host.js` for it — surprising layering. Any new image size needs explicit geometry.
5. **Single master PIC — IRQ 8–15 unreachable** (`pic.ts:285-293`). Constrains the future NE2000 to a master-PIC line (IRQ 3 or 5 being the natural choices).
6. **PIT edge coalescing × batch size:** at most one timer edge per clock batch (`pit.ts:709-714`) against a default 10,000-instruction batch (`ibm-pc.ts:230`) — timer undercount is batch-size-dependent. Subtle timing drift, currently harmless to ELKS.
7. **Trap-registry BIOS hooks key on linear CS:IP** (`cpu.ts:203-209`) — depends on the guest never relocating or overwriting the hooked vectors.
8. **`npm run typecheck` does not cover `tsconfig.cli.json`** — the CLI config is only type-checked implicitly when the `start:*`/`build:elks-*` scripts emit. Clean today (verified explicitly), but it's a hole in the routine gate. (An older report shows the script *used* to include it.)
9. **Small stuff:** `tools/elks/run*.ts` default image paths resolve against cwd (must run from repo root); `NodeFileDisk` slurps whole images into RAM (32 MiB per HD image; documented); unused `readFileSync` imports in both tools.

---

## 7. Dead weight and hygiene

1. **`dist-cli-src-tmp/` (66 tracked files) is an accidentally-committed scratch compile.** Its flat layout is impossible under the committed `tsconfig.cli.json` (whose `rootDir: "."` has never changed); its content is an *intermediate* state — contains Phase-10 `diskClass` code but zero Phase-11 `secondaryDisk` (present ×15 in real dist-cli); it matches no commit's real output; nothing references it except CLAUDE.md. Swept into the hand-authored `e8a1299` checkpoint. Safe-delete candidate (via commit). [Deletion verdict INFERRED from that verified evidence.]
2. **`releases/` is 74% of the repo's tracked files** (1,219 of 1,651) — 196MB on disk, 644MB apparent (the images check out sparse on ext4). Thirteen brief-mandated per-phase snapshots, phases 9→13; **nothing in any code path reads them**; ~90% of the bulk is the same four 32MB HD images and dist trees duplicated 9–13×; the same 1.44MB serial floppy is committed 16+ times across root + snapshots. Recoverable from git history [INFERRED from snapshot READMEs + per-commit stats; not byte-verified for all 13]. Keeping them is a policy choice, not a technical need.
3. **`dist-cli/` and `dist-web/` are current** (spot-checked, not byte-recompiled): nothing compilable changed after the commit that last built them; four distinctive recent identifiers present in the compiled JS; dist-web's hashed assets match its `index.html` and contain the newest feature strings. Also every `start:*`/`build:elks-*` script recompiles dist-cli before running, so its staleness can't bite anyway.
4. **`src/browser/index.ts` is the only dead source file** — a 17-line re-export barrel nothing imports (consumers import `worker-host.js`/`protocol.js` directly).
5. **`breif.sh`** (tracked, filename typo): the phone-era phase driver — copies briefs from `~/storage/downloads`, runs `claude --dangerously-skip-permissions "read emu86-<topic>-brief.md and follow it"`, copies the report back. Historically valuable (it documents the actual workflow), but the committed version has a **stray shell-history paste on its last line** (`…follow it"  487  ls`) that would pass junk arguments if ever re-run.
6. **Tracked scratch outputs:** `corpus-baseline*.txt/.err` (7 files, 3 empty — corpus-validation phase) and `diag-out2.txt` (116KB ELKS boot dump — diagnosis phase). Obsolete, reproducible from committed tooling, deletable only via commit.
7. **`.gitmodules` dead `elks` stanza** confirmed: three stanzas, two gitlinks in the index, no `elks/` on disk; `git submodule status` doesn't list it. Both real submodules are initialized, clean, at their recorded commits.
8. **`.gitignore` oddities:** ignores `dist/` (no such dir; real outputs are the tracked `dist-*`), double `dl`/`dl/` entries, and the ineffective `tests/sst/data/` (§6.1).
9. **Trivia:** no LICENSE file (matters only if the huxley merge goes public); `package.json` still `0.0.1`; git identity split across two emails (cosmetic).

---

## 8. What the repo alone cannot answer

1. **The contents of `emu86-networking-plan.md`** — cited 5× by the Phase 12.1/13.1 pair as Phase 14 device-shape context; never committed anywhere. Recoverable only from the planning chats (convscan #94 / #82 per CLAUDE.md). Not needed for the hello-world step; needed before NE2000 device design.
2. **`emu86-handover-brief-v2.md`** — a **second** dangling reference, not flagged in CLAUDE.md: required reading per `emu86-browser-harness-brief.md:24`, absent from the tree. Presumably also chat-side or huxley-side.
3. **Whether the browser harness still works in a real browser.** All "works in Firefox/Chrome" claims date from before the Termux-era phases (which honestly noted they *couldn't* do GUI verification, but never revisited the earlier claims). This audit verified the web code structurally only. Finding out: `npm run dev:browser` and click around — minutes, but it needs a human or a browser-automation session.
4. **The 4-test ledger gap** (§5.2): needs the SST corpus fetched (~1GB shallow clone of `SingleStepTests/8088`, symlink `v2/` at `tests/sst/data`) and one with-corpus run to see the true total (~1,325 expected).
5. **The huxley-side state:** whether the C co-simulation harness there still drives the current `reference/8086tiny` commit, and everything about the eventual merge-back. Different repo, different machine, pending decision per CLAUDE.md §3.
6. **Whether the GitHub remote is private**, and whether `origin/main` has moved — nothing was fetched this session; local shows in-sync with the last-known remote refs.
7. **Whether emu86 is fast enough for huxley/lite's purposes** — the project's founding question. The 10×-slower-box observation (§2) makes this *more* pressing: if in-VM compiles feel slow here, that's this machine, not necessarily the browser target. No performance work has ever been phased; there is no benchmark suite.

---

## 9. Surprises (the "don't rediscover this in three weeks" list)

1. **`hd32-minix.img` is already in the repo.** Don't run `npm run build:elks-hd-image`; don't wait for a download. CLAUDE.md §2 and the fetch-script header both say otherwise; both are wrong. (74 `.img` files are tracked in total.)
2. **The frontier claim survived live reproduction** — c86 v5.2.0 output byte-identical today, down to the 34M instruction count. The last report can be trusted.
3. **The SST oracle is off because of a committed symlink to a phone's filesystem**, not a missing download — and turning it on means touching a tracked file (§6.1).
4. **This box is ~10× slower** than the machine that set the Phase 12 timing expectations (74s vs 6.5s, same test).
5. **The correct with-corpus test expectation is ~1,325, not 1,294** — the widely-quoted 1,294 is two phases stale, and 4 tests in the ledger were never reconciled.
6. **A hello-world compile has ~115 bytes of script budget** unless the sentinel-echo bug gets fixed first; and there is **no way to extract a compiled binary from the guest** yet (§6.2–6.3).
7. **`c86 -v` compiles its stdin as a side effect** — the surveys exploited this as evidence-of-execution; for real builds, don't pass `-v` and expect it to only print a version. (Also: `as` needs a real input file; `make` needs a Makefile; don't invoke `cpp` directly. All from the extension report's operational notes.)
8. **`dist-cli-src-tmp/` is a 66-file accident** that has sat in the tree through 5 commits looking load-bearing. It isn't.
9. **`breif.sh` records that phase agents ran with `--dangerously-skip-permissions`** — plus a stray shell-paste bug in its committed last line.
10. **Phase 9's report contains a false behavioral claim** (the "blank window") that its own follow-up phase disproved — a standing reminder that even this project's good reports are frozen, not corrected.

---

## 10. What this audit deliberately did NOT do

- **No fixes.** Every defect above is reported, none repaired. The tree is byte-identical to how it was found (plus this report).
- **No rebuilds** of `dist-cli`/`dist-web`/images — their "current" verdicts are history-plus-spot-check, not byte-for-byte recompiles, and are labeled as such.
- **No browser session** — web harness verified structurally only.
- **No network access** — corpus not fetched, remote not contacted, image URLs not probed.
- **No byte-verification of all 13 release snapshots** against their commits (sampled only).
- **The `releases/` READMEs' self-descriptions were trusted** for what each snapshot pins [INFERRED where noted].

---

## 11. Assessment: sensible next moves (in order)

1. **Start Phase 14's hello-world now.** Everything it needs is verified present: image, toolchain, harness, `/bootopts` injection path, FAT12 file injection for `hello.c`. Have the planning chat write the Phase 14 brief; its first milestone (compile + run hello-world in-guest, capture stdout) fits inside today's infrastructure. Its second milestone should be **guest→host extraction** (FAT12 read-back), which the NE2000 artifact will require — schedule the sentinel-echo fix with it.
2. **Recover the two missing documents from the planning chats** before NE2000 device design: `emu86-networking-plan.md` and (lower priority) `emu86-handover-brief-v2.md`.
3. **Decide the `tests/sst/data` symlink's fate** (replace vs `git rm --cached`) and fetch the corpus before any CPU-semantics work — and use that run to close the 4-test ledger gap.
4. **One doc-repair commit** would pay for itself: fix CLAUDE.md's image claims (§4.2), rewrite or clearly deprecate README.md, fix `tests/sst/README.md`, the four stale code comments (§4.3), `breif.sh`'s pasted line, add `tsconfig.cli.json` to `npm run typecheck`.
5. **Make `releases/` a policy decision** rather than a default: 74% of tracked files, zero consumers.
6. Commit `CLAUDE.md` itself — it's still untracked, and it's the best orientation document the repo has (this audit found it ~95% accurate).

---

*Audit performed 2026-07-13 by a Claude Code session using six parallel read-only subagent auditors plus live verification runs. Nothing in the repository was modified other than the addition of this report. Evidence standard: every unmarked claim traces to a file read or command run during the session; [INFERRED] marks conclusions drawn from verified evidence without direct observation.*
