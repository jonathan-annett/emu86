/**
 * MC146818 RTC unit tests (RTC addendum, 2026-07-15).
 *
 * The register contract is exactly what ELKS's `clock.c` reads —
 * including its quirks: index writes carry bit 7 (NMI mask), weekday
 * is stored as tm_wday + 3 ("DOS uses 3 - 9"), month is 1-based, year
 * is two BCD digits with <70 meaning 20xx on the guest side.
 */

import { describe, it, expect } from 'vitest';
import { RTC146818 } from '../../src/devices/rtc.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { BasicIOBus } from '../../src/io/io-bus.js';

/** Read a CMOS register the way clock.c does: outb(reg|0x80, 0x70); inb(0x71). */
function cmosRead(bus: BasicIOBus, reg: number): number {
  bus.outByte(0x70, reg | 0x80);
  return bus.inByte(0x71);
}

function makeRig(initial?: ConstructorParameters<typeof InMemoryHostClock>[0]): {
  bus: BasicIOBus;
  clock: InMemoryHostClock;
} {
  const clock = new InMemoryHostClock(initial);
  const rtc = new RTC146818(clock);
  const bus = new BasicIOBus();
  rtc.registerOn(bus);
  return { bus, clock };
}

describe('RTC146818 — the clock.c read contract', () => {
  it('serves BCD time exactly as cmos_gettime reads it', () => {
    // 2026-07-15 21:43:09, a Wednesday (dayOfWeek 3).
    const { bus } = makeRig({
      seconds: 9, minutes: 43, hours: 21,
      dayOfMonth: 15, month: 6, year: 126, dayOfWeek: 3,
    });
    expect(cmosRead(bus, 0x00)).toBe(0x09); // seconds
    expect(cmosRead(bus, 0x02)).toBe(0x43); // minutes (BCD!)
    expect(cmosRead(bus, 0x04)).toBe(0x21); // hours, 24h BCD
    expect(cmosRead(bus, 0x06)).toBe(0x06); // weekday: wday 3 + 3 (DOS 3-9)
    expect(cmosRead(bus, 0x07)).toBe(0x15); // day of month
    expect(cmosRead(bus, 0x08)).toBe(0x07); // month, 1-based
    expect(cmosRead(bus, 0x09)).toBe(0x26); // year % 100 → guest adds 2000
  });

  it('time flows: advancing the host clock changes reads live', () => {
    const { bus, clock } = makeRig({ seconds: 58, minutes: 0 });
    expect(cmosRead(bus, 0x00)).toBe(0x58);
    clock.advance(3_000);
    expect(cmosRead(bus, 0x00)).toBe(0x01);
    expect(cmosRead(bus, 0x02)).toBe(0x01);
  });

  it('status registers satisfy the probe and BCD/24h mode flags', () => {
    const { bus } = makeRig();
    // cmos_probe: write reg 0x0D, then require (regA & 0x7f)==0x26 && regD.
    bus.outByte(0x70, 0x0d | 0x80);
    bus.outByte(0x71, 0x00);
    expect(cmosRead(bus, 0x0a) & 0x7f).toBe(0x26);
    expect(cmosRead(bus, 0x0d)).toBe(0x80);
    expect(cmosRead(bus, 0x0b)).toBe(0x02); // 24h, BCD
  });

  it('time registers are read-only: clock -w style writes do not stick', () => {
    const { bus } = makeRig({ minutes: 43 });
    bus.outByte(0x70, 0x02 | 0x80);
    bus.outByte(0x71, 0x59); // attempt to set minutes = 59
    expect(cmosRead(bus, 0x02)).toBe(0x43); // still host time
  });

  it('scratch CMOS RAM round-trips for non-time registers', () => {
    const { bus } = makeRig();
    bus.outByte(0x70, 0x20 | 0x80);
    bus.outByte(0x71, 0xa5);
    expect(cmosRead(bus, 0x20)).toBe(0xa5);
  });

  it('the index port reads open-bus-ish (write-only register)', () => {
    const { bus } = makeRig();
    expect(bus.inByte(0x70)).toBe(0xff);
  });
});
