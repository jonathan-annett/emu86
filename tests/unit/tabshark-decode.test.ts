/**
 * tab-shark frame decoding (TAN-freeze brief M3).
 *
 * Real wire-builder frames in, one human line out — TAN guests named
 * by animal, residents by role, everything else by its numbers.
 */

import { describe, expect, it } from 'vitest';
import { decodeFrame, ipName, octetName, tcpFlagText } from '../../web/tabshark-decode.js';
import { tanIdentityFor } from '../../src/net/tan.js';
import { GATEWAY_MAC } from '../../src/net/gateway.js';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_ECHO_REQUEST,
  IPPROTO_ICMP,
  IPPROTO_TCP,
  TCP_ACK,
  TCP_PSH,
  TCP_SYN,
  buildArp,
  buildEthernetFrame,
  buildIcmpEcho,
  buildIpv4,
  buildTcpSegment,
  type Ipv4,
} from '../../src/net/wire.js';

const MOUSE: Ipv4 = [10, 0, 2, 16];
const CAT: Ipv4 = [10, 0, 2, 17];
const GATEWAY: Ipv4 = [10, 0, 2, 2];

describe('tab-shark decode', () => {
  it('names TAN addresses by animal and residents by role', () => {
    expect(ipName(MOUSE)).toBe('mouse');
    expect(ipName(GATEWAY)).toBe('gateway');
    expect(ipName([10, 0, 2, 3])).toBe('dns');
    expect(ipName([1, 1, 1, 1])).toBe('1.1.1.1');
    expect(octetName(200)).toBe('.200'); // outside the named range
  });

  it('renders TCP with ports, flags, and payload length', () => {
    const seg = buildTcpSegment(MOUSE, CAT, {
      srcPort: 1024, dstPort: 23, seq: 1, ack: 1,
      flags: TCP_PSH | TCP_ACK, window: 4380,
      payload: new Uint8Array([0x6c, 0x73, 0x0d]), // "ls\r"
    });
    const frame = buildEthernetFrame(
      tanIdentityFor(17).mac, tanIdentityFor(16).mac,
      ETHERTYPE_IPV4, buildIpv4(IPPROTO_TCP, MOUSE, CAT, seg),
    );
    expect(decodeFrame(frame)).toBe('mouse:1024 → cat:23 [PSH|ACK] len=3');
  });

  it('renders ARP as a conversation', () => {
    const whoHas = buildEthernetFrame(
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff], tanIdentityFor(16).mac,
      ETHERTYPE_ARP,
      buildArp(ARP_OP_REQUEST, tanIdentityFor(16).mac, MOUSE, [0, 0, 0, 0, 0, 0], CAT),
    );
    expect(decodeFrame(whoHas)).toBe('ARP who-has cat? asks mouse');
    const reply = buildEthernetFrame(
      tanIdentityFor(16).mac, tanIdentityFor(17).mac,
      ETHERTYPE_ARP,
      buildArp(ARP_OP_REPLY, tanIdentityFor(17).mac, CAT, tanIdentityFor(16).mac, MOUSE),
    );
    expect(decodeFrame(reply)).toBe('ARP cat is-at (reply to mouse)');
  });

  it('renders ICMP echo as ping/pong', () => {
    const echo = buildEthernetFrame(
      GATEWAY_MAC, tanIdentityFor(16).mac,
      ETHERTYPE_IPV4,
      buildIpv4(IPPROTO_ICMP, MOUSE, GATEWAY, buildIcmpEcho(ICMP_ECHO_REQUEST, 1, 7, new Uint8Array(8))),
    );
    expect(decodeFrame(echo)).toBe('mouse → gateway ping seq=7');
  });

  it('degrades honestly on things it cannot parse', () => {
    expect(decodeFrame(new Uint8Array(4))).toBe('runt frame (4 B)');
    const weird = new Uint8Array(20);
    weird[12] = 0x86; weird[13] = 0xdd; // IPv6 ethertype
    expect(decodeFrame(weird)).toBe('ethertype 0x86dd (20 B)');
  });

  it('spells every TCP flag it knows', () => {
    expect(tcpFlagText(TCP_SYN | TCP_ACK)).toBe('SYN|ACK');
    expect(tcpFlagText(0)).toBe('');
  });
});
