/**
 * Release capture — archive the CURRENTLY LIVE production site under
 * web/public/<stamp>/ before a promotion replaces it.
 *
 *   node scripts/release-capture.mjs            # capture 8086-tab.net
 *   node scripts/release-capture.mjs --force    # overwrite an existing capture
 *
 * Why capture-from-live rather than rebuild-from-git: the first stable
 * build is stamped `9728bb6-dirty` — built from an uncommitted tree, so
 * no checkout can reproduce it. Downloading the served bytes is the only
 * honest archival, and it stays honest for every future version too
 * (what you archive is what users actually ran).
 *
 * What it does:
 *   1. GET the live index.html; discover every /assets/* it references,
 *      plus /elks-serial.img and any source maps the JS mentions.
 *   2. Extract the build stamp from the main JS bundle (the
 *      __EMU86_BUILD__ literal) — the short-hash token names the archive
 *      directory, e.g. web/public/9728bb6-dirty/.
 *   3. Rewrite ABSOLUTE paths in the text files (html/js/css) so the
 *      archive is self-contained under its prefix:
 *        /assets/…           → /<stamp>/assets/…
 *        /elks-serial.img    → /<stamp>/elks-serial.img
 *        /version-history.json → /<stamp>/version-history.json
 *      (`/gh-assets/…` is left alone on purpose — the worker proxy is
 *      shared, version-neutral infrastructure. Binary files and source
 *      maps are stored byte-identical.)
 *   4. Prepend the release to web/public/version-history.json — the
 *      manifest main.ts reads to render the subtle previous-version
 *      link. web/public/ is vite's publicDir, so archives ride into
 *      dist-web on every build from then on.
 *
 * No dependencies; Node's global fetch. See RELEASE_PROCEDURE.md.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = resolve(ROOT, 'web/public');
const ORIGIN = process.env.CAPTURE_ORIGIN ?? 'https://8086-tab.net';
const FORCE = process.argv.includes('--force');

async function fetchBytes(path) {
  const url = `${ORIGIN}${path}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const text = (bytes) => new TextDecoder().decode(bytes);

function rewrite(source, stamp) {
  // Only ABSOLUTE paths get the archive prefix. Relative refs
  // (./assets/…, sourceMappingURL, worker new URL()) already resolve
  // inside the archive and must be left alone: a blind replaceAll
  // matched the /assets/ inside ./assets/, and a page served AT
  // /<stamp>/ resolved the result to /<stamp>/<stamp>/… — the 404s
  // Jonathan field-hit on the first archive (2026-07-15).
  return source
    .replace(/(?<!\.)\/assets\//g, `/${stamp}/assets/`)
    .replace(/(?<!\.)\/elks-serial\.img/g, `/${stamp}/elks-serial.img`)
    .replace(/(?<!\.)\/version-history\.json/g, `/${stamp}/version-history.json`);
}

const indexBytes = await fetchBytes('/');
const indexHtml = text(indexBytes);
console.log(`fetched ${ORIGIN}/ (${indexBytes.byteLength} B)`);

// Discover referenced assets (old builds may differ structurally from
// today's — parse THEIR html, assume nothing).
const assetPaths = [...new Set(
  [...indexHtml.matchAll(/\/assets\/[\w.-]+/g)].map((m) => m[0]),
)];
if (assetPaths.length === 0) throw new Error('no /assets/ references found in live index.html');

const files = new Map(); // repo-relative path under the archive dir → bytes
let stampToken = null;
let fullStamp = null;

// Work-queue: fetched JS can reveal more files — the WORKER bundle is
// referenced RELATIVELY from inside the main JS (`new URL("worker-….js",
// import.meta.url)`), never from index.html. Relative refs need no path
// rewriting (they resolve inside the archive by construction); they just
// need the bytes to exist there.
const queue = [...assetPaths];
const seen = new Set(queue);
while (queue.length > 0) {
  const path = queue.shift();
  let bytes;
  try {
    bytes = await fetchBytes(path);
  } catch (err) {
    console.log(`(skipping ${path}: ${String(err)})`);
    continue;
  }
  console.log(`fetched ${path} (${bytes.byteLength} B)`);
  files.set(path.slice(1), bytes); // strip leading '/'
  if (!path.endsWith('.js')) continue;

  const js = text(bytes);
  // The __EMU86_BUILD__ literal: `<shorthash>[-dirty] · <date> <time>Z`
  const m = js.match(/([0-9a-f]{7,12}(?:-dirty)?) · \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z/);
  if (m !== null && stampToken === null) {
    stampToken = m[1];
    fullStamp = m[0];
  }
  const dir = path.slice(0, path.lastIndexOf('/'));
  // Source maps + relatively-referenced chunks (worker bundles) ride
  // along. `new URL("x.js", import.meta.url)` and sourceMappingURL are
  // both same-directory relative names.
  const relRefs = [
    ...[...js.matchAll(/new URL\("([\w.-]+\.js)"/g)].map((r) => r[1]),
    ...[...js.matchAll(/sourceMappingURL=([\w.-]+\.map)/g)].map((r) => r[1]),
  ];
  for (const rel of relRefs) {
    const relPath = `${dir}/${rel}`;
    if (!seen.has(relPath)) {
      seen.add(relPath);
      queue.push(relPath);
    }
  }
}
if (stampToken === null) {
  throw new Error('could not find a build stamp in any live JS bundle — refusing to guess an archive name');
}
console.log(`live build stamp: "${fullStamp}" → archive /${stampToken}/`);

// The bundled boot image the old JS references absolutely.
try {
  files.set('elks-serial.img', await fetchBytes('/elks-serial.img'));
  console.log('fetched /elks-serial.img');
} catch {
  console.log('(no /elks-serial.img on the live site — skipping)');
}

// Builds from 168e0c4 on fetch /version-history.json for the header
// link; rewrite() points that at /<stamp>/version-history.json, so the
// manifest AS THE LIVE SITE SERVED IT must be frozen into the archive —
// otherwise the archived header silently loses its previous-version
// link (main.ts is deliberately best-effort). Older builds never fetch
// it; no live manifest just means nothing to freeze. Stored verbatim:
// its /<oldstamp>/ paths point at root-level archives, which is correct
// from anywhere.
let liveManifest = null;
try {
  liveManifest = await fetchBytes('/version-history.json');
  console.log('fetched /version-history.json (frozen into the archive)');
} catch {
  console.log('(no /version-history.json on the live site — pre-history build, nothing to freeze)');
}

const archiveDir = resolve(PUBLIC_DIR, stampToken);
if (existsSync(archiveDir) && !FORCE) {
  throw new Error(`${archiveDir} already exists — rerun with --force to overwrite`);
}

// Write, rewriting text files so the archive self-contains under its prefix.
mkdirSync(resolve(archiveDir, 'assets'), { recursive: true });
const isText = (p) => p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css');
writeFileSync(resolve(archiveDir, 'index.html'), rewrite(indexHtml, stampToken));
for (const [relPath, bytes] of files) {
  const out = resolve(archiveDir, relPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, isText(relPath) ? rewrite(text(bytes), stampToken) : bytes);
}
if (liveManifest !== null) {
  writeFileSync(resolve(archiveDir, 'version-history.json'), liveManifest);
}

// Manifest: newest first. main.ts renders entry [0] as the subtle link.
const manifestPath = resolve(PUBLIC_DIR, 'version-history.json');
const history = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : [];
const filtered = history.filter((e) => e.stamp !== stampToken);
filtered.unshift({
  stamp: stampToken,
  bootStamp: fullStamp,
  path: `/${stampToken}/`,
  archivedAt: new Date().toISOString(),
});
writeFileSync(manifestPath, JSON.stringify(filtered, null, 2) + '\n');

console.log(`\narchived ${files.size + 1} files under web/public/${stampToken}/`);
console.log(`manifest: web/public/version-history.json (${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'})`);
console.log('next: npm run build:browser (archive rides publicDir), verify, then deploy:prod.');
