# emu86

A 1980s PC written in plain TypeScript, booting a real Unix in your
browser tab. No WASM, no native code, no runtime dependencies beyond
TypeScript and vitest. Designed to be understandable first, fast
second.

**Live:** [8086-tab.net](https://8086-tab.net) (stable) — boots
unmodified [ELKS](https://github.com/ghaerr/elks) from real disk
images, logs itself in, keeps its own state across reloads, and puts
every open tab's machine on a shared network. There's an
[about page](https://8086-tab.net/about/) with the story.

It exists to answer a question for a different project: a browser
code editor needed an 8086 emulator, and the choice was pure
TypeScript versus C-compiled-to-WASM. This repo is the pure-TS arm
of that bet. Measured verdict so far: on genuine kernel workloads it
sustains ~half of a 4.77 MHz cycle budget under one-instruction-per-
cycle accounting — a standard no real 8086 met (a real XT was
~0.3–1 MIPS), so in delivered instructions it outruns the machine it
imitates; the authentic pacing mode exists to slow it DOWN to period
feel. Speed was never the problem.

## Status (2026-07-17)

Phases 1–18 complete, plus two post-phase feature lines (the network
freeze and the multi-PC rack) landed and gated, awaiting their field
pass before promotion; the live site runs the Phase 17 line. The
suite is 1,465 tests (plus the SingleStepTests corpus when fetched,
and an env-gated binary generator). 64 reports and 38 briefs record
how it got here — including the negative results.

What the machine does today:

- **Boots real operating systems**: ELKS floppy and 32 MB MINIX
  hard-disk images, unmodified — BIOS, PIT, PIC, RTC, UART, 8042,
  IDE disks, NE2000, all modeled honestly enough that the stock
  kernel probes them and finds them.
- **The un-typed boot**: a fresh tab formats its own home drive,
  seeds it, autologs in as `user1`, and performs its first-boot
  show — writing and compiling a C program with the toolchain on
  its own disk — exactly once per drive. Nothing is typed, ever.
- **The machine keeps its own state**: guest writes to the boot
  disk survive reloads via a block-level copy-on-write overlay
  (SHA-256-fingerprinted against the base image); each tab's
  `/dev/hdb` is a private fork with auto-persist; factory reset in
  settings is the escape hatch.
- **Networking between tabs**: every tab joins the Tab Area Network
  over a BroadcastChannel trunk — leased IPs, `.tabs` hostnames,
  guest-to-guest telnet. A gateway at `10.0.2.2` answers ping,
  serves a control API, and terminates real HTTP for the guest's
  `urlget` (CORS-bounded); DNS resolves over DoH at `10.0.2.3`.
- **Honest time**: guest seconds are wall seconds (authentic
  4.77 MHz pacing with a Turbo switch), and an MC146818 RTC serves
  real dates.
- **A host-side editor** over the tab's drive (`/mnt files` drawer):
  reads the running disk through our own MINIX v1 filesystem module,
  writes back with floppy-passing coherence (`resync` in the guest
  picks up edits), and follows the machine live.
- **Frozen in amber** (Phase 18): the whole machine — RAM, CPU,
  devices, clock, disks, even the terminal's screen — serializes to
  an exact state. F5 mid-game resumes mid-game; named save states
  restore from the inspector (a freeze-and-look popup with
  registers, devices, and guest-time-vs-uptime accounting); a
  duplicated tab can choose to clone the original's live session.
- **The network freeze**: the TAN tracks its TCP connections now,
  and when a tab dies its peers freeze their CPUs until it resumes
  (10 s cap) — under "frozen wall time never becomes guest time," a
  reload is invisible to both ends of a telnet session. tab-shark
  (`/tabshark.html`) is the passive analyzer that watches it all:
  decoded frames, live connection table, freeze/thaw events.
- **The rack** (`/rack.html`): one tab, many machines — an
  explorer-style rail of PCs, each the full app in an iframe on the
  shared network. Adopt saved machines, migrate a running PC out of
  its tab (open connections ride through the move), refresh the
  whole rack and every machine resumes, and save the lot as one
  infrastructure package.

## Quick start

```bash
npm install
npm run dev:browser    # vite dev server — the full browser harness
npx vitest run         # the suite (≈15 min; targeted runs are fine day-to-day)
npm run typecheck      # all three tsconfigs
npm run start:elks-serial   # boot ELKS at a terminal, no browser
```

Deployment is two-tier and not git-triggered: `npm run deploy:dev`
(testing) and `npm run deploy:prod` (stable; follow
`RELEASE_PROCEDURE.md` — every promotion archives the outgoing
version). The full suite gates every deploy.

## Architecture

```
web/                    browser main thread: settings, image library (IDB),
                        drive forks, overlay store, editor panel, show relay;
                        extra pages: rack.html (multi-PC), tabshark.html
                        (TAN analyzer), moved.html (migration stub)
src/browser/            the worker: WorkerHost (boot/run/protocol), pacing,
                        bootopts patch, per-boot image stamps
src/machine/            IBMPCMachine — composes everything below
src/cpu8086/ src/core/  the CPU: sync step(), full 8086 opcode set
src/memory/             PagedMemory — sync, never faults
src/devices/ src/io/    PIT, PIC, UART, 8042, RTC, NE2000, IO bus
src/bios/               TS BIOS behind a trap registry (INT 10/13/16/19/1A…)
src/disk/               disks, the COW overlay engine, minix-fs (read/write)
src/net/                switch, gateway, DNS/DoH, TCP, HTTP gateway, TAN, control
src/interrupts/ src/timing/ src/host-clock/ src/runtime/ src/diagnostics/
tools/elks*/            CLI boot + image build/fetch scripts
tests/                  unit / integration / sst (the corpus harness) / probe
reference/              8086tiny + ELKS submodules (source-of-truth reading)
```

## Design principles (unchanged since v0)

1. **Synchronous CPU core.** `cpu.step()` never awaits and memory
   never faults. All async lives at the edges: the worker's paced
   loop, boot-time image work, main-thread persistence.
2. **All memory resident.** 1 MiB fits in any tab; the async
   machinery is for persistence, not memory pressure.
3. **The worker never persists.** Disk deltas sweep to the main
   thread as messages; main owns all IndexedDB. Reads on the hot
   path never leave RAM.
4. **The counterparty is the contract.** Devices are written against
   what the guest's source actually does, verified in the ELKS
   submodule — the datasheet doesn't boot.

## Testing

Unit and integration tests run everywhere (`npx vitest run`);
integration boots real ELKS images end-to-end through the same
message protocol the browser uses. The CPU answers to an external
oracle: the [SingleStepTests/8088](https://github.com/SingleStepTests/8088)
corpus (fetch it and symlink its `v2/` at `tests/sst/data/` when
touching opcode semantics — it is the correctness backbone).

## How work happens here

Brief → implement → report, every phase. The briefs
(`emu86-phase*-brief.md`) set scope before code; the reports
(`*_REPORT.md`) are the project's memory — findings, measurements,
and explicitly what was *not* done. Agents start at `CLAUDE.md`.

## Credits

Built on the shoulders of [ELKS](https://github.com/ghaerr/elks)
(Greg Haerr and contributors),
[8086tiny](https://github.com/adriancable/8086tiny) (Adrian Cable —
the original correctness reference),
[SingleStepTests](https://github.com/SingleStepTests/8088), and
[xterm.js](https://xtermjs.org).

MIT licensed (see `LICENSE`). © 2026 Jonathan Annett · built with Claude
