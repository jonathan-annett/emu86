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
import { saveSessionAt, type SessionState } from './session-store.js';
import { overlayLockName } from './overlay-session.js';
import { forkLockName } from './drive-session.js';
import {
  RACK_CHANNEL_NAME,
  isRackMsg,
  type AdoptRequestMsg,
} from './migrate.js';
import { PackageStore, type RackPackageMember } from './package-store.js';

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

function addPc(id: string, name: string | null = null): void {
  pcs.push({ id, name, octet: null, state: 'booting' });
  const iframe = document.createElement('iframe');
  iframe.src = `./?pc=${encodeURIComponent(id)}`;
  iframe.title = `PC ${id}`;
  iframe.style.display = 'none';
  frames.set(id, iframe);
  pane.appendChild(iframe);
  select(id);
}

function select(id: string): void {
  selected = id;
  for (const [pcId, frame] of frames) {
    frame.style.display = pcId === id ? '' : 'none';
  }
  emptyHint.style.display = pcs.length === 0 ? '' : 'none';
  persistRack();
  renderRail();
  // Focus the machine the user just picked — xterm's own focus funnel
  // takes it from there.
  frames.get(id)?.contentWindow?.focus();
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
    row.append(dot, name, sub);
    row.addEventListener('click', () => select(pc.id));
    rail.appendChild(row);
  }
}

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
  const id = mintPcId();
  saveSessionAt(id, req.record);
  rackChannel.postMessage({ rack: 'adopt-ack', nonce: req.nonce, ok: true });
  // The tab navigates on our ack; spawn only after its document's
  // locks release, or the iframe's session resolution would read
  // "duplicate" and fork fresh identities instead of resuming.
  await locksClear(lockNamesFor(req.record), 5_000);
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
  const iframe = document.createElement('iframe');
  iframe.src = `./?pc=${encodeURIComponent(id)}`;
  iframe.title = `PC ${id}`;
  iframe.style.display = 'none';
  frames.set(id, iframe);
  pane.appendChild(iframe);
}
if (saved.selected !== null) {
  select(saved.selected);
} else {
  emptyHint.style.display = pcs.length === 0 ? '' : 'none';
  renderRail();
}
