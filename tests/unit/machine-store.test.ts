/**
 * MachineStore — the `emu86-machines` IDB tenant (Phase 18 M2).
 *
 * Same fake-indexeddb harness as overlay-store.test.ts: a fresh
 * IDBFactory per test so nothing leaks between cases. Payloads here
 * are miniature MachineStates — the store treats them as opaque
 * structured-cloneables; fidelity is the worker-host round trip's
 * job, not this file's.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLONE_STATE_GC_MAX_AGE_MS,
  MACHINE_STATE_SCHEMA_VERSION,
  MachineStore,
  RESUME_SLOT_GC_MAX_AGE_MS,
  gcOrphanResumeSlots,
  gcStaleCloneStates,
  resumeSlotId,
  resumeSlotLockName,
  type MachineStateRecord,
} from '../../web/machine-store.js';
import type { MachineState } from '../../src/browser/protocol.js';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

/** Minimal structurally-valid MachineState for store round trips. */
function tinyState(): MachineState {
  return {
    v: 1,
    ram: { v: 1, pageSize: 4096, pages: [{ pageId: 1, bytes: new Uint8Array(4096).fill(7) }] },
    cpu: {
      regs: { gp: new Uint16Array(8), seg: new Uint16Array(4), ip: 0x100 },
      flags: 0xf202,
      halted: false,
      segOverride: null,
      interruptInhibit: false,
    },
    intCtrl: { v: 1, queue: [0x20], nmiPending: false },
    pic: {
      v: 1, irr: 0, isr: 0, imr: 0xff, vectorBase: 8,
      initState: 'idle', expectIcw3: false, expectIcw4: false,
      levelTriggered: false, readSelector: 'irr',
    },
    pit: {
      v: 1,
      cyclesAccumulated: 3,
      channels: [pitChannel(), pitChannel(), pitChannel()],
    },
    rtc: { v: 1, index: 0, cmos: new Uint8Array(128) },
    kbc: {
      v: 1, outputBuffer: 0, outputBufferFull: false, inputBufferFull: false,
      lastWriteWasCommand: false, nextDataWriteIs: 'keyboard',
      commandByte: 0x65, outputPort: 0x03, scancodeQueue: [],
    },
    uart: {
      v: 1, ier: 0, lcr: 0, mcr: 0, dll: 0, dlm: 0, scratch: 0,
      fifoEnabled: false, rxFifo: [], overrun: false,
      irqPending: false, pendingIIRSource: 0x01, thriArmed: false,
    },
    nic: {
      v: 1, cr: 0x21, isr: 0x80, imr: 0, dcr: 0, tcr: 0, rcr: 0, rsr: 0, tsr: 0,
      pstart: 0, pstop: 0, bnry: 0, curr: 0, tpsr: 0, tbcr: 0, rsar: 0, rbcr: 0,
      par: new Uint8Array(6), mar: new Uint8Array(8),
      prom: new Uint8Array(32), ram: new Uint8Array(16384),
      remoteMode: 'idle', dmaAddr: 0, dmaRemaining: 0, irqLevel: false,
      rxAccepted: 0, rxDropped: 0, irqEdges: 0,
    },
    clockCycles: 12345,
  };
}

function pitChannel(): MachineState['pit']['channels'][0] {
  return {
    mode: 0, accessMode: 'lobyte', bcd: false, divisor: 0x10000, counter: 0,
    output: false, gate: true, programmed: false, latchedCount: null,
    latchedStatus: null, writeFlipflop: 'awaitingLow', readFlipflop: 'awaitingLow',
    pendingDivisorLow: 0, mode0Fired: false, mode3HighTicks: 0, mode3LowTicks: 0,
    mode3PhaseTick: 0, pendingDivisor: null,
  };
}

function record(
  stateId: string,
  kind: 'named' | 'resume' | 'clone',
  lastTouched: number,
): MachineStateRecord {
  return {
    meta: {
      stateId,
      label: kind === 'named' ? 'test save' : null,
      kind,
      createdAt: lastTouched,
      lastTouched,
      baseFingerprint: 'abc123',
      schemaVersion: MACHINE_STATE_SCHEMA_VERSION,
      sizeBytes: 4096,
    },
    payload: {
      stateId,
      state: tinyState(),
      capturedAt: lastTouched,
      primary: kind === 'named'
        ? {
            gz: new Uint8Array([31, 139, 8, 0]),
            geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 },
            diskClass: 'floppy',
          }
        : null,
      secondary: null,
      primarySha: 'aa'.repeat(32),
      secondarySha: null,
    },
  };
}

describe('MachineStore', () => {
  it('round-trips meta + payload, including the typed-array state', async () => {
    const store = new MachineStore();
    await store.putState(record('named-1', 'named', 1000));
    const rec = await store.getState('named-1');
    expect(rec).not.toBeNull();
    expect(rec?.meta.label).toBe('test save');
    expect(rec?.meta.schemaVersion).toBe(MACHINE_STATE_SCHEMA_VERSION);
    expect(rec?.payload.state.clockCycles).toBe(12345);
    expect(rec?.payload.state.ram.pages[0]?.bytes).toBeInstanceOf(Uint8Array);
    expect(rec?.payload.state.ram.pages[0]?.bytes[5]).toBe(7);
    expect(rec?.payload.state.cpu.regs.gp).toBeInstanceOf(Uint16Array);
    expect(rec?.payload.primary?.gz[0]).toBe(31);
  });

  it('getState is null when either row is missing; delete removes both', async () => {
    const store = new MachineStore();
    expect(await store.getState('nope')).toBeNull();
    await store.putState(record('named-2', 'named', 1000));
    await store.deleteState('named-2');
    expect(await store.getState('named-2')).toBeNull();
    expect(await store.listMeta()).toHaveLength(0);
  });

  it('overwrite keeps createdAt (slot identity) but refreshes the payload', async () => {
    const store = new MachineStore();
    const slot = resumeSlotId('tab-1');
    await store.putState(record(slot, 'resume', 1_000));
    const second = record(slot, 'resume', 2_000);
    await store.putState(second);
    const rec = await store.getState(slot);
    expect(rec?.meta.createdAt).toBe(1_000);
    expect(rec?.meta.lastTouched).toBe(2_000);
    expect(rec?.payload.capturedAt).toBe(2_000);
    expect(await store.listMeta()).toHaveLength(1);
  });

  it('touch stamps lastTouched', async () => {
    const store = new MachineStore();
    await store.putState(record('named-3', 'named', 1_000));
    await store.touch('named-3');
    const meta = await store.getMeta('named-3');
    expect(meta?.lastTouched).toBeGreaterThan(1_000);
  });
});

describe('gcOrphanResumeSlots', () => {
  function makeLocks(held: string[]): {
    supported: boolean;
    probeFree: (name: string) => Promise<boolean>;
  } {
    const heldSet = new Set(held);
    return {
      supported: true,
      probeFree: (name) => Promise.resolve(!heldSet.has(name)),
    };
  }

  it('sweeps stale unheld resume slots; keeps held, fresh, and named rows', async () => {
    const store = new MachineStore();
    const now = RESUME_SLOT_GC_MAX_AGE_MS * 3;
    const staleFree = resumeSlotId('dead-tab');
    const staleHeld = resumeSlotId('slow-tab');
    const fresh = resumeSlotId('live-tab');
    await store.putState(record(staleFree, 'resume', now - RESUME_SLOT_GC_MAX_AGE_MS - 1));
    await store.putState(record(staleHeld, 'resume', now - RESUME_SLOT_GC_MAX_AGE_MS - 1));
    await store.putState(record(fresh, 'resume', now - 1000));
    await store.putState(record('named-old', 'named', 0)); // ancient, never touched

    const deleted = await gcOrphanResumeSlots(
      store,
      makeLocks([resumeSlotLockName(staleHeld)]),
      now,
    );
    expect(deleted).toBe(1);
    const remaining = (await store.listMeta()).map((m) => m.stateId).sort();
    expect(remaining).toEqual([staleHeld, 'named-old', fresh].sort());
  });

  it('degraded mode (no Web Locks) sweeps nothing', async () => {
    const store = new MachineStore();
    await store.putState(record(resumeSlotId('x'), 'resume', 0));
    const deleted = await gcOrphanResumeSlots(
      store,
      { supported: false, probeFree: () => Promise.resolve(true) },
      RESUME_SLOT_GC_MAX_AGE_MS * 10,
    );
    expect(deleted).toBe(0);
    expect(await store.listMeta()).toHaveLength(1);
  });
});

describe('gcStaleCloneStates (Phase 18 M3)', () => {
  it('sweeps abandoned clone couriers; keeps fresh clones and other kinds', async () => {
    const store = new MachineStore();
    const now = CLONE_STATE_GC_MAX_AGE_MS * 5;
    await store.putState(record('clone-dead-child', 'clone', now - CLONE_STATE_GC_MAX_AGE_MS - 1));
    await store.putState(record('clone-fresh-child', 'clone', now - 1_000));
    await store.putState(record('named-keep', 'named', 0)); // ancient, still kept
    await store.putState(record(resumeSlotId('keep'), 'resume', 0)); // not this GC's job

    const deleted = await gcStaleCloneStates(store, now);
    expect(deleted).toBe(1);
    const remaining = (await store.listMeta()).map((m) => m.stateId).sort();
    expect(remaining).toEqual(['clone-fresh-child', 'named-keep', resumeSlotId('keep')].sort());
  });
});
