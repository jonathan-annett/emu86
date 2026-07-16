/**
 * Ethernet frame switch — Phase 14 M3a.
 *
 * The browser-side "LAN" from `emu86-networking-plan.md`: a learning
 * switch that routes ethernet frames between attached ports by
 * destination MAC. The emulated NE2000 is one port; pseudo-hosts (ARP
 * responder, DNS-over-DoH, the HTTP gateway — later milestones) attach
 * as further ports.
 *
 * Semantics, deliberately plain:
 *
 *   - **Learning**: the source MAC of every transmitted frame binds
 *     that MAC to the sending port (last writer wins, moves are
 *     honoured — same as a real switch's CAM table, no aging).
 *   - **Unicast** to a learned MAC delivers to that port only.
 *   - **Broadcast/multicast** (I/G bit — bit 0 of octet 0) and
 *     unknown unicast flood to every port except the sender.
 *   - Frames never echo back to their sender.
 *   - Runt guard: frames shorter than an ethernet header (14 bytes)
 *     are dropped and counted rather than dispatched.
 *
 * No async anywhere — `transmit` dispatches synchronously to the
 * receivers' callbacks. Pseudo-hosts that need async work (fetch)
 * queue internally and call their port's `transmit` later; the switch
 * itself stays a pure frame router.
 */

export interface AttachOptions {
  /** Diagnostic name (shows up in {@link EthernetSwitch.describe}). */
  readonly name?: string;
  /** Called with a copy-safe view of every frame delivered to this port. */
  readonly onFrame: (frame: Uint8Array) => void;
}

export interface SwitchPort {
  /** Send a frame from this port into the switch. */
  transmit(frame: Uint8Array): void;
  /** Remove the port; its learned MACs are forgotten. */
  detach(): void;
}

const ETH_HEADER = 14;

interface PortState {
  readonly name: string;
  readonly onFrame: (frame: Uint8Array) => void;
  attached: boolean;
}

/**
 * Serialized CAM table (Phase 18 M1). Ports are identified by their
 * attach-time `name` — the wiring layer attaches with stable unique
 * names ('ne2000', 'gateway', 'dns'), and a restored table only makes
 * sense against the same port set. Recon hard problem 5 is why this
 * exists at all: the CAM learns only from source MACs, a restored guest
 * may never re-ARP, and an empty post-restore CAM kills its unicast
 * delivery silently.
 */
export interface EthernetSwitchState {
  readonly v: 1;
  /** [macKey (lowercase hex), portName] pairs. */
  readonly cam: ReadonlyArray<readonly [string, string]>;
  readonly runtsDropped: number;
}

export class EthernetSwitch {
  readonly #ports: PortState[] = [];
  /** CAM table: MAC (as lowercase hex key) → port. */
  readonly #cam = new Map<string, PortState>();
  #runtsDropped = 0;

  attach(opts: AttachOptions): SwitchPort {
    const state: PortState = {
      name: opts.name ?? `port${this.#ports.length}`,
      onFrame: opts.onFrame,
      attached: true,
    };
    this.#ports.push(state);
    return {
      transmit: (frame: Uint8Array) => this.#dispatch(state, frame),
      detach: () => {
        state.attached = false;
        const idx = this.#ports.indexOf(state);
        if (idx >= 0) this.#ports.splice(idx, 1);
        for (const [mac, port] of this.#cam) {
          if (port === state) this.#cam.delete(mac);
        }
      },
    };
  }

  /** Frames dropped for being shorter than an ethernet header. */
  get runtsDropped(): number {
    return this.#runtsDropped;
  }

  serializeState(): EthernetSwitchState {
    const cam: Array<readonly [string, string]> = [];
    for (const [mac, port] of this.#cam) cam.push([mac, port.name]);
    return { v: 1, cam, runtsDropped: this.#runtsDropped };
  }

  /**
   * Restore a captured CAM against the CURRENT port set, matching by
   * port name. An entry naming a port that isn't attached is a config
   * mismatch — fail loud rather than drop it (a silently thinner CAM is
   * exactly the failure mode this serialization exists to prevent).
   * With duplicate port names the first attached match wins; the wiring
   * layer keeps names unique.
   */
  restoreState(state: EthernetSwitchState): void {
    if (state.v !== 1) {
      throw new Error(`EthernetSwitch.restoreState: unsupported schema version ${String(state.v)}`);
    }
    const byName = new Map<string, PortState>();
    for (const p of this.#ports) {
      if (!byName.has(p.name)) byName.set(p.name, p);
    }
    const resolved: Array<[string, PortState]> = [];
    for (const [mac, portName] of state.cam) {
      const port = byName.get(portName);
      if (port === undefined) {
        throw new Error(`EthernetSwitch.restoreState: no attached port named '${portName}'`);
      }
      resolved.push([mac, port]);
    }
    this.#cam.clear();
    for (const [mac, port] of resolved) this.#cam.set(mac, port);
    this.#runtsDropped = state.runtsDropped;
  }

  /** Diagnostic snapshot: port names and the learned MAC table. */
  describe(): { ports: string[]; cam: Record<string, string> } {
    const cam: Record<string, string> = {};
    for (const [mac, port] of this.#cam) cam[mac] = port.name;
    return { ports: this.#ports.map((p) => p.name), cam };
  }

  #dispatch(from: PortState, frame: Uint8Array): void {
    if (!from.attached) return;
    if (frame.length < ETH_HEADER) {
      this.#runtsDropped++;
      return;
    }

    // Learn the source MAC (octets 6..11).
    this.#cam.set(macKey(frame, 6), from);

    const destKey = macKey(frame, 0);
    const destByte0 = frame[0] ?? 0;
    const isGroup = (destByte0 & 0x01) !== 0; // broadcast or multicast

    if (!isGroup) {
      const target = this.#cam.get(destKey);
      if (target !== undefined && target !== from && target.attached) {
        target.onFrame(frame);
        return;
      }
      // Unknown unicast → flood (fall through).
    }
    for (const port of this.#ports) {
      if (port !== from && port.attached) port.onFrame(frame);
    }
  }
}

function macKey(frame: Uint8Array, offset: number): string {
  let key = '';
  for (let i = 0; i < 6; i++) {
    key += ((frame[offset + i] ?? 0) & 0xff).toString(16).padStart(2, '0');
  }
  return key;
}
