/**
 * The debug trace (field ask 2026-07-17: "include other logging items
 * in tab-shark, like when pc state is frozen etc — this will help
 * debug later", asked while chasing telnet-restore bugs).
 *
 * Every tab broadcasts its lifecycle breadcrumbs on `emu86-debug-v1`:
 * freezes and thaws, capture and restore outcomes, page lifecycle
 * (pagehide/pageshow/hidden), migration steps — plus a mirror of every
 * syslog line, so anything a tab tells its user it also tells the
 * wire. tab-shark subscribes read-only and renders the traces beside
 * the frames, so a multi-tab bug (a torn telnet restore, say) leaves
 * ONE merged, timestamped story with every participant named.
 *
 * Fire-and-forget by construction: nothing in the app ever LISTENS on
 * this channel, no behavior depends on a trace arriving, and a
 * context without BroadcastChannel simply doesn't trace. Same-origin
 * only, like every channel here.
 */

export const DEBUG_CHANNEL_NAME = 'emu86-debug-v1';

export interface DebugTraceMsg {
  dbg: 'trace';
  /** Sender identity, best known at send time (set after the lease). */
  octet: number | null;
  name: string | null;
  /** Rack instance id when embedded; null in a standalone tab. */
  pc: string | null;
  text: string;
}

export interface DebugTrace {
  (text: string): void;
  setIdentity(octet: number | null, name: string | null): void;
}

/** Minimal channel shape — injectable for tests. */
export interface DebugChannel {
  postMessage(data: unknown): void;
}

export function createDebugTrace(
  pc: string | null = null,
  channel?: DebugChannel | null,
): DebugTrace {
  let sink: DebugChannel | null = null;
  if (channel !== undefined) {
    sink = channel;
  } else {
    try {
      sink = new BroadcastChannel(DEBUG_CHANNEL_NAME);
    } catch {
      sink = null; // no channel, no trace — never an error
    }
  }
  let octet: number | null = null;
  let name: string | null = null;
  const trace = ((text: string): void => {
    try {
      sink?.postMessage({ dbg: 'trace', octet, name, pc, text } satisfies DebugTraceMsg);
    } catch {
      // Tracing must never break the machine it narrates.
    }
  }) as DebugTrace;
  trace.setIdentity = (o: number | null, n: string | null): void => {
    octet = o;
    name = n;
  };
  return trace;
}
