/**
 * RealTimePacer unit tests (pacing milestone).
 *
 * A fake `now()` drives everything deterministically. The reference
 * numbers: 4,772.7 cycles/ms (4.77 MHz), 10,000-cycle slices (the PIT
 * fires at most one rising edge per clock.advance call), 100 ms
 * catch-up cap.
 */

import { describe, it, expect } from 'vitest';
import { Clock } from '../../src/timing/clock.js';
import { AUTHENTIC_CYCLES_PER_MS, RealTimePacer } from '../../src/browser/pacing.js';

function makePacer(opts: Partial<ConstructorParameters<typeof RealTimePacer>[0]> = {}): {
  pacer: RealTimePacer;
  tick: (ms: number) => void;
} {
  let t = 0;
  const pacer = new RealTimePacer({ now: () => t, ...opts });
  return { pacer, tick: (ms) => { t += ms; } };
}

describe('RealTimePacer — cyclesDue', () => {
  it('converts elapsed wall time at 4.77 MHz with fractional carry', () => {
    const { pacer, tick } = makePacer();
    tick(1);
    const first = pacer.cyclesDue();
    expect(first).toBe(4772); // floor(4772.7)
    tick(1);
    // The 0.7 fraction carries: floor(4772.7 + 0.7) = 4773.
    expect(pacer.cyclesDue()).toBe(4773);
    // Conservation: two 1 ms turns = floor(2 ms worth), fraction retained.
    expect(first + 4773).toBe(Math.floor(2 * AUTHENTIC_CYCLES_PER_MS));
  });

  it('ten 1 ms turns and one 10 ms turn yield the same total cycles', () => {
    const a = makePacer();
    let totalA = 0;
    for (let i = 0; i < 10; i++) {
      a.tick(1);
      totalA += a.pacer.cyclesDue();
    }
    const b = makePacer();
    b.tick(10);
    // Within one cycle: 4772.7 isn't binary-exact, so ten small floors
    // can differ from one big floor by a float crumb — bounded, non-
    // accumulating (the carried fraction stays in [0, 1)).
    expect(Math.abs(totalA - b.pacer.cyclesDue())).toBeLessThanOrEqual(1);
  });

  it('caps catch-up: a throttled tab does not fast-forward', () => {
    const { pacer, tick } = makePacer();
    tick(5_000); // tab was suspended for five seconds
    expect(pacer.cyclesDue()).toBe(Math.floor(100 * AUTHENTIC_CYCLES_PER_MS));
    expect(pacer.msDroppedToCap).toBe(4_900);
  });

  it('zero (or negative) elapsed yields zero cycles', () => {
    const { pacer } = makePacer();
    expect(pacer.cyclesDue()).toBe(0);
    expect(pacer.cyclesDue()).toBe(0);
  });

  it('skip() discards elapsed time (the DNS-stall contract)', () => {
    const { pacer, tick } = makePacer();
    tick(500); // stalled while a DoH fetch ran
    pacer.skip();
    tick(2);
    expect(pacer.cyclesDue()).toBe(Math.floor(2 * AUTHENTIC_CYCLES_PER_MS));
  });
});

describe('RealTimePacer — instruction budget (speed modes)', () => {
  it('authentic mode: budget equals cycles due (never outruns 4.77 MHz)', () => {
    const { pacer, tick } = makePacer({ mode: 'authentic' });
    tick(2);
    const cycles = pacer.cyclesDue();
    expect(pacer.instructionBudget(cycles)).toBe(cycles);
  });

  it('turbo mode: budget unbounded; live mode switch applies', () => {
    const { pacer, tick } = makePacer({ mode: 'turbo' });
    tick(2);
    expect(pacer.instructionBudget(pacer.cyclesDue())).toBe(Number.POSITIVE_INFINITY);
    pacer.setMode('authentic');
    tick(1);
    const cycles = pacer.cyclesDue();
    expect(pacer.instructionBudget(cycles)).toBe(cycles);
  });
});

describe('RealTimePacer — advanceClock slicing', () => {
  it('never advances more than sliceCycles per clock.advance call', () => {
    const clock = new Clock();
    const advances: number[] = [];
    clock.subscribe({ onAdvance: (cycles) => advances.push(cycles) });
    const { pacer } = makePacer();
    pacer.advanceClock(clock, 47_728); // one full ELKS jiffy of catch-up
    expect(advances).toEqual([10_000, 10_000, 10_000, 10_000, 7_728]);
    expect(clock.now()).toBe(47_728);
  });

  it('small advances pass through as one call; zero advances not at all', () => {
    const clock = new Clock();
    const advances: number[] = [];
    clock.subscribe({ onAdvance: (cycles) => advances.push(cycles) });
    const { pacer } = makePacer();
    pacer.advanceClock(clock, 4_772);
    pacer.advanceClock(clock, 0);
    expect(advances).toEqual([4_772]);
  });
});
