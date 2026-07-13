/**
 * TcpStack unit tests (Phase 14 M3c).
 *
 * A scripted "guest" plays ktcp's role: it builds real checksummed
 * segments with the wire helpers, feeds them to the stack, and asserts
 * on what the stack transmits back — sequence numbers, flags, and the
 * combined FIN|ACK passive close that ktcp's FIN_WAIT_1 path expects.
 */

import { describe, it, expect } from 'vitest';
import { TcpStack, type TcpConnection } from '../../src/net/tcp.js';
import {
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_RST,
  TCP_SYN,
  buildTcpSegment,
  parseTcpSegment,
  type Ipv4,
  type TcpSegment,
} from '../../src/net/wire.js';

const HOST_IP: Ipv4 = [10, 0, 2, 3];
const GUEST_IP: Ipv4 = [10, 0, 2, 15];
const PORT = 53;
const GUEST_PORT = 1024;

interface Harness {
  stack: TcpStack;
  sent: TcpSegment[];
  /** Segments the stack transmitted, parsed; clears the buffer. */
  take(): TcpSegment[];
  /** Feed one guest→stack segment (real checksum). */
  feed(seg: Pick<TcpSegment, 'seq' | 'ack' | 'flags'> & Partial<TcpSegment>): void;
  conns: TcpConnection[];
  received: Array<{ conn: TcpConnection; data: Uint8Array }>;
  closed: TcpConnection[];
}

function makeHarness(): Harness {
  const sent: TcpSegment[] = [];
  const stack = new TcpStack({
    localIp: HOST_IP,
    transmit: (dstIp, segment) => {
      expect(dstIp).toEqual(GUEST_IP);
      const parsed = parseTcpSegment(HOST_IP, dstIp, segment);
      expect(parsed).not.toBeNull(); // our own checksums must verify
      if (parsed !== null) sent.push(parsed);
    },
  });
  const h: Harness = {
    stack,
    sent,
    take: () => sent.splice(0, sent.length),
    feed: (seg) => {
      stack.onSegment(
        GUEST_IP,
        buildTcpSegment(GUEST_IP, HOST_IP, {
          srcPort: GUEST_PORT,
          dstPort: PORT,
          window: 4380,
          payload: new Uint8Array(0),
          ...seg,
        }),
      );
    },
    conns: [],
    received: [],
    closed: [],
  };
  stack.listen(PORT, {
    onConnect: (conn) => h.conns.push(conn),
    onData: (conn, data) => h.received.push({ conn, data }),
    onClosed: (conn) => h.closed.push(conn),
  });
  return h;
}

/** Run the three-way handshake; returns the stack's ISS. */
function handshake(h: Harness, guestIss = 5000): number {
  h.feed({ seq: guestIss, ack: 0, flags: TCP_SYN });
  const [synAck] = h.take();
  expect(synAck).toBeDefined();
  expect(synAck?.flags).toBe(TCP_SYN | TCP_ACK);
  expect(synAck?.ack).toBe(guestIss + 1);
  const iss = synAck?.seq ?? 0;
  h.feed({ seq: guestIss + 1, ack: iss + 1, flags: TCP_ACK });
  expect(h.take()).toHaveLength(0); // pure ACK is not answered (ktcp symmetry)
  expect(h.conns).toHaveLength(1);
  return iss;
}

describe('TcpStack — handshake and data', () => {
  it('completes SYN → SYN|ACK → ACK and reports the connection', () => {
    const h = makeHarness();
    handshake(h);
    expect(h.stack.connectionCount).toBe(1);
  });

  it('ACKs inbound data before delivering it, exactly once', () => {
    const h = makeHarness();
    const iss = handshake(h);
    const query = Uint8Array.from([0, 3, 0xaa, 0xbb, 0xcc]);
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_PSH | TCP_ACK, payload: query });
    const out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_ACK);
    expect(out[0]?.ack).toBe(5001 + query.length);
    expect(h.received).toHaveLength(1);
    expect(Array.from(h.received[0]?.data ?? [])).toEqual(Array.from(query));
  });

  it('sends application data as PSH|ACK with contiguous sequence numbers', () => {
    const h = makeHarness();
    const iss = handshake(h);
    const big = Uint8Array.from({ length: 1200 }, (_, i) => i & 0xff);
    h.conns[0]?.send(big);
    const out = h.take();
    expect(out).toHaveLength(3); // 536 + 536 + 128
    expect(out[0]?.seq).toBe(iss + 1);
    expect(out[1]?.seq).toBe(iss + 1 + 536);
    expect(out[2]?.seq).toBe(iss + 1 + 1072);
    expect(out.every((s) => s.flags === (TCP_PSH | TCP_ACK))).toBe(true);
    const reassembled = out.flatMap((s) => Array.from(s.payload));
    expect(reassembled).toEqual(Array.from(big));
  });
});

describe('TcpStack — close paths', () => {
  it('passively closes with a combined FIN|ACK and drops on the final ACK', () => {
    const h = makeHarness();
    const iss = handshake(h);
    // Guest closes (in_resolv's close after read): FIN|ACK.
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_FIN | TCP_ACK });
    const out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_FIN | TCP_ACK);
    expect(out[0]?.ack).toBe(5002); // their FIN consumed one
    expect(out[0]?.seq).toBe(iss + 1);
    expect(h.stack.connectionCount).toBe(1); // last-ack, not gone yet
    // Guest ACKs our FIN → connection drops.
    h.feed({ seq: 5002, ack: iss + 2, flags: TCP_ACK });
    expect(h.stack.connectionCount).toBe(0);
    expect(h.closed).toHaveLength(1);
  });

  it('drops the connection immediately on RST', () => {
    const h = makeHarness();
    handshake(h);
    h.feed({ seq: 5001, ack: 0, flags: TCP_RST });
    expect(h.stack.connectionCount).toBe(0);
    expect(h.closed).toHaveLength(1);
    expect(h.take()).toHaveLength(0); // RST is not answered
  });

  it('send() after close is a counted no-op', () => {
    const h = makeHarness();
    const iss = handshake(h);
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_FIN | TCP_ACK });
    h.take();
    h.conns[0]?.send(Uint8Array.from([1, 2, 3])); // late DoH answer
    expect(h.take()).toHaveLength(0);
    expect(h.stack.sendsAfterClose).toBe(1);
  });
});

describe('TcpStack — refusal and robustness', () => {
  it('answers a SYN to a port with no listener with RST|ACK', () => {
    const h = makeHarness();
    h.stack.onSegment(
      GUEST_IP,
      buildTcpSegment(GUEST_IP, HOST_IP, {
        srcPort: GUEST_PORT,
        dstPort: 80, // nobody listens
        seq: 7000,
        ack: 0,
        flags: TCP_SYN,
        window: 4380,
        payload: new Uint8Array(0),
      }),
    );
    const out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_RST | TCP_ACK);
    expect(out[0]?.ack).toBe(7001);
    expect(h.stack.resetsSent).toBe(1);
  });

  it('re-ACKs and drops an out-of-sequence segment', () => {
    const h = makeHarness();
    const iss = handshake(h);
    const data = Uint8Array.from([1, 2, 3, 4]);
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_PSH | TCP_ACK, payload: data });
    h.take();
    // The same segment again (a retransmission): must not re-deliver.
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_PSH | TCP_ACK, payload: data });
    const out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_ACK);
    expect(out[0]?.ack).toBe(5005); // still the true rcv_nxt
    expect(h.received).toHaveLength(1); // delivered once only
    expect(h.stack.segmentsDroppedBadSeq).toBe(1);
  });

  it('ignores segments with corrupted checksums', () => {
    const h = makeHarness();
    handshake(h);
    const seg = buildTcpSegment(GUEST_IP, HOST_IP, {
      srcPort: GUEST_PORT,
      dstPort: PORT,
      seq: 5001,
      ack: 1,
      flags: TCP_PSH | TCP_ACK,
      window: 4380,
      payload: Uint8Array.from([9]),
    });
    seg[16] = (seg[16] ?? 0) ^ 0xff; // corrupt checksum
    h.stack.onSegment(GUEST_IP, seg);
    expect(h.take()).toHaveLength(0);
    expect(h.received).toHaveLength(0);
  });

  it('two interleaved connections keep independent sequence spaces', () => {
    const h = makeHarness();
    const iss1 = handshake(h, 5000);
    // Second connection from a different guest port.
    h.stack.onSegment(
      GUEST_IP,
      buildTcpSegment(GUEST_IP, HOST_IP, {
        srcPort: GUEST_PORT + 1,
        dstPort: PORT,
        seq: 9000,
        ack: 0,
        flags: TCP_SYN,
        window: 4380,
        payload: new Uint8Array(0),
      }),
    );
    const [synAck2] = h.take();
    expect(synAck2?.dstPort).toBe(GUEST_PORT + 1);
    expect(synAck2?.ack).toBe(9001);
    expect(synAck2?.seq).not.toBe(iss1); // distinct ISS per connection
    expect(h.stack.connectionCount).toBe(2);
  });
});
