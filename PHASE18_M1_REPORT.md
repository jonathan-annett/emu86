# Phase 18 M1 report — the state plane + equivalence harness

Landed 2026-07-16. Brief: `emu86-phase18-brief.md` §3 M1, executed under
D1 (same-tab shapes first) and D6's recommended posture (exact-state for
every §1.2 device, harness-enforced). **No device proved intractable —
nothing was downgraded to reset-plus-fixups.**

## 1. What landed

Every §1.2 component now has a versioned serialize/restore pair, and the
§1.6 harness proves them over a real ELKS boot:

| Component | Pair | State carried |
|---|---|---|
| `PagedMemory` | `serializeState()/restoreState()` (+`getPageBytes`) | every resident RAM page, sorted by pageId; ROM excluded |
| `CPU8086` | existing `snapshot()/restore()`, **fixed** | + `interruptInhibit` (the 13-phase gap) |
| `BasicInterruptController` | new pair | maskable FIFO (order preserved) + `nmiPending` |
| `PIC8259` | new pair | IRR/ISR/IMR, vector base, **mid-ICW init state machine**, trigger mode, OCW3 read selector |
| `PIT8254` | new pair | all 3 channels × full state (latched count AND status, both flip-flops, half-written lohi divisor, mode-3 phase, pending divisor) + the sub-tick cycle residual |
| `UART16550` | new pair | registers, divisor, RX FIFO, overrun, and the private IRQ trio `irqPending`/`pendingIIRSource`/`thriArmed` |
| `KeyboardController8042` | new pair | OBF byte+flag, **multi-byte command state** (`nextDataWriteIs`), command byte, P2, scancode queue |
| `RTC146818` | new pair | index + 128-byte CMOS scratch only — time stays wall-served, resume-correct by construction |
| `NE2000` | new pair | full register file, 16 KiB packet ring, PROM, **mid-flight remote-DMA engine**, IRQ level, rx/irq counters |
| `Clock` | `now()` + new `restoreCycles()` | cycle counter, restored silently |
| `EthernetSwitch` | new pair | CAM as (mac → port **name**) + runt counter |
| `LanGateway` / `DnsHost` | new pairs | ARP tables, IP-ID counters, diagnostics counters |
| machine level | `src/machine/machine-state.ts` | `MachineState` + `captureMachineState()`/`restoreMachineState()` |

The two rule-3 state-plane additions are exactly as scoped in brief §5:
`PagedMemory.getPageBytes`/`serializeState`/`restoreState` and
`Clock.restoreCycles`. Nothing else in the substrate changed shape.

## 2. Design decisions (and their whys)

**Naming and versioning.** Devices use `serializeState()/restoreState()`
(the CPU keeps its existing `snapshot()/restore()` per the brief). Every
serialized form opens with `v: 1` and every restore throws on an
unknown version — the settings key-per-era lesson, applied from day one.
All forms are structured-cloneable (plain objects + `Uint8Array`), ready
for M2's IDB tenant and worker messages without translation.

**Restores never fire callbacks.** No `onIRQ*`, no `onTransmit`, no
`controller.raise`, no PIT edges. Rationale, uniform across devices:
every edge that fired before capture is already reflected in the
captured PIC/controller state; re-firing at restore double-delivers it.
The same argument shapes two subtler choices:

- `PIC8259.restoreState` does NOT run `updatePending()`. A captured
  IRR bit that *could* forward can only exist because something blocked
  it at capture (higher-priority ISR bit, mid-init) — the captured
  state is self-consistent with the captured controller FIFO, and the
  next assert/IMR-write/EOI re-evaluates exactly as the original would.
- `NE2000.restoreState` writes `#irqLevel` directly, so a level that
  was high stays high without a duplicate edge.

The unit suite asserts the no-callback property per device; the
equivalence harness enforces the consequence (no double-delivered
interrupts anywhere in a live boot).

**RAM restore drops stale pages.** `restoreState` deletes resident RAM
pages absent from the snapshot (they were all-zero-equivalent at
capture). This makes the resident set — not just the bytes — round-trip
exactly, which the harness relies on. Restored pages enter the dirty
set: a backing store, when present, must be told. ROM pages are never
serialized, never touched, and a snapshot page colliding with a
resident ROM page throws (config mismatch, fail loud).

**`Clock.restoreCycles` is silent** (like `reset()`, a discontinuity
not an advance): notifying would tick the PIT across the whole restored
span, double-counting time the captured machine already lived through.
The PIT's own residual rides in its own serialization.

**CPU: what's in, what's out, with evidence.** `interruptInhibit` is in
— it is legal cross-boundary state (the STI window), and the unit suite
includes a behavioral proof: a restored inhibit window suppresses
exactly one boundary check. `repPrefix` is OUT, deliberately: the REP
dispatcher sets and clears it inside a single `step()` via `try/finally`
(`opcodes-string.ts:183-184`), so it can never be non-null at a step
boundary. `segOverride` stays in the snapshot (pre-existing); note it
is dead at boundaries anyway — `step()` nulls it before fetch.

**NE2000 carries its PROM.** The PROM is constructor-derived from the
MAC, but a snapshot must be exact regardless of what MAC the restore
target was constructed with. Whether a clone *should* keep the parent's
MAC is D5's already-decided territory (trunk-detached, v1) — this layer
just refuses to lose information. Diagnostics counters
(`rxAccepted`/`rxDropped`/`irqEdges`, gateway/DNS counters, switch
runts) are carried too: cheap, and a restored machine's `inspectRx()`
story stays honest.

**Net-side laptop-resume drops (brief §1.3, applied).** NOT serialized,
deliberately: gateway `pendingPings` (queued behind an ARP whose reply
belongs to the pre-capture wire), DNS in-flight resolves and per-
connection query buffers, and both hosts' `TcpStack` connections (the
stack RSTs segments for unknown conns; host-terminated flows die
honestly). The ARP tables and switch CAM ARE serialized — recon hard
problem 5: they learn only from ARP frames, a restored guest may never
re-ARP, and dropping them kills networking silently.

**Switch CAM restores by port name.** Ports are wiring, not state; the
worker attaches with stable unique names (`ne2000`, `gateway`, `dns`).
A CAM entry naming an unattached port throws — a silently thinner CAM
is the exact failure the serialization exists to prevent.

**Machine-level restore follows §1.1 to the letter.** Reset as the
clean baseline, RAM first, devices in the machine's reset order, clock
silently, CPU registers LAST. Reset-then-overwrite, never
reset-after-restore. `MachineState` deliberately does NOT carry disk
bytes — a snapshot is consistent only with its disks (§1.4), but what
restore feeds the primary is D2's open call, so the pairing lives with
the caller (the harness pairs a byte-copy of the source disk; M2's
protocol will do it per D2). RTC posture (present/absent) is checked in
both directions and throws on mismatch.

## 3. The harness (brief §1.6 — LAW), and what it proved

`tests/integration/state-equivalence.test.ts`, over the committed
`hd32-fat.img` with the `elks-hd-boot.test.ts` bootopts patch (serial
console, `init=/bin/sh`). Deterministic by construction:
`InMemoryHostClock`, `InMemoryDisk`, no keyboard, UART TX to an array,
NIC unplugged, and a stepping loop whose every decision is a pure
function of machine state (traceRun's convention: `advance(1)` per
instruction, 1000-cycle halt-spins).

Two checkpoints, both green:

1. **Early boot** (N=500k, M=250k): capture mid-kernel-init, restore
   into a fresh machine, round-trip identity BEFORE stepping, then
   250k instructions on both — RAM, every device serialization, CPU,
   clock, and the full 32 MB disk image byte-identical.
2. **Post-prompt, live continuation** (N=16M to the `#` prompt, M=4M):
   capture the idle shell, restore, inject `echo amber-ok\n` into BOTH
   machines at the same state — the restored machine executes the
   command with **byte-identical serial output**, returns to the
   prompt, and every last bit of state + disk agrees.

Comparison is `tests/state-diff.ts` — a plain-loop structural walker
that reports path + index + both values, capped at 24 diffs (the
toEqual-on-MB lesson stands).

Unit coverage: `tests/unit/state-serialization.test.ts` (26 tests) —
round-trip identity per pair, the mid-operation states specifically
(mid-ICW, half-written lohi divisor + latched status, mid-remote-DMA,
pending 0xD1), the no-callback property, and behavioral continuation
(restored PIT ticks/edges identically; restored NIC completes its
interrupted DMA read and keeps receiving; restored 8042 completes the
pending output-port write).

## 4. Findings surfaced along the way

- **`IBMPCMachine.reset()` does not reset the NIC.** The reset list
  (`ibm-pc.ts` `reset()`) covers CPU, controller, PIC, PIT, RTC, KBC,
  UART, clock — the NE2000 (added Phase 14) never joined it.
  Pre-existing, unchanged here (rule 3: surface, don't refactor);
  `restoreMachineState` restores the NIC unconditionally so the
  omission cannot leak stale NIC state through a restore. Worth its
  own small ruling — a guest rebooting via the BIOS path today keeps
  NIC ring state a real 8390 would keep anyway (register file survives
  reset on real silicon), so it may even be correct as-is.
- **The 16550 RX FIFO bit the harness first.** A 21-byte injected
  command line overruns the 16-byte FIFO and the tail drops (correct
  16550A semantics — both machines dropped it identically; the
  equivalence still held). The harness command is 14 bytes. Anything
  M2 builds that types into a restored machine wants paced injection,
  same as the existing interactive tests.
- **PIC test-authoring trap:** ICW1 `0x11` means *cascade* — the chip
  then consumes ICW3, and what looks like OCW1 lands as ICW4. Single-
  PIC test sequences want `0x13`. (The PIC itself handles both; only
  the test was wrong.)
- **Console state is not guest-readable state.** INT 10h cursor lives
  in the BDA (guest RAM — carried); the `Console` object holds only
  host-side output and an input queue. Nothing to serialize at this
  layer; confirmed by the harness holding at an early-boot checkpoint
  where INT 10h is still the active console path.

## 5. Deliberately NOT done (M1 scope walls)

- No capture/restore protocol, no UI, no `emu86-machines` IDB tenant —
  M2, per the brief.
- No disk bytes in `MachineState` — D2 is Jonathan's open call
  (recommended (a) self-contained); the harness demonstrates the
  pairing obligation without pre-deciding the storage form.
- No TAN lease/state serialization — §1.3: NEVER cloned; re-acquire.
- No HttpGateway/TcpStack connection serialization — host-terminated
  flows drop by law.
- No pacer integration (`#pacer.skip()` is the M2 restore path's job;
  this layer's clock restore is already silent).
- No browser PageStore/dirty-set semantics beyond marking restored
  pages dirty — there is still no browser PageStore (recon fact 3).

## 6. Test evidence

- `npm run typecheck` — clean across all three configs.
- New: 26 unit tests (`state-serialization`) + 2 integration tests
  (`state-equivalence`, ~22 s total, both green).
- Full suite (2026-07-16): **1,370 passed | 1 skipped tests; 127 test
  files passed, 2 skipped** (the standing skips: SST corpus + the
  env-gated ping-binary generator), zero failures, 773 s. Prior
  baseline 1,342 passed (Phase 17 close); the +28 delta is exactly
  the new tests.
