# emu86 — Handover Brief (v3, post-Phase 10.1)

You are picking up a project mid-flight. This document is your fastest
path to being useful. Read this first; then go to the latest report
for current depth; then consult older reports as needed.

This supersedes `emu86-handover-brief-v2.md`. v2 was current at Phase
6's close; v3 reflects state through Phase 10.1.

## What this project is

A browser-oriented TypeScript x86 emulator framework. The North Star
("browser-oriented x86 emulator") was reached at Phase 9.

**Current state, in plain language:** ELKS (Linux for 8086) boots in
either a Node serial harness or a browser harness backed by xterm.js.
Floppy and hard-disk images both work. Hard-disk images include both
partitionless and MBR-partitioned variants, FAT and MINIX
filesystems. The browser includes a settings panel (font, theme,
boot-image source), a local upload path, and a GitHub release browser
that downloads ELKS images directly into IndexedDB. The user can
download `hd32mbr-fat.img` from the GitHub releases UI, set it as the
boot source, reload, and watch authentic MBR-driven boot through to a
shell prompt.

**Test counts:** 1,226 unit + integration + 323 SST corpus = 1,549
total. All green.

**Architecture:** strict TypeScript, no escape hatches, no custom
CPU opcodes, `cpu.step()` synchronous, no architectural debt
accumulated. The discipline that started in v0 has held across
twenty-plus phases.

The human owns architectural direction. You write briefs; specialised
agents on the human's machine implement them and produce reports
back. **You don't write implementation code yourself in this role.**
If asked to write code directly, push back unless it's a small
clarification snippet.

## What's most recent

**Phase 10.1** (latest, fully landed): MBR-partitioned hard-disk
boot. Outcome A — no source-code changes needed. The substrate
already implemented every BIOS call ELKS's bundled MBR Boot Manager
makes. The agent's diagnosis confirmed authentic CHS reads only (no
LBA extensions), and the integration tests pinned the boot end-to-
end for both `hd32mbr-fat.img` and `hd32mbr-minix.img`.

The Phase 10.1 report (`MBR_PARTITION_REPORT.md`) is the right
starting point for current state. Read its Summary and Diagnosis
sections; the Implementation section is "no changes" so it's brief.

After Phase 10.1, the user took a step back rather than dispatching
another brief. This handover refresh is part of that step-back.

## Where things live

Repo layout is unchanged in shape from v2; new directories and files
since Phase 6:

```
emu86/
├── src/
│   ├── core/              types, flags, registers, io interface
│   ├── memory/            PagedMemory + PageStore (RAM + IDB persistence + ROM regions)
│   ├── cpu8086/           the CPU; opcodes split across files; trap registry
│   ├── runtime/           async run loop
│   ├── interrupts/        InterruptController (queue + NMI)
│   ├── io/                BasicIOBus (port-handler registration)
│   ├── timing/            virtual Clock
│   ├── devices/           PIC8259, PIT8254, KeyboardController8042, UART16550
│   ├── machine/           IBMPCMachine (the wiring harness; now multi-disk-class capable)
│   ├── console/           Console interface + Node/in-memory impls + scancode-translator
│   ├── disk/              Disk interface + Node-file/in-memory impls (HD-aware)
│   ├── host-clock/        HostClock interface for RTC
│   ├── bios/              ROM image generator + TS-native BIOS handlers (incl. INT 19h HD)
│   ├── browser/           BrowserConsole, worker-host, message protocol
│   └── diagnostics/       Tracer, instrumentation overlays, CGA mirror, CLI probes
├── web/                   Vite-based browser harness; main thread, modal UI
├── tests/
│   ├── unit/              vitest suite
│   ├── integration/       end-to-end ELKS boot tests (floppy, serial, browser, HD, MBR)
│   └── sst/               SingleStepTests corpus harness (323 cases)
├── tools/
│   ├── elks/              run.ts (CGA harness), run-serial.ts (serial harness)
│   └── elks-build/        build-serial-image.ts, fetch-hd-image.ts
├── releases/              snapshot folders per phase (since Phase 9)
└── reference/
    ├── 8086tiny/          reference C emulator + BIOS source
    ├── elks/              ELKS kernel source (for diagnostics)
    ├── elks-images/       fd1440-minix.img (Phase 7's CGA harness target)
    ├── elks-images-serial/fd1440-fat-serial.img (Phase 8 onward)
    └── elks-images-hd/    hd32-fat.img, hd32mbr-fat.img (test fixtures, build-on-demand)
```

## Architectural principles (non-negotiable)

These have held across twenty-plus phases. Don't relax without
explicit human sign-off.

**`cpu.step()` is pure synchronous.** Async lives in the run loop
and (where appropriate) in device control planes. The CPU never
awaits, never throws across async boundaries. The browser worker
host runs the loop in its own thread but the loop itself remains
synchronous.

**The 8086 ISA is corpus-pure.** No custom opcodes ever. The
SingleStepTests corpus (323 cases × 9263 instructions per case ≈
3M+ assertions) validates every implemented instruction against
real silicon behaviour. Custom opcodes would mean opcodes the
corpus can't test.

**Layers compose; they don't know about each other.** PIC doesn't
know about InterruptController's callers; PIT doesn't know about
PIC; the Machine is the only place wiring happens. UART, keyboard,
and disk all follow this pattern.

**Memory is always resident, never faults.** PagedMemory
reads/writes are sync. ROM regions silently drop writes (real bus
behaviour). Persistence is async write-behind, separated from
access.

**Determinism over realism in tests.** No `Date.now()`, no
`setInterval`, no real timers in unit tests. Virtual `Clock`
advances when the run loop tells it to. **A new pattern emerged in
Phase 10.1**: when a test needs the host-clock to *appear* to
advance (e.g., for the MBR's auto-boot timeout), use a local
`AutoAdvanceHostClock` in the test rather than modifying the
substrate's `InMemoryHostClock`. Test-side workarounds are fine;
substrate determinism is sacred.

**Strict TypeScript.** No `any`, no `as unknown as`, no
`// @ts-ignore`. Every brief reinforces this; every report
confirms it stayed strict.

**Evidence over speculation.** When something doesn't work,
diagnose first. Don't grab-bag stubs hoping one will fix it. Phase
5, Phase 8, and Phase 9.3 are the canonical examples. Phase 10.1
is the canonical example of "the diagnosis was the work; no
implementation needed."

**Authentic emulation over convenience.** The user explicitly
chose authentic MBR chain-load over a virtual-shift translation
layer in Phase 10.1, on the grounds that authenticity matches the
project's posture. A user-toggle for the convenience path is on
the deferred-future list. When in doubt, emulate what real hardware
does.

## What's been built (the project arc through Phase 10.1)

Reading the project as a story, not a flat list:

**Substrate (Briefs 1-7).** The 8086 instruction set, validated to
the SST corpus, with IDB-persisted memory pages, an interrupt
controller, an IO bus, a virtual clock, the 8259 PIC, the 8254
PIT, and the IBMPCMachine wiring harness. By Brief 7 we had a
generic PC substrate that could run code; nothing PC-specific
above the device layer.

**BIOS path (Phases 1-6).** ROM regions, the trap registry,
TypeScript-native BIOS handlers (INT 10h video, INT 13h disk, INT
14h serial, INT 16h keyboard, INT 19h boot, INT 1Ah RTC), the 8042
keyboard controller, A20 modeling, the diagnose-driven push that
got past the boot wedge in Phase 5, and the extended runtime that
reached `login:` in Phase 6.

**Interactivity (Phase 7 + 7.1).** Scancode translation, keyboard
IRQ injection, the CGA framebuffer mirror, and a runnable
`tools/elks/run.ts` Node harness. Phase 7.1 made the CGA mirror
cursor-aware so the kernel banner rendered with correct row
breaks.

**Serial path (Phase 8).** The 16550 UART device. ELKS configured
to boot with `console=ttyS0` via a `/bootopts` edit on a freshly-
built FAT-formatted floppy. `tools/elks/run-serial.ts` is the
canonical Node harness from this point; the CGA harness still
works but isn't the daily-driver path.

**Browser harness (Phase 9 + 9.1 + 9.2 + 9.3).** Vite + Web Worker
+ xterm.js + IndexedDB. The worker hosts the emulator, posts UART
TX bytes to the main thread, receives RX bytes back. Phase 9.1
verified early-printk wiring (it was already correct; the
reported "blank window" was actually the kernel's pre-`set_console`
silence). Phase 9.2 added the settings modal and local image
upload; Phase 9.3 added the GitHub release browser.

**Hard-disk support (Phase 10 + 10.1).** Phase 10 added geometry
inference for HD-class images, INT 13h AH=08h hard-disk path,
INT 19h drive-number derivation by class, and routing the disk
class through `BootConfig`. Phase 10.1 verified MBR-partitioned
images run authentically — no source-code changes, the substrate
just worked.

**Releases.** Since Phase 9, every brief produces a self-contained
snapshot at `releases/phase-N-<slug>/` with both Node and browser
harnesses, the test fixtures, and a README. Reload-safe regression
A/B testing.

## How to ramp up after this handover

Read in this order:

1. **`MBR_PARTITION_REPORT.md`** (Phase 10.1) — the most recent
   work; current state.
2. **`HARDDISK_BOOT_REPORT.md`** (Phase 10) — the substrate work
   10.1 builds on. The unblocking checklist in Phase 9.3 was
   landed here.
3. **`BROWSER_HARNESS_REPORT.md`** (Phase 9) — the browser
   harness's architecture. Worker / main split, message protocol,
   IDB usage.
4. **`SERIAL_CONSOLE_REPORT.md`** (Phase 8) — the UART device and
   the ELKS-side configuration. The diagnose-first discipline at
   its clearest after Phase 5.
5. **`KEYBOARD_HARNESS_REPORT.md`** (Phase 7) — the substrate-end
   for interactivity. Scancode translator, CGA mirror.
6. **`ELKS_DIAGNOSIS_REPORT.md`** (Phase 5) — still the cleanest
   demonstration of the project's diagnose-first discipline.
   Worth re-reading even years on.
7. **`BIOS_SERVICES_REPORT.md`** (Phase 2) — the architecture of
   the BIOS layer. Foundational.
8. **`MACHINE_REPORT.md`** (Brief 7) — the system composition
   mental model.

Earlier reports as needed. The `emu86-INDEX.md` file lists everything.

## How to write briefs (the playbook)

The pattern that's worked, refined across the phases:

**Structure:**

- TL;DR (one paragraph, with success criterion and report
  filename)
- Hard rules (numbered list of non-negotiables; what's locked,
  what's allowed, what triggers stop-and-ask)
- Background (what the substrate already does that informs scope)
- Scope (what's in, with sections per concern)
- Section 1 — diagnosis when the brief is exploratory; this is
  mandatory for Phase 5 / 8 / 9.3 / 10.1-shaped work
- Implementation sections, with multiple acceptable outcomes
  (A/B/C) when there's real uncertainty
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

**Brief-writing principles that have repeatedly paid off:**

- **The "Watch out for" section earns its keep every time.** Spend
  real thought on what the agent would plausibly get wrong. Each
  correct call-out saves debugging time. The 8042 PS/2 Phase 4
  brief's "trace ring eviction" call-out saved hours; the Phase 7
  CGA mirror's "writeWord decomposes into two writeByte calls"
  call-out prevented a double-emit bug.
- **Multiple acceptable outcomes for exploratory work.** Phase 5
  introduced this; Phase 8 refined it; Phase 9.3 used it
  beautifully (GitHub browser shipped regardless of hard-disk
  diagnosis outcome). When uncertainty is real, the brief should
  say so and define what shipping looks like at each likely point.
- **Diagnosis can be the deliverable.** Phase 9.3's hard-disk
  diagnosis output became Phase 10's input. Phase 5's diagnosis
  unblocked Phase 6. Phase 10.1 *was* a diagnosis brief that
  happened to also pin the substrate's correctness in tests. Don't
  treat "we found out it's harder than we thought" as failure.
- **The lock-list discipline.** Every brief names which
  directories the agent can edit and which are locked. The locks
  protect the architecture. Phase 10's brief was the first to
  authorise specific lock-loosening (BIOS, machine, disk-router) —
  that authorisation is rare and named explicitly.
- **The "Things future briefs should address" section in every
  report.** Agent's notes about what they noticed that the next
  brief should know about. Consistently the most valuable input
  for the next brief — Phase 9.3's "hard-disk unblocking
  checklist" became Phase 10's brief almost verbatim.
- **Release snapshots since Phase 9.1.** Each completed phase
  drops a self-contained release folder so you can A/B test
  against earlier phases. Snapshot directive is now standard in
  every brief.

**What to push back on, when the human asks:**

- Bundling unrelated concerns into one brief. Settings + upload +
  GitHub-browser was a real example: I split it twice (first into
  settings+upload vs GitHub, then settings+upload only with GitHub
  as 9.3). The user agreed both times. Bundling means longer
  feedback loops and harder partial-completion recovery.
- Pre-implementing for futures. Phase 9.2's `source: 'upload' |
  'github'` discriminator was the right level of forward-compat
  (small, no migration cost when 9.3 lands); a full image-source
  abstraction would have been over-engineering.
- Silently relaxing rules. The hard-rule lists, the lock lists,
  the "don't fix-and-pray" instructions — these should never be
  weakened mid-conversation without explicit re-asking.

## Patterns to watch for

These have come up repeatedly:

**The "fix-and-pray" failure mode.** Agent sees something not
working, reaches for a stub or a hack hoping it'll work. The
discipline is to diagnose first, then implement the real fix. If
the toolchain isn't available, document and stop — Phase 8's "no
fix-and-pray on ELKS configuration" is the canonical instance.

**The "tempting expansion" failure mode.** Agent finishes the
brief's core work, sees an obvious adjacent improvement, and
expands scope. Briefs name what's NOT in scope explicitly to
counter this. Phase 7.1's "no CRTC tracking" callout is one
example; Phase 9.2's "no framework adoption" is another.

**The "diagnosis was wrong" failure mode.** A brief is shaped
around a diagnosis that turns out not to reproduce. Phase 9.1
was an instance — the brief expected to fix a 3-second blank
window, the agent diagnosed and found the wiring was already
correct. The right move is to verify the wiring as a regression
invariant and remove the misleading welcome text. Never
fabricate a problem to fix.

**The "honest tagging" principle.** When something has known
limitations (the GitHub browser's viability tags, the asset
download CDN's CORS unreliability), surface the limitation
honestly. Tags inform; they don't gatekeep. Documentation that
admits "we don't know if this works" is more valuable than
documentation that pretends.

**The "test the workaround at the right layer" principle.**
Phase 10.1's `AutoAdvanceHostClock` is a test-side helper, not a
substrate change. When something needs to behave differently for
a specific test, do it in the test — not by weakening the
substrate's deterministic guarantees.

## When to stop and ask

The brief-writing contract: **don't invent context you didn't
read; don't silently relax architectural rules; if you're unsure
between options, ask using `ask_user_input_v0` with a
recommendation afterwards.**

Concrete cases that should always trigger a question:

- Multiple plausible directions with materially different
  architectural implications (CGA-canvas vs network vs snapshot
  vs serial-only Phase 8 was exactly this shape).
- Scope decisions inside a brief (image upload semantics; theme
  picker scope; release-range to surface). Defaults can be
  proposed, but the user gets the final call.
- Outcomes that would loosen the lock list. If implementing
  Outcome A or B requires editing a locked directory, the report
  must surface this explicitly — never implement it silently.
- Something that contradicts a previous diagnosis. If Phase N's
  diagnosis claimed X and Phase N+1's work shows X is wrong,
  re-ask before continuing.
- The user's stated preference appears to conflict with the
  architectural posture. The authentic-vs-virtual-shift question
  was a clean instance — the brief committed to the user's call,
  but only after checking.

## Project state in numbers (Phase 10.1 close)

- 1,549 tests total (1,226 unit/integration + 323 SST corpus).
- All green. Strict TypeScript. No `any`. No `as unknown as`.
- 11 release snapshots since Phase 9.1.
- Boot times: ~11s (Phase 6 floppy), ~8s (Phase 8 serial floppy),
  ~14s (Phase 10 partitionless HD), ~24s (Phase 10.1 MBR HD,
  including the MBR Boot Manager's 3s timeout).
- Both Node and browser harnesses production-shaped: Vite build
  yields ~318 KB gzipped JS + a 1.44 MB image as static assets.

## What's next is open

After Phase 10.1, the user stepped back rather than dispatching
another brief. The natural directions, none currently chosen:

- **CGA-canvas browser frontend** — graphics-mode rendering for
  guests that don't use serial. The largest of the candidates.
- **Network device (NE2000)** — toward SSH-style remote use, the
  user's stated long-term direction. Architecturally interesting.
- **Snapshot / restore** — skip the boot. Quality-of-life win;
  test wall-time saver.
- **User toggle: authentic vs virtual-shift MBR boot** — small,
  completes the spectrum that Phase 10.1 left half-open.
- **Tiny: promote partitionless MINIX HD tag** — the
  `hd*-minix.img` viability tag is `untested` because Phase 10
  only verified FAT and Phase 10.1 only verified MINIX-on-MBR.
  Verifying partitionless MINIX is a five-minute brief.
- **Multi-disk machines** — `/dev/hda` + `/dev/hdb` simultaneously,
  pivot-root use cases. Substrate seam exists; nothing currently
  needs it.

When you pick up the next session: ask the user which direction;
recommend if you have a view; don't assume. The arc since Phase 7
has been ELKS-completion-focused; it's reasonable to either
finish out small Phase 10.x items or pivot to one of the bigger
arcs.

## What this handover replaces

This file (`emu86-handover-brief-v3.md`) replaces v2. v2 was
written at Phase 6 close; it's now stale on:

- The ELKS arc (Phases 7-7.1: scancodes, CGA mirror, runnable
  harness).
- The serial path (Phase 8: UART, ELKS reconfigured to ttyS0).
- The browser harness (Phase 9 + 9.1 + 9.2 + 9.3).
- Hard-disk support (Phase 10 + 10.1).
- The release snapshot pattern (introduced in Phase 9.1).
- The patterns-to-watch-for and stop-and-ask sections (refined).

Keep v2 in the knowledge base for historical record, but route
new readers to v3.
