/**
 * tab-shark's diagnostic export (TAN-freeze brief §7 — field ask
 * 2026-07-17: "downloads a zip file with all the events in a format
 * you can analyze … better for you to have the raw data").
 *
 * One zip, assembled from three sources:
 *   - events.json — everything tab-shark saw: census, live flows,
 *     the decoded frame log and the event/trace log (timestamped);
 *   - frames.pcap — the raw frame ring in CLASSIC pcap
 *     (LINKTYPE_ETHERNET), readable by tcpdump/tshark or by hand;
 *   - states/… — every machine state in `emu86-machines` (IDB is
 *     origin-global, so this sees EVERY tab's resume slots and named
 *     saves): meta rows in states.json, and per state the stored
 *     terminal snapshot — terminal.bin (the raw TX tail the restore
 *     replays: byte-exact "screen memory") and terminal.txt (the
 *     same, escape-stripped for eyeballing).
 *
 * DOM-free on purpose; tabshark.ts owns the button and the Blob.
 */

import type { ZipEntry } from './zip.js';
import type { MachineStateMeta, MachineStateRecord } from './machine-store.js';

export interface CapturedFrame {
  /** Wall-clock ms at receipt. */
  tMs: number;
  bytes: Uint8Array;
}

/** Classic pcap (magic 0xa1b2c3d4, v2.4), LINKTYPE_ETHERNET. */
export function buildPcap(frames: readonly CapturedFrame[]): Uint8Array {
  let size = 24;
  for (const f of frames) size += 16 + f.bytes.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0xa1b2c3d4, true);
  view.setUint16(4, 2, true);   // major
  view.setUint16(6, 4, true);   // minor
  view.setUint32(8, 0, true);   // thiszone
  view.setUint32(12, 0, true);  // sigfigs
  view.setUint32(16, 65535, true); // snaplen
  view.setUint32(20, 1, true);  // LINKTYPE_ETHERNET
  let off = 24;
  for (const f of frames) {
    view.setUint32(off, Math.floor(f.tMs / 1000), true);
    view.setUint32(off + 4, Math.round((f.tMs % 1000) * 1000), true);
    view.setUint32(off + 8, f.bytes.length, true);
    view.setUint32(off + 12, f.bytes.length, true);
    out.set(f.bytes, off + 16);
    off += 16 + f.bytes.length;
  }
  return out;
}

/**
 * Escape-stripped, eyeball-readable text from a raw TX stream. CSI /
 * OSC / bare-ESC sequences drop; CR normalizes to LF (a terminal's
 * overwrite-line approximates to a new line in flat text).
 */
export function stripAnsi(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '') // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')        // CSI
    .replace(/\x1b./g, '')                             // other ESC pairs
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); // C0 controls (not newline/tab)
}

/** The subset of MachineStore the export needs — injectable. */
export interface StateSource {
  listMeta(): Promise<MachineStateMeta[]>;
  getState(stateId: string): Promise<MachineStateRecord | null>;
}

export interface ExportInputs {
  build: string;
  framesSeen: number;
  bytesSeen: number;
  members: readonly number[];
  frozenOctets: readonly number[];
  flows: unknown[];
  /** Formatted, timestamped lines, newest first (as rendered). */
  frameLog: readonly string[];
  eventLog: readonly string[];
  frames: readonly CapturedFrame[];
  states: StateSource;
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Assemble the full export as zip entries (the caller zips + saves). */
export async function assembleExport(inputs: ExportInputs): Promise<ZipEntry[]> {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];

  entries.push({
    name: 'events.json',
    bytes: encoder.encode(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          build: inputs.build,
          framesSeen: inputs.framesSeen,
          bytesSeen: inputs.bytesSeen,
          members: inputs.members,
          frozenOctets: inputs.frozenOctets,
          flows: inputs.flows,
          frameLog: inputs.frameLog,
          eventLog: inputs.eventLog,
        },
        null,
        2,
      ),
    ),
  });

  entries.push({ name: 'frames.pcap', bytes: buildPcap(inputs.frames) });

  // Machine states: meta always; terminal snapshots where present.
  const stateRows: unknown[] = [];
  try {
    const metas = (await inputs.states.listMeta()).sort(
      (a, b) => b.lastTouched - a.lastTouched,
    );
    for (const meta of metas) {
      let terminal: { tailBytes: number; viewportY: number; modes: unknown } | null = null;
      try {
        const rec = await inputs.states.getState(meta.stateId);
        const t = rec?.payload.terminal ?? null;
        if (t !== null && t !== undefined) {
          terminal = {
            tailBytes: t.tail.byteLength,
            viewportY: t.viewportY,
            modes: t.modes ?? null,
          };
          const dir = `states/${safeName(meta.stateId)}`;
          entries.push({ name: `${dir}/terminal.bin`, bytes: new Uint8Array(t.tail) });
          entries.push({
            name: `${dir}/terminal.txt`,
            bytes: encoder.encode(stripAnsi(t.tail)),
          });
        }
        stateRows.push({
          ...meta,
          capturedAt: rec?.payload.capturedAt ?? null,
          storeDigest: rec?.payload.storeDigest ?? null,
          primarySha: rec?.payload.primarySha ?? null,
          secondarySha: rec?.payload.secondarySha ?? null,
          hasEmbeddedPrimary: rec?.payload.primary != null,
          hasEmbeddedSecondary: rec?.payload.secondary != null,
          carriedPrimaryChunks: rec?.payload.carriedPrimary?.chunks.length ?? 0,
          carriedSecondarySectors: rec?.payload.carriedSecondary?.length ?? 0,
          terminal,
        });
      } catch (err) {
        stateRows.push({ ...meta, error: String(err) });
      }
    }
  } catch (err) {
    stateRows.push({ error: `listMeta failed: ${String(err)}` });
  }
  entries.push({
    name: 'states/states.json',
    bytes: encoder.encode(JSON.stringify(stateRows, null, 2)),
  });

  return entries;
}
