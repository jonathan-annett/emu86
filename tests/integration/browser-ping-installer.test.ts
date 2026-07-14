/**
 * The ping installer, driven exactly as the browser drives it
 * (Phase 15 M3 follow-on acceptance).
 *
 * The machine downloads its own tools. This test proves the whole chain
 * end to end, offline:
 *
 *   boot → `net start ne0` → the guest's own `urlget` fetches
 *   `install-ping.sh` from GitHub *through the M3d HTTP gateway* → the
 *   script fetches `ping.c` from the same repo → builds it in-VM with
 *   c86 → installs it → `net stop` → `ping elk` reaches the gateway,
 *   BY NAME, from a binary the machine compiled itself.
 *
 * `fetch` is stubbed to serve the two files from the local
 * `8086-tab-tools` checkout, so the test needs no network and cannot
 * flake on GitHub — but every other link in the chain is real: the
 * guest's urlget, the TCP terminator, the HTTP gateway, the toolchain,
 * the raw-frame ping, and the gateway's ICMP.
 *
 * It replaces a test that drove 722 lines of heredoc paste — which is
 * exactly the thing this design deleted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';
import { AutoexecRunner } from '../../web/autoexec.js';
import { PING_REV, buildPingInstallerScript } from '../../web/ping-installer.js';
import { buildLocalAnswer, parseQuestion } from '../../src/net/dns.js';
import type { Ipv4 } from '../../src/net/wire.js';

const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');
/** The public tools repo — the machine's real source of ping. */
const TOOLS_DIR = resolve(homedir(), 'Projects/8086-tab-tools');

const TEST_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * SMALL batches, and this is not a tuning preference — it is the rule
 * from DNS_DOH_REPORT §4.2. A blocked guest burns virtual time at
 * halt-spin rate, so a fat slice can run `in_resolv`'s 2-second alarm
 * out before the host's DoH promise gets a chance to settle between
 * slices. The guest then "times out" on a resolve that was about to
 * succeed. (First cut used 250k and simply hung: the paste-based test
 * got away with it only because it never touched the network.)
 */
const SLICE = 20_000;
const MAX_SLICES = 40_000;
const VERBOSE = process.env['EMU86_INSTALLER_VERBOSE'] === '1';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The address the fake DNS hands out for raw.githubusercontent.com. */
const GITHUB_IP: Ipv4 = [140, 82, 121, 4];

/**
 * Stub the ONE host-side primitive the whole chain rests on: `fetch`.
 * Two kinds of request arrive here, and the first one is easy to forget —
 * the guest has to RESOLVE the name before it can request the file, and
 * on this machine DNS is itself a fetch (DoH). Answering only the file
 * request leaves the guest unable to resolve, so nothing is ever fetched
 * at all (which is exactly how the first version of this test failed).
 */
function stubGitHub(served: string[]): void {
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    const url = String(input);

    // 1. DNS-over-HTTPS: answer with GITHUB_IP for whatever was asked.
    if (url.includes('/dns-query?dns=')) {
      const b64 = url.split('dns=')[1] ?? '';
      const query = base64urlDecode(b64);
      const question = parseQuestion(query);
      if (question === null) {
        return Promise.resolve(new Response('bad query', { status: 400 }));
      }
      const answer = buildLocalAnswer(query, question.end, GITHUB_IP);
      // Copy into a plain ArrayBuffer — BodyInit won't take a Uint8Array view.
      const body = new Uint8Array(answer).buffer;
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/dns-message' },
        }),
      );
    }

    // 2. The file itself, served from the local tools checkout.
    const file = url.split('/').pop() ?? '';
    const path = resolve(TOOLS_DIR, file);
    if (!url.includes('raw.githubusercontent.com') || !existsSync(path)) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    served.push(file);
    return Promise.resolve(
      new Response(readFileSync(path), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
  }) as typeof fetch;
}

/** RFC 4648 §5, the inverse of dns.ts's base64url. */
function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

describe('Phase 15 — the machine downloads, builds, and runs its own ping', () => {
  it('tools checkout matches what emu86 believes it ships (rev + mirror)', () => {
    if (!existsSync(resolve(TOOLS_DIR, 'install-ping.sh'))) {
      console.warn(`[skip] ${TOOLS_DIR} not checked out — rev/mirror pins not checked.`);
      return;
    }
    // PING_REV is emu86's belief about what the tools repo ships; REV=
    // in install-ping.sh is what the guest actually acts on (markers,
    // staleness). If they drift, drives stop picking up fixes — which
    // is precisely the failure the markers exist to prevent.
    const installer = readFileSync(resolve(TOOLS_DIR, 'install-ping.sh'), 'ascii');
    expect(installer).toContain(`\nREV=${PING_REV}\n`);
    // And the C source is a mirror, not a fork: web/guest/ping.c is the
    // canonical copy (the in-VM probe compiles it; tan-names pins its
    // name table), the tools repo is what the guest downloads. Byte-equal
    // or the machine builds something the tests never saw.
    const toolsPing = readFileSync(resolve(TOOLS_DIR, 'ping.c'), 'ascii');
    const guestPing = readFileSync(resolve('web/guest/ping.c'), 'ascii');
    expect(toolsPing).toBe(guestPing);
  });

  it(
    'urlgets install-ping.sh from GitHub, builds ping.c in-VM, and pings elk by name',
    async () => {
      if (!existsSync(HD32_PATH)) {
        console.warn(
          `[skip] ${HD32_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }
      if (!existsSync(resolve(TOOLS_DIR, 'install-ping.sh'))) {
        console.warn(
          `[skip] ${TOOLS_DIR} not checked out. ` +
            `git clone https://github.com/jonathan-annett/8086-tab-tools`,
        );
        return;
      }

      const served: string[] = [];
      stubGitHub(served);

      const raw = readFileSync(HD32_PATH);
      const imageBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

      const pendingTx: Uint8Array[] = [];
      let transcript = '';
      const host = new WorkerHost({
        post: (m: WorkerToMainMessage) => {
          if (m.type === 'tx') pendingTx.push(m.bytes);
        },
        autoRun: false,
      });
      host.handleMessage({ type: 'boot', config: { imageBytes } });
      await host.whenIdle();

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const runner = new AutoexecRunner({
        script: buildPingInstallerScript(),
        send: (text: string) => {
          host.handleMessage({ type: 'rx', bytes: encoder.encode(text) });
        },
        schedule: (_ms: number, fn: () => void) => { fn(); },
        typeDelayMs: () => 0,
      });

      // The guest's echo puts the script's own text in the transcript, so
      // assert on what happened AFTER the installer started running.
      const runOutput = (): string => {
        const at = transcript.lastIndexOf('sh /tmp/ip.sh');
        return at < 0 ? '' : transcript.slice(at);
      };
      const done = (): boolean =>
        /\d+ packets transmitted, \d+ received/.test(runOutput()) ||
        /BUILD FAILED|download failed/.test(runOutput());

      for (let i = 0; i < MAX_SLICES && !done(); i++) {
        const r = host.runUntil(SLICE);
        expect(r.reason).not.toBe('error');
        while (pendingTx.length > 0) {
          const chunk = decoder.decode(pendingTx.shift(), { stream: true });
          transcript += chunk;
          // The fetch settles between run slices — the same batch-boundary
          // rule every fetch-backed pseudo-host lives by.
          if (runner.active) runner.feed(chunk);
        }
        // Let the DoH / gateway promises settle.
        await new Promise((r2) => setTimeout(r2, 0));
        if (VERBOSE && i % 4000 === 0 && i > 0) {
          console.log(`[slice ${i}] served=${JSON.stringify(served)} tail: ` +
            JSON.stringify(transcript.slice(-90)));
        }
      }

      if (VERBOSE || !done()) {
        console.log('--- installer transcript tail ---\n' + transcript.slice(-3000));
      }

      const output = runOutput();

      // ---- the machine really did go to GitHub, twice, in order ----
      expect(served).toEqual(['install-ping.sh', 'ping.c']);

      // ---- ...and built the thing it downloaded ----
      expect(output).not.toContain('download failed');
      expect(output).not.toContain('BUILD FAILED');
      expect(output).toContain('ping: fetching ping.c from github');
      expect(output).toContain('ping: installed /bin/ping');

      // ---- ...and pinged the gateway BY NAME with it ----
      // `elk` resolves from the table compiled into ping — no DNS, which
      // is unavailable anyway with ktcp stopped.
      expect(output).toMatch(/bytes from 10\.0\.2\.2/);
      expect(output).toContain('3 packets transmitted, 3 received');
      expect(host.gateway?.echoRepliesSent).toBeGreaterThanOrEqual(3);

      // ---- and the shell never ran out of memory doing it ----
      // (The paste-based installer fattened the login shell so badly that
      // `net start`'s own shell couldn't allocate a kilobyte. Nothing
      // large goes through the tty any more.)
      expect(transcript).not.toContain('OUT OF HEAP SPACE');
    },
    TEST_TIMEOUT_MS,
  );
});
