/**
 * Phase 18 M3 — the clone handshake ("tab duplicate = frozen in
 * amber"). D3(a): the parent writes the snapshot to `emu86-machines`
 * and broadcasts ONLY the stateId; the child reads IDB. No N-tab
 * structured clones; the snapshot code path is the named-save one.
 *
 * Shape:
 *
 *   child                         parent (holds the duplicated locks)
 *   ─ clone-request ────────────▶ (is parentSessionId mine?)
 *   ◀──────────── clone-accepted  capture + gzip + putState underway
 *   ◀─────────────── clone-ready  { stateId }
 *          — or clone-failed { reason }, or silence —
 *
 * Two timeouts, cold boot on any miss (brief M3: "degraded-mode
 * cold-boot fallback with a timeout, always"): a short one for the
 * ACCEPT (is any parent alive at all — sub-second normally) and a
 * long one for READY (the parent is gzipping ~40 MB of disks).
 *
 * Identity: the child dials with the sessionId it INHERITED via
 * sessionStorage (that is precisely what names the parent) plus its
 * own freshly-minted id; only the tab whose sessionId matches
 * answers, so N other tabs on the channel stay silent. The parent
 * serializes concurrent children — captures are cheap but the gzip
 * isn't, and interleaved putStates help nobody.
 *
 * D5(b) note: nothing here touches the network plane. The clone
 * restores with the parent's in-RAM identity and a detached cable;
 * a reboot re-leases honestly. Recorded, accepted, v1.
 */

/** The channel surface this module needs — BroadcastChannel-shaped,
 *  injectable for tests. */
export interface CloneChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', handler: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', handler: (ev: { data: unknown }) => void): void;
}

export const CLONE_CHANNEL_NAME = 'emu86-clone-v1';

/** Any parent alive? Normally answered within a frame or two. */
export const CLONE_ACCEPT_TIMEOUT_MS = 3_000;
/** Capture + gzip + IDB put of a whole machine — generous on purpose. */
export const CLONE_READY_TIMEOUT_MS = 20_000;

interface CloneRequest {
  v: 1;
  type: 'clone-request';
  parentSessionId: string;
  childSessionId: string;
}
interface CloneAccepted {
  v: 1;
  type: 'clone-accepted';
  parentSessionId: string;
  childSessionId: string;
}
interface CloneReady {
  v: 1;
  type: 'clone-ready';
  parentSessionId: string;
  childSessionId: string;
  stateId: string;
}
interface CloneFailed {
  v: 1;
  type: 'clone-failed';
  parentSessionId: string;
  childSessionId: string;
  reason: string;
}
type CloneMessage = CloneRequest | CloneAccepted | CloneReady | CloneFailed;

function isCloneMessage(data: unknown): data is CloneMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Record<string, unknown>;
  return (
    m.v === 1 &&
    typeof m.type === 'string' &&
    typeof m.parentSessionId === 'string' &&
    typeof m.childSessionId === 'string'
  );
}

export interface CloneRequestOptions {
  acceptTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** Progress callback — the child's syslog narrates the wait. */
  onAccepted?: () => void;
}

/**
 * Child side: ask the parent tab for a frozen-in-amber snapshot.
 * Resolves the `emu86-machines` stateId to restore, or null on any
 * miss (no parent, parent failed, timeout) — null always means a
 * plain cold boot, never an error.
 */
export function requestCloneState(
  channel: CloneChannelLike,
  parentSessionId: string,
  childSessionId: string,
  opts: CloneRequestOptions = {},
): Promise<string | null> {
  const acceptMs = opts.acceptTimeoutMs ?? CLONE_ACCEPT_TIMEOUT_MS;
  const readyMs = opts.readyTimeoutMs ?? CLONE_READY_TIMEOUT_MS;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (stateId: string | null): void => {
      clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      resolve(stateId);
    };
    const onMessage = (ev: { data: unknown }): void => {
      if (!isCloneMessage(ev.data)) return;
      const m = ev.data;
      if (m.parentSessionId !== parentSessionId || m.childSessionId !== childSessionId) return;
      if (m.type === 'clone-accepted') {
        // A parent is alive and capturing — trade the short fuse for
        // the long one.
        clearTimeout(timer);
        timer = setTimeout(() => finish(null), readyMs);
        opts.onAccepted?.();
        return;
      }
      if (m.type === 'clone-ready') finish(m.stateId);
      if (m.type === 'clone-failed') finish(null);
    };
    channel.addEventListener('message', onMessage);
    timer = setTimeout(() => finish(null), acceptMs);
    const req: CloneRequest = {
      v: 1, type: 'clone-request', parentSessionId, childSessionId,
    };
    channel.postMessage(req);
  });
}

export interface CloneParentDeps {
  /** THIS tab's sessionId — only requests naming it are answered. */
  sessionId: () => string;
  /**
   * Capture the running machine and persist it as a clone row
   * (kind 'clone'); resolves the stateId. The named-save code path
   * with a different row identity — D3(a)'s "one code path".
   */
  saveCloneState: (childSessionId: string) => Promise<string>;
  /** Narration hook (parent's syslog). */
  onServed?: (childSessionId: string, ok: boolean) => void;
}

/**
 * Parent side: answer clone requests addressed to this tab. Requests
 * are served ONE AT A TIME (a second child queues behind the first's
 * gzip). Returns an unmount function.
 */
export function mountCloneParent(
  channel: CloneChannelLike,
  deps: CloneParentDeps,
): () => void {
  let chain: Promise<void> = Promise.resolve();
  const onMessage = (ev: { data: unknown }): void => {
    if (!isCloneMessage(ev.data)) return;
    const m = ev.data;
    if (m.type !== 'clone-request' || m.parentSessionId !== deps.sessionId()) return;
    chain = chain.then(async () => {
      const accepted: CloneAccepted = {
        v: 1, type: 'clone-accepted',
        parentSessionId: m.parentSessionId, childSessionId: m.childSessionId,
      };
      channel.postMessage(accepted);
      try {
        const stateId = await deps.saveCloneState(m.childSessionId);
        const ready: CloneReady = {
          v: 1, type: 'clone-ready',
          parentSessionId: m.parentSessionId, childSessionId: m.childSessionId,
          stateId,
        };
        channel.postMessage(ready);
        deps.onServed?.(m.childSessionId, true);
      } catch (err) {
        const failed: CloneFailed = {
          v: 1, type: 'clone-failed',
          parentSessionId: m.parentSessionId, childSessionId: m.childSessionId,
          reason: String(err),
        };
        channel.postMessage(failed);
        deps.onServed?.(m.childSessionId, false);
      }
    });
  };
  channel.addEventListener('message', onMessage);
  return () => channel.removeEventListener('message', onMessage);
}
