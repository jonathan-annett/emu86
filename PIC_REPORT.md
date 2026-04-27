# PIC + IOBus — Implementation Report

## Summary

The real `IOBus` (port-handler registration) and the first device on top
of it (a single 8259 PIC) are in place. Devices register against port
ranges; the CPU's existing IN/OUT opcodes route through the new bus
unchanged; PIC IRQ assertion flows through `controller.raise(vec)` and
the CPU services the resulting interrupt at the next instruction
boundary.

- **Test counts**: 477 unit tests pass (was 422 baseline → +55 new):
  - 24 in `tests/unit/io-bus.test.ts`
  - 30 in `tests/unit/pic.test.ts`
  - 1  in `tests/unit/cpu-pic-integration.test.ts`
- **Typecheck**: clean (`npm run typecheck`).
- **SST corpus**: 329/329 test files pass (~3M cases). No regressions.
- **Pass status**: ✅ All scenarios in the brief implemented and passing.
  No items skipped except the explicitly-out-of-scope ones (cascading,
  auto-EOI, polling, special fully nested, spurious IRQ 7, buffered mode).

## IOBus design

### Where the file lives

I extended the `IOBus` interface in place at `src/core/io.ts` (adding
`register` / `unregister` and the new `PortRange` / `PortHandler` types
right next to the existing four IN/OUT methods) and put the concrete
`BasicIOBus` implementation in a new file at `src/io/io-bus.ts`. Rationale:

- The contract belongs together. Splitting "interface" and "extra methods"
  across two files would force every reader who wants to know what an
  `IOBus` supports to bounce between them. The four CPU-side methods and
  the two device-side methods live on the same surface; both are part of
  the type.
- The implementation belongs in its own module. `BasicIOBus` is one of
  potentially several implementations (already there's `NullIOBus` next
  to the interface, and tests stand up their own recorders), so giving
  the real bus its own home keeps `core/io.ts` interface-only.
- Barrel at `src/io/index.ts` re-exports `BasicIOBus`. The top-level
  `src/index.ts` re-exports both the new `io/` and `devices/` barrels.

### Data structure

A single sorted array of `{ range, handler }` entries, kept sorted by
`range.start`. Lookups are a linear scan (terminated early once
`port < entry.range.start`). For the device counts a real machine config
will hold (PIC, PIT, keyboard, maybe a video controller — call it 5–10
ranges) the scan is well under the cost of the surrounding instruction
fetch. A binary search becomes worth it only at hundreds of devices, and
even then we'd want to profile first. The data structure is one private
field with two methods touching it; swapping it out later is local.

### Word fallback

`inWord` / `outWord` first ask the matched handler if it defines the
word method. If yes, call it directly (lets devices like a 16-bit DMA
controller see one word access instead of two byte ones). If no, the bus
splits into two byte accesses at `port` and `port + 1`. Each byte routes
*independently* through the bus — this matters for the
straddle case (handler covers only `port`, not `port + 1`): low byte
goes to the handler, high byte returns 0xFF (open bus). Real silicon
behaves the same way; word I/O on the 8086 bus is two cycles and there's
no notion of a "word port" at the bus level.

### Other behavioural notes

- **Open-bus reads**: 0xFF for byte, 0xFFFF for word, matching the
  pre-existing `NullIOBus` semantics. Same value when the handler covers
  the port but doesn't define the requested method (e.g. a write-only
  device read returns 0xFF).
- **Dropped writes**: silent. Same shape as `NullIOBus`.
- **Overlap policy**: `register` throws on any overlap (full, partial,
  or single-port collision). Two devices claiming the same port is a
  configuration bug, and we want it loud.
- **Adjacent ranges**: explicitly allowed and tested. `[0x80..0x8F]`
  next to `[0x90..0x9F]` is fine; only `end >= start_of_other` fails.
- **`unregister` policy**: throws if the handler isn't currently
  registered. Symmetric with the overlap throw — handler bookkeeping
  mistakes should fail loudly.
- **`NullIOBus`** stays where it was, but its `register` / `unregister`
  now throw with a message pointing at `BasicIOBus`. This keeps the
  CPU's default arg working for the existing tests that don't wire up
  any devices, while preventing silent footguns where someone tries to
  register a device on the null bus.

## PIC design

### File and exports

`src/devices/pic.ts` contains `PIC8259`, the `PIC8259Options` type, and
nothing else. `src/devices/index.ts` is the barrel. The class implements
the bus's `PortHandler` interface so `pic.registerOn(bus)` is a
one-liner that reserves `[commandPort..dataPort]` on the bus and routes
all four port accesses there into `readByte` / `writeByte`.

### State machine layout

```
private irr            8-bit IRR  — request lines asserted (or latched edges)
private isr            8-bit ISR  — IRQs being handled (cleared by EOI)
private imr            8-bit IMR  — masked-IRQ bitmap (init = 0xFF)
private vectorBase     ICW2 high 5 bits — IRQ N → vector (vectorBase + N)
private initState      'idle' | 'awaitingIcw2' | 'awaitingIcw3' | 'awaitingIcw4'
private expectIcw3     ICW1 bit 1 inverted (cascade signaled)
private expectIcw4     ICW1 bit 0
private levelTriggered ICW1 bit 3
private readSelector   'irr' | 'isr' (set by OCW3, default 'irr')
```

`writeCommand(value)` decodes by bits [4, 3]:

- `bit4 = 1`                → ICW1 (init or re-init from any state)
- `bit4 = 0, bit3 = 0`      → OCW2 (EOI / priority commands)
- `bit4 = 0, bit3 = 1`      → OCW3 (read-register select / poll / mask)

`writeData(value)` switches on `initState`:

- `awaitingIcw2`/`awaitingIcw3`/`awaitingIcw4` → consume the next ICW
- `idle` → write to IMR (OCW1) and trigger serviceability check

A non-ICW1 write to the command port mid-init is undefined per the
datasheet; we warn and ignore.

### `updatePending` strategy

A single private method drives every "could a new IRQ become serviceable
now?" decision. It's called from exactly four places: `assertIRQ`, the
IMR-write branch of `writeData`, the non-specific EOI branch of
`handleOcw2`, and the specific EOI branch of `handleOcw2`. The "raise
no more than one IRQ at a time" invariant from the brief is enforced
structurally: every state change funnels through `updatePending`, which
either raises one IRQ or none.

The selection logic:

1. No-op if `initState !== 'idle'` — software hasn't given us a vector
   base yet, so any latched IRR bits wait until init completes (and
   then for an IMR write, since ICW1 sets IMR = 0xFF).
2. Compute `pending = IRR & ~IMR`. Empty → done.
3. Pick `candidate = lowestSetBit(pending)` (highest priority — IRQ 0
   wins).
4. If ISR has any bit, `candidate` must be strictly lower (higher
   priority) than the lowest ISR bit — otherwise a peer or
   lower-priority pending bit must wait for EOI of the in-service
   handler.
5. Move `candidate` from IRR to ISR, then call
   `controller.raise(vectorBase + candidate)`.

This handles the brief's preemption semantics: a higher-priority IRQ
asserted during a lower-priority handler's service will raise
immediately. Whether the CPU actually services that preemption depends
on its IF gating — that's the `InterruptController` / CPU's concern,
not the PIC's.

### Things I supported beyond the bare brief

- A configurable warning sink (`PIC8259Options.warn`). Default is silent.
  Test code can capture the warnings to assert that unsupported features
  warn-then-continue rather than hard-fail. The warning sites are: ICW1
  with cascade signaled, ICW4 with MCS-80/85 mode bit clear, ICW4 with
  auto-EOI bit set, ICW4 with special-fully-nested bit set, OCW2 rotate
  encodings, OCW2 non-EOI-non-rotate encodings, OCW3 poll-mode bit, and
  OCW3 special-mask bit. None of these change observable PIC state
  beyond the bits the rest of the spec covers.
- A constructor check that `dataPort === commandPort + 1`. The IOBus
  `registerOn` reserves a contiguous range, so a non-adjacent pair would
  silently swallow other ports between them. Fail at construction.
- Inspection getters (`getIRR`, `getISR`, `getIMR`, `getVectorBase`,
  `getInitState`, `getReadSelector`). These are test-only conveniences.
  The "real" inspection path is OCW3 + read of the command port; the
  getters just save tests from having to drive that for assertions.

### Things I deliberately skipped (matching the brief)

- Cascaded master/slave PICs.
- Auto-EOI mode (we *accept* the ICW4 bit with a warning so init still
  completes; the actual auto-EOI behaviour isn't implemented and EOIs
  remain explicit).
- Special fully nested mode.
- Polling mode.
- Spurious IRQ 7 modeling — the brief calls this out; my note: a
  realistic spurious-IRQ test would need to model the case where IRR
  goes low between the CPU's INTA and the PIC's vector-fetch step.
  We don't model INTA cycles at that grain (the controller hands the
  CPU a vector directly), so there's nothing to spuriously fire.
- Buffered-mode signalling.
- Rotate-priority OCW2 encodings (warned and ignored).

## Cascading

If software writes ICW1 with `bit 1 = 0` (cascade signaled, expect ICW3):

- The state machine accepts the byte and consumes the eventual ICW3
  byte. We don't store ICW3's value (it describes which IRQ line a
  slave hangs off, which only matters when a second PIC actually
  exists).
- A warning is logged: `"PIC: ICW1 cascade mode — treated as single PIC for v0"`.
- The PIC otherwise behaves as a single PIC. IRQs 0..7 deliver via
  `vectorBase`. Ports 0xA0/0xA1 (the standard slave-PIC location) are
  *not* automatically also wired up — that's a `Machine` config concern
  that'll arrive with the cascading brief.

This is "treated as single", not "rejected". The decision is documented
as a warning rather than a throw because real PC BIOS code unconditionally
sends the cascade-mode ICW1 even if a system only has one PIC, and we
want such code to boot.

## Edge vs level triggered

ICW1 bit 3 selects the trigger mode and we record it (`levelTriggered`).
The practical difference in our simulation is small but specific:

- **Edge-triggered (default)**: `assertIRQ(n)` sets the IRR bit;
  `deassertIRQ(n)` is a no-op (the request was latched at the rising
  edge and the line going low afterwards doesn't undo it). To "re-fire"
  IRQ n, the device must call `assertIRQ(n)` again after the EOI clears
  ISR.
- **Level-triggered**: `assertIRQ(n)` sets the IRR bit, same as edge.
  `deassertIRQ(n)` clears the IRR bit *if it hasn't already moved to
  ISR*. (ISR represents "the CPU is handling this", which is independent
  of line state — only EOI clears ISR.) If a level-triggered line stays
  high through service, real silicon would re-assert immediately on EOI;
  in our model the device would need to call `assertIRQ(n)` again.

We don't model the silicon-level edge-detector separately from the IRR
bit. A device that wants edge-detection semantics should call
`assertIRQ` exactly once per logical event; one that wants level
semantics should call `assertIRQ` to raise the line and `deassertIRQ`
to drop it. When the next device (PIT or keyboard) lands, this contract
will be confirmed concrete; if it turns out we need finer simulation
(separate "line is high" state vs. "edge was latched"), it's a local
addition to the PIC and a small fix to the device.

## Things future briefs will need to revisit

- **Cascading**: a second PIC instance configurable for slave behaviour,
  ICW3 wiring information that actually routes IRQs from the slave's
  IRQ N to the master's "cascade IRQ" line, and the special fully
  nested mode that becomes meaningful with two PICs. The interface for
  this brief should be additive — `PIC8259` doesn't change shape, but
  there's a new helper that wires master + slave.
- **Auto-EOI**: easy to add — the OCW2 EOI path lifts into a method
  that's also called automatically at the end of `updatePending`'s
  raise step when auto-EOI is set. Worth adding alongside spurious
  IRQ 7 since they often interact.
- **Spurious IRQ 7**: needs us to model the INTA cycle (or at least
  the "between raise and CPU service" window) so we can detect IRR
  going low pre-vector-fetch. The current `controller.raise` is fire-
  and-forget; a "PIC reserves the right to send 7 if the line drops"
  model would need either an event back from the CPU or a controller
  upgrade.
- **Edge-detector fidelity**: if a device wants "line stays high through
  service, re-fires automatically on EOI", we'll need to split IRR into
  "edge-latched" vs "current line state" tracking and re-evaluate on EOI.
  A note in the PIC code already flags where this would land.
- **CPU IN/OUT during HLT**: the integration test happens to hit a tidy
  scenario (program PIC → STI → HLT → IRQ → handler → EOI → IRET → HLT).
  When a real PIT lands, we'll want to verify timer ticks during a
  long-running program don't perturb other state — and that the CPU's
  STI/POP-SS inhibit windows continue to behave correctly when the IRQ
  source is the PIC rather than direct `ctrl.raise()` calls.

## Verification

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json
(clean exit)

$ npx vitest run tests/unit/
 Test Files  27 passed (27)
      Tests  477 passed (477)
   Duration  ~5.5s

$ npm run test:sst
 Test Files  2 passed (2)
      Tests  329 passed (329)
   Duration  ~213s
```

Baseline → new:
- Unit tests: 422 → 477 (+55).
- SST corpus: 329 → 329 (no regression).
- Typecheck: clean.

## Files changed

New:
- `src/io/io-bus.ts` — `BasicIOBus` implementation.
- `src/io/index.ts` — barrel.
- `src/devices/pic.ts` — `PIC8259`.
- `src/devices/index.ts` — barrel.
- `tests/unit/io-bus.test.ts` — 24 tests.
- `tests/unit/pic.test.ts` — 30 tests.
- `tests/unit/cpu-pic-integration.test.ts` — 1 test.
- `PIC_REPORT.md` — this report.

Modified:
- `src/core/io.ts` — extended `IOBus` interface with `register` /
  `unregister`; added `PortRange` and `PortHandler` types; updated
  `NullIOBus` to throw on register/unregister.
- `src/index.ts` — re-export the new `io/` and `devices/` barrels and
  the new `PortRange` / `PortHandler` types.
- `tests/unit/opcodes-io.test.ts` — `MockBus` gained throwing
  `register` / `unregister` so it satisfies the extended interface.
  (The existing CPU-side IN/OUT tests are unchanged.)
