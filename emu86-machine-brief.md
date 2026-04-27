# emu86 — Agent Brief: First Machine Configuration (IBM PC)

## TL;DR

Build the first concrete `Machine` class — `IBMPCMachine` — that composes everything we've built so far (CPU, memory, interrupt controller, clock, IOBus, PIC, PIT) into a coherent IBM PC-compatible system. Wire up standard IRQ assignments, port addresses, and a power-on reset path. Verify by running a small hand-assembled test program through the Machine end-to-end. Ship a green test run plus a report at `MACHINE_REPORT.md`.

You are working in `emu86/`. Read `README.md`, the prior reports (`PIC_REPORT.md`, `PIT_REPORT.md`, etc.), and the existing integration tests (especially `tests/unit/cpu-pit-pic-integration.test.ts`, which is essentially a hand-wired version of what you're systematizing) before writing anything. This brief is composition work — most of the design decisions have been made by prior briefs. You're applying them.

## Hard rules

1. **Don't break existing tests.** Current state: 519 unit tests + 329 corpus files passing. Both must stay green. Run `npx vitest run tests/unit/` after every meaningful change. Run the corpus once at the end as a regression check.
2. **No interface changes** to existing types. Additive only. `CPU8086`, `Memory`, `InterruptController`, `Clock`, `IOBus`, `PIC8259`, `PIT8254` all stay as they are.
3. **`cpu.step()` stays pure synchronous.** Same constraint as always.
4. **Strict TypeScript stays strict.** No `any`, no `as unknown as`, no `// @ts-ignore`.
5. **No abstract base class for "Machine" yet.** This is the first concrete machine; until there's a second one, an abstract base is premature. Just `IBMPCMachine` as a concrete class.
6. **No BIOS loading in this brief.** This brief proves composition by running a hand-assembled test program. The actual 8086tiny BIOS load is the next brief — it'll have its own complications (read-only ROM regions, missing devices the BIOS expects, etc.) that deserve their own focus. Note that the BIOS file lives at `reference/8086tiny/bios` and source at `reference/8086tiny/bios_source/bios.asm` if you want to peek for context, but don't load it.
7. **Determinism.** Same program, same input, same output, every time.

## Scope

### What you're building

1. **`IBMPCMachine` class** (`src/machine/ibm-pc.ts`) — composes existing chips, wires them with PC-standard addresses, provides lifecycle methods (`reset`, `loadProgram`, `setEntryPoint`, `run`).
2. **An integration test** with a hand-assembled program that exercises CPU + memory + I/O + interrupts end-to-end through the Machine.
3. The barrel exports.

### What you are NOT building

- Any new device. PPI, video, keyboard, DMA, RTC, serial, parallel — all future work.
- An abstract `Machine` base class. Concrete only for v0.
- BIOS loading or ROM regions in memory.
- Save/restore of machine state. Memory persistence already exists via `PageStore`; device state persistence is a future brief.
- A console / display abstraction. The test program writes to memory, not to anything visible. The visible-output story comes when video memory exists.
- Real-time pacing. The clock advances as fast as the CPU runs (existing virtual-time semantics). Wall-clock throttling is a future brief.

## Design

### File layout

New:
- `src/machine/ibm-pc.ts` — the `IBMPCMachine` class.
- `src/machine/index.ts` — barrel.
- `tests/unit/ibm-pc-machine.test.ts` — Machine tests (construction, lifecycle) + the end-to-end program test.

Modified:
- `src/index.ts` — export the new `machine/` barrel.
- Possibly: any device that lacks a `reset()` method gets one. The PIC and PIT don't currently have explicit reset methods (per the prior reports, init is via software writing ICW1, etc.). Adding `reset()` methods that put each device back into its post-construction state is a small additive change. Verify with the existing test suite that the behavior matches "freshly constructed" state.

### `IBMPCMachine` shape

```ts
export interface IBMPCMachineConfig {
  /** Memory size in bytes. Default 0x100000 (1 MiB, the 8086 max). */
  memorySize?: number;
  /** Page store for memory persistence. Optional; default is no persistence. */
  pageStore?: PageStore;
  /** Clock cycles per PIT tick. Default 4 (real PC ratio). */
  cyclesPerPitTick?: number;
  /** Run-loop batch size. Default 10_000. */
  batchSize?: number;
  /** Halt-spin clock advance per yield. Default = batchSize. */
  haltCyclesPerSpin?: number;
  /** Optional warning sink for device warnings. Default silent. */
  warn?: (msg: string) => void;
}

export class IBMPCMachine {
  readonly cpu: CPU8086;
  readonly memory: PagedMemory;
  readonly controller: BasicInterruptController;
  readonly clock: Clock;
  readonly bus: BasicIOBus;
  readonly pic: PIC8259;
  readonly pit: PIT8254;
  readonly runLoop: RunLoop;

  constructor(config?: IBMPCMachineConfig);

  /** Power-on reset: resets CPU, drains controller, resets all devices. */
  reset(): void;

  /** Load bytes into memory at the given linear address. */
  loadProgram(bytes: Uint8Array | number[], linearAddress: number): void;

  /** Override CS:IP. Useful for tests; in real operation, reset puts
   *  CS:IP at 0xFFFF:0x0000 and the BIOS jump-vector takes it from there. */
  setEntryPoint(segment: number, offset: number): void;

  /** Convenience wrapper around runLoop.run() with the Machine's defaults. */
  run(opts?: RunLoopOptions): Promise<RunResult>;

  /** Stop the run loop. */
  stop(): void;
}
```

All components are exposed as readonly properties so tests and advanced consumers can poke at any layer directly. The Machine is a wiring harness, not an opaque wrapper.

### Wiring (the actual work this brief does)

The constructor does, in order:

1. **Build the substrate**: `Clock`, `PagedMemory`, `BasicInterruptController`, `BasicIOBus`.
2. **Construct devices that need substrate**:
   - `PIC8259(controller)` — needs the controller to push vectors into.
   - `PIT8254(clock)` — needs the clock to subscribe to.
3. **Register devices on the bus**: `pic.registerOn(bus)` (default ports 0x20-0x21), `pit.registerOn(bus)` (default ports 0x40-0x43).
4. **Wire device interconnections**: 
   - PIT channel 0 rising edge → `pic.assertIRQ(0)`. This is the only inter-device wire in the current device set. Pass via the PIT's `onChannel0RisingEdge` constructor option.
   - Channels 1 and 2's rising edges have no consumers in this brief; default no-op callbacks are fine.
5. **Construct the CPU**: `CPU8086(memory, bus, controller)`. (Verify the existing constructor signature; it may be different.)
6. **Construct the run loop**: `RunLoop(cpu)` with the clock, batchSize, and haltCyclesPerSpin from config.

That's the whole composition. No magic.

### Reset semantics

`machine.reset()`:
1. CPU reset (existing `cpu.reset()` — sets CS:IP, clears flags, etc.)
2. Drain the controller (a fresh `BasicInterruptController` would be empty, but reset semantics should mean "clear pending"). The current `BasicInterruptController` may not have a `reset()` method; if not, add one (or expose `clear()` — pick a name and document).
3. Reset each device. The PIC's reset returns it to pre-init state (init state machine resets, IMR=0xFF, ISR=0, IRR=0, vectorBase=0). The PIT's reset returns each channel to its default state (counters loaded with 0, mode 0, output low, etc.). Add `reset()` methods to PIC and PIT if they don't exist. Make sure these methods are truly equivalent to "freshly constructed" state.

The clock's `reset()` is interesting. Should `now()` go back to 0? Yes — reset is a power-on event, virtual time starts over. Add a clock reset method.

Memory does NOT reset (RAM contents survive a power-on reset on real hardware, and our memory is the persistent layer; clearing it would defeat the persistence work). Document this.

### Memory map

For Scope A (test programs), the entire 1 MiB is RAM. The Machine does not pre-mark any region as ROM — that's a future feature for the BIOS brief. The IVT at 0x00000-0x003FF is just plain RAM that software writes vectors into. The BIOS area at 0xF0000-0xFFFFF is also plain RAM in this brief.

`loadProgram(bytes, linearAddress)` is the primary mechanism for getting code/data into memory. It's a thin wrapper over `memory.writeByte` in a loop.

### Power-on entry point

Real 8086 reset sets CS:IP to 0xFFFF:0x0000. On a real PC, that's the start of the BIOS ROM, where there's a far jump to the actual BIOS entry point.

For this brief, the test program is loaded into RAM at some convenient address, and `setEntryPoint` is used to point CS:IP there. This is a test affordance; in BIOS-land we won't need it.

Document that calling `setEntryPoint` is the test-friendly path; for "real" operation (when a BIOS is loaded), the standard reset vector handles things and this method shouldn't be called.

## Test plan

### Construction and lifecycle (`tests/unit/ibm-pc-machine.test.ts`, part 1)

A handful of tests, ~10:

- Construct a default `IBMPCMachine`, verify all components are present and have expected types.
- Verify default config values: 1 MiB memory, batchSize=10000, etc.
- Verify the PIT is wired to the PIC (assert raising IRQ 0 on the PIC after triggering a rising edge on PIT channel 0 manually — possible via the PIT's existing test API).
- `loadProgram` correctly writes bytes at the given address.
- `loadProgram` accepts both `Uint8Array` and `number[]`.
- `setEntryPoint` updates CS:IP.
- `reset()` returns CPU, controller, PIC, PIT, clock to power-on state.
  - After programming the PIC and resetting, the PIC is back to uninitialized state.
  - After ticking the clock and resetting, `clock.now()` is 0.
  - Memory is preserved across reset (test by writing a byte, resetting, verifying byte is still there).
- A custom `pageStore` is wired through to memory persistence (write a byte, flush, verify it persisted).

### End-to-end program test (`tests/unit/ibm-pc-machine.test.ts`, part 2)

The headline test of this brief. One scenario, but a real one. The test:

1. Constructs an `IBMPCMachine` with `cyclesPerPitTick: 1` and `batchSize: 100` (small, so PIT fires in tractable time).
2. Loads a hand-assembled program that:
   - Programs the PIC: ICW1 (cascade=0, ICW4=1), ICW2 (vector base = 0x08), ICW4 (8086 mode), then writes 0xFE to 0x21 (only IRQ 0 unmasked).
   - Programs the PIT: control word for channel 0 mode 3 lohi access, divisor 100 (0x64, 0x00).
   - Installs an IRQ 0 handler at some known location. The handler increments a memory counter, sends non-specific EOI to the PIC (out 0x20, 0x20), and IRETs.
   - Sets up the IVT[8] to point at the handler (write the handler's offset and segment to linear 0x20-0x23).
   - Runs `STI; HLT; JMP $-2` (or similar — the JMP is for the handler return path: post-IRET we land back at the JMP, which loops back to HLT until next interrupt).
3. Sets the entry point to where the program is loaded.
4. Runs the loop with `maxInstructions: 5000`.
5. Asserts: the memory counter is non-zero (probably between 5 and 50; assert `> 0` and `< 100` for robustness — exact count depends on instruction count vs PIT divisor vs halt-spin behavior).

This is exactly the shape of `tests/unit/cpu-pit-pic-integration.test.ts`, but exercised through the Machine's wiring instead of hand-wired. The `IBMPCMachine` class earns its keep when this test passes with significantly less setup boilerplate than the existing integration test.

#### Hand-assembling the program

This is the tedious part. Here's a sketch — you'll need to verify byte-for-byte against an opcode reference; do not trust this list as-is:

```
; --- Initialize PIC ---
; MOV AL, 0x11        ; ICW1: edge, cascade=0, ICW4=1
; OUT 0x20, AL
; MOV AL, 0x08        ; ICW2: vector base = 0x08
; OUT 0x21, AL
; MOV AL, 0x01        ; ICW4: 8086 mode, no auto-EOI
; OUT 0x21, AL
; MOV AL, 0xFE        ; IMR: only IRQ 0 enabled
; OUT 0x21, AL
;
; --- Initialize PIT channel 0 ---
; MOV AL, 0x36        ; control word: ch0, lohi, mode 3, binary
; OUT 0x43, AL
; MOV AL, 0x64        ; divisor low byte (100)
; OUT 0x40, AL
; MOV AL, 0x00        ; divisor high byte
; OUT 0x40, AL
;
; --- Install IRQ 0 handler ---
; ; Vector 8 is at linear 0x20 = segment 0, offset 0x20.
; ; IVT entry is [offset_lo, offset_hi, segment_lo, segment_hi].
; XOR AX, AX
; MOV ES, AX
; MOV WORD PTR ES:[0x20], handler_offset
; MOV WORD PTR ES:[0x22], 0       ; handler is in segment 0
;
; --- Main loop ---
; STI
; main_loop:
; HLT
; JMP main_loop
;
; --- Handler ---
; handler:
; INC WORD PTR DS:[counter_addr]
; MOV AL, 0x20
; OUT 0x20, AL
; IRET
```

The hand-assembled bytes are tedious. Two pragmatic options:

**Option A**: Write the bytes out in the test file as a `number[]` literal with detailed comments mapping each byte back to the assembly source. Tedious but transparent. Good for ~50 bytes of code, painful for 200+.

**Option B**: Assemble using a simple in-tree assembler — but we don't have one and adding one is out of scope. So this is really option A, just with the labor visible.

If hand-assembling proves too painful or error-prone, write a smaller program (e.g., skip the IVT install by using `loadProgram` to write the IVT directly from the test, leaving only the PIC / PIT / STI / HLT in assembly). The point is to exercise composition end-to-end, not to demonstrate assembly skills.

Note: the existing `tests/unit/cpu-pit-pic-integration.test.ts` already has a hand-assembled program in this shape. **You may copy or closely adapt that program** — it's already known to work. The interesting part of this test is that it runs through the Machine wrapper, not that it's a from-scratch program.

### What you don't need to test

- Each device's individual behavior — already covered by their own unit tests.
- The CPU's instruction semantics — corpus-verified.
- Memory and persistence behavior — already covered.
- The run loop's batch behavior — already covered.

The Machine tests should focus on **what the Machine class adds**: composition, wiring, lifecycle. Nothing else.

## Watch out for

- **Order of construction**: PIC needs controller, PIT needs clock, CPU needs memory and bus. Get the order right or you'll have undefined references.
- **Wiring direction for PIT → PIC**: install the rising-edge callback on the PIT, do not modify the PIC. Per `PIC_REPORT.md` the PIC is controller-agnostic and the PIT is PIC-agnostic; the Machine glues them.
- **`reset()` cascade**: the Machine's reset must be lossless from the device-state-perspective — every device must end up in its post-construction state, and the order of resets shouldn't matter (e.g., resetting the controller before or after the PIC should produce the same end state). Test this if you're unsure.
- **PIC and PIT may not have `reset()` methods today**: if not, add them. Verify the new methods produce state equivalent to fresh construction (a quick test: construct a device, call methods to mutate state, call reset, compare state via inspection getters to a freshly-constructed device's state).
- **Clock reset and now()**: virtual time starts at 0 on reset. A subscriber that holds onto a "last seen now()" value won't be reset by the Clock; the *device* must reset its own time-tracking state in its own `reset()`. The PIT, in particular, has internal time-tracking state (`lastClockTick` per the PIT design notes). Verify that PIT.reset() resets that too.
- **Don't let the Machine become a god object**: it should be ~100 lines plus barrel exports. If it's growing past that, you're putting logic in the Machine that belongs in a device.
- **The test program is the load-bearing test**: if it doesn't pass, the composition is wrong somewhere. Most likely culprits: PIT-PIC wiring (rising-edge callback not installed), PIC port registration (wrong ports), IRQ 0 not unmasked correctly, IVT pointing at the wrong address, handler not EOI-ing.
- **The 8086tiny BIOS file**: it lives at `reference/8086tiny/bios`. Source at `reference/8086tiny/bios_source/bios.asm`. **Do not load it in this brief**, but glance at it if you want to understand what the next brief will need. The BIOS expects video memory, keyboard ports, etc., none of which exist yet.

## Stop and ask

- If you find yourself wanting to change anything in `src/cpu8086/`, `src/core/`, `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`, or `src/timing/`. Adding `reset()` methods to `src/devices/pic.ts` and `src/devices/pit.ts` is fine; anything else, ask.
- If the corpus regresses (it shouldn't — none of this work touches the CPU).
- If a Machine config option seems necessary that isn't in the proposed `IBMPCMachineConfig` shape — design choice worth surfacing.
- If hand-assembling the test program proves so painful that you want to add an assembler dependency. Don't add one without asking.
- If `cpu.step()` starts wanting to be async (it shouldn't).

## Definition of done

- `src/machine/ibm-pc.ts` implements the `IBMPCMachine` class as specified.
- Reset methods added to PIC and PIT (and possibly controller and clock) as needed.
- All existing 519 unit tests still pass.
- New tests as specified, all green.
- Total unit test count ≥ 530 (519 baseline + ~11+ new).
- `npm run typecheck` clean.
- Full corpus run still green.
- Report at project root: `MACHINE_REPORT.md` with these sections:
  - **Summary**: test counts, pass status, any deviations from the brief.
  - **Wiring details**: the exact construction order, port assignments, and the PIT-to-PIC callback wiring. A small ASCII diagram of "what's connected to what" would be helpful.
  - **Reset semantics**: which components got new `reset()` methods, what each one does, whether memory survives reset (it should), and whether `clock.now()` resets to 0 (it should).
  - **Test program**: did you adapt the existing integration test or write a new one? What does the assembled program do? What were the observed IRQ counts in your test runs?
  - **Things future briefs will need**: read-only ROM regions for BIOS loading, additional devices (PPI, video, keyboard) the BIOS will expect, save/restore of device state for full machine snapshots.
  - **Verification**: exact commands, output summaries.

## Reference sources

1. The existing integration test (`tests/unit/cpu-pit-pic-integration.test.ts`) — your model for the end-to-end test program.
2. IBM PC Technical Reference Manual — port assignments, memory map (the `0x20`/`0x21`/`0x40-0x43` etc. addresses are documented there).
3. The prior reports in this repo — design rationale for each component you're composing.
4. 8086tiny BIOS source at `reference/8086tiny/bios_source/bios.asm` — for context on what the next brief will need (do not load it in this brief).

## Appendix: what the next brief will look like

After this lands, the BIOS-boot brief becomes:

1. Add read-only region support to `PagedMemory` (or add a separate `ROM` `PageStore` and compose).
2. Load the 8086tiny BIOS into the appropriate ROM region.
3. Set CS:IP to the standard reset vector (0xFFFF:0x0000) — there should be a far jump there from the BIOS.
4. Run.
5. Triage what happens. The BIOS will try to access devices we don't model (keyboard, video, possibly disk). For each, decide: stub silently, stub with warning, or implement minimally enough to satisfy the BIOS's probe.
6. Eventually reach a point where the BIOS reports "no boot device" or similar, which is the success condition for "we ran the BIOS" in the absence of disk emulation.

That brief is exploratory — we don't know exactly what the BIOS will probe for, and the process of finding out is the work. Different shape from the precise-spec briefs we've been doing. Worth a fresh framing.
