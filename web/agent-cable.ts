/**
 * The agent cable — page client (agent-cable brief M2).
 *
 * When the user sets a cable URL in settings, the page dials OUT to a
 * websocket on their own localhost (tools/agent-cable/server.mjs) and
 * streams its serial console there; the server's plain-HTTP side gives
 * the agent a curl-friendly live view and a way to type. The direction
 * inversion is the whole idea: the Phase 14 M2.5 bridge lives inside
 * the vite dev server and can never reach a deployed page, while this
 * client lets ANY page — localhost vite, the dev tier, one day stable
 * — plug itself into the agent's bench.
 *
 * Security boundary, enforced HERE and re-checked at the settings
 * layer: the only URLs this module accepts are loopback ws://. A
 * deployed page must be impossible to talk into streaming a console
 * anywhere but the user's own machine — so the validator refuses
 * everything else, including wss:// (TLS implies a non-local trust
 * story) and URLs carrying credentials.
 *
 * Browser policy (brief §0): ws://localhost from an HTTPS page is
 * exempt from mixed-content blocking (localhost is a potentially
 * trustworthy origin); newer Chrome may show a one-click Local Network
 * Access prompt; Safari blocks — accepted, this is a dev tool for a
 * box the user controls.
 *
 * Console bytes produced while the cable is down are NOT buffered or
 * replayed: the server keeps its own rolling buffer per connection,
 * and a dev tool has no business replaying output nobody was listening
 * to. What the agent tails is what flowed while it was plugged in.
 */

/** Loopback ws:// only — the cable's whole trust model in one predicate. */
export function isValidAgentCableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'ws:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    && url.username === ''
    && url.password === ''
  );
}

/** What the hello frame carries — see the server's protocol comment. */
export interface AgentCableIdentity {
  /** TAN hostname (mouse/cat/…) once the lease settles; null before. */
  name: string | null;
  /** 10.0.2.<octet> once leased; null before. */
  octet: number | null;
  /** Rack instance id (?pc=…) when embedded; null standalone. */
  pc: string | null;
  /** Build stamp, so the agent knows which build it is watching. */
  build: string;
}

export interface AgentCable {
  /** Stream a console-output chunk (worker tx bytes) to the server. */
  tx(bytes: Uint8Array): void;
  /** Re-send hello — call when the TAN identity settles or changes. */
  refreshIdentity(): void;
  /** Close and stop redialing (URL cleared or replaced). Silent. */
  unplug(): void;
}

const MAX_REDIAL_DELAY_MS = 30_000;

/**
 * Dial the cable server and keep the plug in: exponential-backoff
 * redial (base → 30 s cap, reset on success), with status lines only
 * on TRANSITIONS — one when the plug lands, one when an established
 * connection drops, and a single "nothing listening" the first time a
 * dial fails, ever. Retries themselves are silent; a syslog that
 * ticks every backoff would be worse than no cable.
 */
export function plugAgentCable(opts: {
  url: string;
  identity: () => AgentCableIdentity;
  onRx: (bytes: Uint8Array) => void;
  onStatus: (text: string) => void;
  /** Backoff floor, default 1000 ms — tests shrink it. */
  baseDelayMs?: number;
}): AgentCable {
  const base = opts.baseDelayMs ?? 1000;
  let socket: WebSocket | null = null;
  let unplugged = false;
  let connected = false;
  let announcedDeadDial = false;
  let delay = base;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function sendHello(ws: WebSocket): void {
    const id = opts.identity();
    ws.send(JSON.stringify({
      cable: 'hello',
      name: id.name,
      octet: id.octet,
      pc: id.pc,
      build: id.build,
    }));
  }

  function schedule(): void {
    if (unplugged || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      dial();
    }, delay);
    delay = Math.min(delay * 2, MAX_REDIAL_DELAY_MS);
  }

  function dial(): void {
    if (unplugged) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(opts.url);
    } catch {
      // The constructor itself can refuse (malformed URL slipped past a
      // stale stored value, or a context that forbids the scheme).
      schedule();
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      if (unplugged) {
        ws.close();
        return;
      }
      connected = true;
      delay = base;
      sendHello(ws);
      opts.onStatus(`agent cable: plugged into ${opts.url}`);
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return; // not ours
      }
      if (msg === null || typeof msg !== 'object') return;
      const m = msg as { cable?: unknown; data?: unknown };
      if (m.cable !== 'rx' || typeof m.data !== 'string') return;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(m.data);
      } catch {
        return; // corrupt frame — drop, don't kill the plug
      }
      opts.onRx(bytes);
    });
    // End-of-life differs by runtime: browsers fire error THEN close on
    // a failed dial, Node's undici WebSocket fires ONLY error (no close
    // ever — found by this module's own test). Settle on whichever
    // arrives first, exactly once per socket.
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (socket === ws) socket = null;
      if (unplugged) return;
      if (connected) {
        connected = false;
        opts.onStatus('agent cable: connection lost — redialing quietly');
      } else if (!announcedDeadDial) {
        announcedDeadDial = true;
        opts.onStatus(`agent cable: nothing listening at ${opts.url} — redialing quietly`);
      }
      schedule();
    };
    ws.addEventListener('close', settle);
    ws.addEventListener('error', settle);
  }

  dial();

  return {
    tx(bytes: Uint8Array): void {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ cable: 'tx', data: bytesToBase64(bytes) }));
    },
    refreshIdentity(): void {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      sendHello(socket);
    },
    unplug(): void {
      unplugged = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}

// btoa takes a binary STRING; spreading a whole console burst into one
// fromCharCode call would blow the arg limit, so chunk it.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}
