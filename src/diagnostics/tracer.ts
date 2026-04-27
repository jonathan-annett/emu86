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

export interface InstructionEvent {
  type: 'instruction';
  /** CS:IP segment (16 bit). */
  cs: number;
  /** CS:IP offset (16 bit). */
  ip: number;
  /** Linear address `(cs<<4)+ip`. */
  linear: number;
  /** Up to 6 bytes starting at linear. Useful for hand-decoding the opcode. */
  bytes: number[];
  /** Live register snapshot, captured before the step. */
  ax: number;
  bx: number;
  cx: number;
  dx: number;
  si: number;
  di: number;
  bp: number;
  sp: number;
  ds: number;
  es: number;
  ss: number;
  flags: number;
}

/** Recorded when the CPU is about to execute an INT N / INT 3 / INTO opcode. */
export interface IntEvent {
  type: 'int';
  vector: number;
  cs: number;
  ip: number;
  ax: number;
  bx: number;
  cx: number;
  dx: number;
}

/**
 * Recorded when control reaches a registered BIOS trap address — i.e. the
 * JS BIOS handler is about to fire. `vector` is computed from the trap-stub
 * layout when the address is in `0xF1000..0xF10FF`; otherwise `null`.
 */
export interface TrapEvent {
  type: 'trap';
  linear: number;
  vector: number | null;
  /** `cs` and `ip` at the time the handler runs. */
  cs: number;
  ip: number;
  ah: number;
  al: number;
  /** Common service inputs the handler typically reads. */
  bx: number;
  cx: number;
  dx: number;
  ds: number;
  es: number;
}

/** Recorded for every CPU IN/OUT routed through the IO bus. */
export interface IoEvent {
  type: 'io';
  dir: 'in' | 'out';
  size: 'b' | 'w';
  port: number;
  value: number;
}

/** Recorded for memory writes inside any of the tracer's configured ranges. */
export interface MemWriteEvent {
  type: 'memWrite';
  addr: number;
  value: number;
  size: 'b' | 'w';
}

/**
 * Recorded when an interrupt is about to be serviced by the CPU. `vector`
 * is `2` for NMI; for maskables it is `-1` because peeking the controller
 * without consuming is not supported and we don't want to perturb state.
 */
export interface InterruptServiceEvent {
  type: 'intService';
  vector: number;
  cs: number;
  ip: number;
}

export type TraceEvent =
  | InstructionEvent
  | IntEvent
  | TrapEvent
  | IoEvent
  | MemWriteEvent
  | InterruptServiceEvent;

export type TraceEventKind = TraceEvent['type'];

export interface MemRange {
  start: number;
  end: number;
}

export interface TracerOptions {
  /** Max events held in the ring buffer. Older events drop. Default 50_000. */
  capacity?: number;
  /** Set of event kinds to record. Default: all kinds. */
  kinds?: ReadonlyArray<TraceEventKind>;
  /** Linear-address ranges (inclusive) to capture memory writes for. */
  memWriteRanges?: ReadonlyArray<MemRange>;
}

/**
 * Ring-buffered tracer. Writes are O(1); drain is O(n).
 *
 * The ring is implemented as a fixed-size array with a head pointer once
 * capacity is reached. Before that the array grows normally — keeps the
 * common test case of "tiny trace, capacity not hit" cheap.
 */
export class Tracer {
  readonly capacity: number;
  readonly memWriteRanges: ReadonlyArray<MemRange>;
  private readonly kindMask: ReadonlySet<TraceEventKind>;
  private readonly buf: TraceEvent[] = [];
  private head = 0;
  private full = false;

  constructor(opts: TracerOptions = {}) {
    this.capacity = opts.capacity ?? 50_000;
    if (this.capacity <= 0 || !Number.isInteger(this.capacity)) {
      throw new Error(`Tracer capacity must be a positive integer (got ${this.capacity})`);
    }
    const allKinds: ReadonlyArray<TraceEventKind> = [
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
  enabled(kind: TraceEventKind): boolean {
    return this.kindMask.has(kind);
  }

  /** True if `addr` lies in any configured memory-write range. */
  inMemWriteRange(addr: number): boolean {
    for (const r of this.memWriteRanges) {
      if (addr >= r.start && addr <= r.end) return true;
    }
    return false;
  }

  /** Append an event. Drops the oldest if the ring is full. */
  record(e: TraceEvent): void {
    if (!this.kindMask.has(e.type)) return;
    if (!this.full) {
      this.buf.push(e);
      if (this.buf.length >= this.capacity) {
        this.full = true;
        this.head = 0;
      }
    } else {
      this.buf[this.head] = e;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Number of events currently held. */
  size(): number {
    return this.full ? this.capacity : this.buf.length;
  }

  /** True when the ring has wrapped (oldest events were dropped). */
  isFull(): boolean {
    return this.full;
  }

  /** Snapshot the events in chronological order. */
  drain(): TraceEvent[] {
    if (!this.full) return this.buf.slice();
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  /** Filter helper. */
  filter(predicate: (e: TraceEvent) => boolean): TraceEvent[] {
    return this.drain().filter(predicate);
  }

  /** Counts grouped by event type; useful for digests. */
  countByType(): Record<TraceEventKind, number> {
    const out: Record<TraceEventKind, number> = {
      instruction: 0,
      int: 0,
      trap: 0,
      io: 0,
      memWrite: 0,
      intService: 0,
    };
    for (const e of this.drain()) out[e.type]++;
    return out;
  }
}
