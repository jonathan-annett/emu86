/**
 * The tab→rack move (multi-PC brief M2) — the standalone tab's side.
 *
 * Discovery: racks announce `{rack:'here', rackId}` on the
 * `emu86-rack-v1` channel (on open, and again for every `probe`);
 * a standalone tab probes at mount and shows its "move to the rack"
 * affordance while at least one rack has answered.
 *
 * The move itself is the F5 path aimed elsewhere:
 *   1. freeze the machine (set-paused reason:'teardown' — the worker
 *      broadcasts the TAN freeze, so open connections hold);
 *   2. capture the frozen machine into the resume slot and WAIT for
 *      the row to be durable (the one new requirement over F5, where
 *      the teardown grace does the waiting);
 *   3. send the whole session record to the chosen rack and wait for
 *      its ack;
 *   4. clear this tab's own record (a later visit to ./ must mint a
 *      fresh PC, not fight the rack over this one) and navigate to
 *      moved.html — pagehide fires, the page dies, its Web Locks
 *      release, and the rack's adopted iframe reload-resumes the
 *      machine, thawing its peers.
 *
 * Every abort path unfreezes: a machine must never stay frozen
 * because a rack stopped answering.
 */

import type { SessionState } from './session-store.js';

export const RACK_CHANNEL_NAME = 'emu86-rack-v1';
/** How long the tab waits for the rack's adopt-ack before aborting. */
export const ADOPT_ACK_TIMEOUT_MS = 4_000;

export interface RackHereMsg {
  rack: 'here';
  rackId: string;
}
export interface RackProbeMsg {
  rack: 'probe';
}
export interface AdoptRequestMsg {
  rack: 'adopt-request';
  /** The rack this request is addressed to — others ignore it. */
  to: string;
  nonce: string;
  /** The dying tab's ENTIRE session record — identity, fork, overlay. */
  record: SessionState;
  /** Display name for the rail while the iframe boots. */
  name: string | null;
}
export interface AdoptAckMsg {
  rack: 'adopt-ack';
  nonce: string;
  ok: boolean;
}
export type RackMsg = RackHereMsg | RackProbeMsg | AdoptRequestMsg | AdoptAckMsg;

export function isRackMsg(data: unknown): data is RackMsg {
  return typeof data === 'object' && data !== null && 'rack' in data;
}

/** Structural BroadcastChannel subset (the tan.ts FrameChannel shape). */
export interface RackChannel {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface MoveToRackDeps {
  channel: RackChannel;
  /** Show/hide the affordance as racks appear/disappear from memory. */
  onRackPresence(present: boolean): void;
  /** set-paused reason:'teardown' → the worker (freeze + TAN freeze). */
  freeze(): void;
  /** set-paused false → the worker (also takes the TAN freeze back). */
  unfreeze(): void;
  /** Force a resume-slot capture of the (frozen) machine and resolve
   *  when the write has settled either way. */
  settleResumeSlot(): Promise<void>;
  /** Whether the resume slot commit is at least as new as `since` —
   *  the honesty gate (a restored-from-named-save session writes no
   *  reference slot, and migrating it would silently cold-boot). */
  slotFreshSince(since: number): Promise<boolean>;
  currentRecord(): SessionState;
  currentName(): string | null;
  /** Drop this tab's own session record (post-ack, pre-navigation). */
  clearOwnSession(): void;
  report(text: string): void;
  navigateToMoved(name: string | null): void;
  /** Clock, injectable for tests. */
  now?(): number;
}

export interface MoveToRack {
  /** Racks currently known — the affordance's enable state. */
  rackCount(): number;
  /** Run the whole move dance. Resolves when the tab is navigating
   *  (success) or after an abort (machine unfrozen, reason reported). */
  requestMove(): Promise<void>;
}

// ---- the rack→tab/window move (brief §5d) -----------------------------
//
// The out-move's shared pieces: the window-message shapes the rack and
// a PC exchange (over parent/opener postMessage, NOT the broadcast
// channel — the requester holds a direct reference to the context it
// is asking), and the one-shot localStorage mailbox that carries the
// session record to the freshly spawned top-level context (a new tab
// cannot read the rack's sessionStorage; the spec's session-storage
// copy on window.open is real but its timing against a blank-then-
// navigate spawn is not something to build on — the mailbox is
// deterministic).

/** Rack/opener → PC: freeze, capture durably, hand your record over. */
export interface HandoffRequestMsg {
  emu86: 'handoff';
  requestId: number;
}
/** PC → requester: slot is durable, here is everything; kill me. */
export interface HandoffReadyMsg {
  emu86: 'handoff-ready';
  requestId: number;
  record: SessionState;
  name: string | null;
}
/** PC → requester: cannot move (reason inside); machine resumed. */
export interface HandoffRefusedMsg {
  emu86: 'handoff-refused';
  requestId: number;
  error: string;
}

export function isHandoffRequest(data: unknown): data is HandoffRequestMsg {
  return typeof data === 'object' && data !== null
    && (data as { emu86?: unknown }).emu86 === 'handoff'
    && typeof (data as { requestId?: unknown }).requestId === 'number';
}

export function isHandoffReply(data: unknown): data is HandoffReadyMsg | HandoffRefusedMsg {
  if (data === null || typeof data !== 'object') return false;
  const tag = (data as { emu86?: unknown }).emu86;
  if (tag !== 'handoff-ready' && tag !== 'handoff-refused') return false;
  return typeof (data as { requestId?: unknown }).requestId === 'number';
}

const HANDOFF_MAILBOX_KEY = 'emu86.handoff.v1';
/** A mailbox older than this is a wreck from an interrupted move, not
 *  a live handoff — refuse it so a stale claim can't resurrect. */
export const HANDOFF_MAILBOX_TTL_MS = 60_000;

export interface HandoffMailbox {
  nonce: string;
  pcId: string;
  record: SessionState;
  at: number;
}

/** Rack side: park the record for the spawned context to claim. */
export function writeHandoffMailbox(box: HandoffMailbox): void {
  try {
    localStorage.setItem(HANDOFF_MAILBOX_KEY, JSON.stringify(box));
  } catch { /* quota/private mode — the claim will simply find nothing */ }
}

/**
 * Spawned-context side: claim the mailbox if the nonce matches and it
 * is fresh. One-shot — the row is removed whether or not it matched
 * this claimant's nonce (a mismatched row is another move's garbage).
 */
export function claimHandoffMailbox(
  nonce: string,
  now: number = Date.now(),
): HandoffMailbox | null {
  try {
    const raw = localStorage.getItem(HANDOFF_MAILBOX_KEY);
    if (raw === null) return null;
    localStorage.removeItem(HANDOFF_MAILBOX_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const box = parsed as { nonce?: unknown; pcId?: unknown; record?: unknown; at?: unknown };
    if (box.nonce !== nonce) return null;
    if (typeof box.pcId !== 'string' || typeof box.at !== 'number') return null;
    if (box.record === null || typeof box.record !== 'object') return null;
    if (now - box.at > HANDOFF_MAILBOX_TTL_MS) return null;
    return {
      nonce,
      pcId: box.pcId,
      record: box.record as SessionState,
      at: box.at,
    };
  } catch {
    return null; // unparseable/blocked storage — the boot just proceeds fresh
  }
}

export function mountMoveToRack(deps: MoveToRackDeps): MoveToRack {
  const now = deps.now ?? (() => Date.now());
  const racks = new Set<string>();
  let ackWaiter: ((msg: AdoptAckMsg) => void) | null = null;

  deps.channel.onmessage = (ev) => {
    const data = ev.data;
    if (!isRackMsg(data)) return;
    if (data.rack === 'here') {
      if (typeof data.rackId === 'string' && data.rackId.length > 0) {
        racks.add(data.rackId);
        deps.onRackPresence(true);
      }
      return;
    }
    if (data.rack === 'adopt-ack') {
      ackWaiter?.(data);
      return;
    }
    // 'probe' is rack-bound; 'adopt-request' is another tab's business.
  };
  deps.channel.postMessage({ rack: 'probe' });

  async function requestMove(): Promise<void> {
    const rackId = [...racks][0];
    if (rackId === undefined) {
      deps.report('no rack tab is open — open rack.html first');
      return;
    }
    deps.freeze();
    const started = now();
    try {
      await deps.settleResumeSlot();
      if (!(await deps.slotFreshSince(started))) {
        deps.unfreeze();
        deps.report(
          'cannot move: this session has no resumable state ' +
            '(a machine restored from a named save needs a reboot first)',
        );
        return;
      }
    } catch (err) {
      deps.unfreeze();
      deps.report(`cannot move: capture failed — ${String(err)}`);
      return;
    }

    const nonce =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `n-${Math.random().toString(36).slice(2)}`;
    const ack = await new Promise<AdoptAckMsg | null>((resolve) => {
      const timer = setTimeout(() => {
        ackWaiter = null;
        resolve(null);
      }, ADOPT_ACK_TIMEOUT_MS);
      ackWaiter = (msg) => {
        if (msg.nonce !== nonce) return; // someone else's dance
        clearTimeout(timer);
        ackWaiter = null;
        resolve(msg);
      };
      const request: AdoptRequestMsg = {
        rack: 'adopt-request',
        to: rackId,
        nonce,
        record: deps.currentRecord(),
        name: deps.currentName(),
      };
      deps.channel.postMessage(request);
    });

    if (ack === null || !ack.ok) {
      deps.unfreeze();
      racks.delete(rackId);
      deps.onRackPresence(racks.size > 0);
      deps.report(
        ack === null
          ? 'the rack did not answer — machine resumed here'
          : 'the rack refused the move — machine resumed here',
      );
      return;
    }

    deps.clearOwnSession();
    deps.navigateToMoved(deps.currentName());
  }

  return { rackCount: () => racks.size, requestMove };
}
