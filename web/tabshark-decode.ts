/**
 * tab-shark's frame decoding (TAN-freeze M3) — DOM-free so it unit
 * tests like any other leaf module; tabshark.ts owns the page.
 */

import { nameForOctet } from '../src/net/tan-names.js';
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  IPPROTO_ICMP,
  IPPROTO_TCP,
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_RST,
  TCP_SYN,
  formatIp,
  parseArp,
  parseIcmpEcho,
  parseIpv4,
  parseTcpSegment,
  type Ipv4,
} from '../src/net/wire.js';

export function octetName(octet: number): string {
  return nameForOctet(octet) ?? `.${octet}`;
}

/** TAN-aware address naming: guests by animal, residents by role. */
export function ipName(ip: Ipv4): string {
  const [a, b, c, o] = ip;
  if (a === 10 && b === 0 && c === 2 && o !== undefined) {
    if (o === 2) return 'gateway';
    if (o === 3) return 'dns';
    return octetName(o);
  }
  return formatIp(ip);
}

export function tcpFlagText(flags: number): string {
  const parts: string[] = [];
  if ((flags & TCP_SYN) !== 0) parts.push('SYN');
  if ((flags & TCP_FIN) !== 0) parts.push('FIN');
  if ((flags & TCP_RST) !== 0) parts.push('RST');
  if ((flags & TCP_PSH) !== 0) parts.push('PSH');
  if ((flags & TCP_ACK) !== 0) parts.push('ACK');
  return parts.join('|');
}

/** One human line per frame: ARP conversations, TCP with ports/flags/
 *  len, ICMP echo as ping/pong, anything else by its numbers. */
export function decodeFrame(frame: Uint8Array): string {
  if (frame.length < 14) return `runt frame (${frame.length} B)`;
  const ethertype = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
  if (ethertype === ETHERTYPE_ARP) {
    const arp = parseArp(frame.subarray(14));
    if (arp === null) return 'ARP (malformed)';
    return arp.op === 1
      ? `ARP who-has ${ipName(arp.targetIp)}? asks ${ipName(arp.senderIp)}`
      : `ARP ${ipName(arp.senderIp)} is-at (reply to ${ipName(arp.targetIp)})`;
  }
  if (ethertype === ETHERTYPE_IPV4) {
    const ip = parseIpv4(frame.subarray(14));
    if (ip === null) return 'IPv4 (malformed)';
    const src = ipName(ip.srcIp);
    const dst = ipName(ip.dstIp);
    if (ip.protocol === IPPROTO_TCP) {
      const seg = parseTcpSegment(ip.srcIp, ip.dstIp, ip.payload);
      if (seg === null) return `${src} → ${dst} TCP (bad checksum)`;
      const flags = tcpFlagText(seg.flags);
      return `${src}:${seg.srcPort} → ${dst}:${seg.dstPort} [${flags}] len=${seg.payload.length}`;
    }
    if (ip.protocol === IPPROTO_ICMP) {
      const echo = parseIcmpEcho(ip.payload);
      if (echo !== null) {
        const kind =
          echo.type === ICMP_ECHO_REQUEST ? 'ping' :
          echo.type === ICMP_ECHO_REPLY ? 'pong' : `icmp t=${echo.type}`;
        return `${src} → ${dst} ${kind} seq=${echo.seq}`;
      }
      return `${src} → ${dst} ICMP`;
    }
    return `${src} → ${dst} proto=${ip.protocol} len=${ip.payload.length}`;
  }
  return `ethertype 0x${ethertype.toString(16).padStart(4, '0')} (${frame.length} B)`;
}
