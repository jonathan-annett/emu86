/**
 * Substrate control endpoint (API v1, Phase 15 post-close addendum F).
 *
 * The machine talks to its own substrate with the tool it already has:
 *
 *   urlget http://10.0.2.2/?whoami        → name + address
 *   urlget http://10.0.2.2/?peers        → live TAN members
 *   urlget http://10.0.2.2/?mkdrive=8086  → create + attach a drive
 *
 * A tiny HTTP/1.0 responder on the gateway's OWN address — TCP dialed
 * at 10.0.2.2 used to be silently dropped ({@link LanGateway} handled
 * only ICMP for itself); it now arrives here via `registerLocalTcp`,
 * kept deliberately distinct from the off-subnet terminator (that one
 * fetches the web; this one is introspection and provisioning).
 *
 * The actions are injected: `whoami`/`peers` answer synchronously from
 * the worker's own TAN state; `mkdrive` is a promise because the image
 * library and settings live on the MAIN thread — the worker posts a
 * `control-request` and the answer comes back as a `control-response`
 * (queue-and-complete, the DNS host's pattern). No run-loop stall is
 * needed: the round trip is two postMessages, not a fetch.
 *
 * Responses are plain text, written for a human reading a guest
 * terminal. Anything unparseable gets a 400 with the usage text —
 * `urlget` shows the body either way.
 */

import { LanGateway, GATEWAY_IP } from './gateway.js';
import { TcpStack, type TcpConnection } from './tcp.js';
import { IPPROTO_TCP } from './wire.js';

export const CONTROL_PORT = 80;

/** Longest request head we'll buffer before calling it garbage. */
const MAX_REQUEST_BYTES = 2048;

export interface ControlActions {
  /** One line: who this machine is (name + address). */
  whoami(): string;
  /** The live TAN directory, one member per line. */
  peers(): string;
  /**
   * Create a blank drive of (about) `kb` KB in the image library and
   * select it as the secondary. Resolves to the text shown in the
   * guest terminal (success or an honest refusal).
   */
  mkdrive(kb: number): Promise<string>;
}

const USAGE = [
  'emu86 substrate control -- talk to the machine under the machine.',
  'actions (urlget http://10.0.2.2/?ACTION):',
  '  ?whoami         who am I (name + address)',
  '  ?peers          who is on the Tab Area Network right now',
  '  ?mkdrive=KB     create + attach a blank drive (8086, 16128, 32256)',
  '',
].join('\n');

interface ConnCtx {
  buffer: Uint8Array;
  /** A response is being produced (mkdrive) — hold the connection. */
  busy: boolean;
  remoteClosed: boolean;
}

export class ControlHost {
  readonly #actions: ControlActions;
  readonly #tcp: TcpStack;
  readonly #conns = new Map<TcpConnection, ConnCtx>();
  #gateway: LanGateway | null = null;

  // Counters for tests/diagnostics.
  requestsServed = 0;
  badRequests = 0;
  transmitsWithoutRoute = 0;

  constructor(actions: ControlActions) {
    this.#actions = actions;
    this.#tcp = new TcpStack({
      localIp: GATEWAY_IP,
      transmit: (dstIp, segment, srcIp) => {
        if (this.#gateway === null) return;
        if (!this.#gateway.sendIpv4To(dstIp, srcIp, IPPROTO_TCP, segment)) {
          this.transmitsWithoutRoute++;
        }
      },
    });
    this.#tcp.listen(CONTROL_PORT, {
      onConnect: (conn) => {
        this.#conns.set(conn, {
          buffer: new Uint8Array(0),
          busy: false,
          remoteClosed: false,
        });
      },
      onData: (conn, data) => this.#onData(conn, data),
      onRemoteClose: (conn) => {
        // urlget may shut its write side after the request; hold the
        // half-open connection while an answer is in flight.
        const ctx = this.#conns.get(conn);
        if (ctx === undefined) {
          conn.close();
          return;
        }
        ctx.remoteClosed = true;
        if (!ctx.busy) conn.close();
      },
      onClosed: (conn) => {
        this.#conns.delete(conn);
      },
    });
  }

  /** Plug into the LAN's gateway. One gateway per host instance. */
  attachTo(gateway: LanGateway): void {
    if (this.#gateway !== null) {
      throw new Error('ControlHost: already attached');
    }
    this.#gateway = gateway;
    gateway.registerLocalTcp((srcIp, dstIp, tcpPayload) =>
      this.#tcp.onSegment(srcIp, tcpPayload, dstIp),
    );
  }

  /** The transport engine — exposed for tests/diagnostics. */
  get tcp(): TcpStack {
    return this.#tcp;
  }

  #onData(conn: TcpConnection, data: Uint8Array): void {
    const ctx = this.#conns.get(conn);
    if (ctx === undefined || ctx.busy) return;
    const joined = new Uint8Array(ctx.buffer.length + data.length);
    joined.set(ctx.buffer, 0);
    joined.set(data, ctx.buffer.length);
    ctx.buffer = joined;

    if (ctx.buffer.length > MAX_REQUEST_BYTES) {
      this.badRequests++;
      this.#respond(conn, ctx, '400 Bad Request', USAGE);
      return;
    }
    // A GET has no body — the request is complete at the header end.
    const text = latin1(ctx.buffer);
    if (!text.includes('\r\n\r\n') && !text.includes('\n\n')) return;

    const m = /^GET\s+(\S+)\s+HTTP\//.exec(text);
    if (m === null || m[1] === undefined) {
      this.badRequests++;
      this.#respond(conn, ctx, '400 Bad Request', USAGE);
      return;
    }
    this.#dispatch(conn, ctx, m[1]);
  }

  #dispatch(conn: TcpConnection, ctx: ConnCtx, target: string): void {
    const q = target.indexOf('?');
    const query = q >= 0 ? target.slice(q + 1) : '';
    const [action = '', value = ''] = (query.split('&')[0] ?? '').split('=');

    if (action === 'whoami') {
      this.requestsServed++;
      this.#respond(conn, ctx, '200 OK', this.#actions.whoami() + '\n');
      return;
    }
    if (action === 'peers') {
      this.requestsServed++;
      this.#respond(conn, ctx, '200 OK', this.#actions.peers() + '\n');
      return;
    }
    if (action === 'mkdrive') {
      const kb = /^\d+$/.test(value) ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(kb)) {
        this.badRequests++;
        this.#respond(conn, ctx, '400 Bad Request', USAGE);
        return;
      }
      ctx.busy = true;
      this.requestsServed++;
      this.#actions
        .mkdrive(kb)
        .then((text) => this.#respond(conn, ctx, '200 OK', text + '\n'))
        .catch((err) =>
          this.#respond(conn, ctx, '500 Error', `mkdrive failed: ${String(err)}\n`),
        );
      return;
    }
    this.badRequests++;
    this.#respond(conn, ctx, action === '' ? '200 OK' : '400 Bad Request', USAGE);
  }

  #respond(conn: TcpConnection, ctx: ConnCtx, status: string, body: string): void {
    ctx.busy = false;
    const bytes = new TextEncoder().encode(body);
    const head =
      `HTTP/1.0 ${status}\r\n` +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${bytes.length}\r\n` +
      'Connection: close\r\n\r\n';
    const headBytes = new TextEncoder().encode(head);
    const out = new Uint8Array(headBytes.length + bytes.length);
    out.set(headBytes, 0);
    out.set(bytes, headBytes.length);
    conn.send(out);
    conn.close();
  }
}

/** Bytes → string, one char per byte (requests are ASCII in practice). */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
