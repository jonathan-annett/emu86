/**
 * The ping installer, driven exactly as the browser drives it
 * (Phase 15 M3 follow-on acceptance).
 *
 * This is the test that was missing when the installer shipped broken.
 * The earlier in-VM ping test fed `ping.c` to the guest on the probe
 * FLOPPY — a path the browser does not have. The browser can only type,
 * and typing 14 KB of C through a shell exposed two walls the floppy
 * never touched (`ping-paste-log.txt`, 2026-07-14):
 *
 *   1. the raw tty queue overran (fixed: @here waits on the `> ` prompt);
 *   2. ELKS `sh` blew its heap buffering a nested 14 KB heredoc
 *      (fixed: no nesting + chunked source).
 *
 * So this drives the REAL {@link buildPingInstallerScript} output
 * through the REAL {@link AutoexecRunner} against a REAL boot of
 * hd32-minix under {@link WorkerHost} — the browser's own code path,
 * minus the browser. It asserts the guest built ping in-VM and pinged
 * the WorkerHost's LanGateway, which answers with real ICMP.
 *
 * Skips with a pointer when the fixture image is absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';
import { AutoexecRunner } from '../../web/autoexec.js';
import { buildPingInstallerScript } from '../../web/ping-installer.js';

const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');
const PING_C_PATH = resolve('web/guest/ping.c');

const TEST_TIMEOUT_MS = 20 * 60 * 1000;
/** Small slices: each script line needs one guest echo + prompt to advance. */
const SLICE = 250_000;
const MAX_SLICES = 4000; // ~1e9 instructions of headroom; the loop exits early
const VERBOSE = process.env['EMU86_INSTALLER_VERBOSE'] === '1';

describe('Phase 15 M3 — the browser ping installer builds ping and pings the gateway', () => {
  it(
    'pastes ping.c through the shell, compiles it in-VM, installs it, pings 10.0.2.2',
    async () => {
      if (!existsSync(HD32_PATH)) {
        console.warn(
          `[skip] ${HD32_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }

      const raw = readFileSync(HD32_PATH);
      const imageBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const script = buildPingInstallerScript(readFileSync(PING_C_PATH, 'ascii'));

      // ---- boot the browser's own host (auto-patch, LAN, gateway) ----
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

      // ---- the browser's autoexec runner, wired to the same rx path ----
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const runner = new AutoexecRunner({
        script,
        send: (text: string) => {
          host.handleMessage({ type: 'rx', bytes: encoder.encode(text) });
        },
        // Instant mode throughout (the installer types nothing
        // clackety), so the scheduler is only a safety net.
        schedule: (_ms: number, fn: () => void) => { fn(); },
        typeDelayMs: () => 0,
      });

      /**
       * The guest ECHOES every pasted line, so the script's own text —
       * including strings like "BUILD FAILED" — is in the transcript
       * long before anything runs. Assertions about what the installer
       * *did* must therefore look only after the run began. (The first
       * draft of this test asserted on the whole transcript and
       * "failed" on the echo of its own error message.)
       */
      const runOutput = (): string => {
        const at = transcript.lastIndexOf('sh /tmp/getping.sh');
        return at < 0 ? '' : transcript.slice(at);
      };

      const done = (): boolean =>
        /\d+ packets transmitted, \d+ received/.test(runOutput()) ||
        /BUILD FAILED|not enough memory/.test(runOutput());

      for (let i = 0; i < MAX_SLICES && !done(); i++) {
        const r = host.runUntil(SLICE);
        expect(r.reason).not.toBe('error');
        while (pendingTx.length > 0) {
          const chunk = decoder.decode(pendingTx.shift(), { stream: true });
          transcript += chunk;
          if (runner.active) runner.feed(chunk);
        }
      }

      if (VERBOSE || !done()) {
        console.log('--- installer transcript tail ---\n' + transcript.slice(-3000));
      }

      // ---- the paste survived: no heap death, no shell soup ----
      // (These CAN be asserted over the whole transcript: neither
      // string appears anywhere in the script's own text.)
      expect(transcript).not.toContain('OUT OF HEAP SPACE');
      expect(transcript).not.toContain('Syntax error');

      // ---- the guest built and installed ping ITSELF ----
      const output = runOutput();
      expect(output).not.toContain('BUILD FAILED');
      expect(output).toContain('ping: building it with the in-VM c86 toolchain');
      expect(output).toContain('ping: installed /bin/ping');

      // ---- and it pinged the gateway, which really answered ----
      expect(output).toMatch(/bytes from 10\.0\.2\.2/);
      expect(output).toContain('3 packets transmitted, 3 received');
      expect(host.gateway?.echoRepliesSent).toBeGreaterThanOrEqual(3);
    },
    TEST_TIMEOUT_MS,
  );
});
