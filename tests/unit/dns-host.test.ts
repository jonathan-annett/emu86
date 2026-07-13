/**
 * DnsHost unit tests (Phase 14 M3c).
 *
 * A scripted guest peer sits on a real EthernetSwitch and speaks what
 * ktcp + `in_resolv()` would: ARP for 10.0.2.3, TCP connect to :53,
 * a length-prefixed DNS query, then close. The resolver is a fixture
 * (no network) — its answer must come back length-prefixed and
 * byte-exact. Async boundary: the resolve promise settles on the
 * microtask queue, so tests flush with a macrotask before asserting.
 */

import { describe, it, expect } from 'vitest';
import { EthernetSwitch, type SwitchPort } from '../../src/net/switch.js';
import {
  DNS_IP,
  DNS_MAC,
  DnsHost,
  base64url,
  servfailFor,
} from '../../src/net/dns.js';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  IPPROTO_TCP,
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_SYN,
  buildArp,
  buildEthernetFrame,
  buildIpv4,
  buildTcpSegment,
  parseArp,
  parseIpv4,
  parseTcpSegment,
  type Ipv4,
  type Mac,
  type TcpSegment,
} from '../../src/net/wire.js';

const GUEST_IP: Ipv4 = [10, 0, 2, 15];
const GUEST_MAC: Mac = [0x02, 0x65, 0x6d, 0x75, 0x38, 0x36];
const GUEST_PORT = 2048;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Minimal in_resolv-shaped DNS query: header + QNAME + qtype/qclass. */
function buildQuery(id: number, name: string): Uint8Array {
  const labels: number[] = [];
  for (const part of name.split('.')) {
    labels.push(part.length);
    for (const ch of part) labels.push(ch.charCodeAt(0));
  }
  labels.push(0);
  return Uint8Array.from([
    (id >> 8) & 0xff, id & 0xff,
    0x01, 0x00, // RD
    0x00, 0x01, // qdcount 1
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...labels,
    0x00, 0x01, // qtype A
    0x00, 0x01, // qclass IN
  ]);
}

/** Response fixture: question echoed, one A answer, in_resolv-compatible. */
function buildAnswer(query: Uint8Array, ip: Ipv4): Uint8Array {
  const r = new Uint8Array(query.length + 16);
  r.set(query, 0);
  r[2] = 0x81; // QR, RD
  r[3] = 0x80; // RA, RCODE 0
  r[7] = 0x01; // ancount 1
  let o = query.length;
  r[o++] = 0xc0; r[o++] = 0x0c; // name pointer to the question
  r[o++] = 0x00; r[o++] = 0x01; // type A
  r[o++] = 0x00; r[o++] = 0x01; // class IN
  r[o++] = 0x00; r[o++] = 0x00; r[o++] = 0x0e; r[o++] = 0x10; // TTL 3600
  r[o++] = 0x00; r[o++] = 0x04; // rdlength
  r[o++] = ip[0] ?? 0; r[o++] = ip[1] ?? 0; r[o++] = ip[2] ?? 0; r[o++] = ip[3] ?? 0;
  return r;
}

function withPrefix(message: Uint8Array): Uint8Array {
  const framed = new Uint8Array(2 + message.length);
  framed[0] = (message.length >> 8) & 0xff;
  framed[1] = message.length & 0xff;
  framed.set(message, 2);
  return framed;
}

/** The scripted guest: owns a switch port and a hand-rolled TCP client. */
class GuestPeer {
  readonly port: SwitchPort;
  readonly frames: Uint8Array[] = [];
  seq = 100;
  ack = 0;
  #ipId = 0x40;

  constructor(lan: EthernetSwitch) {
    this.port = lan.attach({
      name: 'guest',
      onFrame: (frame) => this.frames.push(Uint8Array.from(frame)),
    });
  }

  /** ARP who-has for the DNS host; returns the parsed reply. */
  arpResolve(): ReturnType<typeof parseArp> {
    this.port.transmit(
      buildEthernetFrame(
        [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        GUEST_MAC,
        ETHERTYPE_ARP,
        buildArp(ARP_OP_REQUEST, GUEST_MAC, GUEST_IP, [0, 0, 0, 0, 0, 0], DNS_IP),
      ),
    );
    const frame = this.frames.shift();
    expect(frame).toBeDefined();
    if (frame === undefined) return null;
    const etype = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
    expect(etype).toBe(ETHERTYPE_ARP);
    return parseArp(frame.subarray(14));
  }

  sendTcp(flags: number, payload: Uint8Array = new Uint8Array(0)): void {
    this.port.transmit(
      buildEthernetFrame(
        DNS_MAC,
        GUEST_MAC,
        ETHERTYPE_IPV4,
        buildIpv4(
          IPPROTO_TCP,
          GUEST_IP,
          DNS_IP,
          buildTcpSegment(GUEST_IP, DNS_IP, {
            srcPort: GUEST_PORT,
            dstPort: 53,
            seq: this.seq,
            ack: this.ack,
            flags,
            window: 4380,
            payload,
          }),
          this.#ipId++,
        ),
      ),
    );
    this.seq = (this.seq + payload.length + ((flags & (TCP_SYN | TCP_FIN)) !== 0 ? 1 : 0)) >>> 0;
  }

  /** Pop every queued TCP segment addressed to the guest. */
  takeTcp(): TcpSegment[] {
    const out: TcpSegment[] = [];
    for (const frame of this.frames.splice(0, this.frames.length)) {
      const etype = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
      if (etype !== ETHERTYPE_IPV4) continue;
      const ip = parseIpv4(frame.subarray(14));
      if (ip === null || ip.protocol !== IPPROTO_TCP) continue;
      const seg = parseTcpSegment(ip.srcIp, ip.dstIp, ip.payload);
      expect(seg).not.toBeNull();
      if (seg !== null) out.push(seg);
    }
    return out;
  }

  /** ARP + three-way handshake; leaves seq/ack tracking established. */
  connect(): void {
    this.arpResolve();
    this.sendTcp(TCP_SYN);
    const [synAck] = this.takeTcp();
    expect(synAck?.flags).toBe(TCP_SYN | TCP_ACK);
    expect(synAck?.ack).toBe(this.seq);
    this.ack = ((synAck?.seq ?? 0) + 1) >>> 0;
    this.sendTcp(TCP_ACK);
    expect(this.takeTcp()).toHaveLength(0);
  }
}

describe('DnsHost — LAN behavior', () => {
  it('answers ARP for its own IP', () => {
    const lan = new EthernetSwitch();
    const dns = new DnsHost({ resolve: () => Promise.reject(new Error('unused')) });
    dns.attachTo(lan);
    const peer = new GuestPeer(lan);
    const reply = peer.arpResolve();
    expect(reply?.op).toBe(ARP_OP_REPLY);
    expect(reply?.senderMac).toEqual(Array.from(DNS_MAC));
    expect(reply?.senderIp).toEqual(Array.from(DNS_IP));
  });

  it('resolves a length-prefixed query and answers byte-exactly', async () => {
    const lan = new EthernetSwitch();
    const query = buildQuery(0xabcd, 'example.com');
    const answer = buildAnswer(query, [93, 184, 216, 34]);
    const seen: Uint8Array[] = [];
    const dns = new DnsHost({
      resolve: (q) => {
        seen.push(q);
        return Promise.resolve(answer);
      },
    });
    dns.attachTo(lan);
    const peer = new GuestPeer(lan);
    peer.connect();

    peer.sendTcp(TCP_PSH | TCP_ACK, withPrefix(query));
    const [ackSeg] = peer.takeTcp();
    expect(ackSeg?.flags).toBe(TCP_ACK); // query ACKed synchronously
    await flush();

    // The guest's own query reached the resolver, prefix stripped.
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0] ?? [])).toEqual(Array.from(query));

    const [answerSeg] = peer.takeTcp();
    expect(answerSeg?.flags).toBe(TCP_PSH | TCP_ACK);
    expect(Array.from(answerSeg?.payload ?? [])).toEqual(Array.from(withPrefix(answer)));
    expect(dns.queriesResolved).toBe(1);

    // Guest ACKs the data, then closes — in_resolv's read-then-close.
    peer.ack = ((answerSeg?.seq ?? 0) + (answerSeg?.payload.length ?? 0)) >>> 0;
    peer.sendTcp(TCP_ACK);
    peer.sendTcp(TCP_FIN | TCP_ACK);
    const [finAck] = peer.takeTcp();
    expect(finAck?.flags).toBe(TCP_FIN | TCP_ACK);
    peer.ack = ((finAck?.seq ?? 0) + 1) >>> 0;
    peer.sendTcp(TCP_ACK);
    expect(dns.tcp.connectionCount).toBe(0);
  });

  it('reassembles a query split across TCP segments (prefix split too)', async () => {
    const lan = new EthernetSwitch();
    const query = buildQuery(0x1111, 'elks.dev');
    const answer = buildAnswer(query, [1, 2, 3, 4]);
    const dns = new DnsHost({ resolve: () => Promise.resolve(answer) });
    dns.attachTo(lan);
    const peer = new GuestPeer(lan);
    peer.connect();

    const framed = withPrefix(query);
    peer.sendTcp(TCP_PSH | TCP_ACK, framed.subarray(0, 1)); // half the prefix
    peer.takeTcp();
    peer.sendTcp(TCP_PSH | TCP_ACK, framed.subarray(1, 5));
    peer.takeTcp();
    peer.sendTcp(TCP_PSH | TCP_ACK, framed.subarray(5));
    peer.takeTcp();
    await flush();

    const [answerSeg] = peer.takeTcp();
    expect(Array.from(answerSeg?.payload ?? [])).toEqual(Array.from(withPrefix(answer)));
  });

  it('synthesizes SERVFAIL when the resolver rejects', async () => {
    const lan = new EthernetSwitch();
    const query = buildQuery(0xabcd, 'example.com');
    const errors: unknown[] = [];
    const dns = new DnsHost({
      resolve: () => Promise.reject(new Error('DoH: 502')),
      onResolveError: (e) => errors.push(e),
    });
    dns.attachTo(lan);
    const peer = new GuestPeer(lan);
    peer.connect();

    peer.sendTcp(TCP_PSH | TCP_ACK, withPrefix(query));
    peer.takeTcp();
    await flush();

    const [answerSeg] = peer.takeTcp();
    const payload = answerSeg?.payload ?? new Uint8Array(0);
    const message = payload.subarray(2);
    expect((message[2] ?? 0) & 0x80).toBe(0x80); // QR: response
    expect((message[3] ?? 0) & 0x0f).toBe(0x02); // RCODE: SERVFAIL
    expect(message[6]).toBe(0); // ancount 0
    expect(message[7]).toBe(0);
    expect(dns.servfailsSent).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('drops a late answer when the guest already closed (2s alarm shape)', async () => {
    const lan = new EthernetSwitch();
    const query = buildQuery(0x2222, 'slow.example');
    const releaseBox: Array<(answer: Uint8Array) => void> = [];
    const dns = new DnsHost({
      resolve: () => new Promise((resolve) => { releaseBox.push(resolve); }),
    });
    dns.attachTo(lan);
    const peer = new GuestPeer(lan);
    peer.connect();

    peer.sendTcp(TCP_PSH | TCP_ACK, withPrefix(query));
    peer.takeTcp();
    // Guest times out and closes before the resolver answers.
    peer.sendTcp(TCP_FIN | TCP_ACK);
    const [finAck] = peer.takeTcp();
    peer.ack = ((finAck?.seq ?? 0) + 1) >>> 0;
    peer.sendTcp(TCP_ACK);
    expect(dns.tcp.connectionCount).toBe(0);

    releaseBox[0]?.(buildAnswer(query, [9, 9, 9, 9]));
    await flush();
    expect(peer.takeTcp()).toHaveLength(0); // nothing transmitted
    expect(dns.answersDropped).toBe(1);
  });
});

describe('DNS helpers', () => {
  it('base64url matches RFC 4648 vectors, unpadded', () => {
    const enc = (s: string): string =>
      base64url(Uint8Array.from([...s].map((c) => c.charCodeAt(0))));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg');
    expect(enc('fo')).toBe('Zm8');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foob')).toBe('Zm9vYg');
    expect(enc('fooba')).toBe('Zm9vYmE');
    expect(enc('foobar')).toBe('Zm9vYmFy');
    // URL-safe alphabet: 0xfb 0xff → '-_8' (plain base64 says '+/8=').
    expect(base64url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
  });

  it('servfailFor flips QR and RCODE, zeroes the counts, keeps the ID', () => {
    const query = buildQuery(0xbeef, 'x.y');
    const fail = servfailFor(query);
    expect(fail[0]).toBe(0xbe);
    expect(fail[1]).toBe(0xef);
    expect((fail[2] ?? 0) & 0x80).toBe(0x80);
    expect((fail[3] ?? 0) & 0x0f).toBe(0x02);
    expect(fail[4]).toBe(query[4]); // qdcount untouched
    expect(fail[6]).toBe(0);
    expect(fail.length).toBe(query.length);
  });
});
