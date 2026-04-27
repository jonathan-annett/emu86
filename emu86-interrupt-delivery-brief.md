# emu86 — Agent Brief: Async Interrupt Delivery

## TL;DR

Implement the path for async sources to deliver hardware interrupts (INTR and NMI) to the 8086 CPU. The CPU services them synchronously at instruction boundaries with correct save state, IF gating, NMI bypass, HLT wake, and the documented one-instruction inhibit windows after STI / POP SS / MOV SS,r/m. Verify entirely in Node via deterministic tests. Ship a green test run plus a report at `INTERRUPT_DELIVERY_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `CORPUS_VALIDATION_REPORT.md`, and `IDB_PAGE_STORE_REPORT.md` first. Read `src/cpu8086/cpu.ts` and the existing `serviceInterrupt` helper (it's used by INT, INTO, divide-error). Your work extends the CPU to call that helper from a new place — the instruction boundary check — driven by an interrupt controller.

## Hard rules

1. **Don't break existing tests.** Current state: 395 unit tests + 3,007,000 corpus cases passing. Both must stay green. Run `npx vitest run tests/unit/` after every meaningful change. Run the corpus once at the end.
2. **`cpu.step()` stays pure synchronous.** Async lives in the run loop and in interrupt sources, never in the CPU. The controller is queried synchronously by `step()`.
3. **No interface changes** to existing public types (`Memory`, `PageStore`, `IOBus`, the existing CPU surface). The CPU constructor gains an optional parameter; that's an addition, not a change.
4. **No architectural changes** to `src/core/`, `src/memory/`, or `src/runtime/run-loop.ts`'s overall shape. The run loop gets a tiny adjustment to its exit condition (so HLT-with-pending-interrupts wakes); that's it.
5. **Strict TypeScript stays strict.** No `any`, no `as unknown as`, no `// @ts-ignore`.
6. **Determinism over realism in tests.** Don't use real timers in unit tests. Either drive the controller directly (`controller.raise(vec)`) or use `vi.useFakeTimers()`. Tests must be deterministic and fast.

## Scope

### What you're building

The mechanism for async interrupt delivery. Three concerns:

1. **Interrupt controller** — a queue with two intake methods (maskable `raise` and non-maskable `raiseNMI`) and a "what's next to service" view that the CPU consumes.
2. **CPU boundary check** — at the top of `step()`, the CPU consults the controller and services any pending interrupt that's eligible to fire (IF gating, inhibit windows, NMI bypass).
3. **HLT integration** — the run loop's halted state must yield to the event loop, allow async sources to fire, then re-check whether an interrupt has arrived to wake the CPU.

### What you are NOT building

- The 8259 PIC. The controller you build is intentionally PIC-agnostic. A future PIC will be a *device* that sits between async sources and our controller, doing priority management, masking, and EOI. Don't bake any of that in.
- Real timer sources, keyboard sources, or any device. The controller is the substrate; devices come later.
- A scheduler. Sources call `raise()` whenever they want; ordering is FIFO with NMI jumping the queue.
- Any change to how software interrupts (INT n / INT3 / INTO / divide-error) work. Those are corpus-verified and untouched.
- Cycle-accurate timing.

## Design

### File layout

New files:
- `src/interrupts/controller.ts` — `InterruptController` interface, `BasicInterruptController` implementation, `NullInterruptController` (always empty).
- `src/interrupts/index.ts` — barrel export.
- `tests/unit/interrupt-controller.test.ts` — controller unit tests in isolation.
- `tests/unit/cpu-interrupts.test.ts` — CPU-controller integration tests.

Modified files:
- `src/cpu8086/cpu.ts` — constructor accepts optional `InterruptController` (default: `NullInterruptController`). `step()` adds boundary check at the top. New `interruptInhibit: boolean` field, set by POP SS / MOV SS / STI per the rules below, cleared at end of next `step()`.
- `src/cpu8086/opcodes-stack.ts` — POP SS sets `interruptInhibit`.
- `src/cpu8086/opcodes-mov.ts` (or wherever MOV to seg-reg lives) — MOV SS, r/m sets `interruptInhibit`.
- `src/cpu8086/opcodes-flags.ts` (or wherever STI lives) — STI sets `interruptInhibit` and IF (in that order, see below).
- `src/runtime/run-loop.ts` — exit condition update for halted-with-pending case.
- `src/index.ts` — export the new module.

### `InterruptController` interface

```ts
export interface InterruptController {
  /** True if an NMI is pending (always serviceable, IF doesn't gate it). */
  hasNMI(): boolean;
  /** True if at least one maskable interrupt is queued. IF gating is the CPU's concern. */
  hasMaskable(): boolean;
  /** Consume and return the pending NMI flag. Returns false if no NMI was pending. */
  consumeNMI(): boolean;
  /** Consume and return the next maskable vector. Throws if none pending — caller must check first. */
  consumeMaskable(): number;
  /** Source-side: enqueue a maskable interrupt with the given vector (0..255). */
  raise(vector: number): void;
  /** Source-side: signal NMI (vector is fixed at 2 by hardware). */
  raiseNMI(): void;
}
```

`BasicInterruptController` implements with a simple FIFO queue (an array, push/shift; a real ring buffer is premature) plus a single boolean for NMI. The vector argument to `raise` is validated (0..255, integer). NMI is idempotent — calling `raiseNMI()` twice without a `consumeNMI()` between them is the same as calling it once. Maskables are not deduplicated — same vector raised twice means service twice. (The PIC will dedupe at its level when we get there.)

`NullInterruptController` is a static no-op. `hasNMI`/`hasMaskable` always return false; `consume*` either throws or returns falsy depending on the interface contract above. Used as the default so existing tests don't need to construct one.

### CPU step() boundary check

Pseudocode for the top of `step()` (replaces the current `if (this.halted) return;` early exit):

```ts
step() {
  // 1. Halt is broken by NMI always; by maskable iff IF=1 and not inhibited.
  if (this.halted) {
    if (this.intCtrl.hasNMI() ||
        (this.intCtrl.hasMaskable() && this.flags.IF && !this.interruptInhibit)) {
      this.halted = false;
    } else {
      return;  // stay halted; run loop will yield and try again
    }
  }

  // 2. Service interrupts at the boundary, NMI first.
  if (this.intCtrl.hasNMI()) {
    this.intCtrl.consumeNMI();
    serviceInterrupt(this, 2);
    // Fall through to actually execute the next instruction at the new CS:IP.
  } else if (this.intCtrl.hasMaskable() && this.flags.IF && !this.interruptInhibit) {
    const vec = this.intCtrl.consumeMaskable();
    serviceInterrupt(this, vec);
  }

  // 3. The interrupt-inhibit window is one instruction — clear it now so it
  //    only suppresses the very next interrupt check, which we just did.
  //    But: STI sets it for the *current* check (the one above), so we must
  //    clear it AFTER the check, not before. See "STI delayed enable" below.
  this.interruptInhibit = false;

  // 4. Existing instruction fetch and dispatch.
  this.segOverride = null;
  const opcode = this.fetchByte();
  // ... etc
}
```

Note: servicing an interrupt does NOT skip the instruction fetch for this step. The semantics are: we landed at the new CS:IP after the service, then immediately fetch and execute the first instruction of the handler. This matches real hardware behavior — interrupt service is "between" instructions, not "instead of."

Actually, on reflection, I want to revise that — the cleanest reading is that the interrupt service handler in the corpus session already does the IVT lookup and the far-jump, leaving CS:IP pointing at the handler's first instruction. So `step()` services the interrupt and then continues into the fetch — fetching the first instruction of the handler. That's what the pseudocode above does. Verify against the existing `serviceInterrupt` implementation that this is its contract.

### The three inhibit-window quirks (these are 8086 silicon, easy to get wrong)

1. **STI delayed enable.** Real 8086 quirk: the instruction immediately following STI does NOT see the interrupt-enable take effect. The intent is that `STI; RET` doesn't get interrupted before RET completes (e.g., in interrupt service code returning to the caller).
   - Implementation: STI sets IF=1, AND sets `interruptInhibit=true`. The boundary check at the top of the *next* `step()` sees IF=1 but `interruptInhibit=true`, so it doesn't service. After that step, `interruptInhibit` clears, and the step *after* that one will service.
   - Note: the corpus does NOT test this because it tests instructions in isolation. So you must add unit tests for it, and the unit tests ARE the only verification this gets.

2. **POP SS / MOV SS,r/m one-instruction inhibit.** These instructions are typically followed by a corresponding load of SP, and an interrupt between them would push to a half-loaded SS:SP combination, which would be very bad. Real hardware suppresses interrupts for exactly one instruction after.
   - Implementation: POP SS and MOV SS,r/m set `interruptInhibit=true`. Same mechanism as STI.
   - This is a defined hardware behavior, well-documented, and subtle to get right.

3. **NMI bypasses IF but NOT the inhibit window? Or does it?** This is the spec ambiguity. Reasonable readings differ. Consult 8086tiny and the corpus's `v2_undefined/` for any signal. My best understanding: NMI is gated by NEITHER IF nor the inhibit window — it's truly non-maskable. Implement that way unless you find evidence otherwise. Document the choice in the report.

These three behaviors don't share state cleanly with a single "inhibit" flag if you squint at them, because POP SS and MOV SS inhibit ALL interrupts (including NMI on real hardware? — uncertain), while STI inhibits only the IF check. If you find this matters, split into two flags. If everything passes with a single flag, ship it. Document the choice.

### Run loop adjustment

Current loop exits on `cpu.halted`. Update so:
- Inside the inner batch: `if (cpu.halted && !cpu.intCtrl.hasNMI() && !cpu.intCtrl.hasMaskable()) break;`
- Outer loop: same termination logic (we only stop when halted with no pending), but the `await yieldToEventLoop()` at the end of each batch gives async sources a chance to call `raise()`. After the yield returns, we re-enter the inner loop and the boundary check at the top of `step()` does its job.

The result: a halted CPU with IF=1 and a setTimeout-driven source firing maskable interrupts will yield, receive the interrupt, wake, service, execute the handler. A halted CPU with IF=0 and only maskables in the queue stays halted forever (correct — that's what HLT with masked interrupts means). Tests must use `maxInstructions` or `stop()` to escape that case.

There's a subtle scheduling concern: if the run loop keeps spinning because halted-but-no-interrupt-pending and a yield happens, you might burn CPU on tight yield loops. Mitigation: the yield itself is `setTimeout(0)`, which has a minimum delay (4ms in browsers, 1ms in Node by default). That's fine for halt-spinning. If we ever care about reducing halt-spin overhead, we can add an event-driven wake (the controller could expose a `whenPending(): Promise<void>`), but that's optimization, not v0.

## Test plan

### Controller-only tests (`tests/unit/interrupt-controller.test.ts`)

- `raise` enqueues a vector; `hasMaskable` is true; `consumeMaskable` returns it.
- Multiple `raise` calls are serviced FIFO.
- `raise(257)` throws (vector validation). `raise(-1)` throws. `raise(1.5)` throws.
- `raiseNMI` sets the flag; `hasNMI` is true. Calling twice has the same effect as once. `consumeNMI` clears it and returns true; subsequent `consumeNMI` returns false.
- `consumeMaskable` when none pending throws (or returns a sentinel — your choice, but be consistent with the interface contract).
- NMI and maskables coexist independently in the queue.
- `NullInterruptController` always says nothing pending.

### CPU integration tests (`tests/unit/cpu-interrupts.test.ts`)

This is where the real verification lives. Build a tiny CPU with `BasicInterruptController` and a `PagedMemory` containing a hand-laid IVT and handler. Then drive scenarios:

1. **Maskable, IF=1**: raise vector 0x40, step. Assert: FLAGS pushed, CS pushed, IP pushed (in that order, matching `serviceInterrupt`'s contract), IF=0 after, TF=0 after, CS:IP now points to the IVT[0x40] handler.
2. **Maskable, IF=0**: raise vector 0x40, step a NOP. Assert: NOP executed normally, vector still pending in controller (we did NOT consume it).
3. **Maskable becomes serviceable after STI**: IF=0 initially, raise vector, execute STI, then NOP, then any instruction. Assert: STI itself is not interrupted (delayed enable), the NOP after STI is not interrupted, the instruction after that IS interrupted.
4. **NMI with IF=0**: raiseNMI, step. Assert: serviced anyway (vector 2).
5. **NMI takes priority over pending maskable**: raise vector 0x40, raiseNMI, step. Assert: NMI serviced first (vector 2), maskable still queued.
6. **POP SS inhibit**: with IF=1 and a vector pending, execute POP SS. Assert: the next instruction is NOT interrupted; the instruction after that IS.
7. **MOV SS,r/m inhibit**: same as above but with MOV SS, AX.
8. **STI; RET pattern**: classic interrupt-handler tail. Set up so RET pops a return address; raise an interrupt. STI then RET. Assert: RET completes (returns to the original caller), THEN the pending interrupt is serviced (now we're in the interrupt handler from the *original* context).
9. **HLT wake by maskable, IF=1**: HLT, then raise vector. Run the loop with `maxInstructions` ceiling. Assert: CPU woke, serviced interrupt, executed handler.
10. **HLT not woken by maskable, IF=0**: HLT, IF=0, raise vector. Run with `maxInstructions=100`. Assert: still halted, vector still pending, executed count ≈ 0 (or whatever the loop does for "halted with no service" — confirm and document).
11. **HLT woken by NMI even with IF=0**: HLT, IF=0, raiseNMI. Assert: woke, serviced NMI.
12. **Interrupt mid-REP-string**: set up REP MOVSB with CX=10, raise an interrupt mid-loop (call `raise()` after, say, 3 iterations — you'll need to control this; one way is a custom controller that raises after N `consumeMaskable` queries returning false, or step the CPU manually 3 times and then raise). Assert: after the interrupt is serviced and IRET executes, REP MOVSB resumes correctly with CX decremented to where it left off and SI/DI advanced. This is the trickiest test; if it's hard to set up, document and move on, but try.
13. **TF (single-step) interaction**: TF=1, an interrupt arrives. Assert: TF cleared by interrupt service path. The handler doesn't fire INT 1 spuriously inside the IRET-target flow.
14. **No-controller default**: instantiate a CPU without specifying a controller. Assert: works exactly as before, no behavior change. (This is the "don't break 395 tests" backstop.)

### Run loop tests (extending `tests/unit/run-loop.test.ts`)

- HLT-with-IF=1-and-source-driven-interrupt: use `vi.useFakeTimers()` + a setTimeout-driven source that calls `raise()` after 50ms. Run the loop. Assert: completes, instruction count > 0, halted=false at end (or whatever the post-HLT-handler state is).
- Stop request while halted: HLT with no pending interrupts, call `stop()`, assert loop exits with `reason='stopped'`.

### What you don't need to test

- INT/INT3/INTO/IRET semantics — corpus-verified, unchanged.
- `serviceInterrupt` itself — corpus-verified.
- Memory/page store — done.
- The PIC, devices, timers — out of scope.

## Watch out for

- **Order of ops on STI**: set IF=1 BEFORE setting `interruptInhibit=true`, otherwise the inhibit clear at the end of the same step will clobber what you intended. Better: STI sets IF and inhibit; the next step's boundary check evaluates `IF && !inhibit` (false because of inhibit); the inhibit then clears at end of that step; the step after sees `IF && !inhibit` (true). Walk through it on paper.
- **Where `interruptInhibit` is cleared in `step()`**: must be AFTER the boundary check, not before. If cleared before, STI's set-on-current-step is a one-step bug. Easy to mis-order.
- **Interrupt service mid-execution-of-prefixed-instruction**: prefixes (segment override, REP, LOCK) are part of the next instruction. If the boundary check happens at the top of step() and a prefix has been fetched in the previous iteration, you'd interrupt between prefix and the actual op, which real hardware doesn't do. Verify your existing prefix handling consumes the whole prefixed instruction within a single `step()` call. (It should — the prefix handlers in the corpus session were designed this way.) If they don't, you have a problem; surface it before fixing.
- **Far jump in `serviceInterrupt`**: confirm it correctly reads the IVT (4 bytes per vector, vector*4 = linear address; 2 bytes IP, 2 bytes CS, in that order). The corpus verified this for software INT — same code path here.
- **Pushing FLAGS reflects pre-service state**: IF and TF should be set in the pushed FLAGS, then cleared in the live FLAGS. Same pattern as software INT — corpus tested. Reuse.
- **`run-loop.ts` exit condition**: the inner loop's `if (cpu.halted) break` becomes `if (cpu.halted && !pending) break`. Don't accidentally break on every iteration when halted-with-pending — that'd skip the very service that would unhalt.
- **Sources calling `raise()` from a setTimeout that fires WHILE the run loop is in its yield**: completely fine; the queue is just a JS array, raise is sync. The next iteration of the run loop sees it.
- **Don't deduplicate maskable vectors**: same vector raised twice means service twice. The PIC will deduplicate at its level when we get there.

## Stop and ask

- If you find that `step()` wants to be async — stop immediately
- If the corpus regresses (it shouldn't; if it does, the integration is sampling state at the wrong point)
- If you find a real divergence between 8086tiny and the corpus regarding NMI inhibit-window behavior
- If `interruptInhibit` semantics turn out to need two flags rather than one (POP SS vs STI behave subtly differently) and you're unsure how to model — design choice worth surfacing
- If you find yourself wanting to change `serviceInterrupt`'s contract or signature — that's a corpus-verified path; don't disturb it

## Definition of done

- New files implementing the controller and tests as specified
- CPU and run-loop modifications in place, surgical
- `npx vitest run tests/unit/` shows ≥ 410 passing tests (395 baseline + ~15 new)
- `npm run typecheck` clean
- Full corpus run (`npm run test:sst`) still 100% green — no regressions
- Report at project root: `INTERRUPT_DELIVERY_REPORT.md` with these sections:
  - **Summary**: test counts, design choices made, pass status
  - **Inhibit-flag modeling**: did you use one flag or two? Why? What does each cover (STI / POP SS / MOV SS)?
  - **NMI inhibit-window choice**: does NMI bypass `interruptInhibit`? What's the rationale? Any references consulted?
  - **HLT-spin consideration**: any concerns about CPU usage during halted-with-no-interrupt? Document the current behavior and any planned mitigation.
  - **Test scenarios run**: enumerate the 14 integration tests, pass/fail per scenario. Anything not implemented (e.g., REP-string mid-interrupt if it proved too complex), say so explicitly.
  - **Verification**: exact commands, output summaries.

## Reference sources

1. Adrian Cable's 8086tiny — for "what does silicon actually do" on edge cases (NMI inhibit, REP-string interruption resume).
2. Intel 8086 Family User's Manual — interrupt mechanism description (general flow, IF/TF clearing rules, IVT format).
3. The corpus's `v2_undefined/` directory — if it documents anything about boundary-condition flag state after interrupts, useful.
4. The existing `serviceInterrupt` in `src/cpu8086/` (find it; corpus session used it for INT/INTO/divide-error). Whatever its contract is now is what you reuse.
5. Felix Cloutier's reference for STI / CLI / POP SS / MOV SS opcode descriptions and their flag effects.

## Appendix: why this is the architecturally important brief

The async run loop has been speculative since v0 — we built it because we knew interrupts were coming, but until now nothing actually used the asynchrony. This brief is where that bet pays off. After this lands, the substrate is in place for the future PIC, PIT, keyboard, and any other async source. They'll all be devices that wrap the controller's `raise()` method with their own scheduling logic; the CPU machinery doesn't need to change again to support them.

If the integration tests pass cleanly, the architecture has been validated end-to-end through three sessions: instruction set (corpus) → persistence (IDB integration test) → async interrupt delivery (this brief). After this, browser-side device emulation and machine configurations become straightforward composition rather than design problems.
