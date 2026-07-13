/**
 * Cloudflare Worker for 8086-tab.net (Phase 14 deployment shape).
 *
 * Two jobs:
 *
 *   1. **Serve `dist-web`** — the static browser harness. Handled by the
 *      assets binding (`wrangler.jsonc` → `assets.directory`); requests
 *      that match a file never reach this code.
 *   2. **`/gh-assets/…` — a deliberately narrow CORS proxy** for ELKS
 *      release images. The GitHub asset CDN
 *      (release-assets.githubusercontent.com) sends no
 *      Access-Control-Allow-Origin header (Phase 9.3 diagnosis), so the
 *      browser cannot fetch the 31 MB HD images directly; static hosting
 *      can't carry them either (Pages caps files at 25 MB). This proxy
 *      is the brief's chosen remedy.
 *
 * Scope policy (the networking plan explicitly rejected a general
 * host-side proxy): only `GET`/`HEAD`, only paths of the form
 * `/gh-assets/ghaerr/elks/releases/download/<tag>/<file>.img` — i.e.
 * exactly the assets the image library lists. Widening this (e.g. for
 * the M3d HTTP gateway) is a deliberate decision to make then, not a
 * config knob.
 *
 * The web app falls back to this path only when a direct CDN fetch
 * fails (`web/github-releases.ts`), so dev servers and CORS-lenient
 * browsers never touch it. Release assets are immutable per tag, so
 * upstream responses are edge-cached for a day.
 */

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetsBinding;
}

const PROXY_PREFIX = '/gh-assets/';
const ALLOWED_PATH = /^ghaerr\/elks\/releases\/download\/[^/]+\/[\w.-]+\.img$/;
const UPSTREAM_BASE = 'https://github.com/';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD',
  'access-control-expose-headers': 'content-length, content-type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PROXY_PREFIX)) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('GET/HEAD only\n', { status: 405, headers: CORS_HEADERS });
    }

    const assetPath = url.pathname.slice(PROXY_PREFIX.length);
    if (!ALLOWED_PATH.test(assetPath)) {
      return new Response(
        'This proxy serves ghaerr/elks release .img assets only\n',
        { status: 403, headers: CORS_HEADERS },
      );
    }

    // Immutable release assets: let the edge cache the upstream fetch.
    const init: RequestInit & { cf?: Record<string, unknown> } = {
      method: request.method,
      cf: { cacheEverything: true, cacheTtl: 86_400 },
    };
    const range = request.headers.get('range');
    if (range !== null) {
      init.headers = { range };
    }

    const upstream = await fetch(`${UPSTREAM_BASE}${assetPath}`, init);

    const headers = new Headers(CORS_HEADERS);
    for (const name of ['content-length', 'content-type', 'content-range', 'accept-ranges', 'etag']) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('cache-control', 'public, max-age=86400, immutable');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
