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
export class BasicInterruptController {
    queue = [];
    nmiPending = false;
    hasNMI() {
        return this.nmiPending;
    }
    hasMaskable() {
        return this.queue.length > 0;
    }
    consumeNMI() {
        if (!this.nmiPending)
            return false;
        this.nmiPending = false;
        return true;
    }
    consumeMaskable() {
        const v = this.queue.shift();
        if (v === undefined) {
            throw new Error('consumeMaskable() called with no maskable interrupt pending');
        }
        return v;
    }
    raise(vector) {
        if (!Number.isInteger(vector) || vector < 0 || vector > 255) {
            throw new Error(`Invalid interrupt vector: ${vector} (must be integer 0..255)`);
        }
        this.queue.push(vector);
    }
    raiseNMI() {
        this.nmiPending = true;
    }
    reset() {
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
export const NullInterruptController = {
    hasNMI: () => false,
    hasMaskable: () => false,
    consumeNMI: () => false,
    consumeMaskable: () => {
        throw new Error('NullInterruptController has no pending interrupts to consume');
    },
    raise: () => { },
    raiseNMI: () => { },
    reset: () => { },
};
