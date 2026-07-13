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
 *
 * Fail-open like settings.ts: no sessionStorage (sandboxed iframe,
 * exotic privacy mode) degrades to fresh ephemeral values per load.
 */

export interface SessionState {
  /** Stable per-tab id — future hibernation/IDB key. */
  sessionId: string;
  /** Settled TAN host octet from this session's last boot, or null. */
  tanHostOctet: number | null;
}

const STORAGE_KEY = 'emu86.session.v1';

function freshState(): SessionState {
  return {
    sessionId:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `s-${Math.random().toString(36).slice(2)}`,
    tanHostOctet: null,
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
        const obj = parsed as { sessionId?: unknown; tanHostOctet?: unknown };
        if (typeof obj.sessionId === 'string' && obj.sessionId.length > 0) {
          state = {
            sessionId: obj.sessionId,
            tanHostOctet:
              typeof obj.tanHostOctet === 'number' && Number.isInteger(obj.tanHostOctet)
                ? obj.tanHostOctet
                : null,
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
