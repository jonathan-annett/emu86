/**
 * Wire-format helpers for the browser-side LAN (Phase 14 M3b).
 *
 * Pure builders/parsers for the three formats the pseudo-hosts speak:
 * ethernet II framing, ARP, and IPv4+ICMP echo. No state, no I/O —
 * `gateway.ts` (and later pseudo-hosts: DNS, the HTTP gateway) compose
 * these; unit tests hit them directly with known vectors.
 *
 * Counterparty is ELKS's ktcp (`elkscmd/ktcp/{arp,ip,icmp}.c`), which
 * validates IP header checksums (`netstat`'s "IP Bad Checksum"
 * counter) and recomputes ICMP checksums — so both are implemented
 * properly (RFC 1071), not zeroed.
 */

export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
export const IPPROTO_ICMP = 1;
export const IPPROTO_TCP = 6;
export const ICMP_ECHO_REQUEST = 8;
export const ICMP_ECHO_REPLY = 0;
export const ARP_OP_REQUEST = 1;
export const ARP_OP_REPLY = 2;

export const MAC_BROADCAST: readonly number[] = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

export type Mac = readonly number[]; // 6 bytes
export type Ipv4 = readonly number[]; // 4 bytes

/** RFC 1071 internet checksum over a byte range. */
export function internetChecksum(bytes: Uint8Array, start: number, length: number): number {
  let sum = 0;
  const end = start + length;
  for (let i = start; i + 1 < end; i += 2) {
    sum += ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
  }
  if (length % 2 === 1) sum += (bytes[end - 1] ?? 0) << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

export function macEquals(bytes: Uint8Array, offset: number, mac: Mac): boolean {
  for (let i = 0; i < 6; i++) {
    if ((bytes[offset + i] ?? 0) !== mac[i]) return false;
  }
  return true;
}

export function ipEquals(bytes: Uint8Array, offset: number, ip: Ipv4): boolean {
  for (let i = 0; i < 4; i++) {
    if ((bytes[offset + i] ?? 0) !== ip[i]) return false;
  }
  return true;
}

export function formatIp(ip: Ipv4): string {
  return ip.join('.');
}

export function formatMac(mac: Mac): string {
  return mac.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

/** 14-byte ethernet II header + payload. */
export function buildEthernetFrame(dst: Mac, src: Mac, ethertype: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(14 + payload.length);
  frame.set(dst, 0);
  frame.set(src, 6);
  frame[12] = (ethertype >> 8) & 0xff;
  frame[13] = ethertype & 0xff;
  frame.set(payload, 14);
  return frame;
}

// ============================================================
// ARP (ethernet/IPv4 flavour — 28-byte body)
// ============================================================

export interface ArpPacket {
  readonly op: number;
  readonly senderMac: Mac;
  readonly senderIp: Ipv4;
  readonly targetMac: Mac;
  readonly targetIp: Ipv4;
}

export function buildArp(op: number, senderMac: Mac, senderIp: Ipv4, targetMac: Mac, targetIp: Ipv4): Uint8Array {
  const p = new Uint8Array(28);
  p[0] = 0x00; p[1] = 0x01;        // HTYPE ethernet
  p[2] = 0x08; p[3] = 0x00;        // PTYPE IPv4
  p[4] = 6;                        // HLEN
  p[5] = 4;                        // PLEN
  p[6] = (op >> 8) & 0xff; p[7] = op & 0xff;
  p.set(senderMac, 8);
  p.set(senderIp, 14);
  p.set(targetMac, 18);
  p.set(targetIp, 24);
  return p;
}

/** Parse an ARP body (frame payload after the ethernet header). Null if not ethernet/IPv4 ARP. */
export function parseArp(payload: Uint8Array): ArpPacket | null {
  if (payload.length < 28) return null;
  if (payload[0] !== 0x00 || payload[1] !== 0x01) return null;
  if (payload[2] !== 0x08 || payload[3] !== 0x00) return null;
  if (payload[4] !== 6 || payload[5] !== 4) return null;
  const at = (o: number, n: number): number[] => Array.from(payload.subarray(o, o + n));
  return {
    op: ((payload[6] ?? 0) << 8) | (payload[7] ?? 0),
    senderMac: at(8, 6),
    senderIp: at(14, 4),
    targetMac: at(18, 6),
    targetIp: at(24, 4),
  };
}

// ============================================================
// IPv4 + ICMP echo
// ============================================================

export interface Ipv4Packet {
  readonly protocol: number;
  readonly srcIp: Ipv4;
  readonly dstIp: Ipv4;
  /** Payload view (after the header, bounded by total length). */
  readonly payload: Uint8Array;
}

/** Parse an IPv4 packet (frame payload). Null on malformed/truncated. */
export function parseIpv4(payload: Uint8Array): Ipv4Packet | null {
  if (payload.length < 20) return null;
  const versionIhl = payload[0] ?? 0;
  if (versionIhl >> 4 !== 4) return null;
  const headerLen = (versionIhl & 0x0f) * 4;
  if (headerLen < 20 || payload.length < headerLen) return null;
  const totalLen = ((payload[2] ?? 0) << 8) | (payload[3] ?? 0);
  if (totalLen < headerLen || totalLen > payload.length) return null;
  const at = (o: number, n: number): number[] => Array.from(payload.subarray(o, o + n));
  return {
    protocol: payload[9] ?? 0,
    srcIp: at(12, 4),
    dstIp: at(16, 4),
    payload: payload.subarray(headerLen, totalLen),
  };
}

/**
 * Build an IPv4 packet with a 20-byte header and a correct checksum.
 * TTL 64, no fragmentation, IP ID caller-supplied for determinism.
 */
export function buildIpv4(protocol: number, srcIp: Ipv4, dstIp: Ipv4, payload: Uint8Array, ipId = 0): Uint8Array {
  const totalLen = 20 + payload.length;
  const p = new Uint8Array(totalLen);
  p[0] = 0x45;                       // v4, IHL 5
  p[1] = 0x00;                       // DSCP/ECN
  p[2] = (totalLen >> 8) & 0xff;
  p[3] = totalLen & 0xff;
  p[4] = (ipId >> 8) & 0xff;
  p[5] = ipId & 0xff;
  p[6] = 0x00;                       // flags/frag
  p[7] = 0x00;
  p[8] = 64;                         // TTL
  p[9] = protocol & 0xff;
  p.set(srcIp, 12);
  p.set(dstIp, 16);
  const cks = internetChecksum(p, 0, 20);
  p[10] = (cks >> 8) & 0xff;
  p[11] = cks & 0xff;
  p.set(payload, 20);
  return p;
}

export interface IcmpEcho {
  readonly type: number;
  readonly id: number;
  readonly seq: number;
  readonly payload: Uint8Array;
}

/** Build an ICMP echo request/reply with a correct checksum. */
export function buildIcmpEcho(type: number, id: number, seq: number, payload: Uint8Array): Uint8Array {
  const p = new Uint8Array(8 + payload.length);
  p[0] = type & 0xff;
  p[1] = 0x00; // code
  p[4] = (id >> 8) & 0xff;
  p[5] = id & 0xff;
  p[6] = (seq >> 8) & 0xff;
  p[7] = seq & 0xff;
  p.set(payload, 8);
  const cks = internetChecksum(p, 0, p.length);
  p[2] = (cks >> 8) & 0xff;
  p[3] = cks & 0xff;
  return p;
}

export const ICMP_DEST_UNREACHABLE = 3;
export const ICMP_CODE_HOST_UNREACH = 1;

/**
 * Build an ICMP destination-unreachable (RFC 792): type 3, `code`,
 * 4 unused bytes, then the original IP header + first 8 payload bytes
 * (what the sender needs to match the failure to its socket — ktcp's
 * `icmp.c` reads exactly that much on ICMP_TYPE_DST_UNRCH).
 * `original` is the offending IPv4 packet from its first header byte.
 */
export function buildIcmpDestUnreachable(code: number, original: Uint8Array): Uint8Array {
  const headerLen = ((original[0] ?? 0) & 0x0f) * 4;
  const quote = original.subarray(0, Math.min(original.length, headerLen + 8));
  const p = new Uint8Array(8 + quote.length);
  p[0] = ICMP_DEST_UNREACHABLE;
  p[1] = code & 0xff;
  // bytes 4-7 unused (zero)
  p.set(quote, 8);
  const cks = internetChecksum(p, 0, p.length);
  p[2] = (cks >> 8) & 0xff;
  p[3] = cks & 0xff;
  return p;
}

/** Parse an ICMP echo request/reply. Null for other ICMP types/truncation. */
export function parseIcmpEcho(payload: Uint8Array): IcmpEcho | null {
  if (payload.length < 8) return null;
  const type = payload[0] ?? 0;
  if (type !== ICMP_ECHO_REQUEST && type !== ICMP_ECHO_REPLY) return null;
  return {
    type,
    id: ((payload[4] ?? 0) << 8) | (payload[5] ?? 0),
    seq: ((payload[6] ?? 0) << 8) | (payload[7] ?? 0),
    payload: payload.subarray(8),
  };
}

// ============================================================
// TCP (Phase 14 M3c)
// ============================================================
//
// Counterparty is ktcp's `tcp.c`/`tcp_output.c`, which validates the
// checksum over the pseudo-header ("BAD CHECKSUM" printf + drop) and
// drops any segment whose seqnum isn't exactly rcv_nxt — so builders
// carry real checksums and callers must sequence precisely. ktcp puts
// an MSS option in its SYNs (data offset 6) but never parses options
// on segments it receives, so ours are bare 20-byte headers.

export const TCP_FIN = 0x01;
export const TCP_SYN = 0x02;
export const TCP_RST = 0x04;
export const TCP_PSH = 0x08;
export const TCP_ACK = 0x10;

export interface TcpSegment {
  readonly srcPort: number;
  readonly dstPort: number;
  /** 32-bit sequence number (unsigned). */
  readonly seq: number;
  /** 32-bit acknowledgement number (unsigned). */
  readonly ack: number;
  readonly flags: number;
  readonly window: number;
  readonly payload: Uint8Array;
}

/**
 * TCP checksum (RFC 793): RFC 1071 sum over the 12-byte IPv4
 * pseudo-header (src, dst, zero, protocol 6, TCP length) followed by
 * the segment bytes with the checksum field taken as zero.
 */
export function tcpChecksum(srcIp: Ipv4, dstIp: Ipv4, segment: Uint8Array): number {
  const buf = new Uint8Array(12 + segment.length);
  buf.set(srcIp, 0);
  buf.set(dstIp, 4);
  buf[8] = 0;
  buf[9] = IPPROTO_TCP;
  buf[10] = (segment.length >> 8) & 0xff;
  buf[11] = segment.length & 0xff;
  buf.set(segment, 12);
  buf[12 + 16] = 0; // checksum field zeroed for computation
  buf[12 + 17] = 0;
  return internetChecksum(buf, 0, buf.length);
}

/** Build a TCP segment (bare 20-byte header, real checksum). */
export function buildTcpSegment(srcIp: Ipv4, dstIp: Ipv4, seg: TcpSegment): Uint8Array {
  const p = new Uint8Array(20 + seg.payload.length);
  p[0] = (seg.srcPort >> 8) & 0xff;
  p[1] = seg.srcPort & 0xff;
  p[2] = (seg.dstPort >> 8) & 0xff;
  p[3] = seg.dstPort & 0xff;
  writeU32(p, 4, seg.seq);
  writeU32(p, 8, seg.ack);
  p[12] = 5 << 4; // data offset 5 words, no options
  p[13] = seg.flags & 0x3f;
  p[14] = (seg.window >> 8) & 0xff;
  p[15] = seg.window & 0xff;
  // p[16..17] checksum below; p[18..19] urgent pointer stays 0
  p.set(seg.payload, 20);
  const cks = tcpChecksum(srcIp, dstIp, p);
  p[16] = (cks >> 8) & 0xff;
  p[17] = cks & 0xff;
  return p;
}

/**
 * Parse a TCP segment (an IPv4 payload). Options are skipped — ktcp's
 * SYNs carry MSS. Null on truncation or a failed checksum (the src/dst
 * IPs are needed for the pseudo-header).
 */
export function parseTcpSegment(srcIp: Ipv4, dstIp: Ipv4, bytes: Uint8Array): TcpSegment | null {
  if (bytes.length < 20) return null;
  const dataOff = ((bytes[12] ?? 0) >> 4) * 4;
  if (dataOff < 20 || bytes.length < dataOff) return null;
  if (tcpChecksum(srcIp, dstIp, bytes) !== (((bytes[16] ?? 0) << 8) | (bytes[17] ?? 0))) {
    return null;
  }
  return {
    srcPort: ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0),
    dstPort: ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
    seq: readU32(bytes, 4),
    ack: readU32(bytes, 8),
    flags: (bytes[13] ?? 0) & 0x3f,
    window: ((bytes[14] ?? 0) << 8) | (bytes[15] ?? 0),
    payload: bytes.subarray(dataOff),
  };
}

function writeU32(p: Uint8Array, offset: number, value: number): void {
  p[offset] = (value >>> 24) & 0xff;
  p[offset + 1] = (value >>> 16) & 0xff;
  p[offset + 2] = (value >>> 8) & 0xff;
  p[offset + 3] = value & 0xff;
}

function readU32(p: Uint8Array, offset: number): number {
  return (
    (((p[offset] ?? 0) << 24) | ((p[offset + 1] ?? 0) << 16) | ((p[offset + 2] ?? 0) << 8) | (p[offset + 3] ?? 0)) >>> 0
  );
}
