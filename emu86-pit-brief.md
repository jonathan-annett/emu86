# emu86 — Agent Brief: Virtual Clock + 8254 PIT

## TL;DR

Build a virtual-time clock (the central timing abstraction for all future timing-dependent devices) and the second device on top of the existing PIC + IOBus: an 8254 PIT. Wire the run loop to advance the clock after each instruction batch. PIT channels 0/1/2 are individually programmable; channel 0's output line transitions trigger a configurable callback (the machine will wire that to `pic.assertIRQ(0)`). Verify entirely in Node via deterministic tests with manual clock advancement. Ship a green test run plus a report at `PIT_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `PIC_REPORT.md`, and `INTERRUPT_DELIVERY_REPORT.md` first. The PIC is your downstream — you won't import it; the *machine* (future brief) wires PIT output to PIC input. The run loop integration is similar to what was done for interrupts: a small additive change, not a redesign.

## Hard rules

1. **Don't break existing tests.** Current state: 477 unit tests + 329 corpus files passing. Both must stay green. Run `npx vitest run tests/unit/` after every meaningful change. Run the corpus once at the end.
2. **`cpu.step()` stays pure synchronous.** No CPU changes are expected for this brief.
3. **No interface changes** to `Memory`, `PageStore`, `InterruptController`, `IOBus`, or any existing device. Additive only.
4. **No real-time anywhere.** No `setInterval`, no `Date.now()`, no `performance.now()`. The clock advances when the run loop tells it to. Tests advance it manually.
5. **Strict TypeScript stays strict.** No `any`, no `as unknown as`, no `// @ts-ignore`.
6. **Determinism.** Same program, same input, same output, every time.

## Why a virtual-time clock first

Real emulators (Bochs, QEMU, DOSBox) all run on virtual time: device timing is driven by CPU progress, not wall clock. This is the right abstraction because:

- Tests are deterministic without timer fakery.
- Running the emulator at any speed (paused, stepping, full-tilt) keeps timer-driven software self-consistent.
- The PIT, future RTC, future serial baud-rate clocks, and any other timing-dependent device all subscribe to the same clock. One source of truth.

Real-time syncing — throttling the run loop so virtual time matches wall clock for an interactive user experience — is a *separate* layer that wraps the run loop. That's a future brief. For now, virtual time runs as fast as instructions execute.

## Scope

### What you're building

1. **Clock** (`src/timing/clock.ts`) — a single `Clock` class with `advance(cycles)`, `now()`, and a subscription mechanism.
2. **PIT8254** (`src/devices/pit.ts`) — three independently programmable channels, ports 0x40–0x43, full programming protocol (modes 0–5, all access modes, latching, 8254 read-back command).
3. **Run loop integration** — call `clock.advance()` after each batch in `RunLoop`.
4. Tests for each, plus a CPU-PIT-PIC integration test.

### What you are NOT building

- The Machine config that wires PIT output to PIC input. That's the next brief. Your PIT exposes a callback the future machine will install.
- Any interaction with the PPI (port 0x61, channel 2 gate). The PIT models the gate input but channel 2's gate is permanently true in v0; document the limitation.
- The PC speaker. Channel 2's output goes nowhere audible.
- Real-time syncing or wall-clock throttling.
- Cycle-accurate sub-instruction timing. The granularity is "one clock advance per batch."
- BCD counting (the BCD bit on the control word is accepted and ignored; binary counting is used regardless). Document.

## Design

### File layout

New:
- `src/timing/clock.ts` — `Clock` class.
- `src/timing/index.ts` — barrel.
- `src/devices/pit.ts` — `PIT8254` implementing `PortHandler`.
- `tests/unit/clock.test.ts` — clock tests in isolation.
- `tests/unit/pit.test.ts` — PIT tests in isolation, with a fake clock and recorded output transitions.
- `tests/unit/cpu-pit-pic-integration.test.ts` — end-to-end: real CPU + memory + PIC + PIT + clock + IOBus, channel 0 wired to IRQ 0, run a program, assert IRQ count.

Modified:
- `src/runtime/run-loop.ts` — accepts an optional `Clock`; calls `advance(executedThisBatch)` after each batch.
- `src/index.ts` — re-export the new modules.
- `src/devices/index.ts` — add PIT to the barrel.

### Clock design

Minimal interface:

```ts
export interface ClockSubscriber {
  /** Called when the clock advances. `cycles` is how many cycles elapsed in this advance.
   *  Subscriber can read clock.now() for the new current time. */
  onAdvance(cycles: number): void;
}

export class Clock {
  /** Current virtual time in clock cycles since startup. Monotonic, never decreases. */
  now(): number;

  /** Advance virtual time by `cycles`. Notifies all subscribers in registration order.
   *  Cycles must be a non-negative integer; advance(0) is a no-op (no subscriber notification). */
  advance(cycles: number): void;

  /** Register a subscriber. Returns an unsubscribe function. */
  subscribe(subscriber: ClockSubscriber): () => void;
}
```

That's it. No "schedule callback for time T" — devices that need that compute their own crossings inside `onAdvance`. No "cycles per second" rate field — the clock is unitless cycles; if a device needs Hz, it knows its own rate vs the CPU's rate (the PIT, on a real PC, runs at 1.193182 MHz; the CPU at 4.77 MHz; the PIT decrements once per ~4 CPU cycles. We're not enforcing that ratio at the clock level — instead, the PIT's `cyclesPerPitTick` is a configuration option of the PIT itself, defaulting to 4).

Storage: the subscribers list is an array. Iteration order is registration order. `subscribe` returns an unsubscribe function that removes the subscriber. Don't worry about subscriber-modifies-list-during-iteration cases; if it comes up later we'll revisit.

### PIT design

#### Constructor

```ts
class PIT8254 implements PortHandler {
  constructor(
    clock: Clock,
    options?: PIT8254Options
  );

  registerOn(bus: IOBus): void;  // Reserves ports [basePort..basePort+3]
}

interface PIT8254Options {
  /** Base I/O port, default 0x40 (PC standard). Channels at +0/+1/+2, control at +3. */
  basePort?: number;
  /** Clock cycles per PIT tick. Real PC: ~4 (CPU at 4.77 MHz / PIT at 1.193 MHz).
   *  Default 4. Configurable for testing — setting to 1 means PIT ticks every clock cycle. */
  cyclesPerPitTick?: number;
  /** Optional warning sink for unsupported features (BCD counting, mode 1/5 gate behavior).
   *  Default silent. */
  warn?: (msg: string) => void;
  /** Callback invoked when channel 0's output line goes from low to high (the IRQ-trigger edge).
   *  In a real machine, the machine config wires this to pic.assertIRQ(0). Default no-op. */
  onChannel0RisingEdge?: () => void;
  /** Same for channel 1's output. Default no-op (real PC: channel 1 wired to DRAM refresh, which we don't model). */
  onChannel1RisingEdge?: () => void;
  /** Same for channel 2's output. Default no-op (real PC: channel 2 wired to PC speaker via PPI, which we don't model). */
  onChannel2RisingEdge?: () => void;
}
```

The "rising edge" callbacks are the integration point. The future Machine config will pass `onChannel0RisingEdge: () => pic.assertIRQ(0)`. The PIT itself never references the PIC.

#### Channel state (×3)

```ts
interface PITChannel {
  // Programming-time state
  mode: 0 | 1 | 2 | 3 | 4 | 5;
  accessMode: 'latched' | 'lobyte' | 'hibyte' | 'lohi';
  bcd: boolean;                                // recorded; ignored in counting
  // Counting state
  divisor: number;                             // initial reload value (16-bit, 0 = 0x10000)
  counter: number;                             // current count (16-bit; tracked precisely)
  output: boolean;                             // output line state
  gate: boolean;                               // gate input state (true for ch0/ch1; configurable for ch2)
  // Latching for reads
  latchedCount: number | null;                 // null = read live counter
  // Lo/hi byte sequencing
  writeFlipflop: 'awaitingLow' | 'awaitingHigh' | 'idle';
  readFlipflop: 'awaitingLow' | 'awaitingHigh' | 'idle';
  // Status (for 8254 read-back)
  programmed: boolean;                         // true after first counter byte loaded
}
```

#### Programming protocol

**Control word write (port `basePort + 3`)**:

Bits decode as:
- Bits 7-6: select counter (00=ch0, 01=ch1, 10=ch2, 11=read-back command [8254 only])
- Bits 5-4: read/write access mode (00=latch counter, 01=lobyte, 10=hibyte, 11=lohi)
- Bits 3-1: operating mode (000=mode 0, 001=mode 1, 010=mode 2 [also 110], 011=mode 3 [also 111], 100=mode 4, 101=mode 5)
- Bit 0: BCD (0=binary, 1=BCD; we accept BCD bit, count binary, warn on read of programming if needed)

Special: bits 5-4 = 00 is the **counter latch command** for the selected channel. Latches the current count for stable reading. Doesn't change mode or other settings.

Special: bits 7-6 = 11 is the **8254 read-back command**. Allows latching count and/or status of multiple channels simultaneously based on bits 5-1. Implement this — Linux, DOS, and BIOS code uses it.

**Channel data write (ports `basePort + 0/1/2`)**:

Behavior depends on the channel's access mode:
- `lobyte`: this byte is the low byte of the new divisor; high byte stays at 0 (or whatever it was — clarify: real hardware sets high byte to 0). Channel begins counting if mode allows.
- `hibyte`: this byte is the high byte; low byte is 0.
- `lohi`: tracks via `writeFlipflop`. First byte is low, second is high. Channel begins counting after second byte.

For modes that auto-start (0, 2, 3, 4), counting begins as soon as divisor is fully programmed. For modes 1 and 5 (gate-triggered), counting begins on next rising edge of gate (we don't simulate gate transitions, so document and leave these effectively never-triggering).

Loading a divisor of 0 means 0x10000 (65536) — special case for the maximum count.

**Channel data read (ports `basePort + 0/1/2`)**:

If the channel has a latched value, return that; consume the latch after the read pair finishes (lohi: after both bytes; lobyte/hibyte: after the single byte).

If no latch, return the live counter value. In `lohi` access mode, two reads return low then high (potentially of different "now" snapshots, since the counter advances between reads — this is real-hardware behavior some software depends on). We achieve this by computing the live counter at each read time using `clock.now()` minus the last-known-tick.

#### Counting (the heart of the PIT)

On `clock.advance(cycles)`:

1. Compute PIT ticks elapsed: `pitTicksThisAdvance = floor((cyclesAccumulated + cycles) / cyclesPerPitTick)`. Track residual: `cyclesAccumulated = (cyclesAccumulated + cycles) % cyclesPerPitTick`.
2. For each channel:
   - If `gate === false` or not `programmed`: skip.
   - If mode 0 or 4 (one-shot, no reload): decrement counter; if it crosses 0, set output high, fire rising-edge callback; counter wraps and keeps decrementing but output stays high.
   - If mode 2 (rate generator): each tick decrements counter. When counter reaches 1, output goes low for one tick. When counter reaches 0, reload to divisor, output goes high (the rising edge — fire callback).
   - If mode 3 (square wave): output toggles every (divisor/2) ticks. Track the half-period state. When output transitions low→high, fire rising-edge callback.
   - Modes 1 and 5: gate-edge-triggered; we don't simulate gate edges, so these never fire. Document.

**For batch processing** (typical case): a channel might cross many full divisor periods in one `advance()` call. Handle this analytically — compute `crossings = floor(elapsed_pit_ticks / divisor)` for periodic modes, then update counter to `divisor - (elapsed % divisor)` (or similar). This avoids looping millions of times for a fast-running counter.

**The "fire rising-edge callback once per batch" simplification**: if 100 rising edges happened in one batch, we still call the callback once. Document this. Real software won't lose IRQs in practice because:
- The PIC's IRR bit is set once; subsequent calls during the same batch are deduped by the PIC's edge-triggered behavior (per `PIC_REPORT.md`).
- After the CPU services the IRQ and the handler EOIs, the PIT's *next* batch will fire the next edge if elapsed.

The corner case: if a divisor is so small that multiple edges happen between IRQ servicing and the next batch's PIT advance, software loses ticks. This is a known limitation of batch-end timing; future work can add "next event time" hinting that lets the run loop subdivide batches near interesting boundaries. Not for v0.

### Run loop integration

```ts
// Before:
while (running and executed < maxInstructions) {
  for batchSize iterations:
    if halted and no pending: break
    cpu.step()
    executedThisBatch++
  await yieldToEventLoop()
}

// After:
while (running and executed < maxInstructions) {
  let executedThisBatch = 0
  for batchSize iterations:
    if halted and no pending: break
    cpu.step()
    executedThisBatch++
  if (clock) clock.advance(executedThisBatch)
  executed += executedThisBatch
  await yieldToEventLoop()
}
```

Two things to note:

1. The clock is optional. Existing tests that don't pass a clock continue to work unchanged. The `RunLoopOptions` type gains an optional `clock?: Clock`.
2. Advance happens *after* the batch but *before* the yield. This way, if the PIT's rising-edge callback ends up calling `pic.assertIRQ(0)` and the PIC raises through the controller, the next batch's first `cpu.step()` will see the pending interrupt at the boundary. No racing with the yield.

### Halt semantics

When the CPU is halted with a real `InterruptController`, the run loop currently halt-spins (yields, rechecks queue). With a clock and PIT, the halt-spin should *also* advance the clock — otherwise a halted CPU waiting for a timer interrupt will never get one. The existing halt-spin code yields and re-evaluates; we need to add a clock advance there. Probably advance by 1 cycle per yield (or by a small amount — the exact value doesn't matter much).

Actually, this is more subtle. If the CPU is halted, no instructions are executing, so "cycles per yield" is conceptually different from "cycles per instruction." For HALT, we want the clock to advance at *some* rate so timer-driven wake works. A reasonable default: one yield in the halt-spin = one batch worth of cycles (e.g., `batchSize` cycles). That keeps a halted CPU + 18.2Hz timer behaving normally — the halt-spin yields every ~1ms (Node), advances the clock by `batchSize` cycles, the PIT eventually crosses zero, fires the callback, the PIC raises, the controller queues, the next iteration's halted-check sees pending and unhalts.

This needs to be in the brief. The agent should think through this and document the choice.

## Test plan

### Clock tests (`tests/unit/clock.test.ts`)

Small file. Maybe 8 tests.

- `now()` starts at 0.
- `advance(N)` increases `now()` by N.
- `advance(0)` is a no-op (no subscriber notification).
- `advance(-1)` throws (or is rejected somehow — your call, document).
- Subscribers fire on advance, receive the cycle count.
- Multiple subscribers fire in registration order.
- Unsubscribe stops further notifications.
- Subscribers that throw don't prevent other subscribers from firing (or do — design choice, document).

### PIT unit tests (`tests/unit/pit.test.ts`)

Use a real `Clock` and mock the rising-edge callbacks. Probably 30+ tests.

**Programming**:
- Control word writes select the right channel, mode, access mode, BCD bit recorded.
- Counter latch command (control word with bits 5-4 = 00) latches that channel.
- Read-back command (control word with bits 7-6 = 11) latches multiple channels.
- BCD bit set: programming accepts, counting still proceeds in binary, warning fires.

**Counting in mode 2 (rate generator)**:
- Program channel 0 mode 2, divisor 100. Advance clock by 99 PIT ticks (≈ 99 × cyclesPerPitTick clock cycles). Output stays high. Advance by 1 more. Output cycle: goes low, then on next tick goes high — rising-edge callback fires.
- After 200 PIT ticks total, callback has fired exactly 2 times.
- After 1000 PIT ticks, callback has fired 10 times.
- Reprogramming during count (write new divisor) takes effect on next reload.

**Counting in mode 3 (square wave)**:
- Program channel 0 mode 3, divisor 100. After 50 PIT ticks, output toggles low. After 50 more, toggles high — callback fires. After 100 more (so 200 total), callback has fired again.
- Total callbacks for 1000 ticks at divisor 100 = 10 (same as mode 2 at this granularity).
- Odd divisor in mode 3: real hardware uses (divisor+1)/2 high cycles + (divisor-1)/2 low cycles. Test divisor 7: verify the asymmetric period.

**Counting in mode 0 (one-shot)**:
- Program mode 0, divisor 50. After 50 ticks, callback fires once. After 1000 more ticks, no further callbacks. Reprogramming (re-writing divisor) re-arms.

**Latching and reads**:
- In `lohi` access mode, write divisor 0x1234 (low 0x34, high 0x12). Channel started.
- Without latching, advance some ticks, read low byte then high byte: each is current-at-read-time; verify they're consistent with a counter that's decreasing.
- With counter-latch command between reads: read low, latch (without count change), advance, read high — high should be the latched-time high, not the current-time high.

**Special cases**:
- Divisor of 0 is treated as 65536.
- Channel not yet programmed: data writes to data port don't start counting until divisor is fully written.
- Channel 1 and 2 programmed and counting: their callbacks fire (but in v0, the default callbacks are no-op — the test asserts the *PIT-internal* output state via inspection, since the no-op callback can't be observed).

**8254 read-back command**:
- Latch ch0 and ch1 status simultaneously. Subsequent reads of those channels return latched data.

### Integration test (`tests/unit/cpu-pit-pic-integration.test.ts`)

One scenario, end-to-end:

Setup:
- `PagedMemory` with hand-laid IVT (vector 8 = handler).
- `BasicInterruptController`.
- `BasicIOBus`.
- `Clock`.
- `PIC8259` registered on the bus, `onChannel0RisingEdge: () => pic.assertIRQ(0)` wired on the PIT.
- `PIT8254` registered on the bus, attached to the clock.
- `CPU8086` with controller and bus.
- Handler at the IVT vector: increments a memory location, sends EOI to PIC (`MOV AL, 0x20; OUT 0x20, AL`), then `IRET`.
- Main program: program PIC (ICW1, ICW2 vectorBase=8, ICW4), unmask IRQ 0, program PIT channel 0 mode 3 divisor 100, then `STI; HLT`.
- `RunLoop` configured with the clock and `maxInstructions: 10000` (or whatever budget covers ~50 IRQ iterations comfortably).

Steps:
1. Run the loop.
2. The CPU programs PIC and PIT, then halts.
3. Halt-spin advances the clock (per the halt-spin clock-advance rule).
4. Clock advances trigger PIT counting → channel 0 rising edges → IRQ 0 raises → CPU wakes, services, handler runs, EOI, IRET, halts again.
5. After `maxInstructions`, loop exits.
6. Assert: the memory counter the handler incremented holds a value > 0 (probably between 5 and 50, depending on exact instruction count budget vs PIT divisor vs cyclesPerPitTick).

This is the "all the pieces talk to each other correctly" test. If it passes, the architecture works end-to-end.

## Watch out for

- **Channel 1/2 outputs go to no-op callbacks by default**, but their *internal* output state still advances. Test assertions on channel 1/2 should inspect the channel's `output` field via a getter, not rely on the callback being invoked.
- **The lohi flipflop is per-channel and per-direction (read vs write).** Don't share state across channels; each channel maintains independent flipflops.
- **Counter-latch resets the read flipflop too?** Actually no, real hardware: latching just snapshots the value; the read flipflop tracks lo-vs-hi sequencing independently. Verify against the 8254 datasheet.
- **The 8254 read-back command** has fiddly bit semantics (bit 5 = latch count, bit 4 = latch status, bits 3-1 = which channels). Read the datasheet carefully; don't guess.
- **Mode 3 with odd divisor** has asymmetric high/low cycle counts. Easy to get wrong if you assume divisor/2 each way.
- **Loading a new divisor while counting** doesn't take effect immediately in modes 2/3 — it's loaded on next zero-crossing. Mode 0 *does* reset immediately on divisor write. Test these.
- **Halt-spin clock advance** is the new run loop wrinkle. If you don't advance the clock during halt, a HLT-then-wait-for-IRQ-0 program never wakes. Document the choice (advance by `batchSize` per spin? by 1 cycle? something in between?). This is a real design decision worth thinking through, not a freebie.
- **The corpus must still pass.** The corpus runs without a clock (RunLoop's clock is optional). Verify after your run loop changes that omitting the clock parameter doesn't change behavior.
- **`cyclesPerPitTick` defaults to 4.** Most tests will set it to 1 for clean math. Document the difference and pick the right default for each test.

## Stop and ask

- If you find yourself wanting to change `cpu.step()`, `Memory`, or `InterruptController`. None of those should be touched.
- If the corpus regresses (it shouldn't — none of this work touches the CPU).
- If `Clock.advance()` interacts oddly with the run loop (e.g., subscribers calling back into the run loop, recursive advance). The model is: clock advances are flat; subscribers do their own work and return. If something needs recursion, raise it before implementing.
- If you find yourself wanting to add wall-clock-time anywhere (no — virtual time only).
- If you hit a real-hardware quirk that the datasheet documents but real software ignores. Implement faithfully but document; we'll mask it later if it bites.

## Definition of done

- New files implementing Clock, PIT, and tests as specified.
- Run loop accepts an optional clock and advances it after each batch.
- Existing 477 unit tests still pass.
- New tests as specified, all green.
- Total unit test count ≥ 525 (477 baseline + ~50 new is plausible).
- `npm run typecheck` clean.
- Full corpus run still green.
- Report at project root: `PIT_REPORT.md` with these sections:
  - **Summary**: test counts, design choices, pass status.
  - **Clock design**: subscription model, what `now()` represents, any choices about advance(0) / advance(-1) / etc.
  - **PIT design**: per-channel state, how each mode is implemented, the analytical-vs-loop tradeoff for batch advances.
  - **Halt-spin clock advance**: what rate did you pick, why, what would change at higher/lower rates.
  - **Per-batch rising-edge dedup**: what's the worst case where software loses timer ticks? At what batch size and PIT divisor does it become a problem? Document the threshold.
  - **Things future briefs will need to revisit**: PPI / channel 2 gate, BCD counting, sub-batch event scheduling, real-time sync layer, cascaded PICs (since a fast-firing PIT might surface PIC ordering issues).
  - **Verification**: exact commands, output summaries.

## Reference sources

1. Intel 8254 datasheet — canonical programming reference; the mode timing diagrams are essential. The 8253 datasheet is similar but lacks read-back; we want the 8254.
2. IBM PC Technical Reference — describes the PC's specific PIT wiring (channel 0 → IRQ 0; channel 1 → DRAM refresh; channel 2 → PPI 0x61 → speaker).
3. Adrian Cable's 8086tiny — has a minimal PIT implementation; useful for sanity-checking the analytical batch-advance approach.
4. The existing `Clock`-less `RunLoop` in `src/runtime/run-loop.ts` — your changes to it should be additive and obvious.
5. The existing `PIC8259` in `src/devices/pic.ts` — the integration target; understand `assertIRQ` semantics before wiring the integration test.

## Appendix: why this brief sets up the next one

After this lands, the prerequisites for the first Machine config (item 3 in the four-step path) are all in place: CPU, memory with persistence, async interrupts, IOBus, PIC, virtual clock, PIT. The Machine config brief becomes "compose these into a coherent system, install the wiring (PIT channel 0 → PIC IRQ 0), load a test program, run it." That's mostly assembly work, not design.

After the Machine, the BIOS-boot brief (item 4) becomes "load 8086tiny's BIOS image into ROM, run it, observe what hardware it tries to access, decide what to stub vs implement." That's exploratory — but every layer it depends on will exist by then.

If this brief lands clean, we'll have built a complete (if minimal) IBM-PC-compatible substrate in five focused sessions, with verification at every layer. That's an unusual result for an emulator project at this stage.
