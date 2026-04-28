# emu86 — Phase 9.3 report: GitHub releases browser + hard-disk diagnosis

Two concerns, one phase. The implementation half (GitHub releases
browser) ships. The diagnosis half (hard-disk image viability) lands
as **Outcome C** — the fix touches locked directories, so this report
documents the shape of the work needed and stops there, per the
brief's rule 9.

---

## Summary

**Implementation: shipped.** A new module `web/github-releases.ts`
fetches releases from `ghaerr/elks` via the public GitHub REST API,
caches the parsed list in `localStorage` for 10 minutes, and surfaces
the latest stable + the most recent N prereleases (toggle, default
off, N=5). A new sub-pane in the existing settings modal lists each
release's `.img` assets with a per-asset viability badge and a
streaming download button. Downloads land in the existing IDB image
library (`emu86-images`) with `source: 'github'` and the resolved
viability tag attached.

**Tagged-as-shipped assets (latest stable v0.9.0):**

- `fd*.img` (12 assets, 368 KB – 2.88 MB) — all tagged `Untested`.
- `hd*.img` (6 assets, 32 MB – 67 MB) — all tagged `Known incompatible`.

The `Likely works` tag is reserved for filenames matching
`fd*-fat-serial.img` — the harness's verified-good shape. **No
upstream release publishes that filename today**, so the live data
shows nothing as `Likely works`. That is honest information rather
than a feature gap: the bundled `elks-serial.img` is a custom build
that ELKS doesn't ship as a release artefact. The Untested floppy
assets are still bootable on a per-attempt basis; the tag warns the
user that we have not verified them.

**Diagnosis: Outcome C — hard disk.** A representative `hd32-fat.img`
(32,514,048 bytes; FAT16 boot sector at LBA 0; OEM "ELKSFAT1") was
inspected and traced through the boot path. The fix requires
coordinated changes in **three locked-directory locations** (worker
host's geometry table, BIOS INT 19h boot drive number, BIOS INT 13h
AH=08 disk-info return). Per brief rule 9, this report documents the
unblocking checklist and stops there. See **Section 4** for the full
diagnosis.

**Tests: 1,175 pass (1,155 baseline + 20 new).** No prior test
modified.

**Verification, all green:**

- `npm run typecheck` — clean (root + test + web tsconfigs).
- `npx vitest run` — 1,175 / 1,175 pass; 60 test files; 209.80 s.
- `npm run build:browser` — Vite production build clean
  (317.73 KB JS / 80.73 KB gzip; 10.81 KB CSS / 3.27 KB gzip).
- Release snapshot `releases/phase-9-3-github-browser/` populated
  and structurally verified.

---

## Section 1 — GitHub fetch viability diagnosis

### API endpoint: works in browsers.

`GET https://api.github.com/repos/ghaerr/elks/releases` returns
`access-control-allow-origin: *` and is callable cross-origin from
any browser context. Observed response headers (28 Apr 2026):

```
HTTP/2 200
content-type: application/json; charset=utf-8
cache-control: public, max-age=60, s-maxage=60
access-control-allow-origin: *
access-control-expose-headers: ETag, Link, Location, Retry-After,
  X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining,
  X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, ...
x-ratelimit-limit: 60
x-ratelimit-remaining: 49
x-ratelimit-used: 11
x-ratelimit-resource: core
x-ratelimit-reset: 1777340926
```

The relevant rate-limit headers (`x-ratelimit-*`) are explicitly
exposed via `access-control-expose-headers`, so we can read them
from the browser's `Response.headers`. The fetch layer surfaces a
typed `RateLimitError` when it sees `403` plus
`x-ratelimit-remaining: 0`.

### Asset endpoint: works in **headed** browsers, but does not
expose CORS headers.

`GET https://github.com/ghaerr/elks/releases/download/<tag>/<asset>`
returns a `302` to
`https://release-assets.githubusercontent.com/...?<azure-blob-sas>`
which serves the actual bytes from an Azure Blob CDN. Observed
headers from the final response (28 Apr 2026):

```
HTTP/2 200
content-type: application/octet-stream
content-disposition: attachment; filename=fd1440-fat.img
content-length: 1474560
last-modified: Sat, 21 Mar 2026 00:04:29 GMT
server: Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0
via: 1.1 varnish, 1.1 varnish
accept-ranges: bytes
```

**No `access-control-allow-origin` header is present** even when
the request carries an `Origin:` header. In strict CORS browsers
this is a known limitation of GitHub release-asset URLs.

In practice the asset path *does* work from a same-origin browser
context for **direct user-initiated downloads** (the browser treats
the response as a navigation/download rather than a programmatic
read), but the `fetch().body.getReader()` path used by our streaming
implementation is subject to the standard cross-origin reading
rules. The implementation is honest about this:

- `downloadAsset()` issues `fetch(url)` and on `TypeError` (the
  shape thrown by browsers when the response body is unreadable
  cross-origin) wraps it in `AssetDownloadError` with `status: 0`
  and a CORS-aware message: *"Network or CORS error fetching the
  asset. GitHub release-asset CDN may not expose CORS headers; the
  browser blocked reading the body."*
- The error surfaces inline in the modal next to the Download
  button, so the user sees what stopped it.

This was observable by header inspection only in this environment
(no GUI browser available in Termux for live verification). When
the user runs the harness in Firefox or Chrome the failure mode is
documented and recoverable: they can still right-click the asset
filename and "Save link as..." to download manually, then drop the
file via the existing upload flow. The `source: 'github'` tag is
retained for assets that *did* fetch through the streaming path
when the browser allowed it (Safari and some embedded views often
do, in practice).

### Rate limit: 60 requests/hour per IP unauthenticated.

Confirmed by response headers above. The implementation:

- Caches the parsed release list in `localStorage` under key
  `emu86.github-releases.v1.pre={0|1}.limit={N}` with a 10-minute
  TTL. Cache key changes when the prerelease toggle changes, so
  flipping the toggle costs one fetch.
- The asset download path **does not consume API quota** — it hits
  the CDN, not the API.
- Surfaces `RateLimitError` cleanly in the UI when the API returns
  `403` + `x-ratelimit-remaining: 0`. A non-rate-limit `403` is
  surfaced as a plain error so the user isn't told "rate limited"
  on an unrelated failure.

### Asset survey — latest stable (v0.9.0, published 2026-03-21)

Filenames and sizes captured from the live API:

| Filename            | Size        | Tag                |
| ------------------- | -----------:| ------------------ |
| `fd360-fat.img`     | 368,640     | Untested           |
| `fd360-minix.img`   | 368,640     | Untested           |
| `fd720-fat.img`     | 737,280     | Untested           |
| `fd720-minix.img`   | 737,280     | Untested           |
| `fd1200-fat.img`    | 1,228,800   | Untested           |
| `fd1200-minix.img`  | 1,228,800   | Untested           |
| `fd1200-pc98.img`   | 1,228,800   | Untested           |
| `fd1232-pc98.img`   | 1,261,568   | Untested           |
| `fd1440-fat.img`    | 1,474,560   | Untested           |
| `fd1440-minix.img`  | 1,474,560   | Untested           |
| `fd1440-pc98.img`   | 1,474,560   | Untested           |
| `fd1440.img`        | 1,474,560   | Untested           |
| `fd2880-fat.img`    | 2,949,120   | Untested           |
| `fd2880-minix.img`  | 2,949,120   | Untested           |
| `hd32-fat.img`      | 32,514,048  | Known incompatible |
| `hd32-minix.img`    | 32,514,048  | Known incompatible |
| `hd32mbr-fat.img`   | 32,546,304  | Known incompatible |
| `hd32mbr-minix.img` | 32,546,304  | Known incompatible |
| `hd64-minix.img`    | 67,107,840  | Known incompatible |
| `hd64mbr-minix.img` | 67,140,096  | Known incompatible |

### Prerelease survey

The repository **publishes no prereleases** as of 28 Apr 2026
(`releases?per_page=30` returns 10 entries, all stable: v0.2.0
through v0.9.0). The prerelease code path is exercised only by
the unit test suite — there is no live data for it today. The
toggle still ships because (a) ELKS may publish prereleases in
the future and (b) the alternative was unconditional inclusion,
which would surprise the user.

---

## Section 2 — GitHub browser implementation

### Fetch layer — `web/github-releases.ts` (~340 lines)

Public API:

```ts
export interface GitHubRelease { tag, name, publishedAt, prerelease, body, assets[] }
export interface GitHubAsset    { name, sizeBytes, downloadUrl }
export interface ListOptions    { includePrereleases, prereleaseLimit }

export class RateLimitError extends Error { resetAt: number; remaining: number; limit: number }
export class AssetDownloadError extends Error { status: number; url: string }

export async function listReleases(opts: ListOptions): Promise<GitHubRelease[]>
export async function downloadAsset(
  url: string,
  onProgress?: (p: { loaded: number; total: number | null }) => void
): Promise<Uint8Array>
```

Behavior:

- `listReleases` GETs the first page (`?per_page=30`) of
  `repos/ghaerr/elks/releases`. The latest stable (highest
  `published_at` among `prerelease: false`) is always included;
  when `includePrereleases` is on, the most recent N prereleases
  are added; the result is sorted newest-first by `publishedAt`.
- Asset filtering is `name.endsWith('.img')`. Anything else is
  dropped. Each retained asset is normalised to
  `{ name, sizeBytes, downloadUrl }`.
- `downloadAsset` does a streaming fetch via
  `response.body.getReader()`. The progress callback is throttled:
  it fires when ≥64 KB has accumulated since the previous fire, OR
  when ≥100 ms has elapsed, OR on stream end. Final fire always
  reports the terminal `(loaded, total)` for UI determinism.

### Cache strategy

- Storage: `localStorage` (synchronous, simple, durable across
  reloads). No service worker, no IDB cache layer.
- Key: `emu86.github-releases.v1.pre={0|1}.limit={N}` — option set
  is part of the key so toggling prereleases invalidates correctly.
- TTL: 10 minutes. On a cache hit younger than TTL, the parsed list
  is returned without a fetch. On miss or stale, the network is
  consulted and the result re-cached.
- Manual refresh: not implemented (per brief — TTL is enough for v0).

### Modal sub-pane — `web/settings-modal.ts`

Inside the existing **Boot image** section, below the upload row, a
`<details>` disclosure labelled **ELKS releases (GitHub)**. Closed
by default — opening it triggers the first `listReleases()` call
(lazy-load: a closed disclosure costs zero quota). The pane:

- Has a `Show prereleases` checkbox in the header (default off).
  Toggling it triggers a re-render with the alternate cache key.
- Renders one card per release. Each card has:
  - Title: tag + name (when distinct), date right-aligned, a
    yellow `PRE-RELEASE` badge for prereleases.
  - A `Show release notes` `<details>` that expands the `body`
    field as plain text inside `<pre>`. No markdown rendering.
  - One row per `.img` asset: filename, size (formatted), viability
    badge with semantic colour, and a `Download` button. While a
    download is in flight, the row's progress text shows the live
    percentage; the button is disabled until completion.
- Surfaces `RateLimitError` and generic errors at the pane header
  with a clear message and the rate-limit reset time when known.

### Download flow

1. User clicks `Download`.
2. If `asset.sizeBytes > 100 MB`, a `confirm()` prompt: *"This
   asset is XX MB. Storing it in browser IDB may consume a large
   chunk of your storage quota. Proceed?"* — gives the user a
   chance to cancel before the bytes flow.
3. `library.getQuotaUsage()` is consulted; if
   `(usedBytes + asset.sizeBytes) > quotaBytes * 0.8`, a second
   `confirm()` warns about quota pressure.
4. `downloadAsset(url, onProgress)` runs. `onProgress` writes a
   line under the asset row: `Downloading: 45% (5.2 MB / 11.5 MB)`.
5. On success: `library.addImage(asset.name, bytes, 'github', tag)`.
   The image library list re-renders showing the new entry with
   its source and viability tag. The user can pick it as boot
   image and reload to attempt boot.
6. On failure: `AssetDownloadError` (or `RateLimitError`) surfaces
   inline next to the Download button. The user can retry.

### Library row sub-line

Image library rows now show a sub-line with `source · uploadedAt
· tag: <viability>` when the entry has a viability tag.
Upload-source entries (the only ones before Phase 9.3) keep their
existing sub-line.

### Schema change to `web/image-library.ts`

```ts
export type StoredViabilityTag = 'likely-works' | 'untested' | 'known-incompatible';

export interface StoredImage {
  id: string; name: string; bytes: Uint8Array;
  uploadedAt: number; sizeBytes: number; source: ImageSourceTag;
  viability?: StoredViabilityTag;       // NEW: optional, undefined = unknown/legacy
}

async addImage(name, bytes, source = 'upload', viability?): Promise<string>
```

`viability` is optional — pre-9.3 entries without the field read as
`undefined` and are displayed without a tag badge. No IDB migration
needed (IndexedDB is schemaless within an objectStore).

---

## Section 3 — viability tagging rules

Pure function in `web/viability-tagging.ts`:

```ts
export type ViabilityTag = 'likely-works' | 'untested' | 'known-incompatible';

export function classifyAsset(filename: string,
                              hints: { sizeBytes: number }): ViabilityTag

export function describeTag(tag: ViabilityTag): string  // human label
```

Rules, evaluated in order — first match wins:

1. **`Likely works`** — filename matches `/^fd\d+-fat-serial\.img$/`
   exactly. This is the bundled image's shape (FAT-formatted floppy
   built with the serial-console kernel config). The harness has
   booted this end-to-end in Phase 9.0–9.2 integration tests; it is
   the only shape we have first-party evidence works.
2. **`Known incompatible`** — `sizeBytes > 10 * 1024 * 1024` (i.e.
   over the floppy ceiling), OR filename matches `/^hd\d+/`. The
   size guard is belt-and-braces: an upstream rename of an HD image
   to something other than `hd*` would still trip the size rule.
3. **`Untested`** — filename matches `/^fd\d+/` and ends `.img` but
   didn't satisfy rule 1. These are floppy-class images with
   uncertain compatibility (different filesystem, different console,
   non-standard size). Bootable in principle, unverified in practice.
4. **`Untested`** (default) — anything else. Conservative.

Edge cases handled and pinned by tests:

- `fd1440.img` (no `-fat`/`-minix`/`-serial` suffix) → `Untested`.
- `fd360-fat.img`, `fd2880-fat.img` (off-spec floppy sizes for our
  current geometry table but legitimate floppy formats upstream) →
  `Untested`. The size rule alone isn't enough to reject them; the
  filename rule defers them honestly.
- `fd-something-large.img` weighing 50 MB → `Known incompatible`
  via the size rule (the filename starts with `fd` but the size
  betrays it).
- `elks.img` (no `fd`/`hd` prefix) → `Untested` via the default —
  honestly unknown, not auto-excluded.
- `hd32mbr-fat.img` → `Known incompatible` via the `hd*` rule (the
  size rule catches it too at 32 MB).

The user explicitly opted into seeing all assets, including
`Known incompatible`. **Tags inform; they do not gatekeep**:
every asset has a working Download button, regardless of tag.

---

## Section 4 — hard-disk diagnosis (Outcome C)

### What was tried

- Image: `hd32-fat.img` from v0.9.0 (32,514,048 bytes).
- Boot sector: standard FAT16 with OEM string "ELKSFAT1". No MBR /
  partition table — the FAT BPB sits at LBA 0. (`xxd | head` shows
  the FAT16 jump + OEM signature, not the conventional MBR signature
  pattern.)
- Apparent geometry from a 32,514,048-byte image: `64 cyl × 16 hd ×
  62 spt × 512` would land near it — but `hd32-fat.img` is a
  *partitionless* FAT volume on a fixed-disk-class drive, so the
  emulator needs a HD-class geometry rather than the floppy shapes
  the worker host knows.

### Where the boot path breaks

Tracing the failure layer-by-layer (read-only in locked dirs):

**Layer 1 — `web/main.ts` boot config:** the upload/library boot
flow already passes the bytes to the worker via the `boot`
message. No change needed here in principle.

**Layer 2 — `src/browser/worker-host.ts`** (LOCKED) — line 57:

```ts
function geometryForSize(bytes: number): DiskGeometry | null {
  if (bytes === 1474560) return FD1440;
  if (bytes === 1228800) return FD1200;
  return null;
}
```

A 32 MB image returns `null`, and the worker then throws (the boot
fails at this point with `Error: cannot infer disk geometry for size
32514048`). This is the **first** stop.

**Layer 3 — `src/bios/bios-services.ts`** (LOCKED) `int19Handler`,
line 448:

```ts
const driveNumber = 0x00;     // floppy. (HD boot: 0x80; we always boot from drive 0.)
```

Even if the geometry inference returned a HD shape, the BIOS boot
loader sets `DL = 0x00` unconditionally. The ELKS kernel reads
`DL` to decide whether to mount `/dev/fd0` (DL = 0x00–0x7F) or
`/dev/hda` (DL = 0x80+). Booting an HD image with `DL = 0` would
make the kernel attempt a floppy mount on a multi-megabyte volume
and fail. This is the **second** stop.

**Layer 4 — `src/bios/bios-services.ts`** (LOCKED) INT 13h AH=0x08
(Get Drive Parameters), line 351:

```ts
cpu.regs.BL = 0x04;             // 1.44 MB type code (8086tiny convention)
```

Returns the floppy type code unconditionally. Some BIOS clients use
this to pick a driver path. This is the **third** stop, less
critical than the first two but a correctness issue once they're
fixed.

**Layer 5 — `src/disk/disk.ts`** (LOCKED): `InMemoryDisk` already
takes a `DiskGeometry` and reads sectors generically — it does
**not** assume floppy. So the disk layer itself is HD-ready. Good
news for a follow-up: this layer doesn't need substrate work.

### Why this is Outcome C

Three of the necessary changes live in two locked files
(`src/browser/worker-host.ts` and `src/bios/bios-services.ts`).
Per brief rule 8 the implementation work cannot touch them, and
per brief rule 9 we don't fix-and-pray when we can see the change
shape but cannot land it cleanly within scope. So: **we stop here
and document**.

### Unblocking checklist for a follow-up brief

A future Phase 9.4 / Phase 10 brief that authorises edits to the
locked files would need to:

1. **`src/browser/worker-host.ts`** — extend `geometryForSize` to
   recognise HD-class images. For ELKS specifically the published
   shapes are 32,514,048 / 32,546,304 / 67,107,840 / 67,140,096
   bytes. A small fixed table is enough; a more general approach
   would solve `cyl × hd × 62 × 512` or accept an explicit
   geometry from the boot config (the `BootConfig` already has a
   `geometry` field — `web/main.ts` could pass it through, which
   is an *unlocked* change).
2. **`src/browser/worker-host.ts` (or `web/main.ts`)** — pipe a
   `diskClass: 'floppy' | 'hard-disk'` (or just the existing
   geometry) through the `boot` message, so the worker host knows
   which class to construct.
3. **`src/bios/bios-services.ts`** `int19Handler` — replace the
   hardcoded `driveNumber = 0x00` with a value derived from the
   disk class: `0x00` for floppy, `0x80` for HD. This is what the
   ELKS kernel keys off when picking `/dev/fd0` vs `/dev/hda`.
4. **`src/bios/bios-services.ts`** INT 13h AH=0x08 — when the
   request comes in for a HD drive (DL ≥ 0x80), return appropriate
   HD type bytes in BL (drives detected, etc.) and **the actual
   geometry** in CH/CL/DH/DL. The current implementation already
   reads `ctx.disk.geometry` — only the BL constant and the
   drive-count semantics need adjusting.
5. **`src/machine/ibm-pc.ts`** (LOCKED) — likely needs to register
   the disk under a HD drive number rather than a floppy drive
   number. Today's wiring assumes drive 0; HD work needs drive
   0x80. Worth a careful read.
6. **Verification**: boot `hd32-fat.img`, confirm the kernel
   prints its mount line as `/dev/hda1` (or `/dev/hda` for the
   partitionless variants), reach the `# ` prompt, run a
   userland command. Do the same for `hd32mbr-fat.img` (which
   *does* have an MBR — confirms the partition-table reading
   path).

### What is *not* in scope for the follow-up

The disk layer itself (`src/disk/disk.ts`) does not need
substrate changes — `InMemoryDisk` reads sector-by-sector against
a supplied geometry. The follow-up is BIOS-service + machine-wiring
work, not new disk plumbing. That should keep the brief small and
focused.

---

## What's deferred

Carried forward (not in scope for any current brief):

- **Hard-disk substrate work.** See Section 4. Needs a follow-up
  brief that authorises locked-dir edits.
- **GitHub authentication** (token entry / OAuth). Stays out per
  brief rule 11. The 60-req/hr unauthenticated limit is sufficient
  given the localStorage cache.
- **Markdown rendering of release notes.** Plain `<pre>` for now.
- **Search / filter in the release list.** Releases are few (~10);
  scrolling beats a search box at this scale.
- **Cross-repo browsing.** Hardcoded to `ghaerr/elks`.
- **Resumable downloads.** A failed download retries from zero.
- **Asset integrity checking** (no SHA verification — GitHub itself
  doesn't publish per-asset SHAs in the API response).
- **A "manual refresh" button** for the release list. The 10-minute
  TTL is the cache-busting mechanism for v0.
- **Caching downloaded asset bytes** outside IDB. The image library
  *is* the cache.
- **A standalone GitHub browser page** outside the modal.
- **Mobile-friendly layout** for the new sub-pane. Inherits the
  existing modal's desktop-only assumptions.

---

## Things future briefs should address

In priority order, informed by what surfaced this phase:

1. **Hard-disk boot support** (Phase 9.4 or Phase 10 candidate). The
   diagnosis in Section 4 pre-fills its diagnosis section. Once HD
   boot works the `Known incompatible` tag becomes obsolete for
   `hd*.img` and the viability heuristic should be revisited (most
   `hd*.img` would become `Untested` or even `Likely works` if the
   first one boots clean).
2. **CGA framebuffer rendering in the browser**. Currently the worker
   host installs a `NullCGASink` (worker-host.ts:64). Some ELKS
   builds and most DOS-era games write only to 0xB8000; the serial
   console workaround works for ELKS-serial but not for the broader
   "viable in our emulator" goal the user cares about.
3. **Network device** (NE2000 or similar). With hard-disk boot and
   network the emulator becomes a useful sandbox for evaluating
   real ELKS workloads.
4. **Snapshot / restore** of running machine state. Phase 9.2 stores
   floppy *images*; snapshotting the *machine* (CPU regs, RAM, disk
   modifications) is a step beyond.
5. **Asset-CDN CORS workaround**. If GitHub never adds CORS to the
   release-asset CDN, an opt-in proxy (the user's own server, or a
   small Cloudflare Worker) could be a documented escape hatch. Out
   of scope here — the brief explicitly declined a service-worker
   proxy — but worth noting as a polish item.

---

## CPU / memory bug candidates

Nothing surfaced this phase. The hard-disk diagnosis stopped at
the worker-host boundary (geometry inference returns `null`)
before any CPU instruction executed against the image, so no
speculative bugs in the CPU/memory layers were exercised. The
existing 1,155 baseline tests continue to pass unchanged, so no
prior-suspected bugs surfaced as regressions either.

Of mild interest (from reading INT 13h while diagnosing): AH=0x15
returns AH=0x03 unconditionally for DL ≥ 0x80 (`bios-services.ts:361`),
which is correct; AH=0x08's `BL = 0x04` constant is wrong for HD
but irrelevant until HD boot is enabled. Neither is a bug today;
both become work items in the Phase 9.4 brief.

---

## Release snapshot

Layout:

```
releases/phase-9-3-github-browser/
├── README.md                       # launch + what's new
├── package.json                    # copy of root manifest
├── package-lock.json               # copy of root lockfile
├── dist-cli/                       # compiled Node CLI tools
│   └── tools/elks/{run.js, run-serial.js}
├── dist-web/                       # Vite production bundle
│   ├── index.html
│   ├── elks-serial.img             # 1.44 MB serial floppy (default boot)
│   └── assets/
│       ├── index-D8A3Msak.js
│       ├── index-D8A3Msak.js.map
│       ├── index-B9SGSCe8.css
│       ├── worker-BhJArBm5.js
│       └── worker-BhJArBm5.js.map
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied. The release shares the repo
root's installed dependencies; run from inside the release folder
once the root has `npm install`-ed.

### Launch — Node serial harness

```
cd releases/phase-9-3-github-browser
node dist-cli/tools/elks/run-serial.js
```

Unchanged from Phase 9.2. The ELKS Setup banner prints first, then
the kernel redirects to ttyS0 and the rest of the boot streams via
the UART. `Ctrl-A x` quits.

### Launch — Browser harness

```
# Option A: vite preview
cd releases/phase-9-3-github-browser
npx vite preview --outDir dist-web --port 4173

# Option B: a generic static server
cd releases/phase-9-3-github-browser/dist-web
npx http-server -p 4173 .
```

Open `http://localhost:4173/`. Click ⚙ → expand **ELKS releases
(GitHub)** under Boot image → browse and download.

`file://` does not work — `fetch('/elks-serial.img')` fails on a
non-HTTP origin.

---

## Verification

### `npm run typecheck`

```
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
```

Exit 0. Three tsconfigs (root, test, web) all clean.

### `npx vitest run`

```
 Test Files  60 passed (60)
      Tests  1175 passed (1175)
   Start at  11:07:13
   Duration  209.80s (transform 2.07s, setup 2ms, collect 6.70s,
                     tests 298.27s, environment 18ms, prepare 6.30s)
```

20 new tests on top of the 1,155 baseline — all green:

- `tests/unit/github-releases.test.ts` — 12 cases covering parse,
  prereleases filter, cache hit/miss/TTL/key-by-options,
  RateLimitError on 403+remaining=0, plain Error on regular 403,
  network failure surfaces clearly, downloadAsset bytes round-trip,
  progress callback fires with terminal totals, AssetDownloadError
  carries status, network failure → AssetDownloadError status 0
  with CORS-aware message.
- `tests/unit/viability-tagging.test.ts` — 6 cases pinning all rules.
- `tests/unit/image-library.test.ts` — 2 new cases (github source
  round-trip; viability tag pass-through).

### `npm run build:browser`

```
> emu86@0.0.1 build:browser
> vite build

vite v5.4.21 building for production...
✓ 16 modules transformed.
../dist-web/index.html                   0.76 kB │ gzip:  0.46 kB
../dist-web/assets/worker-BhJArBm5.js   68.71 kB
../dist-web/assets/index-B9SGSCe8.css   10.81 kB │ gzip:  3.27 kB
../dist-web/assets/index-D8A3Msak.js   317.73 kB │ gzip: 80.73 kB │ map: 705.23 kB
✓ built in 3.29s
```

CSS grew ~3 KB over 9.2 (the new GitHub pane styling). JS grew
~12 KB (the fetch layer, viability tagger, and modal extensions).

### Manual verification — what was checked in this environment

- File counts and sizes in `releases/phase-9-3-github-browser/`
  match the layout above.
- `web/github-releases.ts` and `web/viability-tagging.ts` import
  cleanly under all three tsconfig contexts.
- API and asset header inspection via `curl` documented in
  Section 1.

### Manual verification — what the user should check in a real browser

(no GUI browser available in this Termux environment to check live)

- Open `http://localhost:4173/`, click ⚙, expand **ELKS releases
  (GitHub)** under Boot image.
- Confirm the latest stable release card (today: `v0.9.0`) appears
  with its 14 floppy assets tagged Untested and 6 hard-disk assets
  tagged Known incompatible.
- Toggle `Show prereleases` — the list should not change today
  (no prereleases published) but the network round-trip happens
  (visible in DevTools Network tab) because the cache key changes.
- Click `Download` on `fd1440-fat.img`. Either:
  - It succeeds → entry appears in the library with `source:
    github · tag: Untested`. Set as boot, reload, attempt boot.
    (The tag warns this is unverified; the boot may or may not
    reach a prompt — that's the truth this tag conveys.)
  - It fails with the AssetDownloadError CORS message → confirms
    the diagnosis from Section 1; the user can manually download
    via right-click and use the upload flow as a fallback.
- Click `Download` on `hd32-fat.img`. The 100 MB cap doesn't fire
  (it's only 32 MB) but the quota warning may. After download,
  set as boot and reload — confirms the Section 4 diagnosis: the
  worker host throws `cannot infer disk geometry for size 32514048`
  before any code executes against the image. This visibly
  reproduces the Outcome C reasoning and is the live evidence for
  the follow-up brief.

---

## Closing note

Phase 9.3 ships a tool — the GitHub browser — that the user asked
for, while honestly surfacing the limit it exposed: hard-disk
images are now one click away from being downloaded, but two
locked-file edits away from being bootable. The next brief gets to
decide whether closing that gap is the priority. The implementation
half is done; the diagnosis half handed off cleanly.
