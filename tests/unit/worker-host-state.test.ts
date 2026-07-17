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

  it('captures state + hashes, never copying disks in reference mode (peek)', async () => {
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
    // §7: reference captures pin inputs — a store digest, no image sha.
    expect(reply.storeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(reply.primarySha).toBeUndefined();
    expect(reply.primary).toBeUndefined(); // reference mode: no image bytes
    // Fix #8: no secondary bytes and no secondary sha either — the
    // fork is pinned by generation main-side, and the drive's bytes
    // only ever ride the (killable) fork-snapshot message.
    expect(reply.secondary).toBeNull();
    expect(reply.secondarySha).toBeNull();
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
    // Fix #8: the reply carries the delta PRE-SLICED (bytes included)
    // and no full drive image at all — the slot never waits on 8 MB.
    expect(reply.carriedSecondary?.map((s) => s.lba)).toEqual([3]);
    expect(reply.carriedSecondary?.[0]?.bytes).toEqual(sector(0x33));
    expect(reply.secondary).toBeNull();
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
    expect(second.carriedSecondary?.map((s) => s.lba)).toEqual([3]);
    // The ack (fork write committed) makes it durable.
    rig.host.handleMessage({ type: 'secondary-persisted', requestId: 2, ok: true });
    expect(tracked.dirtySectorCount).toBe(0);
    // A stale confirmation for an old capture is ignored.
    rig.host.handleMessage({ type: 'secondary-persisted', requestId: 1, ok: true });
    expect(tracked.dirtySectorCount).toBe(0);
  });

  it('posts the fork snapshot AFTER the reply, never on a peek (fix #8)', async () => {
    const rig = await boot({
      imageBytes: haltImage(),
      secondary: { imageBytes: new Uint8Array(1474560) },
    });
    rig.host.runUntil(200);
    rig.host.machine?.secondaryDisk?.writeSector(5, sector(0x55));
    rig.host.handleMessage({
      type: 'capture-state', requestId: 1, disks: 'reference', markSecondaryClean: true,
    });
    await awaitCaptured(rig);
    await new Promise((r) => setTimeout(r, 20)); // let the trailing post land
    const types = rig.messages.map((m) => m.type);
    const replyAt = types.indexOf('state-captured');
    const snapAt = types.indexOf('fork-snapshot');
    expect(replyAt).toBeGreaterThanOrEqual(0);
    expect(snapAt).toBeGreaterThan(replyAt); // the slot row never waits on 8 MB
    const snap = rig.messages.find((m) => m.type === 'fork-snapshot');
    if (snap === undefined || snap.type !== 'fork-snapshot') throw new Error('no snapshot');
    expect(snap.requestId).toBe(1);
    expect(snap.bytes[5 * SECTOR_SIZE]).toBe(0x55);

    // A PEEK (no markSecondaryClean) posts no snapshot at all.
    rig.messages.length = 0;
    rig.host.handleMessage({ type: 'capture-state', requestId: 2, disks: 'reference' });
    await awaitCaptured(rig);
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.messages.some((m) => m.type === 'fork-snapshot')).toBe(false);
  });

  it('the store digest tracks acked epochs and excludes the carried delta (§7)', async () => {
    const rig = await boot({ imageBytes: haltImage() });
    workTheMachine(rig); // guest writes → the first capture mints an epoch

    rig.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
    const first = await awaitCaptured(rig);
    if (first.overlayEpoch == null) throw new Error('no epoch in capture 1');
    expect(first.storeDigest).toMatch(/^[0-9a-f]{64}$/);
    rig.messages.length = 0;

    // Idle repeat with the epoch still UNACKED: the capture re-mints
    // the same delta (fold-back), the mirror is unchanged — digest
    // identical.
    rig.host.handleMessage({ type: 'capture-state', requestId: 2, disks: 'reference' });
    const second = await awaitCaptured(rig);
    expect(second.storeDigest).toBe(first.storeDigest);
    if (second.overlayEpoch == null) throw new Error('no epoch in capture 2');
    rig.messages.length = 0;

    // Ack it (the store committed): the mirror advances, and the next
    // idle capture has NO epoch to carry — the digest now includes the
    // acked chunks instead of excluding them.
    rig.host.handleMessage({
      type: 'overlay-swept', epochId: second.overlayEpoch.epochId, ok: true,
    });
    rig.host.handleMessage({ type: 'capture-state', requestId: 3, disks: 'reference' });
    const third = await awaitCaptured(rig);
    expect(third.overlayEpoch).toBeNull();
    expect(third.storeDigest).not.toBe(first.storeDigest);
    rig.messages.length = 0;

    // New writes mint a fresh epoch; its indexes are excluded, so if
    // they cover exactly the acked chunks the digest can regress —
    // write a NEW chunk's sector so the digests must differ.
    rig.host.overlayDisk?.writeSector(1500, sector(0x99));
    rig.host.handleMessage({ type: 'capture-state', requestId: 4, disks: 'reference' });
    const fourth = await awaitCaptured(rig);
    expect(fourth.overlayEpoch).not.toBeNull();
    expect(fourth.storeDigest).toBe(third.storeDigest); // new chunk excluded, mirror unchanged
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
        reply.storeDigest === undefined) {
      throw new Error('reference capture reply incomplete');
    }
    // §7: reference captures never hash the image — no primarySha.
    expect(reply.primarySha).toBeUndefined();

    // Field fix #4: the capture posts NO overlay-sweep — its final
    // epoch rides the reply, for main to store slot-first.
    expect(collectedChunks(a)).toEqual([]);
    if (reply.overlayEpoch == null) throw new Error('no overlayEpoch in reply');
    expect(reply.overlayEpoch.chunks.length).toBeGreaterThan(0);

    // Main's happy path, simulated: the epoch reached the store AND
    // the slot row carries it (they always travel together since #4).
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
          storeDigest: reply.storeDigest,
          secondarySha: reply.secondarySha ?? null,
        },
        carriedPrimary: {
          chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
          fingerprint: bootFingerprint(a),
          chunks: reply.overlayEpoch.chunks,
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

  it('reference: a store missing an ACKED epoch refuses and cold-boots — honestly', async () => {
    const image = haltImage();
    const a = await boot({ imageBytes: new Uint8Array(image) });
    const fingerprint = bootFingerprint(a);
    workTheMachine(a);

    // Epoch 1 is acked — the worker's mirror (and the slot's digest)
    // now assume the store holds it.
    a.host.handleMessage({ type: 'capture-state', requestId: 3, disks: 'reference' });
    const first = await awaitCaptured(a);
    if (first.overlayEpoch == null) throw new Error('capture 1 carried no epoch');
    a.host.handleMessage({
      type: 'overlay-swept', epochId: first.overlayEpoch.epochId, ok: true,
    });

    a.host.overlayDisk?.writeSector(700, sector(0xe1));
    a.messages.length = 0;
    a.host.handleMessage({ type: 'capture-state', requestId: 4, disks: 'reference' });
    const reply = await awaitCaptured(a);
    if (reply.state === undefined || reply.capturedAt === undefined ||
        reply.storeDigest === undefined || reply.overlayEpoch == null) {
      throw new Error('capture 2 reply incomplete');
    }

    // The store lost the ACKED epoch (rows vanished) — only the
    // carried delta survives. The digest must refuse: the slot's
    // mirror view includes epoch 1, the store has nothing.
    const b = await boot({
      imageBytes: new Uint8Array(image),
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          storeDigest: reply.storeDigest,
          secondarySha: reply.secondarySha ?? null,
        },
        carriedPrimary: {
          chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
          fingerprint,
          chunks: reply.overlayEpoch.chunks,
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

describe('WorkerHost — the clone ghost (Phase 18 M3 field find)', () => {
  /** Minimal TAN hub: every member hears every other member. */
  function makeTanHub(): { join(): {
    postMessage(data: unknown): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
    close(): void;
  }; } {
    const members: Array<{ h: ((ev: { data: unknown }) => void) | null }> = [];
    return {
      join() {
        const slot: { h: ((ev: { data: unknown }) => void) | null } = { h: null };
        members.push(slot);
        return {
          postMessage(data: unknown) {
            for (const m of members) {
              if (m !== slot) m.h?.({ data });
            }
          },
          set onmessage(handler: ((ev: { data: unknown }) => void) | null) {
            slot.h = handler;
          },
          close() { /* hub members never leave in tests */ },
        };
      },
    };
  }

  it('an embedded restore leases its octet but never bridges onto the TAN', async () => {
    const hub = makeTanHub();
    const image = haltImage();

    const bootWithTan = async (config: BootConfig, octet: number): Promise<Rig> => {
      const messages: WorkerToMainMessage[] = [];
      const host = new WorkerHost({
        post: (m) => messages.push(m),
        autoRun: false,
        hostClock: new InMemoryHostClock(),
        tan: { channel: hub.join(), hostOctet: octet },
      });
      host.handleMessage({ type: 'boot', config });
      await host.whenIdle();
      return { host, messages };
    };

    // The original: normal boot, attached — this is mouse.
    const a = await bootWithTan({ imageBytes: new Uint8Array(image) }, 16);
    expect(a.host.tan?.lanAttached).toBe(true);
    const aIdentity = a.messages.find((m) => m.type === 'tan-identity');
    expect(aIdentity).toMatchObject({ hostOctet: 16 });
    expect(aIdentity && 'detached' in aIdentity ? aIdentity.detached : undefined)
      .toBeUndefined();

    a.host.runUntil(300);
    a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'embedded' });
    const reply = await awaitCaptured(a);
    if (reply.state === undefined || reply.capturedAt === undefined ||
        reply.primary === undefined) {
      throw new Error('capture reply incomplete');
    }

    // The clone: embedded restore. Its guest wears mouse's identity,
    // so the trunk must stay unplugged — attached, it answers for
    // mouse and RSTs mouse's connections (field, 2026-07-16: "telnet
    // from mouse to dog fails ... if close cat, mouse can telnet").
    const b = await bootWithTan({
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
    }, 17);
    expect(b.messages.find((m) => m.type === 'restore-result')).toMatchObject({ ok: true });
    expect(b.host.tan?.lanAttached).toBe(false);
    // The lease still ran (the octet is defended for the reboot), and
    // the identity message says so honestly.
    expect(b.messages.find((m) => m.type === 'tan-identity')).toMatchObject({
      hostOctet: 17,
      detached: true,
    });

    // A reboot of the clone tab rejoins normally (cold boot, no restore).
    b.host.handleMessage({ type: 'reset' });
    await b.host.whenIdle();
    b.host.handleMessage({ type: 'boot', config: { imageBytes: new Uint8Array(image) } });
    await b.host.whenIdle();
    expect(b.host.tan?.lanAttached).toBe(true);
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
        second.storeDigest === undefined || second.overlayEpoch == null) {
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
          storeDigest: second.storeDigest,
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
        reply.storeDigest === undefined ||
        reply.carriedSecondary === undefined) {
      throw new Error('capture reply incomplete');
    }
    expect(reply.carriedSecondary.map((s) => s.lba)).toEqual([7, 2048]);

    // Fix #8: the delta arrives pre-sliced; the fork write (whose
    // bytes ride the separate fork-snapshot message) never committed
    // — boot B gets the OLD fork bytes, and main's generation check
    // accepted the pair before offering the restore.
    const carriedSecondary = reply.carriedSecondary;
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
          storeDigest: reply.storeDigest,
          secondarySha: null, // fix #8: the generation pin lives main-side
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

  it('an epoch committed to the store but never acked is subsumed by the carried delta (§7)', async () => {
    const image = haltImage();
    const a = await boot({ imageBytes: new Uint8Array(image) });
    const fingerprint = bootFingerprint(a);
    workTheMachine(a);

    // Capture 1's epoch reaches the store, but the ACK is lost — the
    // worker folds it back (nack) while the rows sit committed. This
    // is the committed-but-unacked window the digest's exclusion rule
    // exists for.
    a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
    const first = await awaitCaptured(a);
    if (first.overlayEpoch == null) throw new Error('capture 1 carried no epoch');
    const committedRows = first.overlayEpoch.chunks;
    a.host.handleMessage({
      type: 'overlay-swept', epochId: first.overlayEpoch.epochId, ok: false,
    });

    // More writes, then capture 2 — its carried delta is a SUPERSET
    // of the unacked epoch (fold-back semantics).
    a.host.overlayDisk?.writeSector(2700, sector(0xf2));
    a.messages.length = 0;
    a.host.handleMessage({ type: 'capture-state', requestId: 2, disks: 'reference' });
    const second = await awaitCaptured(a);
    if (second.state === undefined || second.capturedAt === undefined ||
        second.storeDigest === undefined || second.overlayEpoch == null) {
      throw new Error('capture 2 reply incomplete');
    }
    const carriedIdx = new Set(second.overlayEpoch.chunks.map((c) => c.chunkIndex));
    for (const c of committedRows) expect(carriedIdx.has(c.chunkIndex)).toBe(true);

    // Boot with the store AHEAD of the mirror (it holds the unacked
    // rows) — the exclusion drops them on both sides, the fold's
    // carried layer overwrites them with capture-time bytes, resume
    // succeeds.
    const b = await boot({
      imageBytes: new Uint8Array(image),
      overlay: {
        chunks: committedRows,
        chunkSizeBytes: first.overlayEpoch.chunkSizeBytes,
        fingerprint,
      },
      restore: {
        state: second.state,
        capturedAt: second.capturedAt,
        expected: {
          storeDigest: second.storeDigest,
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
    a.host.runUntil(300);
    b.host.runUntil(300);
    expect(compareHosts(a.host, b.host)).toEqual([]);
  });

  it('a corrupt carried delta refuses and cold-boots', async () => {
    const image = haltImage();
    const a = await boot({ imageBytes: new Uint8Array(image) });
    workTheMachine(a);
    a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
    const reply = await awaitCaptured(a);
    if (reply.state === undefined || reply.capturedAt === undefined ||
        reply.storeDigest === undefined) {
      throw new Error('capture reply incomplete');
    }
    const b = await boot({
      imageBytes: new Uint8Array(image),
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          storeDigest: reply.storeDigest,
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
        reply.storeDigest === undefined || reply.overlayEpoch == null) {
      throw new Error('capture reply incomplete');
    }
    const b = await boot({
      imageBytes: new Uint8Array(image),
      restore: {
        state: reply.state,
        capturedAt: reply.capturedAt,
        expected: {
          storeDigest: reply.storeDigest,
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
