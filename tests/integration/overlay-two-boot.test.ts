/**
 * Phase 17 M2 acceptance — the two-boot overlay round trip.
 *
 * Boot 1: the guest writes a marker into the ROOT filesystem and
 * syncs; the harness sweeps the overlay exactly the way the browser
 * does (overlay-flush, then the reset-path final sweep) and plays
 * the store's part (idempotent merge by chunkIndex, post order).
 * Boot 2 folds the merged chunks: the marker must be there, and
 * ELKS fsck — the same oracle that judged the Phase 16 write path —
 * must exit silent on the FOLDED root device.
 *
 * Also pinned: a deliberately WRONG fingerprint on boot 3 leaves the
 * root fs pristine (the fold is refused, not botched).
 *
 * Skips when reference/elks-images-hd/hd32-minix.img is absent
 * (virtual-drive-persistence precedent).
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import {
  HD32_PATH,
  bootGuest,
  guestShell,
} from './guest-drive-harness.js';
import type {
  BootConfig,
  OverlayIdentityMessage,
  OverlaySweepMessage,
  WorkerToMainMessage,
} from '../../src/browser/protocol.js';

const itif = existsSync(HD32_PATH) ? it : it.skip;

/** Tiny blank secondary — the harness requires one; it plays no part. */
function blankSecondary(): { imageBytes: Uint8Array; geometry: { cylinders: number; heads: number; sectorsPerTrack: number } } {
  return {
    imageBytes: new Uint8Array(0),
    geometry: { cylinders: 4, heads: 2, sectorsPerTrack: 8 },
  };
}

function sweeps(posts: readonly WorkerToMainMessage[]): OverlaySweepMessage[] {
  return posts.filter((m): m is OverlaySweepMessage => m.type === 'overlay-sweep');
}

function identity(posts: readonly WorkerToMainMessage[]): OverlayIdentityMessage {
  const found = posts.find(
    (m): m is OverlayIdentityMessage => m.type === 'overlay-identity',
  );
  if (found === undefined) throw new Error('no overlay-identity posted');
  return found;
}

describe('overlay two-boot round trip (Phase 17 M2)', () => {
  itif(
    'root-fs writes survive a reboot via the fold; fsck judges the folded image clean',
    async () => {
      // ---- Boot 1: write into the ROOT fs, sync, sweep ----
      const s1 = await bootGuest(blankSecondary());
      guestShell(s1, 'echo overlay-mark-42 > /root/m');
      guestShell(s1, 'sync');

      s1.host.handleMessage({ type: 'overlay-flush' });
      const flushed = sweeps(s1.posts);
      expect(flushed.length).toBe(1);
      const first = flushed[0];
      if (first === undefined) throw new Error('unreachable');
      expect(first.chunks.length).toBeGreaterThan(0);
      s1.host.handleMessage({ type: 'overlay-swept', epochId: first.epochId, ok: true });

      // Reset posts the final sweep (teardown must not eat an epoch).
      s1.host.handleMessage({ type: 'reset' });
      await s1.host.whenIdle();

      // ---- Play the store: idempotent merge, post order (newer wins) ----
      const byIndex = new Map<number, Uint8Array>();
      for (const sweep of sweeps(s1.posts)) {
        for (const chunk of sweep.chunks) byIndex.set(chunk.chunkIndex, chunk.bytes);
      }
      const fingerprint = identity(s1.posts).fingerprint;
      const overlay: NonNullable<BootConfig['overlay']> = {
        chunks: [...byIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([chunkIndex, bytes]) => ({ chunkIndex, bytes })),
        chunkSizeBytes: first.chunkSizeBytes,
        fingerprint,
      };

      // ---- Boot 2: fold, verify, and let fsck judge ----
      const s2 = await bootGuest(blankSecondary(), { overlay });
      expect(identity(s2.posts).applied).toBe(true);
      expect(identity(s2.posts).fingerprint).toBe(fingerprint); // same base

      const cat = guestShell(s2, 'cat /root/m');
      expect(cat).toContain('overlay-mark-42');

      // The write-path oracle (minix-write-guest precedent): silent
      // fsck exit = the folded image's bookkeeping is coherent.
      const fsck = guestShell(s2, 'sync; fsck /dev/hda && echo FSCK-OK');
      expect(fsck).toContain('FSCK-OK');

      // ---- Boot 3: the WRONG fingerprint refuses the fold ----
      const s3 = await bootGuest(blankSecondary(), {
        overlay: { ...overlay, fingerprint: 'f'.repeat(64) },
      });
      expect(identity(s3.posts).applied).toBe(false);
      expect(identity(s3.posts).chunksOffered).toBe(overlay.chunks.length);
      const cat3 = guestShell(s3, 'cat /root/m || echo NO-MARKER');
      expect(cat3).toContain('NO-MARKER');
    },
    240_000,
  );
});
