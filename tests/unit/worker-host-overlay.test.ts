/**
 * WorkerHost boot-disk overlay sweeps (Phase 17 M1).
 *
 * The engine's state machine has its own suite (disk-overlay.test.ts);
 * this file pins the HOST wiring: the primary boots wrapped, sweeps
 * ride the overlay-flush / overlay-swept / reset paths, epoch ids stay
 * unique across reboots, and the forced-sweep threshold fires from the
 * paced loop. Guest writes are simulated by writing the overlay disk
 * directly — the machine's primary IS the wrapper, which is itself
 * part of the assertion (worker-host-secondary.test.ts precedent).
 *
 * The one paced test follows worker-host-pacing.test.ts law: fake
 * pacerTimeSource, authentic mode, and ALWAYS reset the host in
 * `finally` — a spinning paced loop wedges vitest with no output.
 */

import { describe, it, expect } from 'vitest';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type {
  OverlayIdentityMessage,
  OverlaySweepMessage,
  WorkerToMainMessage,
} from '../../src/browser/protocol.js';
import { SECTOR_SIZE } from '../../src/disk/disk.js';
import {
  FORCED_SWEEP_BYTES,
  OVERLAY_CHUNK_BYTES,
  OverlayDisk,
  sha256Hex,
} from '../../src/disk/overlay.js';

/** 1.44 MB all-HLT primary so boot idles immediately. */
function haltImage(bytes = 1474560): Uint8Array {
  const image = new Uint8Array(bytes);
  image.fill(0xf4);
  return image;
}

function sector(fill: number): Uint8Array {
  return new Uint8Array(SECTOR_SIZE).fill(fill);
}

function sweeps(messages: readonly WorkerToMainMessage[]): OverlaySweepMessage[] {
  return messages.filter((m): m is OverlaySweepMessage => m.type === 'overlay-sweep');
}

async function booted(): Promise<{ host: WorkerHost; messages: WorkerToMainMessage[] }> {
  const messages: WorkerToMainMessage[] = [];
  const host = new WorkerHost({ post: (m) => messages.push(m), autoRun: false });
  host.handleMessage({ type: 'boot', config: { imageBytes: haltImage() } });
  await host.whenIdle();
  return { host, messages };
}

describe('WorkerHost — overlay wiring', () => {
  it('boots the primary behind the overlay engine, default chunk span', async () => {
    const { host } = await booted();
    expect(host.overlayDisk).toBeInstanceOf(OverlayDisk);
    expect(host.machine?.disk).toBe(host.overlayDisk);
    expect(host.overlayDisk?.chunkBytes).toBe(OVERLAY_CHUNK_BYTES);
  });

  it('overlay-flush sweeps the hot map; ack settles it; a clean flush is silent', async () => {
    const { host, messages } = await booted();
    const overlay = host.overlayDisk;
    if (overlay === null) throw new Error('no overlay');

    overlay.writeSector(0, sector(0xaa));
    overlay.writeSector(1, sector(0xbb));
    host.handleMessage({ type: 'overlay-flush' });

    let posted = sweeps(messages);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.chunkSizeBytes).toBe(OVERLAY_CHUNK_BYTES);
    expect(posted[0]?.chunks.map((c) => c.chunkIndex)).toEqual([0]);
    expect(posted[0]?.chunks[0]?.bytes[0]).toBe(0xaa);
    expect(posted[0]?.chunks[0]?.bytes[SECTOR_SIZE]).toBe(0xbb);
    expect(overlay.sweepPending).toBe(true);

    host.handleMessage({ type: 'overlay-swept', epochId: posted[0]?.epochId ?? -1, ok: true });
    expect(overlay.sweepPending).toBe(false);

    host.handleMessage({ type: 'overlay-flush' }); // nothing dirty now
    posted = sweeps(messages);
    expect(posted).toHaveLength(1);
  });

  it('a nacked epoch folds back and the next flush retries under a fresh id', async () => {
    const { host, messages } = await booted();
    const overlay = host.overlayDisk;
    overlay?.writeSector(5, sector(0x55));
    host.handleMessage({ type: 'overlay-flush' });
    const first = sweeps(messages)[0];
    if (first === undefined) throw new Error('no sweep posted');

    host.handleMessage({ type: 'overlay-swept', epochId: first.epochId, ok: false, detail: 'idb' });
    expect(overlay?.sweepPending).toBe(false);
    expect(overlay?.hotSectorCount).toBe(1); // folded back

    host.handleMessage({ type: 'overlay-flush' });
    const second = sweeps(messages)[1];
    expect(second?.epochId).toBeGreaterThan(first.epochId);
    expect(second?.chunks[0]?.bytes[5 * SECTOR_SIZE]).toBe(0x55);
  });

  it('flush during a pending epoch sweeps the remainder on ack', async () => {
    const { host, messages } = await booted();
    const overlay = host.overlayDisk;
    overlay?.writeSector(0, sector(1));
    host.handleMessage({ type: 'overlay-flush' }); // epoch A in flight

    overlay?.writeSector(64, sector(2)); // chunk 1, lands in the next map
    host.handleMessage({ type: 'overlay-flush' }); // queued, not posted
    expect(sweeps(messages)).toHaveLength(1);

    const a = sweeps(messages)[0];
    host.handleMessage({ type: 'overlay-swept', epochId: a?.epochId ?? -1, ok: true });
    const posted = sweeps(messages);
    expect(posted).toHaveLength(2); // the remainder swept automatically
    expect(posted[1]?.chunks.map((c) => c.chunkIndex)).toEqual([1]);
  });

  it('reset posts one final complete sweep; late acks are harmless', async () => {
    const { host, messages } = await booted();
    const overlay = host.overlayDisk;
    overlay?.writeSector(0, sector(0x0a));
    host.handleMessage({ type: 'overlay-flush' }); // epoch A pending
    overlay?.writeSector(64, sector(0x0b)); // newer write, chunk 1

    host.handleMessage({ type: 'reset' });
    const posted = sweeps(messages);
    expect(posted).toHaveLength(2);
    // The final sweep is COMPLETE: pending epoch folded back under the
    // newer write, both chunks posted.
    expect(posted[1]?.chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);

    await host.whenIdle(); // teardown ran
    expect(host.overlayDisk).toBeNull();

    // Late acks for both epochs land after teardown — no throw, no post.
    const before = messages.length;
    host.handleMessage({ type: 'overlay-swept', epochId: posted[0]?.epochId ?? -1, ok: true });
    host.handleMessage({ type: 'overlay-swept', epochId: posted[1]?.epochId ?? -1, ok: true });
    expect(messages.length).toBe(before);
  });

  it('epoch ids stay unique across reboots', async () => {
    const { host, messages } = await booted();
    host.overlayDisk?.writeSector(0, sector(1));
    host.handleMessage({ type: 'overlay-flush' });
    host.handleMessage({ type: 'reset' });
    await host.whenIdle();

    host.handleMessage({ type: 'boot', config: { imageBytes: haltImage() } });
    await host.whenIdle();
    host.overlayDisk?.writeSector(0, sector(2));
    host.handleMessage({ type: 'overlay-flush' });

    const ids = sweeps(messages).map((s) => s.epochId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });
});

describe('WorkerHost — M2 boot fold + identity', () => {
  function identities(messages: readonly WorkerToMainMessage[]): OverlayIdentityMessage[] {
    return messages.filter((m): m is OverlayIdentityMessage => m.type === 'overlay-identity');
  }

  it('posts the base identity on every boot, even with no overlay offered', async () => {
    const image = haltImage();
    const expected = await sha256Hex(image);
    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({ post: (m) => messages.push(m), autoRun: false });
    host.handleMessage({ type: 'boot', config: { imageBytes: image } });
    await host.whenIdle();

    const ids = identities(messages);
    expect(ids).toHaveLength(1);
    expect(ids[0]?.fingerprint).toBe(expected);
    expect(ids[0]?.applied).toBe(false);
    expect(ids[0]?.chunksOffered).toBe(0);
    // Identity precedes ready (main wants it before wiring the banner).
    expect(messages.findIndex((m) => m.type === 'overlay-identity'))
      .toBeLessThan(messages.findIndex((m) => m.type === 'ready'));
  });

  it('folds offered chunks when the fingerprint matches', async () => {
    const image = haltImage();
    const fingerprint = await sha256Hex(image);
    // Chunk 0 with a marker in sector 5; the rest of the span replays
    // the base's own bytes so untouched sectors stay honest.
    const chunk = image.slice(0, OVERLAY_CHUNK_BYTES);
    chunk.fill(0x5e, 5 * SECTOR_SIZE, 6 * SECTOR_SIZE);

    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({ post: (m) => messages.push(m), autoRun: false });
    host.handleMessage({
      type: 'boot',
      config: {
        imageBytes: image,
        overlay: {
          chunks: [{ chunkIndex: 0, bytes: chunk }],
          chunkSizeBytes: OVERLAY_CHUNK_BYTES,
          fingerprint,
        },
      },
    });
    await host.whenIdle();

    expect(identities(messages)[0]?.applied).toBe(true);
    expect(identities(messages)[0]?.chunksOffered).toBe(1);
    expect(host.machine?.disk?.readSector(5)[0]).toBe(0x5e);
    expect(host.machine?.disk?.readSector(64)[0]).toBe(0xf4); // past the chunk: base
    // The folded state is the new RAM baseline — it is NOT hot-map
    // content (folding is not writing).
    expect(host.overlayDisk?.hotSectorCount).toBe(0);
  });

  it('REFUSES the fold on a fingerprint mismatch and says so', async () => {
    const image = haltImage();
    const chunk = new Uint8Array(OVERLAY_CHUNK_BYTES).fill(0x99);
    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({ post: (m) => messages.push(m), autoRun: false });
    host.handleMessage({
      type: 'boot',
      config: {
        imageBytes: image,
        overlay: {
          chunks: [{ chunkIndex: 0, bytes: chunk }],
          chunkSizeBytes: OVERLAY_CHUNK_BYTES,
          fingerprint: 'not-the-real-fingerprint',
        },
      },
    });
    await host.whenIdle();

    const id = identities(messages)[0];
    expect(id?.applied).toBe(false);
    expect(id?.chunksOffered).toBe(1);
    expect(host.machine?.disk?.readSector(0)[0]).toBe(0xf4); // untouched base
  });
});

describe('WorkerHost — overlay in the paced loop', () => {
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

  it('stats carries overlayHotSectors; the forced threshold sweeps without the heartbeat', async () => {
    const time = { t: 0 };
    const posts: WorkerToMainMessage[] = [];
    const host = new WorkerHost({
      post: (m) => posts.push(m),
      autoRun: true,
      pacerTimeSource: () => time.t,
    });
    // 32 MB HD image: big enough that FORCED_SWEEP_BYTES of dirty
    // sectors fits with room to spare.
    host.handleMessage({
      type: 'boot',
      config: { imageBytes: haltImage(32514048), cpuSpeed: 'authentic' },
    });
    try {
      await until(() => posts.some((m) => m.type === 'ready'));
      const overlay = host.overlayDisk;
      if (overlay === null) throw new Error('no overlay');

      // Below the threshold: no sweep, but the heartbeat reports the
      // hot count. (Fake time crosses one 1 s stats window; 5 s
      // throttle not reached, so the heartbeat must NOT sweep yet.)
      overlay.writeSector(0, sector(1));
      time.t += 1100;
      await until(() => posts.some((m) => m.type === 'stats'));
      const stats = posts.find((m) => m.type === 'stats');
      if (stats?.type !== 'stats') throw new Error('unreachable');
      expect(stats.overlayHotSectors).toBe(1);
      expect(sweeps(posts)).toHaveLength(0);

      // Cross the forced threshold: the per-turn check fires with fake
      // time FROZEN — no stats window, no throttle involved.
      const sectorsNeeded = FORCED_SWEEP_BYTES / SECTOR_SIZE;
      for (let lba = 1; lba <= sectorsNeeded; lba++) {
        overlay.writeSector(lba, sector(lba & 0xff));
      }
      await until(() => sweeps(posts).length > 0);
      const swept = sweeps(posts)[0];
      expect(swept?.chunks.length).toBeGreaterThan(0);
      expect(overlay.sweepPending).toBe(true);
      host.handleMessage({ type: 'overlay-swept', epochId: swept?.epochId ?? -1, ok: true });
      expect(overlay.sweepPending).toBe(false);
    } finally {
      host.handleMessage({ type: 'reset' });
      await host.whenIdle();
    }
    // 20 s, not the 5 s default: this test runs a REAL paced loop and
    // twice starved past 5 s when the full suite ran it alongside two
    // 32 MB ELKS boot files (2026-07-16, both times green standalone).
    // The budget is generous scheduling headroom, not a speed claim.
  }, 20_000);

  it('the heartbeat sweeps under the 5 s throttle', async () => {
    const time = { t: 0 };
    const posts: WorkerToMainMessage[] = [];
    const host = new WorkerHost({
      post: (m) => posts.push(m),
      autoRun: true,
      pacerTimeSource: () => time.t,
    });
    host.handleMessage({
      type: 'boot',
      config: { imageBytes: haltImage(), cpuSpeed: 'authentic' },
    });
    try {
      await until(() => posts.some((m) => m.type === 'ready'));
      host.overlayDisk?.writeSector(7, sector(0x77));

      // Hop fake time past the 5 s throttle in capped 100 ms steps
      // (pacing-test law: bigger hops are truncated by the catch-up
      // cap). Heartbeats before 5 s must not sweep; the first one
      // after must.
      for (let i = 0; i < 52; i++) {
        time.t += 100;
        await sleep(2);
      }
      await until(() => sweeps(posts).length > 0);
      const swept = sweeps(posts)[0];
      expect(swept?.chunks.map((c) => c.chunkIndex)).toEqual([0]);
      expect(swept?.chunks[0]?.bytes[7 * SECTOR_SIZE]).toBe(0x77);
    } finally {
      host.handleMessage({ type: 'reset' });
      await host.whenIdle();
    }
  });
});
