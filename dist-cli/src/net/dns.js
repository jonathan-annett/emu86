/**
 * DNS pseudo-host (Phase 14 M3c) — 10.0.2.3, the slirp-convention
 * nameserver address, one hop along from the M3b gateway at 10.0.2.2.
 *
 * ELKS resolves names over **TCP** (`libc/net/in_resolv.c`: ktcp has
 * no UDP), sending the RFC 1035 §4.2.2 form — a 2-byte big-endian
 * length prefix, then the query message. This host listens on TCP/53
 * via {@link TcpStack}, strips the prefix, hands the raw query to an
 * injected {@link DnsResolve} function, and streams the answer back
 * with the prefix restored. It never parses DNS messages beyond the
 * two header bytes a SERVFAIL synthesis needs — in the browser the
 * resolve function is {@link dohResolve} (RFC 8484 GET pass-through to
 * a CORS-permissive DoH endpoint), so the guest's own query and the
 * resolver's real answer travel byte-authentically.
 *
 * First async pseudo-host: the query is ACKed synchronously (the
 * TcpStack does that before `onData` fires), and the answer transmits
 * whenever the resolve promise settles — the queue-and-complete
 * pattern `ARP_ICMP_REPORT.md` §3.3 reserved for fetch-backed hosts.
 * The switch stays synchronous throughout. If the resolve outlasts the
 * guest's own 2-second `alarm()` the guest closes first and the late
 * answer is dropped by the stack (counted, not an error).
 *
 * ARP is answered for the host's own IP, same learning shape as
 * `LanGateway` — each pseudo-host is its own LAN citizen.
 */
import { TcpStack } from './tcp.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4, IPPROTO_TCP, buildArp, buildEthernetFrame, buildIpv4, formatIp, ipEquals, parseArp, parseIpv4, } from './wire.js';
/** Slirp-convention DNS host identity (gateway is .2, DNS is .3). */
export const DNS_IP = [10, 0, 2, 3];
export const DNS_MAC = [0x52, 0x55, 0x0a, 0x00, 0x02, 0x03];
export const DNS_PORT = 53;
/** Cloudflare's CORS-permissive DoH endpoint (RFC 8484 wire format). */
export const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';
/**
 * RFC 8484 DoH pass-through: base64url the raw query into a GET (the
 * cache-friendly form; also avoids a CORS preflight) and return the
 * `application/dns-message` response bytes.
 */
export function dohResolve(url = DEFAULT_DOH_URL) {
    return async (query) => {
        const response = await fetch(`${url}?dns=${base64url(query)}`, {
            headers: { accept: 'application/dns-message' },
        });
        if (!response.ok) {
            throw new Error(`DoH: ${response.status} ${response.statusText}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    };
}
export class DnsHost {
    ip;
    mac;
    #port = null;
    #resolve;
    #onResolveError;
    #tcp;
    /** IP (dotted string) → MAC, learned from ARP traffic. */
    #arpTable = new Map();
    #pending = new Map();
    #ipId = 1;
    // Counters for tests/diagnostics.
    queriesResolved = 0;
    servfailsSent = 0;
    answersDropped = 0;
    constructor(opts) {
        this.ip = opts.ip ?? DNS_IP;
        this.mac = opts.mac ?? DNS_MAC;
        this.#resolve = opts.resolve;
        this.#onResolveError = opts.onResolveError ?? (() => { });
        this.#tcp = new TcpStack({
            localIp: this.ip,
            transmit: (dstIp, segment) => this.#transmitIp(dstIp, segment),
        });
        this.#tcp.listen(DNS_PORT, {
            onConnect: (conn) => {
                this.#pending.set(conn, { buffer: new Uint8Array(0) });
            },
            onData: (conn, data) => this.#onData(conn, data),
            onClosed: (conn) => {
                this.#pending.delete(conn);
            },
        });
    }
    /** Attach to the LAN. One switch per host instance. */
    attachTo(lan) {
        if (this.#port !== null) {
            throw new Error('DnsHost: already attached');
        }
        this.#port = lan.attach({
            name: 'dns',
            onFrame: (frame) => this.#onFrame(frame),
        });
    }
    detach() {
        this.#port?.detach();
        this.#port = null;
    }
    /** The transport engine — exposed for tests/diagnostics. */
    get tcp() {
        return this.#tcp;
    }
    // ============================================================
    // TCP/53: length-prefixed query in, length-prefixed answer out
    // ============================================================
    #onData(conn, data) {
        const pending = this.#pending.get(conn);
        if (pending === undefined)
            return;
        const buffer = new Uint8Array(pending.buffer.length + data.length);
        buffer.set(pending.buffer, 0);
        buffer.set(data, pending.buffer.length);
        pending.buffer = buffer;
        if (buffer.length < 2)
            return;
        const queryLen = ((buffer[0] ?? 0) << 8) | (buffer[1] ?? 0);
        if (buffer.length < 2 + queryLen)
            return; // wait for the rest
        const query = buffer.subarray(2, 2 + queryLen);
        pending.buffer = buffer.subarray(2 + queryLen); // a next query may follow
        void this.#resolveAndAnswer(conn, Uint8Array.from(query));
    }
    async #resolveAndAnswer(conn, query) {
        let answer;
        try {
            answer = await this.#resolve(query);
            this.queriesResolved++;
        }
        catch (err) {
            this.#onResolveError(err);
            answer = servfailFor(query);
            this.servfailsSent++;
        }
        if (conn.state !== 'established') {
            this.answersDropped++; // guest gave up (its 2s alarm) — nothing to do
            return;
        }
        const framed = new Uint8Array(2 + answer.length);
        framed[0] = (answer.length >> 8) & 0xff;
        framed[1] = answer.length & 0xff;
        framed.set(answer, 2);
        conn.send(framed);
    }
    // ============================================================
    // LAN plumbing: ethernet + ARP + IPv4, same shape as LanGateway
    // ============================================================
    #onFrame(frame) {
        if (frame.length < 14)
            return;
        const ethertype = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
        const payload = frame.subarray(14);
        if (ethertype === ETHERTYPE_ARP) {
            this.#onArp(payload);
            return;
        }
        if (ethertype === ETHERTYPE_IPV4) {
            this.#onIpv4(payload);
        }
    }
    #onArp(payload) {
        const arp = parseArp(payload);
        if (arp === null)
            return;
        this.#arpTable.set(formatIp(arp.senderIp), arp.senderMac);
        if (arp.op === ARP_OP_REQUEST && ipEquals(Uint8Array.from(arp.targetIp), 0, this.ip)) {
            this.#transmitFrame(buildEthernetFrame(arp.senderMac, this.mac, ETHERTYPE_ARP, buildArp(ARP_OP_REPLY, this.mac, this.ip, arp.senderMac, arp.senderIp)));
        }
    }
    #onIpv4(payload) {
        const ip = parseIpv4(payload);
        if (ip === null)
            return;
        if (!ipEquals(Uint8Array.from(ip.dstIp), 0, this.ip))
            return;
        if (ip.protocol !== IPPROTO_TCP)
            return;
        this.#tcp.onSegment(ip.srcIp, ip.payload);
    }
    #transmitIp(dstIp, segment) {
        const mac = this.#arpTable.get(formatIp(dstIp));
        if (mac === undefined)
            return; // no route back without ARP knowledge
        this.#transmitFrame(buildEthernetFrame(mac, this.mac, ETHERTYPE_IPV4, buildIpv4(IPPROTO_TCP, this.ip, dstIp, segment, this.#ipId++)));
    }
    #transmitFrame(frame) {
        if (this.#port === null) {
            throw new Error('DnsHost: not attached to a switch');
        }
        this.#port.transmit(frame);
    }
}
/**
 * Synthesize a SERVFAIL for `query` without parsing it: copy the
 * message, set QR (response) and RCODE 2, zero the answer counts. The
 * question section rides along verbatim, which is what a real server's
 * SERVFAIL carries anyway. `in_resolv` maps RCODE 2 to ESERVERERR.
 */
export function servfailFor(query) {
    const r = Uint8Array.from(query);
    if (r.length < 12)
        return r;
    r[2] = ((r[2] ?? 0) | 0x80) & 0xfb; // QR=1, opcode kept, AA=0
    r[3] = (((r[3] ?? 0) & 0x70) | 0x02) & 0x7f; // RA=0, Z kept, RCODE=2
    r[6] = 0; // ancount
    r[7] = 0;
    r[8] = 0; // nscount
    r[9] = 0;
    r[10] = 0; // arcount
    r[11] = 0;
    return r;
}
/** RFC 4648 §5 base64url (no padding) over raw bytes — RFC 8484's dns= form. */
export function base64url(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i] ?? 0;
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        out += alphabet.charAt(b0 >> 2);
        out += alphabet.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
        if (b1 === undefined)
            break;
        out += alphabet.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
        if (b2 === undefined)
            break;
        out += alphabet.charAt(b2 & 0x3f);
    }
    return out;
}
