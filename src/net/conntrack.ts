/**
 * TanConntrack — connection accounting for the Tab Area Network
 * (TAN-freeze brief, M1).
 *
 * The TAN trunk forwards frames without knowing what rides them; this
 * module watches the same frames and keeps a live table of TCP flows,
 * so a tab can answer "does my guest have a session open to cat?" —
 * the question the network freeze (M2) and the inspect popup's
 * connection list both ask. tab-shark (M3) reuses it verbatim on a
 * bare channel subscription for the whole-network view: the table is
 * endpoint-neutral (every flow crossing the trunk is tracked, not
 * just the local guest's — BroadcastChannel is a bus, so the frames
 * arrive anyway), and the per-tab views filter by octet.
 *
 * Timerless, like tcp.ts: no clocks in the substrate. Life cycle is
 * driven purely by observed segments —
 *   - SYN creates a flow ('syn', the sender is the initiator); a
 *     SYN+ACK on an unknown tuple also creates it (we can still name
 *     the initiator: the SYN+ACK's destination).
 *   - The first plain segment moves 'syn' → 'established'.
 *   - A FIN marks its side; the second side's FIN retires the flow.
 *   - RST retires it immediately.
 *   - A DATA segment (payload > 0) on an unknown tuple creates the
 *     flow as 'established' with an unknown initiator. This is what
 *     carries a session across capture/restore: the restored tab's
 *     table starts empty, and the first keystroke's segment rebuilds
 *     the entry mid-stream. Pure ACKs deliberately do NOT create
 *     flows — the final ACK of a close would otherwise resurrect
 *     every cleanly-closed connection as a ghost.
 *
 * Deliberately NO pruning on TAN claims: a restored tab re-announces
 * its claim at boot, and wiping the peer's live entries at that
 * moment would blind the very next freeze decision. Flows for
 * genuinely dead octets die by RST on first contact or fall off the
 * LRU cap.
 */

import { nameForOctet } from './tan-names.js';
import {
  ETHERTYPE_IPV4,
  IPPROTO_TCP,
  TCP_ACK,
  TCP_FIN,
  TCP_RST,
  TCP_SYN,
  parseIpv4,
  parseTcpSegment,
} from './wire.js';

export type TanFlowState = 'syn' | 'established' | 'closing';

/** One tracked flow, endpoint-neutral (tab-shark's view). */
export interface TanFlow {
  readonly octetA: number;
  readonly portA: number;
  readonly octetB: number;
  readonly portB: number;
  readonly state: TanFlowState;
  /** Octet that sent the first SYN; null when tracked from mid-stream. */
  readonly initiator: number | null;
}

/** A flow seen from one tab's perspective (the inspect popup's view). */
export interface TanPeerConnection {
  readonly peerOctet: number;
  readonly peerName: string | null;
  readonly localPort: number;
  readonly peerPort: number;
  readonly state: TanFlowState;
  /** true = our guest dialed, false = the peer dialed, null = unknown
   *  (tracked from mid-stream, e.g. after a restore). */
  readonly outbound: boolean | null;
}

interface FlowEntry {
  octetA: number;
  portA: number;
  octetB: number;
  portB: number;
  state: TanFlowState;
  initiator: number | null;
  finFromA: boolean;
  finFromB: boolean;
}

const DEFAULT_MAX_FLOWS = 256;

export class TanConntrack {
  readonly #maxFlows: number;
  /** Keyed by canonical tuple; insertion order doubles as LRU (every
   *  touch re-inserts, so the first key is always the coldest). */
  readonly #flows = new Map<string, FlowEntry>();

  constructor(opts: { maxFlows?: number } = {}) {
    this.#maxFlows = opts.maxFlows ?? DEFAULT_MAX_FLOWS;
  }

  /** Observe one raw ethernet frame crossing the trunk (either way). */
  observe(frame: Uint8Array): void {
    if (frame.length < 14 + 40) return; // eth + minimal IPv4+TCP
    if ((((frame[12] ?? 0) << 8) | (frame[13] ?? 0)) !== ETHERTYPE_IPV4) return;
    const ip = parseIpv4(frame.subarray(14));
    if (ip === null || ip.protocol !== IPPROTO_TCP) return;
    // Only guest↔guest TAN flows: both ends on 10.0.2.x. (Resident
    // traffic never crosses the trunk, but tab-shark feeds us a bare
    // channel where defence in depth costs nothing.)
    const srcOctet = tanOctet(ip.srcIp);
    const dstOctet = tanOctet(ip.dstIp);
    if (srcOctet === null || dstOctet === null) return;
    const seg = parseTcpSegment(ip.srcIp, ip.dstIp, ip.payload);
    if (seg === null) return;

    const key = flowKey(srcOctet, seg.srcPort, dstOctet, seg.dstPort);
    const existing = this.#flows.get(key);

    if ((seg.flags & TCP_RST) !== 0) {
      this.#flows.delete(key);
      return;
    }

    if ((seg.flags & TCP_SYN) !== 0) {
      if (existing !== undefined) {
        this.#touch(key, existing); // retransmit/simultaneous open — keep
        return;
      }
      // A bare SYN names the sender as initiator; a SYN+ACK names its
      // destination (it answers the SYN we didn't see).
      const isSynAck = (seg.flags & TCP_ACK) !== 0;
      this.#insert(key, {
        ...canonical(srcOctet, seg.srcPort, dstOctet, seg.dstPort),
        state: 'syn',
        initiator: isSynAck ? dstOctet : srcOctet,
        finFromA: false,
        finFromB: false,
      });
      return;
    }

    if ((seg.flags & TCP_FIN) !== 0) {
      if (existing === undefined) return; // half a close we never knew
      const fromA = srcOctet === existing.octetA && seg.srcPort === existing.portA;
      if (fromA) existing.finFromA = true;
      else existing.finFromB = true;
      if (existing.finFromA && existing.finFromB) {
        this.#flows.delete(key);
      } else {
        existing.state = 'closing';
        this.#touch(key, existing);
      }
      return;
    }

    // Plain segment (ACK and/or data).
    if (existing !== undefined) {
      if (existing.state === 'syn') existing.state = 'established';
      this.#touch(key, existing);
      return;
    }
    if (seg.payload.length > 0) {
      // Mid-stream data on an unknown tuple: a live session we joined
      // late (restore, or tab-shark opened mid-conversation).
      this.#insert(key, {
        ...canonical(srcOctet, seg.srcPort, dstOctet, seg.dstPort),
        state: 'established',
        initiator: null,
        finFromA: false,
        finFromB: false,
      });
    }
    // Pure ACK on an unknown tuple: ignored (see header — ghosts).
  }

  /** Every tracked flow (tab-shark's whole-network table). */
  flows(): TanFlow[] {
    return [...this.#flows.values()].map((f) => ({
      octetA: f.octetA,
      portA: f.portA,
      octetB: f.octetB,
      portB: f.portB,
      state: f.state,
      initiator: f.initiator,
    }));
  }

  /** Flows involving `octet`, seen from its side of the wire. */
  connectionsFor(octet: number): TanPeerConnection[] {
    const out: TanPeerConnection[] = [];
    for (const f of this.#flows.values()) {
      const localIsA = f.octetA === octet;
      if (!localIsA && f.octetB !== octet) continue;
      const peerOctet = localIsA ? f.octetB : f.octetA;
      out.push({
        peerOctet,
        peerName: nameForOctet(peerOctet),
        localPort: localIsA ? f.portA : f.portB,
        peerPort: localIsA ? f.portB : f.portA,
        state: f.state,
        outbound: f.initiator === null ? null : f.initiator === octet,
      });
    }
    return out;
  }

  /** Any tracked flow (any state) between these two octets? */
  hasPeer(localOctet: number, peerOctet: number): boolean {
    for (const f of this.#flows.values()) {
      if (
        (f.octetA === localOctet && f.octetB === peerOctet) ||
        (f.octetA === peerOctet && f.octetB === localOctet)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Does `octet` have any tracked flow at all? */
  hasAnyPeerFor(octet: number): boolean {
    for (const f of this.#flows.values()) {
      if (f.octetA === octet || f.octetB === octet) return true;
    }
    return false;
  }

  get size(): number {
    return this.#flows.size;
  }

  #insert(key: string, entry: FlowEntry): void {
    this.#flows.set(key, entry);
    while (this.#flows.size > this.#maxFlows) {
      const coldest = this.#flows.keys().next().value;
      if (coldest === undefined) break;
      this.#flows.delete(coldest);
    }
  }

  #touch(key: string, entry: FlowEntry): void {
    this.#flows.delete(key);
    this.#flows.set(key, entry);
  }
}

/** Host octet if the address is on the TAN subnet (10.0.2.x), else null. */
function tanOctet(ip: readonly number[]): number | null {
  return ip[0] === 10 && ip[1] === 0 && ip[2] === 2 && ip[3] !== undefined
    ? ip[3]
    : null;
}

function canonical(
  oA: number,
  pA: number,
  oB: number,
  pB: number,
): Pick<FlowEntry, 'octetA' | 'portA' | 'octetB' | 'portB'> {
  if (oA < oB || (oA === oB && pA <= pB)) {
    return { octetA: oA, portA: pA, octetB: oB, portB: pB };
  }
  return { octetA: oB, portA: pB, octetB: oA, portB: pA };
}

function flowKey(oA: number, pA: number, oB: number, pB: number): string {
  const c = canonical(oA, pA, oB, pB);
  return `${c.octetA}:${c.portA}|${c.octetB}:${c.portB}`;
}
