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
export const ICMP_ECHO_REQUEST = 8;
export const ICMP_ECHO_REPLY = 0;
export const ARP_OP_REQUEST = 1;
export const ARP_OP_REPLY = 2;
export const MAC_BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
/** RFC 1071 internet checksum over a byte range. */
export function internetChecksum(bytes, start, length) {
    let sum = 0;
    const end = start + length;
    for (let i = start; i + 1 < end; i += 2) {
        sum += ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
    }
    if (length % 2 === 1)
        sum += (bytes[end - 1] ?? 0) << 8;
    while (sum > 0xffff)
        sum = (sum & 0xffff) + (sum >> 16);
    return ~sum & 0xffff;
}
export function macEquals(bytes, offset, mac) {
    for (let i = 0; i < 6; i++) {
        if ((bytes[offset + i] ?? 0) !== mac[i])
            return false;
    }
    return true;
}
export function ipEquals(bytes, offset, ip) {
    for (let i = 0; i < 4; i++) {
        if ((bytes[offset + i] ?? 0) !== ip[i])
            return false;
    }
    return true;
}
export function formatIp(ip) {
    return ip.join('.');
}
export function formatMac(mac) {
    return mac.map((b) => b.toString(16).padStart(2, '0')).join(':');
}
/** 14-byte ethernet II header + payload. */
export function buildEthernetFrame(dst, src, ethertype, payload) {
    const frame = new Uint8Array(14 + payload.length);
    frame.set(dst, 0);
    frame.set(src, 6);
    frame[12] = (ethertype >> 8) & 0xff;
    frame[13] = ethertype & 0xff;
    frame.set(payload, 14);
    return frame;
}
export function buildArp(op, senderMac, senderIp, targetMac, targetIp) {
    const p = new Uint8Array(28);
    p[0] = 0x00;
    p[1] = 0x01; // HTYPE ethernet
    p[2] = 0x08;
    p[3] = 0x00; // PTYPE IPv4
    p[4] = 6; // HLEN
    p[5] = 4; // PLEN
    p[6] = (op >> 8) & 0xff;
    p[7] = op & 0xff;
    p.set(senderMac, 8);
    p.set(senderIp, 14);
    p.set(targetMac, 18);
    p.set(targetIp, 24);
    return p;
}
/** Parse an ARP body (frame payload after the ethernet header). Null if not ethernet/IPv4 ARP. */
export function parseArp(payload) {
    if (payload.length < 28)
        return null;
    if (payload[0] !== 0x00 || payload[1] !== 0x01)
        return null;
    if (payload[2] !== 0x08 || payload[3] !== 0x00)
        return null;
    if (payload[4] !== 6 || payload[5] !== 4)
        return null;
    const at = (o, n) => Array.from(payload.subarray(o, o + n));
    return {
        op: ((payload[6] ?? 0) << 8) | (payload[7] ?? 0),
        senderMac: at(8, 6),
        senderIp: at(14, 4),
        targetMac: at(18, 6),
        targetIp: at(24, 4),
    };
}
/** Parse an IPv4 packet (frame payload). Null on malformed/truncated. */
export function parseIpv4(payload) {
    if (payload.length < 20)
        return null;
    const versionIhl = payload[0] ?? 0;
    if (versionIhl >> 4 !== 4)
        return null;
    const headerLen = (versionIhl & 0x0f) * 4;
    if (headerLen < 20 || payload.length < headerLen)
        return null;
    const totalLen = ((payload[2] ?? 0) << 8) | (payload[3] ?? 0);
    if (totalLen < headerLen || totalLen > payload.length)
        return null;
    const at = (o, n) => Array.from(payload.subarray(o, o + n));
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
export function buildIpv4(protocol, srcIp, dstIp, payload, ipId = 0) {
    const totalLen = 20 + payload.length;
    const p = new Uint8Array(totalLen);
    p[0] = 0x45; // v4, IHL 5
    p[1] = 0x00; // DSCP/ECN
    p[2] = (totalLen >> 8) & 0xff;
    p[3] = totalLen & 0xff;
    p[4] = (ipId >> 8) & 0xff;
    p[5] = ipId & 0xff;
    p[6] = 0x00; // flags/frag
    p[7] = 0x00;
    p[8] = 64; // TTL
    p[9] = protocol & 0xff;
    p.set(srcIp, 12);
    p.set(dstIp, 16);
    const cks = internetChecksum(p, 0, 20);
    p[10] = (cks >> 8) & 0xff;
    p[11] = cks & 0xff;
    p.set(payload, 20);
    return p;
}
/** Build an ICMP echo request/reply with a correct checksum. */
export function buildIcmpEcho(type, id, seq, payload) {
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
/** Parse an ICMP echo request/reply. Null for other ICMP types/truncation. */
export function parseIcmpEcho(payload) {
    if (payload.length < 8)
        return null;
    const type = payload[0] ?? 0;
    if (type !== ICMP_ECHO_REQUEST && type !== ICMP_ECHO_REPLY)
        return null;
    return {
        type,
        id: ((payload[4] ?? 0) << 8) | (payload[5] ?? 0),
        seq: ((payload[6] ?? 0) << 8) | (payload[7] ?? 0),
        payload: payload.subarray(8),
    };
}
