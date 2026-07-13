/**
 * Real-time pacer (pacing milestone, 2026-07-14).
 *
 * Converts host wall time into virtual clock cycles so the PIT ticks a
 * true 100 Hz regardless of emulation speed. Replaces instruction-paced
 * time (1 instr = 1 cycle) in the browser worker's autoRun loop — and
 * ONLY there: tests, the probe harness, and `WorkerHost.runUntil` keep
 * instruction pacing for determinism.
 *
 * Three constraints shape it:
 *
 *   1. **The PIT fires at most one rising edge per `clock.advance()`
 *      call** regardless of span (`pit.ts` "per-batch rising-edge
 *      dedup"). {@link RealTimePacer.advanceClock} therefore slices
 *      advances into ≤ `sliceCycles` chunks — 10,000 default, safely
 *      under ELKS's 47,728-cycle jiffy, so no timer tick is ever lost.
 *   2. **Catch-up is capped** (`maxCatchupMs`): a tab the browser
 *      throttled or suspended wakes without fast-forwarding a pile of
 *      jiffies through the guest; its clock simply falls behind wall
 *      time (INT 1Ah still serves true wall time to the guest).
 *   3. **Only the CPU is capped — never the networking** (Jonathan,
 *      explicit). The pacer governs the per-turn instruction budget
 *      ({@link RealTimePacer.instructionBudget}) and clock advances;
 *      the LAN fabric stays event-driven and unclocked.
 *
 * Speed modes: `'authentic'` bounds instructions per turn to the cycles
 * wall time has made available (a 4.77 MHz 8086, honest in both
 * directions); `'turbo'` leaves instructions unbounded while the clock
 * stays wall-true (a fast CPU with a correct watch — right for in-VM
 * compiles).
 *
 * Time source is injected (`now()` in milliseconds, fractional ok) so
 * unit tests drive it deterministically.
 */

import type { Clock } from '../timing/clock.js';

/** 4.77 MHz in cycles per millisecond — the real PC/XT clock rate. */
export const AUTHENTIC_CYCLES_PER_MS = 4772.7;

export type CpuSpeedMode = 'authentic' | 'turbo';

export interface RealTimePacerOptions {
  /** Wall-time source in ms. Browser: () => performance.now(). */
  now: () => number;
  /** Virtual cycles per wall millisecond. Default 4,772.7 (4.77 MHz). */
  cyclesPerMs?: number;
  /** Max cycles per single clock.advance() call (PIT edge constraint). */
  sliceCycles?: number;
  /** Elapsed wall time beyond this is dropped, not fast-forwarded. */
  maxCatchupMs?: number;
  /** Initial speed mode. Default 'authentic'. */
  mode?: CpuSpeedMode;
}

export class RealTimePacer {
  readonly #now: () => number;
  readonly #cyclesPerMs: number;
  readonly #sliceCycles: number;
  readonly #maxCatchupMs: number;
  #mode: CpuSpeedMode;

  #lastNow: number;
  /** Fractional cycles carried between turns (elapsed×rate is rarely whole). */
  #fraction = 0;

  // Diagnostics: wall ms dropped by the catch-up cap since construction.
  msDroppedToCap = 0;

  constructor(opts: RealTimePacerOptions) {
    this.#now = opts.now;
    this.#cyclesPerMs = opts.cyclesPerMs ?? AUTHENTIC_CYCLES_PER_MS;
    this.#sliceCycles = opts.sliceCycles ?? 10_000;
    this.#maxCatchupMs = opts.maxCatchupMs ?? 100;
    this.#mode = opts.mode ?? 'authentic';
    this.#lastNow = this.#now();
  }

  get mode(): CpuSpeedMode {
    return this.#mode;
  }

  setMode(mode: CpuSpeedMode): void {
    this.#mode = mode;
  }

  /**
   * Whole cycles wall time has made available since the last call
   * (capped, fraction carried). Consumes the elapsed time — call once
   * per turn and use the result for both the instruction budget and
   * the clock advance.
   */
  cyclesDue(): number {
    const now = this.#now();
    let elapsed = now - this.#lastNow;
    this.#lastNow = now;
    if (elapsed <= 0) return 0; // clock skew defensive — never go backwards
    if (elapsed > this.#maxCatchupMs) {
      this.msDroppedToCap += elapsed - this.#maxCatchupMs;
      elapsed = this.#maxCatchupMs;
    }
    const exact = elapsed * this.#cyclesPerMs + this.#fraction;
    const whole = Math.floor(exact);
    this.#fraction = exact - whole;
    return whole;
  }

  /**
   * Per-turn instruction budget for `cyclesDue` available cycles.
   * Authentic: 1 instruction = 1 cycle, so the budget IS the cycles due
   * (the CPU can never outrun wall time). Turbo: unbounded — callers
   * apply their own batch limit.
   */
  instructionBudget(cyclesDue: number): number {
    return this.#mode === 'authentic' ? cyclesDue : Number.POSITIVE_INFINITY;
  }

  /**
   * Advance `clock` by `cycles`, sliced so no single advance spans more
   * than one PIT period (edges would be lost — pit.ts dedups to one
   * rising edge per advance call).
   */
  advanceClock(clock: Clock, cycles: number): void {
    let remaining = cycles;
    while (remaining > 0) {
      const step = Math.min(remaining, this.#sliceCycles);
      clock.advance(step);
      remaining -= step;
    }
  }

  /**
   * Reset the elapsed baseline without producing cycles — used when the
   * machine was deliberately stalled (DNS resolve in flight): stalled
   * wall time must not become guest time.
   */
  skip(): void {
    this.#lastNow = this.#now();
  }
}
