/**
 * Session-store unit tests (Phase 14 — sticky IPs / per-tab session).
 *
 * `sessionStorage` is shimmed with a Map-backed substitute, same
 * pattern as the settings tests' localStorage shim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSession,
  loadSessionAt,
  sanitizePcId,
  saveSession,
  saveSessionAt,
  storageKeyFor,
} from '../../web/session-store.js';

function makeStorageShim(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number { return map.size; },
    clear(): void { map.clear(); },
    getItem(k: string): string | null { return map.has(k) ? map.get(k)! : null; },
    key(i: number): string | null { return Array.from(map.keys())[i] ?? null; },
    removeItem(k: string): void { map.delete(k); },
    setItem(k: string, v: string): void { map.set(k, String(v)); },
  };
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', makeStorageShim());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session-store', () => {
  it('first load mints a sessionId and persists it across loads', () => {
    const first = loadSession();
    expect(first.sessionId.length).toBeGreaterThan(0);
    expect(first.tanHostOctet).toBeNull();
    expect(first.driveForkId).toBeNull();
    expect(first.pendingBlankKb).toBeNull();
    const second = loadSession();
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('drive fork fields round-trip and patch independently', () => {
    const { sessionId } = loadSession();
    saveSession({ driveForkId: 'row-1' });
    saveSession({ pendingBlankKb: 32256 });
    const s = loadSession();
    expect(s.sessionId).toBe(sessionId);
    expect(s.driveForkId).toBe('row-1');
    expect(s.pendingBlankKb).toBe(32256);
    // Clearing one leaves the other.
    saveSession({ pendingBlankKb: null });
    expect(loadSession().driveForkId).toBe('row-1');
    expect(loadSession().pendingBlankKb).toBeNull();
  });

  it('a pre-M0 stored session (no drive fields) loads with nulls', () => {
    sessionStorage.setItem(
      'emu86.session.v1',
      JSON.stringify({ sessionId: 'old', tanHostOctet: 7 }),
    );
    const s = loadSession();
    expect(s.sessionId).toBe('old');
    expect(s.tanHostOctet).toBe(7);
    expect(s.driveForkId).toBeNull();
    expect(s.pendingBlankKb).toBeNull();
    expect(s.overlayId).toBeNull(); // pre-Phase-17 sessions too
  });

  it('overlayId round-trips beside the drive fields (Phase 17 M1)', () => {
    saveSession({ driveForkId: 'row-1' });
    saveSession({ overlayId: 'ov-1' });
    const s = loadSession();
    expect(s.overlayId).toBe('ov-1');
    expect(s.driveForkId).toBe('row-1'); // patches stay independent
  });

  it('overlayResetPending round-trips and anything non-true reads false (Phase 17 M2)', () => {
    saveSession({ overlayResetPending: true });
    expect(loadSession().overlayResetPending).toBe(true);
    saveSession({ overlayResetPending: false });
    expect(loadSession().overlayResetPending).toBe(false);
    // A tampered/legacy value degrades to false, never truthy-coerces.
    sessionStorage.setItem(
      'emu86.session.v1',
      JSON.stringify({ sessionId: 'old', overlayResetPending: 'yes' }),
    );
    expect(loadSession().overlayResetPending).toBe(false);
  });

  it('saveSession patches one field and preserves the rest', () => {
    const { sessionId } = loadSession();
    const patched = saveSession({ tanHostOctet: 42 });
    expect(patched.tanHostOctet).toBe(42);
    expect(patched.sessionId).toBe(sessionId);
    expect(loadSession().tanHostOctet).toBe(42);
  });

  it('corrupt stored JSON degrades to a fresh session', () => {
    sessionStorage.setItem('emu86.session.v1', '{not json');
    const s = loadSession();
    expect(s.sessionId.length).toBeGreaterThan(0);
    expect(s.tanHostOctet).toBeNull();
  });

  it('a non-integer stored octet degrades to null', () => {
    sessionStorage.setItem(
      'emu86.session.v1',
      JSON.stringify({ sessionId: 'abc', tanHostOctet: 'x' }),
    );
    const s = loadSession();
    expect(s.sessionId).toBe('abc');
    expect(s.tanHostOctet).toBeNull();
  });

  it('fails open when sessionStorage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    const s = loadSession();
    expect(s.sessionId.length).toBeGreaterThan(0);
    // Each load is ephemeral (new id) — nothing sticks, nothing throws.
    expect(saveSession({ tanHostOctet: 5 }).tanHostOctet).toBe(5);
  });
});

describe('session-store instances (rack M0)', () => {
  it('namespaces storage keys per instance, bare key when none', () => {
    expect(storageKeyFor(null)).toBe('emu86.session.v1');
    expect(storageKeyFor('pc-a')).toBe('emu86.session.v1.pc-a');
  });

  it('instances have fully independent records', () => {
    const base = loadSession(); // ambient (no location in tests → bare key)
    const a = loadSessionAt('pc-a');
    const b = loadSessionAt('pc-b');
    expect(new Set([base.sessionId, a.sessionId, b.sessionId]).size).toBe(3);

    saveSessionAt('pc-a', { tanHostOctet: 16, driveForkId: 'fork-a' });
    saveSessionAt('pc-b', { tanHostOctet: 17 });
    expect(loadSessionAt('pc-a').tanHostOctet).toBe(16);
    expect(loadSessionAt('pc-b').tanHostOctet).toBe(17);
    expect(loadSessionAt('pc-b').driveForkId).toBeNull();
    expect(loadSession().tanHostOctet).toBeNull(); // the bare record untouched
  });

  it('an adopted record round-trips wholesale (the migration handshake)', () => {
    // The rack writes a dead tab's ENTIRE record under a fresh
    // instance key; the iframe's boot must read it back verbatim.
    const donor = saveSessionAt('old-tab', {
      tanHostOctet: 16,
      driveForkId: 'fork-1',
      overlayId: 'ov-1',
    });
    saveSessionAt('adopted', donor);
    expect(loadSessionAt('adopted')).toEqual(donor);
  });

  it('rejects unruly instance ids', () => {
    expect(sanitizePcId('pc-a')).toBe('pc-a');
    expect(sanitizePcId('A_1-b')).toBe('A_1-b');
    expect(sanitizePcId('has space')).toBeNull();
    expect(sanitizePcId('dot.dot')).toBeNull();
    expect(sanitizePcId('')).toBeNull();
    expect(sanitizePcId('x'.repeat(65))).toBeNull();
    expect(sanitizePcId(null)).toBeNull();
    expect(sanitizePcId(undefined)).toBeNull();
  });
});
