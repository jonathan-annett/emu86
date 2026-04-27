/**
 * Hardware-interrupt delivery substrate.
 *
 * The CPU services interrupts at instruction boundaries by querying an
 * `InterruptController`. Async sources (timers, keyboard, future PIC,
 * etc.) call `raise()` / `raiseNMI()` from outside the CPU; the CPU
 * reads the queue from inside `step()`. The controller is intentionally
 * PIC-agnostic — a future 8259 will be a *device* that wraps `raise()`,
 * doing priority and EOI bookkeeping at its level. None of that knowledge
 * lives here.
 *
 * The interface is split into a "source side" (`raise*`) and a
 * "consumer side" (`has*` / `consume*`). The CPU only consumes; sources
 * only raise. The split is a hint about who-uses-what — there's no
 * runtime enforcement.
 */

export interface InterruptController {
  /** True if an NMI is pending. NMI is non-maskable: IF gating doesn't apply. */
  hasNMI(): boolean;
  /** True if at least one maskable interrupt is queued. IF gating is the CPU's concern. */
  hasMaskable(): boolean;
  /** Consume the pending NMI flag. Returns true if one was pending, false otherwise. */
  consumeNMI(): boolean;
  /** Consume and return the next maskable vector. Throws if none pending — callers must check first. */
  consumeMaskable(): number;
  /** Source-side: enqueue a maskable interrupt with the given vector (0..255). */
  raise(vector: number): void;
  /** Source-side: signal NMI (the hardware vector is fixed at 2). */
  raiseNMI(): void;
  /**
   * Discard any pending interrupts and reset the controller to its
   * post-construction state. Called by the Machine on power-on reset.
   * Idempotent: resetting an already-empty controller is a no-op.
   */
  reset(): void;
}

/**
 * Minimal interrupt-controller implementation: a FIFO queue of maskable
 * vectors plus a single boolean for NMI.
 *
 * Notes / contracts:
 *   - NMI is idempotent. Two `raiseNMI()` without a `consumeNMI()` between
 *     them is the same as one. (Real silicon: NMI is edge-triggered;
 *     re-asserting while already pending is a no-op.)
 *   - Maskables are NOT deduplicated. Same vector raised twice means
 *     service twice. The future PIC will dedupe at its own level.
 *   - Vector validation: 0..255, integer. Anything else throws synchronously.
 *   - Storage: a plain array used as a queue (`push` / `shift`). A ring
 *     buffer is premature optimization for the queue depths we expect
 *     (a few entries, drained immediately by the CPU).
 */
export class BasicInterruptController implements InterruptController {
  private readonly queue: number[] = [];
  private nmiPending = false;

  hasNMI(): boolean {
    return this.nmiPending;
  }

  hasMaskable(): boolean {
    return this.queue.length > 0;
  }

  consumeNMI(): boolean {
    if (!this.nmiPending) return false;
    this.nmiPending = false;
    return true;
  }

  consumeMaskable(): number {
    const v = this.queue.shift();
    if (v === undefined) {
      throw new Error('consumeMaskable() called with no maskable interrupt pending');
    }
    return v;
  }

  raise(vector: number): void {
    if (!Number.isInteger(vector) || vector < 0 || vector > 255) {
      throw new Error(`Invalid interrupt vector: ${vector} (must be integer 0..255)`);
    }
    this.queue.push(vector);
  }

  raiseNMI(): void {
    this.nmiPending = true;
  }

  reset(): void {
    // Drain the queue in place so external references to it (none today,
    // but cheap insurance) see the same array post-reset.
    this.queue.length = 0;
    this.nmiPending = false;
  }
}

/**
 * No-op controller. The CPU defaults to this when no controller is
 * supplied, so existing callers (and existing tests) get the same
 * "interrupts are software-only" behaviour as before. Reads always say
 * nothing pending; raises are silently ignored — the latter is mostly
 * a convenience so demo code can call `raise()` without first checking
 * whether a real controller has been wired up.
 */
export const NullInterruptController: InterruptController = {
  hasNMI: () => false,
  hasMaskable: () => false,
  consumeNMI: () => false,
  consumeMaskable: () => {
    throw new Error('NullInterruptController has no pending interrupts to consume');
  },
  raise: () => { /* no-op */ },
  raiseNMI: () => { /* no-op */ },
  reset: () => { /* no-op — nothing to clear */ },
};
