/**
 * Browser-path HD serial boot (Phase 14 M2 acceptance, harness side).
 *
 * Boots the STOCK `hd32-minix.img` — no test-side bootopts rewrite —
 * through `WorkerHost`, relying on the M2 auto-patch to redirect the
 * console to ttyS0. This is exactly the code path the web page takes
 * when a user picks an HD image from the library; the only thing this
 * test can't do is click around a real browser (Jonathan's session
 * covers that half).
 *
 * Unlike the Phase 10.2 boot test (which forces `init=/bin/sh`), the
 * auto-patch preserves the image's real init, so the boot lands wherever
 * the image's /etc/inittab points the serial console — a login: prompt
 * or a shell. The test accepts either, and if it's a login prompt, logs
 * in as root (passwordless on the stock image) to reach the shell.
 *
 * Skips with a pointer when the fixture is absent (Phase 13.1 convention).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';

const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * The image's REAL init runs /etc/rc.sys (date, mounts, daemons) before
 * getty, unlike the init=/bin/sh boot tests — budget in slices and stop
 * at the first prompt rather than guessing a single number.
 */
const BOOT_SLICE_INSTRUCTIONS = 10_000_000;
const BOOT_MAX_SLICES = 8;
const STEP_INSTRUCTIONS = 4_000_000;
const PROMPT_RE = /login: *$|# *$|\$ *$/;

describe('Phase 14 M2 — stock hd32-minix.img boots to serial via WorkerHost auto-patch', () => {
  it(
    'reaches a login: or shell prompt over the UART with no test-side bootopts edit',
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

      const posts: WorkerToMainMessage[] = [];
      const host = new WorkerHost({ post: (m) => posts.push(m), autoRun: false });
      host.handleMessage({ type: 'boot', config: { imageBytes: bytes } });
      await host.whenIdle();
      expect(posts.some((m) => m.type === 'ready')).toBe(true);

      const txText = (): string => {
        let s = '';
        for (const m of posts) {
          if (m.type === 'tx') s += String.fromCharCode(...m.bytes);
        }
        return s;
      };

      // ---- boot: run slices until a prompt shows up ----
      let boot = '';
      for (let slice = 0; slice < BOOT_MAX_SLICES; slice++) {
        const r = host.runUntil(BOOT_SLICE_INSTRUCTIONS);
        expect(r.reason).not.toBe('error');
        boot = txText();
        if (PROMPT_RE.test(boot)) break;
      }

      if (!PROMPT_RE.test(boot) || process.env['EMU86_BROWSER_HD_VERBOSE'] === '1') {
        // Surface the tail — always on failure, on request otherwise.
        console.log('--- boot transcript tail ---\n' + boot.slice(-1500));
      }

      // Serial console took over (same milestone as the Phase 10.2 test).
      expect(boot).toContain('VFS: Mounted root device');
      // The image's own init runs — accept login: or a direct shell.
      expect(boot).toMatch(PROMPT_RE);

      // ---- if login: log in as root (stock image: passwordless) ----
      if (/login: *$/.test(boot)) {
        host.handleMessage({
          type: 'rx',
          bytes: new Uint8Array([...'root\n'].map((c) => c.charCodeAt(0))),
        });
        const r2 = host.runUntil(STEP_INSTRUCTIONS);
        expect(r2.reason).not.toBe('error');
        expect(txText()).toMatch(/# *$/);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
