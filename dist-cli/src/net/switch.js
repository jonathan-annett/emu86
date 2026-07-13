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
const ETH_HEADER = 14;
export class EthernetSwitch {
    #ports = [];
    /** CAM table: MAC (as lowercase hex key) → port. */
    #cam = new Map();
    #runtsDropped = 0;
    attach(opts) {
        const state = {
            name: opts.name ?? `port${this.#ports.length}`,
            onFrame: opts.onFrame,
            attached: true,
        };
        this.#ports.push(state);
        return {
            transmit: (frame) => this.#dispatch(state, frame),
            detach: () => {
                state.attached = false;
                const idx = this.#ports.indexOf(state);
                if (idx >= 0)
                    this.#ports.splice(idx, 1);
                for (const [mac, port] of this.#cam) {
                    if (port === state)
                        this.#cam.delete(mac);
                }
            },
        };
    }
    /** Frames dropped for being shorter than an ethernet header. */
    get runtsDropped() {
        return this.#runtsDropped;
    }
    /** Diagnostic snapshot: port names and the learned MAC table. */
    describe() {
        const cam = {};
        for (const [mac, port] of this.#cam)
            cam[mac] = port.name;
        return { ports: this.#ports.map((p) => p.name), cam };
    }
    #dispatch(from, frame) {
        if (!from.attached)
            return;
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
            if (port !== from && port.attached)
                port.onFrame(frame);
        }
    }
}
function macKey(frame, offset) {
    let key = '';
    for (let i = 0; i < 6; i++) {
        key += ((frame[offset + i] ?? 0) & 0xff).toString(16).padStart(2, '0');
    }
    return key;
}
