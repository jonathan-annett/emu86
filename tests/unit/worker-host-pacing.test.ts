/**
 * WorkerHost paced-loop tests (pacing milestone).
 *
 * The autoRun loop with an injected fake time source: virtual time must
 * track (fake) wall time — not instruction count — and freeze when wall
 * time freezes. Zero-image machines execute harmless ADDs forever, same
 * trick as the RX-pacing tests. Real (small) setTimeout sleeps let the
 * MessageChannel-yielded turns interleave with the test.
 *
 * Every test resets its host in `finally`: the paced loop runs until
 * told to stop, so a failing assertion that skipped the reset would
 * leave a spinning loop that wedges the worker past the end of the
 * suite (found the hard way — vitest hangs with no output at all).
 *
 * Turbo caution: with fake time frozen, turbo turns execute a full
 * adaptive batch each (and the tuner only grows it — fake stepMs is
 * always 0), so tests keep hosts in authentic mode while hopping fake
 * time and only flip to turbo at the very end of a stats window.
 */

import { describe, it, expect } from 'vitest';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';

const JIFFY_10MS_CYCLES = Math.floor(10 * 4772.7); // 47,727

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('until(): condition never met');
    await sleep(2);
  }
}

interface Rig {
  host: WorkerHost;
  posts: WorkerToMainMessage[];
  time: { t: number };
}

function bootRig(cpuSpeed?: 'authentic' | 'turbo'): Rig {
  const time = { t: 0 };
  const posts: WorkerToMainMessage[] = [];
  const host = new WorkerHost({
    post: (m) => posts.push(m),
    autoRun: true,
    pacerTimeSource: () => time.t,
  });
  host.handleMessage({
    type: 'boot',
    config: {
      imageBytes: new Uint8Array(64 * 512),
      geometry: { cylinders: 1, heads: 2, sectorsPerTrack: 32 },
      diskClass: 'floppy',
      ...(cpuSpeed !== undefined ? { cpuSpeed } : {}),
    },
  });
  return { host, posts, time };
}

async function stopRig(rig: Rig): Promise<void> {
  rig.host.handleMessage({ type: 'reset' });
  await rig.host.whenIdle();
}

describe('WorkerHost — paced autoRun loop', () => {
  it('virtual time tracks fake wall time and freezes with it', async () => {
    const rig = bootRig('authentic');
    try {
      await until(() => rig.posts.some((m) => m.type === 'ready'));
      await sleep(10); // several zero-elapsed turns — nothing may advance
      expect(rig.host.machine?.clock.now()).toBe(0);

      // 10 ms of wall time appears: exactly that much virtual time
      // follows, regardless of how many turns or instructions it took.
      rig.time.t += 10;
      await until(() => (rig.host.machine?.clock.now() ?? 0) > 0);
      await sleep(10); // extra turns at frozen time must add nothing
      expect(rig.host.machine?.clock.now()).toBe(JIFFY_10MS_CYCLES);
    } finally {
      await stopRig(rig);
    }
  });

  it('posts stats once a (fake) second; a late turbo switch shows in the message', async () => {
    const rig = bootRig('authentic');
    try {
      await until(() => rig.posts.some((m) => m.type === 'ready'));

      // Approach the 1-second stats window in capped 100 ms hops (bigger
      // hops are truncated by the catch-up cap), staying authentic so
      // frozen-time turns stay cheap; flip to turbo just before the
      // window closes so the posted stats carry the switched mode.
      for (let i = 0; i < 9; i++) {
        rig.time.t += 100;
        await sleep(2);
      }
      rig.host.handleMessage({ type: 'set-speed', mode: 'turbo' });
      await sleep(5); // let the mode land before the window closes
      rig.time.t += 200;
      await until(() => rig.posts.some((m) => m.type === 'stats'));

      const stats = rig.posts.find((m) => m.type === 'stats');
      if (stats?.type !== 'stats') throw new Error('unreachable');
      expect(stats.mode).toBe('turbo'); // live set-speed took effect
      expect(stats.batch).toBeGreaterThan(0);
      expect(stats.cyclesPerSec).toBeGreaterThan(0);
      expect(stats.instrPerSec).toBeGreaterThanOrEqual(0);
    } finally {
      await stopRig(rig);
    }
  });
});
