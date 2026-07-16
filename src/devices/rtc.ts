/**
 * MC146818-class CMOS RTC at ports 0x70/0x71 (RTC addendum, 2026-07-15).
 *
 * Gives the guest a real wall clock: the stock ELKS image runs
 * `clock -s -u` from `/etc/rc.sys` at every boot, which reads these
 * ports and calls settimeofday — so with this chip present, `date`
 * matches the host clock with zero guest changes (previously the
 * kernel default of Mon Oct 21 1991).
 *
 * Counterparty-first, like every device here: the implemented contract
 * is exactly what `elkscmd/sys_utils/clock.c` reads —
 *
 *   - Port 0x70 (index, write-only): low 7 bits select a CMOS
 *     register; bit 7 is the historical NMI mask and is ignored
 *     (clock.c always sets it: `outb(reg | 0x80, 0x70)`).
 *   - Port 0x71 (data): time registers in BCD — 0x00 seconds,
 *     0x02 minutes, 0x04 hours (24 h), 0x06 weekday, 0x07 day of
 *     month, 0x08 month (1-based), 0x09 year % 100 (<70 ⇒ 20xx per
 *     clock.c). **Weekday is stored as tm_wday + 3** — clock.c's
 *     "DOS uses 3 - 9 for week days" convention — which deviates from
 *     the MC146818 datasheet's 1..7; the guest utility is the contract
 *     that matters.
 *   - Status A (0x0A) reads 0x26 — the standard divider/rate value
 *     clock.c's (compiled-out) probe expects; the UIP bit stays clear
 *     because register reads here are torn-free (each read snapshots
 *     the host clock; clock.c's own seconds-stability loop covers a
 *     minute rolling over between registers).
 *   - Status B (0x0B) reads 0x02: 24-hour mode, BCD mode.
 *   - Status D (0x0D) reads 0x80: battery OK — the probe's other half.
 *
 * Writes land in a 128-byte scratch CMOS array and are NOT interpreted:
 * time is always served fresh from the injected {@link HostClock}
 * (browser/CLI: local wall time — `clock -s -u` adopts it verbatim, so
 * guest date == host clock; tests: InMemoryHostClock, deterministic).
 * `clock -w` therefore round-trips its status-register save/restore
 * dance harmlessly but cannot set the hardware time — a documented v1
 * limit, not an accident.
 */

import type { IOBus, PortHandler } from '../core/io.js';
import type { HostClock } from '../host-clock/host-clock.js';

const INDEX_PORT = 0x70;
const DATA_PORT = 0x71;

const REG_SECONDS = 0x00;
const REG_MINUTES = 0x02;
const REG_HOURS = 0x04;
const REG_WEEKDAY = 0x06;
const REG_DAY_OF_MONTH = 0x07;
const REG_MONTH = 0x08;
const REG_YEAR = 0x09;
const REG_STATUS_A = 0x0a;
const REG_STATUS_B = 0x0b;
const REG_STATUS_C = 0x0c;
const REG_STATUS_D = 0x0d;

function bcd(value: number): number {
  return ((Math.floor(value / 10) << 4) | value % 10) & 0xff;
}

/**
 * Serialized chip state (Phase 18 M1): the index register + the CMOS
 * scratch RAM, nothing else. Time is wall-served from the injected
 * HostClock on every read, so a restored RTC is resume-correct by
 * construction — exactly the laptop-resume semantics the phase wants.
 */
export interface Rtc146818State {
  readonly v: 1;
  readonly index: number;
  readonly cmos: Uint8Array;
}

export class RTC146818 implements PortHandler {
  readonly #hostClock: HostClock;
  #index = 0;
  /** CMOS scratch RAM — holds writes (uninterpreted) and unknown regs. */
  readonly #cmos = new Uint8Array(128);

  constructor(hostClock: HostClock) {
    this.#hostClock = hostClock;
  }

  registerOn(bus: IOBus): void {
    bus.register({ start: INDEX_PORT, end: DATA_PORT }, this);
  }

  reset(): void {
    this.#index = 0;
    // Scratch CMOS survives reset — it's battery-backed RAM on real
    // hardware; the machine's power-on reset is not a battery pull.
  }

  serializeState(): Rtc146818State {
    return { v: 1, index: this.#index, cmos: new Uint8Array(this.#cmos) };
  }

  restoreState(state: Rtc146818State): void {
    if (state.v !== 1) {
      throw new Error(`RTC146818.restoreState: unsupported schema version ${String(state.v)}`);
    }
    if (state.cmos.length !== this.#cmos.length) {
      throw new Error(
        `RTC146818.restoreState: cmos length ${state.cmos.length} (expected ${this.#cmos.length})`,
      );
    }
    this.#index = state.index & 0x7f;
    this.#cmos.set(state.cmos);
  }

  readByte(port: number): number {
    if (port === INDEX_PORT) return 0xff; // index register is write-only
    return this.#readRegister(this.#index);
  }

  writeByte(port: number, value: number): void {
    if (port === INDEX_PORT) {
      this.#index = value & 0x7f; // bit 7 = NMI mask, not part of the index
      return;
    }
    // Data writes park in scratch; time keeps coming from the host clock.
    this.#cmos[this.#index] = value & 0xff;
  }

  #readRegister(reg: number): number {
    const t = this.#hostClock.now();
    switch (reg) {
      case REG_SECONDS: return bcd(t.seconds);
      case REG_MINUTES: return bcd(t.minutes);
      case REG_HOURS: return bcd(t.hours);
      // clock.c: tm_wday = bcd(reg 6) - 3 ("DOS uses 3 - 9").
      case REG_WEEKDAY: return bcd(t.dayOfWeek + 3);
      case REG_DAY_OF_MONTH: return bcd(t.dayOfMonth);
      case REG_MONTH: return bcd(t.month + 1); // HostTime is 0-based
      case REG_YEAR: return bcd((1900 + t.year) % 100);
      case REG_STATUS_A: return 0x26; // divider on, rate 1024 Hz, UIP clear
      case REG_STATUS_B: return 0x02; // 24-hour, BCD
      case REG_STATUS_C: return 0x00; // no interrupt flags pending
      case REG_STATUS_D: return 0x80; // battery/RAM valid
      default: return this.#cmos[reg] ?? 0;
    }
  }
}
