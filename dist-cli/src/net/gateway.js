/**
 * LAN gateway pseudo-host (Phase 14 M3b).
 *
 * The first inhabitant of the browser-side LAN: a host at the address
 * ELKS already expects its gateway at — `/etc/net.cfg` defaults to
 * guest 10.0.2.15, gateway **10.0.2.2**, /24 (the QEMU slirp layout;
 * the MAC follows the same convention, 52:55:0a:00:02:02).
 *
 * Speaks exactly two protocols for now, per the networking plan's
 * Phase-15 slice:
 *
 *   - **ARP responder**: answers who-has for its own IP, and learns
 *     every sender it sees — including the gratuitous ARP ktcp sends
 *     the moment `net start ne0` runs (`elkscmd/ktcp/deveth.c:57`),
 *     so the guest is usually known before anyone has to ask.
 *   - **ICMP echo, both directions**: replies to pings of its own IP
 *     (once a guest-side ping client exists), and — the M3b
 *     acceptance path — *originates* pings via {@link LanGateway.ping},
 *     which ktcp's `icmp.c` answers. Replies surface through
 *     `onEchoReply`; ELKS's own `netstat` shows the matching ICMP
 *     counters in-guest.
 *
 * Pings to an unresolved MAC queue behind an ARP who-has and flush
 * when the reply (or any learning event) resolves the address —
 * everything stays synchronous with respect to the switch; "later"
 * only ever means "when the next frame arrives".
 */
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4, ICMP_ECHO_REPLY, ICMP_ECHO_REQUEST, IPPROTO_ICMP, MAC_BROADCAST, buildArp, buildEthernetFrame, buildIcmpEcho, buildIpv4, formatIp, parseArp, parseIcmpEcho, parseIpv4, ipEquals, } from './wire.js';
/** QEMU-slirp-convention gateway identity — what /etc/net.cfg points at. */
export const GATEWAY_IP = [10, 0, 2, 2];
export const GATEWAY_MAC = [0x52, 0x55, 0x0a, 0x00, 0x02, 0x02];
/** Payload of the optional welcome ping — visible in packet dumps. */
const WELCOME_PAYLOAD = Uint8Array.from('emu86-lan-hello'.split('').map((c) => c.charCodeAt(0)));
export class LanGateway {
    ip;
    mac;
    #port = null;
    #onEchoReply;
    #welcomePing;
    /** IP (dotted string) → MAC, learned from ARP traffic. */
    #arpTable = new Map();
    #pendingPings = [];
    #ipId = 1;
    // Counters for tests/diagnostics.
    arpRepliesSent = 0;
    echoRequestsSent = 0;
    echoRepliesSent = 0;
    echoRepliesReceived = 0;
    constructor(opts = {}) {
        this.ip = opts.ip ?? GATEWAY_IP;
        this.mac = opts.mac ?? GATEWAY_MAC;
        this.#onEchoReply = opts.onEchoReply ?? (() => { });
        this.#welcomePing = opts.welcomePing ?? false;
    }
    /** Attach to the LAN. One switch per gateway instance. */
    attachTo(lan) {
        if (this.#port !== null) {
            throw new Error('LanGateway: already attached');
        }
        this.#port = lan.attach({
            name: 'gateway',
            onFrame: (frame) => this.#onFrame(frame),
        });
    }
    detach() {
        this.#port?.detach();
        this.#port = null;
    }
    /** Read-only view of the learned IP→MAC table (dotted-IP keys). */
    get arpTable() {
        return this.#arpTable;
    }
    /**
     * Ping `targetIp`. If its MAC is known the echo request goes out
     * immediately (returns 'sent'); otherwise an ARP who-has goes out
     * and the ping queues until the reply arrives (returns
     * 'arp-pending'). Replies surface via `onEchoReply`.
     */
    ping(targetIp, id, seq, payload) {
        const mac = this.#arpTable.get(formatIp(targetIp));
        if (mac !== undefined) {
            this.#sendEcho(mac, targetIp, ICMP_ECHO_REQUEST, id, seq, payload);
            this.echoRequestsSent++;
            return 'sent';
        }
        this.#pendingPings.push({ targetIp, id, seq, payload });
        this.#transmit(buildEthernetFrame(MAC_BROADCAST, this.mac, ETHERTYPE_ARP, buildArp(ARP_OP_REQUEST, this.mac, this.ip, [0, 0, 0, 0, 0, 0], targetIp)));
        return 'arp-pending';
    }
    // ============================================================
    // Frame handling
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
        // Learn the sender unconditionally — covers ktcp's gratuitous ARP
        // (an unsolicited REPLY broadcast at startup), ordinary requests,
        // and replies alike.
        this.#learn(arp.senderIp, arp.senderMac);
        if (arp.op === ARP_OP_REQUEST && ipEquals(Uint8Array.from(arp.targetIp), 0, this.ip)) {
            this.arpRepliesSent++;
            this.#transmit(buildEthernetFrame(arp.senderMac, this.mac, ETHERTYPE_ARP, buildArp(ARP_OP_REPLY, this.mac, this.ip, arp.senderMac, arp.senderIp)));
        }
    }
    #onIpv4(payload) {
        const ip = parseIpv4(payload);
        if (ip === null)
            return;
        if (!ipEquals(Uint8Array.from(ip.dstIp), 0, this.ip))
            return;
        if (ip.protocol !== IPPROTO_ICMP)
            return;
        const echo = parseIcmpEcho(ip.payload);
        if (echo === null)
            return;
        if (echo.type === ICMP_ECHO_REQUEST) {
            // Someone pings the gateway: answer from our own identity.
            const mac = this.#arpTable.get(formatIp(ip.srcIp));
            if (mac === undefined)
                return; // no route back without ARP knowledge
            this.echoRepliesSent++;
            this.#sendEcho(mac, ip.srcIp, ICMP_ECHO_REPLY, echo.id, echo.seq, echo.payload);
            return;
        }
        // Echo reply for one of our pings.
        this.echoRepliesReceived++;
        this.#onEchoReply({
            fromIp: ip.srcIp,
            id: echo.id,
            seq: echo.seq,
            payload: Uint8Array.from(echo.payload),
        });
    }
    #learn(ip, mac) {
        const key = formatIp(ip);
        const isNew = !this.#arpTable.has(key);
        this.#arpTable.set(key, mac);
        // Flush any pings that were waiting on this address.
        for (let i = this.#pendingPings.length - 1; i >= 0; i--) {
            const p = this.#pendingPings[i];
            if (p !== undefined && formatIp(p.targetIp) === key) {
                this.#pendingPings.splice(i, 1);
                this.#sendEcho(mac, p.targetIp, ICMP_ECHO_REQUEST, p.id, p.seq, p.payload);
                this.echoRequestsSent++;
            }
        }
        if (this.#welcomePing && isNew && key !== formatIp(this.ip)) {
            this.#sendEcho(mac, ip, ICMP_ECHO_REQUEST, 0xe86, 1, WELCOME_PAYLOAD);
            this.echoRequestsSent++;
        }
    }
    #sendEcho(dstMac, dstIp, type, id, seq, payload) {
        const icmp = buildIcmpEcho(type, id, seq, payload);
        const packet = buildIpv4(IPPROTO_ICMP, this.ip, dstIp, icmp, this.#ipId++);
        this.#transmit(buildEthernetFrame(dstMac, this.mac, ETHERTYPE_IPV4, packet));
    }
    #transmit(frame) {
        if (this.#port === null) {
            throw new Error('LanGateway: not attached to a switch');
        }
        this.#port.transmit(frame);
    }
}
