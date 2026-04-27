/**
 * Virtual-time clock — the central timing abstraction for all timing-dependent
 * devices.
 *
 * Real emulators (Bochs, QEMU, DOSBox) drive device timing from CPU progress,
 * not wall clock. This is the right abstraction because:
 *
 *   - Tests are deterministic without timer fakery.
 *   - Running the emulator at any speed (paused, stepping, full-tilt) keeps
 *     timer-driven software self-consistent.
 *   - The PIT, future RTC, future serial baud-rate clocks, and any other
 *     timing-dependent device all subscribe to the same clock — one source
 *     of truth.
 *
 * Real-time syncing (throttling the run loop so virtual time matches wall
 * clock for an interactive user experience) is a *separate* layer that wraps
 * the run loop. That's a future brief. For now, virtual time runs as fast as
 * instructions execute.
 *
 * Design notes:
 *
 *   - `now()` is monotonic and unitless ("clock cycles"). The clock has no
 *     opinion on Hz; if a device needs Hz, it knows its own rate vs the CPU's.
 *     The PIT's `cyclesPerPitTick` config is where the CPU/PIT rate ratio
 *     lives; clocks just count.
 *   - `advance(cycles)` notifies subscribers in registration order. It's a
 *     flat fan-out: subscribers do their work and return. No re-entrant
 *     advance, no scheduled callbacks — devices that need "fire at time T"
 *     compute the crossings themselves inside `onAdvance`.
 *   - `subscribe` returns an unsubscribe function so callers don't need to
 *     pass the same reference back later.
 */

/**
 * A consumer of virtual time. Implementations receive a notification on
 * every non-zero `clock.advance(...)` and may consult `clock.now()` for the
 * post-advance time.
 */
export interface ClockSubscriber {
  /**
   * Called when the clock advances by a non-zero number of cycles.
   *
   * @param cycles  How many cycles elapsed in this advance (positive integer).
   *                Subscribers can read `clock.now()` to get the new current
   *                time; the pre-advance time is `clock.now() - cycles`.
   */
  onAdvance(cycles: number): void;
}

/**
 * Virtual clock. Cycles are unitless; the meaning of "one cycle" is whatever
 * the run loop and devices agree on (in practice: one CPU instruction's
 * worth of progress, since the run loop calls `advance(executedInstructions)`
 * after each batch).
 */
export class Clock {
  private cycles: number = 0;
  /**
   * Subscribers in registration order. Iteration order is registration order.
   * Mutation during iteration (e.g. a subscriber that unsubscribes itself)
   * is not supported in v0; if a subscriber needs to unsubscribe during its
   * own callback we'll add the safety net then.
   */
  private readonly subscribers: ClockSubscriber[] = [];

  /** Current virtual time in clock cycles since startup. Monotonic. */
  now(): number {
    return this.cycles;
  }

  /**
   * Power-on reset: virtual time returns to 0. Subscribers are NOT removed
   * — re-subscribing every device on every reset would defeat the
   * register-once design. Devices that hold "last seen now()" state must
   * reset that themselves in their own `reset()`. The clock itself only
   * owns the cycle counter.
   *
   * `reset()` does not notify subscribers. It is a discontinuity, not an
   * advance — the next `advance(n)` after reset will fire `onAdvance(n)`
   * exactly as if the clock had just been constructed.
   */
  reset(): void {
    this.cycles = 0;
  }

  /**
   * Advance virtual time by `cycles`. Notifies all subscribers in
   * registration order *after* the time has been bumped.
   *
   *   - `cycles` must be a non-negative integer.
   *   - `advance(0)` is a no-op (no time bump, no subscriber notification).
   *   - Negative values throw — the clock is monotonic.
   *
   * Subscriber exceptions propagate. If a subscriber throws, later
   * subscribers in the registration order are *not* notified for this
   * advance. Devices should not throw from `onAdvance`; if a device wants to
   * surface an error condition it should latch it and report on the next
   * read instead.
   */
  advance(cycles: number): void {
    if (!Number.isInteger(cycles) || cycles < 0) {
      throw new Error(`Clock.advance(${cycles}): cycles must be a non-negative integer`);
    }
    if (cycles === 0) return;
    this.cycles += cycles;
    // Snapshot length before iteration: a subscriber that registers another
    // subscriber during its own callback should *not* see the new one fire
    // for this same advance. Use a `for` loop with the captured length.
    const len = this.subscribers.length;
    for (let i = 0; i < len; i++) {
      const sub = this.subscribers[i];
      if (sub) sub.onAdvance(cycles);
    }
  }

  /**
   * Register a subscriber. Returns an unsubscribe function that removes it.
   * Subsequent `advance()` calls will not invoke a removed subscriber.
   *
   * Re-subscribing the same instance twice produces two independent slots;
   * callers that want idempotent registration must track that themselves.
   */
  subscribe(subscriber: ClockSubscriber): () => void {
    this.subscribers.push(subscriber);
    return () => {
      const idx = this.subscribers.indexOf(subscriber);
      if (idx !== -1) this.subscribers.splice(idx, 1);
    };
  }
}
