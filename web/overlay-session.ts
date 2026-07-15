/**
 * Per-tab boot-disk overlay lifecycle (Phase 17 M2) — the third
 * deployment of the octet-lease pattern, mirroring drive-session.ts
 * shape-for-shape (that module's states are field-proven; reuse the
 * shape, don't reinvent it).
 *
 * Settled BEFORE boot, alongside the drive fork:
 *
 *   - fresh tab            → mint an overlayId, nothing to fold
 *   - reload               → same id, fold its stored chunks
 *   - duplicated tab       → sessionStorage copied the id but the
 *     original holds its Web Lock → COPY the chunks under a fresh id
 *     (both tabs resume the same machine state, then diverge)
 *   - queued factory reset → drop the overlay first (the mkdrive
 *     pendingBlankKb pattern): next boot is the pristine base
 *   - M1-era rows (null fingerprint) → deleted silently, never
 *     folded. M1 swept without ever folding, so sessions mixed
 *     incoherently under one id — PHASE17_M1_REPORT.md §3 recorded
 *     this exact disposal.
 *
 * The fingerprint MISMATCH case (stored rows belong to a different
 * base image) is NOT handled here — only the worker can hash the
 * base (it may fetch the bundled image itself). This module loads
 * whatever coherent rows exist; the worker refuses the fold and
 * main.ts moves the tab's sweeps to a fresh id on the
 * overlay-identity report (keep semantics; discard is a settings
 * action).
 *
 * GC mirrors gcOrphanForks: unheld lock + lastTouched ≥ 7 days ⇒
 * chunks and meta deleted. Same generosity, same reason — session
 * restore resurrects sessionStorage and those tabs should find
 * their machine state.
 */

import type { ForkLocks } from './drive-session.js';
import type { SessionState } from './session-store.js';
import type { OverlayChunkRow, OverlayMeta } from './overlay-store.js';

/** The store surface this module needs — injectable for tests. */
export interface OverlayStoreLike {
  getMeta(overlayId: string): Promise<OverlayMeta | null>;
  getChunks(overlayId: string): Promise<OverlayChunkRow[]>;
  deleteOverlay(overlayId: string): Promise<void>;
  copyOverlay(fromId: string, toId: string): Promise<void>;
  listMeta(): Promise<OverlayMeta[]>;
}

export interface OverlaySessionDeps {
  store: OverlayStoreLike;
  locks: ForkLocks;
  loadSession(): SessionState;
  saveSession(patch: Partial<SessionState>): SessionState;
}

export type OverlayOrigin = 'fresh' | 'reload' | 'duplicate';

/** What the boot message should carry — null when there is nothing to fold. */
export interface OverlayBootPayload {
  chunks: Array<{ chunkIndex: number; bytes: Uint8Array }>;
  chunkSizeBytes: number;
  fingerprint: string;
}

export interface OverlaySession {
  overlayId: string;
  origin: OverlayOrigin;
  boot: OverlayBootPayload | null;
  /** Human-readable disposal notes ('factory reset consumed', ...). */
  notes: string[];
}

/** Unheld overlays older than this are garbage (the fork GC constant). */
export const OVERLAY_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Single funnel so GC and boot agree on the lock namespace. */
export function overlayLockName(overlayId: string): string {
  return `emu86-overlay-${overlayId}`;
}

export function mintOverlayId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `o-${Math.random().toString(36).slice(2)}`;
}

/**
 * Settle which overlay this tab boots with. Always leaves
 * sessionStorage pointing at the returned id and (when the locks API
 * exists) this tab holding that id's lock. Throws only if the store
 * itself is unusable; the caller boots pristine with a warning.
 */
export async function resolveOverlaySession(
  deps: OverlaySessionDeps,
): Promise<OverlaySession> {
  const session = deps.loadSession();
  const notes: string[] = [];

  // Queued factory reset — consume first, whatever else is stored.
  // Delete only if nobody holds the lock: normally that's this very
  // tab rebooting; a duplicated tab that inherited the pending flag
  // must NOT delete rows the original is still sweeping onto (the
  // mkdrive probeFree precedent).
  if (session.overlayResetPending) {
    if (
      session.overlayId !== null &&
      (await deps.locks.probeFree(overlayLockName(session.overlayId)))
    ) {
      await deps.store.deleteOverlay(session.overlayId);
    }
    const id = mintOverlayId();
    deps.saveSession({ overlayId: id, overlayResetPending: false });
    await deps.locks.acquireForever(overlayLockName(id));
    notes.push('factory reset consumed — pristine boot');
    return { overlayId: id, origin: 'fresh', boot: null, notes };
  }

  // No id yet: fresh tab.
  if (session.overlayId === null) {
    const id = mintOverlayId();
    deps.saveSession({ overlayId: id });
    await deps.locks.acquireForever(overlayLockName(id));
    return { overlayId: id, origin: 'fresh', boot: null, notes };
  }

  // Existing id: soft reboot, or a duplicated tab's copied pointer.
  const acquired = await deps.locks.acquireForever(
    overlayLockName(session.overlayId),
  );
  if (acquired) {
    const boot = await loadBootPayload(deps.store, session.overlayId, notes);
    return { overlayId: session.overlayId, origin: 'reload', boot, notes };
  }

  // The original tab holds the lock — this is a duplicate. Copy the
  // machine state under a fresh identity (both tabs resume, then
  // diverge — the fork-the-fork precedent).
  const freshId = mintOverlayId();
  const meta = await deps.store.getMeta(session.overlayId);
  if (meta !== null) {
    await deps.store.copyOverlay(session.overlayId, freshId);
  }
  deps.saveSession({ overlayId: freshId });
  await deps.locks.acquireForever(overlayLockName(freshId));
  const boot = await loadBootPayload(deps.store, freshId, notes);
  return { overlayId: freshId, origin: 'duplicate', boot, notes };
}

async function loadBootPayload(
  store: OverlayStoreLike,
  overlayId: string,
  notes: string[],
): Promise<OverlayBootPayload | null> {
  const meta = await store.getMeta(overlayId);
  if (meta === null) return null;
  if (meta.baseFingerprint === null) {
    // Pre-identity (M1) rows: never fold, delete silently.
    await store.deleteOverlay(overlayId);
    notes.push('pre-identity (M1-era) machine state discarded');
    return null;
  }
  const rows = await store.getChunks(overlayId);
  if (rows.length === 0) return null;
  return {
    chunks: rows.map((r) => ({ chunkIndex: r.chunkIndex, bytes: r.bytes })),
    chunkSizeBytes: meta.chunkSizeBytes,
    fingerprint: meta.baseFingerprint,
  };
}

/**
 * Sweep overlays owned by long-gone tabs. Mirrors gcOrphanForks:
 * returns rows removed; returns 0 (never guesses) when locks are
 * unsupported or unknowable.
 */
export async function gcOrphanOverlays(
  store: OverlayStoreLike,
  locks: ForkLocks,
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<number> {
  if (!locks.supported) return 0;
  let held: Set<string>;
  try {
    held = await locks.heldNames();
  } catch {
    return 0;
  }
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? OVERLAY_GC_MAX_AGE_MS;
  let removed = 0;
  for (const meta of await store.listMeta()) {
    if (held.has(overlayLockName(meta.overlayId))) continue;
    if (now - meta.lastTouched < maxAge) continue;
    await store.deleteOverlay(meta.overlayId);
    removed++;
  }
  return removed;
}
