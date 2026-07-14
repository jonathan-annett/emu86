/**
 * Minimal TCP engine (Phase 14 M3c listener core, grown for Phase 15
 * M1 — the M3d gateway).
 *
 * Born as a listener-only engine: ELKS resolves DNS over TCP
 * (`libc/net/in_resolv.c` — ktcp has no UDP at all), so the DNS
 * pseudo-host needed listening sockets ahead of M3d. Phase 15 M1 adds
 * what an HTTP gateway terminating connections to *arbitrary*
 * destinations needs — and nothing more. The guest is always the
 * initiator on this LAN, so there is still no client-side TCP (no
 * active open); the additions are:
 *
 *   - **Promiscuous accept** ({@link TcpStack.listenAny}): terminate a
 *     SYN addressed to any (IP, port). Each connection carries its own
 *     local identity — the destination the guest actually dialed — and
 *     all replies are checksummed and sourced from that identity.
 *   - **Active close** ({@link TcpConnection.close}): send our FIN once
 *     every queued byte has been transmitted (FIN-after-drain). The
 *     HTTP gateway answers and then closes; M3c's engine could only
 *     close passively.
 *   - **Window pacing**: outbound data now goes through a per-connection
 *     queue drained against the peer's advertised window (ktcp's is
 *     4380 — CB_NORMAL_BUFSIZ). Multi-KB HTTP bodies would otherwise
 *     overrun it; the lossless-wire argument covers loss, not overflow.
 *
 * The original guarantees still carry the design:
 *
 *   - **The wire is lossless and ordered** (`EthernetSwitch` dispatches
 *     synchronously, in order). No retransmission, no reassembly, no
 *     congestion control on our side. ktcp retransmits *its* data if
 *     un-ACKed, so every inbound data segment is ACKed immediately.
 *   - **ktcp is strictly in-order**: it drops any segment whose seqnum
 *     isn't exactly its rcv_nxt (`tcp.c:556`) and validates checksums,
 *     so outbound segments are precisely sequenced and checksummed
 *     (`wire.ts` builders).
 *   - **No timers.** Everything happens in frame-arrival callbacks
 *     (`cpu.step()` purity is untouched). TIME_WAIT is meaningless
 *     without a clock — connections are dropped at the final ACK.
 *     FIN-after-drain is also timerless: "after drain" means "in the
 *     pump that transmits the last queued byte", and the pump runs on
 *     send() and on every arriving ACK.
 *
 * Transport only: input is IPv4 payloads via {@link TcpStack.onSegment},
 * output goes through the injected `transmit(dstIp, segment, srcIp)`
 * callback (`srcIp` is the connection's local identity — single-identity
 * hosts like the DNS host may ignore it). Ethernet framing, ARP, and IP
 * wrapping belong to the pseudo-host that owns the stack.
 *
 * Close shapes:
 *   - Passive, handler-absent (M3c, unchanged wire trace): remote FIN →
 *     one combined FIN|ACK → LAST_ACK → dropped at the final ACK. If
 *     outbound data is still queued the FIN waits behind it (their FIN
 *     gets a plain ACK first).
 *   - Handler-owned ({@link TcpListenerHandler.onRemoteClose}): remote
 *     FIN is ACKed, the connection sits in close-wait (half-close: we
 *     may still send), and the handler calls `close()` when done.
 *   - Active (`close()` while established): FIN goes out when the queue
 *     drains; their ACK and their FIN retire the connection in either
 *     order (fin-wait → last-ack or straight drop).
 */

import {
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_RST,
  TCP_SYN,
  buildTcpSegment,
  formatIp,
  parseTcpSegment,
  type Ipv4,
  type TcpSegment,
} from './wire.js';

/** Max payload bytes per outbound segment — conservative vs ktcp's 1460 MSS. */
const SEGMENT_MSS = 536;

/** Receive window we advertise. ktcp's own is 4380 (CB_NORMAL_BUFSIZ). */
const RECEIVE_WINDOW = 4096;

type ConnState =
  | 'syn-received'
  | 'established'
  | 'close-wait' // their FIN seen and ACKed; our direction still open
  | 'fin-wait' // our FIN sent; theirs not yet seen
  | 'last-ack' // both FINs down; waiting on their ACK of ours
  | 'closed';

export interface TcpConnection {
  readonly remoteIp: Ipv4;
  readonly remotePort: number;
  /** The identity the guest dialed — per-connection under listenAny. */
  readonly localIp: Ipv4;
  readonly localPort: number;
  readonly state: ConnState;
  /** Queue `data` to the remote, paced against the peer's window. No-op once closing/closed. */
  send(data: Uint8Array): void;
  /** Close our direction: FIN goes out once every queued byte has been transmitted. */
  close(): void;
}

export interface TcpListenerHandler {
  /** Handshake completed (the connecting ACK arrived). */
  onConnect?(conn: TcpConnection): void;
  /** In-order application data from the remote (already ACKed). */
  onData(conn: TcpConnection, data: Uint8Array): void;
  /**
   * Remote sent FIN. If absent, the stack answers with its own FIN —
   * combined FIN|ACK when nothing is queued (passive close, the M3c
   * shape), or after the queue drains. If present, the handler owns
   * the close: the connection holds in close-wait (half-close — send()
   * still works) until the handler calls `conn.close()`.
   */
  onRemoteClose?(conn: TcpConnection): void;
  /** Connection fully closed (final ACK, or RST from the remote). */
  onClosed?(conn: TcpConnection): void;
}

class Connection implements TcpConnection {
  state: ConnState = 'syn-received';
  /** Next sequence number we will send. */
  sendNxt: number;
  /** Next sequence number we expect from the remote. */
  rcvNxt: number;
  /** Oldest of our sequence numbers not yet ACKed by the remote. */
  sndUna: number;
  /** The peer's advertised receive window, refreshed from every ACK. */
  peerWindow: number;

  /** Outbound byte queue: chunks plus an offset into the head chunk. */
  readonly outbound: Uint8Array[] = [];
  outboundHead = 0;
  outboundBytes = 0;

  closeRequested = false;
  ourFinSent = false;
  ourFinAcked = false;

  constructor(
    readonly stack: TcpStack,
    readonly remoteIp: Ipv4,
    readonly remotePort: number,
    readonly localIp: Ipv4,
    readonly localPort: number,
    readonly handler: TcpListenerHandler,
    iss: number,
    irs: number,
    peerWindow: number,
  ) {
    this.sendNxt = iss;
    this.sndUna = iss;
    this.rcvNxt = (irs + 1) >>> 0; // their SYN consumed one
    this.peerWindow = peerWindow;
  }

  send(data: Uint8Array): void {
    this.stack.sendData(this, data);
  }

  close(): void {
    this.stack.requestClose(this);
  }
}

export class TcpStack {
  readonly #localIp: Ipv4;
  readonly #transmit: (dstIp: Ipv4, segment: Uint8Array, srcIp: Ipv4) => void;
  readonly #listeners = new Map<number, TcpListenerHandler>();
  /** Catch-all for any (IP, port) — the promiscuous gateway terminator. */
  #anyListener: TcpListenerHandler | null = null;
  #anyAccept: ((localIp: Ipv4, localPort: number) => boolean) | null = null;
  /** `remoteIp|remotePort|localIp|localPort` → connection. */
  readonly #conns = new Map<string, Connection>();
  /** Deterministic ISS — no clocks on the LAN (and none allowed). */
  #nextIss = 0x0001_0000;

  // Counters for tests/diagnostics.
  resetsSent = 0;
  segmentsDroppedBadSeq = 0;
  sendsAfterClose = 0;
  /** Pump attempts parked on a full peer window (queue non-empty). */
  windowStalls = 0;

  constructor(opts: {
    localIp: Ipv4;
    transmit: (dstIp: Ipv4, segment: Uint8Array, srcIp: Ipv4) => void;
  }) {
    this.#localIp = opts.localIp;
    this.#transmit = opts.transmit;
  }

  listen(port: number, handler: TcpListenerHandler): void {
    if (this.#listeners.has(port)) {
      throw new Error(`TcpStack: port ${port} already has a listener`);
    }
    this.#listeners.set(port, handler);
  }

  /**
   * Accept SYNs to *any* destination the caller feeds in — connections
   * report the dialed identity via `localIp`/`localPort`. Exact-port
   * listeners still win; this is the fallback. The caller decides which
   * destinations reach the stack at all (the gateway feeds only
   * off-subnet traffic). A SYN the optional `accept` predicate declines
   * falls through to the RST path — an honest connection-refused for
   * ports the terminator cannot serve (:443 — fetch owns TLS).
   */
  listenAny(handler: TcpListenerHandler, accept?: (localIp: Ipv4, localPort: number) => boolean): void {
    if (this.#anyListener !== null) {
      throw new Error('TcpStack: already has a listenAny handler');
    }
    this.#anyListener = handler;
    this.#anyAccept = accept ?? null;
  }

  /** Number of live (non-closed) connections — for tests. */
  get connectionCount(): number {
    return this.#conns.size;
  }

  /**
   * Feed one IPv4 payload carrying TCP. `srcIp` must be the packet's
   * source address and `dstIp` its destination (both checksum
   * pseudo-header inputs). `dstIp` defaults to the stack's own IP —
   * single-identity hosts omit it; the promiscuous gateway passes the
   * real destination through.
   */
  onSegment(srcIp: Ipv4, bytes: Uint8Array, dstIp: Ipv4 = this.#localIp): void {
    const seg = parseTcpSegment(srcIp, dstIp, bytes);
    if (seg === null) return; // truncated or bad checksum

    const key = connKey(srcIp, seg.srcPort, dstIp, seg.dstPort);
    const conn = this.#conns.get(key);

    if (conn === undefined) {
      this.#onNoConnection(srcIp, dstIp, seg, key);
      return;
    }
    if ((seg.flags & TCP_RST) !== 0) {
      this.#drop(conn, key);
      return;
    }
    if ((seg.flags & TCP_SYN) !== 0 && conn.state === 'syn-received') {
      // Duplicate SYN (impossible on a lossless wire, cheap to honour):
      // re-send the SYN|ACK.
      this.#sendSynAck(conn);
      return;
    }

    if (seg.seq !== conn.rcvNxt) {
      // Out-of-sequence — a retransmission of something already ACKed.
      // Re-ACK so the sender settles, then drop (mirrors ktcp's own
      // strictness; on this wire it indicates a bug worth counting).
      this.segmentsDroppedBadSeq++;
      this.#sendFlags(conn, TCP_ACK);
      return;
    }

    // ACK bookkeeping before state processing: advance snd_una, refresh
    // the peer window. The pump itself runs after the segment is fully
    // processed so our replies stay sequence-consistent with any data
    // ACK below.
    if ((seg.flags & TCP_ACK) !== 0 && conn.state !== 'syn-received') {
      const acked = (seg.ack - conn.sndUna) >>> 0;
      const inFlight = (conn.sendNxt - conn.sndUna) >>> 0;
      if (acked > 0 && acked <= inFlight) {
        conn.sndUna = seg.ack;
        if (conn.ourFinSent && conn.sndUna === conn.sendNxt) {
          conn.ourFinAcked = true;
        }
      }
      conn.peerWindow = seg.window;
    }

    switch (conn.state) {
      case 'syn-received':
        if ((seg.flags & TCP_ACK) !== 0 && seg.ack === conn.sendNxt) {
          conn.state = 'established';
          conn.sndUna = seg.ack;
          conn.peerWindow = seg.window;
          conn.handler.onConnect?.(conn);
          // ktcp never sends data on the connecting ACK; if it did,
          // established processing below would be needed. Guarded by
          // the payload check in tests.
          if (seg.payload.length > 0) this.#onEstablishedSegment(conn, seg);
        }
        break;
      case 'established':
        this.#onEstablishedSegment(conn, seg);
        break;
      case 'close-wait':
        // Their direction is finished — only ACKs (window updates for
        // our still-open direction) arrive here. Data would be a peer
        // bug; the strict-sequence check already re-ACKed anything old.
        break;
      case 'fin-wait':
        this.#onFinWaitSegment(conn, seg, key);
        break;
      case 'last-ack':
        if ((seg.flags & TCP_ACK) !== 0 && seg.ack === conn.sendNxt) {
          this.#drop(conn, key);
          return;
        }
        break;
      case 'closed':
        return;
    }

    const live = this.#conns.get(key);
    if (live !== undefined) this.#pump(live);
  }

  /** Called by Connection.send — queue, then transmit what the window allows. */
  sendData(conn: Connection, data: Uint8Array): void {
    const open =
      (conn.state === 'established' || conn.state === 'close-wait') && !conn.closeRequested;
    if (!open) {
      this.sendsAfterClose++;
      return;
    }
    if (data.length > 0) {
      conn.outbound.push(data);
      conn.outboundBytes += data.length;
    }
    this.#pump(conn);
  }

  /** Called by Connection.close — FIN once the queue has fully transmitted. */
  requestClose(conn: Connection): void {
    if (conn.closeRequested || conn.state === 'closed') return;
    conn.closeRequested = true;
    this.#pump(conn);
  }

  #onEstablishedSegment(conn: Connection, seg: TcpSegment): void {
    // Inbound data: advance rcv_nxt and ACK before delivering — the
    // handler may transmit from inside onData, and ktcp needs the ACK
    // sequence-consistent with those later segments.
    if (seg.payload.length > 0) {
      conn.rcvNxt = (conn.rcvNxt + seg.payload.length) >>> 0;
      this.#sendFlags(conn, TCP_ACK);
      conn.handler.onData(conn, Uint8Array.from(seg.payload));
      if (conn.state !== 'established') return; // handler closed us
    }

    if ((seg.flags & TCP_FIN) !== 0) {
      conn.rcvNxt = (conn.rcvNxt + 1) >>> 0;
      if (conn.handler.onRemoteClose !== undefined) {
        this.#sendFlags(conn, TCP_ACK);
        conn.state = 'close-wait';
        conn.handler.onRemoteClose(conn);
        return;
      }
      if (conn.outboundBytes === 0 && !conn.closeRequested) {
        // Passive close, combined: ACK their FIN and carry ours in one
        // segment. ktcp's FIN_WAIT_1 takes this to TIME_WAIT and ACKs
        // our FIN, which lands in last-ack processing.
        this.#sendFlags(conn, TCP_FIN | TCP_ACK);
        conn.sendNxt = (conn.sendNxt + 1) >>> 0; // our FIN consumed one
        conn.ourFinSent = true;
        conn.closeRequested = true;
        conn.state = 'last-ack';
        return;
      }
      // Data still queued (or close already requested): plain-ACK their
      // FIN now; ours follows from the pump when the queue drains.
      this.#sendFlags(conn, TCP_ACK);
      conn.closeRequested = true;
      conn.state = 'close-wait';
    }
  }

  #onFinWaitSegment(conn: Connection, seg: TcpSegment, key: string): void {
    // Half-close: our FIN is out, but the remote may keep sending until
    // its own FIN. Deliver and ACK data exactly as when established.
    if (seg.payload.length > 0) {
      conn.rcvNxt = (conn.rcvNxt + seg.payload.length) >>> 0;
      this.#sendFlags(conn, TCP_ACK);
      conn.handler.onData(conn, Uint8Array.from(seg.payload));
      if (conn.state !== 'fin-wait') return;
    }

    if ((seg.flags & TCP_FIN) !== 0) {
      conn.rcvNxt = (conn.rcvNxt + 1) >>> 0;
      this.#sendFlags(conn, TCP_ACK);
      if (conn.ourFinAcked) {
        this.#drop(conn, key);
        return;
      }
      conn.state = 'last-ack';
    }
  }

  #onNoConnection(srcIp: Ipv4, dstIp: Ipv4, seg: TcpSegment, key: string): void {
    if ((seg.flags & TCP_RST) !== 0) return;

    if ((seg.flags & TCP_SYN) !== 0) {
      let handler = this.#listeners.get(seg.dstPort);
      if (handler === undefined && this.#anyListener !== null) {
        if (this.#anyAccept === null || this.#anyAccept(dstIp, seg.dstPort)) {
          handler = this.#anyListener;
        }
      }
      if (handler !== undefined) {
        const conn = new Connection(
          this,
          srcIp,
          seg.srcPort,
          dstIp,
          seg.dstPort,
          handler,
          this.#nextIss,
          seg.seq,
          seg.window,
        );
        this.#nextIss = (this.#nextIss + 0x10000) >>> 0;
        this.#conns.set(key, conn);
        this.#sendSynAck(conn);
        conn.sendNxt = (conn.sendNxt + 1) >>> 0; // our SYN consumed one
        conn.sndUna = conn.sendNxt;
        return;
      }
    }

    // No listener / no connection: refuse, like ktcp's tcp_reject —
    // keeps the guest from waiting out its own timeout on a typo'd port.
    // The RST speaks as the identity that was dialed.
    this.resetsSent++;
    const rst: TcpSegment =
      (seg.flags & TCP_ACK) !== 0
        ? {
            srcPort: seg.dstPort,
            dstPort: seg.srcPort,
            seq: seg.ack,
            ack: 0,
            flags: TCP_RST,
            window: 0,
            payload: new Uint8Array(0),
          }
        : {
            srcPort: seg.dstPort,
            dstPort: seg.srcPort,
            seq: 0,
            ack:
              (seg.seq +
                seg.payload.length +
                ((seg.flags & TCP_SYN) !== 0 || (seg.flags & TCP_FIN) !== 0 ? 1 : 0)) >>>
              0,
            flags: TCP_RST | TCP_ACK,
            window: 0,
            payload: new Uint8Array(0),
          };
    this.#transmit(srcIp, buildTcpSegment(dstIp, srcIp, rst), dstIp);
  }

  /**
   * Transmit queued data up to the peer's advertised window, and the
   * FIN once a requested close finds the queue empty. Runs after every
   * inbound segment, on send(), and on close() — the only three moments
   * anything can change on a timerless stack.
   */
  #pump(conn: Connection): void {
    while (conn.outboundBytes > 0) {
      const inFlight = (conn.sendNxt - conn.sndUna) >>> 0;
      const usable = conn.peerWindow - inFlight;
      if (usable <= 0) {
        this.windowStalls++;
        return; // the next ACK reopens the window and re-runs the pump
      }
      const len = Math.min(SEGMENT_MSS, usable, conn.outboundBytes);
      this.#send(conn, TCP_PSH | TCP_ACK, this.#dequeue(conn, len));
      conn.sendNxt = (conn.sendNxt + len) >>> 0;
    }

    if (conn.closeRequested && !conn.ourFinSent) {
      this.#sendFlags(conn, TCP_FIN | TCP_ACK);
      conn.sendNxt = (conn.sendNxt + 1) >>> 0; // our FIN consumed one
      conn.ourFinSent = true;
      conn.state = conn.state === 'close-wait' ? 'last-ack' : 'fin-wait';
    }
  }

  /** Take exactly `len` bytes off the head of the outbound queue. */
  #dequeue(conn: Connection, len: number): Uint8Array {
    const out = new Uint8Array(len);
    let filled = 0;
    while (filled < len) {
      const head = conn.outbound[0];
      if (head === undefined) break; // unreachable: outboundBytes tracks the chunks
      const avail = head.length - conn.outboundHead;
      const take = Math.min(avail, len - filled);
      out.set(head.subarray(conn.outboundHead, conn.outboundHead + take), filled);
      filled += take;
      conn.outboundHead += take;
      if (conn.outboundHead === head.length) {
        conn.outbound.shift();
        conn.outboundHead = 0;
      }
    }
    conn.outboundBytes -= filled;
    return out;
  }

  #sendSynAck(conn: Connection): void {
    this.#send(conn, TCP_SYN | TCP_ACK, new Uint8Array(0));
  }

  #sendFlags(conn: Connection, flags: number): void {
    this.#send(conn, flags, new Uint8Array(0));
  }

  #send(conn: Connection, flags: number, payload: Uint8Array): void {
    this.#transmit(
      conn.remoteIp,
      buildTcpSegment(conn.localIp, conn.remoteIp, {
        srcPort: conn.localPort,
        dstPort: conn.remotePort,
        seq: conn.sendNxt,
        ack: conn.rcvNxt,
        flags,
        window: RECEIVE_WINDOW,
        payload,
      }),
      conn.localIp,
    );
  }

  #drop(conn: Connection, key: string): void {
    conn.state = 'closed';
    this.#conns.delete(key);
    conn.handler.onClosed?.(conn);
  }

  #keyOf(conn: Connection): string {
    return connKey(conn.remoteIp, conn.remotePort, conn.localIp, conn.localPort);
  }
}

function connKey(remoteIp: Ipv4, remotePort: number, localIp: Ipv4, localPort: number): string {
  return `${formatIp(remoteIp)}:${remotePort}|${formatIp(localIp)}:${localPort}`;
}
