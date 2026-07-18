/**
 * Type-level / shape tests for the browser worker protocol.
 *
 * The protocol is just a discriminated union, but the test exercises a few
 * shape guarantees that future edits could quietly break:
 *   - Discriminant `type` field is exhaustive on both directions.
 *   - Bytes ride as `Uint8Array` (not `ArrayBuffer` or `number[]`).
 *   - Optional fields (`stack`, `geometry`, `imageBytes`/`imageUrl`) round
 *     trip through `JSON.parse(JSON.stringify(...))` (postMessage's
 *     structured-clone semantics, modulo Uint8Array — clone preserves it).
 *
 * If a test ever fails here, the worker host or the main bootstrap will
 * have type errors at the call site too — these are belt-and-suspenders.
 */

import { describe, it, expect } from 'vitest';
import type {
  BootMessage,
  RxMessage,
  ResetMessage,
  ReadyMessage,
  TxMessage,
  HaltedMessage,
  ErrorMessage,
  MainToWorkerMessage,
  OverlaySweepMessage,
  WorkerToMainMessage,
} from '../../src/browser/protocol.js';

describe('browser protocol — message shapes', () => {
  it('Main→Worker discriminants cover boot/rx/reset', () => {
    const boot: BootMessage = {
      type: 'boot',
      config: { imageUrl: '/elks.img' },
    };
    const rx: RxMessage = {
      type: 'rx',
      bytes: new Uint8Array([0x65, 0x63, 0x68, 0x6f]),
    };
    const reset: ResetMessage = { type: 'reset' };
    const all: MainToWorkerMessage[] = [boot, rx, reset];
    expect(all.map((m) => m.type)).toEqual(['boot', 'rx', 'reset']);
  });

  it('Worker→Main discriminants cover ready/tx/halted/error', () => {
    const ready: ReadyMessage = { type: 'ready' };
    const tx: TxMessage = { type: 'tx', bytes: new Uint8Array([0x21]) };
    const halted: HaltedMessage = { type: 'halted', reason: 'instruction-limit' };
    const error: ErrorMessage = { type: 'error', message: 'kaboom' };
    const all: WorkerToMainMessage[] = [ready, tx, halted, error];
    expect(all.map((m) => m.type)).toEqual(['ready', 'tx', 'halted', 'error']);
  });

  it('boot config accepts either imageUrl or imageBytes', () => {
    const a: BootMessage = { type: 'boot', config: { imageUrl: '/img' } };
    const b: BootMessage = {
      type: 'boot',
      config: { imageBytes: new Uint8Array(512) },
    };
    expect(a.config.imageUrl).toBe('/img');
    expect(b.config.imageBytes?.length).toBe(512);
  });

  it('error message stack is optional', () => {
    const noStack: ErrorMessage = { type: 'error', message: 'x' };
    const withStack: ErrorMessage = {
      type: 'error',
      message: 'x',
      stack: 'Error: x\n    at foo:1:1',
    };
    expect(noStack.stack).toBeUndefined();
    expect(withStack.stack).toContain('foo');
  });

  it('TxMessage bytes survive structured-clone round-trip', () => {
    // structuredClone is the postMessage transport's actual semantics. We
    // assert here that Uint8Array passes byte-identically — the hot path
    // for terminal traffic.
    const original: TxMessage = {
      type: 'tx',
      bytes: new Uint8Array([0x1b, 0x5b, 0x33, 0x32, 0x6d]),
    };
    const cloned = structuredClone(original);
    expect(cloned.type).toBe('tx');
    expect(Array.from(cloned.bytes)).toEqual([0x1b, 0x5b, 0x33, 0x32, 0x6d]);
  });

  it('disk geometry is part of an optional override on boot config', () => {
    const m: BootMessage = {
      type: 'boot',
      config: {
        imageUrl: '/x',
        geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 },
      },
    };
    expect(m.config.geometry?.sectorsPerTrack).toBe(18);
  });

  it('boot config carries the overlay fold set (Phase 17 M2)', () => {
    const m: BootMessage = {
      type: 'boot',
      config: {
        imageUrl: '/x',
        overlay: {
          chunks: [{ chunkIndex: 1, bytes: new Uint8Array([7]) }],
          chunkSizeBytes: 32 * 1024,
          fingerprint: 'cd'.repeat(32),
        },
      },
    };
    const cloned = structuredClone(m);
    expect(cloned.config.overlay?.fingerprint).toBe('cd'.repeat(32));
    expect(cloned.config.overlay?.chunks[0]?.bytes[0]).toBe(7);
  });

  it('overlay-sweep chunks survive structured-clone round-trip (Phase 17 M1)', () => {
    // Small payloads on purpose — clone semantics are what's under
    // test, not throughput.
    const original: OverlaySweepMessage = {
      type: 'overlay-sweep',
      epochId: 42,
      chunkSizeBytes: 32 * 1024,
      chunks: [
        { chunkIndex: 3, bytes: new Uint8Array([1, 2, 3]) },
        { chunkIndex: 9, bytes: new Uint8Array([9]) },
      ],
    };
    const cloned = structuredClone(original);
    expect(cloned.epochId).toBe(42);
    expect(cloned.chunks.map((c) => c.chunkIndex)).toEqual([3, 9]);
    expect(cloned.chunks[0]?.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(cloned.chunks[0]?.bytes ?? [])).toEqual([1, 2, 3]);
  });
});

describe('browser protocol — exhaustiveness', () => {
  // The `assertNever` pattern surfaces missed cases at compile time. If
  // any test in this block stops compiling after an edit to the union,
  // a new variant was added without updating consumers.
  function describeMain(m: MainToWorkerMessage): string {
    switch (m.type) {
      case 'boot':  return 'boot';
      case 'rx':    return 'rx';
      case 'reset': return 'reset';
      case 'set-speed': return 'set-speed';
      case 'snapshot-secondary': return 'snapshot-secondary';
      case 'write-secondary': return 'write-secondary';
      case 'control-response': return 'control-response';
      case 'overlay-swept': return 'overlay-swept';
      case 'overlay-flush': return 'overlay-flush';
      case 'capture-state': return 'capture-state';
      case 'secondary-persisted': return 'secondary-persisted';
      case 'set-paused': return 'set-paused';
      case 'inspect-machine': return 'inspect-machine';
      default: {
        const _exhaustive: never = m;
        return _exhaustive;
      }
    }
  }

  function describeWorker(m: WorkerToMainMessage): string {
    switch (m.type) {
      case 'ready':  return 'ready';
      case 'tx':     return 'tx';
      case 'halted': return 'halted';
      case 'error':  return 'error';
      case 'tan-identity': return 'tan-identity';
      case 'stats': return 'stats';
      case 'secondary-snapshot': return 'secondary-snapshot';
      case 'secondary-written': return 'secondary-written';
      case 'control-request': return 'control-request';
      case 'overlay-sweep': return 'overlay-sweep';
      case 'overlay-identity': return 'overlay-identity';
      case 'state-captured': return 'state-captured';
      case 'restore-result': return 'restore-result';
      case 'machine-inspected': return 'machine-inspected';
      case 'tan-freeze': return 'tan-freeze';
      case 'tan-thaw': return 'tan-thaw';
      case 'fork-snapshot': return 'fork-snapshot';
      default: {
        const _exhaustive: never = m;
        return _exhaustive;
      }
    }
  }

  it('main→worker exhaustive switch covers every variant', () => {
    expect(describeMain({ type: 'reset' })).toBe('reset');
    expect(describeMain({ type: 'rx', bytes: new Uint8Array() })).toBe('rx');
    expect(describeMain({ type: 'boot', config: {} })).toBe('boot');
    expect(describeMain({ type: 'set-speed', mode: 'turbo' })).toBe('set-speed');
    // Phase 16 M3: the peek flag and the editor's wholesale write.
    expect(describeMain({ type: 'snapshot-secondary', keepDirty: true }))
      .toBe('snapshot-secondary');
    expect(describeMain({ type: 'write-secondary', bytes: new Uint8Array(512) }))
      .toBe('write-secondary');
    // Phase 17 M1: the overlay engine's ack and forced flush.
    expect(describeMain({ type: 'overlay-swept', epochId: 1, ok: true }))
      .toBe('overlay-swept');
    expect(describeMain({ type: 'overlay-swept', epochId: 2, ok: false, detail: 'idb' }))
      .toBe('overlay-swept');
    expect(describeMain({ type: 'overlay-flush' })).toBe('overlay-flush');
  });

  it('worker→main exhaustive switch covers every variant', () => {
    expect(describeWorker({ type: 'ready' })).toBe('ready');
    expect(describeWorker({ type: 'tx', bytes: new Uint8Array() })).toBe('tx');
    expect(describeWorker({ type: 'halted', reason: 'x' })).toBe('halted');
    expect(describeWorker({ type: 'error', message: 'x' })).toBe('error');
    expect(describeWorker({ type: 'tan-identity', hostOctet: 42 })).toBe('tan-identity');
    expect(
      describeWorker({
        type: 'stats',
        instrPerSec: 1,
        cyclesPerSec: 2,
        realTimeRatio: 0.5,
        mode: 'authentic',
        batch: 5000,
      }),
    ).toBe('stats');
    expect(describeWorker({ type: 'secondary-written', ok: true }))
      .toBe('secondary-written');
    expect(describeWorker({ type: 'secondary-written', ok: false, detail: 'no drive' }))
      .toBe('secondary-written');
    // Phase 17 M1: one swept overlay epoch.
    expect(
      describeWorker({
        type: 'overlay-sweep',
        epochId: 5,
        chunkSizeBytes: 32 * 1024,
        chunks: [{ chunkIndex: 0, bytes: new Uint8Array(8) }],
      }),
    ).toBe('overlay-sweep');
    // Phase 17 M2: the base identity report, every boot.
    expect(
      describeWorker({
        type: 'overlay-identity',
        fingerprint: 'ab'.repeat(32),
        applied: true,
        chunksOffered: 3,
      }),
    ).toBe('overlay-identity');
    // TAN-freeze M2: the network freeze surfacing.
    expect(
      describeWorker({
        type: 'tan-freeze',
        peerOctet: 16,
        peerName: 'mouse',
        connections: [{
          peerOctet: 16, peerName: 'mouse', localPort: 23, peerPort: 1024,
          state: 'established', outbound: false, expectFromPeer: null,
        }],
      }),
    ).toBe('tan-freeze');
    expect(
      describeWorker({
        type: 'tan-thaw', peerOctet: 16, peerName: 'mouse', outcome: 'returned',
      }),
    ).toBe('tan-thaw');
  });
});
