# emu86 — Handover Brief (v4, post-Phase 13)

You are picking up a project mid-flight. This document is your fastest
path to being useful. Read this first; then go to the latest report
for current depth; then consult older reports as needed.

This supersedes `emu86-handover-brief-v3.md`. v3 was current at Phase
10.1's close; v4 reflects state through Phase 13 and the in-flight
Phase 12.1 / 13.1 brief.

## What this project is

A browser-oriented TypeScript x86 emulator framework. The North Star
("browser-oriented x86 emulator") was reached at Phase 9.

**Current state, in plain language:** ELKS (Linux for 8086) boots in
either a Node serial harness or a browser harness backed by xterm.js.
Floppy and hard-disk images both work. Hard-disk images include both
partitionless and MBR-partitioned variants, FAT and MINIX
filesystems. Multi-disk machines (primary + secondary) work and have
been verified to boot ELKS with both disks visible to the kernel.
The browser includes a settings panel (font, theme, primary and
secondary boot-image source), a local upload path, and a GitHub
release browser that downloads ELKS images directly into IndexedDB.

A reusable test-side **probe harness** (Phase 12) lets test code
boot ELKS, write a probe script onto a secondary disk, run it, and
capture the script's output. Phase 13 used this to survey published
ELKS images for self-hosted compilers; the survey hit a harness-
internal limitation (boot budget too low for HD images) and landed
Outcome C — *we know HD images contain Dev86-shaped binaries
(c86, cpp, as, ld, make, ar, objdump) but couldn't verify they run.*
The Phase 12.1 / 13.1 combined brief in `emu86-probe-harness-extension-brief.md`
is queued to settle this.

**Test counts:** ~1,294 unit + integration + 323 SST corpus =
1,617 total. All green.

**Architecture:** strict TypeScript, no escape hatches, no custom
CPU opcodes, `cpu.step()` synchronous, no architectural debt
accumulated. The discipline that started in v0 has held across
this many phases.

The human owns architectural direction. You write briefs; specialised
agents on the human's machine implement them and produce reports
back. **You don't write implementation code yourself in this role.**
If asked to write code directly, push back unless it's a small
clarification snippet.

## What's most recent

**Phase 13** (Toolchain Survey) closed with **Outcome C** — survey
blocked by infrastructure (probe harness's hard-coded boot budget
too small for HD images). Findings:

- *Floppy images contain no compilers.* `fd1440-minix.img` was
  fully surveyed; 138 binaries in `/bin`, none compiler-shaped.
- *HD32 images plausibly contain a Dev86 toolchain.* Partial
  listings of `hd32-minix.img` and `hd32-fat.img` showed
  `c86 cpp as ld make ar objdump` in `/usr/bin/`. Existence
  established; *function* not (couldn't run version probe within
  budget).
- *MBR-padded HD32 and HD64 sizes were rejected by `inferGeometry()`.*
  Same harness limit, different shape.

The Phase 13 report's recommendation: **defer in-VM dogfooding**
until a Phase 12.x harness extension lands; meanwhile Phase 14
should host-cross-compile NE2000 if the user takes that path.

**The user's choice (queued in `emu86-probe-harness-extension-brief.md`):**
do the harness extension *and* the deferred version probe in one
combined Phase 12.1 / 13.1 brief, then write Phase 14 with full
information. The brief is queued; the agent has not yet run it as
of this writeup.

## Where things live

Repo layout is unchanged in shape from v3; new directories and
files since Phase 10.1:

```
emu86/
├── src/
│   ├── ... (substrate; unchanged in shape since Phase 10.1)
│   ├── machine/ibm-pc.ts          ← multi-disk wiring (Phase 11)
│   ├── bios/bios-services.ts      ← INT 13h drive routing (Phase 11)
│   ├── browser/protocol.ts        ← BootConfig with secondary disk (Phase 11)
│   └── browser/worker-host.ts     ← multi-disk consumer (Phase 11)
├── web/
│   ├── settings-modal.ts          ← gained secondary disk picker (Phase 11)
│   └── ... (otherwise unchanged)
├── tests/
│   ├── unit/                      ← +bios-int13-multi-disk, +machine-multi-disk, +ramdisk*, ...
│   ├── integration/
│   │   ├── elks-multi-disk-boot.test.ts        (Phase 11)
│   │   ├── elks-ramdisk-serial.test.ts         (Phase 11.6)
│   │   ├── probe-harness-trivial.test.ts       (Phase 12)
│   │   └── toolchain-survey.test.ts            (Phase 13)
│   └── probe/                     ← NEW directory (Phase 12)
│       ├── probe-harness.ts       — runProbe() entry point
│       ├── probe-disk.ts          — pure-TS FAT12 writer
│       ├── *.test.ts              — unit tests for harness internals
│       └── surveys/
│           └── survey-runner.ts   — Phase 13 survey orchestration
├── tools/
│   ├── elks/                      ← run.ts, run-serial.ts; +secondary-disk.ts (Phase 11)
│   └── elks-build/
│       ├── build-serial-image.ts  ← gained --filesystem flag (Phase 11.6)
│       └── fetch-hd-image.ts      ← multi-image fetcher
├── releases/                      ← phase-N-<slug>/ snapshots since 9.1
└── reference/
    ├── ... (kernel source, reference C emulator)
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img
    │   └── fd1440-minix-serial.img       (Phase 11.6 — UART + device nodes)
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/
        ├── hd32-fat.img                  (Phase 10 partitionless FAT)
        ├── hd32-minix.img                (Phase 10.2 partitionless MINIX)
        ├── hd32mbr-fat.img               (Phase 10.1 MBR FAT)
        └── hd32mbr-minix.img             (Phase 10.1 MBR MINIX)
```

## Architectural principles (non-negotiable)

These have held across all phases. **Don't relax without explicit
human sign-off.**

**`cpu.step()` is pure synchronous.** Async lives in the run loop
and (where appropriate) in device control planes. The CPU never
awaits. The browser worker host runs the loop in its own thread but
the loop itself stays synchronous.

**The 8086 ISA is corpus-pure.** No custom opcodes ever. The
SingleStepTests corpus (323 cases × 9263 instructions per case ≈
3M+ assertions) validates every implemented instruction against
real silicon behaviour.

**Layers compose; they don't know about each other.** PIC doesn't
know about InterruptController's callers; PIT doesn't know about
PIC; the Machine is the only place wiring happens. Multi-disk
followed this discipline — disk-class-routing within INT 13h, the
disks themselves are unchanged.

**Memory is always resident, never faults.** PagedMemory
reads/writes are sync. ROM regions silently drop writes. Persistence
is async write-behind.

**Determinism over realism in tests.** No `Date.now()`, no
`setInterval`, no real timers in unit tests. Virtual `Clock`
advances when the run loop tells it to. Phase 10.1's
`AutoAdvanceHostClock` test-side helper is the canonical pattern:
when a test needs a host clock to *appear* to advance (e.g., for
the MBR's auto-boot timeout), use a local override in the test
rather than modifying the substrate.

**Strict TypeScript.** No `any`, no `as unknown as`, no
`// @ts-ignore`. Every brief reinforces this; every report
confirms it stayed strict.

**Evidence over speculation.** When something doesn't work,
diagnose first. Don't grab-bag stubs. Phase 5, Phase 8, Phase 9.3,
Phase 10.1, and Phase 13 are the canonical examples. Phase 13 is
particularly worth re-reading: a clean Outcome C ("survey blocked
by infrastructure") preserved the architecture by *refusing* to
work around the harness limit silently.

**Authentic emulation over convenience.** Phase 10.1's authentic
MBR chain-load over virtual-shift; Phase 11.6's in-place hex edit
preserving the upstream `/bootopts` convention. When in doubt,
emulate what real hardware does.

**Back-compat for substrate APIs.** Phase 11 added multi-disk
support without breaking any prior single-disk test by keeping
the legacy `disk` field as a pure addition rather than a union or
a normalisation step. Pure additive optionals minimise churn and
make legacy paths obviously legacy.

**Tools, not features.** Phase 12's probe harness is a clean
example: the brief explicitly disallowed bundling investigative
content with the tool's first ship. Phase 13 honoured this — used
the tool, didn't extend it. The discipline preserves the tool's
clarity for the many later applications.

## What's been built (the project arc)

Reading the project as a story, not a flat list. The new chapter
since v3:

**Multi-disk substrate (Phase 11 + 11.5 + 11.6).** Multi-disk
machine config; `/dev/hdb` and `/dev/fd1` routable; ramdisk
verified working via `/dev/rd0` (driver compiled in, 512 KB cap,
conventional RAM only); MINIX-FS serial floppy image
(`fd1440-minix-serial.img`) bridges device nodes + UART console
in one image.

**Probe harness (Phase 12).** Reusable test-side framework for
"boot ELKS, run a script, capture output." Pure-TypeScript FAT12
writer for staging probe scripts. `runProbe()` API. Integration
test pattern that future investigations build on.

**Toolchain survey (Phase 13).** First real application of the
harness. Outcome C — survey hit a harness boot-budget limit on
HD images. Found Dev86 binaries on HD32 images by name; couldn't
verify their function. Recommended deferring in-VM dogfooding to
a Phase 12.x extension that lifts the limit.

**Networking architecture plan (`emu86-networking-plan.md`).**
Captured during this session, before any networking phase begins.
Two-layer plan: NE2000 + virtual switch as the daily-driver
network (with ARP/ICMP/DNS/HTTP gateway pseudo-hosts implemented
in JavaScript), plus a `webget`-shaped HTTPS escape hatch via a
second UART. This is the agreed shape for whatever the dogfooding
verdict turns out to be.

**Releases.** Every phase since 9.1 ships a self-contained
snapshot at `releases/phase-N-<slug>/`. Reload-safe regression
A/B testing. Now ten releases deep.

## How to ramp up after this handover

Read in this order:

1. **`PROBE_HARNESS_EXTENSION_REPORT.md`** (Phase 12.1 / 13.1) —
   when it lands, the most recent state. Tells you whether in-VM
   dogfooding is viable or not.
2. **`TOOLCHAIN_SURVEY_REPORT.md`** (Phase 13) — the survey that
   surfaced the question 12.1 / 13.1 settles. Section 4
   ("Things future briefs should address") is concrete.
3. **`emu86-networking-plan.md`** — the agreed shape for the
   networking arc. Phase 14's brief writes itself from this plus
   the verdict in #1.
4. **`PROBE_HARNESS_REPORT.md`** (Phase 12) — the harness API and
   structure.
5. **`MULTI_DISK_REPORT.md`** (Phase 11) — multi-disk substrate;
   the routing seam Phase 14's networking will live alongside.
6. **`MBR_PARTITION_REPORT.md`** (Phase 10.1) — the canonical
   "Outcome A: no source changes" example; useful template for
   "diagnosis-confirms-substrate-already-handles-it" reports.
7. **`HARDDISK_BOOT_REPORT.md`** (Phase 10) — Phase 11 builds on
   the diskClass plumbing here.
8. **`SERIAL_CONSOLE_REPORT.md`** (Phase 8) — diagnose-first
   discipline at its clearest.
9. **`emu86-INDEX.md`** — full navigation if you need older
   context.

## How to write briefs (the playbook)

Refined slightly since v3. The structural template stays the
same; the principles below are what's been re-validated this
session.

**Structural template:**

- TL;DR (one paragraph, with success criterion and report
  filename)
- Hard rules (numbered list of non-negotiables; what's locked,
  what's allowed, what triggers stop-and-ask)
- Background (what the substrate already does that informs scope)
- Scope (what's in, with sections per concern)
- Section 1 — diagnosis when the brief is exploratory (mandatory
  for Phase 5 / 8 / 9.3 / 10.1 / 11.5 / 13-shaped work)
- Implementation sections, with multiple acceptable outcomes
  (A/B/C, sometimes D) when there's real uncertainty
- What you are NOT building (an explicit fence — saves the agent
  from helpful expansion)
- Tests (per-component test counts and shapes)
- Watch out for (the bug magnets — call them out before they
  bite)
- Definition of done (test counts, typecheck, corpus regression,
  manual verification, release snapshot)
- Release snapshot directive (mandatory since Phase 9.1)
- Report sections (named, ordered)
- Reference sources

**Principles re-validated this session:**

- **The lock list is rule-zero.** Phase 13's Outcome C happened
  precisely because the harness was locked by Hard Rule 7 and the
  agent honoured it instead of working around the boot budget
  silently. *That's the discipline working*. The locks protect
  the architecture; the architecture is the project. Phase 12.1
  unlocks the harness deliberately because doing so is now the
  brief's purpose.

- **Diagnose-first turns "stuck" into "informed."** Phase 13
  could have ground forward by working around the harness limit;
  instead it stopped, named the limit precisely, and produced a
  recommendation that's actionable either way. The next brief
  inherits a clear path.

- **Outcomes A/B/C/D are not failure modes — they're shapes of
  completion.** Phase 11.5 (Outcome A: ramdisk works), Phase 13
  (Outcome C: survey blocked, here's why), Phase 10.1 (Outcome A
  with no source changes). All clean landings. The brief
  structures itself so each outcome lands gracefully.

- **The closing-courtesy update.** Phase 10.2's tagger update,
  Phase 11's secondary-disk picker — small ride-along pieces that
  honour findings from a prior phase without bloating the new
  brief. Watch for opportunities.

- **Forward-compat at the discriminator level, not the field
  level.** Phase 9.2's `source: 'upload' | 'github'` was the
  smallest-possible forward-compat for Phase 9.3 to add
  GitHub-sourced library entries. Phase 11's multi-disk did the
  same — additive optional fields rather than restructured
  shapes.

- **Tools earn their keep across many uses.** Phase 12's harness
  was Phase 13's first application; Phase 12.1 will see Phase 13.1
  re-use it; the networking arc may use it for kernel-feature
  investigations. Building tools that feel "more general than this
  brief needs" repeatedly pays back when later briefs need the
  generality.

**What to push back on, when the human asks:**

- Bundling unrelated concerns. Phase 9.2 → 9.3 split was a clean
  example. Phase 12 → 13 was another. The probe-harness brief
  explicitly forbade investigative content; Phase 13 honoured it.
- Pre-implementing for futures. Phase 9.2's discriminator was the
  right level; a full image-source abstraction would have been
  over-engineering.
- Silently relaxing rules. The hard-rule lists, the lock lists,
  the "no fix-and-pray" instructions — these should never be
  weakened mid-conversation without explicit re-asking.
- Skipping diagnosis. If a brief is exploratory and the agent
  can speedrun straight to implementation, that's fragile —
  diagnosis-as-deliverable is durable.
- Reversing prior architectural calls without new evidence.
  Phase 10.1 chose authentic chain-load; if a future brief argues
  for virtual-shift, that's a re-decision, not a casual fork.

## Patterns to watch for

These have come up repeatedly:

**The "fix-and-pray" failure mode.** Agent sees something not
working, reaches for a stub or a hack hoping it'll work. The
discipline is to diagnose first, then implement the real fix.
Phase 13 is the new canonical "I won't even attempt to work
around this" instance.

**The "tempting expansion" failure mode.** Agent finishes the
brief's core work, sees an obvious adjacent improvement, and
expands scope. Briefs name what's NOT in scope explicitly to
counter this. Phase 12's "harness is the tool, not the work"
extension of this discipline worked. Phase 12.1's "stop at
version output" repeats it.

**The "diagnosis was wrong" failure mode.** Phase 9.1: brief
expected to fix a 3-second blank window; agent diagnosed the
wiring was already correct. Phase 11.5: brief expected to need
substrate work for ramdisk; agent diagnosed it Just Worked.
The right move is to verify the wiring as a regression invariant
and report. Never fabricate a problem to fix.

**The "honest tagging" principle.** When something has known
limitations (the GitHub browser's viability tags, the asset
download CDN's CORS unreliability, Phase 13's "evidence-of-name-
not-of-function" finding), surface the limitation honestly. Tags
inform; they don't gatekeep. Documentation that admits "we don't
know if this works" is more valuable than documentation that
pretends.

**The "test the workaround at the right layer" principle.**
Phase 10.1's `AutoAdvanceHostClock` is a test-side helper, not
a substrate change. When something needs to behave differently
for a specific test, do it in the test — not by weakening the
substrate's deterministic guarantees.

**The "diagnosis pre-fills the next brief" principle.** Phase
9.3's hard-disk diagnosis became Phase 10's input nearly
verbatim. Phase 13's recommendation became Phase 12.1 / 13.1's
brief structure. Reports that include "Things future briefs
should address" pay back compounding interest.

## When to stop and ask

The brief-writing contract: **don't invent context you didn't
read; don't silently relax architectural rules; if you're unsure
between options, ask using `ask_user_input_v0` with a
recommendation afterwards.**

Concrete cases that should always trigger a question:

- Multiple plausible directions with materially different
  architectural implications.
- Scope decisions inside a brief (image upload semantics; theme
  picker scope; release-range to surface; dogfooding's
  "comprehensive vs targeted" survey scope).
- Outcomes that would loosen the lock list. If implementing
  Outcome A or B requires editing a locked directory, the report
  must surface this explicitly — never implement it silently.
- Something that contradicts a previous diagnosis. If Phase N's
  diagnosis claimed X and Phase N+1's work shows X is wrong,
  re-ask before continuing.
- The user's stated preference appears to conflict with the
  architectural posture. The authentic-vs-virtual-shift question
  was a clean instance.
- Bundling vs splitting briefs. The networking arc has 4-5
  potential briefs that could be bundled various ways; ask before
  committing.

## Project state in numbers (post-Phase 13, pre-12.1)

- 1,617 tests total (1,294 unit/integration + 323 SST corpus).
- All green. Strict TypeScript. No `any`. No `as unknown as`.
- 13+ release snapshots since Phase 9.1.
- Boot times: ~7-8s (HD partitionless), ~24s (MBR HD with auto-
  boot timeout).
- Both Node and browser harnesses production-shaped: ~318 KB
  gzipped JS + image fixtures as static assets.

## What's next

After Phase 12.1 / 13.1 lands and settles the dogfooding question,
the natural arc is networking. The shape is laid out in
`emu86-networking-plan.md`:

- **Phase 14**: NE2000 device + Switch substrate. Card exists,
  frames flow, no peers attached. Dogfooded if 13.1 went well;
  cross-compiled if not.
- **Phase 15**: ARP + ICMP pseudo-host. `ping 10.0.0.1` works.
- **Phase 16**: DNS via DoH. Real name resolution.
- **Phase 17**: TCP termination + HTTP proxy (probably 2 briefs).
  `wget http://example.com` works.
- **Phase 18** (or earlier opportunistically): `webget` HTTPS
  escape hatch via second UART.
- **Phase 19+**: NTP/RTC, multi-NIC, WebSocket relay for inter-VM.

Three open questions in `emu86-networking-plan.md` that the next
planning instance should engage with before drafting Phase 14:

1. Order priority within the network arc (linear or parallel).
2. `webget` placement (early as cheap user-visible win, or after
   the network is real, when its purpose is clearer as a labelled
   exception).
3. Configuration surface for pseudo-hosts (worker host config vs
   browser settings panel vs both).

Other directions still on the table from earlier menus:

- **CGA-canvas browser frontend** — graphics-mode rendering for
  non-serial guests.
- **Snapshot / restore** — skip the boot. Quality-of-life win.
- **User toggle: authentic vs virtual-shift MBR boot** — small,
  completes the spectrum.
- **Multi-disk machines beyond two** — substrate seam exists but
  unused.
- **Public README / demo** — different audience, different shape;
  worth its own brief if surfaced as a goal.

## A note on the user's posture

The user has stated philosophical positions worth preserving across
context boundaries:

**"Teach a man to fish, don't just give him a fish snack."** This
is the project's posture, not a one-off comment. It's why we
built the probe harness instead of doing the survey ad-hoc, why
authentic emulation wins over virtual-shift, why every brief has
hard rules and a lock list, why diagnosis is mandatory before
implementation. The architecture has held across this many phases
because the discipline is genuinely the project. **Don't relax it
under pressure.**

**Authenticity matters.** Phase 10.1's authentic MBR chain-load
over virtual-shift (with the "user toggle" deferred for a future
brief) was a deliberate architectural call. The networking plan's
two-layer shape — real network for everything, `webget` as labelled
exception only for HTTPS — reflects the same posture.

**Multiple acceptable outcomes are normal.** The user has
repeatedly accepted Outcome B / C / D as completion. Briefs that
structure for "what happens if this doesn't pan out cleanly"
ship reliably. Briefs that pretend success is the only outcome
quietly accumulate technical debt or get rewritten mid-flight.

**The user pushes back productively.** Several times this session
the user's instinct redirected the brief shape: pulling ramdisk
forward to its own focused brief; recognising that the FAT-vs-
MINIX device-node finding deserved its own follow-up phase;
choosing comprehensive over targeted scope on the toolchain
survey. Engage with these redirections rather than treating them
as derailments — they're typically right.

## What this handover replaces

This file (`emu86-handover-brief-v4.md`) replaces v3. v3 was
written at Phase 10.1 close; it's now stale on:

- Multi-disk substrate (Phase 11) and its sub-phases (11.5
  ramdisk, 11.6 MINIX serial floppy).
- The probe harness (Phase 12) and its first application (Phase
  13's toolchain survey).
- The networking architecture plan documented in
  `emu86-networking-plan.md`.
- The Phase 12.1 / 13.1 in-flight brief.
- New patterns identified this session (Outcome D, "test the
  workaround at the right layer," "diagnosis pre-fills the next
  brief," "tools earn their keep across many uses").

Keep v3 in the knowledge base for historical record, but route
new readers to v4.

## Final note to my successor

The arc since I picked up this project at Phase 6 has been:
substrate completion → interactive harness → serial path →
browser deployment → image library → hard-disk support →
multi-disk → ramdisk → probe harness → toolchain survey. Twenty-
plus phases. Each one small. Each one compounds.

The discipline is the project. The architecture has held because
the briefs have held. The user has pushed back productively at
exactly the moments when pushing back mattered. The agents have
honoured locks at exactly the moments when honouring them
mattered. None of this happened by accident; all of it is
preservable.

Pick up where I left off. The handover stack — this file, the
INDEX, the networking plan, the latest report — has what you
need. Phase 12.1 / 13.1's verdict will tell you whether Phase 14
is in-VM dogfood or host cross-compile; the networking plan
covers both shapes. Whichever way the verdict goes, the next
brief writes itself fairly directly.

It's been a privilege to plan this with the user. Whatever shape
the project takes next, the substrate is in genuinely good
hands.
