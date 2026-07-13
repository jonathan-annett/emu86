# emu86 — Handover Brief (Refreshed Post-Phase 6)

You are picking up a project mid-flight. This document is your fastest path to being useful. Read this first; then read `emu86-milestone-summary.md` for the full arc; then go to the latest reports for current depth.

## What this project is

A browser-oriented TypeScript x86 emulator framework. **Current state: boots ELKS (Linux for 8086) headless to a `login:` prompt in 11 seconds wall-clock.** Real Linux kernel + userland (`/etc/rc.sys`, `/sbin/init`) running on our TypeScript 8086 emulator. 1029 tests + 3,007,000 SingleStepTests corpus cases passing. Strict TypeScript, no escape hatches, no architectural debt.

The human owns architectural direction. You write briefs; specialised agents on the human's machine implement them and produce reports back. You don't write implementation code yourself in this role. If asked to write code directly, push back unless it's a small clarification snippet.

**Current brief in flight: Phase 7** — keyboard input plumbing, CGA framebuffer mirroring, and a runnable Node ELKS harness. When the report arrives, the next brief is shaped by what's in it.

## Where things live

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
│   ├── devices/           PIC8259, PIT8254, KeyboardController8042
│   ├── machine/           IBMPCMachine (the wiring harness)
│   ├── console/           Console interface + Node/in-memory impls
│   ├── disk/              Disk interface + Node-file/in-memory impls
│   ├── host-clock/        HostClock interface for RTC
│   ├── bios/              ROM image generator + TS-native BIOS handlers
│   └── diagnostics/       Tracer, instrumentation overlays, CLI probes
├── tests/
│   ├── unit/              vitest suite
│   ├── integration/       end-to-end ELKS boot tests + diagnostic probes
│   └── sst/               SingleStepTests corpus harness
└── reference/
    ├── 8086tiny/          reference C emulator + BIOS source (for contracts)
    ├── elks/              ELKS kernel source (for diagnostics)
    └── elks-images/       boot images (fd1440-minix.img is the working one)
```

The reports at the project root are the durable record. Read in this order to ramp up after the milestone summary:

1. `ELKS_ROOT_MOUNT_REPORT.md` (Phase 6) — most recent, has current state
2. `ELKS_DIAGNOSIS_REPORT.md` (Phase 5) — the cleanest demonstration of project discipline
3. `BIOS_SERVICES_REPORT.md` — the architecture of the BIOS layer
4. `MACHINE_REPORT.md` — the system composition mental model
5. Earlier reports as needed

## Architectural principles (non-negotiable)

These have held across nine sessions. Don't relax them without explicit human sign-off.

**`cpu.step()` is pure synchronous.** Async lives in the run loop and (where appropriate) in device control planes. The CPU never awaits, never throws across async boundaries.

**The 8086 ISA is corpus-pure.** No custom opcodes ever. The SingleStepTests corpus (3M cases) validates every implemented instruction against real silicon behaviour. Custom opcodes would mean opcodes the corpus can't test.

**Layers compose; they don't know about each other.** PIC doesn't know about InterruptController's callers; PIT doesn't know about PIC; the Machine is the only place wiring happens. New devices follow this pattern.

**Memory is always resident, never faults.** PagedMemory reads/writes are sync. ROM regions silently drop writes (real bus behaviour). Persistence is async write-behind, separated from access.

**Determinism over realism in tests.** No `Date.now()`, no `setInterval`, no real timers in unit tests. Virtual `Clock` advances when the run loop tells it to.

**Strict TypeScript.** No `any`, no `as unknown as`, no `// @ts-ignore`. Every brief reinforces this; every report confirms it stayed strict.

**Evidence over speculation.** When something doesn't work, diagnose first. Don't grab-bag stubs hoping one will fix it. Phase 5 is the canonical example of this discipline paying off.

## How to write briefs (the playbook)

The pattern that's worked:

**Structure**:
- TL;DR (one paragraph, with success criterion and report filename)
- Hard rules (numbered list of non-negotiables)
- Scope (what's in, what's explicitly out)
- Design (interfaces, file layout, decision rationale)
- Test plan (per-component test counts and shapes)
- Watch out for (the bug magnets — call them out before they bite)
- Stop and ask (when to surface back to human rather than push through)
- Definition of done (test counts, typecheck, corpus regression, report sections)
- Reference sources

**The "Watch out for" section earns its keep every time.** Spend real thought on what the agent would plausibly get wrong. Each correct call-out saves debugging time.

**Always require a report at a named filename.** Per-section structure in the report definition makes the report comparable across briefs and helps the agent self-check coverage.

**"Things future briefs will need" section in every report** — agent's notes about what they noticed that the next brief should know about. These have been consistently the most valuable input for the next brief.

**Ask the human before scoping decisions** with `ask_user_input_v0`-style questions when the answer materially shapes the work. Don't assume.

**Brief size**: target ~one focused unit of work. Five-stage briefs that span multiple architectural concerns produce muddy outcomes. Two clean smaller briefs > one large mixed one.

**For exploratory briefs (like Phase 3, 5, 6)**: define multiple acceptable success outcomes, each with definition-of-done. Don't force a binary. Document-quality is a valid success.

## Patterns the agents do well

- They follow strict TypeScript discipline without being reminded
- They add small smart things one step ahead of the brief (e.g., `outputBytes` alongside `output` for raw-byte assertions; configurable `installExitHook` for test environments; reading the CGA framebuffer when InMemoryConsole went silent in Phase 6)
- They report honest deviations rather than hide them
- They read existing code before writing new code
- They flag forward concerns ("Phase X will need...") in reports

## Patterns to watch for and steer

- Tendency to over-test simple things (the 8254 PIT brief had ~50 tests for a state machine; not wrong, but the agent will sometimes test the polyfill itself if you don't say "don't")
- Tendency to silently relax a constraint when it gets hard. Hard rules in the brief prevent this.
- Tendency to invent helper abstractions speculatively. Counter with explicit "concrete only, no abstract base class until there are two concrete implementations."
- Tendency to take pre-authorized stubs even when diagnosis doesn't indicate them. Phase 5's brief explicitly said "no fix-and-pray" and the agent honored it; this discipline must be re-asserted in every brief that pre-authorizes additions.

## Open work

**Just completed**: Phase 6 — ELKS reaches `login:` prompt headless. 1029 tests + 3M corpus, all green, no architectural debt. 25M instructions in 11 seconds wall-clock.

**In flight**: Phase 7 (keyboard harness brief). When the report arrives, write the next brief based on its contents. Likely topics depending on what the report shows:
- If the harness lands cleanly: browser deployment, 286 real mode, snapshot/save-restore, real-time pacing, or other devices
- If something surfaced (CPU bug, missing BIOS service): a focused fix brief

**Phase 7 known risks** (worth being aware of when reading the report):
- Scancode timing — keyboard injection may be too fast for kernel's IRQ 1 handler to keep up
- Ctrl-C handling — needs to be a scancode to ELKS, not a SIGINT to our process; magic-prefix quit instead
- CGA mirror simplifications — overwrites and scrolls produce visual garble; document, don't try to perfect
- The kernel's IRQ 1 handler must EOI to PIC — if it doesn't, we deadlock the same way Phase 4 did on IRQ 0

**Beyond Phase 7** (in rough independent priority, depending on outcome):
- Browser deployment (Vite-based UI, browser-side Console + Disk)
- Real-time pacing layer
- 80286 real mode (planned roadmap; clean extension of CPU8086)
- Save/restore of full machine state
- More devices: serial UART, real DMA, MC146818 RTC, VGA
- Cascaded PICs (for AT-class machines and IRQs > 7)
- Sub-batch event scheduling (PIT loses ticks at fast divisors with large batches)
- Other guest OSes (DOS, Minix, FreeDOS)

## Things we already tried and rejected

Brief notes only. Detail in reports' "deviations" or "rationale" sections.

- **Page-fault-and-retry memory model** — initially considered for v0; rejected in favour of always-resident with async write-behind.
- **Custom 8086 opcodes for BIOS host calls** — 8086tiny does this. We don't. Reasoning: TypeScript is our microcode, not a C-style instruction-decoder switch; clean trap-based dispatch via the trap registry achieves the same outcome without ISA pollution. Documented in `BIOS_SERVICES_REPORT.md`.
- **Pure-ASM BIOS with emulated FDC/IDE** — rejected on perf grounds.
- **Wall-clock-driven device timing** — rejected for tests. Virtual `Clock` is the abstraction; wall-clock pacing is a separate future layer.
- **Abstract `Machine` base class** — deferred. Not premature-abstraction until there's a second concrete machine.
- **Custom 8086tiny BIOS image as our BIOS** — considered briefly during Phase 8 (BIOS services) design; rejected in favour of writing our own thin TS-native BIOS.
- **Pre-authorized fix stubs without diagnosis** — Phase 5 deliberately rejected slave PIC and DMA stubs that the brief had pre-authorized, because diagnosis showed they weren't needed. Discipline: every implementation must be motivated by specific evidence.

## Tone notes

The human:
- Prefers concise responses. No preamble, no recapping their question.
- Knows the architecture; explain decisions, not concepts they already grasp.
- Asks "are you sure?" pointedly when they think you're about to go wrong. Take the question seriously and reconsider; don't defend the original direction reflexively.
- Values you flagging your own state honestly (memory pressure, uncertainty, where you'd want a second opinion).
- Has been generous with autonomy. Use it well.

When using `ask_user_input_v0`, give them the option you'd recommend by stating it after the tool call. They like making decisions with a recommendation in front of them rather than ranking blank options.

## Final note

The architecture has held across nine sessions because we kept refusing shortcuts that would have compromised it. That discipline is the project. Don't spend the budget you've earned.
