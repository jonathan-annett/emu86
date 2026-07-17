/**
 * The tab→rack move dance (multi-PC brief M2).
 *
 * The mover talks to a fake rack over the synchronous hub; the deps
 * record every side effect in order, so the tests assert the dance's
 * CHOREOGRAPHY: freeze before capture, capture durable before the
 * request, navigation only after a matching ack — and every abort
 * path unfreezing the machine it froze.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADOPT_ACK_TIMEOUT_MS,
  mountMoveToRack,
  type AdoptRequestMsg,
  type MoveToRackDeps,
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
  deps: MoveToRackDeps;
  requests: AdoptRequestMsg[];
  rackSide: RackChannel;
  presence: boolean[];
  slotFresh: boolean;
}

function makeRig(hub: { join(): RackChannel }): Rig {
  const events: string[] = [];
  const requests: AdoptRequestMsg[] = [];
  const presence: boolean[] = [];
  const rackSide = hub.join();
  const rig: Rig = {
    events,
    requests,
    rackSide,
    presence,
    slotFresh: true,
    deps: {
      channel: hub.join(),
      onRackPresence: (p) => presence.push(p),
      freeze: () => events.push('freeze'),
      unfreeze: () => events.push('unfreeze'),
      settleResumeSlot: async () => {
        events.push('settle');
      },
      slotFreshSince: async () => rig.slotFresh,
      currentRecord: () => RECORD,
      currentName: () => 'mouse',
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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('mountMoveToRack', () => {
  it('probes at mount and surfaces rack presence', () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    let probed = 0;
    const prior = rig.rackSide.onmessage;
    rig.rackSide.onmessage = (ev) => {
      if ((ev.data as { rack?: string }).rack === 'probe') probed++;
      prior?.(ev);
    };
    const mover = mountMoveToRack(rig.deps);
    expect(mover.rackCount()).toBe(0);
    rig.rackSide.postMessage({ rack: 'here', rackId: 'rack-1' });
    expect(mover.rackCount()).toBe(1);
    expect(rig.presence).toEqual([true]);
  });

  it('runs the whole dance in order and navigates on ack', async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    rig.rackSide.onmessage = (ev) => {
      const data = ev.data as { rack?: string; nonce?: string };
      if (data.rack === 'adopt-request') {
        rig.requests.push(ev.data as AdoptRequestMsg);
        rig.rackSide.postMessage({ rack: 'adopt-ack', nonce: data.nonce, ok: true });
      }
    };
    const mover = mountMoveToRack(rig.deps);
    rig.rackSide.postMessage({ rack: 'here', rackId: 'rack-1' });

    await mover.requestMove();

    expect(rig.events).toEqual(['freeze', 'settle', 'clear', 'navigate:mouse']);
    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0]).toMatchObject({
      to: 'rack-1',
      record: RECORD,
      name: 'mouse',
    });
  });

  it('aborts unfrozen when the slot never became fresh', async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    rig.slotFresh = false;
    const mover = mountMoveToRack(rig.deps);
    rig.rackSide.postMessage({ rack: 'here', rackId: 'rack-1' });

    await mover.requestMove();

    expect(rig.events.slice(0, 3)).toEqual(['freeze', 'settle', 'unfreeze']);
    expect(rig.events[3]).toMatch(/^report:cannot move: this session has no resumable/);
    expect(rig.requests).toHaveLength(0); // the record never left the tab
  });

  it('aborts unfrozen when no ack arrives, and forgets that rack', async () => {
    const hub = makeHub();
    const rig = makeRig(hub); // rack side records requests, never acks
    const mover = mountMoveToRack(rig.deps);
    rig.rackSide.postMessage({ rack: 'here', rackId: 'rack-1' });

    const dance = mover.requestMove();
    await vi.advanceTimersByTimeAsync(ADOPT_ACK_TIMEOUT_MS + 1);
    await dance;

    expect(rig.events.slice(0, 3)).toEqual(['freeze', 'settle', 'unfreeze']);
    expect(rig.events[3]).toMatch(/^report:the rack did not answer/);
    expect(mover.rackCount()).toBe(0); // silent racks stop offering the button
    expect(rig.presence.at(-1)).toBe(false);
  });

  it('ignores an ack with a foreign nonce (someone else’s dance)', async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    rig.rackSide.onmessage = (ev) => {
      const data = ev.data as { rack?: string };
      if (data.rack === 'adopt-request') {
        rig.rackSide.postMessage({ rack: 'adopt-ack', nonce: 'not-ours', ok: true });
      }
    };
    const mover = mountMoveToRack(rig.deps);
    rig.rackSide.postMessage({ rack: 'here', rackId: 'rack-1' });

    const dance = mover.requestMove();
    await vi.advanceTimersByTimeAsync(ADOPT_ACK_TIMEOUT_MS + 1);
    await dance;

    expect(rig.events.at(-2)).toBe('unfreeze'); // timed out, not navigated
    expect(rig.events.some((e) => e.startsWith('navigate'))).toBe(false);
  });

  it('refuses to start with no rack known — and freezes nothing', async () => {
    const hub = makeHub();
    const rig = makeRig(hub);
    const mover = mountMoveToRack(rig.deps);
    await mover.requestMove();
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]).toMatch(/^report:no rack tab is open/);
  });
});
