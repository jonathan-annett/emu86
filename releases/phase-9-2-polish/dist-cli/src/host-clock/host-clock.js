/**
 * Host clock abstraction.
 *
 * The BIOS INT 1Ah handler needs the current wall-clock time. To keep the
 * BIOS code testable we don't reach for `new Date()` directly — we route
 * every read through a {@link HostClock}. Production code uses
 * {@link NodeHostClock}; tests use {@link InMemoryHostClock} so the same
 * INT 1Ah call returns deterministic, settable values.
 */
// ============================================================
// NodeHostClock — reads real wall-clock time
// ============================================================
/**
 * Pulls the current time from the host (via `new Date()`). Non-deterministic
 * by definition; not suitable for tests that compare times against constants.
 *
 * The Date object's `getDay()`, `getMonth()`, etc. already match the
 * `struct tm` conventions we picked above (Sunday = 0, January = 0, year
 * since 1900), so the translation is mostly direct. The two extras are
 * `dayOfYear` (computed) and `dst` (Date doesn't expose a clean DST flag in
 * a portable way, so we report -1 = unknown, which the BIOS treats as "no
 * DST in effect" via INT 1Ah AH=02h DL).
 */
export class NodeHostClock {
    now() {
        const d = new Date();
        return {
            seconds: d.getSeconds(),
            minutes: d.getMinutes(),
            hours: d.getHours(),
            dayOfMonth: d.getDate(),
            month: d.getMonth(),
            year: d.getFullYear() - 1900,
            dayOfWeek: d.getDay(),
            dayOfYear: dayOfYear(d),
            dst: -1,
            milliseconds: d.getMilliseconds(),
        };
    }
}
function dayOfYear(d) {
    // Local-time day-of-year, 0-indexed (Jan 1 → 0). Matches POSIX struct tm.
    const start = new Date(d.getFullYear(), 0, 1);
    const ms = d.getTime() - start.getTime();
    return Math.floor(ms / 86_400_000);
}
// ============================================================
// InMemoryHostClock — deterministic, settable
// ============================================================
/**
 * Test-friendly clock. Holds a mutable {@link HostTime}, exposes setters and
 * an `advance(ms)` helper that propagates carry through every field.
 *
 * Default time is 2026-01-01 00:00:00.000 (a Thursday, day-of-year 0). Tests
 * that don't care about the absolute value can leave it; tests that do care
 * call `setTime` first.
 */
export class InMemoryHostClock {
    #time;
    constructor(initial) {
        this.#time = {
            seconds: 0,
            minutes: 0,
            hours: 0,
            dayOfMonth: 1,
            month: 0,
            year: 126, // 1900 + 126 = 2026
            dayOfWeek: 4, // 2026-01-01 is a Thursday
            dayOfYear: 0,
            dst: 0,
            milliseconds: 0,
            ...initial,
        };
    }
    now() {
        // Defensive copy — callers can hold the result without seeing future
        // mutations from `advance()` or `setTime()`.
        return { ...this.#time };
    }
    setTime(t) {
        this.#time = { ...t };
    }
    /**
     * Advance the clock by `ms` milliseconds. Propagates through seconds,
     * minutes, hours, days-of-month / days-of-week / days-of-year. Months and
     * years are NOT propagated — if a test needs that, it should `setTime()`
     * to the next month explicitly. (Implementing month rollover correctly
     * requires per-month day counts and leap-year logic; out of scope for v0.)
     */
    advance(ms) {
        if (!Number.isFinite(ms) || ms < 0) {
            throw new Error(`InMemoryHostClock.advance: ms must be a non-negative finite number (got ${ms})`);
        }
        const t = this.#time;
        let totalMs = t.milliseconds + ms;
        t.milliseconds = totalMs % 1000;
        let carrySec = Math.floor(totalMs / 1000);
        let totalSec = t.seconds + carrySec;
        t.seconds = totalSec % 60;
        let carryMin = Math.floor(totalSec / 60);
        let totalMin = t.minutes + carryMin;
        t.minutes = totalMin % 60;
        let carryHr = Math.floor(totalMin / 60);
        let totalHr = t.hours + carryHr;
        t.hours = totalHr % 24;
        let carryDay = Math.floor(totalHr / 24);
        if (carryDay > 0) {
            t.dayOfMonth += carryDay; // no clamping; see jsdoc note above
            t.dayOfWeek = (t.dayOfWeek + carryDay) % 7;
            t.dayOfYear += carryDay;
        }
    }
}
