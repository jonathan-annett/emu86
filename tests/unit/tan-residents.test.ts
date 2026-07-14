/**
 * Reserved residents must stay tab-local on the TAN (field, 2026-07-15).
 *
 * Every tab hosts its own gateway (10.0.2.2) and DNS host (10.0.2.3)
 * with FIXED, identical MACs. On a TAN, a guest's ARP who-has for a
 * resident is answered by its OWN tab's resident — and then, via the
 * trunk, by every other tab's too. Same MAC, so the answers look
 * interchangeable ("anycast quirk, harmless" — tan.ts). They are not:
 * the LAST reply wins the CAM, and the remote one arrives last, so the
 * guest's DNS queries and gateway TCP get served by ANOTHER TAB —
 * where the DNS-stall (worker-host pauses the machine while ITS OWN
 * DnsHost has a resolve in flight) cannot protect this guest's
 * in_resolv 2-second alarm, and where the DoH answer cache that feeds
 * the HTTP gateway's reverse map is the wrong tab's. Field symptom:
 * the OLD first-resolve "Name not found" bug (killed by the stall in
 * 5c0aa63) resurfaced, but only with two tabs open.
 *
 * The fix: resident traffic never crosses the trunk. Frames sourced
 * from a reserved resident MAC are not posted to the channel, and are
 * dropped if one arrives from it (an unfixed tab on the same channel).
 */

import { describe, it, expect } from 'vitest';
import { EthernetSwitch } from '../../src/net/switch.js';
import { TabAreaNetwork, type FrameChannel } from '../../src/net/tan.js';
import { DnsHost, DNS_MAC } from '../../src/net/dns.js';
import { LanGateway } from '../../src/net/gateway.js';
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  MAC_BROADCAST,
  buildArp,
  buildEthernetFrame,
  type Mac,
} from '../../src/net/wire.js';

/**
 * DEFERRED BroadcastChannel-alike hub. Unlike tan.test.ts's synchronous
 * hub, deliveries queue until pump() — because the ordering IS the bug:
 * in a real browser the local resident's ARP reply lands synchronously
 * and the remote tab's copy arrives LATER over the channel, so the
 * remote one wins the CAM. A synchronous hub delivers the remote reply
 * first and hides the hijack.
 */
function makeHub(): { join(): FrameChannel; pump(): void } {
  const members: FrameChannel[] = [];
  const queue: Array<() => void> = [];
  return {
    join(): FrameChannel {
      const member: FrameChannel = {
        onmessage: null,
        postMessage(data: unknown) {
          for (const other of members) {
            if (other !== member) queue.push(() => other.onmessage?.({ data }));
          }
        },
      };
      members.push(member);
      return member;
    },
    pump(): void {
      while (queue.length > 0) queue.shift()?.();
    },
  };
}

const GUEST_A_MAC: Mac = [0x02, 0x65, 0x6d, 0x75, 0x38, 16];

/** Two tabs, each with its own switch, DNS host, gateway, and TAN. */
function twoTabs() {
  const hub = makeHub();
  const lanA = new EthernetSwitch();
  const lanB = new EthernetSwitch();
  const tanA = new TabAreaNetwork(hub.join(), { hostOctet: 16 });
  const tanB = new TabAreaNetwork(hub.join(), { hostOctet: 17 });
  tanA.attach(lanA);
  tanB.attach(lanB);
  const never = (): Promise<Uint8Array> => new Promise(() => {});
  const dnsA = new DnsHost({ resolve: never });
  const dnsB = new DnsHost({ resolve: never });
  dnsA.attachTo(lanA);
  dnsB.attachTo(lanB);
  const gwA = new LanGateway();
  const gwB = new LanGateway();
  gwA.attachTo(lanA);
  gwB.attachTo(lanB);

  const rxA: Uint8Array[] = [];
  const guestA = lanA.attach({ name: 'nicA', onFrame: (f) => rxA.push(f) });
  return { hub, lanA, lanB, tanA, tanB, dnsA, dnsB, gwA, gwB, rxA, guestA };
}

function whoHasOwl(): Uint8Array {
  return buildEthernetFrame(
    MAC_BROADCAST,
    GUEST_A_MAC,
    ETHERTYPE_ARP,
    buildArp(ARP_OP_REQUEST, GUEST_A_MAC, [10, 0, 2, 16], [0, 0, 0, 0, 0, 0], [10, 0, 2, 3]),
  );
}

describe('TAN — reserved residents stay tab-local', () => {
  it('a who-has for the DNS host draws exactly ONE reply (the local one)', () => {
    const t = twoTabs();
    t.guestA.transmit(whoHasOwl());
    t.hub.pump(); // the remote tab hears it and (today) also answers
    t.hub.pump(); // ...and its answer crosses back
    // Two identical replies today: local dnsA synchronously, then
    // dnsB's through the trunk — the one whose CAM learning is what
    // hijacks later unicast.
    const arpReplies = t.rxA.filter(
      (f) => (((f[12] ?? 0) << 8) | (f[13] ?? 0)) === ETHERTYPE_ARP,
    );
    expect(arpReplies).toHaveLength(1);
  });

  it("the guest's unicast to the DNS MAC never crosses the trunk", () => {
    const t = twoTabs();
    t.guestA.transmit(whoHasOwl());
    t.hub.pump(); // remote resident answers...
    t.hub.pump(); // ...and its reply, arriving LAST, wins lanA's CAM
    const framesOutBefore = t.tanA.framesOut;
    // The guest talks TCP:53 to owl — a unicast frame to the DNS MAC.
    // (Payload irrelevant: the CAM routes on the MAC alone.)
    t.guestA.transmit(
      buildEthernetFrame(DNS_MAC, GUEST_A_MAC, ETHERTYPE_IPV4, new Uint8Array(28)),
    );
    t.hub.pump();
    // It must be served by THIS tab's DnsHost — the one whose pending
    // resolves stall THIS machine — not disappear across the trunk.
    expect(t.tanA.framesOut - framesOutBefore).toBe(0);
  });

  it('drops resident-sourced frames arriving from an older tab (ingress defence)', () => {
    const t = twoTabs();
    // A tab running a pre-filter build trunks its DNS host's ARP reply.
    // Simulate it: post a DNS-MAC-sourced frame straight on the channel.
    const rogue = buildEthernetFrame(GUEST_A_MAC, DNS_MAC, ETHERTYPE_IPV4, new Uint8Array(28));
    const channelB = t.hub.join();
    channelB.postMessage({ tan: 'frame', bytes: rogue });
    t.hub.pump();
    expect(t.rxA).toHaveLength(0); // never reached the guest
    expect(t.tanA.residentFramesKept).toBeGreaterThanOrEqual(1);
  });

  it('guest-to-guest frames still cross (the filter is residents-only)', () => {
    const t = twoTabs();
    const rxB: Uint8Array[] = [];
    t.lanB.attach({ name: 'nicB', onFrame: (f) => rxB.push(f) });
    t.guestA.transmit(
      buildEthernetFrame(MAC_BROADCAST, GUEST_A_MAC, ETHERTYPE_IPV4, new Uint8Array(28)),
    );
    t.hub.pump();
    expect(rxB).toHaveLength(1);
  });
});
