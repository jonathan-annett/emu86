/**
 * The rack (multi-PC brief M1) — one tab, many machines.
 *
 * Explorer-style layout: a left rail of PC names, a pane showing the
 * selected machine. Each PC is the EXISTING app in an iframe at
 * `./?pc=<instanceId>` — the M0 session namespace gives every iframe
 * its own record inside the tab's shared sessionStorage, and
 * everything else already composes:
 *
 *   - BroadcastChannel is same-origin, so every embedded PC joins the
 *     TAN (and the freeze protocol, and the clone channel) unchanged;
 *   - iframes receive pagehide when the rack tab closes or reloads,
 *     so every PC runs its normal teardown capture — a rack F5 is N
 *     ordinary reload-resumes;
 *   - adopting a named save is just writing pendingRestoreStateId
 *     into the new instance's session record before the iframe
 *     boots — the app's own restore path does the rest.
 *
 * Hidden PCs keep running: display:none pauses nothing (workers are
 * threads; the paced loop yields on an unclamped MessageChannel).
 *
 * The rail persists in the rack's OWN session record (`emu86.rack.v1`
 * — the bare `emu86.session.v1` key stays untouched for a standalone
 * machine in this tab, which the rack deliberately never boots).
 */

import {
  MachineStore,
  resumeSlotId,
  resumeSlotLockName,
  type MachineStateMeta,
} from './machine-store.js';
import {
  loadSessionAt,
  saveSessionAt,
  storageKeyFor,
  type SessionState,
} from './session-store.js';
import { overlayLockName } from './overlay-session.js';
import { forkLockName } from './drive-session.js';
import {
  RACK_CHANNEL_NAME,
  isRackMsg,
  isHandoffReply,
  writeHandoffMailbox,
  type AdoptRequestMsg,
} from './migrate.js';
import { PackageStore, type RackPackageMember } from './package-store.js';
import { createDebugTrace } from './debug-log.js';

// The rack narrates too (debug trace, field ask 2026-07-17): adoption
// handshakes and lock waits are exactly the seams a migration bug
// hides in. Named 'rack' — it has no octet of its own.
const dbg = createDebugTrace(null);
dbg.setIdentity(null, 'rack');

/** iframe → rack status report (posted by embedded main.ts). */
interface PcStatusMsg {
  emu86: 'pc-status';
  pc: string;
  name: string | null;
  octet: number | null;
  state: 'booting' | 'running' | 'frozen' | 'halted';
}

function isPcStatusMsg(data: unknown): data is PcStatusMsg {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { emu86?: unknown }).emu86 === 'pc-status'
  );
}

interface RackPc {
  id: string;
  /** Last reported identity/status — display only. */
  name: string | null;
  octet: number | null;
  state: PcStatusMsg['state'];
}

interface RackState {
  pcs: Array<{ id: string }>;
  selected: string | null;
}

const RACK_KEY = 'emu86.rack.v1';

// ---- rack session (which PCs live here) ------------------------------

function loadRack(): RackState {
  try {
    const raw = sessionStorage.getItem(RACK_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed as { pcs?: unknown; selected?: unknown };
        if (Array.isArray(obj.pcs)) {
          const pcs = obj.pcs
            .filter((p): p is { id: string } =>
              typeof (p as { id?: unknown }).id === 'string')
            .map((p) => ({ id: p.id }));
          return {
            pcs,
            selected:
              typeof obj.selected === 'string' &&
              pcs.some((p) => p.id === obj.selected)
                ? obj.selected
                : pcs[0]?.id ?? null,
          };
        }
      }
    }
  } catch { /* fresh rack below */ }
  return { pcs: [], selected: null };
}

function persistRack(): void {
  try {
    sessionStorage.setItem(
      RACK_KEY,
      JSON.stringify({ pcs: pcs.map((p) => ({ id: p.id })), selected }),
    );
  } catch { /* a rack that won't stick still works this session */ }
}

// ---- state -----------------------------------------------------------

const machineStore = new MachineStore();
const packageStore = new PackageStore();
const pcs: RackPc[] = [];
const frames = new Map<string, HTMLIFrameElement>();
/** PCs floated to their own window (brief §5d): the WindowProxy we
 *  opened (the hand-back channel) and the pane placeholder. */
const floating = new Map<string, { win: Window; placeholder: HTMLDivElement }>();
let selected: string | null = null;

const rail = document.getElementById('rail') as HTMLDivElement;
const pane = document.getElementById('pane') as HTMLElement;
const emptyHint = document.getElementById('empty-hint') as HTMLDivElement;
const addBtn = document.getElementById('add-pc') as HTMLButtonElement;
const saveBtn = document.getElementById('save-rack') as HTMLButtonElement;
const noteEl = document.getElementById('rack-note') as HTMLDivElement;
const pickerBackdrop = document.getElementById('picker-backdrop') as HTMLDivElement;
const picker = document.getElementById('picker') as HTMLDivElement;

let noteTimer: ReturnType<typeof setTimeout> | null = null;
function note(text: string, sticky = false): void {
  dbg(text); // whatever the rack tells its user, it tells the wire
  noteEl.textContent = text;
  noteEl.hidden = false;
  if (noteTimer !== null) clearTimeout(noteTimer);
  noteTimer = sticky
    ? null
    : setTimeout(() => {
        noteEl.hidden = true;
      }, 6_000);
}

function mintPcId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `pc-${crypto.randomUUID()}`
    : `pc-${Math.random().toString(36).slice(2)}`;
}

// ---- PCs -------------------------------------------------------------

function spawnFrame(id: string): void {
  const iframe = document.createElement('iframe');
  iframe.src = `./?pc=${encodeURIComponent(id)}`;
  iframe.title = `PC ${id}`;
  iframe.style.display = 'none';
  frames.set(id, iframe);
  pane.appendChild(iframe);
}

function addPc(id: string, name: string | null = null): void {
  pcs.push({ id, name, octet: null, state: 'booting' });
  spawnFrame(id);
  select(id);
}

function select(id: string): void {
  selected = id;
  for (const [pcId, frame] of frames) {
    frame.style.display = pcId === id ? '' : 'none';
  }
  // A floated PC's pane slot is its placeholder (brief §5d).
  for (const [pcId, f] of floating) {
    f.placeholder.style.display = pcId === id ? '' : 'none';
  }
  emptyHint.style.display = pcs.length === 0 ? '' : 'none';
  persistRack();
  renderRail();
  // Focus the machine the user just picked: the iframe window first,
  // then the terminal inside it (field ask 2026-07-18 — window focus
  // alone leaves xterm's textarea unfocused). A floated PC's real
  // window comes forward instead.
  frames.get(id)?.contentWindow?.focus();
  postToPc(id, { emu86: 'focus' });
  const away = floating.get(id);
  if (away !== undefined && !away.win.closed) away.win.focus();
}

function renderRail(): void {
  rail.textContent = '';
  for (const pc of pcs) {
    const row = document.createElement('div');
    row.className = pc.id === selected ? 'pc-row selected' : 'pc-row';
    const dot = document.createElement('span');
    dot.className = `pc-dot ${pc.state}`;
    const name = document.createElement('span');
    name.className = 'pc-name';
    name.textContent = pc.name ?? 'booting…';
    const sub = document.createElement('span');
    sub.className = 'pc-sub';
    sub.textContent = pc.octet !== null ? `.${pc.octet}` : '';
    if (floating.has(pc.id)) {
      // Floated out (brief §5d): the only rail action is bring-back —
      // ⏻ and re-float wait until the machine is docked again.
      sub.textContent = `${sub.textContent} · in a window`;
      const back = document.createElement('button');
      back.className = 'pc-move';
      back.textContent = '⇱';
      back.title = 'bring this PC back into the rack';
      back.addEventListener('click', (e) => {
        e.stopPropagation();
        void bringBack(pc.id);
      });
      row.append(dot, name, sub, back);
    } else {
      const toTab = document.createElement('button');
      toTab.className = 'pc-move';
      toTab.textContent = '⇲';
      toTab.title = 'move this PC out to its own tab (it leaves the rack)';
      toTab.addEventListener('click', (e) => {
        e.stopPropagation();
        void moveOut(pc, 'tab');
      });
      const toWin = document.createElement('button');
      toWin.className = 'pc-move';
      toWin.textContent = '🗗';
      toWin.title = 'float this PC in its own window (it stays in the rack)';
      toWin.addEventListener('click', (e) => {
        e.stopPropagation();
        void moveOut(pc, 'window');
      });
      const off = document.createElement('button');
      off.className = 'pc-off';
      off.textContent = '⏻';
      off.title = 'turn off — removes this PC (unsaved machine state is lost; saved states and its drive fork persist)';
      off.addEventListener('click', (e) => {
        e.stopPropagation();
        powerOff(pc);
      });
      row.append(dot, name, sub, toTab, toWin, off);
    }
    row.addEventListener('click', () => select(pc.id));
    rail.appendChild(row);
  }
}

/**
 * Turn off a PC (field ask 2026-07-18 — the recorded eject wart).
 * Removing the iframe fires pagehide inside it, so the machine runs
 * its normal teardown (capture + TAN freeze if it had connections —
 * peers give up after the honest 10 s, since this one never returns).
 * Then the instance's records go: the namespaced session record and
 * its resume slot, proactively (the orphan GC would take a week).
 * Named saves and the drive fork persist — a fork with no owner is
 * the fork GC's business, exactly as with a closed tab.
 */
function powerOff(pc: RackPc): void {
  const label = pc.name ?? pc.id.slice(0, 11);
  if (!confirm(`Turn off ${label}? Unsaved machine state is lost (saved states and its drive fork persist).`)) {
    return;
  }
  const sessionId = loadSessionAt(pc.id).sessionId;
  frames.get(pc.id)?.remove();
  frames.delete(pc.id);
  const at = pcs.findIndex((p) => p.id === pc.id);
  if (at >= 0) pcs.splice(at, 1);
  try {
    sessionStorage.removeItem(storageKeyFor(pc.id));
  } catch { /* nothing to clean */ }
  void machineStore.deleteState(resumeSlotId(sessionId)).catch(() => { /* GC's backstop */ });
  if (selected === pc.id) {
    selected = pcs[0]?.id ?? null;
    if (selected !== null) select(selected);
  }
  emptyHint.style.display = pcs.length === 0 ? '' : 'none';
  persistRack();
  renderRail();
  note(`${label} turned off`);
}

// ---- the out-move (brief §5d): to a tab, or a floating window ---------
//
// Mirror of the M2 adoption with the requester reversed: the PC runs
// the same freeze → durable-capture → freshness-gate dance and hands
// its record over; only then does the rack kill its context and let
// the spawned window resume it. Never pagehide-and-pray.

let handoffSeq = 0;
const handoffWaiters = new Map<
  number,
  (reply:
    | { ok: true; record: SessionState; name: string | null }
    | { ok: false; error: string }) => void
>();

window.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (e.origin !== location.origin) return;
  if (!isHandoffReply(e.data)) return;
  const waiter = handoffWaiters.get(e.data.requestId);
  if (waiter === undefined) return;
  handoffWaiters.delete(e.data.requestId);
  if (e.data.emu86 === 'handoff-ready') {
    waiter({ ok: true, record: e.data.record, name: e.data.name });
  } else {
    waiter({ ok: false, error: e.data.error });
  }
});

/** A 640K capture can take a while — the M3 member-save number. */
const HANDOFF_TIMEOUT_MS = 30_000;

function requestHandoff(
  post: (data: unknown) => void,
): Promise<{ record: SessionState; name: string | null }> {
  return new Promise((resolve, reject) => {
    const requestId = ++handoffSeq;
    const timer = setTimeout(() => {
      handoffWaiters.delete(requestId);
      reject(new Error('the PC did not answer the handoff'));
    }, HANDOFF_TIMEOUT_MS);
    handoffWaiters.set(requestId, (reply) => {
      clearTimeout(timer);
      if (reply.ok) resolve({ record: reply.record, name: reply.name });
      else reject(new Error(reply.error));
    });
    post({ emu86: 'handoff', requestId });
  });
}

function mintNonce(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `n-${Math.random().toString(36).slice(2)}`;
}

async function moveOut(pc: RackPc, mode: 'tab' | 'window'): Promise<void> {
  const label = pc.name ?? pc.id.slice(0, 11);
  // The spawn window opens SYNCHRONOUSLY in the click — popup blockers
  // honor the gesture, not the async dance that follows. Named target
  // for the float, so a double-click can't fork two windows.
  const spawn = window.open(
    '',
    mode === 'window' ? `emu86-pc-${pc.id}` : '_blank',
    mode === 'window' ? 'popup=yes,width=1000,height=720' : '',
  );
  if (spawn === null) {
    note('the browser blocked the new window — allow popups for this site');
    return;
  }
  try {
    spawn.document.title = `moving ${label}…`;
    spawn.document.body.append(`moving ${label}…`);
  } catch { /* cosmetic only */ }
  dbg(`moving ${label} out to a ${mode} — requesting handoff`);
  note(`moving ${label} out…`, true);
  try {
    const { record } = await requestHandoff((data) => postToPc(pc.id, data));
    const nonce = mintNonce();
    writeHandoffMailbox({ nonce, pcId: pc.id, record, at: Date.now() });
    frames.get(pc.id)?.remove();
    frames.delete(pc.id);
    await locksClear(lockNamesFor(record), 5_000);
    spawn.location.href = `./?pc=${encodeURIComponent(pc.id)}&claim=${encodeURIComponent(nonce)}`;
    if (mode === 'tab') {
      // The PC has LEFT the rack: row and namespaced record go. The
      // resume slot is KEPT — the machine lives on (contrast ⏻).
      const at = pcs.findIndex((p) => p.id === pc.id);
      if (at >= 0) pcs.splice(at, 1);
      try {
        sessionStorage.removeItem(storageKeyFor(pc.id));
      } catch { /* dies with the tab anyway */ }
      if (selected === pc.id) selected = pcs[0]?.id ?? null;
      note(`${label} moved to its own tab`);
    } else {
      floating.set(pc.id, { win: spawn, placeholder: mountPlaceholder(pc) });
      note(`${label} floated to its own window`);
    }
    if (selected !== null) {
      select(selected);
    } else {
      emptyHint.style.display = pcs.length === 0 ? '' : 'none';
      persistRack();
      renderRail();
    }
  } catch (err) {
    try {
      spawn.close();
    } catch { /* already gone */ }
    // Belt and braces: a PC that never answered may still be frozen —
    // an unfreeze to a healthy one is a no-op.
    postToPc(pc.id, { emu86: 'set-paused', paused: false });
    note(`move failed — ${String(err)}`);
  }
}

function mountPlaceholder(pc: RackPc): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'pc-away';
  const text = document.createElement('p');
  text.textContent = `${pc.name ?? 'this PC'} is running in its own window.`;
  const back = document.createElement('button');
  back.textContent = 'bring it back into the rack';
  back.addEventListener('click', () => {
    void bringBack(pc.id);
  });
  el.append(text, back);
  el.style.display = 'none';
  pane.appendChild(el);
  return el;
}

async function bringBack(id: string): Promise<void> {
  const away = floating.get(id);
  const pc = pcs.find((p) => p.id === id);
  if (away === undefined || pc === undefined) return;
  const label = pc.name ?? pc.id.slice(0, 11);
  if (away.win.closed) {
    // Closed by hand: its pagehide teardown updated the resume slot,
    // and sessionId (the slot key) never drifts — the rack's copy of
    // the record is enough. Octet/fork drift heals by re-lease / the
    // generation machinery's honest refusal (recorded wart, §5d).
    reDock(pc, loadSessionAt(pc.id));
    return;
  }
  dbg(`bringing ${label} back — requesting handoff from its window`);
  note(`bringing ${label} back…`, true);
  try {
    const { record } = await requestHandoff((data) =>
      away.win.postMessage(data, location.origin));
    saveSessionAt(pc.id, record); // the window's truth over our stale copy
    away.win.close();
    reDock(pc, record);
  } catch (err) {
    note(`bring-back failed — ${String(err)} (the window keeps the machine)`);
  }
}

function reDock(pc: RackPc, record: SessionState): void {
  const away = floating.get(pc.id);
  away?.placeholder.remove();
  floating.delete(pc.id);
  void (async () => {
    await locksClear(lockNamesFor(record), 5_000);
    spawnFrame(pc.id);
    select(pc.id);
    note(`${pc.name ?? pc.id.slice(0, 11)} is back in the rack`);
  })();
}

// A floated window the user closes by hand re-docks on its own — the
// poll notices and restores from the rack's copy of the record.
setInterval(() => {
  for (const [id, away] of floating) {
    if (!away.win.closed) continue;
    const pc = pcs.find((p) => p.id === id);
    if (pc === undefined) {
      floating.delete(id);
      away.placeholder.remove();
      continue;
    }
    note(`${pc.name ?? id.slice(0, 11)}'s window closed — re-docking`);
    reDock(pc, loadSessionAt(id));
  }
}, 2_000);

// ---- the [+] picker ---------------------------------------------------

function describeAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function openPicker(): Promise<void> {
  picker.textContent = '';

  const h = document.createElement('h2');
  h.textContent = 'add a PC';
  picker.appendChild(h);

  const blank = document.createElement('div');
  blank.className = 'pick-row';
  blank.textContent = '▷ new blank PC';
  blank.addEventListener('click', () => {
    closePicker();
    addPc(mintPcId());
  });
  picker.appendChild(blank);

  // Packages (M3) — whole racks, restored PC by PC.
  const hPkg = document.createElement('h2');
  hPkg.textContent = 'infrastructure packages';
  picker.appendChild(hPkg);
  try {
    const packages = await packageStore.list();
    if (packages.length === 0) {
      const none = document.createElement('div');
      none.className = 'pick-none';
      none.textContent = '(none yet — 💾 saves the running rack as one)';
      picker.appendChild(none);
    }
    for (const p of packages) {
      const row = document.createElement('div');
      row.className = 'pick-row';
      const label = document.createElement('span');
      label.textContent = `📦 ${p.name} (${p.members.length} PC${p.members.length === 1 ? '' : 's'})`;
      const right = document.createElement('span');
      right.className = 'age';
      right.textContent = describeAge(Date.now() - p.createdAt);
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'delete this package and its member states';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete package “${p.name}” and its ${p.members.length} saved machine(s)?`)) return;
        // Members first, manifest last — a tear leaves named saves.
        void (async () => {
          for (const m of p.members) {
            await machineStore.deleteState(m.stateId).catch(() => { /* best effort */ });
          }
          await packageStore.delete(p.packageId);
          closePicker();
          note(`package “${p.name}” deleted`);
        })();
      });
      row.append(label, right, del);
      row.addEventListener('click', () => {
        closePicker();
        loadPackage(p.members);
      });
      picker.appendChild(row);
    }
  } catch { /* the section just stays empty */ }

  const h2 = document.createElement('h2');
  h2.textContent = 'saved machines';
  picker.appendChild(h2);

  let named: MachineStateMeta[] = [];
  try {
    named = (await machineStore.listMeta())
      .filter((m) => m.kind === 'named')
      .sort((a, b) => b.lastTouched - a.lastTouched);
  } catch { /* empty list renders below */ }

  if (named.length === 0) {
    const none = document.createElement('div');
    none.className = 'pick-none';
    none.textContent = '(no saved machines — the inspect popup saves them)';
    picker.appendChild(none);
  }
  for (const meta of named) {
    const row = document.createElement('div');
    row.className = 'pick-row';
    const label = document.createElement('span');
    label.textContent = meta.label ?? meta.stateId;
    const age = document.createElement('span');
    age.className = 'age';
    age.textContent = describeAge(Date.now() - meta.createdAt);
    row.append(label, age);
    row.addEventListener('click', () => {
      closePicker();
      // The whole adoption: seed the new instance's session record
      // with the queued restore, then boot the app. Its own restore
      // path (Phase 18 M2) does everything else.
      const id = mintPcId();
      saveSessionAt(id, { pendingRestoreStateId: meta.stateId });
      addPc(id);
    });
    picker.appendChild(row);
  }

  pickerBackdrop.classList.add('open');
}

function closePicker(): void {
  pickerBackdrop.classList.remove('open');
}

addBtn.addEventListener('click', () => { void openPicker(); });
pickerBackdrop.addEventListener('click', (e) => {
  if (e.target === pickerBackdrop) closePicker();
});

// ---- infrastructure packages (multi-PC brief M3) -----------------------

/** Post a parent→iframe command (freeze/thaw, save-named). */
function postToPc(id: string, data: unknown): void {
  frames.get(id)?.contentWindow?.postMessage(data, location.origin);
}

let saveRequestSeq = 0;
const saveWaiters = new Map<number, (reply: { ok: boolean; stateId?: string; error?: string }) => void>();

window.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (e.origin !== location.origin) return;
  const data = e.data as { emu86?: unknown; requestId?: unknown; ok?: unknown; stateId?: unknown; error?: unknown };
  if (data?.emu86 !== 'named-saved' || typeof data.requestId !== 'number') return;
  const waiter = saveWaiters.get(data.requestId);
  if (waiter === undefined) return;
  saveWaiters.delete(data.requestId);
  waiter({
    ok: data.ok === true,
    ...(typeof data.stateId === 'string' ? { stateId: data.stateId } : {}),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
  });
});

const SAVE_MEMBER_TIMEOUT_MS = 30_000; // a 640K RAM copy + gzip can take a while

function saveNamedViaPc(id: string, label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const requestId = ++saveRequestSeq;
    const timer = setTimeout(() => {
      saveWaiters.delete(requestId);
      reject(new Error('member capture timed out'));
    }, SAVE_MEMBER_TIMEOUT_MS);
    saveWaiters.set(requestId, (reply) => {
      clearTimeout(timer);
      if (reply.ok && reply.stateId !== undefined) resolve(reply.stateId);
      else reject(new Error(reply.error ?? 'member capture failed'));
    });
    postToPc(id, { emu86: 'save-named', label, requestId });
  });
}

/**
 * D3 (Jonathan's ruling): freeze-all → capture-each → resume. The
 * freeze holds every member's clock while the captures run, so the
 * package is one coherent moment; in-flight frames reconcile by TCP
 * on load, the same law as a single PC's capture boundary. Member
 * states land FIRST, the manifest LAST — an interrupted save leaves
 * only ordinary named saves, never a manifest pointing at nothing.
 */
async function saveRack(): Promise<void> {
  if (pcs.length === 0) {
    note('nothing to save — the rack is empty');
    return;
  }
  if (floating.size > 0) {
    // A floated PC has no iframe to answer the member capture — the
    // save would sit on the 30 s timeout and fail late. Refuse early.
    note('bring floating PCs back into the rack before saving it as a package');
    return;
  }
  const name = prompt('package name?', 'my lab');
  if (name === null || name.trim() === '') return;
  saveBtn.disabled = true;
  note(`saving “${name.trim()}” — freezing ${pcs.length} PC(s)…`, true);
  for (const pc of pcs) postToPc(pc.id, { emu86: 'set-paused', paused: true });
  const members: RackPackageMember[] = [];
  try {
    for (const pc of pcs) {
      const label = pc.name ?? pc.id.slice(0, 11);
      note(`saving “${name.trim()}” — capturing ${label}…`, true);
      const stateId = await saveNamedViaPc(pc.id, `${name.trim()} / ${label}`);
      members.push({ label: pc.name, stateId });
    }
    await packageStore.put({
      packageId:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? `pkg-${crypto.randomUUID()}`
          : `pkg-${Math.random().toString(36).slice(2)}`,
      name: name.trim(),
      createdAt: Date.now(),
      members,
    });
    note(`package “${name.trim()}” saved (${members.length} PC(s))`);
  } catch (err) {
    // Roll the members back best-effort: a tear leaves named saves,
    // which are visible and deletable — never a dangling manifest.
    for (const m of members) {
      void machineStore.deleteState(m.stateId).catch(() => { /* best effort */ });
    }
    note(`package save failed — ${String(err)}`);
  } finally {
    for (const pc of pcs) postToPc(pc.id, { emu86: 'set-paused', paused: false });
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', () => { void saveRack(); });

/** Load every member of a package as a fresh PC (named-save path).
 *  Restored members boot with a detached cable until their first
 *  reboot — existing named-save semantics, recorded in the brief. */
function loadPackage(members: RackPackageMember[]): void {
  for (const member of members) {
    const id = mintPcId();
    saveSessionAt(id, { pendingRestoreStateId: member.stateId });
    addPc(id, member.label);
  }
}

// ---- status from the iframes ------------------------------------------

window.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (e.origin !== location.origin) return;
  if (!isPcStatusMsg(e.data)) return;
  // Bind by SOURCE, not by the message's own claim — an iframe can
  // only ever update its own row.
  for (const [pcId, frame] of frames) {
    if (frame.contentWindow === e.source) {
      const pc = pcs.find((p) => p.id === pcId);
      if (pc !== undefined) {
        pc.name = e.data.name;
        pc.octet = e.data.octet;
        pc.state = e.data.state;
        renderRail();
      }
      return;
    }
  }
});

// ---- migration (multi-PC brief M2): adopt PCs from dying tabs ----------

const rackId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `rack-${crypto.randomUUID()}`
    : `rack-${Math.random().toString(36).slice(2)}`;
const rackChannel = new BroadcastChannel(RACK_CHANNEL_NAME);

function announce(): void {
  rackChannel.postMessage({ rack: 'here', rackId });
}

/** The Web Locks the dying tab's document holds — all derivable from
 *  its session record. They release when moved.html commits. */
function lockNamesFor(record: SessionState): string[] {
  const names = [resumeSlotLockName(resumeSlotId(record.sessionId))];
  if (record.overlayId !== null) names.push(overlayLockName(record.overlayId));
  if (record.driveForkId !== null) names.push(forkLockName(record.driveForkId));
  return names;
}

async function locksClear(names: string[], capMs: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const q = await navigator.locks.query();
      const held = new Set((q.held ?? []).map((l) => l?.name));
      if (!names.some((n) => held.has(n))) return;
    } catch {
      return; // no Locks API — spawn; the session self-healers decide
    }
    if (Date.now() - t0 > capMs) return; // backstop: they self-heal too
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function adopt(req: AdoptRequestMsg): Promise<void> {
  // Seed the new instance with the dying tab's ENTIRE record —
  // sessionId (→ its resume slot), octet, fork, overlay. The iframe's
  // boot then reload-resumes exactly as if this were the old tab.
  dbg(`adopting ${req.name ?? 'a PC'} — record received, acking`);
  const id = mintPcId();
  saveSessionAt(id, req.record);
  rackChannel.postMessage({ rack: 'adopt-ack', nonce: req.nonce, ok: true });
  // The tab navigates on our ack; spawn only after its document's
  // locks release, or the iframe's session resolution would read
  // "duplicate" and fork fresh identities instead of resuming.
  const t0 = Date.now();
  await locksClear(lockNamesFor(req.record), 5_000);
  dbg(
    `adopting ${req.name ?? 'a PC'} — old tab's locks cleared after ` +
      `${Date.now() - t0} ms, spawning the iframe`,
  );
  addPc(id, req.name);
}

rackChannel.onmessage = (ev: MessageEvent<unknown>) => {
  const data = ev.data;
  if (!isRackMsg(data)) return;
  if (data.rack === 'probe') {
    announce();
    return;
  }
  if (data.rack === 'adopt-request' && data.to === rackId) {
    void adopt(data);
  }
};
announce();

// ---- boot: restore the rail from the rack's own session ----------------

const saved = loadRack();
for (const { id } of saved.pcs) {
  pcs.push({ id, name: null, octet: null, state: 'booting' });
  spawnFrame(id);
}
if (saved.selected !== null) {
  select(saved.selected);
} else {
  emptyHint.style.display = pcs.length === 0 ? '' : 'none';
  renderRail();
}
