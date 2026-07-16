/**
 * Phase 18 M3 — the clone handshake (clone-session.ts).
 *
 * D3(a) over a fake broadcast bus: request → accepted → ready carries
 * only the stateId; every miss (no parent, failure, hang) resolves
 * null — the child's cold-boot fallback, never an exception. The bus
 * mirrors BroadcastChannel semantics: a poster does NOT hear itself.
 */

import { describe, expect, it } from 'vitest';
import {
  mountCloneParent,
  requestCloneState,
  type CloneChannelLike,
} from '../../web/clone-session.js';

type Handler = (ev: { data: unknown }) => void;

/** N endpoints on one bus; posts deliver to every OTHER endpoint, async. */
function makeBus(count: number): CloneChannelLike[] {
  const handlers: Array<Set<Handler>> = Array.from({ length: count }, () => new Set());
  return handlers.map((_, i) => ({
    postMessage(data: unknown) {
      queueMicrotask(() => {
        handlers.forEach((set, j) => {
          if (j === i) return; // BroadcastChannel: sender never hears itself
          for (const h of set) h({ data });
        });
      });
    },
    addEventListener(_type: 'message', h: Handler) {
      handlers[i]?.add(h);
    },
    removeEventListener(_type: 'message', h: Handler) {
      handlers[i]?.delete(h);
    },
  }));
}

const FAST = { acceptTimeoutMs: 50, readyTimeoutMs: 100 };

describe('clone handshake (Phase 18 M3, D3(a))', () => {
  it('happy path: request → accepted → ready resolves the stateId', async () => {
    const [childCh, parentCh] = makeBus(2);
    if (!childCh || !parentCh) throw new Error('bus');
    let acceptedSeen = false;
    mountCloneParent(parentCh, {
      sessionId: () => 'parent-1',
      saveCloneState: async (childId) => `clone-${childId}`,
    });
    const stateId = await requestCloneState(childCh, 'parent-1', 'child-1', {
      ...FAST,
      onAccepted: () => { acceptedSeen = true; },
    });
    expect(stateId).toBe('clone-child-1');
    expect(acceptedSeen).toBe(true);
  });

  it('no parent on the channel: null after the accept timeout', async () => {
    const [childCh] = makeBus(1);
    if (!childCh) throw new Error('bus');
    const t0 = Date.now();
    const stateId = await requestCloneState(childCh, 'parent-x', 'child-1', FAST);
    expect(stateId).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it('parent accepted but never delivers: null after the ready timeout', async () => {
    const [childCh, parentCh] = makeBus(2);
    if (!childCh || !parentCh) throw new Error('bus');
    mountCloneParent(parentCh, {
      sessionId: () => 'parent-1',
      saveCloneState: () => new Promise(() => { /* hangs forever */ }),
    });
    const stateId = await requestCloneState(childCh, 'parent-1', 'child-1', FAST);
    expect(stateId).toBeNull();
  });

  it('parent capture fails: clone-failed resolves null without waiting out the timeout', async () => {
    const [childCh, parentCh] = makeBus(2);
    if (!childCh || !parentCh) throw new Error('bus');
    let served: boolean | null = null;
    mountCloneParent(parentCh, {
      sessionId: () => 'parent-1',
      saveCloneState: async () => {
        throw new Error('no machine is running');
      },
      onServed: (_child, ok) => { served = ok; },
    });
    const t0 = Date.now();
    const stateId = await requestCloneState(childCh, 'parent-1', 'child-1', {
      acceptTimeoutMs: 50, readyTimeoutMs: 5_000,
    });
    expect(stateId).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000); // failed fast, not timed out
    expect(served).toBe(false);
  });

  it('requests naming another parent are ignored', async () => {
    const [childCh, parentCh] = makeBus(2);
    if (!childCh || !parentCh) throw new Error('bus');
    let captures = 0;
    mountCloneParent(parentCh, {
      sessionId: () => 'parent-OTHER',
      saveCloneState: async () => {
        captures++;
        return 'clone-x';
      },
    });
    const stateId = await requestCloneState(childCh, 'parent-1', 'child-1', FAST);
    expect(stateId).toBeNull();
    expect(captures).toBe(0);
  });

  it('two children are served one at a time, each getting its own row', async () => {
    const [child1, child2, parentCh] = makeBus(3);
    if (!child1 || !child2 || !parentCh) throw new Error('bus');
    const activeCaptures: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    mountCloneParent(parentCh, {
      sessionId: () => 'parent-1',
      saveCloneState: async (childId) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        activeCaptures.push(childId);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return `clone-${childId}`;
      },
    });
    const [a, b] = await Promise.all([
      requestCloneState(child1, 'parent-1', 'child-A', { acceptTimeoutMs: 200, readyTimeoutMs: 500 }),
      requestCloneState(child2, 'parent-1', 'child-B', { acceptTimeoutMs: 200, readyTimeoutMs: 500 }),
    ]);
    expect(a).toBe('clone-child-A');
    expect(b).toBe('clone-child-B');
    expect(maxConcurrent).toBe(1); // serialized — gzips never interleave
    expect(activeCaptures.sort()).toEqual(['child-A', 'child-B']);
  });

  it('a child ignores ready messages addressed to another child', async () => {
    const [childCh, otherCh] = makeBus(2);
    if (!childCh || !otherCh) throw new Error('bus');
    // A rogue "ready" for a different child must not resolve us.
    otherCh.postMessage({
      v: 1, type: 'clone-ready',
      parentSessionId: 'parent-1', childSessionId: 'someone-else',
      stateId: 'clone-wrong',
    });
    const stateId = await requestCloneState(childCh, 'parent-1', 'child-1', FAST);
    expect(stateId).toBeNull();
  });

  it('unmounting the parent stops it answering', async () => {
    const [childCh, parentCh] = makeBus(2);
    if (!childCh || !parentCh) throw new Error('bus');
    const unmount = mountCloneParent(parentCh, {
      sessionId: () => 'parent-1',
      saveCloneState: async () => 'clone-x',
    });
    unmount();
    const stateId = await requestCloneState(childCh, 'parent-1', 'child-1', FAST);
    expect(stateId).toBeNull();
  });
});
