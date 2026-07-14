/**
 * HttpGatewayHost unit tests (Phase 15 M1 — M3d).
 *
 * A scripted guest peer sits on a real EthernetSwitch and speaks what
 * ktcp would after `route add default gw 10.0.2.2`: ARP for the
 * gateway, then TCP to *off-subnet* destinations through the gateway
 * MAC. The LanGateway hands routed TCP to the HttpGatewayHost, whose
 * fetch is a fixture (no network). Assertions cover both directions:
 * the URL/headers the fixture sees, and the byte-level HTTP response
 * the guest reads back.
 */

import { describe, it, expect } from 'vitest';
import { EthernetSwitch, type SwitchPort } from '../../src/net/switch.js';
import { GATEWAY_MAC, LanGateway } from '../../src/net/gateway.js';
import {
  HttpGatewayHost,
  tryParseRequest,
  type FetchedResponse,
  type GatewayFetchRequest,
} from '../../src/net/http.js';
import { DnsAnswerCache } from '../../src/net/dns.js';
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  IPPROTO_TCP,
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_RST,
  TCP_SYN,
  buildArp,
  buildEthernetFrame,
  buildIpv4,
  buildTcpSegment,
  formatIp,
  parseIpv4,
  parseTcpSegment,
  type Ipv4,
  type Mac,
  type TcpSegment,
} from '../../src/net/wire.js';

const GUEST_IP: Ipv4 = [10, 0, 2, 15];
const GUEST_MAC: Mac = [0x02, 0x65, 0x6d, 0x75, 0x38, 0x36];
const WEB_IP: Ipv4 = [93, 184, 216, 34];

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0xff));
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/** Scripted guest: hand-rolled TCP client routing everything via the gateway MAC. */
class GuestPeer {
  readonly port: SwitchPort;
  readonly frames: Uint8Array[] = [];
  seq = 100;
  ack = 0;
  srcPort = 2048;
  #ipId = 0x40;

  constructor(lan: EthernetSwitch) {
    this.port = lan.attach({
      name: 'guest',
      onFrame: (frame) => this.frames.push(Uint8Array.from(frame)),
    });
  }

  /** Gratuitous ARP-ish hello so the gateway learns our MAC (ktcp does this at net start). */
  announce(): void {
    this.port.transmit(
      buildEthernetFrame(
        [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        GUEST_MAC,
        ETHERTYPE_ARP,
        buildArp(ARP_OP_REQUEST, GUEST_MAC, GUEST_IP, [0, 0, 0, 0, 0, 0], [10, 0, 2, 2]),
      ),
    );
    this.frames.length = 0; // discard the gateway's ARP reply
  }

  sendTcp(dstIp: Ipv4, dstPort: number, flags: number, payload: Uint8Array = new Uint8Array(0)): void {
    this.port.transmit(
      buildEthernetFrame(
        GATEWAY_MAC, // routed: off-subnet traffic goes to the gateway MAC
        GUEST_MAC,
        ETHERTYPE_IPV4,
        buildIpv4(
          IPPROTO_TCP,
          GUEST_IP,
          dstIp,
          buildTcpSegment(GUEST_IP, dstIp, {
            srcPort: this.srcPort,
            dstPort,
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

  /** Pop queued TCP segments; asserts each one's IP source is `fromIp`. */
  takeTcp(fromIp: Ipv4): TcpSegment[] {
    const out: TcpSegment[] = [];
    for (const frame of this.frames.splice(0, this.frames.length)) {
      const etype = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
      if (etype !== ETHERTYPE_IPV4) continue;
      const ip = parseIpv4(frame.subarray(14));
      if (ip === null || ip.protocol !== IPPROTO_TCP) continue;
      expect(formatIp(ip.srcIp)).toBe(formatIp(fromIp)); // replies speak as the dialed IP
      const seg = parseTcpSegment(ip.srcIp, ip.dstIp, ip.payload);
      expect(seg).not.toBeNull();
      if (seg !== null) out.push(seg);
    }
    return out;
  }

  /** Handshake with an off-subnet destination through the gateway. */
  connect(dstIp: Ipv4, dstPort: number): void {
    this.sendTcp(dstIp, dstPort, TCP_SYN);
    const [synAck] = this.takeTcp(dstIp);
    expect(synAck?.flags).toBe(TCP_SYN | TCP_ACK);
    expect(synAck?.ack).toBe(this.seq);
    this.ack = ((synAck?.seq ?? 0) + 1) >>> 0;
    this.sendTcp(dstIp, dstPort, TCP_ACK);
    expect(this.takeTcp(dstIp)).toHaveLength(0);
  }

  /**
   * Read a full response: collect data segments (ACKing the FIN when
   * it arrives), reassemble the payload in order, and retire the
   * connection with our own FIN.
   */
  readResponseAndClose(dstIp: Ipv4, dstPort: number): Uint8Array {
    const segs = this.takeTcp(dstIp);
    let body = new Uint8Array(0);
    let sawFin = false;
    for (const seg of segs) {
      if (seg.payload.length > 0) {
        const grown = new Uint8Array(body.length + seg.payload.length);
        grown.set(body, 0);
        grown.set(seg.payload, body.length);
        body = grown;
        this.ack = (seg.seq + seg.payload.length) >>> 0;
      }
      if ((seg.flags & TCP_FIN) !== 0) {
        sawFin = true;
        this.ack = (seg.seq + seg.payload.length + 1) >>> 0;
      }
    }
    expect(sawFin).toBe(true); // Connection: close semantics — the host FINs
    this.sendTcp(dstIp, dstPort, TCP_FIN | TCP_ACK);
    this.takeTcp(dstIp); // final ACK of our FIN
    return body;
  }
}

interface Rig {
  lan: EthernetSwitch;
  gateway: LanGateway;
  host: HttpGatewayHost;
  peer: GuestPeer;
  requests: GatewayFetchRequest[];
}

function makeRig(opts: {
  response?: FetchedResponse | ((req: GatewayFetchRequest) => FetchedResponse);
  reject?: unknown;
  cache?: DnsAnswerCache;
  dnsResolve?: (query: Uint8Array) => Promise<Uint8Array>;
}): Rig {
  const lan = new EthernetSwitch();
  const gateway = new LanGateway();
  gateway.attachTo(lan);
  const requests: GatewayFetchRequest[] = [];
  const host = new HttpGatewayHost({
    fetchFn: (req) => {
      requests.push(req);
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      const r = opts.response ?? {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/plain']],
        body: latin1Bytes('ok\n'),
      };
      return Promise.resolve(typeof r === 'function' ? r(req) : r);
    },
    ...(opts.cache ? { reverseLookup: (ip: Ipv4) => opts.cache?.lookup(ip) } : {}),
    ...(opts.dnsResolve ? { dnsResolve: opts.dnsResolve } : {}),
  });
  host.attachTo(gateway);
  const peer = new GuestPeer(lan);
  peer.announce();
  return { lan, gateway, host, peer, requests };
}

describe('HttpGatewayHost — request path', () => {
  it('terminates off-subnet TCP, reconstructs the URL from Host, and answers as HTTP/1.0', async () => {
    const rig = makeRig({
      response: {
        status: 200,
        statusText: '', // HTTP/2 origins report no reason phrase
        headers: [
          ['content-type', 'text/html'],
          ['content-encoding', 'gzip'], // must be stripped: fetch already decoded
          ['transfer-encoding', 'chunked'], // ditto
        ],
        body: latin1Bytes('<html>hello</html>'),
      },
    });
    rig.peer.connect(WEB_IP, 80);
    rig.peer.sendTcp(
      WEB_IP,
      80,
      TCP_PSH | TCP_ACK,
      latin1Bytes('GET /index.html HTTP/1.0\r\nHost: example.com\r\nUser-Agent: urlget\r\n\r\n'),
    );
    expect(rig.peer.takeTcp(WEB_IP)[0]?.flags).toBe(TCP_ACK); // request ACKed synchronously
    await flush();

    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0]?.url).toBe('http://example.com/index.html');
    expect(rig.requests[0]?.method).toBe('GET');
    const names = rig.requests[0]?.headers.map(([n]) => n.toLowerCase()) ?? [];
    expect(names).toContain('user-agent');
    expect(names).not.toContain('host'); // hop-by-hop, fetch owns it

    const response = latin1(rig.peer.readResponseAndClose(WEB_IP, 80));
    expect(response).toMatch(/^HTTP\/1\.0 200 OK\r\n/); // reason refilled from the table
    expect(response).toContain('content-type: text/html\r\n');
    expect(response).not.toMatch(/content-encoding/i);
    expect(response).not.toMatch(/transfer-encoding/i);
    expect(response).toContain(`Content-Length: 18\r\n`);
    expect(response).toContain('Connection: close\r\n');
    expect(response.endsWith('\r\n\r\n<html>hello</html>')).toBe(true);
    expect(rig.host.requestsServed).toBe(1);
    expect(rig.host.tcp.connectionCount).toBe(0);
    expect(rig.gateway.tcpForwarded).toBeGreaterThan(0);
  });

  it('falls back to the DNS reverse map, then the dotted IP, for Host-less requests', async () => {
    const cache = new DnsAnswerCache();
    // Simulate the resolver having answered example.com → WEB_IP.
    cache.noteAnswer(
      Uint8Array.from([
        0, 1, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0,
        7, ...[...'example'].map((c) => c.charCodeAt(0)), 3, ...[...'com'].map((c) => c.charCodeAt(0)), 0,
        0, 1, 0, 1,
        0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0x0e, 0x10, 0, 4, 93, 184, 216, 34,
      ]),
    );
    const rig = makeRig({ cache });
    rig.peer.connect(WEB_IP, 80);
    rig.peer.sendTcp(WEB_IP, 80, TCP_PSH | TCP_ACK, latin1Bytes('GET / HTTP/1.0\r\n\r\n'));
    await flush();
    expect(rig.requests[0]?.url).toBe('http://example.com/');

    // A destination the resolver never answered: dotted IP.
    rig.peer.frames.length = 0; // discard connection 1's unread response
    rig.peer.srcPort = 2049;
    rig.peer.seq = 500;
    rig.peer.connect([1, 2, 3, 4], 8080);
    rig.peer.sendTcp([1, 2, 3, 4], 8080, TCP_PSH | TCP_ACK, latin1Bytes('GET /x HTTP/1.0\r\n\r\n'));
    await flush();
    expect(rig.requests[1]?.url).toBe('http://1.2.3.4:8080/x');
  });

  it('forwards POST bodies per Content-Length', async () => {
    const rig = makeRig({});
    rig.peer.connect(WEB_IP, 80);
    rig.peer.sendTcp(
      WEB_IP,
      80,
      TCP_PSH | TCP_ACK,
      latin1Bytes('POST /submit HTTP/1.0\r\nHost: example.com\r\nContent-Length: 5\r\n\r\nhello'),
    );
    await flush();
    expect(rig.requests[0]?.method).toBe('POST');
    expect(latin1(rig.requests[0]?.body ?? new Uint8Array(0))).toBe('hello');
  });

  it('answers 502 when the fetch rejects', async () => {
    const rig = makeRig({ reject: new Error('TypeError: Failed to fetch') });
    rig.peer.connect(WEB_IP, 80);
    rig.peer.sendTcp(WEB_IP, 80, TCP_PSH | TCP_ACK, latin1Bytes('GET / HTTP/1.0\r\nHost: a.b\r\n\r\n'));
    await flush();
    const response = latin1(rig.peer.readResponseAndClose(WEB_IP, 80));
    expect(response).toMatch(/^HTTP\/1\.0 502 Bad Gateway\r\n/);
    expect(response).toContain('emu86 gateway:');
    expect(rig.host.fetchErrors).toBe(1);
  });

  it('answers 400 to a malformed request without calling fetch', async () => {
    const rig = makeRig({});
    rig.peer.connect(WEB_IP, 80);
    rig.peer.sendTcp(WEB_IP, 80, TCP_PSH | TCP_ACK, latin1Bytes('SSH-2.0-OpenSSH\r\n\r\n'));
    await flush();
    const response = latin1(rig.peer.readResponseAndClose(WEB_IP, 80));
    expect(response).toMatch(/^HTTP\/1\.0 400 Bad Request\r\n/);
    expect(rig.requests).toHaveLength(0);
    expect(rig.host.badRequests).toBe(1);
  });

  it('delivers the response to a client that FINs right after the request (half-close)', async () => {
    const rig = makeRig({});
    rig.peer.connect(WEB_IP, 80);
    rig.peer.sendTcp(WEB_IP, 80, TCP_PSH | TCP_ACK, latin1Bytes('GET / HTTP/1.0\r\nHost: a.b\r\n\r\n'));
    rig.peer.sendTcp(WEB_IP, 80, TCP_FIN | TCP_ACK); // write-then-shutdown client
    rig.peer.takeTcp(WEB_IP); // request ACK + FIN ACK
    await flush();

    const segs = rig.peer.takeTcp(WEB_IP);
    const body = segs.filter((s) => s.payload.length > 0);
    expect(body.length).toBeGreaterThan(0);
    expect(latin1(body[0]?.payload ?? new Uint8Array(0))).toMatch(/^HTTP\/1\.0 200/);
    const fin = segs.find((s) => (s.flags & TCP_FIN) !== 0);
    expect(fin).toBeDefined();
    // Final ACK retires it.
    const last = segs[segs.length - 1];
    rig.peer.ack = ((last?.seq ?? 0) + (last?.payload.length ?? 0) + 1) >>> 0;
    rig.peer.sendTcp(WEB_IP, 80, TCP_ACK);
    expect(rig.host.tcp.connectionCount).toBe(0);
  });

  it(':443 is the https bridge — plain HTTP in, https URL out (the wrapper trick)', async () => {
    const rig = makeRig({});
    rig.peer.connect(WEB_IP, 443);
    rig.peer.sendTcp(
      WEB_IP,
      443,
      TCP_PSH | TCP_ACK,
      latin1Bytes('GET /secret HTTP/1.0\r\nHost: example.com\r\n\r\n'),
    );
    await flush();
    expect(rig.requests[0]?.url).toBe('https://example.com/secret');
    const response = latin1(rig.peer.readResponseAndClose(WEB_IP, 443));
    expect(response).toMatch(/^HTTP\/1\.0 200/);
  });

  it(':443 strips a :443 suffix from the Host authority (default port of the real scheme)', async () => {
    const rig = makeRig({});
    rig.peer.connect(WEB_IP, 443);
    rig.peer.sendTcp(
      WEB_IP,
      443,
      TCP_PSH | TCP_ACK,
      latin1Bytes('GET / HTTP/1.0\r\nHost: example.com:443\r\n\r\n'),
    );
    await flush();
    expect(rig.requests[0]?.url).toBe('https://example.com/');
  });

  it('a custom acceptPort predicate still refuses with an RST', () => {
    const lan = new EthernetSwitch();
    const gateway = new LanGateway();
    gateway.attachTo(lan);
    const host = new HttpGatewayHost({
      fetchFn: () => Promise.reject(new Error('unused')),
      acceptPort: (port) => port === 80,
    });
    host.attachTo(gateway);
    const peer = new GuestPeer(lan);
    peer.announce();
    peer.sendTcp(WEB_IP, 25, TCP_SYN);
    const [rst] = peer.takeTcp(WEB_IP);
    expect(rst).toBeDefined();
    expect((rst?.flags ?? 0) & TCP_RST).toBe(TCP_RST);
    expect(host.tcp.connectionCount).toBe(0);
  });
});

describe('HttpGatewayHost — :53 DNS-over-TCP (OpenDNS default path)', () => {
  it('length-prefixed pass-through, same shape as DnsHost', async () => {
    const query = Uint8Array.from([0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 97, 0, 0, 1, 0, 1]);
    const answer = Uint8Array.from([0xab, 0xcd, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0]);
    const seen: Uint8Array[] = [];
    const rig = makeRig({
      dnsResolve: (q) => {
        seen.push(q);
        return Promise.resolve(answer);
      },
    });
    const OPENDNS: Ipv4 = [208, 67, 222, 222];
    rig.peer.connect(OPENDNS, 53);
    const framed = new Uint8Array(2 + query.length);
    framed[0] = 0;
    framed[1] = query.length;
    framed.set(query, 2);
    rig.peer.sendTcp(OPENDNS, 53, TCP_PSH | TCP_ACK, framed);
    expect(rig.peer.takeTcp(OPENDNS)[0]?.flags).toBe(TCP_ACK);
    await flush();

    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0] ?? [])).toEqual(Array.from(query));
    const [answerSeg] = rig.peer.takeTcp(OPENDNS);
    expect(answerSeg?.flags).toBe(TCP_PSH | TCP_ACK);
    expect(Array.from(answerSeg?.payload ?? [])).toEqual([0, answer.length, ...answer]);
    expect(rig.host.dnsQueriesResolved).toBe(1);
  });
});

describe('realGatewayFetch — the origin-conditional https upgrade', () => {
  async function urlsFetched(
    opts: { upgradeToHttps?: boolean },
    urls: readonly string[],
  ): Promise<string[]> {
    const { realGatewayFetch } = await import('../../src/net/http.js');
    const seen: string[] = [];
    const stub = (input: string | URL | Request): Promise<Response> => {
      seen.push(String(input));
      return Promise.resolve(new Response(new Uint8Array(0), { status: 200 }));
    };
    const original = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const gw = realGatewayFetch(opts);
      for (const url of urls) {
        await gw({ url, method: 'GET', headers: [], body: null });
      }
    } finally {
      globalThis.fetch = original;
    }
    return seen;
  }

  it('on an https origin, upgrades EVERY http URL — explicit ports included', async () => {
    // Mixed content hard-blocks plain http from a secure page (the
    // request never leaves the tab), so leaving the scheme alone
    // guarantees failure. The :81 field block is the ported case.
    const seen = await urlsFetched({ upgradeToHttps: true }, [
      'http://example.com/a',
      'http://1.2.3.4:8080/b',
      'https://example.com/c', // the :443 bridge's output passes through
    ]);
    expect(seen).toEqual([
      'https://example.com/a',
      'https://1.2.3.4:8080/b',
      'https://example.com/c',
    ]);
  });

  it('on an http origin (localhost dev), leaves http alone — captive portals stay honest', async () => {
    // captive.apple.com is plain-http BY DESIGN: a captive portal
    // intercepts http, not https, so upgrading defeats the endpoint.
    // No mixed-content rule applies on an http page, so don't.
    const seen = await urlsFetched({ upgradeToHttps: false }, [
      'http://captive.apple.com/',
      'http://example.com:81/x',
    ]);
    expect(seen).toEqual(['http://captive.apple.com/', 'http://example.com:81/x']);
  });
});

describe('HTTP request parsing', () => {
  it('waits for complete headers, then a complete body', () => {
    expect(tryParseRequest(latin1Bytes('GET / HT'))).toBe('incomplete');
    expect(tryParseRequest(latin1Bytes('POST / HTTP/1.0\r\nContent-Length: 4\r\n\r\nab'))).toBe(
      'incomplete',
    );
    const done = tryParseRequest(latin1Bytes('POST / HTTP/1.0\r\nContent-Length: 4\r\n\r\nabcd'));
    expect(done).not.toBe('incomplete');
    expect(done).not.toBe('bad');
    if (done !== 'incomplete' && done !== 'bad') {
      expect(latin1(done.body)).toBe('abcd');
    }
  });

  it('rejects non-HTTP preambles definitively', () => {
    expect(tryParseRequest(latin1Bytes('\x16\x03\x01\x02\x00garbage\r\n\r\n'))).toBe('bad');
    expect(tryParseRequest(latin1Bytes('GET /\r\n\r\n'))).toBe('bad'); // HTTP/0.9 unsupported
  });
});
