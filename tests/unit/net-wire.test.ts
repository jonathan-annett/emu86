/**
 * Wire-format unit tests (Phase 14 M3b) — checksums against known
 * vectors, build/parse round trips.
 */

import { describe, it, expect } from 'vitest';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ICMP_ECHO_REQUEST,
  IPPROTO_ICMP,
  TCP_ACK,
  TCP_PSH,
  TCP_SYN,
  buildArp,
  buildEthernetFrame,
  buildIcmpEcho,
  buildIpv4,
  buildTcpSegment,
  internetChecksum,
  parseArp,
  parseIcmpEcho,
  parseIpv4,
  parseTcpSegment,
  tcpChecksum,
} from '../../src/net/wire.js';

describe('internetChecksum', () => {
  it('matches the classic RFC 1071 worked example', () => {
    // 0x0001 0xf203 0xf4f5 0xf6f7 → checksum 0x220d (RFC 1071 §3).
    const bytes = Uint8Array.from([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7]);
    expect(internetChecksum(bytes, 0, 8)).toBe(0x220d);
  });

  it('handles odd lengths by zero-padding the tail', () => {
    const even = Uint8Array.from([0x12, 0x34, 0x56, 0x00]);
    const odd = Uint8Array.from([0x12, 0x34, 0x56]);
    expect(internetChecksum(odd, 0, 3)).toBe(internetChecksum(even, 0, 4));
  });

  it('validates: a packet including its own checksum sums to zero-complement', () => {
    const p = buildIcmpEcho(ICMP_ECHO_REQUEST, 7, 1, Uint8Array.from([1, 2, 3, 4]));
    expect(internetChecksum(p, 0, p.length)).toBe(0);
  });
});

describe('ARP build/parse', () => {
  it('round-trips a request', () => {
    const p = buildArp(ARP_OP_REQUEST, [1, 2, 3, 4, 5, 6], [10, 0, 2, 2], [0, 0, 0, 0, 0, 0], [10, 0, 2, 15]);
    const parsed = parseArp(p);
    expect(parsed).not.toBeNull();
    expect(parsed?.op).toBe(ARP_OP_REQUEST);
    expect(parsed?.senderIp).toEqual([10, 0, 2, 2]);
    expect(parsed?.targetIp).toEqual([10, 0, 2, 15]);
  });

  it('rejects non-ethernet/IPv4 ARP', () => {
    const p = buildArp(ARP_OP_REPLY, [1, 2, 3, 4, 5, 6], [1, 1, 1, 1], [0, 0, 0, 0, 0, 0], [2, 2, 2, 2]);
    p[1] = 0x06; // bogus HTYPE
    expect(parseArp(p)).toBeNull();
  });
});

describe('IPv4 + ICMP build/parse', () => {
  it('builds a header ktcp would accept (checksum verifies to 0)', () => {
    const p = buildIpv4(IPPROTO_ICMP, [10, 0, 2, 2], [10, 0, 2, 15], new Uint8Array(8), 42);
    expect(internetChecksum(p, 0, 20)).toBe(0);
    const parsed = parseIpv4(p);
    expect(parsed?.protocol).toBe(IPPROTO_ICMP);
    expect(parsed?.srcIp).toEqual([10, 0, 2, 2]);
    expect(parsed?.dstIp).toEqual([10, 0, 2, 15]);
    expect(parsed?.payload.length).toBe(8);
  });

  it('bounds the payload by the IP total-length field', () => {
    const inner = buildIpv4(IPPROTO_ICMP, [1, 1, 1, 1], [2, 2, 2, 2], new Uint8Array(4));
    // Simulate ethernet padding: 10 trailing junk bytes beyond total_len.
    const padded = new Uint8Array(inner.length + 10).fill(0xee);
    padded.set(inner, 0);
    const parsed = parseIpv4(padded);
    expect(parsed?.payload.length).toBe(4);
  });

  it('round-trips an ICMP echo with id/seq/payload intact', () => {
    const payload = Uint8Array.from({ length: 32 }, (_, i) => i);
    const p = buildIcmpEcho(ICMP_ECHO_REQUEST, 0x1234, 7, payload);
    const parsed = parseIcmpEcho(p);
    expect(parsed?.type).toBe(ICMP_ECHO_REQUEST);
    expect(parsed?.id).toBe(0x1234);
    expect(parsed?.seq).toBe(7);
    expect(Array.from(parsed?.payload ?? [])).toEqual(Array.from(payload));
  });

  it('frames carry the right ethertype', () => {
    const f = buildEthernetFrame([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1], 0x0806, new Uint8Array(28));
    expect(f.length).toBe(42);
    expect(f[12]).toBe(0x08);
    expect(f[13]).toBe(0x06);
  });
});

describe('TCP build/parse (Phase 14 M3c)', () => {
  const SRC = [10, 0, 2, 15] as const;
  const DST = [10, 0, 2, 3] as const;

  it('round-trips a segment with ports/seq/ack/flags/payload intact', () => {
    const payload = Uint8Array.from({ length: 49 }, (_, i) => i);
    const seg = buildTcpSegment(SRC, DST, {
      srcPort: 1024,
      dstPort: 53,
      seq: 0xdeadbeef,
      ack: 0x00010001,
      flags: TCP_PSH | TCP_ACK,
      window: 4380,
      payload,
    });
    const parsed = parseTcpSegment(SRC, DST, seg);
    expect(parsed).not.toBeNull();
    expect(parsed?.srcPort).toBe(1024);
    expect(parsed?.dstPort).toBe(53);
    expect(parsed?.seq).toBe(0xdeadbeef);
    expect(parsed?.ack).toBe(0x00010001);
    expect(parsed?.flags).toBe(TCP_PSH | TCP_ACK);
    expect(parsed?.window).toBe(4380);
    expect(Array.from(parsed?.payload ?? [])).toEqual(Array.from(payload));
  });

  it('carries a checksum ktcp accepts (pseudo-header sum verifies to 0)', () => {
    // ktcp's tcp_chksum sums the segment (checksum field included) plus
    // the pseudo-header and expects 0 — mirror that acceptance check.
    const seg = buildTcpSegment(SRC, DST, {
      srcPort: 3000,
      dstPort: 53,
      seq: 1,
      ack: 2,
      flags: TCP_SYN | TCP_ACK,
      window: 4096,
      payload: Uint8Array.from([0xab]),
    });
    const pseudo = new Uint8Array(12 + seg.length);
    pseudo.set(SRC, 0);
    pseudo.set(DST, 4);
    pseudo[9] = 6;
    pseudo[10] = (seg.length >> 8) & 0xff;
    pseudo[11] = seg.length & 0xff;
    pseudo.set(seg, 12);
    expect(internetChecksum(pseudo, 0, pseudo.length)).toBe(0);
  });

  it('rejects a corrupted checksum', () => {
    const seg = buildTcpSegment(SRC, DST, {
      srcPort: 1,
      dstPort: 2,
      seq: 3,
      ack: 4,
      flags: TCP_ACK,
      window: 100,
      payload: new Uint8Array(0),
    });
    seg[19] = 0x55; // flip urgent-pointer byte after checksum was fixed
    expect(parseTcpSegment(SRC, DST, seg)).toBeNull();
  });

  it('skips options — a ktcp-style SYN with MSS (data offset 6) parses', () => {
    // Hand-build a 24-byte header the way ktcp's tcp_output does for
    // SYN: MSS option kind 2, len 4, value 1460.
    const p = new Uint8Array(24);
    p[0] = 0x10; p[1] = 0x00;             // sport 4096
    p[2] = 0x00; p[3] = 0x35;             // dport 53
    p[4] = 0x00; p[5] = 0x00; p[6] = 0x00; p[7] = 0x2a; // seq 42
    p[12] = 6 << 4;                       // data offset 6 words
    p[13] = TCP_SYN;
    p[14] = 0x11; p[15] = 0x1c;           // window 4380
    p[20] = 2; p[21] = 4; p[22] = 1460 >> 8; p[23] = 1460 & 0xff;
    const cks = tcpChecksum(SRC, DST, p);
    p[16] = (cks >> 8) & 0xff;
    p[17] = cks & 0xff;
    const parsed = parseTcpSegment(SRC, DST, p);
    expect(parsed).not.toBeNull();
    expect(parsed?.flags).toBe(TCP_SYN);
    expect(parsed?.seq).toBe(42);
    expect(parsed?.payload.length).toBe(0); // options are not payload
  });
});
