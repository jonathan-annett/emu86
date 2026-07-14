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
  remoteClosed: TcpConnection[];
  closed: TcpConnection[];
}

function makeHarness(opts: { ownClose?: boolean } = {}): Harness {
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
    remoteClosed: [],
    closed: [],
  };
  stack.listen(PORT, {
    onConnect: (conn) => h.conns.push(conn),
    onData: (conn, data) => h.received.push({ conn, data }),
    ...(opts.ownClose === true
      ? { onRemoteClose: (conn: TcpConnection) => h.remoteClosed.push(conn) }
      : {}),
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

describe('TcpStack — active close (Phase 15 M1)', () => {
  it('close() on an idle connection sends FIN|ACK and retires cleanly', () => {
    const h = makeHarness();
    const iss = handshake(h);
    h.conns[0]?.close();
    let out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_FIN | TCP_ACK);
    expect(out[0]?.seq).toBe(iss + 1);
    expect(h.conns[0]?.state).toBe('fin-wait');
    // Guest ACKs our FIN — nothing to say back.
    h.feed({ seq: 5001, ack: iss + 2, flags: TCP_ACK });
    expect(h.take()).toHaveLength(0);
    // Guest's own FIN → final ACK from us, connection gone.
    h.feed({ seq: 5001, ack: iss + 2, flags: TCP_FIN | TCP_ACK });
    out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_ACK);
    expect(out[0]?.ack).toBe(5002);
    expect(h.stack.connectionCount).toBe(0);
    expect(h.closed).toHaveLength(1);
  });

  it('send() after close() is a counted no-op', () => {
    const h = makeHarness();
    handshake(h);
    h.conns[0]?.close();
    h.take();
    h.conns[0]?.send(Uint8Array.from([1]));
    expect(h.take()).toHaveLength(0);
    expect(h.stack.sendsAfterClose).toBe(1);
  });

  it('holds the FIN behind queued data until the window lets it drain', () => {
    const h = makeHarness();
    h.feed({ seq: 5000, ack: 0, flags: TCP_SYN, window: 600 });
    const [synAck] = h.take();
    const iss = synAck?.seq ?? 0;
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_ACK, window: 600 });
    h.take();
    const body = Uint8Array.from({ length: 1200 }, (_, i) => i & 0xff);
    h.conns[0]?.send(body);
    h.conns[0]?.close();
    let out = h.take();
    // Window 600: 536 + 64 in flight, 600 still queued — the FIN waits.
    expect(out.map((s) => s.payload.length)).toEqual([536, 64]);
    expect(out.every((s) => s.flags === (TCP_PSH | TCP_ACK))).toBe(true);
    expect(h.stack.windowStalls).toBeGreaterThan(0);
    // Guest ACKs the first 600: the rest drains and the FIN follows it out.
    h.feed({ seq: 5001, ack: iss + 1 + 600, flags: TCP_ACK, window: 600 });
    out = h.take();
    expect(out.map((s) => s.payload.length)).toEqual([536, 64, 0]);
    expect(out[2]?.flags).toBe(TCP_FIN | TCP_ACK);
    expect(out[2]?.seq).toBe(iss + 1 + 1200);
    // Their FIN (ACKing ours) retires the connection.
    h.feed({ seq: 5001, ack: iss + 1 + 1200 + 1, flags: TCP_FIN | TCP_ACK, window: 600 });
    out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_ACK);
    expect(h.stack.connectionCount).toBe(0);
    expect(h.closed).toHaveLength(1);
  });

  it('onRemoteClose hands the close to the handler: half-close, send, then close()', () => {
    const h = makeHarness({ ownClose: true });
    const iss = handshake(h);
    // Guest FIN → plain ACK (no combined FIN|ACK), handler owns the rest.
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_FIN | TCP_ACK });
    let out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_ACK);
    expect(out[0]?.ack).toBe(5002);
    expect(h.remoteClosed).toHaveLength(1);
    expect(h.conns[0]?.state).toBe('close-wait');
    // Half-close: our direction still sends.
    h.conns[0]?.send(Uint8Array.from([1, 2, 3]));
    out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_PSH | TCP_ACK);
    expect(out[0]?.seq).toBe(iss + 1);
    // Handler closes: FIN goes out, final ACK retires the connection.
    h.conns[0]?.close();
    out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.flags).toBe(TCP_FIN | TCP_ACK);
    h.feed({ seq: 5002, ack: iss + 1 + 3 + 1, flags: TCP_ACK });
    expect(h.stack.connectionCount).toBe(0);
    expect(h.closed).toHaveLength(1);
  });
});

describe('TcpStack — window pacing (Phase 15 M1)', () => {
  it('paces a large send against the advertised window, resuming per ACK', () => {
    const h = makeHarness();
    h.feed({ seq: 5000, ack: 0, flags: TCP_SYN, window: 1000 });
    const [synAck] = h.take();
    const iss = synAck?.seq ?? 0;
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_ACK, window: 1000 });
    h.take();
    const big = Uint8Array.from({ length: 3000 }, (_, i) => i & 0xff);
    h.conns[0]?.send(big);
    const rounds: number[][] = [h.take().map((s) => s.payload.length)];
    h.feed({ seq: 5001, ack: iss + 1 + 1000, flags: TCP_ACK, window: 1000 });
    rounds.push(h.take().map((s) => s.payload.length));
    h.feed({ seq: 5001, ack: iss + 1 + 2000, flags: TCP_ACK, window: 1000 });
    rounds.push(h.take().map((s) => s.payload.length));
    expect(rounds).toEqual([
      [536, 464],
      [536, 464],
      [536, 464],
    ]);
    // Everything ACKed, nothing queued — the final ACK is not answered.
    h.feed({ seq: 5001, ack: iss + 1 + 3000, flags: TCP_ACK, window: 1000 });
    expect(h.take()).toHaveLength(0);
    // The full body arrived, in order.
    const sentBytes = [536, 464, 536, 464, 536, 464].reduce((a, b) => a + b, 0);
    expect(sentBytes).toBe(big.length);
  });

  it('parks sends on a zero window and resumes on a window update', () => {
    const h = makeHarness();
    const iss = handshake(h);
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_ACK, window: 0 });
    h.conns[0]?.send(Uint8Array.from([9, 9, 9]));
    expect(h.take()).toHaveLength(0);
    expect(h.stack.windowStalls).toBe(1);
    h.feed({ seq: 5001, ack: iss + 1, flags: TCP_ACK, window: 4380 });
    const out = h.take();
    expect(out).toHaveLength(1);
    expect(Array.from(out[0]?.payload ?? [])).toEqual([9, 9, 9]);
  });
});

describe('TcpStack — promiscuous accept (Phase 15 M1)', () => {
  const GATEWAY_IP: Ipv4 = [10, 0, 2, 2];
  const WEB_IP: Ipv4 = [93, 184, 216, 34];
  const WEB2_IP: Ipv4 = [1, 1, 1, 1];

  interface AnyHarness {
    stack: TcpStack;
    sent: Array<{ seg: TcpSegment; srcIp: Ipv4; dstIp: Ipv4 }>;
    take(): Array<{ seg: TcpSegment; srcIp: Ipv4; dstIp: Ipv4 }>;
    feed(
      dstIp: Ipv4,
      seg: Pick<TcpSegment, 'seq' | 'ack' | 'flags' | 'dstPort'> & Partial<TcpSegment>,
    ): void;
    conns: TcpConnection[];
    received: Array<{ conn: TcpConnection; data: Uint8Array }>;
    closed: TcpConnection[];
  }

  function makeAnyHarness(): AnyHarness {
    const sent: AnyHarness['sent'] = [];
    const stack = new TcpStack({
      localIp: GATEWAY_IP,
      transmit: (dstIp, segment, srcIp) => {
        expect(dstIp).toEqual(GUEST_IP);
        const parsed = parseTcpSegment(srcIp, dstIp, segment);
        expect(parsed).not.toBeNull(); // checksummed against the dialed identity
        if (parsed !== null) sent.push({ seg: parsed, srcIp, dstIp });
      },
    });
    const h: AnyHarness = {
      stack,
      sent,
      take: () => sent.splice(0, sent.length),
      feed: (dstIp, seg) => {
        stack.onSegment(
          GUEST_IP,
          buildTcpSegment(GUEST_IP, dstIp, {
            srcPort: GUEST_PORT,
            window: 4380,
            payload: new Uint8Array(0),
            ...seg,
          }),
          dstIp,
        );
      },
      conns: [],
      received: [],
      closed: [],
    };
    stack.listenAny({
      onConnect: (conn) => h.conns.push(conn),
      onData: (conn, data) => h.received.push({ conn, data }),
      onClosed: (conn) => h.closed.push(conn),
    });
    return h;
  }

  it('terminates a connection to an arbitrary destination under its identity', () => {
    const h = makeAnyHarness();
    h.feed(WEB_IP, { dstPort: 80, seq: 5000, ack: 0, flags: TCP_SYN });
    const [synAck] = h.take();
    expect(synAck).toBeDefined();
    expect(synAck?.seg.flags).toBe(TCP_SYN | TCP_ACK);
    expect(synAck?.srcIp).toEqual(WEB_IP); // replies speak as the dialed IP
    const iss = synAck?.seg.seq ?? 0;
    h.feed(WEB_IP, { dstPort: 80, seq: 5001, ack: iss + 1, flags: TCP_ACK });
    expect(h.conns).toHaveLength(1);
    expect(h.conns[0]?.localIp).toEqual(WEB_IP);
    expect(h.conns[0]?.localPort).toBe(80);
    // Request/response round-trip under the dialed identity.
    const req = Uint8Array.from([71, 69, 84]); // "GET"
    h.feed(WEB_IP, { dstPort: 80, seq: 5001, ack: iss + 1, flags: TCP_PSH | TCP_ACK, payload: req });
    expect(h.take()[0]?.seg.flags).toBe(TCP_ACK);
    expect(h.received).toHaveLength(1);
    h.conns[0]?.send(Uint8Array.from([79, 75])); // "OK"
    const out = h.take();
    expect(out[0]?.seg.flags).toBe(TCP_PSH | TCP_ACK);
    expect(out[0]?.srcIp).toEqual(WEB_IP);
  });

  it('keeps connections to different destinations on the same ports independent', () => {
    const h = makeAnyHarness();
    h.feed(WEB_IP, { dstPort: 80, seq: 5000, ack: 0, flags: TCP_SYN });
    h.feed(WEB2_IP, { dstPort: 80, seq: 7000, ack: 0, flags: TCP_SYN });
    const out = h.take();
    expect(out).toHaveLength(2);
    expect(out[0]?.srcIp).toEqual(WEB_IP);
    expect(out[1]?.srcIp).toEqual(WEB2_IP);
    expect(out[0]?.seg.seq).not.toBe(out[1]?.seg.seq); // distinct ISS
    expect(h.stack.connectionCount).toBe(2);
  });

  it('answers a non-SYN segment for an unknown connection with an RST from the dialed identity', () => {
    const h = makeAnyHarness();
    h.feed(WEB_IP, { dstPort: 80, seq: 6000, ack: 123, flags: TCP_ACK });
    const out = h.take();
    expect(out).toHaveLength(1);
    expect(out[0]?.seg.flags).toBe(TCP_RST);
    expect(out[0]?.srcIp).toEqual(WEB_IP);
    expect(h.stack.resetsSent).toBe(1);
  });

  it('exact-port listeners win over the listenAny fallback', () => {
    const h = makeAnyHarness();
    const portConns: TcpConnection[] = [];
    h.stack.listen(53, {
      onConnect: (conn) => portConns.push(conn),
      onData: () => undefined,
    });
    h.feed(WEB_IP, { dstPort: 53, seq: 5000, ack: 0, flags: TCP_SYN });
    const [synAck] = h.take();
    const iss = synAck?.seg.seq ?? 0;
    h.feed(WEB_IP, { dstPort: 53, seq: 5001, ack: iss + 1, flags: TCP_ACK });
    expect(portConns).toHaveLength(1); // the port listener got it…
    expect(h.conns).toHaveLength(0); // …not the catch-all
  });
});
