/**
 * WorkerHost secondary-drive snapshot protocol (Phase 15 M2).
 *
 * Pins the save loop's worker half: `snapshot-secondary` returns the
 * secondary's full bytes plus the dirty count, and marks the disk
 * clean (the main thread owns persistence from there). Guest writes
 * are simulated by writing the machine's secondary disk directly —
 * the machine object IS the tracked wrapper, which is itself part of
 * the assertion.
 */

import { describe, it, expect } from 'vitest';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';
import { SECTOR_SIZE } from '../../src/disk/disk.js';

/** 1.44 MB all-HLT primary so boot idles immediately. */
function haltImage(): Uint8Array {
  const bytes = new Uint8Array(1474560);
  bytes.fill(0xf4);
  return bytes;
}

/** Tiny blank secondary: 4×2×8 CHS = 32 KiB — snapshots instantly. */
const SECONDARY_GEOMETRY = { cylinders: 4, heads: 2, sectorsPerTrack: 8 };
const SECONDARY_BYTES = 4 * 2 * 8 * SECTOR_SIZE;

async function bootedWithSecondary(): Promise<{
  host: WorkerHost;
  messages: WorkerToMainMessage[];
}> {
  const messages: WorkerToMainMessage[] = [];
  const host = new WorkerHost({ post: (m) => messages.push(m), autoRun: false });
  host.handleMessage({
    type: 'boot',
    config: {
      imageBytes: haltImage(),
      secondary: { imageBytes: new Uint8Array(0), geometry: SECONDARY_GEOMETRY },
    },
  });
  await host.whenIdle();
  return { host, messages };
}

function snapshots(messages: readonly WorkerToMainMessage[]): Array<{
  bytes: Uint8Array | null;
  dirtySectors: number;
}> {
  const out: Array<{ bytes: Uint8Array | null; dirtySectors: number }> = [];
  for (const m of messages) {
    if (m.type === 'secondary-snapshot') out.push({ bytes: m.bytes, dirtySectors: m.dirtySectors });
  }
  return out;
}

describe('WorkerHost — secondary snapshot protocol', () => {
  it('answers with the full image and resets the dirty count', async () => {
    const { host, messages } = await bootedWithSecondary();

    // Clean at boot.
    host.handleMessage({ type: 'snapshot-secondary' });
    let snaps = snapshots(messages);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.dirtySectors).toBe(0);
    expect(snaps[0]?.bytes?.length).toBe(SECONDARY_BYTES);

    // "Guest" writes two sectors (one twice — distinct count is 2).
    const disk = host.machine?.secondaryDisk;
    expect(disk).toBeDefined();
    if (!disk) return;
    disk.writeSector(3, new Uint8Array(SECTOR_SIZE).fill(0x5a));
    disk.writeSector(3, new Uint8Array(SECTOR_SIZE).fill(0x5b));
    disk.writeSector(7, new Uint8Array(SECTOR_SIZE).fill(0x7c));

    host.handleMessage({ type: 'snapshot-secondary' });
    snaps = snapshots(messages);
    expect(snaps).toHaveLength(2);
    expect(snaps[1]?.dirtySectors).toBe(2);
    expect(snaps[1]?.bytes?.[3 * SECTOR_SIZE]).toBe(0x5b);
    expect(snaps[1]?.bytes?.[7 * SECTOR_SIZE]).toBe(0x7c);
    expect(snaps[1]?.bytes?.[0]).toBe(0); // untouched sectors stay zero

    // Snapshot marked it clean — an immediate re-snapshot reports 0.
    host.handleMessage({ type: 'snapshot-secondary' });
    snaps = snapshots(messages);
    expect(snaps[2]?.dirtySectors).toBe(0);
    expect(snaps[2]?.bytes?.[3 * SECTOR_SIZE]).toBe(0x5b); // data persists
  });

  it('answers bytes:null when no secondary is mounted', async () => {
    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({ post: (m) => messages.push(m), autoRun: false });
    host.handleMessage({ type: 'boot', config: { imageBytes: haltImage() } });
    await host.whenIdle();

    host.handleMessage({ type: 'snapshot-secondary' });
    const snaps = snapshots(messages);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.bytes).toBeNull();
    expect(snaps[0]?.dirtySectors).toBe(0);
  });
});
