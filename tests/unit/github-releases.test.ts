/**
 * Unit tests for web/github-releases.ts.
 *
 * `fetch` is mocked via `vi.stubGlobal`. localStorage is provided by a
 * lightweight in-memory polyfill so the cache code path doesn't need a real
 * browser environment. We never hit api.github.com from these tests — the
 * Section 1 diagnosis covered the live observation; here we pin the
 * contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listReleases,
  downloadAsset,
  RateLimitError,
  AssetDownloadError,
} from '../../web/github-releases.js';

/* ---------- localStorage polyfill ---------- */

class MemoryStorage {
  #map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#map.has(k) ? (this.#map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void { this.#map.set(k, v); }
  removeItem(k: string): void { this.#map.delete(k); }
  clear(): void { this.#map.clear(); }
  key(i: number): string | null {
    return Array.from(this.#map.keys())[i] ?? null;
  }
  get length(): number { return this.#map.size; }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  // performance.now() — used by the streaming download throttle. Always
  // available in modern Node, but be defensive.
  if (typeof globalThis.performance === 'undefined') {
    vi.stubGlobal('performance', { now: () => Date.now() });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ---------- helpers to build mock responses ---------- */

interface MockReleaseInput {
  tag_name: string;
  name?: string | null;
  published_at?: string | null;
  prerelease?: boolean;
  body?: string | null;
  assets?: Array<{ name: string; size: number; browser_download_url?: string }>;
}

function mockRelease(input: MockReleaseInput): Record<string, unknown> {
  const assets = (input.assets ?? []).map((a) => ({
    name: a.name,
    size: a.size,
    browser_download_url:
      a.browser_download_url ??
      `https://github.com/ghaerr/elks/releases/download/${input.tag_name}/${a.name}`,
  }));
  return {
    tag_name: input.tag_name,
    name: input.name ?? input.tag_name,
    published_at: input.published_at ?? null,
    prerelease: input.prerelease ?? false,
    body: input.body ?? '',
    assets,
  };
}

function mockJsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers(init.headers ?? {});
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

/* ---------- tests ---------- */

describe('github-releases — listReleases', () => {
  it('parses a typical API response and returns latest stable when prereleases are off', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([
        mockRelease({
          tag_name: 'v0.9.0',
          name: 'ELKS 0.9.0',
          published_at: '2026-03-21T00:00:00Z',
          assets: [
            { name: 'fd1440-fat.img', size: 1474560 },
            { name: 'hd32-fat.img', size: 32514048 },
            { name: 'something.txt', size: 100 },  // non-img filtered out
          ],
        }),
        mockRelease({
          tag_name: 'v0.8.1',
          published_at: '2024-10-16T00:00:00Z',
          assets: [{ name: 'fd1440-fat.img', size: 1474560 }],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const releases = await listReleases({ includePrereleases: false, prereleaseLimit: 5 });
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      tag: 'v0.9.0',
      name: 'ELKS 0.9.0',
      prerelease: false,
    });
    expect(releases[0]?.assets.map((a) => a.name)).toEqual([
      'fd1440-fat.img',
      'hd32-fat.img',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('api.github.com/repos/ghaerr/elks/releases');
  });

  it('includes up to N most recent prereleases when toggled on, alongside latest stable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockJsonResponse([
        mockRelease({ tag_name: 'v0.9.1-rc2', published_at: '2026-04-01T00:00:00Z', prerelease: true }),
        mockRelease({ tag_name: 'v0.9.1-rc1', published_at: '2026-03-25T00:00:00Z', prerelease: true }),
        mockRelease({ tag_name: 'v0.9.0', published_at: '2026-03-21T00:00:00Z' }),
        mockRelease({ tag_name: 'v0.9.0-rc1', published_at: '2026-03-15T00:00:00Z', prerelease: true }),
        mockRelease({ tag_name: 'v0.8.1', published_at: '2024-10-16T00:00:00Z' }),
      ]),
    ));

    const list = await listReleases({ includePrereleases: true, prereleaseLimit: 5 });
    // Latest stable (v0.9.0) + 3 prereleases (rc2, rc1, 0.9.0-rc1). Sorted newest-first.
    expect(list.map((r) => r.tag)).toEqual([
      'v0.9.1-rc2',
      'v0.9.1-rc1',
      'v0.9.0',
      'v0.9.0-rc1',
    ]);
  });

  it('caches the parsed list in localStorage and serves from cache on the next call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([mockRelease({ tag_name: 'v0.9.0', published_at: '2026-03-21T00:00:00Z' })]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listReleases({ includePrereleases: false, prereleaseLimit: 5 });
    await listReleases({ includePrereleases: false, prereleaseLimit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cache key differs by option set — toggling prereleases triggers a new fetch', async () => {
    // Each fetch call needs a fresh Response (Response bodies are
    // single-read). mockImplementation returns a new one per invocation.
    const buildResponse = () => mockJsonResponse([
      mockRelease({ tag_name: 'v0.9.1-rc1', published_at: '2026-03-25T00:00:00Z', prerelease: true }),
      mockRelease({ tag_name: 'v0.9.0', published_at: '2026-03-21T00:00:00Z' }),
    ]);
    const fetchMock = vi.fn().mockImplementation(async () => buildResponse());
    vi.stubGlobal('fetch', fetchMock);

    await listReleases({ includePrereleases: false, prereleaseLimit: 5 });
    await listReleases({ includePrereleases: true, prereleaseLimit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cache TTL: a stale entry triggers a refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([mockRelease({ tag_name: 'v0.9.0', published_at: '2026-03-21T00:00:00Z' })]),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Manually plant a stale cache entry — fetchedAt = 11 minutes ago.
    const stale = {
      fetchedAt: Date.now() - 11 * 60 * 1000,
      releases: [{
        tag: 'v-stale',
        name: 'stale',
        publishedAt: 1,
        prerelease: false,
        body: '',
        assets: [],
      }],
    };
    localStorage.setItem('emu86.github-releases.v1.pre=0.limit=5', JSON.stringify(stale));

    const list = await listReleases({ includePrereleases: false, prereleaseLimit: 5 });
    expect(list[0]?.tag).toBe('v0.9.0');  // not the stale entry
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rate-limit (403 with x-ratelimit-remaining=0) surfaces as RateLimitError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '60',
          'x-ratelimit-reset': '9999999999',
        },
      }),
    ));

    await expect(
      listReleases({ includePrereleases: false, prereleaseLimit: 5 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('non-rate-limit 403 surfaces as a plain Error (not RateLimitError)', async () => {
    // Fresh Response per call — bodies are single-read.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async () => new Response('{"message":"forbidden"}', { status: 403 }),
    ));
    await expect(
      listReleases({ includePrereleases: false, prereleaseLimit: 5 }),
    ).rejects.toThrow(/403/);
    // Should NOT be a RateLimitError.
    await expect(
      listReleases({ includePrereleases: false, prereleaseLimit: 5 }),
    ).rejects.not.toBeInstanceOf(RateLimitError);
  });

  it('network failure (fetch throws) surfaces as a clear error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(
      listReleases({ includePrereleases: false, prereleaseLimit: 5 }),
    ).rejects.toThrow(/network\/CORS.*Failed to fetch/);
  });
});

describe('github-releases — downloadAsset', () => {
  it('downloads bytes and resolves to a Uint8Array of the right length', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(data, { status: 200, headers: { 'content-length': '8' } }),
    ));

    const out = await downloadAsset('https://example/asset.img');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('progress callback fires at least once with terminal totals', async () => {
    const data = new Uint8Array(32);
    for (let i = 0; i < data.length; i++) data[i] = i;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(data, { status: 200, headers: { 'content-length': '32' } }),
    ));

    const events: Array<{ loaded: number; total: number | null }> = [];
    const out = await downloadAsset('https://example/asset.img', (p) => events.push({ ...p }));
    expect(out.byteLength).toBe(32);
    expect(events.length).toBeGreaterThanOrEqual(1);
    // Final event reports the full payload size.
    const last = events[events.length - 1]!;
    expect(last.loaded).toBe(32);
    expect(last.total).toBe(32);
  });

  it('non-2xx response surfaces as AssetDownloadError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async () => new Response('not found', { status: 404 }),
    ));
    await expect(downloadAsset('https://example/missing.img')).rejects.toBeInstanceOf(AssetDownloadError);
    try {
      await downloadAsset('https://example/missing.img');
    } catch (err) {
      expect(err).toBeInstanceOf(AssetDownloadError);
      expect((err as AssetDownloadError).status).toBe(404);
    }
  });

  it('network failure surfaces as AssetDownloadError with status 0 and a CORS-aware message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    }));
    try {
      await downloadAsset('https://example/asset.img');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AssetDownloadError);
      expect((err as AssetDownloadError).status).toBe(0);
      expect((err as Error).message).toMatch(/CORS/);
    }
  });
});
