import { describe, expect, it } from 'vitest';
import {
  InMemoryHostClock,
  NodeHostClock,
  type HostTime,
} from '../../src/host-clock/index.js';

/**
 * Unit tests for the {@link HostClock} family. The in-memory implementation
 * is the workhorse for BIOS tests downstream; we verify it round-trips,
 * advances correctly, and isn't aliased into callers' state.
 */

describe('InMemoryHostClock', () => {
  it('returns the documented default when no initial time is given', () => {
    const c = new InMemoryHostClock();
    const t = c.now();
    expect(t).toEqual<HostTime>({
      seconds: 0,
      minutes: 0,
      hours: 0,
      dayOfMonth: 1,
      month: 0,
      year: 126,
      dayOfWeek: 4,
      dayOfYear: 0,
      dst: 0,
      milliseconds: 0,
    });
  });

  it('honours partial initial time, defaulting unspecified fields', () => {
    const c = new InMemoryHostClock({ hours: 12, minutes: 34, seconds: 56 });
    const t = c.now();
    expect(t.hours).toBe(12);
    expect(t.minutes).toBe(34);
    expect(t.seconds).toBe(56);
    expect(t.dayOfMonth).toBe(1);
  });

  it('returns a defensive copy so external mutation does not leak in', () => {
    const c = new InMemoryHostClock();
    const t = c.now();
    t.hours = 99;
    expect(c.now().hours).toBe(0);
  });

  it('setTime overwrites the stored value', () => {
    const c = new InMemoryHostClock();
    const t: HostTime = {
      seconds: 1, minutes: 2, hours: 3,
      dayOfMonth: 4, month: 5, year: 100,
      dayOfWeek: 6, dayOfYear: 7, dst: -1, milliseconds: 999,
    };
    c.setTime(t);
    expect(c.now()).toEqual(t);
  });

  it('advance(500) propagates within the second', () => {
    const c = new InMemoryHostClock();
    c.advance(500);
    const t = c.now();
    expect(t.milliseconds).toBe(500);
    expect(t.seconds).toBe(0);
  });

  it('advance rolls milliseconds → seconds → minutes → hours', () => {
    const c = new InMemoryHostClock();
    c.advance(1000);
    expect(c.now().seconds).toBe(1);
    c.advance(59 * 1000);            // up to 60 seconds total
    let t = c.now();
    expect(t.seconds).toBe(0);
    expect(t.minutes).toBe(1);
    c.advance(59 * 60 * 1000);       // up to 60 minutes
    t = c.now();
    expect(t.minutes).toBe(0);
    expect(t.hours).toBe(1);
  });

  it('advance over midnight propagates day, day-of-week, day-of-year', () => {
    const c = new InMemoryHostClock();
    c.advance(24 * 60 * 60 * 1000);
    const t = c.now();
    expect(t.dayOfMonth).toBe(2);
    expect(t.dayOfWeek).toBe(5);     // Thursday + 1 = Friday
    expect(t.dayOfYear).toBe(1);
    expect(t.hours).toBe(0);
  });

  it('rejects negative or non-finite advance', () => {
    const c = new InMemoryHostClock();
    expect(() => c.advance(-1)).toThrow();
    expect(() => c.advance(Number.NaN)).toThrow();
    expect(() => c.advance(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('NodeHostClock', () => {
  it('returns wall-clock fields close to Date.now()', () => {
    const c = new NodeHostClock();
    const before = Date.now();
    const t = c.now();
    const after = Date.now();
    // The host clock should report a time within the [before, after]
    // window. We reconstruct the wall-clock millis from the host time
    // fields and compare against the bracket — within one full second
    // tolerance for sub-second jitter and the year-only year field.
    const reconstructed = new Date(
      1900 + t.year, t.month, t.dayOfMonth,
      t.hours, t.minutes, t.seconds, t.milliseconds,
    ).getTime();
    expect(reconstructed).toBeGreaterThanOrEqual(before - 1000);
    expect(reconstructed).toBeLessThanOrEqual(after + 1000);
  });

  it('returns sane field ranges', () => {
    const t = new NodeHostClock().now();
    expect(t.seconds).toBeGreaterThanOrEqual(0);
    expect(t.seconds).toBeLessThan(60);
    expect(t.minutes).toBeGreaterThanOrEqual(0);
    expect(t.minutes).toBeLessThan(60);
    expect(t.hours).toBeGreaterThanOrEqual(0);
    expect(t.hours).toBeLessThan(24);
    expect(t.dayOfMonth).toBeGreaterThanOrEqual(1);
    expect(t.dayOfMonth).toBeLessThanOrEqual(31);
    expect(t.month).toBeGreaterThanOrEqual(0);
    expect(t.month).toBeLessThan(12);
    expect(t.dayOfWeek).toBeGreaterThanOrEqual(0);
    expect(t.dayOfWeek).toBeLessThan(7);
    expect(t.dayOfYear).toBeGreaterThanOrEqual(0);
    expect(t.dayOfYear).toBeLessThan(366);
    expect(t.milliseconds).toBeGreaterThanOrEqual(0);
    expect(t.milliseconds).toBeLessThan(1000);
  });
});
