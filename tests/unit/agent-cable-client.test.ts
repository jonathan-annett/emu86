/**
 * The agent cable's page client (agent-cable brief M2).
 *
 * The validator is tested as the security boundary it is; the client
 * is tested REAL — plugged into an actual M1 server instance on an
 * ephemeral loopback port via Node's built-in WebSocket, so hello/tx/
 * rx framing, the identity re-hello, redial, and unplug are all
 * exercised against the genuine other end, not a mock.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  isValidAgentCableUrl,
  plugAgentCable,
  type AgentCable,
} from '../../web/agent-cable.js';
// eslint-disable-next-line -- plain-JS tool module, typed structurally below
// @ts-expect-error: the tool ships as untyped .mjs on purpose
import { createCableServer } from '../../tools/agent-cable/server.mjs';

interface Cable {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  machines: Map<string, {
    name: string | null;
    octet: number | null;
    pc: string | null;
    build: string | null;
    buffer: { length: number };
  }>;
}

const makeServer = createCableServer as (opts?: object) => Cable;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function plug(url: string, over: Partial<Parameters<typeof plugAgentCable>[0]> = {}): {
  cable: AgentCable;
  statuses: string[];
  received: Uint8Array[];
  spawns: string[];
  identity: { name: string | null; octet: number | null };
} {
  const statuses: string[] = [];
  const received: Uint8Array[] = [];
  const spawns: string[] = [];
  const identity = { name: null as string | null, octet: null as number | null };
  const cable = plugAgentCable({
    url,
    identity: () => ({ ...identity, pc: null, build: 'test-build' }),
    onRx: (bytes) => received.push(bytes),
    onStatus: (text) => statuses.push(text),
    onSpawn: (kind) => spawns.push(kind),
    baseDelayMs: 25,
    ...over,
  });
  cleanups.push(() => cable.unplug());
  return { cable, statuses, received, spawns, identity };
}

describe('agent cable URL validation (the security boundary)', () => {
  it('accepts loopback ws:// and nothing else', () => {
    const accepted = [
      'ws://localhost:8737/cable',
      'ws://localhost/cable',
      'ws://127.0.0.1:9000',
      'ws://127.0.0.1',
    ];
    const refused = [
      'wss://localhost:8737/cable',      // TLS implies a non-local trust story
      'ws://example.com/cable',
      'ws://localhost.evil.com/cable',   // suffix tricks
      'ws://evil.com/localhost',
      'ws://user:pass@localhost:8737/',  // no credentials
      'ws://192.168.1.5:8737/',          // LAN is not loopback
      'ws://[::1]:8737/',                // v1 allowlist is the two names in the brief
      'http://localhost:8737/',
      'ws//localhost',
      '',
      'not a url',
    ];
    for (const url of accepted) expect(isValidAgentCableUrl(url), url).toBe(true);
    for (const url of refused) expect(isValidAgentCableUrl(url), url).toBe(false);
    expect(isValidAgentCableUrl(42)).toBe(false);
    expect(isValidAgentCableUrl(null)).toBe(false);
    expect(isValidAgentCableUrl(undefined)).toBe(false);
  });
});

describe('agent cable client against a real server', () => {
  it('plugs in, hellos, streams tx, takes rx, re-hellos, unplugs', async () => {
    const server = makeServer();
    cleanups.push(() => server.close());
    const port = await server.listen(0);
    const { cable, statuses, received, spawns, identity } = plug(`ws://127.0.0.1:${port}/cable`);

    // Plug lands: one connected status, hello identity visible to the agent.
    await until(() => server.machines.size === 1);
    await until(() => [...server.machines.values()][0]?.build === 'test-build');
    expect(statuses.some((s) => s.includes('plugged into'))).toBe(true);

    // Console TX flows out (raw bytes, base64 on the wire). tx is
    // fire-and-forget, so wait for the server's buffer to fill.
    cable.tx(new TextEncoder().encode('mouse$ ls\r\n'));
    await until(() => ([...server.machines.values()][0]?.buffer.length ?? 0) > 0);
    const text = await (await fetch(`http://127.0.0.1:${port}/console?from=m1`)).text();
    expect(text).toBe('mouse$ ls\r\n');

    // Agent types: POST /rx arrives through onRx byte-identical.
    await fetch(`http://127.0.0.1:${port}/rx?to=m1`, { method: 'POST', body: 'invaders\n' });
    await until(() => received.length === 1);
    expect(new TextDecoder().decode(received[0])).toBe('invaders\n');

    // Agent grows the lab: POST /spawn lands as onSpawn(kind).
    await fetch(`http://127.0.0.1:${port}/spawn?to=m1&kind=rack`, { method: 'POST' });
    await until(() => spawns.length === 1);
    expect(spawns[0]).toBe('rack');

    // TAN lease settles later → re-hello updates the listing in place.
    identity.name = 'mouse';
    identity.octet = 16;
    cable.refreshIdentity();
    await until(() => [...server.machines.values()][0]?.name === 'mouse');
    expect([...server.machines.values()][0]?.octet).toBe(16);

    // Unplug: the machine disappears and stays gone (no zombie redial).
    cable.unplug();
    await until(() => server.machines.size === 0);
    await new Promise((res) => setTimeout(res, 120));
    expect(server.machines.size).toBe(0);
  });

  it('redials after the server dies and comes back, with transition-only status', async () => {
    const server = makeServer();
    const port = await server.listen(0);
    const { statuses } = plug(`ws://127.0.0.1:${port}/cable`);
    await until(() => server.machines.size === 1);

    // Server dies: exactly one "lost" line, then quiet retrying.
    await server.close();
    await until(() => statuses.some((s) => s.includes('connection lost')));

    // Server returns on the same port: the plug lands again by itself.
    const revived = makeServer();
    cleanups.push(() => revived.close());
    await revived.listen(port);
    await until(() => revived.machines.size === 1, 4000);
    expect(statuses.filter((s) => s.includes('plugged into'))).toHaveLength(2);
    expect(statuses.filter((s) => s.includes('connection lost'))).toHaveLength(1);
  });

  it('stays quiet when nothing is listening: one line, ever', async () => {
    // Grab a loopback port that is definitely closed.
    const probe = makeServer();
    const deadPort = await probe.listen(0);
    await probe.close();

    const { statuses } = plug(`ws://127.0.0.1:${deadPort}/cable`, { baseDelayMs: 10 });
    // Several backoff rounds pass; the syslog must not tick with them.
    await new Promise((res) => setTimeout(res, 300));
    expect(statuses).toEqual([
      `agent cable: nothing listening at ws://127.0.0.1:${deadPort}/cable — redialing quietly`,
    ]);
  });
});
