/**
 * TanConntrack unit tests (TAN-freeze brief M1).
 *
 * Synthetic frames through the real wire builders (checksummed — the
 * parser validates), plus a two-TabAreaNetwork hub test proving the
 * trunk tap sees both directions.
 */

import { describe, it, expect } from 'vitest';
import { TanConntrack, buildFlowResetFrame } from '../../src/net/conntrack.js';
import { EthernetSwitch } from '../../src/net/switch.js';
import { TabAreaNetwork, tanIdentityFor, type FrameChannel } from '../../src/net/tan.js';
import {
  ETHERTYPE_IPV4,
  IPPROTO_TCP,
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_RST,
  TCP_SYN,
  buildEthernetFrame,
  buildIpv4,
  buildTcpSegment,
  parseIpv4,
  parseTcpSegment,
  type Ipv4,
} from '../../src/net/wire.js';

const MOUSE: Ipv4 = [10, 0, 2, 16];
const CAT: Ipv4 = [10, 0, 2, 17];

function tcpFrame(
  srcIp: Ipv4,
  dstIp: Ipv4,
  srcPort: number,
  dstPort: number,
  flags: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const srcMac = tanIdentityFor(srcIp[3] ?? 0).mac;
  const dstMac = tanIdentityFor(dstIp[3] ?? 0).mac;
  const seg = buildTcpSegment(srcIp, dstIp, {
    srcPort, dstPort, seq: 1000, ack: 2000, flags, window: 4380, payload,
  });
  return buildEthernetFrame(dstMac, srcMac, ETHERTYPE_IPV4, buildIpv4(IPPROTO_TCP, srcIp, dstIp, seg));
}

/** The classic telnet three-way handshake, mouse:1024 → cat:23. */
function handshake(ct: TanConntrack): void {
  ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_SYN));
  ct.observe(tcpFrame(CAT, MOUSE, 23, 1024, TCP_SYN | TCP_ACK));
  ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_ACK));
}

describe('TanConntrack', () => {
  it('tracks the handshake to established, with the right initiator', () => {
    const ct = new TanConntrack();
    ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_SYN));
    expect(ct.flows()).toEqual([
      { octetA: 16, portA: 1024, octetB: 17, portB: 23, state: 'syn', initiator: 16 },
    ]);
    ct.observe(tcpFrame(CAT, MOUSE, 23, 1024, TCP_SYN | TCP_ACK));
    expect(ct.flows()[0]?.state).toBe('syn');
    ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_ACK));
    expect(ct.flows()[0]?.state).toBe('established');
  });

  it('reports the perspective views symmetrically', () => {
    const ct = new TanConntrack();
    handshake(ct);
    expect(ct.connectionsFor(16)).toEqual([{
      peerOctet: 17, peerName: 'cat', localPort: 1024, peerPort: 23,
      state: 'established', outbound: true,
      expectFromPeer: 1001, // cat's SYN+ACK consumed seq 1000
    }]);
    expect(ct.connectionsFor(17)).toEqual([{
      peerOctet: 16, peerName: 'mouse', localPort: 23, peerPort: 1024,
      state: 'established', outbound: false,
      expectFromPeer: 1000, // mouse's final plain ACK re-stamped 1000
    }]);
    expect(ct.hasPeer(16, 17)).toBe(true);
    expect(ct.hasPeer(17, 16)).toBe(true);
    expect(ct.hasPeer(16, 18)).toBe(false);
    expect(ct.hasAnyPeerFor(17)).toBe(true);
    expect(ct.hasAnyPeerFor(42)).toBe(false);
  });

  it('closes on the second FIN, and the final pure ACK leaves no ghost', () => {
    const ct = new TanConntrack();
    handshake(ct);
    ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_FIN | TCP_ACK));
    expect(ct.flows()[0]?.state).toBe('closing');
    ct.observe(tcpFrame(CAT, MOUSE, 23, 1024, TCP_FIN | TCP_ACK));
    expect(ct.size).toBe(0);
    ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_ACK)); // the last ACK
    expect(ct.size).toBe(0); // pure ACK must not resurrect the flow
  });

  it('retires a flow immediately on RST', () => {
    const ct = new TanConntrack();
    handshake(ct);
    ct.observe(tcpFrame(CAT, MOUSE, 23, 1024, TCP_RST));
    expect(ct.size).toBe(0);
  });

  it('joins a live session mid-stream on a data segment (the restore case)', () => {
    const ct = new TanConntrack();
    ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_ACK | TCP_PSH, new Uint8Array([0x6c, 0x73])));
    expect(ct.flows()).toEqual([
      { octetA: 16, portA: 1024, octetB: 17, portB: 23, state: 'established', initiator: null },
    ]);
    expect(ct.connectionsFor(16)[0]?.outbound).toBeNull();
  });

  it('names the initiator from a SYN+ACK when the SYN was missed', () => {
    const ct = new TanConntrack();
    ct.observe(tcpFrame(CAT, MOUSE, 23, 1024, TCP_SYN | TCP_ACK));
    expect(ct.flows()[0]?.initiator).toBe(16);
  });

  it('ignores non-TAN, non-TCP, and malformed traffic', () => {
    const ct = new TanConntrack();
    const offNet = tcpFrame([192, 168, 1, 5] as Ipv4, CAT, 1024, 23, TCP_SYN);
    ct.observe(offNet);
    ct.observe(new Uint8Array(64)); // not IPv4 at all
    ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_SYN).subarray(0, 40)); // truncated
    expect(ct.size).toBe(0);
  });

  it('evicts the coldest flow at the cap, never the busy one', () => {
    const ct = new TanConntrack({ maxFlows: 2 });
    ct.observe(tcpFrame(MOUSE, CAT, 1000, 23, TCP_SYN));
    ct.observe(tcpFrame(MOUSE, CAT, 1001, 23, TCP_SYN));
    ct.observe(tcpFrame(MOUSE, CAT, 1000, 23, TCP_ACK)); // touch the first — now warmest
    ct.observe(tcpFrame(MOUSE, CAT, 1002, 23, TCP_SYN)); // over cap: 1001 is coldest
    const ports = ct.flows().map((f) => f.portA).sort((a, b) => a - b);
    expect(ports).toEqual([1000, 1002]);
  });
});

/** Synchronous BroadcastChannel-alike hub (the tan.test.ts pattern). */
function makeHub(): { join(): FrameChannel } {
  const members: FrameChannel[] = [];
  return {
    join(): FrameChannel {
      const member: FrameChannel = {
        onmessage: null,
        postMessage(data: unknown) {
          for (const other of members) {
            if (other !== member) other.onmessage?.({ data });
          }
        },
      };
      members.push(member);
      return member;
    },
  };
}

describe('TabAreaNetwork conntrack tap', () => {
  it('both tabs track a cross-trunk flow, each from its own side', () => {
    const hub = makeHub();
    const tanA = new TabAreaNetwork(hub.join(), { hostOctet: 16 });
    const tanB = new TabAreaNetwork(hub.join(), { hostOctet: 17 });
    const lanA = new EthernetSwitch();
    const lanB = new EthernetSwitch();
    tanA.attach(lanA);
    tanB.attach(lanB);

    // mouse's guest dials cat's telnetd: inject at a guest-like port on
    // switch A; unknown unicast floods to A's trunk, crosses the hub,
    // and enters switch B as trunk traffic.
    const guestA = lanA.attach({ name: 'guest-a', onFrame: () => {} });
    const guestB = lanB.attach({ name: 'guest-b', onFrame: () => {} });
    guestA.transmit(tcpFrame(MOUSE, CAT, 1024, 23, TCP_SYN));
    guestB.transmit(tcpFrame(CAT, MOUSE, 23, 1024, TCP_SYN | TCP_ACK));
    guestA.transmit(tcpFrame(MOUSE, CAT, 1024, 23, TCP_ACK));

    expect(tanA.conntrack.connectionsFor(16)).toEqual([{
      peerOctet: 17, peerName: 'cat', localPort: 1024, peerPort: 23,
      state: 'established', outbound: true, expectFromPeer: 1001,
    }]);
    expect(tanB.conntrack.connectionsFor(17)).toEqual([{
      peerOctet: 16, peerName: 'mouse', localPort: 23, peerPort: 1024,
      state: 'established', outbound: false, expectFromPeer: 1000,
    }]);
  });
});

describe('buildFlowResetFrame (fix #9)', () => {
  it('builds an in-sequence RST wearing the peer\'s identity', () => {
    const frame = buildFlowResetFrame(16, {
      peerOctet: 17, localPort: 1024, peerPort: 23, expectFromPeer: 0x1cd,
    });
    // Ethernet: to the local guest's MAC, from the peer's.
    expect([...frame.subarray(0, 6)]).toEqual([0x02, 0x65, 0x6d, 0x75, 0x38, 16]);
    expect([...frame.subarray(6, 12)]).toEqual([0x02, 0x65, 0x6d, 0x75, 0x38, 17]);
    const ip = parseIpv4(frame.subarray(14));
    expect(ip?.srcIp).toEqual([10, 0, 2, 17]);
    expect(ip?.dstIp).toEqual([10, 0, 2, 16]);
    const seg = ip !== null ? parseTcpSegment(ip.srcIp, ip.dstIp, ip.payload) : null;
    expect(seg?.srcPort).toBe(23);
    expect(seg?.dstPort).toBe(1024);
    expect(seg?.flags).toBe(TCP_RST);
    expect(seg?.seq).toBe(0x1cd); // the guest's rcv_nxt — the only seq ktcp accepts
  });
});
