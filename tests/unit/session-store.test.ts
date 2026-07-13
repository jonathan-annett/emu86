/**
 * Session-store unit tests (Phase 14 — sticky IPs / per-tab session).
 *
 * `sessionStorage` is shimmed with a Map-backed substitute, same
 * pattern as the settings tests' localStorage shim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSession, saveSession } from '../../web/session-store.js';

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
    const second = loadSession();
    expect(second.sessionId).toBe(first.sessionId);
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
