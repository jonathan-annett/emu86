/**
 * LanGateway unit tests (Phase 14 M3b).
 *
 * A fake "guest" port on the switch plays ktcp's role: it announces
 * itself with a gratuitous ARP (like `deveth.c:57`), answers nothing
 * on its own, and lets us assert exactly what the gateway emits.
 */

import { describe, it, expect } from 'vitest';
import { EthernetSwitch } from '../../src/net/switch.js';
import { GATEWAY_IP, GATEWAY_MAC, LanGateway, type EchoReplyEvent } from '../../src/net/gateway.js';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  IPPROTO_ICMP,
  MAC_BROADCAST,
  buildArp,
  buildEthernetFrame,
  buildIcmpEcho,
  buildIpv4,
  parseArp,
  parseIcmpEcho,
  parseIpv4,
} from '../../src/net/wire.js';

const GUEST_MAC = [0x02, 0x65, 0x6d, 0x75, 0x38, 0x36] as const;
const GUEST_IP = [10, 0, 2, 15] as const;

interface Lan {
  gateway: LanGateway;
  guestRx: Uint8Array[];
  guest: ReturnType<EthernetSwitch['attach']>;
  replies: EchoReplyEvent[];
}

function makeLan(): Lan {
  const lan = new EthernetSwitch();
  const replies: EchoReplyEvent[] = [];
  const gateway = new LanGateway({ onEchoReply: (ev) => replies.push(ev) });
  gateway.attachTo(lan);
  const guestRx: Uint8Array[] = [];
  const guest = lan.attach({ name: 'guest', onFrame: (f) => guestRx.push(f) });
  return { gateway, guestRx, guest, replies };
}

/** ktcp's startup announcement: an unsolicited broadcast ARP REPLY. */
function gratuitousArp(l: Lan): void {
  l.guest.transmit(
    buildEthernetFrame(
      MAC_BROADCAST,
      GUEST_MAC,
      ETHERTYPE_ARP,
      buildArp(ARP_OP_REPLY, GUEST_MAC, GUEST_IP, GUEST_MAC, GUEST_IP),
    ),
  );
}

describe('LanGateway', () => {
  it('replies to ARP who-has for its own IP', () => {
    const l = makeLan();
    l.guest.transmit(
      buildEthernetFrame(
        MAC_BROADCAST,
        GUEST_MAC,
        ETHERTYPE_ARP,
        buildArp(ARP_OP_REQUEST, GUEST_MAC, GUEST_IP, [0, 0, 0, 0, 0, 0], GATEWAY_IP),
      ),
    );
    expect(l.gateway.arpRepliesSent).toBe(1);
    expect(l.guestRx).toHaveLength(1);
    const arp = parseArp(l.guestRx[0]!.subarray(14));
    expect(arp?.op).toBe(ARP_OP_REPLY);
    expect(arp?.senderMac).toEqual(Array.from(GATEWAY_MAC));
    expect(arp?.senderIp).toEqual(Array.from(GATEWAY_IP));
    expect(arp?.targetIp).toEqual(Array.from(GUEST_IP));
  });

  it('learns the guest from its gratuitous ARP', () => {
    const l = makeLan();
    gratuitousArp(l);
    expect(l.gateway.arpTable.get('10.0.2.15')).toEqual(Array.from(GUEST_MAC));
  });

  it('pings immediately when the target MAC is known', () => {
    const l = makeLan();
    gratuitousArp(l);
    const payload = Uint8Array.from([0xca, 0xfe]);
    expect(l.gateway.ping(GUEST_IP, 0x77, 1, payload)).toBe('sent');
    expect(l.guestRx).toHaveLength(1);
    const ip = parseIpv4(l.guestRx[0]!.subarray(14));
    expect(ip?.protocol).toBe(IPPROTO_ICMP);
    const echo = parseIcmpEcho(ip!.payload);
    expect(echo?.type).toBe(ICMP_ECHO_REQUEST);
    expect(echo?.id).toBe(0x77);
    expect(Array.from(echo?.payload ?? [])).toEqual([0xca, 0xfe]);
  });

  it('queues a ping behind ARP resolution and flushes on the reply', () => {
    const l = makeLan();
    expect(l.gateway.ping(GUEST_IP, 5, 9, new Uint8Array(4))).toBe('arp-pending');
    // First wire traffic is the who-has broadcast.
    expect(l.guestRx).toHaveLength(1);
    const arp = parseArp(l.guestRx[0]!.subarray(14));
    expect(arp?.op).toBe(ARP_OP_REQUEST);
    expect(arp?.targetIp).toEqual(Array.from(GUEST_IP));

    // Guest answers (ktcp's arp_reply shape) → queued ping flushes.
    l.guest.transmit(
      buildEthernetFrame(
        Array.from(GATEWAY_MAC),
        GUEST_MAC,
        ETHERTYPE_ARP,
        buildArp(ARP_OP_REPLY, GUEST_MAC, GUEST_IP, Array.from(GATEWAY_MAC), Array.from(GATEWAY_IP)),
      ),
    );
    expect(l.gateway.echoRequestsSent).toBe(1);
    expect(l.guestRx).toHaveLength(2);
    const echo = parseIcmpEcho(parseIpv4(l.guestRx[1]!.subarray(14))!.payload);
    expect(echo?.seq).toBe(9);
  });

  it('surfaces echo replies through onEchoReply', () => {
    const l = makeLan();
    gratuitousArp(l);
    l.gateway.ping(GUEST_IP, 3, 1, Uint8Array.from([9, 9]));
    // Guest replies (what ktcp's icmp.c does: same id/seq/payload back).
    l.guest.transmit(
      buildEthernetFrame(
        Array.from(GATEWAY_MAC),
        GUEST_MAC,
        ETHERTYPE_IPV4,
        buildIpv4(IPPROTO_ICMP, GUEST_IP, GATEWAY_IP, buildIcmpEcho(ICMP_ECHO_REPLY, 3, 1, Uint8Array.from([9, 9]))),
      ),
    );
    expect(l.gateway.echoRepliesReceived).toBe(1);
    expect(l.replies).toHaveLength(1);
    expect(l.replies[0]?.id).toBe(3);
    expect(l.replies[0]?.fromIp).toEqual(Array.from(GUEST_IP));
  });

  it('answers pings of its own IP', () => {
    const l = makeLan();
    gratuitousArp(l);
    l.guest.transmit(
      buildEthernetFrame(
        Array.from(GATEWAY_MAC),
        GUEST_MAC,
        ETHERTYPE_IPV4,
        buildIpv4(IPPROTO_ICMP, GUEST_IP, GATEWAY_IP, buildIcmpEcho(ICMP_ECHO_REQUEST, 11, 2, Uint8Array.from([1]))),
      ),
    );
    expect(l.gateway.echoRepliesSent).toBe(1);
    const echo = parseIcmpEcho(parseIpv4(l.guestRx[l.guestRx.length - 1]!.subarray(14))!.payload);
    expect(echo?.type).toBe(ICMP_ECHO_REPLY);
    expect(echo?.id).toBe(11);
  });

  it('welcome-pings newly learned hosts when enabled (once, not on re-learn)', () => {
    const lan = new EthernetSwitch();
    const gateway = new LanGateway({ welcomePing: true });
    gateway.attachTo(lan);
    const guestRx: Uint8Array[] = [];
    const guest = lan.attach({ name: 'guest', onFrame: (f) => guestRx.push(f) });

    const announce = (): void =>
      guest.transmit(
        buildEthernetFrame(
          MAC_BROADCAST,
          GUEST_MAC,
          ETHERTYPE_ARP,
          buildArp(ARP_OP_REPLY, GUEST_MAC, GUEST_IP, GUEST_MAC, GUEST_IP),
        ),
      );
    announce();
    expect(gateway.echoRequestsSent).toBe(1);
    const echo = parseIcmpEcho(parseIpv4(guestRx[0]!.subarray(14))!.payload);
    expect(echo?.type).toBe(ICMP_ECHO_REQUEST);
    expect(echo?.id).toBe(0xe86);
    // Re-announcement of a known host: no second welcome ping.
    announce();
    expect(gateway.echoRequestsSent).toBe(1);
  });

  it('ignores IPv4 traffic not addressed to it', () => {
    const l = makeLan();
    gratuitousArp(l);
    l.guest.transmit(
      buildEthernetFrame(
        Array.from(GATEWAY_MAC),
        GUEST_MAC,
        ETHERTYPE_IPV4,
        buildIpv4(IPPROTO_ICMP, GUEST_IP, [10, 0, 2, 99], buildIcmpEcho(ICMP_ECHO_REQUEST, 1, 1, new Uint8Array(0))),
      ),
    );
    expect(l.gateway.echoRepliesSent).toBe(0);
  });
});

describe('LanGateway — off-LAN echo gets host-unreachable (Phase 15 M3, D6)', () => {
  const FAR_IP = [8, 8, 8, 8] as const;

  it('answers a routed echo request with ICMP type 3 code 1 quoting the original', () => {
    const l = makeLan();
    gratuitousArp(l);
    const original = buildIpv4(
      IPPROTO_ICMP,
      GUEST_IP,
      Array.from(FAR_IP),
      buildIcmpEcho(ICMP_ECHO_REQUEST, 0x1234, 7, Uint8Array.from([1, 2, 3, 4])),
      0x42,
    );
    l.guest.transmit(
      buildEthernetFrame(Array.from(GATEWAY_MAC), GUEST_MAC, ETHERTYPE_IPV4, original),
    );

    expect(l.gateway.unreachablesSent).toBe(1);
    expect(l.guestRx).toHaveLength(1);
    const ip = parseIpv4(l.guestRx[0]!.subarray(14));
    expect(ip?.protocol).toBe(IPPROTO_ICMP);
    expect(ip?.srcIp).toEqual(Array.from(GATEWAY_IP)); // the router speaks as itself
    const icmp = ip?.payload ?? new Uint8Array(0);
    expect(icmp[0]).toBe(3); // dest-unreachable
    expect(icmp[1]).toBe(1); // host-unreachable
    // RFC 792 quote: original IP header + first 8 payload bytes.
    expect(icmp[8]).toBe(0x45); // quoted header starts at v4/IHL5
    expect(Array.from(icmp.subarray(8 + 16, 8 + 20))).toEqual(Array.from(FAR_IP));
    expect(icmp.length).toBe(8 + 20 + 8);
  });

  it('stays silent for echo replies and for senders it cannot route back to', () => {
    const l = makeLan();
    // No gratuitous ARP: sender unknown — nothing goes out.
    l.guest.transmit(
      buildEthernetFrame(
        Array.from(GATEWAY_MAC),
        GUEST_MAC,
        ETHERTYPE_IPV4,
        buildIpv4(IPPROTO_ICMP, GUEST_IP, Array.from(FAR_IP), buildIcmpEcho(ICMP_ECHO_REQUEST, 1, 1, new Uint8Array(0))),
      ),
    );
    expect(l.gateway.unreachablesSent).toBe(0);
    expect(l.guestRx).toHaveLength(0);
    // Echo REPLY to an off-LAN target: not answered either.
    gratuitousArp(l);
    l.guest.transmit(
      buildEthernetFrame(
        Array.from(GATEWAY_MAC),
        GUEST_MAC,
        ETHERTYPE_IPV4,
        buildIpv4(IPPROTO_ICMP, GUEST_IP, Array.from(FAR_IP), buildIcmpEcho(ICMP_ECHO_REPLY, 1, 1, new Uint8Array(0))),
      ),
    );
    expect(l.gateway.unreachablesSent).toBe(0);
  });
});
