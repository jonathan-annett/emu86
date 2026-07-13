/**
 * GitHub releases fetcher for ghaerr/elks.
 *
 * Two surface functions:
 *   - listReleases({ includePrereleases, prereleaseLimit }) → GitHubRelease[]
 *   - downloadAsset(url, onProgress?)                       → Uint8Array
 *
 * Cache:
 *   The release list is cached in localStorage with a 10-minute TTL. The
 *   key includes the option set so toggling "Show prereleases" doesn't
 *   serve stale data. Asset bytes are NOT cached here — once downloaded
 *   they live in the image library, which is the canonical store. A user
 *   re-downloading the same asset gets a new library entry.
 *
 * No authentication. Per-IP rate limit is 60 req/hr against api.github.com;
 * asset downloads do NOT consume API quota (they're served from a separate
 * CDN). Hitting the limit surfaces a `RateLimitError` so the UI can show a
 * specific message instead of a generic "fetch failed".
 *
 * CORS:
 *   - api.github.com returns `access-control-allow-origin: *` — fine.
 *   - asset CDN (release-assets.githubusercontent.com) does NOT return ACAO
 *     headers (verified Phase 9.3 diagnosis). A browser fetch in cors mode
 *     SHOULD therefore fail — but real-world behaviour is browser-version
 *     dependent. We attempt the fetch, and when it throws we retry once
 *     through the same-origin `/gh-assets/` CORS proxy that the production
 *     worker serves (deploy/cf-worker.ts; the vite dev server mirrors it).
 *     Only if both fail do we surface the diagnostic error, and the user
 *     can then fall back to the manual upload path.
 *
 * Phase 9.2 forward-compat: the image library's `source: 'upload' | 'github'`
 * discriminator landed in 9.2 specifically so 9.3 can write `'github'`-
 * tagged entries without an IDB migration.
 */

const RELEASES_API_URL = 'https://api.github.com/repos/ghaerr/elks/releases';
const CACHE_KEY_PREFIX = 'emu86.github-releases.v1';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

export interface GitHubRelease {
  /** e.g. 'v0.9.0' */
  tag: string;
  /** Human-readable release title; falls back to tag if API returns null. */
  name: string;
  /** ms since epoch — Date.parse of the API's ISO string. */
  publishedAt: number;
  prerelease: boolean;
  /** Release notes; markdown — we don't render it, just `<pre>` it. */
  body: string;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  /** Filename. e.g. 'fd1440-fat.img'. */
  name: string;
  sizeBytes: number;
  /** Browser-fetchable URL (the `browser_download_url`). */
  downloadUrl: string;
}

export interface ListOptions {
  /** Include prereleases. Default false. */
  includePrereleases: boolean;
  /** When includePrereleases is true, cap the prereleases at this many. */
  prereleaseLimit: number;
}

export interface DownloadProgress {
  /** Bytes received so far. */
  loaded: number;
  /**
   * Expected total bytes if known (from Content-Length). Null when the
   * server omits the header (rare for this CDN; documented for safety).
   */
  total: number | null;
}

/** Thrown when the GitHub API responds with 403 + rate-limit metadata. */
export class RateLimitError extends Error {
  /** UNIX seconds when the limit window resets. */
  readonly resetAtSeconds: number;
  /** Per-window cap (typically 60 unauthenticated). */
  readonly limit: number;
  constructor(message: string, limit: number, resetAtSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
    this.limit = limit;
    this.resetAtSeconds = resetAtSeconds;
  }
}

/** Thrown when fetching an asset fails (CORS, network, 4xx, 5xx). */
export class AssetDownloadError extends Error {
  /** HTTP status if the request reached the server; 0 for network/CORS errors. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AssetDownloadError';
    this.status = status;
  }
}

interface CachedReleases {
  fetchedAt: number;
  releases: GitHubRelease[];
}

interface RawAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface RawRelease {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  prerelease: boolean;
  body: string | null;
  assets: RawAsset[];
}

/**
 * Fetch the release list (and parse it into our shape) with a short
 * localStorage cache. Cache key includes the option set so opting into
 * prereleases isn't served from a stable-only cache slot.
 *
 * Pagination: the API returns 30 per page by default; ghaerr/elks has well
 * under 30 releases as of 2026-04, so a single page is enough. If the cap
 * ever stops being adequate, callers can set a larger `per_page`; we just
 * don't bother today.
 */
export async function listReleases(opts: ListOptions): Promise<GitHubRelease[]> {
  const cacheKey = makeCacheKey(opts);
  const cached = readCache(cacheKey);
  if (cached) return cached.releases;

  const url = `${RELEASES_API_URL}?per_page=30`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
  } catch (err) {
    throw new Error(
      `GitHub API fetch failed (network/CORS): ${describeError(err)}`,
    );
  }

  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    const limit = res.headers.get('x-ratelimit-limit');
    if (remaining === '0' && reset !== null) {
      throw new RateLimitError(
        `GitHub API rate limit exceeded (${limit ?? '?'}/hr). Resets at ${formatResetTime(Number(reset))}.`,
        Number(limit ?? '60'),
        Number(reset),
      );
    }
    throw new Error(`GitHub API returned 403: ${await safeText(res)}`);
  }

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${await safeText(res)}`);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new Error(`GitHub API returned invalid JSON: ${describeError(err)}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error('GitHub API: expected an array of releases');
  }

  const releases = parseReleases(raw);
  const filtered = applyPrereleaseFilter(releases, opts);
  writeCache(cacheKey, { fetchedAt: Date.now(), releases: filtered });
  return filtered;
}

/**
 * Stream-fetch an asset. For assets > a few MB the streaming path lets the
 * UI report progress; the alternative (response.arrayBuffer()) gives no
 * visibility until the whole download completes, which is a poor UX for
 * 30+ MB hard-disk images.
 *
 * The CORS situation for the asset CDN is documented at the module top:
 * the failure surface here is the user's UI affordance for that.
 */
export async function downloadAsset(
  url: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const originalError = new AssetDownloadError(
      `Asset fetch failed (network/CORS): ${describeError(err)}. ` +
      `If this is a CORS error, the GitHub asset CDN does not return ` +
      `Access-Control-Allow-Origin headers; falling back to the manual upload ` +
      `flow is the supported path.`,
      0,
    );
    // CORS/network failure: retry once through the same-origin proxy
    // (production worker / vite dev proxy). A host without the proxy
    // 404s, and the original error is the one worth surfacing.
    const proxied = proxyAssetUrl(url);
    if (proxied === null) throw originalError;
    try {
      res = await fetch(proxied);
    } catch {
      throw originalError;
    }
    if (!res.ok) throw originalError;
  }
  if (!res.ok) {
    throw new AssetDownloadError(
      `Asset fetch returned HTTP ${res.status} ${res.statusText}`,
      res.status,
    );
  }

  const totalHeader = res.headers.get('content-length');
  const total = totalHeader !== null ? Number(totalHeader) : null;

  // Prefer streaming if response.body is exposed and a progress callback was
  // requested. The fallback path (arrayBuffer) is here for Node/test envs
  // where ReadableStream may not be wired up — and for callers that don't
  // care about progress (the cost of buffering once is negligible).
  if (onProgress && res.body && typeof res.body.getReader === 'function') {
    return await readWithProgress(res.body.getReader(), total, onProgress);
  }
  const buf = await res.arrayBuffer();
  if (onProgress) {
    // Fire one terminal event so the UI can flip from "0 / N" to "N / N".
    onProgress({ loaded: buf.byteLength, total });
  }
  return new Uint8Array(buf);
}

/**
 * Same-origin proxy URL for a GitHub release download, or null when the
 * URL isn't a github.com download or there's no http(s) origin to be
 * same-origin with (tests, file: pages). `/gh-assets/<path>` is served
 * by the production worker (deploy/cf-worker.ts) and mirrored by the
 * vite dev server; unknown hosts simply 404 and the caller keeps the
 * original error.
 */
export function proxyAssetUrl(downloadUrl: string): string | null {
  const GITHUB_PREFIX = 'https://github.com/';
  if (!downloadUrl.startsWith(GITHUB_PREFIX)) return null;
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) {
    return null;
  }
  return `/gh-assets/${downloadUrl.slice(GITHUB_PREFIX.length)}`;
}

async function readWithProgress(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  total: number | null,
  onProgress: (p: DownloadProgress) => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  // Throttle progress events so a fast download doesn't queue thousands of
  // DOM updates. 64 KB or 100 ms whichever comes first.
  const PROGRESS_BYTES = 64 * 1024;
  const PROGRESS_MS = 100;
  let lastEmitted = 0;
  let lastTime = performance.now();

  // Initial event so the UI can transition from "starting…" to "0 / N".
  onProgress({ loaded: 0, total });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      const now = performance.now();
      if (loaded - lastEmitted >= PROGRESS_BYTES || now - lastTime >= PROGRESS_MS) {
        onProgress({ loaded, total });
        lastEmitted = loaded;
        lastTime = now;
      }
    }
  }

  // Final terminal event.
  onProgress({ loaded, total });

  // Concat into a single Uint8Array. Doing this once at the end avoids the
  // O(n²) alloc-and-copy cost of growing a single buffer per chunk.
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Parsing + filtering                                                  */
/* ------------------------------------------------------------------ */

function parseReleases(raw: unknown[]): GitHubRelease[] {
  const out: GitHubRelease[] = [];
  for (const item of raw) {
    if (!isRawRelease(item)) continue;
    const publishedAt = item.published_at ? Date.parse(item.published_at) : 0;
    const assets: GitHubAsset[] = [];
    for (const a of item.assets) {
      if (!isRawAsset(a)) continue;
      // Only surface .img assets — the brief is explicit about this. Other
      // assets (release notes PDFs, source tarballs auto-attached by GitHub,
      // etc.) aren't bootable, so listing them would be noise.
      if (!a.name.endsWith('.img')) continue;
      assets.push({
        name: a.name,
        sizeBytes: a.size,
        downloadUrl: a.browser_download_url,
      });
    }
    out.push({
      tag: item.tag_name,
      name: item.name && item.name.length > 0 ? item.name : item.tag_name,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : 0,
      prerelease: item.prerelease,
      body: item.body ?? '',
      assets,
    });
  }
  // Newest first — the API typically returns this order, but enforce it.
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out;
}

function applyPrereleaseFilter(
  all: GitHubRelease[],
  opts: ListOptions,
): GitHubRelease[] {
  // Always include the latest stable (non-prerelease) — that's the user's
  // default expectation. Then layer on up to N most-recent prereleases if
  // opted in.
  const stables = all.filter((r) => !r.prerelease);
  const latestStable = stables.length > 0 ? [stables[0]!] : [];
  if (!opts.includePrereleases) return latestStable;

  const prereleases = all.filter((r) => r.prerelease).slice(0, opts.prereleaseLimit);

  // Merge and re-sort newest-first so a recent prerelease appears above an
  // older stable (the common case when cutting a new RC).
  const merged = [...latestStable, ...prereleases];
  merged.sort((a, b) => b.publishedAt - a.publishedAt);
  return merged;
}

function isRawRelease(v: unknown): v is RawRelease {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.tag_name === 'string'
    && typeof o.prerelease === 'boolean'
    && Array.isArray(o.assets);
}

function isRawAsset(v: unknown): v is RawAsset {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === 'string'
    && typeof o.size === 'number'
    && typeof o.browser_download_url === 'string';
}

/* ------------------------------------------------------------------ */
/* localStorage cache                                                   */
/* ------------------------------------------------------------------ */

function makeCacheKey(opts: ListOptions): string {
  return `${CACHE_KEY_PREFIX}.pre=${opts.includePrereleases ? 1 : 0}.limit=${opts.prereleaseLimit}`;
}

function readCache(key: string): CachedReleases | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as { fetchedAt?: unknown; releases?: unknown };
  if (typeof obj.fetchedAt !== 'number' || !Array.isArray(obj.releases)) {
    return null;
  }
  if (Date.now() - obj.fetchedAt > CACHE_TTL_MS) return null;
  // Coerce releases through validation — a partial corruption should miss
  // rather than blow up. Cheap to validate vs a network round-trip.
  const releases: GitHubRelease[] = [];
  for (const r of obj.releases) {
    if (isCachedRelease(r)) releases.push(r);
  }
  return { fetchedAt: obj.fetchedAt, releases };
}

function isCachedRelease(v: unknown): v is GitHubRelease {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.tag === 'string'
    && typeof o.name === 'string'
    && typeof o.publishedAt === 'number'
    && typeof o.prerelease === 'boolean'
    && typeof o.body === 'string'
    && Array.isArray(o.assets);
}

function writeCache(key: string, value: CachedReleases): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cache is best-effort. Quota or private-mode failures are fine — the
    // user just pays the network cost on the next call.
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '<no body>';
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatResetTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return 'unknown';
  try {
    return new Date(unixSeconds * 1000).toLocaleTimeString();
  } catch {
    return `${unixSeconds}`;
  }
}
