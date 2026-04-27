# Virtual Clock + 8254 PIT — Implementation Report

## Summary

The virtual-time clock and the 8254 PIT (the second device on the
IOBus + PIC stack) are in place. The clock is a small subscription hub;
the PIT subscribes and counts down three independent channels at a
configurable cycles-per-PIT-tick ratio. The run loop now optionally
calls `clock.advance()` after each batch (additive — existing tests
without a clock are unaffected). An end-to-end integration test wires
PIT channel 0 → PIC IRQ 0 and confirms the whole pipeline ticks.

- **Test counts**: 519 unit tests pass (was 477 baseline → +42 new):
  - 12 in `tests/unit/clock.test.ts`
  - 29 in `tests/unit/pit.test.ts`
  - 1  in `tests/unit/cpu-pit-pic-integration.test.ts`
- **Typecheck**: clean (`npm run typecheck`).
- **SST corpus**: 329/329 test files pass (~3M cases). No regressions.
- **Pass status**: ✅ All scenarios in the brief implemented and
  passing. Modes 1 / 5 (gate-edge triggered) are accepted in
  programming but never fire — the brief explicitly permitted this.
  BCD counting is accepted-and-warned but counts in binary regardless,
  also per the brief.

## Clock design

### File and exports

`src/timing/clock.ts` exports a single `Clock` class plus the
`ClockSubscriber` interface. `src/timing/index.ts` is the barrel; the
top-level `src/index.ts` re-exports both.

### Subscription model

Subscribers register via `clock.subscribe(sub)`, which returns an
unsubscribe function. On each non-zero `clock.advance(cycles)` call,
the clock bumps `cycles` into `now()` and then iterates a snapshot of
the current subscriber list in registration order, calling each
`onAdvance(cycles)`.

The snapshot length is captured before iteration so that a subscriber
that registers another subscriber during its own callback does not see
the new one fire for the same advance — the new subscriber starts
firing on the *next* advance. Mutation during iteration is otherwise
unsupported in v0; if a subscriber needs to unsubscribe during its own
callback we'll add the safety net then.

### `now()` semantics

Monotonic, unitless cycle count starting at 0. The clock has no opinion
on Hz; if a device needs Hz, it knows its own rate vs the CPU's
(the PIT's `cyclesPerPitTick` config is where the ratio lives).

### `advance(cycles)` choices

- `cycles` must be a non-negative integer. `advance(-1)` throws — the
  clock is monotonic by construction. Non-integers (NaN, fractional)
  also throw; we never want fractional cycles polluting downstream
  device math.
- `advance(0)` is a no-op: time doesn't change, subscribers are not
  notified. This keeps device code simple ("advance(0) means nothing
  to do").
- Subscriber exceptions propagate. If a subscriber throws, later
  subscribers in the registration order are *not* notified for this
  advance, and the exception bubbles up to the caller. Devices should
  not throw from `onAdvance`; if a device wants to surface an error
  condition it should latch it and report on the next read instead.
  This is the simplest, most predictable contract — no swallowing of
  unknown errors. Documented in the test (`a subscriber that throws
  prevents later subscribers from firing this advance`).

## PIT design

### File and exports

`src/devices/pit.ts` contains `PIT8254`, `PIT8254Options`, and the
small `PITAccessMode` / `PITMode` type aliases. The class implements
both `PortHandler` (so `pit.registerOn(bus)` reserves
`[basePort..basePort+3]`) and `ClockSubscriber` (so it subscribes to
clock advances inside the constructor). `src/devices/index.ts` exports
all of the above.

### Per-channel state

Each of the three channels carries:

- **Programming-time**: `mode`, `accessMode`, `bcd`, `divisor`.
- **Counting-time**: `counter`, `output`, `gate`, `programmed`,
  `mode0Fired` (mode 0/4), `mode3HighTicks` / `mode3LowTicks` /
  `mode3PhaseTick` (mode 3 specifics).
- **Latching**: `latchedCount`, `latchedStatus`, `readFlipflop`,
  `writeFlipflop`, `pendingDivisorLow` (lohi-write low byte buffer).
- **Reprogramming**: `pendingDivisor` (queued for next zero crossing
  in modes 2/3).

Channels are stored as a fixed `[Channel, Channel, Channel]` tuple
indexed 0..2.

### Mode implementations

**Mode 0 (one-shot, software-triggered)**: Output goes low on control
word write. Counter loads on divisor write. Each PIT tick decrements;
when counter reaches 0 for the first time, output goes high (rising
edge fires) and `mode0Fired` latches. Counter continues decrementing
mod 0x10000 forever (or until reprogrammed). Reprogramming via a fresh
control word + divisor re-arms.

**Mode 2 (rate generator)**: Output starts high; counter loads to
divisor. Edges happen once per period of `divisor` PIT ticks. The
implementation walks down to the first zero crossing analytically,
then computes whole periods elapsed via `floor(remaining / divisor)`,
so a million-tick advance is O(1) work, not O(million). On reach-zero,
the counter reloads (and any `pendingDivisor` is consumed at the
boundary). Output is reported as `(counter !== 1)` — the single-tick
low pulse is observable if a read happens to land on it but otherwise
invisible at batch granularity, which matches what software relying
on the IRQ tick (rather than polling output) needs.

**Mode 3 (square wave)**: For divisor *D*, output is high for
`highTicks = ceil(D/2)` and low for `lowTicks = floor(D/2)`. Even
divisor: symmetric. Odd divisor: asymmetric (per Intel datasheet).
Implementation tracks `mode3PhaseTick` mod period and derives both
output and rising-edge crossings from it. Whole-period batch advances
are skipped analytically (`floor(remaining / period)`). Reprogramming
applies at the next period boundary; `computeMode3Phases` recomputes
high/low splits after each reload. The "live counter" view in mode 3
is a linear approximation (real silicon decrements by 2 with an extra
on phase entry, which we don't faithfully reproduce — software that
depends on the exact stepping pattern is rare and noted in the report
as a known v0 simplification).

**Mode 4 (software-triggered strobe)**: Like mode 0 but output starts
high, pulses low at terminal count for one tick, then back high. The
single-tick low pulse is invisible at v0's batch granularity unless
the read happens to land on it; the rising-edge callback fires when
the pulse ends.

**Modes 1 / 5 (gate-edge triggered)**: Accepted in programming, warned
on, and never fire — gate edges are not simulated. Documented in the
warning string.

### Analytical-vs-loop tradeoff for batch advances

For each non-trivial mode (0, 2, 3, 4) the per-tick math is constant
time: walk to the next "interesting" boundary in O(1), compute whole
periods elapsed in O(1), and update final state. The only loops are
in the per-channel switch and (for mode 3) a small while-loop that
runs at most twice (once to cross the current phase, once to skip
whole periods). A 1 GHz advance arriving in a single batch costs the
same as a 1 MHz advance.

The cost: subtle edge state (e.g. mode 3's exact mid-period output
transition) is tracked at "post-advance" granularity, not per-tick.
Software that polls the OUT pin at sub-PIT-tick rates and depends on
the precise stepping pattern won't match real silicon. The integration
target (PIC IRQ on rising edge) doesn't depend on this precision.

### Per-batch rising-edge dedup

The PIT calls each channel's rising-edge callback **once per advance**,
even when the analytical math says many edges occurred during that
advance. This is the brief's "future work would add sub-batch event
scheduling" simplification.

**Why it usually works in practice**: real PC software flows for IRQ 0
look like
```
HLT → IRQ → handler → INC tick_count → EOI → IRET → HLT → …
```
The PIC's IRR latches one edge until EOI clears ISR; subsequent edges
within the same batch would just re-set IRR. Real BIOS / DOS code is
written to tolerate the occasional missed-tick because the cumulative
drift is reset by tick-counter resync logic.

**Worst case**: with PIT divisor *D* and run-loop batch size *B*, a
batch's advance crosses `B / D` periods. If `B / D >> 1`, we lose
`(B/D) - 1` ticks per batch. With the defaults from the integration
test (`cyclesPerPitTick = 1`, `D = 100`, `batchSize = 100`, halt-spin
cycles = 100), each spin produces exactly one rising edge — the
sweet spot. With `cyclesPerPitTick = 4` (the real PC ratio) and
`batchSize = 10000`, a batch advances 10000 / 4 = 2500 PIT ticks; if
software programs a typical 18.2 Hz tick (D = 65536), 2500 / 65536 < 1,
so no edges per batch on average, no loss. If software programs an
unusually fast tick (D = 100), each batch crosses 25 periods and we
lose ~24 ticks per batch.

**Threshold for problems**: `B / (D * cyclesPerPitTick) > 1`. Below
that, no ticks are lost; above, we lose (ratio - 1) per batch. Future
"next event time" hinting from devices to the run loop would let the
loop subdivide batches near interesting boundaries and remove the
limitation entirely.

### Programming protocol

**Control word** (port `basePort + 3`):

- Bits 7–6 select counter (00=ch0, 01=ch1, 10=ch2, 11=read-back).
- Bits 5–4 access mode (00=latch counter, 01=lobyte, 10=hibyte,
  11=lohi).
- Bits 3–1 operating mode (with 110→2 and 111→3 alias handling).
- Bit 0 BCD (recorded; warned; counts in binary regardless).

The 00 access-mode encoding is the **counter latch command**: latch
the live count for the selected channel without changing mode/access
mode. The 11 channel-select encoding is the **8254 read-back**: see
below.

**Channel data writes** (`basePort + 0/1/2`):

- `lobyte`: one byte sets divisor low; high = 0; channel programmed.
- `hibyte`: one byte sets divisor high; low = 0; channel programmed.
- `lohi`: two writes via `writeFlipflop`. First byte buffered; second
  byte composes the divisor and starts counting.

A divisor of 0 is treated as 0x10000 (the 8254's "max count"
encoding). Tested.

**Channel data reads**: status latch beats count latch beats live
read. For lohi reads, `readFlipflop` alternates low-then-high per
read. Latched reads consume the latch on completion (after both
bytes for lohi, after the single byte for lobyte/hibyte).

**8254 read-back command** (control word with bits 7–6 = 11):

- Bit 5 (active-low /CNT): 0 → latch count.
- Bit 4 (active-low /STA): 0 → latch status.
- Bits 3, 2, 1 select channels 2, 1, 0 respectively.
- Bit 0 reserved (must be 0).

For each selected channel, latch count and/or status as requested.
Status is a single byte combining OUT pin state, null-count flag,
access mode, mode, and BCD bit. Both-latch-at-once: status reads
first, then count.

### Reprogramming during a count

- **Modes 0 / 4**: A new control word + divisor write resets the
  channel immediately. The counter reloads, output returns to its
  initial-state, and `mode0Fired` is reset.
- **Modes 2 / 3**: A bare data-port write (no preceding control word)
  with the channel already programmed queues the new divisor in
  `pendingDivisor`; it applies at the next zero crossing. This matches
  real-silicon behaviour and lets software change tick rate without
  dropping a tick.

## Halt-spin clock advance

When the CPU is halted and a clock is wired, each halt-spin iteration
advances the clock by `haltCyclesPerSpin` (default = `batchSize`).
Without this, a HLT-then-wait-for-IRQ-0 program never wakes — the PIT
counts only when the clock advances, and a halted CPU would otherwise
contribute zero cycles.

**Choice rationale**: `batchSize` keeps the cadence roughly equal to
an executing CPU. A halted CPU, in real-time terms, "uses" about as
much wall clock per yield as an executing one would across a batch
yield. Picking `batchSize` means the PIT fires at its programmed rate
during HLT, which is what timer-driven interactive software (e.g.
"sleep until next tick") expects.

**At higher rates** (e.g. `haltCyclesPerSpin = 10 * batchSize`):
virtual time runs faster during idle than during execution, which is
fine for "make the test go quickly" but breaks any future real-time
sync layer.

**At lower rates** (e.g. `haltCyclesPerSpin = 1`): each spin advances
the clock by one cycle. With PIT divisor 100 and `cyclesPerPitTick`
1, you'd need 100 spins (100 yields ≈ 100 ms in Node) to fire one
edge — guests would experience timer interrupts at 10 Hz instead of
the 100 Hz they programmed. Bad.

The default is the right middle ground; the option is exposed so
tests can tune (the integration test uses `haltCyclesPerSpin: 100` to
match `batchSize: 100` explicitly).

## Run loop integration

`RunLoopOptions` gains two optional fields: `clock?: Clock` and
`haltCyclesPerSpin?: number`. The change is purely additive — every
existing test that omits these fields gets the pre-clock behaviour
unchanged. Verified by:

1. The 477 baseline unit tests continue to pass without modification.
2. The corpus runs without a clock and remains green (329/329).

The advance call lives **after** the batch but **before** the yield
(`clock.advance(executedThisBatch)` between the inner `for` loop and
`await yieldToEventLoop()`). This way, if the PIT's rising-edge
callback ends up calling `pic.assertIRQ(0)` and the PIC raises through
the controller, the next iteration's first `cpu.step()` sees the
pending interrupt at the boundary — no race with the yield.

For the halted branch, `clock.advance(haltCyclesPerSpin)` runs before
the spin's yield, for the same reason.

## Things future briefs will need to revisit

- **PPI / channel 2 gate**: Real PC wires PIT channel 2's gate to PPI
  port 0x61 bit 0 (the PC speaker enable / counter gate). v0 hard-
  wires it `true`; `setChannel2Gate` is exposed for the future PPI
  brief but currently unused outside tests.
- **BCD counting**: The BCD bit is accepted and warned, but counting
  is always binary. The few BIOS routines that program BCD counts
  (vanishingly rare on PCs — the BIOS PIT is binary throughout) would
  observe wrong values. A future brief can add a BCD subtype if
  needed; the place to wire it is the divisor-load path.
- **Sub-batch event scheduling**: The "rising edge fires once per
  batch" simplification means software that programs unusually fast
  PIT rates (relative to the CPU's batch size) loses ticks. The fix
  is "next event time" hinting from devices to the run loop, letting
  the loop subdivide batches near interesting boundaries. A real-PC-
  ratio configuration (`cyclesPerPitTick = 4`, batchSize = 10_000)
  with a typical PIT-IRQ-0 setup (D = 65536) doesn't lose ticks; the
  problem only appears for D < `batchSize / cyclesPerPitTick`.
- **Real-time sync layer**: The clock is virtual — it advances as
  fast as instructions execute. For interactive use (where users see
  a wall-clock-paced display) we'll need a layer that wraps the run
  loop and throttles batches against `performance.now()`. The clock
  abstraction is the right insertion point: a "real-time clock"
  subclass could yield the run loop until wall time catches up.
- **Cascaded PICs and higher IRQ rates**: A fast-firing PIT (e.g.
  IRQ 0 at 1 kHz) plus a future cascaded slave PIC may surface
  ordering bugs we haven't seen yet. The integration test runs at
  100 Hz and stresses single-PIC delivery only.
- **Mode 3 live-counter accuracy**: Our linear approximation of the
  live counter in mode 3 differs from silicon (which decrements by 2
  per tick with an asymmetric extra step). Software that polls the
  count directly during a square-wave run gets approximate values.
  No known software depends on this; if a future test bumps into it,
  the fix is to track per-half-period decrement explicitly.
- **Mode 0 / 4 single-tick low pulse**: Mode 4's one-tick-wide low
  pulse is invisible at batch granularity unless a read happens to
  land on it. Same for mode 2's counter==1 transient. Acceptable
  for current goals; revisit if a guest depends on observing the
  pulse via the OUT pin.

## Verification

```
$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json
(clean exit)

$ npx vitest run tests/unit/
 Test Files  30 passed (30)
      Tests  519 passed (519)
   Duration  ~5.8s

$ npm run test:sst
 Test Files  2 passed (2)
      Tests  329 passed (329)
   Duration  ~226s
```

Baseline → new:
- Unit tests: 477 → 519 (+42).
- SST corpus: 329 → 329 (no regression).
- Typecheck: clean.

## Files changed

New:
- `src/timing/clock.ts` — `Clock` class + `ClockSubscriber` interface.
- `src/timing/index.ts` — barrel.
- `src/devices/pit.ts` — `PIT8254` with three channels, full
  programming protocol, modes 0/2/3/4, mode 1/5 acknowledged-but-
  silent, latching, 8254 read-back.
- `tests/unit/clock.test.ts` — 12 tests.
- `tests/unit/pit.test.ts` — 29 tests.
- `tests/unit/cpu-pit-pic-integration.test.ts` — 1 end-to-end test.
- `PIT_REPORT.md` — this report.

Modified:
- `src/runtime/run-loop.ts` — `RunLoopOptions` gains `clock?` and
  `haltCyclesPerSpin?`. The batch path calls `clock.advance(
  executedThisBatch)` after each batch; the halt-spin path calls
  `clock.advance(haltCyclesPerSpin)` per iteration.
- `src/devices/index.ts` — re-exports `PIT8254` and its types.
- `src/index.ts` — re-exports the new `timing/` barrel.
