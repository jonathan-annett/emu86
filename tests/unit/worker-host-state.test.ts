/**
 * WorkerHost capture/restore protocol (Phase 18 M2).
 *
 * The M1 equivalence law, pushed through the protocol layer: what
 * `capture-state` posts, fed back as `BootConfig.restore`, must
 * produce THE SAME MACHINE — for both disk carriages:
 *
 *   - embedded (named saves, D2(a)): captured bytes verbatim, resolve
 *     pipeline bypassed;
 *   - reference (reload-resume, D2(b)): base + collected overlay
 *     sweeps reconstruct the primary, hash-verified — any drift
 *     refuses and cold-boots.
 *
 * Fixture shape follows worker-host-overlay.test.ts: all-HLT floppy,
 * autoRun: false, guest writes simulated through the overlay wrapper
 * (the machine's primary IS the wrapper). Determinism: both hosts get
 * a frozen InMemoryHostClock — the M1 harness ground rule.
 */

import { describe, expect, it } from 'vitest';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type {
  BootConfig,
  OverlayChunk,
  RestoreResultMessage,
  StateCapturedMessage,
  WorkerToMainMessage,
} from '../../src/browser/protocol.js';
import { SECTOR_SIZE, WriteTrackingDisk } from '../../src/disk/disk.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { captureMachineState } from '../../src/machine/machine-state.js';
import { diffStates } from '../state-diff.js';

/** 1.44 MB all-HLT primary so boot idles immediately. */
function haltImage(bytes = 1474560): Uint8Array {
  const image = new Uint8Array(bytes);
  image.fill(0xf4);
  return image;
}

function sector(fill: number): Uint8Array {
  return new Uint8Array(SECTOR_SIZE).fill(fill);
}

interface Rig {
  host: WorkerHost;
  messages: WorkerToMainMessage[];
}

async function boot(config: BootConfig): Promise<Rig> {
  const messages: WorkerToMainMessage[] = [];
  const host = new WorkerHost({
    post: (m) => messages.push(m),
    autoRun: false,
    hostClock: new InMemoryHostClock(),
  });
  host.handleMessage({ type: 'boot', config });
  await host.whenIdle();
  return { host, messages };
}

function captured(rig: Rig): StateCapturedMessage {
  const msg = rig.messages.find(
    (m): m is StateCapturedMessage => m.type === 'state-captured',
  );
  if (msg === undefined) throw new Error('no state-captured reply');
  return msg;
}

/** Poll for the async capture reply (hashes settle off the message path). */
async function awaitCaptured(rig: Rig): Promise<StateCapturedMessage> {
  for (let i = 0; i < 400; i++) {
    const msg = rig.messages.find(
      (m): m is StateCapturedMessage => m.type === 'state-captured',
    );
    if (msg !== undefined) return msg;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('state-captured never arrived');
}

function restoreResult(rig: Rig): RestoreResultMessage {
  const msg = rig.messages.find(
    (m): m is RestoreResultMessage => m.type === 'restore-result',
  );
  if (msg === undefined) throw new Error('no restore-result posted');
  return msg;
}

/** Union of every posted sweep's chunks, post-order overwrite — what main's store accumulates. */
function collectedChunks(rig: Rig): OverlayChunk[] {
  const byIndex = new Map<number, OverlayChunk>();
  for (const m of rig.messages) {
    if (m.type !== 'overlay-sweep') continue;
    for (const c of m.chunks) byIndex.set(c.chunkIndex, c);
  }
  return [...byIndex.values()];
}

function bootFingerprint(rig: Rig): string {
  const msg = rig.messages.find((m) => m.type === 'overlay-identity');
  if (msg === undefined || msg.type !== 'overlay-identity') {
    throw new Error('no overlay-identity posted');
  }
  return msg.fingerprint;
}

function compareHosts(a: WorkerHost, b: WorkerHost): string[] {
  if (a.machine === null || b.machine === null) return ['a machine is missing'];
  return diffStates(captureMachineState(a.machine), captureMachineState(b.machine));
}

/** Dirty the machine beyond its reset state: disk writes + device pokes + steps. */
function workTheMachine(rig: Rig): void {
  const overlay = rig.host.overlayDisk;
  if (overlay === null) throw new Error('no overlay disk');
  overlay.writeSector(100, sector(0xaa));
  overlay.writeSector(101, sector(0xbb));
  rig.host.runUntil(500); // boot sector loads, CPU executes into the HLT
  overlay.writeSector(2000, sector(0xcc));
  rig.host.machine?.uart.injectByte(0x58); // pending RX byte rides the state
  rig.host.runUntil(200);
}

describe('WorkerHost — capture-state', () => {
  it('replies ok:false with no machine running', async () => {
    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({ post: (m) => messages.push(m), autoRun: false });
    host.handleMessage({ type: 'capture-state', requestId: 7, disks: 'reference' });
    const reply = messages.find((m) => m.type === 'state-captured');
    expect(reply).toMatchObject({ requestId: 7, ok: false });
  });

  it('captures state + hashes + secondary bytes, keeping the dirty count (peek)', async () => {
    const secondaryBytes = new Uint8Array(1474560).fill(0x11);
    const rig = await boot({
      imageBytes: haltImage(),
      secondary: { imageBytes: secondaryBytes },
    });
    rig.host.runUntil(200);
    rig.host.machine?.secondaryDisk?.writeSector(9, sector(0x77));
    rig.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
    const reply = await awaitCaptured(rig);
    expect(reply.ok).toBe(true);
    expect(reply.state?.v).toBe(1);
    expect(reply.primarySha).toMatch(/^[0-9a-f]{64}$/);
    expect(reply.primary).toBeUndefined(); // reference mode: hashes only
    expect(reply.secondary?.bytes[9 * SECTOR_SIZE]).toBe(0x77);
    expect(reply.secondarySha).toMatch(/^[0-9a-f]{64}$/);
    expect(reply.secondaryDirtySectors).toBe(1);
    // Peek semantics (no markSecondaryClean): the auto-persist trigger survives.
    const tracked = rig.host.machine?.secondaryDisk;
    if (!(tracked instanceof WriteTrackingDisk)) throw new Error('no tracked secondary');
    expect(tracked.dirtySectorCount).toBe(1);
  });

  it('markSecondaryClean is two-phase: durable only on secondary-persisted (field fix #4)', async () => {
    const rig = await boot({
      imageBytes: haltImage(),
      secondary: { imageBytes: new Uint8Array(1474560) },
    });
    rig.host.runUntil(200);
    rig.host.machine?.secondaryDisk?.writeSector(3, sector(0x33));
    rig.host.handleMessage({
      type: 'capture-state', requestId: 1, disks: 'reference', markSecondaryClean: true,
    });
    const reply = await awaitCaptured(rig);
    expect(reply.secondaryDirtySectors).toBe(1);
    // The reply names the unconfirmed sectors — the slot's carried delta.
    expect(reply.secondaryDirtyLbas).toEqual([3]);
    const tracked = rig.host.machine?.secondaryDisk;
    if (!(tracked instanceof WriteTrackingDisk)) throw new Error('no tracked secondary');
    // Still unconfirmed: the fork write hasn't been acknowledged.
    expect(tracked.dirtySectorCount).toBe(1);
    // A nack folds back — the next capture re-carries.
    rig.host.handleMessage({ type: 'secondary-persisted', requestId: 1, ok: false });
    expect(tracked.dirtySectorCount).toBe(1);
    rig.messages.length = 0;
    rig.host.handleMessage({
      type: 'capture-state', requestId: 2, disks: 'reference', markSecondaryClean: true,
    });
    const second = await awaitCaptured(rig);
    expect(second.secondaryDirtyLbas).toEqual([3]);
    // The ack (fork write committed) makes it durable.
    rig.host.handleMessage({ type: 'secondary-persisted', requestId: 2, ok: true });
    expect(tracked.dirtySectorCount).toBe(0);
    // A stale confirmation for an old capture is ignored.
    rig.host.handleMessage({ type: 'secondary-persisted', requestId: 1, ok: true });
    expect(tracked.dirtySectorCount).toBe(0);
  });

  it('the sha cache serves idle repeat captures and invalidates on a disk write', async () => {
    const rig = await boot({ imageBytes: haltImage() });
    rig.host.runUntil(200);

    rig.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
    const first = await awaitCaptured(rig);
    rig.messages.length = 0;

    // Idle: no writes since — the cached hash must be IDENTICAL.
    rig.host.handleMessage({ type: 'capture-state', requestId: 2, disks: 'reference' });
    const second = await awaitCaptured(rig);
    expect(second.primarySha).toBe(first.primarySha);
    rig.messages.length = 0;

    // A write invalidates: the hash must change.
    rig.host.overlayDisk?.writeSector(50, sector(0x99));
    rig.host.handleMessage({ type: 'capture-state', requestId: 3, disks: 'reference' });
    const third = await awaitCaptured(rig);
    expect(third.primarySha).not.toBe(first.primarySha);
  });
});

describe('WorkerHost — freeze-and-inspect (field-loop UI)', () => {
  it('inspect-machine returns a coherent snapshot matching the machine', async () => {
    const rig = await boot({ imageBytes: haltImage() });
    rig.host.runUntil(200);
    rig.host.handleMessage({ type: 'inspect-machine', requestId: 42 });
    const reply = rig.messages.find((m) => m.type === 'machine-inspected');
    if (reply === undefined || reply.type !== 'machine-inspected') {
      throw new Error('no machine-inspected reply');
    }
    expect(reply).toMatchObject({ requestId: 42, ok: true });
    const cpu = rig.host.machine?.cpu;
    if (cpu === undefined || cpu === null || reply.snapshot === undefined) {
      throw new Error('snapshot missing');
    }
    expect(reply.snapshot.regs.ip).toBe(cpu.regs.IP);
    expect(reply.snapshot.regs.cs).toBe(cpu.regs.CS);
    expect(reply.snapshot.halted).toBe(cpu.halted);
    // The code window reads the actual bytes at CS:IP.
    const linear = ((cpu.regs.CS << 4) + cpu.regs.IP) & 0xfffff;
    expect(reply.snapshot.code.linear).toBe(linear);
    expect(reply.snapshot.code.bytes[0]).toBe(
      rig.host.machine?.memory.readByte(linear),
    );
    expect(reply.snapshot.code.bytes.length).toBe(64);
    expect(reply.snapshot.devices.pic.imr).toBeDefined();
    // Guest-time accounting: a cold boot's session IS its lifetime.
    expect(reply.snapshot.time.cyclesSinceBoot).toBeGreaterThan(0);
    expect(reply.snapshot.time.cyclesThisSession).toBe(reply.snapshot.time.cyclesSinceBoot);
  });

  it('inspect with no machine replies ok:false; set-paused round-trips', () => {
    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({ post: (m) => messages.push(m), autoRun: false });
    host.handleMessage({ type: 'inspect-machine', requestId: 1 });
    expect(messages.find((m) => m.type === 'machine-inspected')).toMatchObject({
      ok: false,
    });
    // set-paused is accepted without a machine (a no-op until boot).
    host.handleMessage({ type: 'set-paused', paused: true });
    host.handleMessage({ type: 'set-paused', paused: false });
  });
});

describe('WorkerHost — restore round trips (the M1 law through the protocol)', () => {
  it('embedded: capture → restore → identical machine, and it stays identical', async () => {
    const a = await boot({ imageBytes: haltImage() });
    workTheMachine(a);

    a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'embedded' });
    const reply = await awaitCaptured(a);
    expect(reply.ok).toBe(true);
    if (reply.state === undefined || reply.capturedAt === undefined || reply.primary === undefined) {
      throw new Error('embedded capture reply incomplete');
    }

    const b = await boot({
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        embedded: {
          primary: {
            imageBytes: reply.primary.bytes,
            geometry: reply.primary.geometry,
            diskClass: reply.primary.diskClass,
          },
          secondary: null,
        },
      },
    });
    expect(restoreResult(b).ok).toBe(true);
    expect(compareHosts(a.host, b.host)).toEqual([]);

    // The restored machine continues in lockstep with the original.
    a.host.runUntil(300);
    b.host.runUntil(300);
    expect(compareHosts(a.host, b.host)).toEqual([]);
  });

  it('reference: base + store chunks reconstruct, verify, restore', async () => {
    const image = haltImage();
    const a = await boot({ imageBytes: new Uint8Array(image) });
    workTheMachine(a);

    a.host.handleMessage({ type: 'capture-state', requestId: 2, disks: 'reference' });
    const reply = await awaitCaptured(a);
    expect(reply.ok).toBe(true);
    if (reply.state === undefined || reply.capturedAt === undefined ||
        reply.primarySha === undefined) {
      throw new Error('reference capture reply incomplete');
    }

    // Field fix #4: the capture posts NO overlay-sweep — its final
    // epoch rides the reply, for main to store slot-first.
    expect(collectedChunks(a)).toEqual([]);
    if (reply.overlayEpoch == null) throw new Error('no overlayEpoch in reply');
    expect(reply.overlayEpoch.chunks.length).toBeGreaterThan(0);

    // Main's happy path, simulated: the epoch reached the store.
    const b = await boot({
      imageBytes: new Uint8Array(image), // the pristine base, as a reload would fetch
      overlay: {
        chunks: reply.overlayEpoch.chunks,
        chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
        fingerprint: bootFingerprint(a),
      },
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          primarySha: reply.primarySha,
          secondarySha: reply.secondarySha ?? null,
        },
      },
    });
    expect(restoreResult(b)).toMatchObject({ ok: true });
    expect(compareHosts(a.host, b.host)).toEqual([]);

    // Guest-time accounting across the restore: the lineage counter
    // survives (clockCycles rode the state), the session line resets.
    b.host.handleMessage({ type: 'inspect-machine', requestId: 99 });
    const inspected = b.messages.find((m) => m.type === 'machine-inspected');
    if (inspected === undefined || inspected.type !== 'machine-inspected' ||
        inspected.snapshot === undefined) {
      throw new Error('no inspection after restore');
    }
    expect(inspected.snapshot.time.cyclesSinceBoot).toBe(
      a.host.machine?.clock.now(),
    );
    expect(inspected.snapshot.time.cyclesThisSession).toBe(0);

    a.host.runUntil(300);
    b.host.runUntil(300);
    expect(compareHosts(a.host, b.host)).toEqual([]);
  });

  it('reference: a hash mismatch refuses and cold-boots — honestly', async () => {
    const image = haltImage();
    const a = await boot({ imageBytes: new Uint8Array(image) });
    workTheMachine(a);
    a.host.handleMessage({ type: 'capture-state', requestId: 3, disks: 'reference' });
    const reply = await awaitCaptured(a);
    if (reply.state === undefined || reply.capturedAt === undefined) {
      throw new Error('capture reply incomplete');
    }

    // The reconstruction is missing the sweeps (a lost final epoch).
    const b = await boot({
      imageBytes: new Uint8Array(image),
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          primarySha: reply.primarySha ?? '0'.repeat(64),
          secondarySha: null,
        },
      },
    });
    const result = restoreResult(b);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not match/);
    // The machine still boots — a cold boot of the resolved disk.
    expect(b.host.machine).not.toBeNull();
    const r = b.host.runUntil(200);
    expect(r.reason).not.toBe('error');
  });

  it('a corrupt state schema refuses at restore and cold-boots', async () => {
    const a = await boot({ imageBytes: haltImage() });
    a.host.runUntil(100);
    a.host.handleMessage({ type: 'capture-state', requestId: 4, disks: 'embedded' });
    const reply = await awaitCaptured(a);
    if (reply.state === undefined || reply.capturedAt === undefined || reply.primary === undefined) {
      throw new Error('capture reply incomplete');
    }
    const mangled = { ...reply.state, v: 99 as unknown as 1 };
    const b = await boot({
      restore: {
        state: mangled,
        capturedAt: reply.capturedAt,
        embedded: {
          primary: {
            imageBytes: reply.primary.bytes,
            geometry: reply.primary.geometry,
            diskClass: reply.primary.diskClass,
          },
          secondary: null,
        },
      },
    });
    const result = restoreResult(b);
    expect(result.ok).toBe(false);
    expect(b.host.machine).not.toBeNull();
  });
});

describe('WorkerHost — the torn resume pair (field fix #4)', () => {
  it('slot committed, store lost: the carried epoch reconstructs and re-enters the hot map', async () => {
    const image = haltImage();
    const a = await boot({ imageBytes: new Uint8Array(image) });
    const fingerprint = bootFingerprint(a);
    workTheMachine(a);

    // Capture 1: its epoch reaches the store (main acks after commit).
    a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
    const first = await awaitCaptured(a);
    if (first.overlayEpoch == null) throw new Error('capture 1 carried no epoch');
    const storeChunks = first.overlayEpoch.chunks;
    a.host.handleMessage({
      type: 'overlay-swept', epochId: first.overlayEpoch.epochId, ok: true,
    });

    // More guest writes, then capture 2 — the F5 kills the store write
    // but the slot row (carrying epoch 2) committed.
    a.host.overlayDisk?.writeSector(300, sector(0xd1));
    a.host.overlayDisk?.writeSector(2500, sector(0xd2));
    a.messages.length = 0;
    a.host.handleMessage({ type: 'capture-state', requestId: 2, disks: 'reference' });
    const second = await awaitCaptured(a);
    if (second.state === undefined || second.capturedAt === undefined ||
        second.primarySha === undefined || second.overlayEpoch == null) {
      throw new Error('capture 2 reply incomplete');
    }

    const b = await boot({
      imageBytes: new Uint8Array(image),
      overlay: {
        chunks: storeChunks, // the store never saw epoch 2
        chunkSizeBytes: first.overlayEpoch.chunkSizeBytes,
        fingerprint,
      },
      restore: {
        state: second.state,
        capturedAt: second.capturedAt,
        expected: {
          primarySha: second.primarySha,
          secondarySha: second.secondarySha ?? null,
        },
        carriedPrimary: {
          chunkSizeBytes: second.overlayEpoch.chunkSizeBytes,
          fingerprint,
          chunks: second.overlayEpoch.chunks,
        },
      },
    });
    expect(restoreResult(b)).toMatchObject({ ok: true });
    expect(compareHosts(a.host, b.host)).toEqual([]);
    // The seeding rule: the carried sectors are hot again, so the next
    // capture re-carries them toward the store — a lost store write
    // must not strand them outside future reconstructions.
    expect(b.host.overlayDisk?.hotSectorCount ?? 0).toBeGreaterThan(0);

    a.host.runUntil(300);
    b.host.runUntil(300);
    expect(compareHosts(a.host, b.host)).toEqual([]);
  });

  it('fork row stale, slot committed: the carried drive sectors reconstruct and stay dirty', async () => {
    const forkBytes = new Uint8Array(1474560).fill(0x11);
    const a = await boot({
      imageBytes: haltImage(),
      secondary: { imageBytes: new Uint8Array(forkBytes) },
    });
    a.host.runUntil(300);
    a.host.machine?.secondaryDisk?.writeSector(7, sector(0x70));
    a.host.machine?.secondaryDisk?.writeSector(2048, sector(0x71));

    a.host.handleMessage({
      type: 'capture-state', requestId: 1, disks: 'reference', markSecondaryClean: true,
    });
    const reply = await awaitCaptured(a);
    if (reply.state === undefined || reply.capturedAt === undefined ||
        reply.primarySha === undefined || reply.secondary == null ||
        reply.secondaryDirtyLbas === undefined) {
      throw new Error('capture reply incomplete');
    }
    expect(reply.secondaryDirtyLbas).toEqual([7, 2048]);

    // Main's slot row: carried sectors sliced from the capture's own
    // snapshot. The fork write never committed — boot B gets the OLD
    // fork bytes.
    const carriedSecondary = reply.secondaryDirtyLbas.map((lba) => ({
      lba,
      bytes: reply.secondary!.bytes.slice(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE),
    }));
    const overlay = reply.overlayEpoch != null
      ? {
          chunks: reply.overlayEpoch.chunks,
          chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
          fingerprint: bootFingerprint(a),
        }
      : undefined;
    const b = await boot({
      imageBytes: haltImage(),
      secondary: { imageBytes: new Uint8Array(forkBytes) }, // stale fork
      ...(overlay !== undefined ? { overlay } : {}),
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          primarySha: reply.primarySha,
          secondarySha: reply.secondarySha ?? null,
        },
        ...(reply.overlayEpoch != null
          ? {
              carriedPrimary: {
                chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
                fingerprint: bootFingerprint(a),
                chunks: reply.overlayEpoch.chunks,
              },
            }
          : {}),
        carriedSecondary,
      },
    });
    expect(restoreResult(b)).toMatchObject({ ok: true });
    // The carried sectors are on the restored drive…
    expect(b.host.machine?.secondaryDisk?.readSector(7)[0]).toBe(0x70);
    expect(b.host.machine?.secondaryDisk?.readSector(2048)[0]).toBe(0x71);
    // …and STILL dirty, so the next confirmed persist writes them to
    // the fork row this reconstruction had to work around.
    const tracked = b.host.machine?.secondaryDisk;
    if (!(tracked instanceof WriteTrackingDisk)) throw new Error('no tracked secondary');
    expect(tracked.dirtySectorCount).toBe(2);
  });

  it('a corrupt carried delta refuses and cold-boots', async () => {
    const image = haltImage();
    const a = await boot({ imageBytes: new Uint8Array(image) });
    workTheMachine(a);
    a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
    const reply = await awaitCaptured(a);
    if (reply.state === undefined || reply.capturedAt === undefined ||
        reply.primarySha === undefined) {
      throw new Error('capture reply incomplete');
    }
    const b = await boot({
      imageBytes: new Uint8Array(image),
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          primarySha: reply.primarySha,
          secondarySha: reply.secondarySha ?? null,
        },
        carriedPrimary: {
          chunkSizeBytes: 32 * 1024,
          fingerprint: bootFingerprint(a),
          chunks: [{ chunkIndex: 1_000_000, bytes: sector(0xff) }], // far past the disk
        },
      },
    });
    const result = restoreResult(b);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/corrupt/);
    expect(b.host.machine).not.toBeNull();
    expect(b.host.runUntil(200).reason).not.toBe('error');
  });

  it('a carried delta against a different base refuses', async () => {
    const image = haltImage();
    const a = await boot({ imageBytes: new Uint8Array(image) });
    workTheMachine(a);
    a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
    const reply = await awaitCaptured(a);
    if (reply.state === undefined || reply.capturedAt === undefined ||
        reply.primarySha === undefined || reply.overlayEpoch == null) {
      throw new Error('capture reply incomplete');
    }
    const b = await boot({
      imageBytes: new Uint8Array(image),
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          primarySha: reply.primarySha,
          secondarySha: reply.secondarySha ?? null,
        },
        carriedPrimary: {
          chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
          fingerprint: 'f'.repeat(64), // not this base
          chunks: reply.overlayEpoch.chunks,
        },
      },
    });
    const result = restoreResult(b);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/different base image/);
    expect(b.host.machine).not.toBeNull();
  });
});
