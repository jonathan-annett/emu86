/**
 * The resume ARP wedge — regression test (field, 2026-07-17: "after a
 * refresh and exit from telnet session, the telnet dns fails
 * ('Nameserver not found'), however a ping fixes it").
 *
 * Root cause (reproduced deterministically by this very test before
 * the fix): the pseudo-hosts (owl, elk) learned MACs ONLY from ARP
 * traffic and silently dropped replies "without ARP knowledge". A
 * resumed guest's RESTORED ktcp ARP cache is warm — it never ARPs the
 * fixed pseudo-host MACs again — so the freshly-built owl never
 * learned the guest's MAC and dropped every SYN-ACK; the resolver's
 * alarm(2)-bounded connect read as ENONAMESERVER, forever. `ping`
 * "fixed" it because its broadcast who-has carries the guest's
 * MAC+IP, which owl learns passively. Fix: both hosts also learn from
 * every IPv4 frame addressed to them (dns.ts / gateway.ts).
 *
 * Field sequence: mouse and cat on one TAN hub (autologin, auto-net —
 * the browser flow), mouse telnets to cat BY NAME (owl in the loop),
 * reference-capture mouse mid-session (the F5 path — embedded
 * restores detach from the TAN by design and would mask this), kill
 * the old tab's hub membership, resume into a fresh host on the same
 * octet, exit the telnet session, dial `telnet cat` again — and it
 * must CONNECT, no ping required.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type {
  StateCapturedMessage,
  WorkerToMainMessage,
} from '../../src/browser/protocol.js';
import type { FrameChannel } from '../../src/net/tan.js';

const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const SLICE = 500_000; // the elks-tan-telnet interleave grain

interface HubMember extends FrameChannel {
  kill(): void;
}

/** Synchronous hub with killable members (a dead tab's channel must
 *  neither deliver nor defend). */
function makeHub(): { join(): HubMember } {
  const members: Array<{ ch: HubMember; dead: boolean }> = [];
  return {
    join(): HubMember {
      const slot: { ch: HubMember; dead: boolean } = {
        dead: false,
        ch: {
          onmessage: null,
          postMessage(data: unknown) {
            if (slot.dead) return;
            for (const other of members) {
              if (other !== slot && !other.dead) other.ch.onmessage?.({ data });
            }
          },
          kill() {
            slot.dead = true;
            slot.ch.onmessage = null;
          },
        },
      };
      members.push(slot);
      return slot.ch;
    },
  };
}

interface Tab {
  host: WorkerHost;
  posts: WorkerToMainMessage[];
  tx: () => string;
  channel: HubMember;
}

async function bootTab(
  hub: { join(): HubMember },
  bytes: Uint8Array,
  octet: number,
  restore?: import('../../src/browser/protocol.js').BootConfig['restore'],
  overlay?: import('../../src/browser/protocol.js').BootConfig['overlay'],
): Promise<Tab> {
  const posts: WorkerToMainMessage[] = [];
  const channel = hub.join();
  const host = new WorkerHost({
    post: (m) => posts.push(m),
    autoRun: false,
    tan: { channel, hostOctet: octet },
  });
  host.handleMessage({
    type: 'boot',
    config: {
      imageBytes: bytes,
      diskClass: 'hard-disk',
      autologin: 'user1',
      autoNet: true,
      ...(overlay !== undefined ? { overlay } : {}),
      ...(restore !== undefined ? { restore } : {}),
    },
  });
  await host.whenIdle();
  const tx = (): string => {
    let s = '';
    for (const m of posts) {
      if (m.type === 'tx') s += String.fromCharCode(...m.bytes);
    }
    return s;
  };
  return { host, posts, tx, channel };
}

function type(tab: Tab, line: string): void {
  tab.host.handleMessage({
    type: 'rx',
    bytes: new Uint8Array([...line].map((c) => c.charCodeAt(0))),
  });
}

function runUntilMatch(tab: Tab, other: Tab, re: RegExp, maxSlices: number): boolean {
  for (let i = 0; i < maxSlices; i++) {
    tab.host.runUntil(SLICE);
    other.host.runUntil(SLICE);
    if (re.test(tab.tx())) return true;
  }
  return false;
}

async function awaitCaptured(tab: Tab): Promise<StateCapturedMessage> {
  for (let i = 0; i < 400; i++) {
    const msg = tab.posts.find(
      (m): m is StateCapturedMessage => m.type === 'state-captured',
    );
    if (msg !== undefined) return msg;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('state-captured never arrived');
}

describe('resume then fresh DNS connect (field wedge repro)', () => {
  it(
    'mouse resumes mid-telnet, exits, and dials cat by name again',
    async () => {
      if (!existsSync(HD32_PATH)) {
        console.warn(`[skip] ${HD32_PATH} not found.`);
        return;
      }
      const raw = readFileSync(HD32_PATH);
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const hub = makeHub();

      // mouse (.16) and cat (.17), the field octets. Autologin +
      // auto-net: both land at their prompts with ktcp running.
      const a = await bootTab(hub, new Uint8Array(bytes), 16);
      const b = await bootTab(hub, new Uint8Array(bytes), 17);
      const aFingerprint = (() => {
        const m = a.posts.find((x) => x.type === 'overlay-identity');
        if (m === undefined || m.type !== 'overlay-identity') throw new Error('no identity');
        return m.fingerprint;
      })();

      expect(runUntilMatch(a, b, /mouse\$ *$/, 90)).toBe(true);
      expect(runUntilMatch(b, a, /cat\$ *$/, 90)).toBe(true);
      // Quiesce: daemons forking, welcome pings settling.
      for (let i = 0; i < 8; i++) {
        a.host.runUntil(SLICE);
        b.host.runUntil(SLICE);
      }

      // ---- telnet BY NAME (owl resolves) and log in ----
      type(a, 'telnet cat\n');
      expect(runUntilMatch(a, b, /login: *$/, 120)).toBe(true);
      type(a, 'user1\n');
      expect(runUntilMatch(a, b, /cat\$ *$/, 60)).toBe(true);
      console.log('[repro] telnet session up; DNS worked pre-capture');

      // ---- the F5: reference capture, old tab dies, resume ----
      a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
      const reply = await awaitCaptured(a);
      if (reply.state === undefined || reply.capturedAt === undefined ||
          reply.storeDigest === undefined || reply.overlayEpoch == null) {
        throw new Error(`capture incomplete: ${reply.reason ?? 'no reason'}`);
      }
      a.channel.kill(); // the refreshed page is GONE — no defence, no delivery

      const a2 = await bootTab(hub, new Uint8Array(bytes), 16, {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          storeDigest: reply.storeDigest,
          secondarySha: reply.secondarySha ?? null,
        },
        carriedPrimary: {
          chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
          fingerprint: aFingerprint,
          chunks: reply.overlayEpoch.chunks,
        },
      }, {
        chunks: reply.overlayEpoch.chunks,
        chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
        fingerprint: aFingerprint,
      });
      const restoreResult = a2.posts.find((m) => m.type === 'restore-result');
      expect(restoreResult).toMatchObject({ ok: true });
      expect(a2.host.tan?.lanAttached).toBe(true); // reference resume rejoins
      console.log('[repro] resumed; session should be live');

      // ---- the session survives the resume (enters echo) ----
      const preEnter = a2.tx().length;
      type(a2, '\n');
      runUntilMatch(a2, b, /cat\$ *$/, 40);
      console.log(`[repro] post-resume enter tail: ${JSON.stringify(a2.tx().slice(preEnter).slice(-80))}`);

      // ---- exit the telnet session ----
      type(a2, 'exit\n');
      const backAtMouse = runUntilMatch(a2, b, /mouse\$ *$/, 60);
      console.log(`[repro] exit landed back at mouse$: ${backAtMouse}`);

      // ---- the field failure: dial by name again ----
      const preDial = a2.tx().length;
      type(a2, 'telnet cat\n');
      for (let i = 0; i < 120; i++) {
        a2.host.runUntil(SLICE);
        b.host.runUntil(SLICE);
        const tail = a2.tx().slice(preDial);
        if (/Nameserver not found/.test(tail) || /Connected/.test(tail)) break;
      }
      const outcome = a2.tx().slice(preDial);
      console.log(`[repro] second dial outcome:\n${outcome.slice(-400)}`);

      // Diagnostics regardless of outcome.
      console.log(
        `[repro] a2 nic: ${JSON.stringify(a2.host.machine?.nic.inspectRx())} | ` +
          `tan out=${a2.host.tan?.framesOut} in=${a2.host.tan?.framesIn} | ` +
          `cam=${JSON.stringify(a2.host.network?.describe().cam)}`,
      );

      // Pre-fix this printed "cat: Nameserver not found" every time
      // (WEDGED=true, run of 2026-07-17). The fix makes the second
      // by-name dial connect with no ping in between.
      expect(outcome).not.toContain('Nameserver not found');
      expect(outcome).toContain('Connected');
    },
    TEST_TIMEOUT_MS,
  );
});
