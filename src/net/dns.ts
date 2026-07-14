/**
 * DNS pseudo-host (Phase 14 M3c) — 10.0.2.3, the slirp-convention
 * nameserver address, one hop along from the M3b gateway at 10.0.2.2.
 *
 * ELKS resolves names over **TCP** (`libc/net/in_resolv.c`: ktcp has
 * no UDP), sending the RFC 1035 §4.2.2 form — a 2-byte big-endian
 * length prefix, then the query message. This host listens on TCP/53
 * via {@link TcpStack}, strips the prefix, hands the raw query to an
 * injected {@link DnsResolve} function, and streams the answer back
 * with the prefix restored. The pass-through itself is byte-exact —
 * in the browser the resolve function is {@link dohResolve} (RFC 8484
 * GET pass-through to a CORS-permissive DoH endpoint), so the guest's
 * own query and the resolver's real answer travel byte-authentically.
 *
 * Phase 15 M1 posture change (deliberate, recorded): when a
 * {@link DnsAnswerCache} is supplied, successful answers are *read*
 * (question name + A records) to build the IP→name reverse map the
 * HTTP gateway needs for Host-less clients. Reading is all — the
 * answer still travels to the guest untouched.
 *
 * First async pseudo-host: the query is ACKed synchronously (the
 * TcpStack does that before `onData` fires), and the answer transmits
 * whenever the resolve promise settles — the queue-and-complete
 * pattern `ARP_ICMP_REPORT.md` §3.3 reserved for fetch-backed hosts.
 * The switch stays synchronous throughout. If the resolve outlasts the
 * guest's own 2-second `alarm()` the guest closes first and the late
 * answer is dropped by the stack (counted, not an error).
 *
 * ARP is answered for the host's own IP, same learning shape as
 * `LanGateway` — each pseudo-host is its own LAN citizen.
 */

import type { EthernetSwitch, SwitchPort } from './switch.js';
import { TcpStack, type TcpConnection } from './tcp.js';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  IPPROTO_TCP,
  buildArp,
  buildEthernetFrame,
  buildIpv4,
  formatIp,
  ipEquals,
  parseArp,
  parseIpv4,
  type Ipv4,
  type Mac,
} from './wire.js';

/** Slirp-convention DNS host identity (gateway is .2, DNS is .3). */
export const DNS_IP: Ipv4 = [10, 0, 2, 3];
export const DNS_MAC: Mac = [0x52, 0x55, 0x0a, 0x00, 0x02, 0x03];

export const DNS_PORT = 53;

/**
 * Resolve one raw DNS query message (no length prefix) to a raw DNS
 * response message. Rejections become synthesized SERVFAILs.
 */
export type DnsResolve = (query: Uint8Array) => Promise<Uint8Array>;

/** Cloudflare's CORS-permissive DoH endpoint (RFC 8484 wire format). */
export const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';

/**
 * RFC 8484 DoH pass-through: base64url the raw query into a GET (the
 * cache-friendly form; also avoids a CORS preflight) and return the
 * `application/dns-message` response bytes.
 */
export function dohResolve(url: string = DEFAULT_DOH_URL): DnsResolve {
  return async (query: Uint8Array): Promise<Uint8Array> => {
    const response = await fetch(`${url}?dns=${base64url(query)}`, {
      headers: { accept: 'application/dns-message' },
    });
    if (!response.ok) {
      throw new Error(`DoH: ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

export interface DnsHostOptions {
  resolve: DnsResolve;
  ip?: Ipv4;
  mac?: Mac;
  /** Observe resolve failures (already answered with SERVFAIL). */
  onResolveError?: (err: unknown) => void;
  /** Populated from successful answers — the M3d reverse map. */
  cache?: DnsAnswerCache;
}

interface PendingQuery {
  /** Accumulated request bytes — length prefix plus query so far. */
  buffer: Uint8Array;
}

export class DnsHost {
  readonly ip: Ipv4;
  readonly mac: Mac;

  #port: SwitchPort | null = null;
  readonly #resolve: DnsResolve;
  readonly #onResolveError: (err: unknown) => void;
  readonly #cache: DnsAnswerCache | null;
  readonly #tcp: TcpStack;
  /** IP (dotted string) → MAC, learned from ARP traffic. */
  readonly #arpTable = new Map<string, Mac>();
  readonly #pending = new Map<TcpConnection, PendingQuery>();
  #ipId = 1;

  // Counters for tests/diagnostics.
  queriesResolved = 0;
  servfailsSent = 0;
  answersDropped = 0;

  /**
   * Resolves currently in flight. The browser run loop STALLS the
   * machine while this is non-zero: guest virtual time races wall time
   * when the guest idles in HLT (halt spins), so `in_resolv`'s
   * 2-guest-second alarm would otherwise expire in a few tens of wall
   * milliseconds — losing to any cold DoH fetch. Field signature:
   * first lookup of a name fails "Name not found" (the in_resolv
   * stale-buffer quirk, see DNS_DOH_REPORT.md §4.3), immediate retry
   * on a warm connection wins. Pausing the clock is invisible to the
   * guest — its only time sources are the PIT being stalled and INT
   * 1Ah wall time. Superseded properly by the pacing milestone.
   */
  #pendingResolves = 0;

  get pendingResolves(): number {
    return this.#pendingResolves;
  }

  constructor(opts: DnsHostOptions) {
    this.ip = opts.ip ?? DNS_IP;
    this.mac = opts.mac ?? DNS_MAC;
    this.#resolve = opts.resolve;
    this.#onResolveError = opts.onResolveError ?? (() => { /* unobserved */ });
    this.#cache = opts.cache ?? null;
    this.#tcp = new TcpStack({
      localIp: this.ip,
      transmit: (dstIp, segment) => this.#transmitIp(dstIp, segment),
    });
    this.#tcp.listen(DNS_PORT, {
      onConnect: (conn) => {
        this.#pending.set(conn, { buffer: new Uint8Array(0) });
      },
      onData: (conn, data) => this.#onData(conn, data),
      onClosed: (conn) => {
        this.#pending.delete(conn);
      },
    });
  }

  /** Attach to the LAN. One switch per host instance. */
  attachTo(lan: EthernetSwitch): void {
    if (this.#port !== null) {
      throw new Error('DnsHost: already attached');
    }
    this.#port = lan.attach({
      name: 'dns',
      onFrame: (frame) => this.#onFrame(frame),
    });
  }

  detach(): void {
    this.#port?.detach();
    this.#port = null;
  }

  /** The transport engine — exposed for tests/diagnostics. */
  get tcp(): TcpStack {
    return this.#tcp;
  }

  // ============================================================
  // TCP/53: length-prefixed query in, length-prefixed answer out
  // ============================================================

  #onData(conn: TcpConnection, data: Uint8Array): void {
    const pending = this.#pending.get(conn);
    if (pending === undefined) return;

    const buffer = new Uint8Array(pending.buffer.length + data.length);
    buffer.set(pending.buffer, 0);
    buffer.set(data, pending.buffer.length);
    pending.buffer = buffer;

    if (buffer.length < 2) return;
    const queryLen = ((buffer[0] ?? 0) << 8) | (buffer[1] ?? 0);
    if (buffer.length < 2 + queryLen) return; // wait for the rest

    const query = buffer.subarray(2, 2 + queryLen);
    pending.buffer = buffer.subarray(2 + queryLen); // a next query may follow
    void this.#resolveAndAnswer(conn, Uint8Array.from(query));
  }

  async #resolveAndAnswer(conn: TcpConnection, query: Uint8Array): Promise<void> {
    let answer: Uint8Array;
    this.#pendingResolves++;
    try {
      answer = await this.#resolve(query);
      this.queriesResolved++;
      this.#cache?.noteAnswer(answer);
    } catch (err) {
      this.#onResolveError(err);
      answer = servfailFor(query);
      this.servfailsSent++;
    } finally {
      this.#pendingResolves--;
    }
    if (conn.state !== 'established') {
      this.answersDropped++; // guest gave up (its 2s alarm) — nothing to do
      return;
    }
    const framed = new Uint8Array(2 + answer.length);
    framed[0] = (answer.length >> 8) & 0xff;
    framed[1] = answer.length & 0xff;
    framed.set(answer, 2);
    conn.send(framed);
  }

  // ============================================================
  // LAN plumbing: ethernet + ARP + IPv4, same shape as LanGateway
  // ============================================================

  #onFrame(frame: Uint8Array): void {
    if (frame.length < 14) return;
    const ethertype = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
    const payload = frame.subarray(14);
    if (ethertype === ETHERTYPE_ARP) {
      this.#onArp(payload);
      return;
    }
    if (ethertype === ETHERTYPE_IPV4) {
      this.#onIpv4(payload);
    }
  }

  #onArp(payload: Uint8Array): void {
    const arp = parseArp(payload);
    if (arp === null) return;
    this.#arpTable.set(formatIp(arp.senderIp), arp.senderMac);
    if (arp.op === ARP_OP_REQUEST && ipEquals(Uint8Array.from(arp.targetIp), 0, this.ip)) {
      this.#transmitFrame(
        buildEthernetFrame(
          arp.senderMac,
          this.mac,
          ETHERTYPE_ARP,
          buildArp(ARP_OP_REPLY, this.mac, this.ip, arp.senderMac, arp.senderIp),
        ),
      );
    }
  }

  #onIpv4(payload: Uint8Array): void {
    const ip = parseIpv4(payload);
    if (ip === null) return;
    if (!ipEquals(Uint8Array.from(ip.dstIp), 0, this.ip)) return;
    if (ip.protocol !== IPPROTO_TCP) return;
    this.#tcp.onSegment(ip.srcIp, ip.payload);
  }

  #transmitIp(dstIp: Ipv4, segment: Uint8Array): void {
    const mac = this.#arpTable.get(formatIp(dstIp));
    if (mac === undefined) return; // no route back without ARP knowledge
    this.#transmitFrame(
      buildEthernetFrame(
        mac,
        this.mac,
        ETHERTYPE_IPV4,
        buildIpv4(IPPROTO_TCP, this.ip, dstIp, segment, this.#ipId++),
      ),
    );
  }

  #transmitFrame(frame: Uint8Array): void {
    if (this.#port === null) {
      throw new Error('DnsHost: not attached to a switch');
    }
    this.#port.transmit(frame);
  }
}

/**
 * Synthesize a SERVFAIL for `query` without parsing it: copy the
 * message, set QR (response) and RCODE 2, zero the answer counts. The
 * question section rides along verbatim, which is what a real server's
 * SERVFAIL carries anyway. `in_resolv` maps RCODE 2 to ESERVERERR.
 */
export function servfailFor(query: Uint8Array): Uint8Array {
  const r = Uint8Array.from(query);
  if (r.length < 12) return r;
  r[2] = ((r[2] ?? 0) | 0x80) & 0xfb; // QR=1, opcode kept, AA=0
  r[3] = (((r[3] ?? 0) & 0x70) | 0x02) & 0x7f; // RA=0, Z kept, RCODE=2
  r[6] = 0; // ancount
  r[7] = 0;
  r[8] = 0; // nscount
  r[9] = 0;
  r[10] = 0; // arcount
  r[11] = 0;
  return r;
}

/**
 * IP→name reverse map for the M3d HTTP gateway (Phase 15 M1).
 *
 * Every A record in a successful answer maps its address to the
 * *question* name — deliberately not the RR owner name: after a CNAME
 * chain the owner is the canonical host, but the guest dials the name
 * it asked for, and that is the Host header the gateway must
 * reconstruct. Latest answer wins; there is no TTL (the LAN has no
 * clock, and a stale name still beats a dotted IP in a Host header).
 */
export class DnsAnswerCache {
  readonly #byIp = new Map<string, string>();

  /** Read question + A records out of one answer message; bad messages are ignored. */
  noteAnswer(message: Uint8Array): void {
    const parsed = parseAnswerARecords(message);
    if (parsed === null || parsed.question.length === 0) return;
    for (const ip of parsed.addresses) {
      this.#byIp.set(formatIp(ip), parsed.question);
    }
  }

  lookup(ip: Ipv4): string | undefined {
    return this.#byIp.get(formatIp(ip));
  }

  get size(): number {
    return this.#byIp.size;
  }
}

export interface ParsedAnswerARecords {
  /** First question name, lowercased, dot-joined. */
  question: string;
  /** Every A-record address in the answer section, in order. */
  addresses: Ipv4[];
}

/**
 * Minimal RFC 1035 reader for {@link DnsAnswerCache}: first question
 * name plus the answer-section A records (type 1, class IN). Anything
 * else (AAAA, CNAME, authority/additional sections) is skipped, not
 * an error. Returns null only for messages too malformed to walk.
 */
export function parseAnswerARecords(message: Uint8Array): ParsedAnswerARecords | null {
  if (message.length < 12) return null;
  const qdcount = ((message[4] ?? 0) << 8) | (message[5] ?? 0);
  const ancount = ((message[6] ?? 0) << 8) | (message[7] ?? 0);

  let offset = 12;
  let question = '';
  for (let q = 0; q < qdcount; q++) {
    const name = readDnsName(message, offset);
    if (name === null) return null;
    if (q === 0) question = name.name;
    offset = name.next + 4; // qtype + qclass
    if (offset > message.length) return null;
  }

  const addresses: Ipv4[] = [];
  for (let a = 0; a < ancount; a++) {
    const name = readDnsName(message, offset);
    if (name === null) return null;
    offset = name.next;
    if (offset + 10 > message.length) return null;
    const type = ((message[offset] ?? 0) << 8) | (message[offset + 1] ?? 0);
    const klass = ((message[offset + 2] ?? 0) << 8) | (message[offset + 3] ?? 0);
    const rdlength = ((message[offset + 8] ?? 0) << 8) | (message[offset + 9] ?? 0);
    const rdata = offset + 10;
    if (rdata + rdlength > message.length) return null;
    if (type === 1 && klass === 1 && rdlength === 4) {
      addresses.push([
        message[rdata] ?? 0,
        message[rdata + 1] ?? 0,
        message[rdata + 2] ?? 0,
        message[rdata + 3] ?? 0,
      ]);
    }
    offset = rdata + rdlength;
  }
  return { question, addresses };
}

/**
 * Read one possibly-compressed domain name (RFC 1035 §4.1.4). `next`
 * is the offset after the name *in the original stream* — after the
 * first pointer for compressed names. Null on truncation, a reserved
 * label type, or a pointer loop.
 */
function readDnsName(message: Uint8Array, offset: number): { name: string; next: number } | null {
  const parts: string[] = [];
  let o = offset;
  let next = -1; // fixed at the first pointer jump
  let jumps = 0;
  for (;;) {
    const len = message[o];
    if (len === undefined) return null;
    if (len === 0) {
      o += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const lo = message[o + 1];
      if (lo === undefined) return null;
      if (next < 0) next = o + 2;
      o = ((len & 0x3f) << 8) | lo;
      if (++jumps > 32) return null; // pointer loop
      continue;
    }
    if ((len & 0xc0) !== 0) return null; // 01/10 label types are reserved
    const end = o + 1 + len;
    if (end > message.length) return null;
    let label = '';
    for (let i = o + 1; i < end; i++) {
      label += String.fromCharCode(message[i] ?? 0);
    }
    parts.push(label.toLowerCase());
    o = end;
    if (parts.length > 128) return null;
  }
  return { name: parts.join('.'), next: next >= 0 ? next : o };
}

/** RFC 4648 §5 base64url (no padding) over raw bytes — RFC 8484's dns= form. */
export function base64url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet.charAt(b0 >> 2);
    out += alphabet.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    if (b1 === undefined) break;
    out += alphabet.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    if (b2 === undefined) break;
    out += alphabet.charAt(b2 & 0x3f);
  }
  return out;
}
