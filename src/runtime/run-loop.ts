import type { CPU8086 } from '../cpu8086/cpu.js';
import { NullInterruptController } from '../interrupts/controller.js';
import type { Clock } from '../timing/clock.js';

export interface RunLoopOptions {
  /**
   * How many instructions to execute between event-loop yields.
   * Higher = less async overhead, lower = better responsiveness for
   * interrupts / DOM events. 10_000 is a reasonable starting point.
   */
  batchSize?: number;

  /**
   * Optional hard instruction limit. Useful in tests ("run at most N
   * instructions then stop no matter what"). undefined = run forever
   * (or until halted, or until stop() is called).
   */
  maxInstructions?: number;

  /**
   * Optional virtual-time clock. When provided, the run loop calls
   * `clock.advance(executedThisBatch)` after each batch — this drives
   * subscribed devices (PIT, future RTC, etc.). Omitting the clock keeps
   * the loop's pre-clock behaviour, so existing tests that don't use
   * timer-driven devices need no changes.
   *
   * Halt-spin behaviour: when the CPU is halted with a real interrupt
   * controller and a clock is wired, each halt-spin iteration also
   * advances the clock by `haltCyclesPerSpin` so timer-driven wake works.
   * Without a clock, the halt-spin just yields and rechecks the queue
   * (the pre-clock behaviour).
   */
  clock?: Clock;

  /**
   * Cycles to advance the clock per halt-spin iteration when the CPU is
   * halted with no pending serviceable interrupt. Default: `batchSize`,
   * matching the cadence of an executing CPU. Setting too low starves
   * timer-driven wake (a halted CPU never reaches the next PIT edge);
   * too high inflates virtual time on long idles. The default is the
   * conservative middle ground; future briefs can replace this with a
   * "next event time" hint from devices that lets the loop sleep exactly
   * to the next interesting boundary.
   */
  haltCyclesPerSpin?: number;
}

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
  private running = false;
  private currentRun: Promise<RunResult> | null = null;

  constructor(private readonly cpu: CPU8086) {}

  /**
   * Run until halted, stop() is called, or maxInstructions is reached.
   * Returns a summary of how the run ended.
   */
  run(opts: RunLoopOptions = {}): Promise<RunResult> {
    if (this.currentRun) return this.currentRun;
    this.running = true;
    this.currentRun = this.#runInner(opts).finally(() => {
      this.running = false;
      this.currentRun = null;
    });
    return this.currentRun;
  }

  /** Request a graceful stop. Resolves when the current batch finishes. */
  stop(): void {
    this.running = false;
  }

  async #runInner(opts: RunLoopOptions): Promise<RunResult> {
    const batchSize = opts.batchSize ?? 10_000;
    const maxInstructions = opts.maxInstructions ?? Infinity;
    const clock = opts.clock;
    // Default halt-spin cycles to batchSize: a halted CPU "uses" roughly
    // the cycles a running one would across a batch yield, which keeps
    // the PIT firing at its programmed rate during HLT. See report for
    // the rationale on this default and what changes at other rates.
    const haltCyclesPerSpin = opts.haltCyclesPerSpin ?? batchSize;
    let executed = 0;
    let exitReason: RunResult['reason'] | null = null;

    while (this.running && executed < maxInstructions) {
      if (this.cpu.halted) {
        // Halted: the CPU itself does nothing until an interrupt wakes it.
        // Decide what to do based on the controller state.
        const ctrl = this.cpu.intCtrl;
        const canServiceNow =
          ctrl.hasNMI() ||
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
        if (clock) clock.advance(haltCyclesPerSpin);
        await yieldToEventLoop();
        if (!this.running) break;
        continue;
      }

      const budget = Math.min(batchSize, maxInstructions - executed);
      let executedThisBatch = 0;
      for (let i = 0; i < budget; i++) {
        if (this.cpu.halted) break;
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
      if (clock && executedThisBatch > 0) clock.advance(executedThisBatch);
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

export interface RunResult {
  executed: number;
  reason: 'halted' | 'stopped' | 'instruction-limit';
}

/**
 * Yield to the event loop. Uses the scheduler API when available (modern
 * browsers) for slightly lower overhead than setTimeout(0); falls back to
 * a zero-timeout elsewhere.
 */
function yieldToEventLoop(): Promise<void> {
  const sched = (globalThis as {
    scheduler?: { postTask?: (fn: () => void) => Promise<void> };
  }).scheduler;
  if (sched?.postTask) {
    return sched.postTask(() => { /* no-op */ });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
