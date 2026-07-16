/**
 * Per-tab session store (Phase 14 — sticky IPs; Jonathan, 2026-07-14:
 * "establishing a session store will be useful, even if it's just to
 * allow for future possibilities like saving a key to an indexed db
 * backing store for hibernation").
 *
 * `sessionStorage`-backed, so the scope is exactly "this tab, this
 * browsing session": survives reloads, dies with the tab. Distinct
 * from `settings.ts` (localStorage — durable user preferences shared
 * by all tabs); anything that must differ per tab lives here.
 *
 * Current tenants:
 *   - `tanHostOctet` — the settled TAN address, offered back to the
 *     lease as a *preferred* octet on the next load so reloads keep
 *     their IP. Safe against tab duplication: the duplicate's copied
 *     sessionStorage offers the same octet, the live original defends
 *     it, the lease repicks, and the duplicate's store is overwritten
 *     with its own settled octet.
 *   - `sessionId` — a stable per-tab UUID, generated on first use. No
 *     consumer yet; it exists as the future key for tab-scoped IDB
 *     state (hibernation snapshots). KNOWN CAVEAT for that future
 *     consumer: tab duplication copies the id, so hibernation must
 *     add its own liveness/collision handling (the octet-lease pattern
 *     is the precedent) rather than trusting the id to be unique.
 *   - `driveForkId` — Phase 16 M0: the image-library row id of THIS
 *     tab's /dev/hdb working copy (source tag 'fork'). Duplication
 *     copies it, exactly as the caveat above predicted; the
 *     drive-session module detects the collision via a Web Lock named
 *     for the id and forks a fresh copy (the octet-lease pattern).
 *   - `pendingBlankKb` — Phase 16 M0: a queued `?mkdrive` swap. Set by
 *     the control endpoint; consumed (and cleared) at the tab's next
 *     boot, which replaces the fork with a fresh blank of this size.
 *     Session-scoped on purpose: it must only ever swap THIS tab's
 *     drive, never the shared base image.
 *   - `overlayId` — Phase 17 M1/M2: the key this tab's boot-disk
 *     overlay chunks live under in `emu86-overlays`. Settled pre-boot
 *     by overlay-session.ts (M2): Web Lock detects duplication and
 *     copies chunks under a fresh id — the octet-lease pattern's
 *     third deployment, as the caveat above predicted.
 *   - `overlayResetPending` — Phase 17 M2: a queued factory reset.
 *     Set by the settings modal; consumed at the tab's next boot,
 *     which drops the overlay so the machine boots the pristine base
 *     (the pendingBlankKb pattern). Session-scoped: resets THIS tab's
 *     machine state only.
 *
 * Fail-open like settings.ts: no sessionStorage (sandboxed iframe,
 * exotic privacy mode) degrades to fresh ephemeral values per load.
 */

export interface SessionState {
  /** Stable per-tab id — future hibernation/IDB key. */
  sessionId: string;
  /** Settled TAN host octet from this session's last boot, or null. */
  tanHostOctet: number | null;
  /** This tab's /dev/hdb fork — image-library row id, or null before first boot. */
  driveForkId: string | null;
  /** Queued `?mkdrive` swap (KB), consumed at next boot; null when none. */
  pendingBlankKb: number | null;
  /** This tab's boot-disk overlay key (Phase 17 M1), or null before the first sweep. */
  overlayId: string | null;
  /** Queued factory reset (Phase 17 M2) — consumed at next boot. */
  overlayResetPending: boolean;
  /**
   * Queued restore of a named save-state (Phase 18 M2) — the
   * `emu86-machines` stateId to restore, consumed at the tab's next
   * boot (the overlayResetPending pattern: a running machine can't
   * un-write its RAM, so restore = flag + reload). Additive field:
   * archived builds drop it on their saves, which only costs a
   * queued restore across a version hop — acceptable.
   */
  pendingRestoreStateId: string | null;
  /**
   * Queued REBOOT (Phase 18 field loop): reload-resume made a plain
   * page reload resume instead of restart, which silently removed the
   * only reboot affordance the machine had. Consumed at next boot:
   * skip the resume once and drop the slot — RAM restarts, disk state
   * (overlay + fork) persists, exactly a real PC's reset button.
   */
  pendingColdBoot: boolean;
}

const STORAGE_KEY = 'emu86.session.v1';

/**
 * Mint a fresh per-tab id. Exposed for the clone path (Phase 18 M3):
 * a duplicated tab inherits its parent's sessionId via sessionStorage
 * and must re-mint BEFORE anything keys off it — two tabs sharing an
 * id fight over one resume-slot row.
 */
export function mintSessionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Math.random().toString(36).slice(2)}`;
}

function freshState(): SessionState {
  return {
    sessionId: mintSessionId(),
    tanHostOctet: null,
    driveForkId: null,
    pendingBlankKb: null,
    overlayId: null,
    overlayResetPending: false,
    pendingRestoreStateId: null,
    pendingColdBoot: false,
  };
}

/**
 * Load (or initialise) this tab's session state. First call in a fresh
 * tab mints and persists the sessionId; later calls round-trip it.
 */
export function loadSession(): SessionState {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return freshState();
  }

  let state: SessionState | null = null;
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed as {
          sessionId?: unknown;
          tanHostOctet?: unknown;
          driveForkId?: unknown;
          pendingBlankKb?: unknown;
          overlayId?: unknown;
          overlayResetPending?: unknown;
          pendingRestoreStateId?: unknown;
          pendingColdBoot?: unknown;
        };
        if (typeof obj.sessionId === 'string' && obj.sessionId.length > 0) {
          state = {
            sessionId: obj.sessionId,
            tanHostOctet:
              typeof obj.tanHostOctet === 'number' && Number.isInteger(obj.tanHostOctet)
                ? obj.tanHostOctet
                : null,
            driveForkId:
              typeof obj.driveForkId === 'string' && obj.driveForkId.length > 0
                ? obj.driveForkId
                : null,
            pendingBlankKb:
              typeof obj.pendingBlankKb === 'number' && Number.isInteger(obj.pendingBlankKb)
                ? obj.pendingBlankKb
                : null,
            overlayId:
              typeof obj.overlayId === 'string' && obj.overlayId.length > 0
                ? obj.overlayId
                : null,
            overlayResetPending: obj.overlayResetPending === true,
            pendingRestoreStateId:
              typeof obj.pendingRestoreStateId === 'string' &&
              obj.pendingRestoreStateId.length > 0
                ? obj.pendingRestoreStateId
                : null,
            pendingColdBoot: obj.pendingColdBoot === true,
          };
        }
      }
    } catch {
      // Corrupt JSON → fresh state below.
    }
  }

  if (state === null) {
    state = freshState();
    persist(state);
  }
  return state;
}

/** Merge `patch` into the stored state (loading/creating as needed). */
export function saveSession(patch: Partial<SessionState>): SessionState {
  const next = { ...loadSession(), ...patch };
  persist(next);
  return next;
}

function persist(state: SessionState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota/privacy failures: the session simply won't stick. Fine.
  }
}
