# emu86 — Agent Brief: IOBus + 8259 PIC

## TL;DR

Build the real IOBus (port-handler registration) and the first device on top of it: a single 8259 PIC. Wire the PIC into the existing interrupt controller so device-asserted IRQs flow through to the CPU. Verify entirely in Node via deterministic state-machine tests + one CPU integration test. Ship a green test run plus a report at `PIC_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `INTERRUPT_DELIVERY_REPORT.md`, and `src/interrupts/controller.ts` first. The interrupt controller is your downstream — the PIC's job is to decide *which* IRQ becomes a vector and *when*, then call `controller.raise(vec)`. Read `src/core/io.ts` to see the existing `IOBus` interface and `NullIOBus` placeholder; you're upgrading this from a stub to a real bus.

## Hard rules

1. **Don't break existing tests.** Current state: 422 unit tests + 329 corpus files (~3M cases) passing. Both must stay green. Run `npx vitest run tests/unit/` after every meaningful change. Run the corpus once at the end as a regression check.
2. **`cpu.step()` stays pure synchronous.** No changes to `cpu.ts` are expected for this brief. If you find yourself wanting to touch it, stop and ask.
3. **No interface changes** to `Memory`, `PageStore`, `InterruptController`. These are settled.
4. **The IOBus interface CAN change** — `NullIOBus` is a placeholder, and the real bus will have additional methods for handler registration. But: the four methods on the existing `IOBus` interface (`inByte`, `inWord`, `outByte`, `outWord`) must keep their signatures so the CPU's I/O opcodes (when implemented later) work without modification.
5. **Strict TypeScript stays strict.** No `any`, no `as unknown as`, no `// @ts-ignore`.
6. **Determinism in tests.** No real timers. No randomness. Tests must be deterministic and fast.

## Scope

### What you're building

Two new pieces that compose:

1. **Real IOBus** (`src/io/io-bus.ts` or extend `src/core/io.ts` — your call, document which). Supports registering port-range handlers. The CPU's `inByte`/`outByte` route through registered handlers; unregistered ports return open-bus values (0xFF / 0xFFFF) and silently drop writes, matching the existing `NullIOBus` semantics.

2. **8259 PIC** (`src/devices/pic.ts`). Single PIC model — no cascading for v0. Implements the 8259 programming protocol via I/O ports 0x20 (command) and 0x21 (data). Wires into an `InterruptController` to deliver serviceable IRQs as `raise(vec)` calls.

Plus tests and a barrel export.

### What you are NOT building

- Cascaded PICs (master + slave). Single PIC only for v0; the brief that adds cascading will extend the existing one, not replace it.
- Auto-EOI mode (rarely used; non-specific and specific EOI cover the practical cases).
- Special-fully-nested mode (used in cascading; out of scope).
- Polling mode (alternate interrupt-handling style; rarely used in PC software).
- Spurious IRQ 7 modeling. Document the omission in the report.
- Buffered mode (hardware-level signaling we don't simulate).
- A PIT, keyboard controller, or any other device that uses IRQs. Those are future briefs. The PIC's tests use synthetic `assertIRQ(n)` calls in lieu of devices.
- The CPU's IN/OUT opcodes are already implemented. You do not need to touch them. Your job is to make the IOBus they call into actually do something.

## Design

### File layout

New files:
- `src/io/io-bus.ts` — real `IOBus` with handler registration. (If you'd prefer to put it in `src/core/io.ts` next to the interface, that's also fine — make a deliberate call and explain in the report.)
- `src/io/index.ts` — barrel.
- `src/devices/pic.ts` — `PIC8259` class.
- `src/devices/index.ts` — barrel.
- `tests/unit/io-bus.test.ts` — bus tests in isolation.
- `tests/unit/pic.test.ts` — PIC tests in isolation, using a fake `InterruptController` that records calls.
- `tests/unit/cpu-pic-integration.test.ts` — end-to-end test wiring CPU + memory + controller + PIC + IOBus.

Modified files:
- `src/core/io.ts` — `IOBus` interface may gain `register(...)` and `unregister(...)` methods; `NullIOBus` may move or stay; document. The four existing IO methods stay unchanged.
- `src/index.ts` — export the new modules.

### IOBus design

The interface (extending what exists):

```ts
export interface IOBus {
  // Existing — CPU's IN/OUT opcodes call these.
  inByte(port: number): Byte;
  inWord(port: number): Word;
  outByte(port: number, value: Byte): void;
  outWord(port: number, value: Word): void;

  // New — devices register here at machine setup.
  register(range: PortRange, handler: PortHandler): void;
  unregister(handler: PortHandler): void;
}

export interface PortRange {
  /** Inclusive start port (0..65535). */
  start: number;
  /** Inclusive end port. start === end for a single port. */
  end: number;
}

export interface PortHandler {
  readByte?(port: number): Byte;
  readWord?(port: number): Word;
  writeByte?(port: number, value: Byte): void;
  writeWord?(port: number, value: Word): void;
}
```

Behavioral rules:

- A registered handler that lacks the requested method (e.g., handler defines `readByte` but caller does `inWord`) gets the fallback treatment described next.
- **Word access at a port that only registers byte handlers**: split into two byte accesses at `port` and `port+1`. Real hardware does the same — there's no such thing as a "word port" at the bus level; word I/O is two cycles.
- **Word access at a port that registers `readWord`/`writeWord`**: use the word handler directly.
- **Read with no handler**: 0xFF for byte, 0xFFFF for word (open-bus, matches `NullIOBus`).
- **Write with no handler**: silently drop.
- **Overlapping handlers**: throw on `register()` if the new range overlaps an existing one. Don't try to support overlapping registrations — that's a configuration bug, fail loudly.
- **Address space**: 64K I/O ports (0..0xFFFF). Don't pre-allocate a 64K array; use a sparse data structure (sorted list of ranges, or a Map keyed on port for single-port registrations + a smaller list for ranges, your call).

Test discipline: every behavioral rule above gets at least one test.

### PIC8259 design

State held by the PIC:

```ts
interface PICState {
  irr: number;       // 8-bit Interrupt Request Register: lines currently asserted
  isr: number;       // 8-bit In-Service Register: IRQs currently being handled
  imr: number;       // 8-bit Interrupt Mask Register: 1=masked
  vectorBase: number;// ICW2 high bits — IRQ N maps to vector (vectorBase + N)
  initState: 'idle' | 'awaitingIcw2' | 'awaitingIcw3' | 'awaitingIcw4';
  expectIcw3: boolean;        // ICW1 bit 1: 1 means single PIC (skip ICW3); 0 means cascade (expect ICW3)
                              // For v0 we only support single-PIC; if a programmer sets cascade mode, document and treat as single.
  expectIcw4: boolean;        // ICW1 bit 0: 1 means ICW4 will be sent
  levelTriggered: boolean;    // ICW1 bit 3
  readSelector: 'irr' | 'isr';// OCW3 selects which register a read of the command port returns
  // We don't model the rotating-priority modes; default fixed priority (IRQ 0 highest, IRQ 7 lowest).
}
```

#### Programming protocol (port 0x20 = command, 0x21 = data)

**Initialization sequence** (triggered by writing ICW1 to command port — bit 4 of value is 1):

1. ICW1 (command port, bit 4 = 1): records `expectIcw3` (bit 1 inverted: 0 means cascade, expect ICW3; 1 means single, skip ICW3), `expectIcw4` (bit 0), `levelTriggered` (bit 3). Sets `initState = 'awaitingIcw2'`. Resets IMR to 0xFF (all masked) — real hardware does this. Resets ISR to 0.
2. ICW2 (data port): high 5 bits become `vectorBase`. Low 3 bits ignored on real hardware (forced by IRQ number). Then state moves to `'awaitingIcw3'` if `!expectIcw3 ? skip → 'awaitingIcw4'` if `expectIcw4`, else `'idle'`.
3. ICW3 (data port, only if `expectIcw3`): describes cascade configuration. We ignore the value but consume the byte to keep the state machine honest. State moves to `'awaitingIcw4'` if `expectIcw4` else `'idle'`.
4. ICW4 (data port, only if `expectIcw4`): bit 0 = 8086/8088 mode (must be 1 for our purposes; reject or warn if 0). Bit 1 = auto-EOI (we don't support; reject or warn). Other bits: buffered mode (ignore), special fully nested (ignore). State moves to `'idle'`.

**Operation control words** (after init):

- Writes to data port (0x21) when `initState === 'idle'`: become IMR. Trigger a serviceability check.
- Writes to command port (0x20) when `initState === 'idle'`:
  - Bit 4 = 1: this is actually a re-init (ICW1). Restart the init sequence.
  - Bit 4 = 0, bit 3 = 0: this is OCW2 (EOI commands).
    - Bit 5 (EOI bit) = 1, bit 6 (specific) = 0, bit 7 (rotate) = 0: non-specific EOI. Clear the highest-priority bit currently set in ISR. Trigger serviceability check.
    - Bit 5 = 1, bit 6 = 1, bit 7 = 0: specific EOI. Low 3 bits identify which IRQ to clear in ISR. Trigger serviceability check.
    - Other OCW2 forms (rotate, set priority): not supported. Document and warn.
  - Bit 4 = 0, bit 3 = 1: this is OCW3.
    - Bit 0 = 1, bit 1 = 0: read IRR next time command port is read.
    - Bit 0 = 1, bit 1 = 1: read ISR next time command port is read.
    - Other OCW3 functions (poll mode, special mask): not supported. Document and warn.

**Reads**:

- Read from data port (0x21): return IMR.
- Read from command port (0x20): return IRR or ISR depending on `readSelector` (set by most-recent OCW3; default IRR).

#### IRQ assertion path

```ts
// Device-side API
pic.assertIRQ(n: number): void;     // 0..7. Sets bit in IRR (edge-triggered: noop if already set; level-triggered: same — we don't distinguish for v0 since we don't model the de-assertion timing window).
pic.deassertIRQ(n: number): void;   // 0..7. Clears bit in IRR if level-triggered. For edge-triggered, no effect (the request was latched at the rising edge).
```

For v0, support both edge and level modes per ICW1, but the practical difference in our simulation is small — devices call `assertIRQ` and `deassertIRQ` discretely, with no real "line goes high then low and we miss the rising edge" race.

#### Serviceability check (`#updatePending` or similar)

Called after any state change (assertIRQ, deassertIRQ, IMR write, EOI):

1. Compute pending = `IRR & ~IMR` (asserted and not masked).
2. If any bit in pending has higher priority than the lowest-numbered bit currently in ISR (or ISR is empty), select the highest-priority pending bit (= lowest IRQ number).
3. Move that bit from IRR to ISR, then call `controller.raise(vectorBase + n)`.
4. If no bit is selectable, do nothing.

The "higher priority than lowest in ISR" rule implements priority preemption: a higher-priority IRQ can interrupt a lower-priority handler if IF is set in the CPU. Lower-priority IRQs wait for the in-service handler to EOI.

**Important**: only ever raise one IRQ at a time. After `controller.raise()`, the PIC waits for EOI before raising another (the ISR bit is set, blocking equal-or-lower priority). The controller and CPU handle the actual delivery; the PIC's job is just to pick the next.

#### Constructor

```ts
class PIC8259 implements PortHandler {
  constructor(
    private readonly controller: InterruptController,
    options?: { commandPort?: number; dataPort?: number }
  ) { ... }

  // To wire into an IOBus:
  registerOn(bus: IOBus): void;  // Or expose readByte/writeByte directly and let the machine register; your call.
}
```

Default ports 0x20 / 0x21 (PC standard). Configurable so a future cascaded second PIC can use 0xA0 / 0xA1.

## Test plan

### IOBus unit tests (`tests/unit/io-bus.test.ts`)

- Register a single-port handler, byte read/write routes correctly.
- Register a port range, byte read at any port in the range routes; outside the range returns open-bus.
- Word read with `readWord` registered: uses the word handler.
- Word read with only `readByte` registered: composes two byte reads.
- Word write same: composes two byte writes if no `writeWord`.
- Word read straddling a registered range and an unregistered port: low byte from handler, high byte 0xFF.
- Unregistered port read: 0xFF / 0xFFFF.
- Unregistered port write: silently dropped.
- Overlapping registration throws.
- Unregister removes the handler.
- Unregister with a handler not registered: throws (or silent — pick one and document; consistent error policy is what matters).

### PIC unit tests (`tests/unit/pic.test.ts`)

Each test uses a fake `InterruptController` that records `raise()` calls. No CPU.

**Programming sequence**:
- Full ICW1→ICW2→ICW4 sequence (single-PIC mode), state ends at `idle`.
- Full ICW1→ICW2→ICW3→ICW4 sequence (cascade mode signaled but treated as single), state ends at `idle`. Document the choice in the report.
- ICW1 mid-sequence restarts the state machine.
- IMR set/get round-trip.
- Vector base from ICW2 (high 5 bits) — write 0x40, read implied vector for IRQ 0 = 0x40, IRQ 7 = 0x47.
- ICW2 low 3 bits ignored — write 0x47, IRQ 0 still uses vector 0x40 not 0x47.
- ICW4 bit 0 = 0 (MCS-80 mode) is rejected or warned.
- ICW4 bit 1 = 1 (auto-EOI) is rejected or warned.

**IRR/ISR/IMR semantics**:
- Assert IRQ 3 with PIC programmed and IRQ 3 unmasked: `controller.raise(base+3)` called once. IRR and ISR state inspectable via OCW3+read.
- Assert IRQ 3 with IRQ 3 masked: no `raise()` call. Unmask via IMR write: `raise()` now called.
- Multiple IRQs asserted simultaneously: highest-priority (lowest number) raised first.
- Assert IRQ 5 while IRQ 3 is in ISR: not raised (lower priority, blocked).
- Assert IRQ 1 while IRQ 3 is in ISR: raised (higher priority preempts; CPU's IF is what gates whether it actually fires, but the PIC delivers).

**EOI**:
- Non-specific EOI clears highest bit in ISR.
- Specific EOI clears named bit only.
- After EOI, lower-priority pending IRQ (queued during in-service of higher) is now raised.
- EOI when ISR is empty: no-op (don't crash).

**Reads**:
- OCW3 selects IRR; subsequent command-port read returns IRR.
- OCW3 selects ISR; subsequent command-port read returns ISR.
- Data-port read always returns IMR.

**Edge cases**:
- assertIRQ(8) throws (out of range).
- deassertIRQ on edge-triggered: documented behavior (probably no-op once latched, but state this).
- assertIRQ before initialization: documented behavior (probably stored in IRR but no `raise()` until vectorBase is set; specify and test).

### Integration test (`tests/unit/cpu-pic-integration.test.ts`)

One scenario, but a solid one. Set up:
- `PagedMemory` with a hand-laid IVT: vector 8 (= IRQ 0 if vectorBase = 8) points to a small handler.
- `BasicInterruptController`.
- `IOBus` with PIC registered on 0x20/0x21.
- `CPU8086` with controller + bus.
- Handler is, say, `MOV AX, 0x1234; MOV AL, 0x20; OUT 0x20, AL; IRET` — does some work, sends non-specific EOI, returns.
- Main program: `STI; HLT`.

Steps:
1. Program PIC: ICW1, ICW2 (vectorBase=8), ICW4 (8086 mode), then IMR=0xFE (only IRQ 0 unmasked).
2. CPU runs, reaches HLT.
3. Test code calls `pic.assertIRQ(0)`.
4. CPU wakes (HLT + maskable + IF=1), services interrupt, executes handler, returns.
5. Assert: AX=0x1234, ISR has been cleared by the EOI, CPU is back at the instruction after HLT (or halted again, depending on what comes next).

This single test validates: PIC programming via I/O ports, IRQ assertion, vector translation, controller.raise, CPU service, EOI, ISR clearing. If this passes, the whole pipeline works.

## Watch out for

- **The init state machine is the most bug-prone part of the PIC.** A misplaced ICW2 or wrong bit interpretation breaks everything downstream silently. Test the state-machine transitions explicitly.
- **OCW2 vs OCW3 distinction**: bit 3 of the command-port write determines which one. Bit 4 must be 0 for either (bit 4 = 1 means ICW1 = re-init). Easy to misread the bits and have OCW3 commands silently treated as OCW2 EOIs or vice versa.
- **ICW2's low 3 bits are forced by hardware to match the IRQ number**. Software typically writes them as 0 but if it writes nonzero, the PIC ignores them. Test this.
- **Priority is fixed: IRQ 0 highest, IRQ 7 lowest**. Don't accidentally implement reverse priority. The default 8259 mode is "fixed priority" with IRQ 0 winning.
- **The `controller.raise()` call must happen exactly once per IRQ-becomes-serviceable event**. Calling it twice (once on assertion, once on a subsequent IMR change that didn't actually unmask anything new) will service the IRQ twice. Drive everything through the single `#updatePending` method so there's one place to get this right.
- **IRR clears when the IRQ moves to ISR**, not when EOI happens. EOI clears the ISR bit. Don't conflate.
- **Word access to command port** (`outWord` to 0x20): real hardware just sees byte 0 written to 0x20 and byte 1 written to 0x21 (or the device might not support it at all, depending on bus implementation). For us: split as two byte writes, which through the IOBus's word-fallback rules will write to 0x20 then 0x21. Test and document. Most PIC programmers use byte writes anyway.
- **Don't pre-call `raise()` for every asserted-and-unmasked IRR bit on init.** If software programs the PIC after some IRR bits were latched (unusual but possible if devices assert before the OS programs the PIC), only the highest-priority one should fire after init completes.
- **The `controller.raise()` call from inside a port-write handler is fine** but means that an OUT instruction can effectively schedule an interrupt for the next instruction boundary. Real hardware behaves this way too. Verify the timing is correct in the integration test.

## Stop and ask

- If you find yourself wanting to change `cpu.step()` or anything in `src/cpu8086/`. The PIC is downstream of the CPU's I/O opcodes; nothing about it should require CPU changes.
- If `controller.raise()` interacts with the PIC's state machine in a way that requires the controller to know about the PIC. It shouldn't — the PIC pushes vectors into the controller, not vice versa.
- If the IOBus needs a method other than the four existing CPU-side ones plus `register`/`unregister`. The interface should stay minimal.
- If the corpus regresses (it shouldn't — none of this work touches CPU/opcode code, but verify).
- If you find yourself writing a "fake CPU" or "fake memory" for tests where the real ones would do. Use the real CPU + memory for integration tests; only stub `InterruptController` for the PIC unit tests.

## Definition of done

- New files implementing IOBus and PIC as specified.
- Existing tests still pass (422+ in unit, 329 corpus files green).
- New tests as specified, all green.
- Total unit test count ≥ 460 (422 baseline + ~40 new is plausible; less is fine if your tests are well-factored, more is fine if you found edge cases worth covering).
- `npm run typecheck` clean.
- Full corpus run still green.
- Report at project root: `PIC_REPORT.md` with these sections:
  - **Summary**: test counts, design choices made, pass status.
  - **IOBus design**: where you put the file, the data structure for port registration, how word fallback works, anything non-obvious.
  - **PIC design**: state machine layout, your `#updatePending` implementation strategy, anything you decided to support beyond the brief or skip with rationale.
  - **Cascading**: confirm what happens if software writes ICW1 with cascade-expected (bit 1 = 0). Treated-as-single? Rejected?
  - **Edge vs level triggered**: how you handle the distinction in our simulation model.
  - **Things future briefs will need to revisit**: cascading, auto-EOI, spurious IRQ 7, anything else you noticed.
  - **Verification**: exact commands, output summaries.

## Reference sources

1. Intel 8259A datasheet — the canonical programming reference. The state diagrams for ICW sequences and OCW2/OCW3 distinctions are non-obvious from prose; the diagrams help.
2. The IBM PC Technical Reference Manual — describes how the PIC is wired in the original 5150 (single-PIC at 0x20/0x21, IRQ 0 = timer, IRQ 1 = keyboard, etc.). Useful context for what realistic IRQ usage looks like, even though the PIC itself doesn't care about specific assignments.
3. OSDev wiki PIC article — practical programmer's-eye view; good for sanity-checking initialization sequences.
4. Adrian Cable's 8086tiny — has a PIC implementation; see how they handle the EOI and serviceability check.
5. The existing `InterruptController` in `src/interrupts/controller.ts` — your downstream. The PIC calls into this; do not modify the controller.

## Appendix: why this brief is the bridge to the rest of the project

Up to now the emulator has been all CPU and memory — pure computation, no devices. This brief crosses that line for the first time. After it lands:

- Adding a PIT (next brief) is "build a state machine that calls `pic.assertIRQ(0)` periodically." Small.
- Adding a keyboard controller is "build a state machine that calls `pic.assertIRQ(1)` when a key arrives." Small.
- Building a Machine config that boots a real BIOS becomes assembly: CPU + memory + controller + bus + PIC + PIT + keyboard + display, wired together once.

The PIC is the keystone for all of that. Get this right and everything downstream is composition rather than design.
