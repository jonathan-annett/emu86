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
import { nameForOctet } from '../../src/net/tan-names.js';

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
  it('settled holders defend; a newcomer repicks to the next free octet', async () => {
    const hub = makeHub();
    // The holder is `mouse` (16). The newcomer's first pick is the
    // lowest free octet it knows of — also 16 — so it collides, gets
    // defended off, learns the membership, and lands on 17: `cat`.
    const holder = new TabAreaNetwork(hub.join(), { hostOctet: 16 });
    holder.attach(new EthernetSwitch());

    const newcomer = new TabAreaNetwork(hub.join(), {
      claimWaitMs: 5,
      random: () => { throw new Error('lowest-free must not consult random'); },
    });
    const id = await newcomer.acquire();
    expect(id.hostOctet).toBe(17);
    expect(holder.identity?.hostOctet).toBe(16);
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
    // live original defends it, and the fallback is now the lowest free
    // octet (16 — `mouse`), not a random one.
    const duplicate = new TabAreaNetwork(hub.join(), {
      preferredOctet: 42,
      claimWaitMs: 5,
      random: () => { throw new Error('lowest-free must not consult random'); },
    });
    const id = await duplicate.acquire();
    expect(id.hostOctet).toBe(16);
    expect(original.identity?.hostOctet).toBe(42);
  });

  it('an out-of-range preferred octet is ignored, not thrown', async () => {
    const hub = makeHub();
    const tan = new TabAreaNetwork(hub.join(), {
      preferredOctet: 999, // nonsense from a tampered session store
      claimWaitMs: 5,
      random: () => { throw new Error('lowest-free must not consult random'); },
    });
    const id = await tan.acquire();
    // Ignored, and the ordinary lowest-free pick applies: `mouse`.
    expect(id.hostOctet).toBe(16);
  });
});

describe('TAN naming — tabs arrive as mouse, cat, dog (Phase 15 M4)', () => {
  it('three tabs opened in order get the first three names', async () => {
    const hub = makeHub();
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const tan = new TabAreaNetwork(hub.join(), { claimWaitMs: 5 });
      tan.attach(new EthernetSwitch());
      const id = await tan.acquire();
      names.push(nameForOctet(id.hostOctet) ?? '?');
    }
    // The whole point of the feature: a row of tabs reads like a
    // neighbourhood, not a subnet dump.
    expect(names).toEqual(['mouse', 'cat', 'dog']);
  });

  it('the census bounds repicks: the 4th tab settles without 3 collisions', async () => {
    const hub = makeHub();
    const settled = [16, 17, 18];
    for (const octet of settled) {
      const holder = new TabAreaNetwork(hub.join(), { hostOctet: octet });
      holder.attach(new EthernetSwitch());
      await holder.acquire();
    }
    // A settled tab answers ANY claim with `here <octet>`, so the
    // newcomer learns all three in its first claim-wait and picks
    // correctly on the next attempt — not one attempt per existing tab.
    // (`here` draws no reply, which is why this doesn't storm.)
    const newcomer = new TabAreaNetwork(hub.join(), { claimWaitMs: 5 });
    const id = await newcomer.acquire();
    expect(id.hostOctet).toBe(19);
    expect(nameForOctet(id.hostOctet)).toBe('fox');
  });

  it('a returning tab keeps its name (sticky IP + deterministic naming)', async () => {
    const hub = makeHub();
    const channel = hub.join();
    const first = new TabAreaNetwork(channel, { claimWaitMs: 5 });
    const id1 = await first.acquire();
    expect(nameForOctet(id1.hostOctet)).toBe('mouse');

    // The tab CLOSES: its channel stops listening, so nothing defends
    // the octet any more. (Leaving the old tab live here would be a
    // different scenario entirely — the duplicated-tab case above,
    // where the original rightly defends and the copy becomes `cat`.)
    channel.onmessage = null;

    // Reload: the session store hands the octet back, and with it the
    // name. `mouse` comes home.
    const reloaded = new TabAreaNetwork(hub.join(), {
      preferredOctet: id1.hostOctet,
      claimWaitMs: 5,
    });
    const id2 = await reloaded.acquire();
    expect(id2.hostOctet).toBe(id1.hostOctet);
    expect(nameForOctet(id2.hostOctet)).toBe('mouse');
  });
});
