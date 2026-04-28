/**
 * Diagnostic tracer for ELKS-boot debugging.
 *
 * The tracer is a passive recorder: callers (typically a `traceRun` driver)
 * call `record()` with structured events; the tracer keeps the most recent
 * `capacity` events in a ring buffer and `drain()` produces them in
 * chronological order.
 *
 * Why a tracer rather than `console.log`: the trace will be hundreds of
 * thousands of events long, so unconditional logging is unusable. A
 * buffering ring keeps the LAST N events (where N is configurable) so
 * post-mortem analysis after a crash sees the relevant tail rather than
 * the long boring init prefix. Filters narrow further (e.g., only INT
 * fires).
 *
 * NB: The tracer never imports CPU8086 or PagedMemory — it's pure data,
 * driven entirely by the runner. Keeps it test-friendly and decouples
 * it from the layers the brief locks down.
 */
/**
 * Ring-buffered tracer. Writes are O(1); drain is O(n).
 *
 * The ring is implemented as a fixed-size array with a head pointer once
 * capacity is reached. Before that the array grows normally — keeps the
 * common test case of "tiny trace, capacity not hit" cheap.
 */
export class Tracer {
    capacity;
    memWriteRanges;
    kindMask;
    buf = [];
    head = 0;
    full = false;
    constructor(opts = {}) {
        this.capacity = opts.capacity ?? 50_000;
        if (this.capacity <= 0 || !Number.isInteger(this.capacity)) {
            throw new Error(`Tracer capacity must be a positive integer (got ${this.capacity})`);
        }
        const allKinds = [
            'instruction',
            'int',
            'trap',
            'io',
            'memWrite',
            'intService',
        ];
        this.kindMask = new Set(opts.kinds ?? allKinds);
        this.memWriteRanges = opts.memWriteRanges ?? [];
    }
    /** True when this kind of event should be recorded. */
    enabled(kind) {
        return this.kindMask.has(kind);
    }
    /** True if `addr` lies in any configured memory-write range. */
    inMemWriteRange(addr) {
        for (const r of this.memWriteRanges) {
            if (addr >= r.start && addr <= r.end)
                return true;
        }
        return false;
    }
    /** Append an event. Drops the oldest if the ring is full. */
    record(e) {
        if (!this.kindMask.has(e.type))
            return;
        if (!this.full) {
            this.buf.push(e);
            if (this.buf.length >= this.capacity) {
                this.full = true;
                this.head = 0;
            }
        }
        else {
            this.buf[this.head] = e;
            this.head = (this.head + 1) % this.capacity;
        }
    }
    /** Number of events currently held. */
    size() {
        return this.full ? this.capacity : this.buf.length;
    }
    /** True when the ring has wrapped (oldest events were dropped). */
    isFull() {
        return this.full;
    }
    /** Snapshot the events in chronological order. */
    drain() {
        if (!this.full)
            return this.buf.slice();
        return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
    }
    /** Filter helper. */
    filter(predicate) {
        return this.drain().filter(predicate);
    }
    /** Counts grouped by event type; useful for digests. */
    countByType() {
        const out = {
            instruction: 0,
            int: 0,
            trap: 0,
            io: 0,
            memWrite: 0,
            intService: 0,
        };
        for (const e of this.drain())
            out[e.type]++;
        return out;
    }
}
