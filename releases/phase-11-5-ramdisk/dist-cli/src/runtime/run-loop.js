import { NullInterruptController } from '../interrupts/controller.js';
/**
 * Async run loop around a synchronous CPU.
 *
 * Shape is deliberately minimal in v0:
 *   - Execute `batchSize` instructions in a tight sync loop.
 *   - Yield to the event loop between batches so timers, write-back, and
 *     (later) async-sourced interrupts can run.
 *   - Bail on halt, stop(), or maxInstructions.
 *
 * Growth points (not implemented yet, but this is where they'll live):
 *   - Pending-interrupt check at the top of each inner iteration.
 *   - Snapshot/restore around each step once we have recoverable faults
 *     (interrupt-gating, debugger stepping, etc.).
 */
export class RunLoop {
    cpu;
    running = false;
    currentRun = null;
    constructor(cpu) {
        this.cpu = cpu;
    }
    /**
     * Run until halted, stop() is called, or maxInstructions is reached.
     * Returns a summary of how the run ended.
     */
    run(opts = {}) {
        if (this.currentRun)
            return this.currentRun;
        this.running = true;
        this.currentRun = this.#runInner(opts).finally(() => {
            this.running = false;
            this.currentRun = null;
        });
        return this.currentRun;
    }
    /** Request a graceful stop. Resolves when the current batch finishes. */
    stop() {
        this.running = false;
    }
    async #runInner(opts) {
        const batchSize = opts.batchSize ?? 10_000;
        const maxInstructions = opts.maxInstructions ?? Infinity;
        const clock = opts.clock;
        // Default halt-spin cycles to batchSize: a halted CPU "uses" roughly
        // the cycles a running one would across a batch yield, which keeps
        // the PIT firing at its programmed rate during HLT. See report for
        // the rationale on this default and what changes at other rates.
        const haltCyclesPerSpin = opts.haltCyclesPerSpin ?? batchSize;
        let executed = 0;
        let exitReason = null;
        while (this.running && executed < maxInstructions) {
            if (this.cpu.halted) {
                // Halted: the CPU itself does nothing until an interrupt wakes it.
                // Decide what to do based on the controller state.
                const ctrl = this.cpu.intCtrl;
                const canServiceNow = ctrl.hasNMI() ||
                    (ctrl.hasMaskable() && this.cpu.flags.IF && !this.cpu.interruptInhibit);
                if (canServiceNow) {
                    // step() will service and unhalt, then dispatch the first handler
                    // instruction. Counts as one executed instruction.
                    this.cpu.step();
                    executed++;
                    continue;
                }
                if (ctrl.hasNMI() || ctrl.hasMaskable()) {
                    // Halted with un-serviceable pending interrupts (IF=0 with only
                    // maskables queued, or the inhibit window still on). The CPU is
                    // halted, so no software path will change IF or inhibit; the
                    // queue can only grow. Bail out — caller is expected to use
                    // stop()/maxInstructions to manage this case if they care.
                    exitReason = 'halted';
                    break;
                }
                // Halted with an empty queue.
                //
                // Two flavours:
                //   - No real controller (Null): the queue can never grow because
                //     no source can call raise(). Exit immediately as 'halted'.
                //     This preserves pre-controller behaviour for legacy callers
                //     that don't pass an interrupt controller.
                //   - Real controller: yield indefinitely so async sources (timers,
                //     devices, the future PIC) can call raise() between yields.
                //     Exit only via stop() or maxInstructions. The brief calls
                //     this "halt-spinning" and accepts the small idle cost for v0;
                //     a future event-driven `whenPending(): Promise<void>` could
                //     replace the spin without changing the interface.
                if (ctrl === NullInterruptController) {
                    exitReason = 'halted';
                    break;
                }
                // Halt-spin clock advance: a HLT-then-wait-for-IRQ-0 program
                // would never wake without this — the PIT only counts when the
                // clock advances, and a halted CPU would otherwise contribute
                // zero cycles to virtual time. We advance by `haltCyclesPerSpin`
                // (default = batchSize) so the cadence roughly matches an
                // executing CPU.
                if (clock)
                    clock.advance(haltCyclesPerSpin);
                await yieldToEventLoop();
                if (!this.running)
                    break;
                continue;
            }
            const budget = Math.min(batchSize, maxInstructions - executed);
            let executedThisBatch = 0;
            for (let i = 0; i < budget; i++) {
                if (this.cpu.halted)
                    break;
                this.cpu.step();
                executedThisBatch++;
            }
            executed += executedThisBatch;
            // Advance virtual time *after* the batch but *before* the yield.
            // Subscribed devices (PIT) can fire rising-edge callbacks here,
            // which (via the Machine's wiring) reach `pic.assertIRQ` →
            // `controller.raise`. The next iteration's first `cpu.step()`
            // sees the pending interrupt at the boundary — no race with the
            // yield.
            if (clock && executedThisBatch > 0)
                clock.advance(executedThisBatch);
            // Yield to macrotask queue — lets setTimeout callbacks (write-back
            // loop, async interrupt sources, future PIT timer) run before we
            // resume. Skip the yield when halted; the halted branch above has
            // its own yield path with a re-check.
            if (this.running && !this.cpu.halted && executed < maxInstructions) {
                await yieldToEventLoop();
            }
        }
        if (exitReason === null) {
            exitReason = !this.running ? 'stopped'
                : this.cpu.halted ? 'halted'
                    : 'instruction-limit';
        }
        return { executed, reason: exitReason };
    }
}
/**
 * Yield to the event loop. Uses the scheduler API when available (modern
 * browsers) for slightly lower overhead than setTimeout(0); falls back to
 * a zero-timeout elsewhere.
 */
function yieldToEventLoop() {
    const sched = globalThis.scheduler;
    if (sched?.postTask) {
        return sched.postTask(() => { });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
}
