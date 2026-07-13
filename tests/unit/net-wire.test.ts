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
  buildArp,
  buildEthernetFrame,
  buildIcmpEcho,
  buildIpv4,
  internetChecksum,
  parseArp,
  parseIcmpEcho,
  parseIpv4,
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
