/**
 * HTTP gateway pseudo-host (Phase 15 M1 — the milestone the networking
 * plan called M3d): TCP termination for arbitrary off-subnet
 * destinations, with `fetch()` as the way out to the real internet.
 *
 * Not a LAN citizen: no MAC, no switch port. Routing already delivers
 * every off-subnet packet to the LanGateway's MAC, so this host plugs
 * into the gateway ({@link LanGateway.registerTcpTerminator} in,
 * {@link LanGateway.sendIpv4To} out) and terminates whatever TCP shows
 * up, speaking as whichever destination the guest dialed.
 *
 * Two payload modes by dialed port:
 *
 *   - **:53 → DNS-over-TCP**, the same length-prefixed pass-through as
 *     `DnsHost`. ELKS's resolver defaults to OpenDNS (208.67.222.222)
 *     when no DNSIP is set — that address now terminates here, so
 *     zero-config lookups work (deliberately parked in
 *     DNS_DOH_REPORT.md §5 "until M3d").
 *   - **anything else → HTTP**: parse one request, fetch it, stream the
 *     response back, FIN (Connection: close — one request per
 *     connection). The URL is reconstructed Host-header-first; clients
 *     that send no Host header fall back to the {@link DnsAnswerCache}
 *     reverse map (dialed IP → the name the guest resolved), then to
 *     the dotted IP itself.
 *
 * Port 443 is refused with an RST (the `acceptPort` default): fetch
 * owns TLS, so raw HTTPS termination is structurally impossible here —
 * an instant connection-refused is the honest answer, not a hang. The
 * `webget`/ttyS1 escape hatch remains the sanctioned HTTPS route.
 *
 * Async pattern is DnsHost's: request bytes are ACKed synchronously by
 * the TcpStack, the fetch settles between run batches, the response
 * transmits then. {@link HttpGatewayHost.pendingFetches} mirrors
 * `pendingResolves` as the run-loop stall signal (belt-and-braces
 * under honest pacing, same rationale as the DNS stall).
 */

import { GATEWAY_IP, type LanGateway } from './gateway.js';
import { TcpStack, type TcpConnection } from './tcp.js';
import { servfailFor, type DnsResolve } from './dns.js';
import { IPPROTO_TCP, formatIp, type Ipv4 } from './wire.js';

/** One fetched response, already fully buffered (bodies are small-era sized). */
export interface FetchedResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export interface GatewayFetchRequest {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: Uint8Array | null;
}

/** Injected fetch — tests use fixtures; the browser uses {@link realGatewayFetch}. */
export type GatewayFetch = (req: GatewayFetchRequest) => Promise<FetchedResponse>;

/**
 * Wrap the platform fetch(). Redirects are followed silently (the
 * guest sees the final body). Port-80 URLs are upgraded to https by
 * default: the deployed page is itself served over HTTPS, and browsers
 * block plain-http fetches from secure pages as mixed content — the
 * guest still speaks HTTP/1.0 on the LAN wire; only the host-side hop
 * travels TLS. Explicit non-80 ports are left alone (TLS on a random
 * port would be a different service).
 */
export function realGatewayFetch(opts: { upgradeToHttps?: boolean } = {}): GatewayFetch {
  const upgrade = opts.upgradeToHttps ?? true;
  return async (req: GatewayFetchRequest): Promise<FetchedResponse> => {
    const url =
      upgrade && /^http:\/\/[^/:]+(\/|$)/.test(req.url) ? `https://${req.url.slice(7)}` : req.url;
    const response = await fetch(url, {
      method: req.method,
      headers: req.headers,
      redirect: 'follow',
      ...(req.body !== null && req.body.length > 0 ? { body: toArrayBuffer(req.body) } : {}),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    const headers: Array<[string, string]> = [];
    response.headers.forEach((value, name) => headers.push([name, value]));
    return { status: response.status, statusText: response.statusText, headers, body };
  };
}

export interface HttpGatewayHostOptions {
  fetchFn: GatewayFetch;
  /** Reverse map for Host-less clients: dialed IP → the name the guest resolved. */
  reverseLookup?: (ip: Ipv4) => string | undefined;
  /** Serve off-subnet :53 as DNS-over-TCP. Absent → :53 behaves like any HTTP port. */
  dnsResolve?: DnsResolve;
  /** Observe fetch/resolve failures (already answered with 502/SERVFAIL). */
  onError?: (err: unknown) => void;
  /** Ports the terminator accepts; refused ports RST. Default: everything except 443. */
  acceptPort?: (port: number) => boolean;
}

/** Request headers that must not be forwarded into fetch(). */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

/** Response headers we own (recomputed or meaningless after fetch decoding). */
const RESPONSE_STRIP = new Set(['transfer-encoding', 'content-encoding', 'content-length', 'connection']);

/** Reason phrases for origins that answer over HTTP/2 (fetch reports ''). */
const REASONS = new Map<number, string>([
  [200, 'OK'],
  [201, 'Created'],
  [204, 'No Content'],
  [301, 'Moved Permanently'],
  [302, 'Found'],
  [304, 'Not Modified'],
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
]);

/** Headers larger than this without a terminator are a bad request, not patience. */
const MAX_HEADER_BYTES = 16384;

export interface ParsedRequest {
  method: string;
  target: string;
  version: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

interface ConnCtx {
  mode: 'http' | 'dns';
  buffer: Uint8Array;
  /** Fetches/resolves in flight on this connection. */
  inFlight: number;
  /** Guest half-closed — close ours once the last in-flight op answers. */
  remoteClosed: boolean;
  /** HTTP mode: request dispatched (or refused) — ignore further bytes. */
  done: boolean;
}

export class HttpGatewayHost {
  readonly #fetch: GatewayFetch;
  readonly #reverseLookup: (ip: Ipv4) => string | undefined;
  readonly #dnsResolve: DnsResolve | null;
  readonly #onError: (err: unknown) => void;
  readonly #tcp: TcpStack;
  readonly #conns = new Map<TcpConnection, ConnCtx>();
  #gateway: LanGateway | null = null;
  #pendingFetches = 0;

  // Counters for tests/diagnostics.
  requestsServed = 0;
  badRequests = 0;
  fetchErrors = 0;
  dnsQueriesResolved = 0;
  responsesDropped = 0;
  transmitsWithoutRoute = 0;

  constructor(opts: HttpGatewayHostOptions) {
    this.#fetch = opts.fetchFn;
    this.#reverseLookup = opts.reverseLookup ?? (() => undefined);
    this.#dnsResolve = opts.dnsResolve ?? null;
    this.#onError = opts.onError ?? (() => { /* unobserved */ });
    const acceptPort = opts.acceptPort ?? ((port: number): boolean => port !== 443);
    this.#tcp = new TcpStack({
      localIp: GATEWAY_IP, // nominal; every connection carries its dialed identity
      transmit: (dstIp, segment, srcIp) => {
        if (this.#gateway === null) return;
        if (!this.#gateway.sendIpv4To(dstIp, srcIp, IPPROTO_TCP, segment)) {
          this.transmitsWithoutRoute++;
        }
      },
    });
    this.#tcp.listenAny(
      {
        onConnect: (conn) => {
          this.#conns.set(conn, {
            mode: conn.localPort === 53 && this.#dnsResolve !== null ? 'dns' : 'http',
            buffer: new Uint8Array(0),
            inFlight: 0,
            remoteClosed: false,
            done: false,
          });
        },
        onData: (conn, data) => this.#onData(conn, data),
        onRemoteClose: (conn) => {
          const ctx = this.#conns.get(conn);
          if (ctx === undefined) {
            conn.close();
            return;
          }
          // write-then-shutdown clients still want their answer: hold
          // the half-open connection while anything is in flight.
          ctx.remoteClosed = true;
          if (ctx.inFlight === 0) conn.close();
        },
        onClosed: (conn) => {
          this.#conns.delete(conn);
        },
      },
      (_localIp, localPort) => acceptPort(localPort),
    );
  }

  /** Plug into the LAN's gateway. One gateway per host instance. */
  attachTo(gateway: LanGateway): void {
    if (this.#gateway !== null) {
      throw new Error('HttpGatewayHost: already attached');
    }
    this.#gateway = gateway;
    gateway.registerTcpTerminator((srcIp, dstIp, tcpPayload) =>
      this.#tcp.onSegment(srcIp, tcpPayload, dstIp),
    );
  }

  /** The transport engine — exposed for tests/diagnostics. */
  get tcp(): TcpStack {
    return this.#tcp;
  }

  /** Fetches + resolves in flight — the run-loop stall signal. */
  get pendingFetches(): number {
    return this.#pendingFetches;
  }

  // ============================================================
  // Payload handling
  // ============================================================

  #onData(conn: TcpConnection, data: Uint8Array): void {
    const ctx = this.#conns.get(conn);
    if (ctx === undefined) return;
    ctx.buffer = concat(ctx.buffer, data);

    if (ctx.mode === 'dns') {
      this.#drainDnsQueries(conn, ctx);
      return;
    }

    if (ctx.done || ctx.inFlight > 0) return; // one request per connection
    const parsed = tryParseRequest(ctx.buffer);
    if (parsed === 'incomplete') return;
    if (parsed === 'bad') {
      ctx.done = true;
      this.badRequests++;
      this.#respond(conn, 'HTTP/1.0', 'GET', {
        status: 400,
        statusText: 'Bad Request',
        headers: [['content-type', 'text/plain']],
        body: latin1Bytes('emu86 gateway: malformed HTTP request\n'),
      });
      return;
    }
    ctx.done = true;
    ctx.inFlight++;
    void this.#fetchAndRespond(conn, ctx, parsed);
  }

  async #fetchAndRespond(conn: TcpConnection, ctx: ConnCtx, req: ParsedRequest): Promise<void> {
    const url = this.#buildUrl(conn, req);
    const forwarded = req.headers.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()));

    let response: FetchedResponse;
    this.#pendingFetches++;
    try {
      response = await this.#fetch({
        url,
        method: req.method,
        headers: forwarded,
        body: req.body.length > 0 ? req.body : null,
      });
    } catch (err) {
      this.#onError(err);
      this.fetchErrors++;
      response = {
        status: 502,
        statusText: 'Bad Gateway',
        headers: [['content-type', 'text/plain']],
        body: latin1Bytes(`emu86 gateway: ${String(err)}\n`),
      };
    } finally {
      this.#pendingFetches--;
      ctx.inFlight--;
    }
    this.#respond(conn, req.version, req.method, response);
  }

  /**
   * Host-header-first URL reconstruction; absolute-form targets
   * (proxy-style `GET http://host/ HTTP/1.0`) pass through verbatim.
   */
  #buildUrl(conn: TcpConnection, req: ParsedRequest): string {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(req.target)) return req.target;
    const hostHeader = getHeader(req.headers, 'host');
    let authority = hostHeader ?? this.#reverseLookup(conn.localIp) ?? formatIp(conn.localIp);
    if (!authority.includes(':') && conn.localPort !== 80) {
      authority += `:${conn.localPort}`;
    }
    const path = req.target.startsWith('/') ? req.target : `/${req.target}`;
    return `http://${authority}${path}`;
  }

  /** Format and send the response, then close (Connection: close semantics). */
  #respond(conn: TcpConnection, version: string, method: string, response: FetchedResponse): void {
    if (conn.state !== 'established' && conn.state !== 'close-wait') {
      this.responsesDropped++; // guest gave up before the origin answered
      return;
    }
    const reason =
      response.statusText.length > 0 ? response.statusText : (REASONS.get(response.status) ?? '');
    const lines = [`${version === 'HTTP/1.1' ? 'HTTP/1.1' : 'HTTP/1.0'} ${response.status} ${reason}`.trimEnd()];
    for (const [name, value] of response.headers) {
      if (RESPONSE_STRIP.has(name.toLowerCase())) continue;
      lines.push(`${name}: ${value}`);
    }
    lines.push(`Content-Length: ${response.body.length}`);
    lines.push('Connection: close');
    const head = latin1Bytes(`${lines.join('\r\n')}\r\n\r\n`);
    conn.send(method === 'HEAD' ? head : concat(head, response.body));
    this.requestsServed++;
    conn.close();
  }

  // ============================================================
  // :53 — DNS-over-TCP, DnsHost's exact shape
  // ============================================================

  #drainDnsQueries(conn: TcpConnection, ctx: ConnCtx): void {
    for (;;) {
      if (ctx.buffer.length < 2) return;
      const queryLen = ((ctx.buffer[0] ?? 0) << 8) | (ctx.buffer[1] ?? 0);
      if (ctx.buffer.length < 2 + queryLen) return; // wait for the rest
      const query = Uint8Array.from(ctx.buffer.subarray(2, 2 + queryLen));
      ctx.buffer = ctx.buffer.subarray(2 + queryLen);
      ctx.inFlight++;
      void this.#resolveAndAnswer(conn, ctx, query);
    }
  }

  async #resolveAndAnswer(conn: TcpConnection, ctx: ConnCtx, query: Uint8Array): Promise<void> {
    const resolve = this.#dnsResolve;
    if (resolve === null) return; // unreachable: dns mode requires it
    let answer: Uint8Array;
    this.#pendingFetches++;
    try {
      answer = await resolve(query);
      this.dnsQueriesResolved++;
    } catch (err) {
      this.#onError(err);
      answer = servfailFor(query);
    } finally {
      this.#pendingFetches--;
      ctx.inFlight--;
    }
    if (conn.state !== 'established' && conn.state !== 'close-wait') {
      this.responsesDropped++;
      return;
    }
    const framed = new Uint8Array(2 + answer.length);
    framed[0] = (answer.length >> 8) & 0xff;
    framed[1] = answer.length & 0xff;
    framed.set(answer, 2);
    conn.send(framed);
    if (ctx.remoteClosed && ctx.inFlight === 0) conn.close();
  }
}

// ============================================================
// Request parsing
// ============================================================

/**
 * Parse one HTTP request off the accumulated bytes. 'incomplete' asks
 * for more data; 'bad' is definitive. Tolerates HTTP/1.0 and 1.1
 * origin-form and absolute-form targets; requires CRLF line endings
 * (what ELKS `urlget`/`httpd`-era clients send).
 */
export function tryParseRequest(bytes: Uint8Array): ParsedRequest | 'incomplete' | 'bad' {
  const headerEnd = findDoubleCrlf(bytes);
  if (headerEnd < 0) {
    return bytes.length > MAX_HEADER_BYTES ? 'bad' : 'incomplete';
  }
  const head = latin1(bytes.subarray(0, headerEnd));
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ').filter((p) => p.length > 0);
  if (parts.length !== 3) return 'bad';
  const method = parts[0] ?? '';
  const target = parts[1] ?? '';
  const version = parts[2] ?? '';
  if (!/^[A-Z]+$/.test(method) || !/^HTTP\/\d\.\d$/.test(version)) return 'bad';

  const headers: Array<[string, string]> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon < 1) return 'bad';
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }

  const lengthHeader = getHeader(headers, 'content-length');
  const contentLength = lengthHeader !== undefined ? Number.parseInt(lengthHeader, 10) : 0;
  if (!Number.isFinite(contentLength) || contentLength < 0) return 'bad';
  const bodyStart = headerEnd + 4;
  if (bytes.length < bodyStart + contentLength) return 'incomplete';
  return {
    method,
    target,
    version,
    headers,
    body: Uint8Array.from(bytes.subarray(bodyStart, bodyStart + contentLength)),
  };
}

function findDoubleCrlf(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function getHeader(headers: Array<[string, string]>, name: string): string | undefined {
  for (const [key, value] of headers) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Copy into a fresh allocation: `.buffer` is then a plain ArrayBuffer, which BodyInit accepts. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
