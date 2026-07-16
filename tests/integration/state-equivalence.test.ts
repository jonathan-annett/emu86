/**
 * Phase 18 M1 — the N/M equivalence harness (brief §1.6: LAW).
 *
 * The property under test, over a REAL ELKS boot:
 *
 *   run N steps → capture → restore into a fresh machine → M steps
 *     ≡  run N+M steps straight
 *
 * byte-compared over RAM, every device serialization, the CPU, the
 * clock, AND the disk image — with plain-loop compares that report
 * where the states diverge (the toEqual-on-MB lesson stands).
 *
 * Missing any one private field from any serialize pair produces rare
 * post-restore heisenbugs; this harness is the honest defense. The CPU
 * snapshot's interruptInhibit gap — 13 phases unnoticed — is the proof
 * it's needed.
 *
 * Determinism ground rules (why straight and restored runs can be
 * expected byte-identical at all): InMemoryHostClock (fixed wall time
 * for INT 1Ah + RTC), InMemoryDisk (sync, no wall-clock), no keyboard
 * input, UART TX to a capture array, NIC unplugged, and a stepping
 * loop whose every decision is a pure function of machine state — the
 * same convention traceRun uses (advance(1) per instruction, batched
 * halt-spin advances).
 *
 * Uses hd32-fat.img — committed in-tree — with the same /bootopts
 * patch as elks-hd-boot.test.ts (serial console, init=/bin/sh).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import {
  captureMachineState,
  restoreMachineState,
  type MachineState,
} from '../../src/machine/machine-state.js';
import { InMemoryDisk, WriteTrackingDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type {
  BootConfig,
  StateCapturedMessage,
  WorkerToMainMessage,
} from '../../src/browser/protocol.js';
import { diffBytes, diffStates } from '../state-diff.js';

const HD32_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-fat.img');

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

function buildBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 hd32 serial console build',
    'hma=kernel',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

/** Patched hd32-fat image bytes (fresh Buffer each call — machines must not share). */
function loadHdImageBytes(): Uint8Array {
  const original = readFileSync(HD32_PATH);
  const offset = original.indexOf(Buffer.from(BOOTOPTS_HEADER, 'ascii'));
  if (offset < 0) {
    throw new Error(`No /bootopts header found in ${HD32_PATH}`);
  }
  const modified = Buffer.from(original);
  buildBootopts().copy(modified, offset);
  return new Uint8Array(modified);
}

interface Rig {
  machine: IBMPCMachine;
  disk: WriteTrackingDisk;
  tx: number[];
}

function makeRig(diskContents: Uint8Array): Rig {
  const disk = new WriteTrackingDisk(
    new InMemoryDisk({ geometry: HD32_GEOMETRY, contents: diskContents }),
  );
  const tx: number[] = [];
  const machine = new IBMPCMachine({
    disk,
    diskClass: 'hard-disk',
    console: new InMemoryConsole(),
    hostClock: new InMemoryHostClock(),
    cyclesPerPitTick: 4,
    uartTransmit: (byte: number) => tx.push(byte),
  });
  machine.reset();
  return { machine, disk, tx };
}

/**
 * Execute exactly `n` instructions, deterministically. Every decision
 * is a function of machine state alone, so a straight run and a
 * restored run traverse identical sequences from identical states.
 * Halt-spins advance virtual time without counting as instructions
 * (traceRun's convention: 1000 cycles per spin).
 */
function stepN(m: IBMPCMachine, n: number): void {
  const cpu = m.cpu;
  let executed = 0;
  let haltSpins = 0;
  while (executed < n) {
    if (cpu.halted) {
      const ctrl = cpu.intCtrl;
      const can =
        ctrl.hasNMI() ||
        (ctrl.hasMaskable() && cpu.flags.IF && !cpu.interruptInhibit);
      if (!can) {
        if (++haltSpins > 100_000) {
          throw new Error(`stepN: halt-spin exhausted at ${executed}/${n} instructions`);
        }
        m.clock.advance(1000);
        continue;
      }
    }
    cpu.step();
    executed++;
    haltSpins = 0;
    m.clock.advance(1);
  }
}

/** Full state + disk comparison; returns human-readable differences. */
function diffRigs(a: Rig, b: Rig): string[] {
  const out = diffStates(captureMachineState(a.machine), captureMachineState(b.machine));
  out.push(...diffBytes('disk', a.disk.snapshot(), b.disk.snapshot()));
  return out;
}

function injectLine(m: IBMPCMachine, line: string): void {
  for (let i = 0; i < line.length; i++) {
    m.uart.injectByte(line.charCodeAt(i));
  }
}

describe('Phase 18 M1 — whole-machine state equivalence over a real ELKS boot', () => {
  it('early-boot checkpoint: capture at 500k, restored run ≡ straight run for 250k more', () => {
    const N = 500_000;
    const M = 250_000;
    const image = loadHdImageBytes();

    const a = makeRig(image);
    stepN(a.machine, N);
    const state: MachineState = captureMachineState(a.machine);

    // The restored machine gets a byte-copy of A's disk AT CAPTURE — a
    // snapshot is consistent only with its disks (brief §1.4; pairing
    // is the caller's job at this layer, D2 owns the M2 protocol form).
    const b = makeRig(a.disk.snapshot());
    restoreMachineState(b.machine, state);

    // Round-trip identity before a single instruction runs.
    expect(diffStates(captureMachineState(b.machine), state)).toEqual([]);

    stepN(a.machine, M);
    stepN(b.machine, M);
    expect(diffRigs(a, b)).toEqual([]);
  }, 60_000);

  it('post-prompt checkpoint: restored machine runs a live shell command byte-identically', () => {
    const N_BOOT = 16_000_000; // the elks-hd-boot precedent: prompt well within
    const M = 4_000_000;       // the precedent's phase-2 budget
    const image = loadHdImageBytes();

    const a = makeRig(image);
    stepN(a.machine, N_BOOT);
    const bootTx = String.fromCharCode(...a.tx);
    expect(bootTx).toContain('VFS: Mounted root device');
    expect(bootTx).toMatch(/# *$/); // /bin/sh prompt — the machine idles here

    const state = captureMachineState(a.machine);
    const b = makeRig(a.disk.snapshot());
    restoreMachineState(b.machine, state);
    expect(diffStates(captureMachineState(b.machine), state)).toEqual([]);

    // Same input, injected at the SAME machine state on both sides.
    // ≤ 16 bytes — the whole line must fit the 16550 RX FIFO in one
    // injection (longer lines overrun and drop the tail, on both
    // machines alike, and the command never completes).
    const txMarkA = a.tx.length;
    injectLine(a.machine, 'echo amber-ok\n');
    injectLine(b.machine, 'echo amber-ok\n');
    stepN(a.machine, M);
    stepN(b.machine, M);

    // The restored machine is alive: the shell ran the command.
    const tailA = String.fromCharCode(...a.tx.slice(txMarkA));
    const tailB = String.fromCharCode(...b.tx);
    expect(tailB).toContain('amber-ok');
    expect(tailB).toMatch(/# *$/); // back at the prompt
    // And it is the SAME machine: serial output byte-identical…
    expect(tailB).toBe(tailA);
    // …and every last bit of state + disk agrees.
    expect(diffRigs(a, b)).toEqual([]);
  }, 180_000);

  it('M2 protocol round trip: capture-state → BootConfig.restore ≡ the straight run', () => {
    // The same law, through the WORKER PROTOCOL: an embedded capture
    // posted by one WorkerHost, fed as BootConfig.restore to a fresh
    // one, continues in lockstep with the original — the acceptance
    // line "equivalence harness green across the protocol round trip".
    const N = 500_000;
    const M = 250_000;
    const image = loadHdImageBytes();

    const bootHost = async (
      config: BootConfig,
    ): Promise<{ host: WorkerHost; messages: WorkerToMainMessage[] }> => {
      const messages: WorkerToMainMessage[] = [];
      const host = new WorkerHost({
        post: (m) => messages.push(m),
        autoRun: false,
        hostClock: new InMemoryHostClock(),
      });
      host.handleMessage({ type: 'boot', config });
      await host.whenIdle();
      return { host, messages };
    };

    return (async () => {
      const a = await bootHost({ imageBytes: image, diskClass: 'hard-disk' });
      a.host.runUntil(N);

      a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'embedded' });
      let reply: StateCapturedMessage | undefined;
      for (let i = 0; i < 400 && reply === undefined; i++) {
        reply = a.messages.find(
          (m): m is StateCapturedMessage => m.type === 'state-captured',
        );
        if (reply === undefined) await new Promise((r) => setTimeout(r, 5));
      }
      if (reply?.state === undefined || reply.capturedAt === undefined || reply.primary === undefined) {
        throw new Error(`capture failed: ${reply?.reason ?? 'no reply'}`);
      }

      const b = await bootHost({
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
      const result = b.messages.find((m) => m.type === 'restore-result');
      expect(result).toMatchObject({ ok: true });

      a.host.runUntil(M);
      b.host.runUntil(M);
      if (a.host.machine === null || b.host.machine === null) {
        throw new Error('machine missing after run');
      }
      expect(
        diffStates(
          captureMachineState(a.host.machine),
          captureMachineState(b.host.machine),
        ),
      ).toEqual([]);
    })();
  }, 120_000);

  it('XMS M1/M2: a 4 MiB machine boots ELKS with INT15 XMS enabled', () => {
    // The XMS brief's acceptance seed: honest AH=88h + the AH=87h
    // block move + xms=int15/hma=off stamps → ELKS's xms_init takes
    // the INT15 path instead of "disabled, A20 error". The kernel
    // then runs its ext buffers ABOVE 1 MiB — the 64 K that used to
    // fall back into main RAM stays out of it.
    const image = new Uint8Array(
      readFileSync(resolve('reference/elks-images-hd', 'hd32-minix.img')),
    );
    return (async () => {
      const messages: WorkerToMainMessage[] = [];
      const tx: number[] = [];
      const host = new WorkerHost({
        post: (m) => {
          messages.push(m);
          if (m.type === 'tx') tx.push(...m.bytes);
        },
        autoRun: false,
        hostClock: new InMemoryHostClock(),
      });
      host.handleMessage({
        type: 'boot',
        config: {
          imageBytes: image,
          diskClass: 'hard-disk',
          memorySize: 4 * 1024 * 1024,
        },
      });
      await host.whenIdle();
      // xms_init runs early in kernel start — 3M instructions covers
      // it with margin (the mount lines land around there too).
      host.runUntil(3_000_000);
      const text = String.fromCharCode(...tx);
      expect(text).toContain('xms: 3072K');
      expect(text).toContain('int 15/1F');
      expect(text).not.toContain('A20 error');
      // The stamp did its job: no HMA kernel to auto-disable INT15.
      expect(text).not.toContain('disabled w/kernel HMA');
    })();
  }, 60_000);

  it('M2 REFERENCE round trip over ELKS with per-boot stamps (the field case)', () => {
    // Jonathan's field failure, as a regression test: an autologin boot
    // stamps the image through minix-fs (wall-clock mtimes, allocator
    // state), so a restore that re-derives the stamps can never hash to
    // the capture. Fix #3's law: boot deltas are seeded into the
    // overlay store and the reconstruction is PURE base + fold. This
    // test fails with 'restore-result ok:false' under the old scheme.
    //
    // Fixture: the RAW hd32-minix image — the worker must do its own
    // bootopts patch + M3 stamps, exactly the browser flow (the fat
    // helper above pre-patches bootopts, which would no-op the very
    // pipeline under test).
    const N = 500_000;
    const M = 250_000;
    const image = new Uint8Array(
      readFileSync(resolve('reference/elks-images-hd', 'hd32-minix.img')),
    );

    const bootHost = async (
      config: BootConfig,
    ): Promise<{ host: WorkerHost; messages: WorkerToMainMessage[] }> => {
      const messages: WorkerToMainMessage[] = [];
      const host = new WorkerHost({
        post: (m) => messages.push(m),
        autoRun: false,
        hostClock: new InMemoryHostClock(),
      });
      host.handleMessage({ type: 'boot', config });
      await host.whenIdle();
      return { host, messages };
    };

    return (async () => {
      const a = await bootHost({
        imageBytes: new Uint8Array(image),
        diskClass: 'hard-disk',
        autologin: 'user1',
        autoNet: true,
      });
      a.host.runUntil(N);

      a.host.handleMessage({ type: 'capture-state', requestId: 1, disks: 'reference' });
      let reply: StateCapturedMessage | undefined;
      for (let i = 0; i < 400 && reply === undefined; i++) {
        reply = a.messages.find(
          (m): m is StateCapturedMessage => m.type === 'state-captured',
        );
        if (reply === undefined) await new Promise((r) => setTimeout(r, 5));
      }
      if (reply?.state === undefined || reply.capturedAt === undefined ||
          reply.primarySha === undefined) {
        throw new Error(`capture failed: ${reply?.reason ?? 'no reply'}`);
      }
      expect(reply.referenceValid).toBe(true);

      // Main's role: the store accumulated every maintenance sweep,
      // and (field fix #4) the capture's own final epoch rides the
      // REPLY — main persists it after the slot row. Fold both here,
      // reply last (it is the newest).
      const chunkMap = new Map<number, { chunkIndex: number; bytes: Uint8Array }>();
      let chunkSizeBytes = 32 * 1024;
      let fingerprint = '';
      for (const m of a.messages) {
        if (m.type === 'overlay-sweep') {
          chunkSizeBytes = m.chunkSizeBytes;
          for (const c of m.chunks) chunkMap.set(c.chunkIndex, c);
        }
        if (m.type === 'overlay-identity') fingerprint = m.fingerprint;
      }
      if (reply.overlayEpoch != null) {
        chunkSizeBytes = reply.overlayEpoch.chunkSizeBytes;
        for (const c of reply.overlayEpoch.chunks) chunkMap.set(c.chunkIndex, c);
      }
      expect(chunkMap.size).toBeGreaterThan(0); // the stamps at minimum

      const b = await bootHost({
        imageBytes: new Uint8Array(image),
        diskClass: 'hard-disk',
        autologin: 'user1',
        autoNet: true,
        overlay: {
          chunks: [...chunkMap.values()],
          chunkSizeBytes,
          fingerprint,
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
      const result = b.messages.find((m) => m.type === 'restore-result');
      expect(result).toMatchObject({ ok: true });

      a.host.runUntil(M);
      b.host.runUntil(M);
      if (a.host.machine === null || b.host.machine === null) {
        throw new Error('machine missing after run');
      }
      expect(
        diffStates(
          captureMachineState(a.host.machine),
          captureMachineState(b.host.machine),
        ),
      ).toEqual([]);
    })();
  }, 120_000);
});
