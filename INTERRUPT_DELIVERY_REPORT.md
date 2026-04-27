# Interrupt Delivery — Implementation Report

## Summary

The async interrupt-delivery substrate is in place. Hardware sources can now
call `controller.raise(vec)` / `controller.raiseNMI()` from outside the CPU,
and the CPU services them at instruction boundaries inside `step()` with
correct IF gating, NMI bypass, HLT wake, and the documented one-instruction
inhibit windows after STI / POP SS / MOV SS,r/m.

- **Test counts**: 422 unit tests passing (was 395), +27 net new:
  - 11 controller-only tests (`tests/unit/interrupt-controller.test.ts`)
  - 14 CPU-controller integration tests (`tests/unit/cpu-interrupts.test.ts`)
  - 2 new run-loop tests added to `tests/unit/run-loop.test.ts`
- **Typecheck**: clean (`npm run typecheck`).
- **SST corpus**: 329/329 test files passing (~3M cases). No regressions.
- **Design choices**:
  - Single inhibit flag covers STI / POP SS / MOV SS,r/m.
  - NMI bypasses both IF and the inhibit window — truly non-maskable.
  - Run loop differentiates `NullInterruptController` (exit on halt) from
    real controllers (halt-spin, awaiting an async source).
- **Pass status**: ✅ All scenarios in the brief implemented and passing,
  except scenario 12 (REP-string mid-interrupt resume) which was not
  implemented — see "Test scenarios run" below.

## Inhibit-flag modeling

**One flag**: `cpu.interruptInhibit: boolean`. STI, POP SS, and MOV SS,r/m
all set it to `true`. The CPU's boundary check (top of `step()`) consults
it for **maskable** delivery only; NMI is unaffected. The flag is cleared
at the end of every `step()` *after* the boundary check, so a setter that
runs in the dispatch phase suppresses exactly the next step's check and
no other.

The single flag works because the practical effect is the same in all three
cases: maskable interrupts don't fire on the very next instruction. The
brief raised the possibility that POP SS / MOV SS might also need to
inhibit NMI on real silicon, but I found no authoritative source confirming
that — Intel's user-manual language for STI/POP SS/MOV SS describes only
the maskable path. The 8086tiny code I'm aware of treats them all as
maskable-only inhibit. So one flag, gated on maskable only.

If a future reference document specifies that POP SS / MOV SS also block
NMI for one instruction, the change is local: add a second flag and gate
NMI on it in the boundary check.

## NMI inhibit-window choice

**NMI bypasses both IF and the inhibit window.** Rationale:

- The N in NMI is "non-maskable". Real hardware asserts NMI on a separate
  pin and the silicon services it without consulting IF. There's no
  documented way for software to suppress NMI delivery on the 8086.
- Treating the inhibit window as "asymmetric" — applying to maskable only —
  matches the most common reading of the user's manual and the 8086tiny
  reference code. The brief's exact phrasing was "NMI is gated by NEITHER
  IF nor the inhibit window — it's truly non-maskable. Implement that way
  unless you find evidence otherwise."
- I did not find evidence to the contrary. The SST corpus does not test
  cross-instruction interrupt timing (corpus cases are single-instruction),
  so it can neither confirm nor deny the choice. We've documented it here
  so a future investigation can revisit if needed.

## HLT-spin consideration

When the CPU is halted with no pending interrupt, the run loop's behaviour
depends on which controller is in use:

- **`NullInterruptController` (default)** — the queue can never grow because
  no source can call `raise()`. The run loop exits immediately with
  `reason: 'halted'`. This matches pre-controller behaviour exactly, so
  every existing test that ran a program ending in HLT continues to pass
  unchanged.
- **Real controller (e.g. `BasicInterruptController`)** — the run loop
  enters a "halt-spin": yield, recheck the queue, repeat. This is what
  lets an async source (a setTimeout, a future PIT, a keyboard device)
  fire `raise()` between yields and wake the CPU. The spin only exits
  on `stop()`, `maxInstructions`, or a serviced interrupt that takes the
  CPU out of HLT (where it might re-halt, restarting the spin).

The spin's idle cost is one `setTimeout(0)` per iteration. In Node that's
~1 ms per yield; in browsers ~4 ms (the HTML spec's clamped minimum). Not
free, but not catastrophic for v0. The brief flagged this as something
to revisit later via an event-driven `controller.whenPending(): Promise<void>`
that the loop could await instead of polling — that's the obvious upgrade
when we care.

A halted CPU with `IF=0` and only maskables queued exits immediately as
`'halted'` — no halt-spin in this case, because the queue is *unservicable*
and only an IF/inhibit change could unblock it, and no software path will
change those while halted. This handling is in the run loop's halted
branch (see `src/runtime/run-loop.ts` — the early break on
`hasMaskable() || hasNMI()` when not servicable now).

## Test scenarios run

All 14 scenarios from the brief, mapped to test cases. ✅ = implemented and
passing; ⚠️ = not implemented (with reason).

| #  | Scenario                                                | Status | Test                                                                                |
|----|---------------------------------------------------------|--------|-------------------------------------------------------------------------------------|
| 1  | Maskable, IF=1                                          | ✅     | `CPU services maskable interrupts at instruction boundary > IF=1 + maskable...`    |
| 2  | Maskable, IF=0                                          | ✅     | `CPU does not service maskable when IF=0 > IF=0 → instruction runs normally...`    |
| 3  | Maskable becomes serviceable after STI                  | ✅     | `STI delayed-enable inhibit window > STI; NOP; NOP — interrupt fires after...`     |
| 4  | NMI with IF=0                                            | ✅     | `NMI bypasses IF > IF=0 + NMI pending → still serviced via vector 2`               |
| 5  | NMI takes priority over pending maskable                 | ✅     | `NMI priority over maskable > both pending → NMI services first`                   |
| 6  | POP SS inhibit                                           | ✅     | `POP SS inhibit window > POP SS; NOP; NOP — interrupt suppressed for one...`       |
| 7  | MOV SS,r/m inhibit                                       | ✅     | `MOV SS,r/m inhibit window > MOV SS, AX; NOP; NOP — same shape as POP SS` (+1 negative test for MOV ES, AX) |
| 8  | STI; RET pattern                                         | ✅     | `STI; RET delayed enable > classic interrupt-handler tail`                         |
| 9  | HLT wake by maskable, IF=1                               | ✅     | `HLT wake > woken by a pending maskable when IF=1`                                 |
| 10 | HLT not woken by maskable, IF=0                          | ✅     | `HLT wake > NOT woken by a maskable when IF=0`                                     |
| 11 | HLT woken by NMI even with IF=0                          | ✅     | `HLT wake > woken by NMI even when IF=0`                                           |
| 12 | Interrupt mid-REP-string                                 | ⚠️     | Not implemented. See note below.                                                   |
| 13 | TF (single-step) interaction                             | ✅     | `TF and interrupt service > service clears live TF; pushed FLAGS still has TF set` |
| 14 | No-controller default                                    | ✅     | `no-controller default > CPU built without an explicit controller behaves...`      |

Run-loop additions (`tests/unit/run-loop.test.ts`):

- ✅ `halted CPU is woken by maskable interrupt from async source` — uses
  `vi.useFakeTimers()` + `setTimeout(() => ctrl.raise(0x40), 50)` to drive
  delivery through the halt-spin path. Verifies CPS:IP at handler entry
  after the source fires.
- ✅ `stop() while halted with a controller exits with reason=stopped` —
  exercises the `!this.running` exit from inside the halt-spin yield.

### Why scenario 12 (REP-string mid-interrupt) wasn't implemented

The current REP implementation (in `src/cpu8086/opcodes-string.ts`) executes
the entire CX-driven loop within a single `step()` call. The interrupt
boundary check lives at the top of `step()`, so an interrupt arriving
mid-REP wouldn't be observed until the whole REP completed. To match real
silicon (which interrupts mid-REP and rewinds CS:IP to the prefix so IRET
resumes the loop), the REP loop body would need:

1. An interrupt-pending check between iterations.
2. A way to rewind IP to point at the prefix byte (currently we'd have to
   subtract 2 — one for the prefix, one for the inner opcode that's already
   been fetched).
3. Confirmation that this rewind doesn't disturb the SST corpus, which
   tests REP-prefixed instructions with a synthesized "REP completed
   normally" expected state.

Item 3 is the risk: the corpus is the source of truth for REP behaviour
in the codebase, and adding interrupt-rewind logic without breaking the
corpus needs careful staging — the corpus runs with `NullInterruptController`,
so as long as no interrupt is ever pending, the rewind path is dead code.
That's likely fine but warrants a separate review. The brief explicitly
permitted skipping this scenario ("if it's hard to set up, document and
move on"), and I'm taking that allowance. When this scenario lands, it'll
look something like:

```ts
function repLoop(cpu, zfBreaksOn, prefix) {
  // ... existing setup ...
  while (cpu.regs.CX !== 0) {
    if (interruptPendingAndServiceable(cpu)) {
      cpu.regs.IP = (cpu.regs.IP - 2) & 0xFFFF; // rewind to prefix
      return;
    }
    handler(cpu);
    cpu.regs.CX = (cpu.regs.CX - 1) & 0xFFFF;
    if (checksZF && cpu.flags.ZF === zfBreaksOn) break;
  }
}
```

The infrastructure is now in place to do this incrementally.

## Verification

```
$ npx vitest run tests/unit/
 Test Files  24 passed (24)
      Tests  422 passed (422)
   Duration  ~2.2s

$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json
(clean exit)

$ npm run test:sst
 Test Files  2 passed (2)
      Tests  329 passed (329)
   Duration  ~198s
```

422 unit tests pass (395 baseline + 27 new), typecheck is clean, and the
full SST corpus is green. No corpus regressions — a sanity check that the
boundary check at the top of `step()` doesn't disturb single-instruction
state machine behaviour (the corpus runs with `NullInterruptController`,
so the boundary check is a no-op on every step but its presence had to
not perturb fetch/dispatch ordering).

## Files changed

New:
- `src/interrupts/controller.ts` — interface + `BasicInterruptController` + `NullInterruptController`
- `src/interrupts/index.ts` — barrel export
- `tests/unit/interrupt-controller.test.ts` — 11 tests
- `tests/unit/cpu-interrupts.test.ts` — 14 tests
- `INTERRUPT_DELIVERY_REPORT.md` — this report

Modified (surgical):
- `src/cpu8086/cpu.ts` — `intCtrl` field + `interruptInhibit` field +
  boundary check at the top of `step()`. Constructor gained a third
  optional parameter that defaults to `NullInterruptController`.
- `src/cpu8086/opcodes-misc.ts` — STI now sets `interruptInhibit=true`.
- `src/cpu8086/opcodes-stack.ts` — POP SS now sets `interruptInhibit=true`.
- `src/cpu8086/opcodes-mov.ts` — MOV SS,r/m (only when sreg=SS) sets
  `interruptInhibit=true`. MOV to ES/CS/DS unchanged.
- `src/runtime/run-loop.ts` — halted branch handles real-controller halt-spin,
  preserves immediate-exit behaviour for `NullInterruptController`.
- `src/index.ts` — exports the new interrupts module.
- `tests/unit/run-loop.test.ts` — +2 tests for HLT wake and stop-while-halted.
