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
 * Reserved residents stay tab-local (field bug, 2026-07-15 — this was
 * the "anycast quirk, harmless" note until it wasn't): every tab hosts
 * its own gateway (10.0.2.2) and DNS host (10.0.2.3) with IDENTICAL
 * fixed MACs. If their frames cross the trunk, the remote copy's ARP
 * reply arrives after the local one and wins the neighbour's CAM, and
 * from then on that guest's DNS and gateway traffic is served by the
 * WRONG TAB — where the worker's DNS/fetch stall cannot pause the
 * asking machine (in_resolv's 2-second alarm runs against a cold DoH
 * in a throttled background tab: the pre-stall first-resolve flake of
 * 5c0aa63, resurfaced), and where the DoH answer cache feeding the
 * HTTP gateway's reverse map belongs to the other tab. So the trunk
 * filters resident-sourced frames in both directions; each tab always
 * talks to its own residents, which are identical services anyway.
 */

import type { EthernetSwitch, SwitchPort } from './switch.js';
import { TanConntrack } from './conntrack.js';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  buildArp,
  buildEthernetFrame,
  macEquals,
  parseArp,
  type Ipv4,
  type Mac,
} from './wire.js';
import { GATEWAY_MAC } from './gateway.js';
import { DNS_MAC } from './dns.js';
import { nameForOctet } from './tan-names.js';

/**
 * Pseudo-hosts every tab runs at the same fixed MAC. Frames they
 * source never cross the trunk — see the header. (Guest traffic is
 * untouched: guest MACs are per-octet unique.)
 */
const RESERVED_RESIDENT_MACS: readonly Mac[] = [GATEWAY_MAC, DNS_MAC];

function isResidentSourced(frame: Uint8Array): boolean {
  return RESERVED_RESIDENT_MACS.some((mac) => macEquals(frame, 6, mac));
}

/**
 * Structural subset of BroadcastChannel that browser workers, Node,
 * and test stubs all satisfy.
 */
export interface FrameChannel {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close?(): void;
}

/** Host octets the lease draws from: 10.0.2.[16..199]. Gateway is .2,
 *  the plan reserves .3 (DNS) and .15 (single-tab default). */
const OCTET_MIN = 16;
const OCTET_MAX = 199;

/** How long a fresh claim listens for a defence before settling. */
const DEFAULT_CLAIM_WAIT_MS = 150;

interface TanFrameMsg {
  readonly tan: 'frame';
  readonly bytes: Uint8Array;
}
interface TanClaimMsg {
  readonly tan: 'claim';
  readonly octet: number;
}
/**
 * Census reply (Phase 15 M4). A settled tab answers any *other* tab's
 * claim with `here <my octet>`, so a newcomer learns the WHOLE
 * membership in one claim-wait and can pick the lowest free octet —
 * which is what makes the first tab `mouse` and the second `cat`
 * instead of two random animals.
 *
 * It is a distinct message type, and deliberately so: `here` never
 * triggers a reply. Answering a claim with another *claim* would have
 * every tab re-announcing at every other tab's announcement, forever.
 */
interface TanHereMsg {
  readonly tan: 'here';
  readonly octet: number;
}
/**
 * Network freeze (TAN-freeze brief M2). `freeze`: the sender's page is
 * DYING (pagehide — never a tab switch) and peers with open
 * connections to it should hold their CPUs still so no guest time
 * passes during the reload gap. `thaw`: the sender is back (restore
 * outcome known, either way) or revived from bfcache — release.
 * Receivers self-select against their OWN conntrack; an uninvolved
 * tab ignores both.
 */
interface TanFreezeMsg {
  readonly tan: 'freeze';
  readonly octet: number;
}
interface TanThawMsg {
  readonly tan: 'thaw';
  readonly octet: number;
}
type TanMsg = TanFrameMsg | TanClaimMsg | TanHereMsg | TanFreezeMsg | TanThawMsg;

function isTanMsg(data: unknown): data is TanMsg {
  return typeof data === 'object' && data !== null && 'tan' in data;
}

export interface TanIdentity {
  readonly hostOctet: number;
  readonly ip: Ipv4;
  readonly mac: Mac;
  /** The tab's `.tabs` name (mouse/cat/dog) — null outside the range. */
  readonly name: string | null;
  /** The bootopts line net.cfg reads: `LOCALIP=10.0.2.<octet>`. */
  readonly localipLine: string;
  /**
   * Bootopts line that tells the SHELL who it is (field ask,
   * 2026-07-15: "no way for the shell to know its own hostname").
   * Stock /etc/profile does `PS1="$HOSTNAME$PS1"`, so this also turns
   * the prompt into `mouse# ` for free. Null when the octet has no
   * .tabs name. Recorded caveat: a BARE `ktcp` (no explicit IP arg —
   * /bin/net always passes one) resolves $HOSTNAME as its local
   * address instead of falling back to its builtin default.
   */
  readonly hostnameLine: string | null;
}

export function tanIdentityFor(octet: number): TanIdentity {
  if (!Number.isInteger(octet) || octet < 1 || octet > 254) {
    throw new Error(`TAN: host octet must be 1..254 (got ${octet})`);
  }
  const name = nameForOctet(octet);
  return {
    hostOctet: octet,
    ip: [10, 0, 2, octet],
    mac: [0x02, 0x65, 0x6d, 0x75, 0x38, octet],
    name,
    localipLine: `LOCALIP=10.0.2.${octet}`,
    hostnameLine: name !== null ? `HOSTNAME=${name}` : null,
  };
}

export interface TabAreaNetworkOptions {
  /** Fixed host octet — skips the claim wait (deterministic tests). */
  hostOctet?: number;
  /**
   * Preferred host octet — tried as the FIRST pick, with the full
   * claim/defend/repick flow still applying (unlike `hostOctet`, which
   * settles unconditionally). This is the sticky-IP hook: the main
   * thread persists the settled octet in the tab's session store and
   * offers it back on the next page load, so reloads keep their
   * address while a duplicated tab (whose copied sessionStorage offers
   * the SAME octet) gets defended off it and repicks a fresh one.
   * Ignored when `hostOctet` is set or the value is outside the lease
   * range.
   */
  preferredOctet?: number;
  /** Claim-defence listening window. Default 150 ms. */
  claimWaitMs?: number;
  /** Random source for octet picks. Default Math.random. */
  random?: () => number;
}

export class TabAreaNetwork {
  readonly #channel: FrameChannel;
  readonly #claimWaitMs: number;
  readonly #random: () => number;
  readonly #preferredOctet: number | null;

  #identity: TanIdentity | null = null;
  #trunk: SwitchPort | null = null;
  #lan: EthernetSwitch | null = null;
  /** True once the identity is final — settled holders defend it. */
  #settled = false;
  /** Set when a conflicting claim arrives during our own claim window. */
  #conflictSeen = false;

  /**
   * Connection accounting over everything crossing the trunk (both
   * directions — the channel is a bus, so this includes third-party
   * flows; the per-tab views filter by octet). Drives the M2 network
   * freeze and the inspect popup's connection list.
   */
  readonly conntrack = new TanConntrack();

  /**
   * Network-freeze hooks (M2): a peer announced its death / return.
   * The host layer decides involvement (its own conntrack) and owns
   * the deadline; the TAN only carries the words.
   */
  onPeerFreeze: ((octet: number) => void) | null = null;
  onPeerThaw: ((octet: number) => void) | null = null;

  /** Frames forwarded in each direction — diagnostics/tests. */
  framesOut = 0;
  framesIn = 0;
  /** Proxy-ARP answers served for known TAN members — diagnostics. */
  proxyArpReplies = 0;
  /** Resident-sourced frames kept off the trunk (both directions). */
  residentFramesKept = 0;

  /**
   * Every octet ever claimed on this channel (including our own). The
   * lease registry doubles as an ARP directory: member MACs derive
   * deterministically from octets, so who-has for any known member can
   * be answered locally, instantly — see {@link #maybeProxyArp}.
   */
  readonly #knownOctets = new Set<number>();

  constructor(channel: FrameChannel, opts: TabAreaNetworkOptions = {}) {
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

  get identity(): TanIdentity | null {
    return this.#identity;
  }

  /**
   * Every octet known live on this channel (leases seen + our own),
   * ascending — the `?peers` directory. Claims are never expired, so a
   * closed tab lingers until its octet is re-leased; the census makes
   * fresh joins accurate.
   */
  get memberOctets(): readonly number[] {
    return [...this.#knownOctets].sort((a, b) => a - b);
  }

  /**
   * Acquire a unique identity on the TAN. With a fixed `hostOctet`
   * this resolves immediately (the claim is still announced so other
   * tabs learn it). Otherwise: pick a random free-looking octet,
   * announce, listen {@link DEFAULT_CLAIM_WAIT_MS} for a defence from
   * an existing holder, repick on conflict.
   */
  async acquire(): Promise<TanIdentity> {
    if (this.#identity !== null) {
      this.#channel.postMessage({ tan: 'claim', octet: this.#identity.hostOctet });
      return this.#identity;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      // Sticky IP: the persisted octet from the last session gets first
      // shot; a live holder (e.g. the original of a duplicated tab)
      // defends it and the fallback picks are random as before.
      const octet =
        attempt === 0 && this.#preferredOctet !== null
          ? this.#preferredOctet
          : this.#pickOctet();
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

  /** Whether a LAN is currently bridged onto the trunk (Phase 18 M3:
   *  a cloned/restored machine boots with this deliberately false —
   *  its guest wears another tab's MAC+IP and would RST that tab's
   *  connections; field-found 2026-07-16). */
  get lanAttached(): boolean {
    return this.#trunk !== null;
  }

  /** Bridge a switch onto the TAN. Call after {@link acquire}. */
  attach(lan: EthernetSwitch): void {
    if (this.#trunk !== null) throw new Error('TAN: already attached');
    this.#lan = lan;
    this.#trunk = lan.attach({
      name: 'tan-trunk',
      onFrame: (frame) => {
        // Resident-sourced frames never leave the tab: the neighbour
        // has an identical resident of its own, and this copy's ARP
        // reply would win its CAM and hijack its guest's DNS/gateway
        // traffic to a tab whose stall can't protect it (see header).
        if (isResidentSourced(frame)) {
          this.residentFramesKept++;
          return;
        }
        // Local frame flooded/routed to the trunk → other tabs.
        this.framesOut++;
        this.conntrack.observe(frame);
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

  #maybeProxyArp(frame: Uint8Array): void {
    if (this.#trunk === null || frame.length < 14 + 28) return;
    if ((((frame[12] ?? 0) << 8) | (frame[13] ?? 0)) !== ETHERTYPE_ARP) return;
    const arp = parseArp(frame.subarray(14));
    if (arp === null || arp.op !== ARP_OP_REQUEST) return;
    const [a, b, c, octet] = arp.targetIp;
    if (a !== 10 || b !== 0 || c !== 2 || octet === undefined) return;
    if (!this.#knownOctets.has(octet)) return;
    if (this.#identity !== null && octet === this.#identity.hostOctet) return; // our own guest answers itself
    const member = tanIdentityFor(octet);
    this.proxyArpReplies++;
    // Enters the local switch as trunk traffic — the CAM learns the
    // member's MAC on the trunk port, exactly where real frames to it
    // go.
    this.#trunk.transmit(
      buildEthernetFrame(
        arp.senderMac,
        member.mac,
        ETHERTYPE_ARP,
        buildArp(ARP_OP_REPLY, member.mac, member.ip, arp.senderMac, arp.senderIp),
      ),
    );
  }

  /** Announce our death (pagehide) — peers with open connections to
   *  us hold still. No-op before the identity settles. */
  broadcastFreeze(): void {
    if (this.#identity === null) return;
    this.#channel.postMessage({ tan: 'freeze', octet: this.#identity.hostOctet });
  }

  /** Announce our return (restore outcome known, or bfcache revival). */
  broadcastThaw(): void {
    if (this.#identity === null) return;
    this.#channel.postMessage({ tan: 'thaw', octet: this.#identity.hostOctet });
  }

  /**
   * Unplug from the current switch only — identity, channel, and
   * defence stay live so a rebooting tab keeps its address and other
   * tabs' claims still get answered. Frames arriving trunkless drop.
   */
  detachLan(): void {
    this.#trunk?.detach();
    this.#trunk = null;
    this.#lan = null;
  }

  /** Full shutdown: leave the LAN and release the channel. */
  close(): void {
    this.detachLan();
    this.#channel.onmessage = null;
    this.#channel.close?.();
  }

  #onChannelMessage(data: unknown): void {
    if (!isTanMsg(data)) return;
    if (data.tan === 'frame') {
      if (this.#trunk === null) return;
      const bytes = data.bytes instanceof Uint8Array ? data.bytes : Uint8Array.from(data.bytes);
      // Defence in depth: a tab running an older build may still trunk
      // its residents' frames — drop them at ingress too.
      if (isResidentSourced(bytes)) {
        this.residentFramesKept++;
        return;
      }
      this.framesIn++;
      this.conntrack.observe(bytes);
      // Enters the local switch as trunk-port traffic; the switch never
      // echoes to the ingress port, so nothing re-posts to the channel.
      this.#trunk.transmit(bytes);
      return;
    }
    if (data.tan === 'here') {
      // Census reply from a settled member. Pure directory information:
      // record it, and treat it as a conflict if it lands on the octet
      // we are provisionally claiming.
      if (!Number.isInteger(data.octet)) return;
      this.#knownOctets.add(data.octet);
      const mine = this.#identity;
      if (mine !== null && !this.#settled && data.octet === mine.hostOctet) {
        this.#conflictSeen = true;
      }
      return;
    }
    if (data.tan === 'freeze' || data.tan === 'thaw') {
      if (!Number.isInteger(data.octet)) return;
      if (this.#identity !== null && data.octet === this.#identity.hostOctet) return;
      if (data.tan === 'freeze') this.onPeerFreeze?.(data.octet);
      else this.onPeerThaw?.(data.octet);
      return;
    }
    if (data.tan === 'claim') {
      if (!Number.isInteger(data.octet)) return;
      this.#knownOctets.add(data.octet);
      const mine = this.#identity;
      if (mine !== null && data.octet === mine.hostOctet) {
        if (this.#settled) {
          // Settled holder: always defend, so the newcomer repicks.
          this.#channel.postMessage({ tan: 'claim', octet: mine.hostOctet });
        } else {
          // We're mid-claim ourselves: a matching claim (defence or a
          // simultaneous newcomer) means this octet is contested.
          this.#conflictSeen = true;
        }
      } else if (this.#settled && mine !== null) {
        // Census: answer every newcomer's claim with our own octet, so
        // it learns the entire membership in ONE round and can pick the
        // lowest free name. `here` draws no reply, so this terminates.
        this.#channel.postMessage({ tan: 'here', octet: mine.hostOctet });
      }
    }
  }

  /**
   * The lowest octet nobody is known to hold — so the first tab is
   * `mouse`, the second `cat`, the third `dog`. Falls back to a random
   * pick only if the whole range looks taken (184 tabs, in which case
   * the collision protocol sorts it out).
   */
  #pickOctet(): number {
    for (let octet = OCTET_MIN; octet <= OCTET_MAX; octet++) {
      if (!this.#knownOctets.has(octet)) return octet;
    }
    return OCTET_MIN + Math.floor(this.#random() * (OCTET_MAX - OCTET_MIN + 1));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
