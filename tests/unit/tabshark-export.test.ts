/**
 * tab-shark's diagnostic export (TAN-freeze brief §7) — the zip
 * container, the pcap writer, the ANSI stripper, and the assembly
 * over a fake state source. The zip test includes a from-spec reader
 * so the container is verified structurally, not by faith.
 */

import { describe, expect, it } from 'vitest';
import { buildZip, crc32, type ZipEntry } from '../../web/zip.js';
import {
  assembleExport,
  buildPcap,
  stripAnsi,
  type StateSource,
} from '../../web/tabshark-export.js';
import {
  MACHINE_STATE_SCHEMA_VERSION,
  type MachineStateMeta,
  type MachineStateRecord,
} from '../../web/machine-store.js';
import type { MachineState } from '../../src/browser/protocol.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- zip -------------------------------------------------------------

/** Just enough of a ZIP reader (from APPNOTE) to verify our writer. */
function readZip(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End record: search back for PK\5\6.
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('no end record');
  const count = view.getUint16(end + 10, true);
  let dir = view.getUint32(end + 16, true);
  const out: Array<{ name: string; data: Uint8Array }> = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(dir, true) !== 0x02014b50) throw new Error('bad central header');
    const nameLen = view.getUint16(dir + 28, true);
    const extraLen = view.getUint16(dir + 30, true);
    const commentLen = view.getUint16(dir + 32, true);
    const size = view.getUint32(dir + 24, true);
    const crc = view.getUint32(dir + 16, true);
    const localOff = view.getUint32(dir + 42, true);
    const name = dec.decode(bytes.subarray(dir + 46, dir + 46 + nameLen));
    // Local header → data.
    if (view.getUint32(localOff, true) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);
    out.push({ name, data: new Uint8Array(data) });
    dir += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('buildZip', () => {
  it('computes the standard CRC-32 check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips entries through a from-spec reader', () => {
    const entries: ZipEntry[] = [
      { name: 'events.json', bytes: enc.encode('{"a":1}') },
      { name: 'states/x/terminal.bin', bytes: new Uint8Array([0, 1, 2, 0x1b, 255]) },
      { name: 'empty.txt', bytes: new Uint8Array(0) },
    ];
    const zip = buildZip(entries, new Date(2026, 6, 18, 12, 34, 56));
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (let i = 0; i < entries.length; i++) {
      expect(back[i]?.data).toEqual(entries[i]?.bytes);
    }
  });
});

// ---- pcap ------------------------------------------------------------

describe('buildPcap', () => {
  it('writes the classic header and per-frame records', () => {
    const frame = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const pcap = buildPcap([{ tMs: 1_752_800_000_123, bytes: frame }]);
    const view = new DataView(pcap.buffer);
    expect(view.getUint32(0, true)).toBe(0xa1b2c3d4);
    expect(view.getUint32(20, true)).toBe(1); // LINKTYPE_ETHERNET
    expect(view.getUint32(24, true)).toBe(1_752_800_000); // seconds
    expect(view.getUint32(28, true)).toBe(123_000); // microseconds
    expect(view.getUint32(32, true)).toBe(3); // incl_len
    expect(pcap.subarray(40)).toEqual(frame);
    expect(pcap.length).toBe(24 + 16 + 3);
  });
});

// ---- ansi strip ------------------------------------------------------

describe('stripAnsi', () => {
  it('drops escapes, keeps prose, normalizes CR', () => {
    const raw = enc.encode(
      '\x1b[2J\x1b[?25llogin: \x1b[1;32muser1\x1b[0m\r\nmouse# ls\r\nhello.c\r\n',
    );
    expect(stripAnsi(raw)).toBe('login: user1\nmouse# ls\nhello.c\n');
  });
});

// ---- assembly --------------------------------------------------------

function tinyState(): MachineState {
  // Structural minimum for the payload type; the export never reads it.
  const pitChannel = (): MachineState['pit']['channels'][0] => ({
    mode: 0, accessMode: 'lobyte', bcd: false, divisor: 0x10000, counter: 0,
    output: false, gate: true, programmed: false, latchedCount: null,
    latchedStatus: null, writeFlipflop: 'awaitingLow', readFlipflop: 'awaitingLow',
    pendingDivisorLow: 0, mode0Fired: false, mode3HighTicks: 0, mode3LowTicks: 0,
    mode3PhaseTick: 0, pendingDivisor: null,
  });
  return {
    v: 1,
    ram: { v: 1, pageSize: 4096, pages: [] },
    cpu: {
      regs: { gp: new Uint16Array(8), seg: new Uint16Array(4), ip: 0 },
      flags: 0xf202, halted: false, segOverride: null, interruptInhibit: false,
    },
    intCtrl: { v: 1, queue: [], nmiPending: false },
    pic: {
      v: 1, irr: 0, isr: 0, imr: 0xff, vectorBase: 8,
      initState: 'idle', expectIcw3: false, expectIcw4: false,
      levelTriggered: false, readSelector: 'irr',
    },
    pit: { v: 1, cyclesAccumulated: 0, channels: [pitChannel(), pitChannel(), pitChannel()] },
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
      v: 1, cr: 0x21, isr: 0, imr: 0, dcr: 0, tcr: 0, rcr: 0, rsr: 0, tsr: 0,
      pstart: 0, pstop: 0, bnry: 0, curr: 0, tpsr: 0, tbcr: 0, rsar: 0, rbcr: 0,
      par: new Uint8Array(6), mar: new Uint8Array(8),
      prom: new Uint8Array(32), ram: new Uint8Array(0),
      remoteMode: 'idle', dmaAddr: 0, dmaRemaining: 0, irqLevel: false,
      rxAccepted: 0, rxDropped: 0, irqEdges: 0,
    },
    clockCycles: 0,
  };
}

function meta(stateId: string, kind: MachineStateMeta['kind']): MachineStateMeta {
  return {
    stateId, label: null, kind, createdAt: 1000, lastTouched: 1000,
    baseFingerprint: null, schemaVersion: MACHINE_STATE_SCHEMA_VERSION,
    sizeBytes: 1,
  };
}

describe('assembleExport', () => {
  it('bundles events, pcap, and terminal snapshots per state', async () => {
    const tail = enc.encode('\x1b[?25lmouse# invaders\r\n');
    const withTerminal: MachineStateRecord = {
      meta: meta('resume-abc', 'resume'),
      payload: {
        stateId: 'resume-abc', state: tinyState(), capturedAt: 999,
        primary: null, secondary: null, primarySha: null, secondarySha: null,
        storeDigest: 'digest-1',
        terminal: { tail, viewportY: 3, modes: [{ mode: 25, set: false }] },
      },
    };
    const bare: MachineStateRecord = {
      meta: meta('named-x', 'named'),
      payload: {
        stateId: 'named-x', state: tinyState(), capturedAt: 500,
        primary: null, secondary: null, primarySha: null, secondarySha: null,
      },
    };
    const source: StateSource = {
      listMeta: async () => [withTerminal.meta, bare.meta],
      getState: async (id) =>
        id === 'resume-abc' ? withTerminal : id === 'named-x' ? bare : null,
    };

    const entries = await assembleExport({
      build: 'test-build', framesSeen: 2, bytesSeen: 128,
      members: [16, 17], frozenOctets: [17],
      flows: [{ octetA: 16, portA: 1024, octetB: 17, portB: 23 }],
      frameLog: ['12:00:00.000  mouse:1024 → cat:23 [ACK] len=1'],
      eventLog: ['12:00:00.001  [mouse] resume slot captured'],
      frames: [{ tMs: 1000, bytes: new Uint8Array([1, 2]) }],
      states: source,
    });

    const names = entries.map((e) => e.name);
    expect(names).toContain('events.json');
    expect(names).toContain('frames.pcap');
    expect(names).toContain('states/states.json');
    expect(names).toContain('states/resume-abc/terminal.bin');
    expect(names).toContain('states/resume-abc/terminal.txt');
    expect(names.some((n) => n.startsWith('states/named-x/'))).toBe(false);

    const events = JSON.parse(
      dec.decode(entries.find((e) => e.name === 'events.json')?.bytes),
    ) as { build: string; members: number[]; frozenOctets: number[] };
    expect(events.build).toBe('test-build');
    expect(events.members).toEqual([16, 17]);
    expect(events.frozenOctets).toEqual([17]);

    const states = JSON.parse(
      dec.decode(entries.find((e) => e.name === 'states/states.json')?.bytes),
    ) as Array<{ stateId: string; terminal: { tailBytes: number } | null; storeDigest?: string | null }>;
    expect(states[0]?.stateId).toBe('resume-abc');
    expect(states[0]?.terminal?.tailBytes).toBe(tail.byteLength);
    expect(states[0]?.storeDigest).toBe('digest-1');
    expect(states[1]?.terminal).toBeNull();

    const bin = entries.find((e) => e.name === 'states/resume-abc/terminal.bin');
    expect(bin?.bytes).toEqual(tail);
    const txt = dec.decode(
      entries.find((e) => e.name === 'states/resume-abc/terminal.txt')?.bytes,
    );
    expect(txt).toBe('mouse# invaders\n');
  });

  it('reports a broken state row instead of dying', async () => {
    const source: StateSource = {
      listMeta: async () => [meta('resume-broken', 'resume')],
      getState: async () => {
        throw new Error('idb detached');
      },
    };
    const entries = await assembleExport({
      build: 'b', framesSeen: 0, bytesSeen: 0, members: [], frozenOctets: [],
      flows: [], frameLog: [], eventLog: [], frames: [], states: source,
    });
    const states = JSON.parse(
      dec.decode(entries.find((e) => e.name === 'states/states.json')?.bytes),
    ) as Array<{ stateId?: string; error?: string }>;
    expect(states[0]?.error).toContain('idb detached');
  });
});
