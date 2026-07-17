/**
 * The network freeze (TAN-freeze brief M2).
 *
 * Two layers under test:
 *   - TabAreaNetwork: the freeze/thaw control words on the channel —
 *     broadcast requires a settled identity, receivers get the hook,
 *     nobody reacts to their own announcement.
 *   - WorkerHost: the protocol — teardown-pause broadcasts freeze only
 *     when connections are open; the peer self-selects against its own
 *     conntrack, holds with a deadline, releases on thaw or expiry;
 *     the restore outcome thaws either way; bfcache unpause takes a
 *     sent freeze back.
 *
 * Fixture shape follows worker-host-state.test.ts: all-HLT floppy,
 * autoRun: false (the loop's gate is the one-line `serviceTanFreezes`
 * check — the method is driven directly with a fake clock here).
 */

import { describe, expect, it } from 'vitest';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { TabAreaNetwork, type FrameChannel } from '../../src/net/tan.js';
import {
  ETHERTYPE_IPV4,
  IPPROTO_TCP,
  TCP_ACK,
  TCP_SYN,
  buildEthernetFrame,
  buildIpv4,
  buildTcpSegment,
  type Ipv4,
} from '../../src/net/wire.js';
import { tanIdentityFor } from '../../src/net/tan.js';

/** Synchronous BroadcastChannel-alike hub (the tan.test.ts pattern). */
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

function tcpFrame(
  srcIp: Ipv4,
  dstIp: Ipv4,
  srcPort: number,
  dstPort: number,
  flags: number,
): Uint8Array {
  const seg = buildTcpSegment(srcIp, dstIp, {
    srcPort, dstPort, seq: 1, ack: 1, flags, window: 4380,
    payload: new Uint8Array(0),
  });
  return buildEthernetFrame(
    tanIdentityFor(dstIp[3] ?? 0).mac,
    tanIdentityFor(srcIp[3] ?? 0).mac,
    ETHERTYPE_IPV4,
    buildIpv4(IPPROTO_TCP, srcIp, dstIp, seg),
  );
}

const MOUSE: Ipv4 = [10, 0, 2, 16];
const CAT: Ipv4 = [10, 0, 2, 17];

describe('TabAreaNetwork freeze/thaw words', () => {
  it('carries freeze/thaw to peers, never back to the sender', () => {
    const hub = makeHub();
    const a = new TabAreaNetwork(hub.join(), { hostOctet: 16 });
    const b = new TabAreaNetwork(hub.join(), { hostOctet: 17 });
    const seenByA: string[] = [];
    const seenByB: string[] = [];
    a.onPeerFreeze = (o) => seenByA.push(`freeze:${o}`);
    a.onPeerThaw = (o) => seenByA.push(`thaw:${o}`);
    b.onPeerFreeze = (o) => seenByB.push(`freeze:${o}`);
    b.onPeerThaw = (o) => seenByB.push(`thaw:${o}`);

    a.broadcastFreeze();
    a.broadcastThaw();
    expect(seenByB).toEqual(['freeze:16', 'thaw:16']);
    expect(seenByA).toEqual([]); // the channel never echoes to the sender
  });

  it('does not broadcast before the identity settles', () => {
    const hub = makeHub();
    const unsettled = new TabAreaNetwork(hub.join());
    const b = new TabAreaNetwork(hub.join(), { hostOctet: 17 });
    let heard = 0;
    b.onPeerFreeze = () => heard++;
    unsettled.broadcastFreeze();
    expect(heard).toBe(0);
  });
});

/** 1.44 MB all-HLT primary so boot idles immediately. */
function haltImage(): Uint8Array {
  const image = new Uint8Array(1474560);
  image.fill(0xf4);
  return image;
}

interface Rig {
  host: WorkerHost;
  messages: WorkerToMainMessage[];
  now: { t: number };
}

async function bootOnHub(hub: { join(): FrameChannel }, octet: number): Promise<Rig> {
  const messages: WorkerToMainMessage[] = [];
  const now = { t: 0 };
  const host = new WorkerHost({
    post: (m) => messages.push(m),
    autoRun: false,
    hostClock: new InMemoryHostClock(),
    tan: { channel: hub.join(), hostOctet: octet },
    pacerTimeSource: () => now.t,
  });
  host.handleMessage({
    type: 'boot',
    config: { imageBytes: haltImage() },
  });
  await host.whenIdle();
  return { host, messages, now };
}

/** Telnet mouse:1024 → cat:23, observed by both ends' conntracks. */
function openTelnet(mouse: Rig, cat: Rig): void {
  for (const rig of [mouse, cat]) {
    const ct = rig.host.tan?.conntrack;
    if (ct === undefined) throw new Error('no tan on rig');
    ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_SYN));
    ct.observe(tcpFrame(CAT, MOUSE, 23, 1024, TCP_SYN | TCP_ACK));
    ct.observe(tcpFrame(MOUSE, CAT, 1024, 23, TCP_ACK));
  }
}

function messagesOf(rig: Rig, type: string): WorkerToMainMessage[] {
  return rig.messages.filter((m) => m.type === type);
}

describe('WorkerHost network freeze protocol', () => {
  it('teardown-pause freezes the involved peer; thaw releases it', async () => {
    const hub = makeHub();
    const mouse = await bootOnHub(hub, 16);
    const cat = await bootOnHub(hub, 17);
    const dog = await bootOnHub(hub, 18); // no connections — must ignore
    openTelnet(mouse, cat);

    mouse.host.handleMessage({ type: 'set-paused', paused: true, reason: 'teardown' });

    const freeze = messagesOf(cat, 'tan-freeze');
    expect(freeze).toHaveLength(1);
    expect(freeze[0]).toMatchObject({
      peerOctet: 16,
      peerName: 'mouse',
      connections: [{ peerOctet: 16, localPort: 23, peerPort: 1024, state: 'established' }],
    });
    expect(cat.host.serviceTanFreezes(cat.now.t)).toBe(true); // held
    expect(messagesOf(dog, 'tan-freeze')).toHaveLength(0); // self-selection

    // bfcache revival: the unpause takes the freeze back.
    mouse.host.handleMessage({ type: 'set-paused', paused: false });
    expect(messagesOf(cat, 'tan-thaw')).toEqual([
      { type: 'tan-thaw', peerOctet: 16, peerName: 'mouse', outcome: 'returned' },
    ]);
    expect(cat.host.serviceTanFreezes(cat.now.t)).toBe(false); // released
  });

  it('a teardown with no open connections stays silent on the wire', async () => {
    const hub = makeHub();
    const mouse = await bootOnHub(hub, 16);
    const cat = await bootOnHub(hub, 17);
    mouse.host.handleMessage({ type: 'set-paused', paused: true, reason: 'teardown' });
    expect(messagesOf(cat, 'tan-freeze')).toHaveLength(0);
    // ...and the later unpause must not broadcast a phantom thaw that
    // would clear some OTHER tab's legitimate freeze.
    mouse.host.handleMessage({ type: 'set-paused', paused: false });
    expect(messagesOf(cat, 'tan-thaw')).toHaveLength(0);
  });

  it('an inspect-popup pause never touches the network', async () => {
    const hub = makeHub();
    const mouse = await bootOnHub(hub, 16);
    const cat = await bootOnHub(hub, 17);
    openTelnet(mouse, cat);
    mouse.host.handleMessage({ type: 'set-paused', paused: true }); // no reason
    expect(messagesOf(cat, 'tan-freeze')).toHaveLength(0);
  });

  it('gives up after the deadline, honestly', async () => {
    const hub = makeHub();
    const mouse = await bootOnHub(hub, 16);
    const cat = await bootOnHub(hub, 17);
    openTelnet(mouse, cat);
    mouse.host.handleMessage({ type: 'set-paused', paused: true, reason: 'teardown' });

    expect(cat.host.serviceTanFreezes(cat.now.t + 9_999)).toBe(true);
    expect(cat.host.serviceTanFreezes(cat.now.t + 10_000)).toBe(false);
    expect(messagesOf(cat, 'tan-thaw')).toEqual([
      { type: 'tan-thaw', peerOctet: 16, peerName: 'mouse', outcome: 'timeout' },
    ]);
  });

  it('a restore outcome thaws the waiting peer (the reload round trip)', async () => {
    const hub = makeHub();
    const mouse = await bootOnHub(hub, 16);
    const cat = await bootOnHub(hub, 17);
    openTelnet(mouse, cat);
    mouse.host.handleMessage({ type: 'set-paused', paused: true, reason: 'teardown' });
    expect(cat.host.serviceTanFreezes(cat.now.t)).toBe(true);

    // The page actually dies: its channel goes silent BEFORE the
    // reload claims the octet. (Without this, two fixed identities on
    // the same octet defend against each other's claims forever — a
    // storm the synchronous hub turns into a stack overflow. Real
    // pagehide kills the channel first, so production can't get here.)
    mouse.host.tan?.close();

    // The "reloaded" mouse: a fresh host on the same hub, same octet,
    // booting with a restore config. The state is nonsense on purpose —
    // the REFUSAL path must thaw exactly like a success would.
    const messages: WorkerToMainMessage[] = [];
    const reloaded = new WorkerHost({
      post: (m) => messages.push(m),
      autoRun: false,
      hostClock: new InMemoryHostClock(),
      tan: { channel: hub.join(), hostOctet: 16 },
    });
    reloaded.handleMessage({
      type: 'boot',
      config: {
        imageBytes: haltImage(),
        restore: {
          state: null as never, // torn on purpose — restore must refuse
          capturedAt: 0,
        },
      },
    });
    await reloaded.whenIdle();

    expect(messages.find((m) => m.type === 'restore-result')?.ok).toBe(false);
    expect(messagesOf(cat, 'tan-thaw')).toEqual([
      { type: 'tan-thaw', peerOctet: 16, peerName: 'mouse', outcome: 'returned' },
    ]);
    expect(cat.host.serviceTanFreezes(cat.now.t)).toBe(false);
  });
});
