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

import type { EthernetSwitch, SwitchPort } from './switch.js';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_CODE_HOST_UNREACH,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  IPPROTO_ICMP,
  IPPROTO_TCP,
  MAC_BROADCAST,
  buildArp,
  buildEthernetFrame,
  buildIcmpDestUnreachable,
  buildIcmpEcho,
  buildIpv4,
  formatIp,
  parseArp,
  parseIcmpEcho,
  parseIpv4,
  ipEquals,
  type Ipv4,
  type Mac,
} from './wire.js';

/** QEMU-slirp-convention gateway identity — what /etc/net.cfg points at. */
export const GATEWAY_IP: Ipv4 = [10, 0, 2, 2];
export const GATEWAY_MAC: Mac = [0x52, 0x55, 0x0a, 0x00, 0x02, 0x02];

/** Payload of the optional welcome ping — visible in packet dumps. */
const WELCOME_PAYLOAD = Uint8Array.from('emu86-lan-hello'.split('').map((c) => c.charCodeAt(0)));

export interface EchoReplyEvent {
  readonly fromIp: Ipv4;
  readonly id: number;
  readonly seq: number;
  readonly payload: Uint8Array;
}

export interface LanGatewayOptions {
  ip?: Ipv4;
  mac?: Mac;
  /** Fired for every ICMP echo reply addressed to the gateway. */
  onEchoReply?: (ev: EchoReplyEvent) => void;
  /**
   * Ping each newly-learned host once (id 0xe86, seq 1). ELKS ships
   * no ping client, so without this a browser guest joining the LAN
   * sees only zeros in `netstat` — the welcome ping makes the ICMP
   * counters move the moment `net start ne0` runs. Default false
   * (tests and future pseudo-hosts want a quiet wire).
   */
  welcomePing?: boolean;
}

interface PendingPing {
  readonly targetIp: Ipv4;
  readonly id: number;
  readonly seq: number;
  readonly payload: Uint8Array;
}

/**
 * Serialized gateway state (Phase 18 M1): the learned ARP table, the IP
 * header ID counter, and the diagnostics counters. Pending pings are
 * deliberately NOT carried — laptop-resume semantics (brief §1.3): they
 * were queued behind an ARP whose reply belongs to the pre-capture
 * wire, and the ping originator retries. TCP handlers are wiring, not
 * state.
 */
export interface LanGatewayState {
  readonly v: 1;
  /** [dotted IP, MAC bytes] pairs. */
  readonly arpTable: ReadonlyArray<readonly [string, readonly number[]]>;
  readonly ipId: number;
  readonly arpRepliesSent: number;
  readonly echoRequestsSent: number;
  readonly echoRepliesSent: number;
  readonly echoRepliesReceived: number;
  readonly tcpForwarded: number;
  readonly tcpLocalDelivered: number;
  readonly unreachablesSent: number;
}

export class LanGateway {
  readonly ip: Ipv4;
  readonly mac: Mac;

  #port: SwitchPort | null = null;
  readonly #onEchoReply: (ev: EchoReplyEvent) => void;
  readonly #welcomePing: boolean;
  /** IP (dotted string) → MAC, learned from ARP traffic. */
  readonly #arpTable = new Map<string, Mac>();
  readonly #pendingPings: PendingPing[] = [];
  /** Off-subnet TCP handler (Phase 15 M1 — the HTTP gateway terminator). */
  #tcpTerminator: ((srcIp: Ipv4, dstIp: Ipv4, tcpPayload: Uint8Array) => void) | null = null;
  /** TCP addressed to the gateway ITSELF (substrate API v1 control). */
  #localTcp: ((srcIp: Ipv4, dstIp: Ipv4, tcpPayload: Uint8Array) => void) | null = null;
  #ipId = 1;

  // Counters for tests/diagnostics.
  arpRepliesSent = 0;
  echoRequestsSent = 0;
  echoRepliesSent = 0;
  echoRepliesReceived = 0;
  tcpForwarded = 0;
  tcpLocalDelivered = 0;
  unreachablesSent = 0;

  constructor(opts: LanGatewayOptions = {}) {
    this.ip = opts.ip ?? GATEWAY_IP;
    this.mac = opts.mac ?? GATEWAY_MAC;
    this.#onEchoReply = opts.onEchoReply ?? (() => { /* unobserved */ });
    this.#welcomePing = opts.welcomePing ?? false;
  }

  /** Attach to the LAN. One switch per gateway instance. */
  attachTo(lan: EthernetSwitch): void {
    if (this.#port !== null) {
      throw new Error('LanGateway: already attached');
    }
    this.#port = lan.attach({
      name: 'gateway',
      onFrame: (frame) => this.#onFrame(frame),
    });
  }

  detach(): void {
    this.#port?.detach();
    this.#port = null;
  }

  /** Read-only view of the learned IP→MAC table (dotted-IP keys). */
  get arpTable(): ReadonlyMap<string, Mac> {
    return this.#arpTable;
  }

  // ============================================================
  // State plane (Phase 18 M1)
  // ============================================================

  serializeState(): LanGatewayState {
    const arpTable: Array<readonly [string, readonly number[]]> = [];
    for (const [ip, mac] of this.#arpTable) arpTable.push([ip, [...mac]]);
    return {
      v: 1,
      arpTable,
      ipId: this.#ipId,
      arpRepliesSent: this.arpRepliesSent,
      echoRequestsSent: this.echoRequestsSent,
      echoRepliesSent: this.echoRepliesSent,
      echoRepliesReceived: this.echoRepliesReceived,
      tcpForwarded: this.tcpForwarded,
      tcpLocalDelivered: this.tcpLocalDelivered,
      unreachablesSent: this.unreachablesSent,
    };
  }

  /**
   * Restore captured state. Pending pings are dropped (see
   * {@link LanGatewayState}) — restore does not transmit anything.
   */
  restoreState(state: LanGatewayState): void {
    if (state.v !== 1) {
      throw new Error(`LanGateway.restoreState: unsupported schema version ${String(state.v)}`);
    }
    this.#arpTable.clear();
    for (const [ip, mac] of state.arpTable) this.#arpTable.set(ip, [...mac]);
    this.#pendingPings.length = 0;
    this.#ipId = state.ipId;
    this.arpRepliesSent = state.arpRepliesSent;
    this.echoRequestsSent = state.echoRequestsSent;
    this.echoRepliesSent = state.echoRepliesSent;
    this.echoRepliesReceived = state.echoRepliesReceived;
    this.tcpForwarded = state.tcpForwarded;
    this.tcpLocalDelivered = state.tcpLocalDelivered;
    this.unreachablesSent = state.unreachablesSent;
  }

  /**
   * Register the off-subnet TCP terminator (Phase 15 M1). Routing
   * means the guest sends every off-subnet packet to the gateway MAC;
   * TCP among it is handed here instead of dropped. One terminator per
   * gateway.
   */
  registerTcpTerminator(handler: (srcIp: Ipv4, dstIp: Ipv4, tcpPayload: Uint8Array) => void): void {
    if (this.#tcpTerminator !== null) {
      throw new Error('LanGateway: already has a TCP terminator');
    }
    this.#tcpTerminator = handler;
  }

  /**
   * Register the handler for TCP addressed to the gateway ITSELF
   * (substrate API v1: `urlget http://10.0.2.2/?...`). Distinct from
   * the off-subnet terminator on purpose — that one fetches the web,
   * this one is the machine talking to its own substrate. Was
   * silently dropped before. One handler per gateway.
   */
  registerLocalTcp(handler: (srcIp: Ipv4, dstIp: Ipv4, tcpPayload: Uint8Array) => void): void {
    if (this.#localTcp !== null) {
      throw new Error('LanGateway: already has a local TCP handler');
    }
    this.#localTcp = handler;
  }

  /**
   * Transmit an IPv4 packet to a LAN host from an arbitrary source
   * identity — the terminator's replies speak as whatever destination
   * the guest dialed, from the gateway's MAC (exactly how a router
   * looks on the wire). False when the LAN host's MAC is unknown; the
   * guest always ARPs the gateway before routing through it, so its
   * MAC is learned by then.
   */
  sendIpv4To(dstIp: Ipv4, srcIp: Ipv4, protocol: number, payload: Uint8Array): boolean {
    const mac = this.#arpTable.get(formatIp(dstIp));
    if (mac === undefined) return false;
    this.#transmit(
      buildEthernetFrame(
        mac,
        this.mac,
        ETHERTYPE_IPV4,
        buildIpv4(protocol, srcIp, dstIp, payload, this.#ipId++),
      ),
    );
    return true;
  }

  /**
   * Ping `targetIp`. If its MAC is known the echo request goes out
   * immediately (returns 'sent'); otherwise an ARP who-has goes out
   * and the ping queues until the reply arrives (returns
   * 'arp-pending'). Replies surface via `onEchoReply`.
   */
  ping(targetIp: Ipv4, id: number, seq: number, payload: Uint8Array): 'sent' | 'arp-pending' {
    const mac = this.#arpTable.get(formatIp(targetIp));
    if (mac !== undefined) {
      this.#sendEcho(mac, targetIp, ICMP_ECHO_REQUEST, id, seq, payload);
      this.echoRequestsSent++;
      return 'sent';
    }
    this.#pendingPings.push({ targetIp, id, seq, payload });
    this.#transmit(
      buildEthernetFrame(
        MAC_BROADCAST,
        this.mac,
        ETHERTYPE_ARP,
        buildArp(ARP_OP_REQUEST, this.mac, this.ip, [0, 0, 0, 0, 0, 0], targetIp),
      ),
    );
    return 'arp-pending';
  }

  // ============================================================
  // Frame handling
  // ============================================================

  #onFrame(frame: Uint8Array): void {
    if (frame.length < 14) return;
    const ethertype = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
    const payload = frame.subarray(14);
    if (ethertype === ETHERTYPE_ARP) {
      this.#onArp(payload);
      return;
    }
    if (ethertype === ETHERTYPE_IPV4) {
      this.#onIpv4(payload, frame.subarray(6, 12));
    }
  }

  #onArp(payload: Uint8Array): void {
    const arp = parseArp(payload);
    if (arp === null) return;

    // Learn the sender unconditionally — covers ktcp's gratuitous ARP
    // (an unsolicited REPLY broadcast at startup), ordinary requests,
    // and replies alike.
    this.#learn(arp.senderIp, arp.senderMac);

    if (arp.op === ARP_OP_REQUEST && ipEquals(Uint8Array.from(arp.targetIp), 0, this.ip)) {
      this.arpRepliesSent++;
      this.#transmit(
        buildEthernetFrame(
          arp.senderMac,
          this.mac,
          ETHERTYPE_ARP,
          buildArp(ARP_OP_REPLY, this.mac, this.ip, arp.senderMac, arp.senderIp),
        ),
      );
    }
  }

  #onIpv4(payload: Uint8Array, srcMac: Uint8Array): void {
    const ip = parseIpv4(payload);
    if (ip === null) return;
    // Learn from the data frame too (field find, 2026-07-17, the owl
    // wedge — dns.ts has the full story): a RESUMED guest's warm ARP
    // cache never ARPs again, and a fresh gateway that only learns
    // from ARP would silently drop every reply — internet, control
    // API, and pings alike — until a broadcast who-has happens by.
    this.#learn(ip.srcIp, [...srcMac]);
    if (!ipEquals(Uint8Array.from(ip.dstIp), 0, this.ip)) {
      // Routed traffic — the guest's ktcp sends anything off-subnet to
      // the gateway MAC. TCP is terminated (M3d). ICMP echo gets an
      // honest host-unreachable (Phase 15 M3, decision D6): a browser
      // cannot send real ICMP, and a synthetic reply with a fetch-shaped
      // RTT would be a lie — unreachable is what this router truthfully
      // knows. Everything else still drops.
      if (ip.protocol === IPPROTO_TCP && this.#tcpTerminator !== null) {
        this.tcpForwarded++;
        this.#tcpTerminator(ip.srcIp, ip.dstIp, ip.payload);
        return;
      }
      if (ip.protocol === IPPROTO_ICMP) {
        const echo = parseIcmpEcho(ip.payload);
        if (echo === null || echo.type !== ICMP_ECHO_REQUEST) return;
        const mac = this.#arpTable.get(formatIp(ip.srcIp));
        if (mac === undefined) return; // no route back without ARP knowledge
        this.unreachablesSent++;
        const icmp = buildIcmpDestUnreachable(ICMP_CODE_HOST_UNREACH, payload);
        const packet = buildIpv4(IPPROTO_ICMP, this.ip, ip.srcIp, icmp, this.#ipId++);
        this.#transmit(buildEthernetFrame(mac, this.mac, ETHERTYPE_IPV4, packet));
      }
      return;
    }
    // TCP dialed at the gateway itself — the control endpoint.
    if (ip.protocol === IPPROTO_TCP && this.#localTcp !== null) {
      this.tcpLocalDelivered++;
      this.#localTcp(ip.srcIp, ip.dstIp, ip.payload);
      return;
    }
    if (ip.protocol !== IPPROTO_ICMP) return;

    const echo = parseIcmpEcho(ip.payload);
    if (echo === null) return;

    if (echo.type === ICMP_ECHO_REQUEST) {
      // Someone pings the gateway: answer from our own identity.
      const mac = this.#arpTable.get(formatIp(ip.srcIp));
      if (mac === undefined) return; // no route back without ARP knowledge
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

  #learn(ip: Ipv4, mac: Mac): void {
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

  #sendEcho(dstMac: Mac, dstIp: Ipv4, type: number, id: number, seq: number, payload: Uint8Array): void {
    const icmp = buildIcmpEcho(type, id, seq, payload);
    const packet = buildIpv4(IPPROTO_ICMP, this.ip, dstIp, icmp, this.#ipId++);
    this.#transmit(buildEthernetFrame(dstMac, this.mac, ETHERTYPE_IPV4, packet));
  }

  #transmit(frame: Uint8Array): void {
    if (this.#port === null) {
      throw new Error('LanGateway: not attached to a switch');
    }
    this.#port.transmit(frame);
  }
}
