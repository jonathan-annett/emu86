/**
 * TAN — the Tab Area Network (Phase 14 M3-tabs).
 *
 * Lets every same-origin browser tab's emulated machine share one LAN,
 * so tab 1 can `telnet 10.0.2.<tab 2>`. Two jobs, one channel:
 *
 *   1. **Trunk**: each tab keeps its own {@link EthernetSwitch}; a
 *      trunk port bridges it onto a broadcast channel, exactly like
 *      trunking two physical switches. The M3a learning CAM already
 *      handles who-lives-where — broadcasts and unknown unicast flood
 *      across the trunk, learned unicast routes precisely. Loop-free
 *      by construction: a channel never echoes to its sender (both
 *      browser and Node BroadcastChannel semantics), and the switch
 *      never echoes to the ingress port, so a frame crosses the trunk
 *      at most once and is never re-posted.
 *
 *   2. **Identity lease** ("DHCP at the bootopts layer"): ELKS has no
 *      DHCP client — ktcp takes a static IP — but the stock
 *      /etc/net.cfg reads `$LOCALIP` from the bootopts environment.
 *      So each tab claims a unique host octet over the same channel
 *      (random pick, announce, defend, repick on conflict), and the
 *      bootopts patcher stamps `LOCALIP=10.0.2.<octet>`. The NIC MAC
 *      derives from the same octet (02:65:6d:75:38:XX) — a shared
 *      segment cannot tolerate the fixed default MAC in two tabs.
 *
 * Guest↔guest TCP needs nothing further: ktcp speaks real TCP on both
 * ends and telnetd already listens — the TAN only has to move frames.
 *
 * The channel is typed structurally ({@link FrameChannel}) so browser
 * BroadcastChannel, Node's BroadcastChannel, and synchronous test
 * stubs all fit without DOM types leaking into the substrate.
 *
 * Known quirk, documented not fixed: every tab also hosts its own
 * LanGateway at 10.0.2.2 with the same MAC. On a bridged TAN they act
 * as one anycast-ish gateway (identical ARP answers keep CAMs stable);
 * a remote gateway's welcome ping may get answered toward the local
 * one. Harmless for M3-tabs; a lease-elected single gateway is a
 * later nicety.
 */
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_ARP, buildArp, buildEthernetFrame, parseArp, } from './wire.js';
/** Host octets the lease draws from: 10.0.2.[16..199]. Gateway is .2,
 *  the plan reserves .3 (DNS) and .15 (single-tab default). */
const OCTET_MIN = 16;
const OCTET_MAX = 199;
/** How long a fresh claim listens for a defence before settling. */
const DEFAULT_CLAIM_WAIT_MS = 150;
function isTanMsg(data) {
    return typeof data === 'object' && data !== null && 'tan' in data;
}
export function tanIdentityFor(octet) {
    if (!Number.isInteger(octet) || octet < 1 || octet > 254) {
        throw new Error(`TAN: host octet must be 1..254 (got ${octet})`);
    }
    return {
        hostOctet: octet,
        ip: [10, 0, 2, octet],
        mac: [0x02, 0x65, 0x6d, 0x75, 0x38, octet],
        localipLine: `LOCALIP=10.0.2.${octet}`,
    };
}
export class TabAreaNetwork {
    #channel;
    #claimWaitMs;
    #random;
    #preferredOctet;
    #identity = null;
    #trunk = null;
    #lan = null;
    /** True once the identity is final — settled holders defend it. */
    #settled = false;
    /** Set when a conflicting claim arrives during our own claim window. */
    #conflictSeen = false;
    /** Frames forwarded in each direction — diagnostics/tests. */
    framesOut = 0;
    framesIn = 0;
    /** Proxy-ARP answers served for known TAN members — diagnostics. */
    proxyArpReplies = 0;
    /**
     * Every octet ever claimed on this channel (including our own). The
     * lease registry doubles as an ARP directory: member MACs derive
     * deterministically from octets, so who-has for any known member can
     * be answered locally, instantly — see {@link #maybeProxyArp}.
     */
    #knownOctets = new Set();
    constructor(channel, opts = {}) {
        this.#channel = channel;
        this.#claimWaitMs = opts.claimWaitMs ?? DEFAULT_CLAIM_WAIT_MS;
        this.#random = opts.random ?? Math.random;
        this.#preferredOctet =
            opts.preferredOctet !== undefined
                && Number.isInteger(opts.preferredOctet)
                && opts.preferredOctet >= OCTET_MIN
                && opts.preferredOctet <= OCTET_MAX
                ? opts.preferredOctet
                : null;
        if (opts.hostOctet !== undefined) {
            // Fixed identities are settled from birth and defend immediately.
            this.#identity = tanIdentityFor(opts.hostOctet);
            this.#settled = true;
            this.#knownOctets.add(opts.hostOctet);
        }
        this.#channel.onmessage = (ev) => this.#onChannelMessage(ev.data);
    }
    get identity() {
        return this.#identity;
    }
    /**
     * Acquire a unique identity on the TAN. With a fixed `hostOctet`
     * this resolves immediately (the claim is still announced so other
     * tabs learn it). Otherwise: pick a random free-looking octet,
     * announce, listen {@link DEFAULT_CLAIM_WAIT_MS} for a defence from
     * an existing holder, repick on conflict.
     */
    async acquire() {
        if (this.#identity !== null) {
            this.#channel.postMessage({ tan: 'claim', octet: this.#identity.hostOctet });
            return this.#identity;
        }
        for (let attempt = 0; attempt < 10; attempt++) {
            // Sticky IP: the persisted octet from the last session gets first
            // shot; a live holder (e.g. the original of a duplicated tab)
            // defends it and the fallback picks are random as before.
            const octet = attempt === 0 && this.#preferredOctet !== null
                ? this.#preferredOctet
                : OCTET_MIN + Math.floor(this.#random() * (OCTET_MAX - OCTET_MIN + 1));
            this.#conflictSeen = false;
            this.#identity = tanIdentityFor(octet); // provisional
            this.#channel.postMessage({ tan: 'claim', octet });
            await delay(this.#claimWaitMs);
            if (!this.#conflictSeen) {
                this.#settled = true;
                this.#knownOctets.add(octet);
                return this.#identity;
            }
            this.#identity = null;
        }
        throw new Error('TAN: could not acquire a host octet after 10 attempts');
    }
    /** Bridge a switch onto the TAN. Call after {@link acquire}. */
    attach(lan) {
        if (this.#trunk !== null)
            throw new Error('TAN: already attached');
        this.#lan = lan;
        this.#trunk = lan.attach({
            name: 'tan-trunk',
            onFrame: (frame) => {
                // Local frame flooded/routed to the trunk → other tabs.
                this.framesOut++;
                this.#channel.postMessage({ tan: 'frame', bytes: frame });
                // Proxy-ARP: answer who-has for known members immediately.
                // First-contact ARP otherwise costs a full cross-tab round
                // trip — guest-seconds under tab throttling or interleaved
                // test slices — and ktcp's SYN_SENT clock runs (and expires)
                // WHILE its packet sits in deveth's one-deep ARP queue. Local
                // instant answers make connect() latency-proof; the real
                // owner's own reply (if it ever arrives) is a harmless
                // duplicate cache update.
                this.#maybeProxyArp(frame);
            },
        });
    }
    #maybeProxyArp(frame) {
        if (this.#trunk === null || frame.length < 14 + 28)
            return;
        if ((((frame[12] ?? 0) << 8) | (frame[13] ?? 0)) !== ETHERTYPE_ARP)
            return;
        const arp = parseArp(frame.subarray(14));
        if (arp === null || arp.op !== ARP_OP_REQUEST)
            return;
        const [a, b, c, octet] = arp.targetIp;
        if (a !== 10 || b !== 0 || c !== 2 || octet === undefined)
            return;
        if (!this.#knownOctets.has(octet))
            return;
        if (this.#identity !== null && octet === this.#identity.hostOctet)
            return; // our own guest answers itself
        const member = tanIdentityFor(octet);
        this.proxyArpReplies++;
        // Enters the local switch as trunk traffic — the CAM learns the
        // member's MAC on the trunk port, exactly where real frames to it
        // go.
        this.#trunk.transmit(buildEthernetFrame(arp.senderMac, member.mac, ETHERTYPE_ARP, buildArp(ARP_OP_REPLY, member.mac, member.ip, arp.senderMac, arp.senderIp)));
    }
    /**
     * Unplug from the current switch only — identity, channel, and
     * defence stay live so a rebooting tab keeps its address and other
     * tabs' claims still get answered. Frames arriving trunkless drop.
     */
    detachLan() {
        this.#trunk?.detach();
        this.#trunk = null;
        this.#lan = null;
    }
    /** Full shutdown: leave the LAN and release the channel. */
    close() {
        this.detachLan();
        this.#channel.onmessage = null;
        this.#channel.close?.();
    }
    #onChannelMessage(data) {
        if (!isTanMsg(data))
            return;
        if (data.tan === 'frame') {
            if (this.#trunk === null)
                return;
            const bytes = data.bytes instanceof Uint8Array ? data.bytes : Uint8Array.from(data.bytes);
            this.framesIn++;
            // Enters the local switch as trunk-port traffic; the switch never
            // echoes to the ingress port, so nothing re-posts to the channel.
            this.#trunk.transmit(bytes);
            return;
        }
        if (data.tan === 'claim') {
            if (!Number.isInteger(data.octet))
                return;
            const firstSighting = !this.#knownOctets.has(data.octet);
            this.#knownOctets.add(data.octet);
            const mine = this.#identity;
            if (mine !== null && data.octet === mine.hostOctet) {
                if (this.#settled) {
                    // Settled holder: always defend, so the newcomer repicks.
                    this.#channel.postMessage({ tan: 'claim', octet: mine.hostOctet });
                }
                else {
                    // We're mid-claim ourselves: a matching claim (defence or a
                    // simultaneous newcomer) means this octet is contested.
                    this.#conflictSeen = true;
                }
            }
            else if (firstSighting && this.#settled && mine !== null) {
                // Directory gossip: a new member just announced — re-announce
                // ourselves once so it learns the existing membership. Only on
                // first sighting, so announcements can't storm.
                this.#channel.postMessage({ tan: 'claim', octet: mine.hostOctet });
            }
        }
    }
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
