/**
 * Minimal TCP listener engine (Phase 14 M3c).
 *
 * Pulled forward from M3d by a guest reality: ELKS resolves DNS over
 * TCP (`libc/net/in_resolv.c` — ktcp has no UDP at all), so the DNS
 * pseudo-host needs listening sockets. This is the smallest engine
 * that satisfies ktcp's `tcp.c`, exploiting what the browser-side LAN
 * guarantees:
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
 *
 * Transport only: input is IPv4 payloads via {@link TcpStack.onSegment},
 * output goes through the injected `transmit(dstIp, segment)` callback.
 * Ethernet framing, ARP, and IP wrapping belong to the pseudo-host
 * that owns the stack (`dns.ts` first; M3d's HTTP gateway later).
 *
 * Close shape: when the remote FIN arrives, the stack ACKs-and-FINs in
 * one segment (→ LAST_ACK) unless the handler supplies `onRemoteClose`
 * and takes over. That matches `in_resolv()`'s lifecycle — the guest
 * always closes first (write, read, close) — and ktcp's FIN_WAIT_1
 * handles the combined FIN|ACK fine (`tcp_fin_wait_1`: FIN → CLOSING,
 * ACK-of-our-FIN → TIME_WAIT).
 */
import { TCP_ACK, TCP_FIN, TCP_PSH, TCP_RST, TCP_SYN, buildTcpSegment, formatIp, parseTcpSegment, } from './wire.js';
/** Max payload bytes per outbound segment — conservative vs ktcp's 1460 MSS. */
const SEGMENT_MSS = 536;
/** Receive window we advertise. ktcp's own is 4380 (CB_NORMAL_BUFSIZ). */
const RECEIVE_WINDOW = 4096;
class Connection {
    stack;
    remoteIp;
    remotePort;
    localPort;
    handler;
    state = 'syn-received';
    /** Next sequence number we will send. */
    sendNxt;
    /** Next sequence number we expect from the remote. */
    rcvNxt;
    constructor(stack, remoteIp, remotePort, localPort, handler, iss, irs) {
        this.stack = stack;
        this.remoteIp = remoteIp;
        this.remotePort = remotePort;
        this.localPort = localPort;
        this.handler = handler;
        this.sendNxt = iss;
        this.rcvNxt = (irs + 1) >>> 0; // their SYN consumed one
    }
    send(data) {
        this.stack.sendData(this, data);
    }
}
export class TcpStack {
    #localIp;
    #transmit;
    #listeners = new Map();
    /** `remoteIp|remotePort|localPort` → connection. */
    #conns = new Map();
    /** Deterministic ISS — no clocks on the LAN (and none allowed). */
    #nextIss = 0x0001_0000;
    // Counters for tests/diagnostics.
    resetsSent = 0;
    segmentsDroppedBadSeq = 0;
    sendsAfterClose = 0;
    constructor(opts) {
        this.#localIp = opts.localIp;
        this.#transmit = opts.transmit;
    }
    listen(port, handler) {
        if (this.#listeners.has(port)) {
            throw new Error(`TcpStack: port ${port} already has a listener`);
        }
        this.#listeners.set(port, handler);
    }
    /** Number of live (non-closed) connections — for tests. */
    get connectionCount() {
        return this.#conns.size;
    }
    /**
     * Feed one IPv4 payload carrying TCP. `srcIp` must be the packet's
     * source address (pseudo-header). Segments not addressed to our IP
     * should be filtered by the caller.
     */
    onSegment(srcIp, bytes) {
        const seg = parseTcpSegment(srcIp, this.#localIp, bytes);
        if (seg === null)
            return; // truncated or bad checksum
        const key = connKey(srcIp, seg.srcPort, seg.dstPort);
        const conn = this.#conns.get(key);
        if (conn === undefined) {
            this.#onNoConnection(srcIp, seg, key);
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
        switch (conn.state) {
            case 'syn-received':
                if ((seg.flags & TCP_ACK) !== 0 && seg.ack === conn.sendNxt) {
                    conn.state = 'established';
                    conn.handler.onConnect?.(conn);
                    // ktcp never sends data on the connecting ACK; if it did,
                    // established processing below would be needed. Guarded by
                    // the payload check in tests.
                    if (seg.payload.length > 0)
                        this.#onEstablishedSegment(conn, seg);
                }
                return;
            case 'established':
                this.#onEstablishedSegment(conn, seg);
                return;
            case 'last-ack':
                if ((seg.flags & TCP_ACK) !== 0 && seg.ack === conn.sendNxt) {
                    this.#drop(conn, key);
                }
                return;
            case 'closed':
                return;
        }
    }
    /** Called by Connection.send — segmentize and transmit immediately. */
    sendData(conn, data) {
        if (conn.state !== 'established') {
            this.sendsAfterClose++;
            return;
        }
        for (let off = 0; off < data.length; off += SEGMENT_MSS) {
            const chunk = data.subarray(off, Math.min(off + SEGMENT_MSS, data.length));
            this.#send(conn, TCP_PSH | TCP_ACK, chunk);
            conn.sendNxt = (conn.sendNxt + chunk.length) >>> 0;
        }
    }
    #onEstablishedSegment(conn, seg) {
        // Inbound data: advance rcv_nxt and ACK before delivering — the
        // handler may transmit from inside onData, and ktcp needs the ACK
        // sequence-consistent with those later segments.
        if (seg.payload.length > 0) {
            conn.rcvNxt = (conn.rcvNxt + seg.payload.length) >>> 0;
            this.#sendFlags(conn, TCP_ACK);
            conn.handler.onData(conn, Uint8Array.from(seg.payload));
            if (conn.state !== 'established')
                return; // handler closed us
        }
        if ((seg.flags & TCP_FIN) !== 0) {
            conn.rcvNxt = (conn.rcvNxt + 1) >>> 0;
            if (conn.handler.onRemoteClose !== undefined) {
                this.#sendFlags(conn, TCP_ACK);
                conn.handler.onRemoteClose(conn);
                return;
            }
            // Passive close, combined: ACK their FIN and carry ours in one
            // segment. ktcp's FIN_WAIT_1 takes this to TIME_WAIT and ACKs
            // our FIN, which lands in last-ack below.
            this.#sendFlags(conn, TCP_FIN | TCP_ACK);
            conn.sendNxt = (conn.sendNxt + 1) >>> 0; // our FIN consumed one
            conn.state = 'last-ack';
        }
    }
    #onNoConnection(srcIp, seg, key) {
        if ((seg.flags & TCP_RST) !== 0)
            return;
        if ((seg.flags & TCP_SYN) !== 0) {
            const handler = this.#listeners.get(seg.dstPort);
            if (handler !== undefined) {
                const conn = new Connection(this, srcIp, seg.srcPort, seg.dstPort, handler, this.#nextIss, seg.seq);
                this.#nextIss = (this.#nextIss + 0x10000) >>> 0;
                this.#conns.set(key, conn);
                this.#sendSynAck(conn);
                conn.sendNxt = (conn.sendNxt + 1) >>> 0; // our SYN consumed one
                return;
            }
        }
        // No listener / no connection: refuse, like ktcp's tcp_reject —
        // keeps the guest from waiting out its own timeout on a typo'd port.
        this.resetsSent++;
        const rst = (seg.flags & TCP_ACK) !== 0
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
                ack: (seg.seq +
                    seg.payload.length +
                    ((seg.flags & TCP_SYN) !== 0 || (seg.flags & TCP_FIN) !== 0 ? 1 : 0)) >>>
                    0,
                flags: TCP_RST | TCP_ACK,
                window: 0,
                payload: new Uint8Array(0),
            };
        this.#transmit(srcIp, buildTcpSegment(this.#localIp, srcIp, rst));
    }
    #sendSynAck(conn) {
        this.#send(conn, TCP_SYN | TCP_ACK, new Uint8Array(0));
    }
    #sendFlags(conn, flags) {
        this.#send(conn, flags, new Uint8Array(0));
    }
    #send(conn, flags, payload) {
        this.#transmit(conn.remoteIp, buildTcpSegment(this.#localIp, conn.remoteIp, {
            srcPort: conn.localPort,
            dstPort: conn.remotePort,
            seq: conn.sendNxt,
            ack: conn.rcvNxt,
            flags,
            window: RECEIVE_WINDOW,
            payload,
        }));
    }
    #drop(conn, key) {
        conn.state = 'closed';
        this.#conns.delete(key);
        conn.handler.onClosed?.(conn);
    }
}
function connKey(remoteIp, remotePort, localPort) {
    return `${formatIp(remoteIp)}:${remotePort}:${localPort}`;
}
