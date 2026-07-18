/**
 * The rack adoption dance (multi-PC brief M2, inverted by §5g).
 *
 * The PC's presence mount talks to a fake rack over the synchronous
 * hub; the deps record every side effect in order, so the tests
 * assert the CHOREOGRAPHY: probe answered with the identity card,
 * invite → freeze before capture, capture durable before the
 * request, navigation only after a matching ack — and every abort
 * path unfreezing the machine it froze.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADOPT_ACK_TIMEOUT_MS,
  HANDOFF_MAILBOX_TTL_MS,
  claimHandoffMailbox,
  isHandoffReply,
  isHandoffRequest,
  mountPcPresence,
  writeHandoffMailbox,
  type AdoptRequestMsg,
  type PcPresenceDeps,
  type RackChannel,
} from '../../web/migrate.js';
import type { SessionState } from '../../web/session-store.js';

function makeHub(): { join(): RackChannel } {
  const members: RackChannel[] = [];
  return {
    join(): RackChannel {
      const member: RackChannel = {
        onmessage: null,
        postMessage(data: unknown) {
          for (const other of members) {
            if (other !== member) other.onmessage?.({ data });
          }
        },
      };
      members.push(member);
      return member;
    },
  };
}

const RECORD: SessionState = {
  sessionId: 'sess-1',
  tanHostOctet: 16,
  driveForkId: 'fork-1',
  pendingBlankKb: null,
  overlayId: 'ov-1',
  overlayResetPending: false,
  pendingRestoreStateId: null,
  pendingColdBoot: false,
};

interface Rig {
  events: string[];
  deps: PcPresenceDeps;
  requests: AdoptRequestMsg[];
  rackSide: RackChannel;
  slotFresh: boolean;
}

function makeRig(hub: { join(): RackChannel }): Rig {
  const events: string[] = [];
  const requests: AdoptRequestMsg[] = [];
  const rackSide = hub.join();
  const rig: Rig = {
    events,
    requests,
    rackSide,
    slotFresh: true,
    deps: {
      channel: hub.join(),
      sessionId: () => RECORD.sessionId,
      currentName: () => 'mouse',
      currentOctet: () => RECORD.tanHostOctet,
      machineState: () => 'running',
      freeze: () => events.push('freeze'),
      unfreeze: () => events.push('unfreeze'),
      settleResumeSlot: async () => {
        events.push('settle');
      },
      slotFreshSince: async () => rig.slotFresh,
      currentRecord: () => RECORD,
      clearOwnSession: () => events.push('clear'),
      report: (text) => events.push(`report:${text}`),
      navigateToMoved: (name) => events.push(`navigate:${name}`),
    },
  };
  rackSide.onmessage = (ev) => {
    const data = ev.data as { rack?: string };
    if (data.rack === 'adopt-request') requests.push(ev.data as AdoptRequestMsg);
  };
  return rig;
}

/** Let the invite-triggered async dance drain its microtasks. */
async function drain(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('mountPcPresence (§5g pull model)', () => {
  it('answers a probe with its identity card', () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    const cards: unknown[] = [];
    const prior = rig.rackSide.onmessage;
    rig.rackSide.onmessage = (ev) => {
      if ((ev.data as { rack?: string }).rack === 'pc-here') cards.push(ev.data);
      prior?.(ev);
    };
    mountPcPresence(rig.deps);
    rig.rackSide.postMessage({ rack: 'pc-probe' });
    expect(cards).toEqual([
      { rack: 'pc-here', sessionId: 'sess-1', name: 'mouse', octet: 16, state: 'running' },
    ]);
  });

  it('runs the whole dance on invite and navigates on ack', async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    rig.rackSide.onmessage = (ev) => {
      const data = ev.data as { rack?: string; nonce?: string };
      if (data.rack === 'adopt-request') {
        rig.requests.push(ev.data as AdoptRequestMsg);
        rig.rackSide.postMessage({ rack: 'adopt-ack', nonce: data.nonce, ok: true });
      }
    };
    mountPcPresence(rig.deps);
    rig.rackSide.postMessage({ rack: 'adopt-invite', toSession: 'sess-1', rackId: 'rack-1' });
    await drain();

    expect(rig.events).toEqual(['freeze', 'settle', 'clear', 'navigate:mouse']);
    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0]).toMatchObject({
      to: 'rack-1',
      record: RECORD,
      name: 'mouse',
    });
  });

  it("ignores an invite addressed to someone else's session", async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    mountPcPresence(rig.deps);
    rig.rackSide.postMessage({ rack: 'adopt-invite', toSession: 'sess-other', rackId: 'rack-1' });
    await drain();
    expect(rig.events).toEqual([]); // froze nothing, told nobody
  });

  it('ignores a second invite while a move is in flight (one freeze)', async () => {
    const hub = makeHub();
    const rig = makeRig(hub); // rack side records requests, never acks
    const presence = mountPcPresence(rig.deps);
    rig.rackSide.postMessage({ rack: 'adopt-invite', toSession: 'sess-1', rackId: 'rack-1' });
    await drain();
    expect(presence.moving()).toBe(true);
    rig.rackSide.postMessage({ rack: 'adopt-invite', toSession: 'sess-1', rackId: 'rack-2' });
    await vi.advanceTimersByTimeAsync(ADOPT_ACK_TIMEOUT_MS + 1);

    expect(rig.events.filter((e) => e === 'freeze')).toHaveLength(1);
    expect(rig.requests.map((r) => r.to)).toEqual(['rack-1']); // rack-2 never entered
    expect(presence.moving()).toBe(false); // and the PC is invitable again
  });

  it('aborts unfrozen when the slot never became fresh', async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    rig.slotFresh = false;
    mountPcPresence(rig.deps);
    rig.rackSide.postMessage({ rack: 'adopt-invite', toSession: 'sess-1', rackId: 'rack-1' });
    await drain();

    expect(rig.events.slice(0, 3)).toEqual(['freeze', 'settle', 'unfreeze']);
    expect(rig.events[3]).toMatch(/^report:cannot move: this session has no resumable/);
    expect(rig.requests).toHaveLength(0); // the record never left the tab
  });

  it('aborts unfrozen when no ack arrives', async () => {
    const hub = makeHub();
    const rig = makeRig(hub); // rack side records requests, never acks
    mountPcPresence(rig.deps);
    rig.rackSide.postMessage({ rack: 'adopt-invite', toSession: 'sess-1', rackId: 'rack-1' });
    await vi.advanceTimersByTimeAsync(ADOPT_ACK_TIMEOUT_MS + 1);

    expect(rig.events.slice(0, 3)).toEqual(['freeze', 'settle', 'unfreeze']);
    expect(rig.events[3]).toMatch(/^report:the rack did not answer/);
  });

  it('ignores an ack with a foreign nonce (someone else\u2019s dance)', async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    rig.rackSide.onmessage = (ev) => {
      const data = ev.data as { rack?: string };
      if (data.rack === 'adopt-request') {
        rig.rackSide.postMessage({ rack: 'adopt-ack', nonce: 'not-ours', ok: true });
      }
    };
    mountPcPresence(rig.deps);
    rig.rackSide.postMessage({ rack: 'adopt-invite', toSession: 'sess-1', rackId: 'rack-1' });
    await vi.advanceTimersByTimeAsync(ADOPT_ACK_TIMEOUT_MS + 1);

    expect(rig.events.at(-2)).toBe('unfreeze'); // timed out, not navigated
    expect(rig.events.some((e) => e.startsWith('navigate'))).toBe(false);
  });

  it('retired-era rack verbs fall through ignored', async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    mountPcPresence(rig.deps);
    rig.rackSide.postMessage({ rack: 'here', rackId: 'rack-old' });
    rig.rackSide.postMessage({ rack: 'probe' });
    await drain();
    expect(rig.events).toEqual([]); // archived builds' chatter is inert
  });
});

// ---- the out-move's shared pieces (brief §5d) --------------------------

describe('handoff message guards', () => {
  it('recognises exactly the handoff shapes', () => {
    expect(isHandoffRequest({ emu86: 'handoff', requestId: 3 })).toBe(true);
    expect(isHandoffRequest({ emu86: 'handoff' })).toBe(false); // no id
    expect(isHandoffRequest({ emu86: 'focus' })).toBe(false);
    expect(isHandoffRequest(null)).toBe(false);
    expect(isHandoffRequest('handoff')).toBe(false);

    expect(isHandoffReply({ emu86: 'handoff-ready', requestId: 1, record: RECORD, name: 'mouse' })).toBe(true);
    expect(isHandoffReply({ emu86: 'handoff-refused', requestId: 1, error: 'nope' })).toBe(true);
    expect(isHandoffReply({ emu86: 'handoff-ready' })).toBe(false); // no id
    expect(isHandoffReply({ emu86: 'pc-status', requestId: 1 })).toBe(false);
    expect(isHandoffReply(null)).toBe(false);
  });
});

describe('handoff mailbox (the record carrier to the spawned context)', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('round-trips a parked record, one-shot', () => {
    writeHandoffMailbox({ nonce: 'n1', pcId: 'pc-a', record: RECORD, at: 1_000 });
    const box = claimHandoffMailbox('n1', 1_500);
    expect(box).not.toBeNull();
    expect(box?.pcId).toBe('pc-a');
    expect(box?.record).toEqual(RECORD);
    // One-shot: the row is gone whatever happens next.
    expect(claimHandoffMailbox('n1', 1_600)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('refuses a nonce mismatch — and still burns the row', () => {
    writeHandoffMailbox({ nonce: 'n1', pcId: 'pc-a', record: RECORD, at: 1_000 });
    expect(claimHandoffMailbox('other', 1_100)).toBeNull();
    expect(store.size).toBe(0); // a mismatched row is another move's garbage
  });

  it('refuses a stale mailbox — a wreck from an interrupted move', () => {
    writeHandoffMailbox({ nonce: 'n1', pcId: 'pc-a', record: RECORD, at: 1_000 });
    expect(claimHandoffMailbox('n1', 1_000 + HANDOFF_MAILBOX_TTL_MS + 1)).toBeNull();
  });

  it('survives an empty or corrupt mailbox', () => {
    expect(claimHandoffMailbox('n1', 0)).toBeNull();
    store.set('emu86.handoff.v1', 'not json');
    expect(claimHandoffMailbox('n1', 0)).toBeNull();
    store.set('emu86.handoff.v1', JSON.stringify({ nonce: 'n1', pcId: 42, record: RECORD, at: 0 }));
    expect(claimHandoffMailbox('n1', 0)).toBeNull();
  });
});
