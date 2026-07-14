/**
 * Per-tab drive forks (Phase 16 M0 — brief Addendum A).
 *
 * Every tab owns a private /dev/hdb working copy (a `'fork'` row in the
 * image library); the shared base image is only a TEMPLATE that new
 * tabs copy at first boot. The Save button on the page promotes a tab's
 * current drive to be the new base; open tabs keep their forks.
 * Field trigger (2026-07-15): a brand-new tab answered `?mkdrive` with
 * "a drive is already attached" because the attach lived in
 * origin-global localStorage — see SUBSTRATE_API_REPORT.md §4.
 *
 * The fork pointer lives in sessionStorage (`driveForkId`), which
 * browsers COPY on tab duplication. That collision is detected with a
 * Web Lock named for the fork id: the original tab holds its lock for
 * the page's lifetime, so a duplicate finds it taken and forks a fresh
 * copy of the bytes — the octet-lease pattern the session-store doc
 * comment reserved for exactly this (2026-07-14).
 *
 * States resolved at boot, in order:
 *   pendingBlankKb set      → 'swap'          (queued ?mkdrive: fresh blank)
 *   forkId + lock acquired  → 'reload'        (same tab, soft reboot)
 *   forkId + lock taken     → 'duplicate'     (copy the bytes, new id)
 *   no forkId, base set     → 'fork-of-base'  (copy the template)
 *   no forkId, no base      → 'fresh-blank'   (blank 8086 KB — Jonathan,
 *                             2026-07-15: "8mb is enough for a basic
 *                             edit session, the upsize to 32mb is
 *                             optional")
 *
 * Fork rows are whole images, not chunked — the auto-persist cadence
 * (main.ts, ~5 s while dirty) makes an 8 MB structured-clone write
 * cheap and a 32 MB one acceptable. Chunked rows + a dirty-RANGE
 * snapshot message are the recorded follow-on if the field says 32 MB
 * hurts; `IndexedDBPageStore` is the in-repo precedent to grow toward.
 *
 * No locks API (old Safari, exotic modes): duplication detection
 * degrades to last-write-wins on a shared row and GC disables itself
 * (`supported: false`) — never delete what might be alive.
 */

import type { ImageLibrary, StoredDiskGeometry } from './image-library.js';
import { DRIVE_PRESETS, presetKb } from './image-library.js';
import type { SessionState } from './session-store.js';

/** The subset of ImageLibrary this module touches (tests may stub it). */
export type ForkLibrary = Pick<
  ImageLibrary,
  'listImages' | 'getImageEntry' | 'addImage' | 'removeImage'
>;

/** How this tab came to own its drive — provenance for the boot banner. */
export type ForkOrigin =
  | 'fresh-blank'
  | 'fork-of-base'
  | 'reload'
  | 'duplicate'
  | 'swap';

/** The drive a tab settled on: what to boot and where to auto-persist. */
export interface DriveSession {
  /** Image-library row id of this tab's fork — boot source AND persist target. */
  imageId: string;
  name: string;
  sizeBytes: number;
  geometry: StoredDiskGeometry | undefined;
  origin: ForkOrigin;
}

/**
 * Web Locks wrapper, injectable for tests. All names go through
 * {@link forkLockName} so GC and boot agree on the namespace.
 */
export interface ForkLocks {
  /** False when the Web Locks API is unavailable — GC then no-ops. */
  readonly supported: boolean;
  /** Hold `name` until the tab dies. False if another tab holds it. */
  acquireForever(name: string): Promise<boolean>;
  /** True if `name` is currently unheld (take-and-release probe). */
  probeFree(name: string): Promise<boolean>;
  /** Names of locks currently held by any tab. Rejects if unknowable. */
  heldNames(): Promise<Set<string>>;
}

export interface DriveSessionDeps {
  library: ForkLibrary;
  locks: ForkLocks;
  loadSession(): SessionState;
  saveSession(patch: Partial<SessionState>): SessionState;
  /** The shared base image new tabs fork, or null → fresh blank 8086 KB. */
  base: { kind: 'library'; id: string } | null;
}

/** Unheld fork rows older than this are garbage. Generous on purpose:
 *  reopen-closed-tab and browser session restore resurrect
 *  sessionStorage, and those tabs should find their bits. */
export const FORK_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The default drive every tab gets with no base template: 8086 KB. */
const DEFAULT_FORK_KB = 8086;

export function forkLockName(imageId: string): string {
  return `emu86-fork-${imageId}`;
}

function presetForKb(kb: number): (typeof DRIVE_PRESETS)[number] | undefined {
  return DRIVE_PRESETS.find((p) => presetKb(p) === kb);
}

/**
 * Settle which drive this tab boots, per the state table in the module
 * doc. Always leaves sessionStorage pointing at the returned row and
 * (when the locks API exists) this tab holding the row's lock.
 *
 * Throws only if the library itself is unusable (no IDB); the caller
 * (main.ts) degrades to a solo boot with a warning in that case.
 */
export async function resolveDriveSession(
  deps: DriveSessionDeps,
): Promise<DriveSession> {
  const session = deps.loadSession();

  // Queued ?mkdrive swap — consume it first, whatever else is stored.
  if (session.pendingBlankKb !== null) {
    const preset = presetForKb(session.pendingBlankKb);
    if (preset !== undefined) {
      // Retire the old fork only if nobody holds it. Normally that is
      // this very tab rebooting (its lock released on unload). A
      // duplicated tab that inherited the pending swap must NOT delete
      // a row the original is still running on.
      if (
        session.driveForkId !== null &&
        (await deps.locks.probeFree(forkLockName(session.driveForkId)))
      ) {
        await deps.library.removeImage(session.driveForkId);
      }
      const created = await createBlankFork(deps, preset, 'swap');
      deps.saveSession({ driveForkId: created.imageId, pendingBlankKb: null });
      return created;
    }
    // Unrecognized size (stale preset table?): drop the request honestly.
    deps.saveSession({ pendingBlankKb: null });
  }

  // Existing fork: soft reboot, or a duplicated tab's copied pointer.
  if (session.driveForkId !== null) {
    const acquired = await deps.locks.acquireForever(
      forkLockName(session.driveForkId),
    );
    const entry = await deps.library
      .getImageEntry(session.driveForkId)
      .catch(() => null);
    if (entry !== null) {
      if (acquired) {
        return {
          imageId: entry.id,
          name: entry.name,
          sizeBytes: entry.sizeBytes,
          geometry: entry.geometry,
          origin: 'reload',
        };
      }
      // The original tab holds the lock — this is a duplicate. Fork the
      // fork: same bytes (as of its last auto-persist), fresh identity.
      const id = await deps.library.addImage(
        entry.name,
        entry.bytes,
        'fork',
        undefined,
        entry.geometry,
      );
      deps.saveSession({ driveForkId: id });
      await deps.locks.acquireForever(forkLockName(id));
      return {
        imageId: id,
        name: entry.name,
        sizeBytes: entry.sizeBytes,
        geometry: entry.geometry,
        origin: 'duplicate',
      };
    }
    // Row vanished (GC'd, library wiped): fall through to a fresh fork.
    // The stray lock we may now hold references nothing — harmless.
  }

  // Fresh tab: fork the base template if one is set and still exists.
  if (deps.base !== null) {
    const baseEntry = await deps.library
      .getImageEntry(deps.base.id)
      .catch(() => null);
    if (baseEntry !== null) {
      const id = await deps.library.addImage(
        `fork of ${baseEntry.name}`,
        baseEntry.bytes,
        'fork',
        undefined,
        baseEntry.geometry,
      );
      deps.saveSession({ driveForkId: id });
      await deps.locks.acquireForever(forkLockName(id));
      return {
        imageId: id,
        name: `fork of ${baseEntry.name}`,
        sizeBytes: baseEntry.sizeBytes,
        geometry: baseEntry.geometry,
        origin: 'fork-of-base',
      };
    }
  }

  // No base (or it vanished): every tab still gets a drive — blank 8086 KB.
  const preset = presetForKb(DEFAULT_FORK_KB);
  if (preset === undefined) {
    throw new Error('drive-session: the 8086 KB preset vanished from DRIVE_PRESETS');
  }
  const created = await createBlankFork(deps, preset, 'fresh-blank');
  deps.saveSession({ driveForkId: created.imageId });
  return created;
}

async function createBlankFork(
  deps: DriveSessionDeps,
  preset: (typeof DRIVE_PRESETS)[number],
  origin: ForkOrigin,
): Promise<DriveSession> {
  const geometry: StoredDiskGeometry = {
    cylinders: preset.cylinders,
    heads: preset.heads,
    sectorsPerTrack: preset.sectorsPerTrack,
  };
  const sizeBytes = preset.cylinders * preset.heads * preset.sectorsPerTrack * 512;
  const name = `tab drive (${preset.label})`;
  const id = await deps.library.addImage(
    name,
    new Uint8Array(sizeBytes),
    'fork',
    undefined,
    geometry,
  );
  await deps.locks.acquireForever(forkLockName(id));
  return { imageId: id, name, sizeBytes, geometry, origin };
}

/**
 * Delete fork rows whose tab is gone: lock unheld AND last touched more
 * than `maxAgeMs` ago. Returns how many were removed. No-ops (0) when
 * the locks API is missing or unreadable — never guess about liveness.
 */
export async function gcOrphanForks(
  library: ForkLibrary,
  locks: ForkLocks,
  opts?: { maxAgeMs?: number; now?: number },
): Promise<number> {
  if (!locks.supported) return 0;
  const maxAgeMs = opts?.maxAgeMs ?? FORK_GC_MAX_AGE_MS;
  const now = opts?.now ?? Date.now();
  let held: Set<string>;
  try {
    held = await locks.heldNames();
  } catch {
    return 0;
  }
  let removed = 0;
  for (const meta of await library.listImages()) {
    if (meta.source !== 'fork') continue;
    if (held.has(forkLockName(meta.id))) continue;
    const touched = meta.modifiedAt ?? meta.uploadedAt;
    if (now - touched < maxAgeMs) continue;
    await library.removeImage(meta.id);
    removed += 1;
  }
  return removed;
}

/** The real Web Locks API, wrapped to the {@link ForkLocks} shape. */
export function createWebForkLocks(): ForkLocks {
  const manager =
    typeof navigator !== 'undefined' && 'locks' in navigator
      ? navigator.locks
      : null;
  if (manager === null) {
    // Degraded mode: duplication detection off (dup tabs share a row,
    // last write wins), reboot-retire proceeds, GC stays disabled via
    // `supported` — deleting rows we can't prove dead is worse than
    // letting them age out never.
    return {
      supported: false,
      acquireForever: () => Promise.resolve(true),
      probeFree: () => Promise.resolve(true),
      heldNames: () => Promise.reject(new Error('Web Locks unavailable')),
    };
  }
  return {
    supported: true,
    acquireForever(name: string): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        manager
          .request(name, { ifAvailable: true }, (lock) => {
            if (lock === null) {
              resolve(false);
              return undefined;
            }
            resolve(true);
            // Never settle: the lock releases when the page is destroyed.
            return new Promise<never>(() => { /* held until tab close */ });
          })
          .catch(() => resolve(false));
      });
    },
    probeFree(name: string): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        manager
          .request(name, { ifAvailable: true }, (lock) => {
            resolve(lock !== null);
            return undefined; // returning releases the probe immediately
          })
          .catch(() => resolve(false));
      });
    },
    async heldNames(): Promise<Set<string>> {
      const names = new Set<string>();
      const snapshot = await manager.query();
      for (const info of snapshot.held ?? []) {
        if (typeof info.name === 'string') names.add(info.name);
      }
      return names;
    },
  };
}
