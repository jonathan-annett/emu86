/**
 * TAN unit tests (Phase 14 M3-tabs).
 *
 * A synchronous hub stands in for BroadcastChannel: postMessage on one
 * member delivers immediately to every OTHER member (same
 * no-echo-to-sender semantics as the real thing, browser and Node
 * alike), so trunking and lease behaviour test deterministically.
 */

import { describe, it, expect } from 'vitest';
import { EthernetSwitch } from '../../src/net/switch.js';
import {
  TabAreaNetwork,
  tanIdentityFor,
  type FrameChannel,
} from '../../src/net/tan.js';

/** Synchronous BroadcastChannel-alike hub. */
function makeHub(): { join(): FrameChannel } {
  const members: FrameChannel[] = [];
  return {
    join(): FrameChannel {
      const member: FrameChannel = {
        onmessage: null,
        postMessage(data: unknown) {
          for (const other of members) {
            if (other !== member) other.onmessage?.({ data });
          }
        },
      };
      members.push(member);
      return member;
    },
  };
}

function broadcastFrame(fill: number): Uint8Array {
  const f = new Uint8Array(64).fill(fill);
  f.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);          // broadcast dst
  f.set([0x02, 0x65, 0x6d, 0x75, 0x38, fill & 0xff], 6);   // src
  return f;
}

describe('tanIdentityFor', () => {
  it('derives ip, mac, and the LOCALIP bootopts line from the octet', () => {
    const id = tanIdentityFor(42);
    expect(id.ip).toEqual([10, 0, 2, 42]);
    expect(id.mac).toEqual([0x02, 0x65, 0x6d, 0x75, 0x38, 42]);
    expect(id.localipLine).toBe('LOCALIP=10.0.2.42');
  });

  it('rejects out-of-range octets', () => {
    expect(() => tanIdentityFor(0)).toThrow();
    expect(() => tanIdentityFor(255)).toThrow();
  });
});

describe('TAN trunking', () => {
  it('bridges frames between two switches, no echo to the origin LAN', () => {
    const hub = makeHub();
    const lanA = new EthernetSwitch();
    const lanB = new EthernetSwitch();
    const tanA = new TabAreaNetwork(hub.join(), { hostOctet: 21 });
    const tanB = new TabAreaNetwork(hub.join(), { hostOctet: 22 });
    tanA.attach(lanA);
    tanB.attach(lanB);

    const rxA: Uint8Array[] = [];
    const rxB: Uint8Array[] = [];
    const hostA = lanA.attach({ name: 'nicA', onFrame: (f) => rxA.push(f) });
    lanB.attach({ name: 'nicB', onFrame: (f) => rxB.push(f) });

    hostA.transmit(broadcastFrame(21));
    expect(rxB).toHaveLength(1);          // crossed the trunk
    expect(rxA).toHaveLength(0);          // no local echo
    expect(tanA.framesOut).toBe(1);
    expect(tanB.framesIn).toBe(1);
    expect(tanB.framesOut).toBe(0);       // never re-posted (no loop)
  });

  it('floods to every member of a three-tab TAN exactly once', () => {
    const hub = makeHub();
    const lans = [new EthernetSwitch(), new EthernetSwitch(), new EthernetSwitch()];
    const tans = lans.map((lan, i) => {
      const tan = new TabAreaNetwork(hub.join(), { hostOctet: 21 + i });
      tan.attach(lan);
      return tan;
    });
    const rx: Uint8Array[][] = [[], [], []];
    const ports = lans.map((lan, i) =>
      lan.attach({ name: `nic${i}`, onFrame: (f) => rx[i]!.push(f) }),
    );

    ports[0]!.transmit(broadcastFrame(1));
    expect(rx[1]).toHaveLength(1);
    expect(rx[2]).toHaveLength(1);
    expect(rx[0]).toHaveLength(0);
    expect(tans[1]!.framesOut).toBe(0);
    expect(tans[2]!.framesOut).toBe(0);
  });

  it('detachLan stops forwarding but keeps the channel handler', () => {
    const hub = makeHub();
    const lanA = new EthernetSwitch();
    const tanA = new TabAreaNetwork(hub.join(), { hostOctet: 21 });
    const chanB = hub.join();
    tanA.attach(lanA);
    tanA.detachLan();
    const hostA = lanA.attach({ name: 'nicA', onFrame: () => { /* sink */ } });
    let bGot = 0;
    chanB.onmessage = () => {
      bGot++;
    };
    hostA.transmit(broadcastFrame(9));
    expect(bGot).toBe(0);
    expect(tanA.framesOut).toBe(0);
  });
});

describe('TAN identity lease', () => {
  it('settled holders defend; a newcomer repicks to a free octet', async () => {
    const hub = makeHub();
    const holder = new TabAreaNetwork(hub.join(), { hostOctet: 21 });
    holder.attach(new EthernetSwitch());

    // Newcomer's random insists on 21 first, then yields 22.
    const picks = [21, 22].map((o) => (o - 16) / (199 - 16 + 1));
    let pickIdx = 0;
    const newcomer = new TabAreaNetwork(hub.join(), {
      claimWaitMs: 5,
      random: () => picks[Math.min(pickIdx++, picks.length - 1)]!,
    });
    const id = await newcomer.acquire();
    expect(id.hostOctet).toBe(22);
    expect(holder.identity?.hostOctet).toBe(21);
  });

  it('acquire with a fixed octet resolves immediately and re-announces', async () => {
    const hub = makeHub();
    const listener = hub.join();
    const claims: number[] = [];
    listener.onmessage = (ev) => {
      const d = ev.data as { tan?: string; octet?: number };
      if (d.tan === 'claim' && typeof d.octet === 'number') claims.push(d.octet);
    };
    const tan = new TabAreaNetwork(hub.join(), { hostOctet: 33 });
    const id = await tan.acquire();
    expect(id.hostOctet).toBe(33);
    expect(claims).toEqual([33]);
  });

  it('a free preferred octet is granted first try (sticky IP across reloads)', async () => {
    const hub = makeHub();
    const tan = new TabAreaNetwork(hub.join(), {
      preferredOctet: 42,
      claimWaitMs: 5,
      random: () => { throw new Error('random must not be consulted'); },
    });
    const id = await tan.acquire();
    expect(id.hostOctet).toBe(42);
  });

  it('a defended preferred octet is repicked (the duplicated-tab case)', async () => {
    const hub = makeHub();
    const original = new TabAreaNetwork(hub.join(), { hostOctet: 42 });
    original.attach(new EthernetSwitch());

    // The duplicate's copied session store offers the SAME octet; the
    // live original defends it and the fallback pick lands on 57.
    const duplicate = new TabAreaNetwork(hub.join(), {
      preferredOctet: 42,
      claimWaitMs: 5,
      random: () => (57 - 16 + 0.5) / (199 - 16 + 1), // midpoint — float-safe
    });
    const id = await duplicate.acquire();
    expect(id.hostOctet).toBe(57);
    expect(original.identity?.hostOctet).toBe(42);
  });

  it('an out-of-range preferred octet is ignored, not thrown', async () => {
    const hub = makeHub();
    const tan = new TabAreaNetwork(hub.join(), {
      preferredOctet: 3, // DNS pseudo-host — outside the lease range
      claimWaitMs: 5,
      random: () => (77 - 16 + 0.5) / (199 - 16 + 1), // midpoint — float-safe
    });
    const id = await tan.acquire();
    expect(id.hostOctet).toBe(77);
  });
});
