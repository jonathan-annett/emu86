/**
 * tab-shark — the TAN's own network analyzer (TAN-freeze brief M3).
 *
 * A passive god-mode page: the TAN's BroadcastChannel is a bus, so
 * every inter-tab frame, lease claim, census reply, and freeze/thaw
 * control word is already visible to any same-origin listener. This
 * page subscribes read-only — it NEVER posts, never claims an octet,
 * boots no machine — and renders:
 *
 *   - a rolling decoded frame log (ARP, TCP with ports/flags/len,
 *     ICMP echo, anything else by ethertype/protocol number),
 *   - a live connection table (TanConntrack, reused verbatim from
 *     the trunk tap — fed here by the same frames),
 *   - the membership census and freeze/thaw events.
 *
 * Passive-by-construction is the page's one hard rule: a listener
 * that transmitted would perturb the network it observes (and a
 * `claim` from a machineless page would burn an octet).
 */

import { TanConntrack } from '../src/net/conntrack.js';
import { decodeFrame, octetName } from './tabshark-decode.js';
import { DEBUG_CHANNEL_NAME, type DebugTraceMsg } from './debug-log.js';
import { ETHERTYPE_IPV4, parseIpv4, type Ipv4 } from '../src/net/wire.js';
import { MachineStore } from './machine-store.js';
import { assembleExport, type CapturedFrame } from './tabshark-export.js';
import { buildZip } from './zip.js';

declare const __EMU86_BUILD__: string;

/** Same literal as web/worker.ts — the TAN's channel name. */
const TAN_CHANNEL_NAME = 'emu86-tan-v1';

/** Mirror of the worker's TAN_FREEZE_WAIT_MS — the ❄ chip's fallback
 *  clear when a thaw never arrives (a closed-forever tab). */
const FREEZE_CHIP_FALLBACK_MS = 10_000;

const FRAME_LOG_CAP = 400;
const EVENT_LOG_CAP = 500; // debug traces are chatty on purpose
/** Raw frames kept for the pcap export — bytes, not just decodes. */
const RAW_FRAME_CAP = 2000;

// ---- state ----------------------------------------------------------

const conntrack = new TanConntrack();
const frameLines: string[] = [];
const eventLines: string[] = [];
const rawFrames: CapturedFrame[] = [];
const members = new Set<number>();
const frozen = new Map<number, number>(); // octet → chip-clear fallback deadline
let framesSeen = 0;
let bytesSeen = 0;

// ---- rendering (rAF-throttled on a dirty flag) -----------------------

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`tab-shark: missing #${id}`);
  return el;
};
const frameLog = $('frame-log');
const connTable = $('conn-table');
const eventLog = $('event-log');
const censusEl = $('census');
const statsEl = $('stats');

let dirty = false;
function render(): void {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => {
    dirty = false;
    framedLogRender();
    connTable.textContent = connectionsText();
    eventLog.textContent = eventLines.join('\n');
    censusRender();
    statsEl.textContent =
      framesSeen === 0
        ? 'listening…'
        : `${framesSeen} frames · ${(bytesSeen / 1024).toFixed(1)} KiB`;
  });
}

function framedLogRender(): void {
  frameLog.textContent = frameLines.join('\n');
}

function censusRender(): void {
  censusEl.textContent = '';
  const now = performance.now();
  for (const octet of [...members].sort((a, b) => a - b)) {
    const chip = document.createElement('span');
    const deadline = frozen.get(octet);
    if (deadline !== undefined && now >= deadline) frozen.delete(octet);
    const isFrozen = frozen.has(octet);
    chip.className = isFrozen ? 'chip frozen' : 'chip';
    chip.textContent = `${isFrozen ? '❄ ' : ''}${octetName(octet)} (.${octet})`;
    censusEl.appendChild(chip);
  }
}

function connectionsText(): string {
  const flows = conntrack.flows();
  if (flows.length === 0) return '(none)';
  return flows
    .map((f) => {
      const arrow =
        f.initiator === null ? '↔' : f.initiator === f.octetA ? '→' : '←';
      return `${octetName(f.octetA)}:${f.portA} ${arrow} ${octetName(f.octetB)}:${f.portB}  ${f.state}`;
    })
    .join('\n');
}

// ---- logging ---------------------------------------------------------

function stamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function logFrame(text: string): void {
  frameLines.unshift(`${stamp()}  ${text}`);
  if (frameLines.length > FRAME_LOG_CAP) frameLines.length = FRAME_LOG_CAP;
}

function logEvent(text: string): void {
  eventLines.unshift(`${stamp()}  ${text}`);
  if (eventLines.length > EVENT_LOG_CAP) eventLines.length = EVENT_LOG_CAP;
}

/** Members learned from the data plane too — a tab whose claim
 *  predates this page still shows up from its traffic. */
function noteMemberIp(ip: Ipv4): void {
  const [a, b, c, o] = ip;
  if (a === 10 && b === 0 && c === 2 && o !== undefined && o > 3) members.add(o);
}

// ---- the read-only subscription --------------------------------------

const channel = new BroadcastChannel(TAN_CHANNEL_NAME);
channel.onmessage = (ev: MessageEvent<unknown>) => {
  const data = ev.data;
  if (typeof data !== 'object' || data === null || !('tan' in data)) return;
  const msg = data as { tan: unknown; octet?: unknown; bytes?: unknown };

  if (msg.tan === 'frame') {
    const bytes =
      msg.bytes instanceof Uint8Array
        ? msg.bytes
        : msg.bytes instanceof ArrayBuffer
          ? new Uint8Array(msg.bytes)
          : null;
    if (bytes === null) return;
    framesSeen++;
    bytesSeen += bytes.byteLength;
    rawFrames.push({ tMs: Date.now(), bytes: new Uint8Array(bytes) });
    if (rawFrames.length > RAW_FRAME_CAP) rawFrames.shift();
    conntrack.observe(bytes);
    if (bytes.length >= 34 && (((bytes[12] ?? 0) << 8) | (bytes[13] ?? 0)) === ETHERTYPE_IPV4) {
      const ip = parseIpv4(bytes.subarray(14));
      if (ip !== null) {
        noteMemberIp(ip.srcIp);
        noteMemberIp(ip.dstIp);
      }
    }
    logFrame(decodeFrame(bytes));
    render();
    return;
  }

  if (typeof msg.octet !== 'number' || !Number.isInteger(msg.octet)) return;
  const octet = msg.octet;
  if (msg.tan === 'claim' || msg.tan === 'here') {
    members.add(octet);
    if (msg.tan === 'claim') logEvent(`claim: ${octetName(octet)} takes .${octet}`);
    render();
    return;
  }
  if (msg.tan === 'freeze') {
    members.add(octet);
    frozen.set(octet, performance.now() + FREEZE_CHIP_FALLBACK_MS);
    logEvent(`freeze: ${octetName(octet)} is reloading — involved peers hold`);
    render();
    return;
  }
  if (msg.tan === 'thaw') {
    members.add(octet);
    frozen.delete(octet);
    logEvent(`thaw: ${octetName(octet)} is back`);
    render();
    return;
  }
};

// The debug trace (field ask 2026-07-17): every tab broadcasts its
// lifecycle — freezes, captures, restore outcomes, page lifecycle,
// every syslog line — on emu86-debug-v1. Rendered into the event log
// with the sender named, so a multi-tab bug leaves ONE merged story.
const debugChannel = new BroadcastChannel(DEBUG_CHANNEL_NAME);
debugChannel.onmessage = (ev: MessageEvent<unknown>) => {
  const d = ev.data as Partial<DebugTraceMsg> | null;
  if (typeof d !== 'object' || d === null || d.dbg !== 'trace') return;
  if (typeof d.text !== 'string') return;
  const octet = typeof d.octet === 'number' ? d.octet : null;
  if (octet !== null) members.add(octet); // traces feed the census too
  const who =
    typeof d.name === 'string' && d.name.length > 0
      ? d.name
      : octet !== null
        ? `.${octet}`
        : typeof d.pc === 'string'
          ? `pc:${d.pc.slice(0, 11)}`
          : '?';
  logEvent(`[${who}] ${d.text}`);
  render();
};

// The export (brief §7): one zip with events.json, frames.pcap, and
// every stored machine state's terminal snapshot — raw data for the
// analyst instead of pasted fragments.
const exportBtn = document.getElementById('export-zip') as HTMLButtonElement | null;
exportBtn?.addEventListener('click', () => {
  void (async () => {
    exportBtn.disabled = true;
    try {
      const entries = await assembleExport({
        build: __EMU86_BUILD__,
        framesSeen,
        bytesSeen,
        members: [...members].sort((a, b) => a - b),
        frozenOctets: [...frozen.keys()],
        flows: conntrack.flows(),
        frameLog: frameLines,
        eventLog: eventLines,
        frames: rawFrames,
        states: new MachineStore(),
      });
      const zip = buildZip(entries);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const url = URL.createObjectURL(
        new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `tabshark-${stamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      logEvent(`exported ${entries.length} files (${(zip.length / 1024).toFixed(0)} KiB zip)`);
    } catch (err) {
      logEvent(`export FAILED — ${String(err)}`);
    } finally {
      exportBtn.disabled = false;
      render();
    }
  })();
});

// The ❄ fallback needs an occasional repaint even with a silent wire.
setInterval(() => {
  if (frozen.size > 0) render();
}, 1000);
