# emu86 — Project Index (Refreshed Post-Phase 13)

You're picking up a TypeScript x86 emulator project that boots ELKS
(Linux for 8086) in either a Node terminal or a browser. This file
orients you. Read these in order.

## Start here (5–15 min)

1. **`emu86-handover-brief-v4.md`** — canonical orientation.
   Architecture principles, file layout, current state, brief-writing
   playbook. The single most important file. (Supersedes v3 and v2.)
2. **`PROBE_HARNESS_EXTENSION_REPORT.md`** (Phase 12.1 / 13.1) —
   when it lands, the most recent completed work. Tells you whether
   in-VM dogfooding is viable or the cross-compile path is correct.
   Phase 14's shape depends on this verdict.
3. **`emu86-networking-plan.md`** — the agreed architectural shape
   for the networking arc (Phase 14 onwards). Read alongside the
   verdict in #2 to draft Phase 14.

If you only read three files, those three. Stop here unless you need
depth.

## Most recent state

- **`PROBE_HARNESS_EXTENSION_REPORT.md`** (Phase 12.1 / 13.1, when
  landed) — settles the in-VM dogfooding question.
- **`TOOLCHAIN_SURVEY_REPORT.md`** (Phase 13) — Outcome C: survey
  blocked by harness boot budget; HD32 images contain Dev86
  compiler binaries by name; function unverified.
- **`PROBE_HARNESS_REPORT.md`** (Phase 12) — reusable test-side
  framework for probe-script-driven investigations.

## Briefs (the contracts under which work was done)

In project order. Each brief specifies hard rules, scope, design,
tests, and a named report file.

**Substrate** (CPU through Machine — Briefs 1-7, pre-phasing):

- `emu86-agent-brief.md` — Brief 1: complete the 8086 instruction set
- `emu86-corpus-validation-brief.md` — Brief 2: SingleStepTests
  corpus validation
- `emu86-idb-page-store-brief.md` — Brief 3: IndexedDB persistence
- `emu86-interrupt-delivery-brief.md` — Brief 4: async interrupt
  delivery
- `emu86-pic-brief.md` — Brief 5: 8259 PIC + IOBus
- `emu86-pit-brief.md` — Brief 6: virtual Clock + 8254 PIT
- `emu86-machine-brief.md` — Brief 7: first IBMPCMachine composition

**BIOS and ELKS path** (Phases 1-6):

- `emu86-bios-infra-brief.md` — Phase 1: ROM regions, trap registry
- `emu86-bios-services-brief.md` — Phase 2: TS-native BIOS handlers
- `emu86-elks-boot-brief.md` — Phase 3: first attempt at booting ELKS
- `emu86-ps2-a20-brief.md` — Phase 4: 8042 keyboard controller + A20
- `emu86-elks-diagnosis-brief.md` — Phase 5: diagnose-then-fix
- `emu86-elks-root-mount-brief.md` — Phase 6: extend run, reach login

**Interactivity** (Phase 7):

- `emu86-keyboard-harness-brief.md` — Phase 7: keyboard + CGA mirror
- `emu86-cga-cursor-brief.md` — Phase 7.1: cursor-aware CGA mirror

**Serial path** (Phase 8):

- `emu86-serial-console-brief.md` — Phase 8: 16550 UART + ELKS serial

**Browser harness** (Phases 9 — 9.3):

- `emu86-browser-harness-brief.md` — Phase 9: Vite + Worker + xterm.js
- `emu86-early-printk-brief.md` — Phase 9.1: verify early-printk path
- `emu86-browser-polish-brief.md` — Phase 9.2: settings + upload
- `emu86-github-browser-brief.md` — Phase 9.3: GitHub releases browser

**Hard-disk** (Phases 10 — 10.2):

- `emu86-harddisk-boot-brief.md` — Phase 10: partitionless HD
- `emu86-mbr-partition-brief.md` — Phase 10.1: MBR-partitioned HD
- `emu86-minix-hd-brief.md` — Phase 10.2: partitionless MINIX HD

**Multi-disk substrate** (Phases 11 — 11.6):

- `emu86-multi-disk-brief.md` — Phase 11: two simultaneous disks
- `emu86-ramdisk-brief.md` — Phase 11.5: `/dev/rd0` verification
- `emu86-minix-serial-brief.md` — Phase 11.6: MINIX serial floppy

**Probe harness arc** (Phases 12 — 13):

- `emu86-probe-harness-brief.md` — Phase 12: reusable probe harness
- `emu86-toolchain-survey-brief.md` — Phase 13: toolchain survey
- `emu86-probe-harness-extension-brief.md` — Phase 12.1 / 13.1
  (in flight)

## Reports (immutable findings)

In project order.

**Substrate**:

- `SESSION_REPORT.md` — 8086 instruction set completion
- `CORPUS_VALIDATION_REPORT.md` — SST corpus validation
- `IDB_PAGE_STORE_REPORT.md` — IndexedDB persistence
- `INTERRUPT_DELIVERY_REPORT.md` — async interrupt delivery
- `PIC_REPORT.md` — 8259 PIC + IOBus
- `PIT_REPORT.md` — 8254 PIT + virtual Clock
- `MACHINE_REPORT.md` — IBMPCMachine composition

**BIOS and ELKS path**:

- `BIOS_INFRA_REPORT.md` — Phase 1
- `BIOS_SERVICES_REPORT.md` — Phase 2
- `ELKS_BOOT_REPORT.md` — Phase 3
- `PS2_A20_REPORT.md` — Phase 4
- `ELKS_DIAGNOSIS_REPORT.md` — Phase 5 (canonical discipline example)
- `ELKS_ROOT_MOUNT_REPORT.md` — Phase 6 (reaches `login:`)

**Interactivity**:

- `KEYBOARD_HARNESS_REPORT.md` — Phase 7
- `CGA_CURSOR_REPORT.md` — Phase 7.1

**Serial path**:

- `SERIAL_CONSOLE_REPORT.md` — Phase 8

**Browser harness**:

- `BROWSER_HARNESS_REPORT.md` — Phase 9
- `EARLY_PRINTK_REPORT.md` — Phase 9.1
- `BROWSER_POLISH_REPORT.md` — Phase 9.2
- `GITHUB_BROWSER_REPORT.md` — Phase 9.3

**Hard-disk**:

- `HARDDISK_BOOT_REPORT.md` — Phase 10
- `MBR_PARTITION_REPORT.md` — Phase 10.1
- `MINIX_HD_REPORT.md` — Phase 10.2

**Multi-disk**:

- `MULTI_DISK_REPORT.md` — Phase 11
- `RAMDISK_REPORT.md` — Phase 11.5
- `SERIAL_MINIX_REPORT.md` — Phase 11.6

**Probe harness arc**:

- `PROBE_HARNESS_REPORT.md` — Phase 12
- `TOOLCHAIN_SURVEY_REPORT.md` — Phase 13 (Outcome C)
- `PROBE_HARNESS_EXTENSION_REPORT.md` — Phase 12.1 / 13.1 (pending)

## Architectural planning documents

- **`emu86-networking-plan.md`** — agreed shape for the networking
  arc (Phase 14 onwards). Two-layer plan: NE2000 + virtual switch
  + pseudo-hosts (DNS, HTTP gateway via fetch, optional NTP/ICMP),
  plus `webget` HTTPS escape hatch via second UART. Read alongside
  the Phase 12.1 / 13.1 verdict to draft Phase 14.

## Meta-process (the conversation)

- **Chat archives** — the planning conversations across the project.
  Reports document what was done; chats capture *why* decisions were
  made and the brief-writing rhythm that emerged. Particularly
  valuable for: the custom-opcode near-miss in Phase 2; the
  authentic-vs-virtual-shift call in Phase 10.1; the in-place-hex-
  edit-as-first-best-choice pattern from Phase 11.6; the two-layer
  networking decision.

## Superseded files

- `emu86-handover-brief.md` — v1, very stale.
- `emu86-handover-brief-v2.md` — v2, Phase 6 close.
- `emu86-handover-brief-v3.md` — v3, Phase 10.1 close.
- `emu86-milestone-summary.md` — substrate-arc material valid;
  stale on subsequent work.

## Project repo

The actual codebase lives outside this knowledge base, on the
human's machine. Reports reference paths like `src/cpu8086/`; those
refer to the repo, not files in this knowledge base.

Each completed phase since 9.1 produces a self-contained release
snapshot at `releases/phase-N-<slug>/` on the human's machine.
These let the user A/B test against earlier phases when chasing
regressions.

## Briefs in flight

**`emu86-probe-harness-extension-brief.md` (Phase 12.1 / 13.1)** —
combined harness boot-budget extension and HD32 version probe.
Drafted; awaiting agent run. The verdict it produces settles
whether Phase 14 takes the in-VM dogfooding shape or the
host-cross-compile shape.

## How to use this knowledge base

You're a fresh planning instance. Your contract:

1. Read `emu86-handover-brief-v4.md` first.
2. Read the most recent report.
3. Read `emu86-networking-plan.md` if Phase 14+ is on the agenda.
4. Consult older briefs/reports only as needed.
5. Produce either a next brief or a question for the human. Don't
   invent context you didn't read. Don't silently relax architectural
   rules.
6. Update `emu86-handover-brief-v4.md` (or create v5) if your work
   materially changes the project state.

The architecture has held across this many phases. Don't
compromise it. **Teach a man to fish, don't just give him a fish
snack** — that's the user's stated philosophy and it's been the
project's actual posture throughout.
