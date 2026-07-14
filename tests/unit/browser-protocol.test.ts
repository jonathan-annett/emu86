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
      case 'control-response': return 'control-response';
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
      case 'control-request': return 'control-request';
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
  });
});
