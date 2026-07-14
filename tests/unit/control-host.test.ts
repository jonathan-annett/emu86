/**
 * ControlHost unit tests (substrate API v1 — Phase 15 post-close
 * addendum F).
 *
 * A scripted guest speaks what ktcp + `urlget` would: ARP for
 * 10.0.2.2, TCP connect to :80, `GET /?action HTTP/1.0`, read the
 * plain-text answer. The actions are fixtures; `mkdrive` settles on
 * the microtask queue like the real main-thread round trip, so those
 * tests flush with a macrotask before asserting — the DNS host tests'
 * pattern, client and all.
 */

import { describe, it, expect } from 'vitest';
import { EthernetSwitch, type SwitchPort } from '../../src/net/switch.js';
import { LanGateway, GATEWAY_IP, GATEWAY_MAC } from '../../src/net/gateway.js';
import { ControlHost, type ControlActions } from '../../src/net/control.js';
import {
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
  parseIpv4,
  parseTcpSegment,
  type Ipv4,
  type Mac,
  type TcpSegment,
} from '../../src/net/wire.js';

const GUEST_IP: Ipv4 = [10, 0, 2, 16];
const GUEST_MAC: Mac = [0x02, 0x65, 0x6d, 0x75, 0x38, 16];
const GUEST_PORT = 3000;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The scripted guest: hand-rolled TCP client dialing the gateway :80. */
class GuestPeer {
  readonly port: SwitchPort;
  readonly frames: Uint8Array[] = [];
  seq = 500;
  ack = 0;
  #ipId = 0x70;

  constructor(lan: EthernetSwitch) {
    this.port = lan.attach({
      name: 'guest',
      onFrame: (frame) => this.frames.push(Uint8Array.from(frame)),
    });
  }

  arp(): void {
    this.port.transmit(
      buildEthernetFrame(
        [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        GUEST_MAC,
        ETHERTYPE_ARP,
        buildArp(ARP_OP_REQUEST, GUEST_MAC, GUEST_IP, [0, 0, 0, 0, 0, 0], GATEWAY_IP),
      ),
    );
    this.frames.shift(); // the gateway's ARP reply
  }

  sendTcp(flags: number, payload: Uint8Array = new Uint8Array(0)): void {
    this.port.transmit(
      buildEthernetFrame(
        GATEWAY_MAC,
        GUEST_MAC,
        ETHERTYPE_IPV4,
        buildIpv4(
          IPPROTO_TCP,
          GUEST_IP,
          GATEWAY_IP,
          buildTcpSegment(GUEST_IP, GATEWAY_IP, {
            srcPort: GUEST_PORT,
            dstPort: 80,
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

  connect(): void {
    this.arp();
    this.sendTcp(TCP_SYN);
    const [synAck] = this.takeTcp();
    expect(synAck?.flags).toBe(TCP_SYN | TCP_ACK);
    this.ack = ((synAck?.seq ?? 0) + 1) >>> 0;
    this.sendTcp(TCP_ACK);
  }

  /** GET the query and return everything the host said (decoded). */
  get(target: string): string {
    const req = new TextEncoder().encode(`GET ${target} HTTP/1.0\r\n\r\n`);
    this.sendTcp(TCP_ACK | TCP_PSH, req);
    return this.readAll();
  }

  readAll(): string {
    let body = '';
    for (const seg of this.takeTcp()) {
      if (seg.payload.length === 0) continue;
      body += new TextDecoder().decode(seg.payload);
      this.ack = (seg.seq + seg.payload.length) >>> 0;
      this.sendTcp(TCP_ACK);
    }
    return body;
  }
}

function fixture(overrides: Partial<ControlActions> = {}): {
  lan: EthernetSwitch;
  gateway: LanGateway;
  host: ControlHost;
  guest: GuestPeer;
} {
  const lan = new EthernetSwitch();
  const gateway = new LanGateway();
  gateway.attachTo(lan);
  const host = new ControlHost({
    whoami: () => 'cat 10.0.2.17',
    peers: () => 'mouse 10.0.2.16\ncat 10.0.2.17  <- you',
    mkdrive: (kb) => Promise.resolve(`created ${kb} KB (fixture)`),
    ...overrides,
  });
  host.attachTo(gateway);
  const guest = new GuestPeer(lan);
  return { lan, gateway, host, guest };
}

describe('ControlHost — urlget against the gateway itself', () => {
  it('answers ?whoami with the injected identity', () => {
    const t = fixture();
    t.guest.connect();
    const answer = t.guest.get('/?whoami');
    expect(answer).toContain('200 OK');
    expect(answer).toContain('cat 10.0.2.17');
    expect(t.gateway.tcpLocalDelivered).toBeGreaterThan(0);
    expect(t.host.requestsServed).toBe(1);
  });

  it('answers ?peers with the live directory', () => {
    const t = fixture();
    t.guest.connect();
    const answer = t.guest.get('/?peers');
    expect(answer).toContain('mouse 10.0.2.16');
    expect(answer).toContain('<- you');
  });

  it('?mkdrive settles asynchronously (the main-thread round trip)', async () => {
    let asked = -1;
    const t = fixture({
      mkdrive: (kb) => {
        asked = kb;
        return Promise.resolve(`created a 8086 KB drive (${kb})`);
      },
    });
    t.guest.connect();
    t.guest.get('/?mkdrive=8086'); // answer not yet on the wire
    await flush(); // ...the promise settles between run batches
    const answer = t.guest.readAll();
    expect(asked).toBe(8086);
    expect(answer).toContain('200 OK');
    expect(answer).toContain('created a 8086 KB drive');
  });

  it('unknown actions get the usage text as a 400', () => {
    const t = fixture();
    t.guest.connect();
    const answer = t.guest.get('/?frobnicate');
    expect(answer).toContain('400 Bad Request');
    expect(answer).toContain('?mkdrive=KB');
    expect(t.host.badRequests).toBe(1);
  });

  it('a bare GET / serves the usage text as a friendly 200', () => {
    const t = fixture();
    t.guest.connect();
    const answer = t.guest.get('/');
    expect(answer).toContain('200 OK');
    expect(answer).toContain('substrate control');
  });

  it('mkdrive with a malformed size is a 400, not a crash', () => {
    const t = fixture();
    t.guest.connect();
    const answer = t.guest.get('/?mkdrive=lots');
    expect(answer).toContain('400 Bad Request');
  });

  it('a gateway with no control host still drops TCP to itself (old behavior)', () => {
    const lan = new EthernetSwitch();
    const gateway = new LanGateway();
    gateway.attachTo(lan);
    const guest = new GuestPeer(lan);
    guest.arp();
    guest.sendTcp(TCP_SYN);
    expect(guest.takeTcp()).toHaveLength(0); // dropped, no RST storm
  });
});
