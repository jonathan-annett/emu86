import { describe, expect, it } from 'vitest';
import { Clock } from '../../src/timing/clock.js';
import type { ClockSubscriber } from '../../src/timing/clock.js';

/**
 * Unit tests for the virtual-time {@link Clock}. The clock is small and
 * has only three observable behaviours: `now()` reads the current cycle
 * count, `advance()` bumps it and notifies subscribers, `subscribe()`
 * registers and returns an unsubscriber.
 */

class Recorder implements ClockSubscriber {
  readonly calls: number[] = [];
  onAdvance(cycles: number): void {
    this.calls.push(cycles);
  }
}

describe('Clock.now()', () => {
  it('starts at 0', () => {
    const clock = new Clock();
    expect(clock.now()).toBe(0);
  });

  it('increases by exactly the advance amount', () => {
    const clock = new Clock();
    clock.advance(5);
    expect(clock.now()).toBe(5);
    clock.advance(7);
    expect(clock.now()).toBe(12);
  });
});

describe('Clock.advance()', () => {
  it('advance(0) is a no-op (no subscriber notification)', () => {
    const clock = new Clock();
    const r = new Recorder();
    clock.subscribe(r);
    clock.advance(0);
    expect(clock.now()).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it('throws on negative cycles', () => {
    const clock = new Clock();
    expect(() => clock.advance(-1)).toThrow();
  });

  it('throws on non-integer cycles', () => {
    const clock = new Clock();
    expect(() => clock.advance(1.5)).toThrow();
    expect(() => clock.advance(NaN)).toThrow();
  });

  it('passes the cycle count to subscribers', () => {
    const clock = new Clock();
    const r = new Recorder();
    clock.subscribe(r);
    clock.advance(3);
    clock.advance(7);
    expect(r.calls).toEqual([3, 7]);
  });

  it('subscribers see clock.now() as the post-advance value', () => {
    const clock = new Clock();
    const seen: number[] = [];
    clock.subscribe({
      onAdvance() {
        seen.push(clock.now());
      },
    });
    clock.advance(10);
    clock.advance(5);
    expect(seen).toEqual([10, 15]);
  });
});

describe('Clock.subscribe()', () => {
  it('multiple subscribers fire in registration order', () => {
    const clock = new Clock();
    const order: string[] = [];
    clock.subscribe({ onAdvance: () => order.push('a') });
    clock.subscribe({ onAdvance: () => order.push('b') });
    clock.subscribe({ onAdvance: () => order.push('c') });
    clock.advance(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('unsubscribe stops further notifications', () => {
    const clock = new Clock();
    const r = new Recorder();
    const off = clock.subscribe(r);
    clock.advance(1);
    off();
    clock.advance(2);
    expect(r.calls).toEqual([1]);
  });

  it('unsubscribing one subscriber leaves others intact', () => {
    const clock = new Clock();
    const a = new Recorder();
    const b = new Recorder();
    const c = new Recorder();
    clock.subscribe(a);
    const offB = clock.subscribe(b);
    clock.subscribe(c);
    clock.advance(1);
    offB();
    clock.advance(2);
    expect(a.calls).toEqual([1, 2]);
    expect(b.calls).toEqual([1]);
    expect(c.calls).toEqual([1, 2]);
  });

  it('unsubscribe is idempotent (calling twice is a no-op)', () => {
    const clock = new Clock();
    const r = new Recorder();
    const off = clock.subscribe(r);
    off();
    off(); // must not throw
    clock.advance(1);
    expect(r.calls).toEqual([]);
  });

  it('a subscriber that throws prevents later subscribers from firing this advance', () => {
    // Documented behaviour (see Clock.advance docstring): exceptions propagate.
    // We don't paper over throws; devices are not allowed to throw from onAdvance.
    const clock = new Clock();
    const seen: string[] = [];
    clock.subscribe({ onAdvance: () => { seen.push('a'); } });
    clock.subscribe({ onAdvance: () => { throw new Error('boom'); } });
    clock.subscribe({ onAdvance: () => { seen.push('c'); } });
    expect(() => clock.advance(1)).toThrow('boom');
    expect(seen).toEqual(['a']);
    // Time still advanced — the throw was after the bump. This matches the
    // implementation's "bump first, notify second" ordering.
    expect(clock.now()).toBe(1);
  });
});
