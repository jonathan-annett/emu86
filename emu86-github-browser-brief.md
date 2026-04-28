# emu86 — Agent Brief: GitHub Releases Browser + Hard-disk Diagnosis (Phase 9.3)

## TL;DR

Two concerns, deliberately scoped together:

1. **Implementation: GitHub releases browser.** Add a second source
   to the Phase 9.2 image library. Fetch from `ghaerr/elks` releases
   via the GitHub API, list available `.img` assets across the
   latest stable release plus the most recent five prereleases, let
   the user download any of them into IDB. All assets are surfaced
   with a per-asset viability tag (`likely-works`, `untested`,
   `known-incompatible`) so the user knows what to expect.
2. **Diagnosis: hard-disk image viability.** Attempt to boot a
   hard-disk-class image (`hd*.img`) downloaded via the new browser.
   Document what works, what breaks, and at which layer. Three
   outcomes: (A) it boots, ship as-is; (B) it nearly boots, a small
   fix lands; (C) it needs substantial work, document scope for a
   follow-up brief.

The browser implementation ships regardless of the hard-disk
outcome — the user's evaluation goal is unblocked even if (C) is
the diagnosis result.

Document in `GITHUB_BROWSER_REPORT.md`.

You are working in `emu86/`. Read `BROWSER_POLISH_REPORT.md` (image
library schema, modal structure, the `source: 'upload' | 'github'`
discriminator). Phase 9 / 9.1 reports are background context if you
need them.

## Hard rules

1. **Don't break existing tests.** 1,155 passing as of Phase 9.2.
   All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **Diagnose hard-disk viability before implementing anything for
   it.** If diagnosis surfaces a substantial change (BIOS INT 13h,
   partition table parsing, machine-side disk geometry rework,
   etc.), document and stop on the hard-disk side. Outcome C is
   acceptable completion. The browser still ships.
6. **You may add** files under `web/` (UI, GitHub fetch logic,
   types) and unit tests for fetch/parsing logic. Browser-side
   files mostly; no new emulator devices.
7. **You may modify** `web/main.ts`, `web/index.html`, `web/
   settings-modal.ts`, `web/image-library.ts` (the `source` union
   already accepts `'github'` — write paths just need to use it),
   `web/themes.ts` only if a tag-color affordance needs it,
   `package.json`, and Vite config if a fetch helper requires it.
8. **You may NOT modify** anything in `src/cpu8086/`, `src/memory/`,
   `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
   `src/devices/`, `src/console/`, `src/disk/`, `src/bios/`,
   `src/host-clock/`, `src/diagnostics/`, `src/machine/ibm-pc.ts`,
   `src/browser/worker-host.ts`, or `src/browser/browser-console.ts`
   *as part of the implementation work*. The diagnosis section may
   *read* these to understand failure modes. Modifications to any
   of them — if hard-disk Outcome A or B requires it — must be
   surfaced for explicit user authorisation in the report; if
   ambiguous, prefer Outcome C and document the change required.
9. **No fix-and-pray on hard-disk support.** If the diagnosis
   surfaces a problem you can't see all the way through to a
   working fix, stop. Document. Outcome C is the right answer.
10. **No service worker, no offline caching of GitHub responses
    beyond a simple in-memory + localStorage cache for the release
    list.** Don't proxy asset downloads through a service worker.
11. **No GitHub authentication.** Unauthenticated API only. Document
    the rate-limit implications.

## Background

Phase 9.2 built the image library with a discriminated source field
(`'upload' | 'github'`) specifically for this brief. The library API,
modal UI, IDB schema, and boot-from-library flow already exist.
Phase 9.3 adds a second add-path that writes `'github'`-tagged
entries and a UI surface (a "Browse releases" affordance, plus a
release/asset list inside the existing modal) to populate it.

The user's stated goal is to evaluate whether large ELKS images
with inbuilt toolchains are viable in our emulator. Those are
typically hard-disk class (`hd*.img`, 30+ MB), not floppy class.
The Phase 9.2 report flagged that:

- The 10 MB upload cap rejects them.
- The floppy-only validation in the upload flow assumes them.
- The worker-host's geometry inference assumes floppy-class.

The 9.2 report tagged these as Phase 9.3 territory. This brief
takes that on as a diagnosis-shaped second concern.

ELKS releases live at `https://github.com/ghaerr/elks/releases`.
The GitHub API endpoint is
`https://api.github.com/repos/ghaerr/elks/releases`. Asset
download URLs are of the form
`https://github.com/ghaerr/elks/releases/download/<tag>/<asset>` and
redirect to `objects.githubusercontent.com`.

## Scope

### Section 1 — diagnosis: GitHub fetch viability (mandatory first)

Before writing any UI, verify the browser can actually fetch what's
needed. Answer concretely in the report:

1. **Does `fetch('https://api.github.com/repos/ghaerr/elks/
   releases')` succeed from the browser context with permissive
   CORS?** Cite the response headers actually observed.
2. **Does `fetch(<asset-download-url>)` succeed?** The redirect to
   `objects.githubusercontent.com` may or may not preserve CORS;
   verify with a real download. Document the response headers.
3. **What's the unauthenticated API rate limit, and how does it
   manifest?** Per-IP, 60 requests/hour. The release-list call is
   one request per cache miss; asset downloads do not consume API
   quota. Confirm.
4. **What `.img` assets does the latest stable release actually
   publish?** List them with sizes and (where the filename
   suggests) what they're for. Build the empirical basis for the
   viability-tagging rules in Section 2.
5. **What's a representative recent prerelease's asset list?** Same
   shape; helps confirm tagging rules generalise.

If CORS blocks any of the above, **stop and document**. The brief
becomes "GitHub browser blocked on CORS; here's what we saw" and
ships nothing else for the GitHub feature. This would be Outcome
C-equivalent for the implementation half. The hard-disk diagnosis
half can still proceed independently using a manually-uploaded
`hd*.img` that the user provides.

### Section 2 — implementation: GitHub releases browser

A new module, `web/github-releases.ts`, plus UI additions in the
existing settings modal.

**Fetch layer (`web/github-releases.ts`):**

```ts
interface GitHubRelease {
  tag: string                  // e.g. 'v0.9.0'
  name: string                 // human-readable; tag if absent
  publishedAt: number          // ms since epoch
  prerelease: boolean
  body: string                 // release notes; markdown
  assets: GitHubAsset[]
}

interface GitHubAsset {
  name: string                 // filename, e.g. 'fd1440-fat.img'
  sizeBytes: number
  downloadUrl: string          // browser-fetchable URL
}

interface ListOptions {
  includePrereleases: boolean  // default false
  prereleaseLimit: number      // default 5
}

async function listReleases(opts: ListOptions): Promise<GitHubRelease[]>
async function downloadAsset(url: string,
                             onProgress?: (loaded, total) => void
                            ): Promise<Uint8Array>
```

`listReleases` fetches the latest stable release plus, if
`includePrereleases`, the most recent N prereleases (paginate if
needed; expect almost never to need more than the first page).

The release list is cached in `localStorage` with a short TTL —
recommended 10 minutes. The cache key includes the option set.
Cache invalidation is "wait for TTL"; no manual refresh button is
required for v0 (a future polish if needed).

`downloadAsset` does a streaming fetch — but for v0, a simple
`response.arrayBuffer()` + `new Uint8Array(...)` is fine if the
asset is under, say, 50 MB. For larger assets, use `response.body`
as a `ReadableStream` and accumulate; this is the path that lets
the user see download progress for big hard-disk images.

**Viability tagging:**

Per the user's preference, assets are tagged for display:

- `likely-works` — looks like a serial-console FAT-formatted
  floppy our harness can boot. Filename heuristic:
  `fd*-fat-serial.img`-shaped, or anything matching the bundled
  image's pattern.
- `untested` — anything `fd*.img` that isn't obviously matching
  the known-good pattern (different filesystem, different size,
  different console config, etc.) but is at least floppy-class.
- `known-incompatible` — hard-disk class images (`hd*.img` or
  any asset > 10 MB), graphics-mode-only configs, etc., based on
  what the diagnosis section established.

The exact filename heuristics are the agent's call, informed by
the Section 1 diagnosis. Document the rules in the report.
**Tag-text matters**: the user has explicitly opted into seeing all
assets, including the ones likely to fail. Tags are honest
information, not gatekeeping. Even `known-incompatible` assets
remain downloadable.

**UI in the settings modal:**

The "Boot image" section gains a "Browse ELKS releases" affordance
below the existing upload row. Clicking it expands a sub-pane
showing:

- A "Show prereleases" toggle (default off → stable only).
- A list of releases, each with:
  - Title (release name + tag).
  - Date.
  - "Prerelease" badge if applicable.
  - Expandable list of `.img` assets, each showing: filename,
    size, viability tag (with colour or icon), and a "Download"
    button.
  - Optional: a small "Show release notes" expander (the `body`
    field rendered as plain text — no markdown rendering for v0;
    just `<pre>` it).

When the user clicks "Download":

1. Show a progress indicator (use the optional `onProgress`
   callback). Disable the button while in flight.
2. On completion, write to the library via
   `addImage(<asset.name>, bytes, 'github')`.
3. The library list updates; the new entry appears with a `github`
   tag visible in the row (so the user can distinguish their
   uploads from GitHub-sourced).
4. The user can then "Boot on next reload" the entry as with any
   other library entry.

The viability tag should be carried into the library entry's
metadata if it's small to do — this means displaying the tag in
the library list too. Optional; document the choice. (If carried,
extend `StoredImage` schema with an optional `viability?:
ViabilityTag` field. The Phase 9.2 schema's discriminator-only
addition was enough; this is a true field addition. Forward-compat
matters less than at the discriminator layer because reads can
treat `undefined` as "unknown".)

### Section 3 — adjusted size cap and floppy validation

The Phase 9.2 upload flow rejected files > 10 MB. For GitHub
downloads, this cap is wrong — hard-disk images are exactly the
thing the user wants to evaluate.

Adjustments:
- The upload-from-disk path keeps its 10 MB cap (uploads remain
  floppy-only for now; a user with a hard-disk image they want
  uploaded can do that in a future brief if desired).
- The GitHub-download path has a higher cap, recommended 100 MB.
  Below this, download proceeds; above it, the user gets a clear
  prompt asking whether to proceed (browser IDB quota
  implications).
- IDB quota check before download starts: call
  `library.getQuotaUsage()`, compare to asset size + headroom,
  warn if usage would exceed (say) 80 % of quota.

Document the chosen caps in the report.

### Section 4 — diagnosis: hard-disk image viability (mandatory)

After the GitHub browser is shippable, attempt to boot a hard-disk
image. Acquisition options, in order of preference:

1. Download an `hd*.img` from the GitHub browser you just built.
2. Fall back to a manually-supplied image from the user if the
   browser is blocked (Outcome C in Section 1).

Boot attempt protocol:

1. Set the library entry as boot source.
2. Reload the browser harness; observe what happens.
3. If the boot fails, characterise the failure:
   - At which layer does it fail? (BIOS INT 13h read of MBR /
     partition table parsing / kernel disk-driver init / userland
     mount / etc.)
   - What's the proximate symptom? (CPU exception trace, kernel
     panic line, hung after some byte count, etc.)
   - What's the root cause as best you can determine without
     modifying the locked directories? Read source, follow the
     code path.

Three diagnosis outcomes:

**Outcome A: it boots.** The Phase 9 worker host accepts
arbitrary-size image bytes and our existing BIOS INT 13h handlers
already handle the larger geometry. Surprise but possible. Verify
end-to-end (boot to prompt, run a command). Ship as-is. Document
why this worked.

**Outcome B: small fix lands.** The boot fails at a small,
self-contained layer (e.g., the worker host's geometry inference
hardcodes 80×2×18 floppy geometry; passing the image size lets it
infer correctly). The fix fits within the **non-locked** worker-
host or BrowserConsole code paths, and lands here. Verify
end-to-end. Document.

**Outcome C: substantial work.** The fix touches locked
directories: BIOS INT 13h handlers in `src/bios/`, the disk
subsystem in `src/disk/`, the IBMPCMachine config in
`src/machine/`, or similar. **Stop**. The brief's job is now to
document what's needed, with as much specificity as possible:
which file, which function, what change shape. Surface it as a
candidate for a follow-up brief (Phase 10 or 9.4).

In Outcome C, also document any partial information: the
filename of the `hd*.img` tried, its size and apparent geometry,
the boot trace up to the point of failure, the failure mode at
the byte-or-instruction level. This becomes Phase 10's diagnosis
section pre-filled.

### Section 5 — what you are NOT building

- Modifying any locked directory for hard-disk support unless
  Outcome B is reachable cleanly.
- A "refresh release list" button (cache TTL covers it).
- GitHub authentication (token entry, OAuth, etc.).
- Markdown rendering for release notes (plain text in `<pre>`).
- A search/filter inside the release list (5–6 releases is
  small).
- Cross-repo browsing (only `ghaerr/elks`).
- Resumable downloads (a failed download just retries on click).
- Verification of asset integrity (no SHA checking).
- Caching downloaded asset bytes (the library *is* the cache —
  re-downloading writes a new entry).
- Drag-and-drop of GitHub URLs into the modal.
- A standalone "GitHub browser" page outside the settings modal.
- Mobile-friendly layout for the new sub-pane.

## Tests

### Unit tests

- **`tests/unit/github-releases.test.ts`** *(new, ~6-10 cases).*
  Mock `fetch` (vitest's `vi.stubGlobal` or similar). Cover:
  list parsing of a representative API response; pagination
  short-circuit when only one page is needed; cache hit /
  miss / TTL expiry; prerelease filter; download bytes round-trip
  for a small fake asset; download progress callback fires.
  Don't hit the real GitHub API in tests.
- **`tests/unit/viability-tagging.test.ts`** *(new, ~3-5 cases).*
  Pure-function tests on the filename → tag heuristic. Cover
  known-good filename → `likely-works`; obvious hard-disk pattern
  → `known-incompatible`; ambiguous floppy → `untested`.
- **Updates to `tests/unit/image-library.test.ts`**: add a case
  asserting that an entry written with `source: 'github'` round-
  trips correctly through list / get / remove. The Phase 9.2
  schema supports it; this just pins it down.

### No UI integration tests

Same as Phase 9.2: manual verification covers the modal, the
browser sub-pane, the download flow, and the boot-from-library
flow.

### Smoke tests

Existing browser-worker-host integration tests must keep passing.
The hard-disk diagnosis runs interactively; not automated.

## Watch out for

- **CORS surprises.** GitHub's API has permissive CORS but asset
  download URLs redirect through a CDN that *may* not.
  Section 1's diagnosis is mandatory because of this. Don't
  assume; verify with an actual fetch and document the response
  headers.
- **Rate limit visibility.** A user reloading the page repeatedly
  while testing the new browser feature will hit the 60/hour
  limit. The localStorage TTL cache prevents this in normal use,
  but if hit, surface the rate-limit error clearly. Don't pretend
  the API is broken when it's just rate-limited.
- **Downloads are bytes, not URL refs.** Once downloaded, the
  asset lives in IDB. The original GitHub URL is not retained;
  the asset is now decoupled from its source. This is correct (no
  re-fetching, deterministic boot from a stored byte stream) but
  means a user can't "re-link" an entry to a different version
  later. Document.
- **Hard-disk diagnosis is read-only on locked dirs.** The
  diagnosis section *reads* `src/bios/` and `src/disk/` to
  understand failure modes. It does *not* modify them. If the
  agent finds itself wanting to "just fix this one thing in
  src/disk/", stop — that's the Outcome C signal.
- **The viability tag is honest, not protective.** The user
  explicitly opted into seeing everything. Tagging
  `known-incompatible` does not disable download. Tags inform;
  they don't gatekeep.
- **Asset sizes vary wildly.** A floppy is 1.44 MB; a hard-disk
  image with toolchains can be 30-50+ MB. Progress indicators
  matter; downloading 30 MB silently is a bad UX. The streaming
  fetch with `onProgress` covers this.
- **Don't carry the GitHub URL into the boot path.** The worker
  host fetches/loads bytes per Phase 9.2's Option A. GitHub
  downloads put bytes into IDB; boot reads bytes from IDB. The
  worker never sees a GitHub URL. Same path as user uploads.
- **Test-environment fetch mocking.** Vitest's environment in
  the existing `tsconfig.test.json` may need adjustments to mock
  global `fetch` cleanly. Use `vi.stubGlobal` or `vi.fn()`
  patterns; don't reach for `msw` or other heavy frameworks.
- **A 10 MB cap that auto-raises for GitHub downloads** is a
  source of confusion. Be explicit in the upload flow's status
  text about the cap, and explicit in the GitHub flow about its
  higher cap and quota implications.

## Definition of done

**GitHub browser implementation success:**

- `npm run dev:browser` — page loads, gear opens modal, Browse
  ELKS releases sub-pane works.
- Stable release shown by default; toggling prereleases reveals
  up to 5 more.
- Each release lists `.img` assets with name, size, viability
  tag.
- Click Download → progress visible → IDB entry created with
  `source: 'github'` → entry visible in library list.
- Boot the new entry on reload — works for `likely-works`-tagged
  floppy assets.
- Rate-limit error path manually testable (e.g., by spamming
  refresh with cache disabled — document the test method).

**Hard-disk diagnosis (one of three):**

- Outcome A: a hard-disk image boots and runs end-to-end.
- Outcome B: a hard-disk image boots after a small, non-locked
  fix; describe the fix.
- Outcome C: a hard-disk image fails to boot; the report's
  diagnosis section is concrete enough that a follow-up brief
  is straightforward.

**Test counts:**

- All 1,155 prior tests pass.
- GitHub releases: ~6-10 new cases.
- Viability tagging: ~3-5 new cases.
- Image library extension: 1-2 new cases.
- Total ≥ 1,165.

**Verification:**

- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).
- Manual UI verification per the success list above.
- Release snapshot at `releases/phase-9-3-github-browser/`
  populated and manually launch-verified.

The report at `GITHUB_BROWSER_REPORT.md` has these sections:

- **Summary**: outcome of both halves; which assets shipped as
  tagged; which hard-disk outcome.
- **GitHub fetch diagnosis**: API and asset CORS verification with
  observed headers; rate-limit confirmation; asset survey of
  latest stable + sample prerelease.
- **GitHub browser implementation**: fetch layer; cache strategy;
  modal sub-pane; download flow.
- **Viability tagging rules**: the heuristic, with examples;
  edge cases handled.
- **Hard-disk diagnosis**: which image was tried; failure mode
  if any; outcome; for Outcome C, the unblocking checklist.
- **What's deferred**: hard-disk substrate work (if Outcome C);
  authentication; markdown rendering; search; cross-repo;
  resumable downloads; integrity checking; cached fetch.
- **Things future briefs should address**: pulled from the
  diagnosis if Outcome C, otherwise the broader roadmap items
  (CGA-canvas, network device, snapshot/restore).
- **CPU/memory bug candidates**: anything noticed during the
  hard-disk boot attempt's tracing.
- **Release snapshot**: layout, launch commands, verification
  outputs.
- **Verification**: exact commands and outputs.

## Release snapshot

After all verification commands pass and before writing the report,
copy the working artefacts to a self-contained release folder.

Layout:

```
releases/phase-9-3-github-browser/
├── README.md                # launch commands + what's new
├── package.json             # copy of root manifest
├── package-lock.json        # copy of root lockfile
├── dist-cli/                # compiled Node CLI tools
├── dist-web/                # Vite production bundle (with browser)
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied. The release shares the repo
root's installed dependencies.

Verify the snapshot is launchable manually:
- Launch the Node serial harness from within the release folder;
  confirm it boots to `# `.
- Launch a static server against `dist-web/`; open in browser;
  verify gear, modal, Browse ELKS releases, download, and boot
  flows all work.

Document both verification outputs in the report.

## Reference sources

1. **`web/image-library.ts`** — the existing IDB layer; you'll add
   `source: 'github'` write paths and possibly the optional
   `viability?` field.
2. **`web/settings-modal.ts`** — the existing modal; add the
   release-browser sub-pane below the upload row.
3. **`web/main.ts`** — the boot bootstrap; doesn't change for
   GitHub but does for the hard-disk diagnosis if Outcome A or B
   reached.
4. **`src/browser/protocol.ts` and `src/browser/worker-host.ts`** —
   read-only for diagnosis; the worker host's image handling and
   any geometry inference live here.
5. **`src/bios/` and `src/disk/`** — read-only for diagnosis. The
   INT 13h handlers and disk subsystem are where hard-disk failure
   modes manifest.
6. **GitHub API docs** at https://docs.github.com/en/rest/releases
   — the endpoints, rate limits, response shapes.
7. **`ghaerr/elks` repo** — the actual releases, the actual asset
   names. Use the diagnosis to ground the viability heuristic.

## Final notes

This brief has two halves with very different shapes:

- **The GitHub browser is implementation work** with a clear
  feature spec and modest UI surface. It should ship cleanly. The
  diagnosis in Section 1 is just a CORS check, not deep
  exploration.
- **The hard-disk diagnosis is research work**. Its outcome is
  unknown until tried. It is fine — and likely — for it to land
  as Outcome C: a well-documented "this is what's needed for a
  follow-up brief." That's a valid completion, not a failure.

The user's stated motivation is evaluating whether large
toolchain-bearing ELKS images are viable in our emulator. Phase 9.3
gives them a tool (the browser) to download those images and a
diagnosis of what stops them booting. Phase 10 (or 9.4) takes the
diagnosis output and turns it into substrate work — but only if
the user decides that's the next priority after seeing what was
learned.

The discipline this brief asks for is **not bundling the substrate
work into 9.3 just because the diagnosis surfaces it**. The
locked-directory rule (#8 above) is the gate. If the diagnosis
points at INT 13h needing extension, that's a separate brief, not
a sidecar.
