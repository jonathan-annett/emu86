/**
 * The agent cable's localhost server (agent-cable brief M1).
 *
 * REAL end-to-end: an actual HTTP server on an ephemeral loopback
 * port, dialed by Node's built-in WebSocket client — so the
 * hand-rolled handshake and masked-frame parsing are exercised by a
 * genuine independent implementation, not by our own builder.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line -- plain-JS tool module, typed structurally below
// @ts-expect-error: the tool ships as untyped .mjs on purpose
import { FrameParser, createCableServer, wsFrame } from '../../tools/agent-cable/server.mjs';

interface Cable {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  machines: Map<string, unknown>;
}

let cable: Cable;
let port: number;

beforeEach(async () => {
  cable = (createCableServer as (opts?: object) => Cable)();
  port = await cable.listen(0);
});

afterEach(async () => {
  await cable.close();
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cable`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('connect failed')));
  });
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('agent cable server', () => {
  it('runs the whole loop: hello, tx, list, console paging, rx', async () => {
    const ws = await connect();
    const injected: string[] = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { cable: string; data: string };
      if (msg.cable === 'rx') {
        injected.push(Buffer.from(msg.data, 'base64').toString('utf8'));
      }
    });

    ws.send(JSON.stringify({ cable: 'hello', name: 'mouse', octet: 16, pc: null, build: 'test' }));
    ws.send(JSON.stringify({ cable: 'tx', data: b64('mouse$ ') }));
    await until(() => cable.machines.size === 1);

    const list = (await (await fetch(`http://127.0.0.1:${port}/machines`)).json()) as Array<{
      id: string; name: string; octet: number; consoleBytes: number;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'mouse', octet: 16 });

    // Console read + incremental paging via the offset header.
    const r1 = await fetch(`http://127.0.0.1:${port}/console?from=mouse`);
    const text1 = await r1.text();
    expect(text1).toBe('mouse$ ');
    const offset = Number(r1.headers.get('x-console-offset'));
    expect(offset).toBe(7);

    ws.send(JSON.stringify({ cable: 'tx', data: b64('ls\r\n') }));
    await until(() => {
      const m = [...cable.machines.values()][0] as { buffer: Buffer };
      return m.buffer.length > 7;
    });
    const r2 = await fetch(`http://127.0.0.1:${port}/console?from=mouse&since=${offset}`);
    expect(await r2.text()).toBe('ls\r\n');

    // Agent types into the machine.
    const post = await fetch(`http://127.0.0.1:${port}/rx?to=mouse`, {
      method: 'POST',
      body: 'invaders\n',
    });
    expect(post.status).toBe(200);
    await until(() => injected.length === 1);
    expect(injected[0]).toBe('invaders\n');

    ws.close();
    await until(() => cable.machines.size === 0);
  });

  it('404s honestly for unknown machines and unknown routes', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/console?from=nobody`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/rx?to=nobody`, { method: 'POST', body: 'x' })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });

  it('parses masked frames split at every chunk boundary', () => {
    // A masked client frame built by hand, fed byte-by-byte.
    const payload = Buffer.from('{"cable":"tx","data":""}');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i & 3] ?? 0)));
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      masked,
    ]);
    for (let cut = 1; cut < frame.length; cut++) {
      const parser = new (FrameParser as new () => { feed(b: Buffer): Array<{ opcode: number; payload: Buffer }> })();
      const a = parser.feed(frame.subarray(0, cut));
      const b = parser.feed(frame.subarray(cut));
      const frames = [...a, ...b];
      expect(frames).toHaveLength(1);
      expect(frames[0]?.opcode).toBe(1);
      expect(frames[0]?.payload.toString()).toBe(payload.toString());
    }
  });

  it('builds frames Node’s own client accepts (16-bit length path)', async () => {
    const ws = await connect();
    const received: string[] = [];
    ws.addEventListener('message', (ev) => received.push(String(ev.data)));
    ws.send(JSON.stringify({ cable: 'hello', name: 'cat', octet: 17, pc: null, build: 't' }));
    await until(() => cable.machines.size === 1);

    const big = 'x'.repeat(200); // > 125 → 16-bit length header
    const post = await fetch(`http://127.0.0.1:${port}/rx?to=cat`, { method: 'POST', body: big });
    expect(post.status).toBe(200);
    await until(() => received.length === 1);
    const msg = JSON.parse(received[0] ?? '{}') as { data: string };
    expect(Buffer.from(msg.data, 'base64').toString()).toBe(big);
    ws.close();
  });
});
