/**
 * TAN telnet end-to-end (Phase 14 M3-tabs acceptance — "tab 1 can
 * telnet to tab 2. that will be gold").
 *
 * Two full WorkerHost machines — exactly what two browser tabs run —
 * boot the stock hd32-minix.img on one Tab Area Network (synchronous
 * hub standing in for BroadcastChannel). Each leases its own identity
 * (10.0.2.21 / .22, distinct MACs), logs in, and starts networking
 * with the guest's own `net start ne0`. Then machine A telnets to
 * machine B's IP: ktcp speaks real TCP on both ends across the trunk,
 * B's telnetd serves a real login prompt, and it renders in A's
 * terminal. No host-side TCP exists anywhere — only frames moved.
 *
 * Machines interleave in instruction slices; the sync hub delivers
 * frames mid-slice, which the NE2000 ring absorbs like any other
 * asynchronous wire.
 *
 * Skips with a pointer when the fixture is absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';
import type { FrameChannel } from '../../src/net/tan.js';

const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');
const TEST_TIMEOUT_MS = 15 * 60 * 1000;

const PROMPT_RE = /login: *$|# *$/;
/**
 * Interleave grain. Cross-machine latency is one round = two slices of
 * GUEST time; ktcp's connect runs 1990s-fast RTOs (RTT floor ~62 ms,
 * SYN give-up within ~3 RTOs), so coarse slices make the peer look
 * seconds away and connects time out. 500K instructions ≈ 0.1 guest-
 * seconds keeps round-trips well inside the retransmit budget.
 */
const SLICE = 500_000;

/** Wire-tap decode for hub traffic (diagnostic; printed on failure). */
function describeFrame(frame: Uint8Array): string {
  const mac = (o: number): string =>
    Array.from(frame.subarray(o, o + 6)).map((b) => b.toString(16).padStart(2, '0')).join(':');
  const ethertype = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
  let s = `${mac(6)}→${mac(0)} `;
  if (ethertype === 0x0806) {
    const op = frame[21] === 1 ? 'who-has' : 'is-at';
    s += `ARP ${op} ${frame.subarray(38, 42).join('.')} from ${frame.subarray(28, 32).join('.')}`;
  } else if (ethertype === 0x0800) {
    const ihl = ((frame[14] ?? 0) & 0x0f) * 4;
    const proto = frame[23] ?? 0;
    const src = frame.subarray(26, 30).join('.');
    const dst = frame.subarray(30, 34).join('.');
    if (proto === 6) {
      const t = 14 + ihl;
      const sport = ((frame[t] ?? 0) << 8) | (frame[t + 1] ?? 0);
      const dport = ((frame[t + 2] ?? 0) << 8) | (frame[t + 3] ?? 0);
      const flags = frame[t + 13] ?? 0;
      const names = [
        [0x02, 'SYN'], [0x10, 'ACK'], [0x01, 'FIN'], [0x04, 'RST'], [0x08, 'PSH'],
      ] as const;
      const fl = names.filter(([bit]) => (flags & bit) !== 0).map(([, n]) => n).join('+') || '·';
      s += `TCP ${src}:${sport}→${dst}:${dport} ${fl}`;
    } else {
      s += `IPv4 proto ${proto} ${src}→${dst}`;
    }
  } else {
    s += `ethertype 0x${ethertype.toString(16)}`;
  }
  return s;
}

const wireLog: string[] = [];

function makeHub(): { join(): FrameChannel } {
  const members: FrameChannel[] = [];
  let n = 0;
  return {
    join(): FrameChannel {
      const idx = n++;
      const member: FrameChannel = {
        onmessage: null,
        postMessage(data: unknown) {
          const d = data as { tan?: string; bytes?: Uint8Array };
          if (d.tan === 'frame' && d.bytes instanceof Uint8Array && wireLog.length < 200) {
            wireLog.push(`[${idx === 0 ? 'A→' : 'B→'}] ${describeFrame(d.bytes)}`);
          }
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

interface Tab {
  host: WorkerHost;
  tx: () => string;
}

async function bootTab(hub: { join(): FrameChannel }, bytes: Uint8Array, octet: number): Promise<Tab> {
  const posts: WorkerToMainMessage[] = [];
  const host = new WorkerHost({
    post: (m) => posts.push(m),
    autoRun: false,
    tan: { channel: hub.join(), hostOctet: octet },
  });
  host.handleMessage({ type: 'boot', config: { imageBytes: bytes } });
  await host.whenIdle();
  expect(posts.some((m) => m.type === 'ready')).toBe(true);
  const tx = (): string => {
    let s = '';
    for (const m of posts) {
      if (m.type === 'tx') s += String.fromCharCode(...m.bytes);
    }
    return s;
  };
  return { host, tx };
}

function type(tab: Tab, line: string): void {
  tab.host.handleMessage({
    type: 'rx',
    bytes: new Uint8Array([...line].map((c) => c.charCodeAt(0))),
  });
}

/** Run `tab` in slices until `re` matches its transcript (or budget out). */
function runUntilMatch(tab: Tab, other: Tab, re: RegExp, maxSlices: number): boolean {
  for (let i = 0; i < maxSlices; i++) {
    tab.host.runUntil(SLICE);
    other.host.runUntil(SLICE); // keep the peer's clock moving too
    if (re.test(tab.tx())) return true;
  }
  return false;
}

describe('Phase 14 M3-tabs — TAN: tab 1 telnets to tab 2', () => {
  it(
    'two WorkerHosts on one TAN; telnet across renders the remote login prompt',
    async () => {
      if (!existsSync(HD32_PATH)) {
        console.warn(
          `[skip] ${HD32_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }

      const raw = readFileSync(HD32_PATH);
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const hub = makeHub();

      const a = await bootTab(hub, bytes, 21);
      const b = await bootTab(hub, bytes, 22);

      // Distinct leased identities all the way down.
      expect(a.host.tan?.identity?.hostOctet).toBe(21);
      expect(b.host.tan?.identity?.hostOctet).toBe(22);
      expect(a.host.machine?.nic.mac[5]).toBe(21);
      expect(b.host.machine?.nic.mac[5]).toBe(22);

      // ---- boot both to login:, log in as root ----
      for (const tab of [a, b]) {
        expect(runUntilMatch(tab, tab === a ? b : a, PROMPT_RE, 40)).toBe(true);
        if (/login: *$/.test(tab.tx())) {
          type(tab, 'root\n');
          expect(runUntilMatch(tab, tab === a ? b : a, /# *$/, 20)).toBe(true);
        }
      }

      // ---- both join the LAN with their own tooling ----
      // net.cfg reads $LOCALIP from the TAN-stamped bootopts line.
      type(a, 'net start ne0\n');
      expect(runUntilMatch(a, b, /Starting daemons.*\n.*# *$|# *$/, 32)).toBe(true);
      expect(a.tx()).toContain('ktcp: ip 10.0.2.21');

      type(b, 'net start ne0\n');
      expect(runUntilMatch(b, a, /# *$/, 32)).toBe(true);
      expect(b.tx()).toContain('ktcp: ip 10.0.2.22');

      // Let both ktcps and their daemons go quiescent before dialing —
      // right after `net start` they're still forking telnetd/ftpd and
      // answering welcome pings.
      for (let i = 0; i < 8; i++) {
        a.host.runUntil(SLICE);
        b.host.runUntil(SLICE);
      }

      // ---- the gold moment: A telnets to B ----
      const beforeTelnet = a.tx().length;
      type(a, 'telnet 10.0.2.22\n');
      const nicSamples: string[] = [];
      let connected = false;
      for (let i = 0; i < 120 && !connected; i++) {
        a.host.runUntil(SLICE);
        b.host.runUntil(SLICE);
        nicSamples.push(`r${i}: ${JSON.stringify(a.host.machine?.nic.inspectRx())}`);
        connected = /login: */.test(a.tx().slice(beforeTelnet));
      }
      if (!connected) {
        console.log('--- A nic during telnet wait ---\n' + nicSamples.slice(0, 12).join('\n'));
        console.log('--- wire log ---\n' + wireLog.join('\n'));
        console.log('--- A tail ---\n' + a.tx().slice(-1200));
        console.log('--- B tail ---\n' + b.tx().slice(-1200));
        for (const [name, tab] of [['A', a], ['B', b]] as const) {
          console.log(
            `--- ${name}: tan out=${tab.host.tan?.framesOut} in=${tab.host.tan?.framesIn}` +
              ` | gw arpTable=${JSON.stringify([...(tab.host.gateway?.arpTable.keys() ?? [])])}` +
              ` | cam=${JSON.stringify(tab.host.network?.describe().cam)}`,
          );
          console.log(`--- ${name} nic: ${JSON.stringify(tab.host.machine?.nic.inspectRx())}`);
        }
        // ktcp's own counters, both sides: who saw whose ARP?
        for (const [name, tab] of [['A', a], ['B', b]] as const) {
          const mark = tab.tx().length;
          type(tab, '\x1dq\n'); // escape any wedged telnet (^] q) — harmless at a shell
          tab.host.runUntil(SLICE);
          type(tab, 'netstat\n');
          for (let i = 0; i < 4; i++) tab.host.runUntil(SLICE);
          console.log(`--- ${name} netstat ---\n` + tab.tx().slice(mark));
        }
      }
      expect(connected).toBe(true);

      // B's telnetd really served it: a fresh login prompt appeared in
      // A's terminal AFTER the telnet command, delivered over TCP
      // frames that crossed the trunk.
      expect(a.tx().slice(beforeTelnet)).toMatch(/login: */);
    },
    TEST_TIMEOUT_MS,
  );
});
