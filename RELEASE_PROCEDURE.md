# Release procedure — promoting dev → stable (8086-tab.net)

Formalized 2026-07-15 (Jonathan's ask: users should have a way back
to a version they're familiar with as the site grows). Every
promotion ARCHIVES the outgoing live version at `/<stamp>/` and the
new version's header carries a subtle "previous version" link.
Deploys remain permission-gated for agents — Jonathan runs steps 3–4.

## The steps

1. **Capture the outgoing version** (from the live site — see "why
   capture" below):

   ```
   npm run release:capture
   ```

   This downloads everything 8086-tab.net currently serves
   (index.html, both JS bundles + source maps, CSS, elks-serial.img),
   extracts the build stamp from the live bundle (e.g.
   `9728bb6-dirty`), rewrites the absolute paths so the copy is
   self-contained, and writes it to `web/public/<stamp>/` — vite's
   publicDir, so every future build carries all archives verbatim.
   It also prepends the entry to `web/public/version-history.json`,
   which the running app reads to render the header link. Refuses to
   overwrite an existing archive without `--force`.

2. **Build + verify**: `npm run build:browser`, confirm
   `dist-web/<stamp>/index.html` exists and the full suite is green
   (the cadence ruling: the full suite gates every deploy).

3. **Deploy stable**: `npm run deploy:prod` (Jonathan;
   `set -a; source ~/cf-token.env; set +a` first).

4. **Field-check both**: the new version boots at `/`, the archived
   one at `/<stamp>/`, and the header shows
   `· previous version (<stamp>)`.

5. **Commit** `web/public/<stamp>/`, the manifest, and dist-web —
   the archive is part of the tree from then on.

## Why capture-from-live, not rebuild-from-git

The first stable build is stamped `9728bb6-dirty` — built from an
uncommitted tree, unreproducible from any checkout. Downloading the
served bytes is the only honest archival, and it stays the right
method forever: what is archived is exactly what users were running,
including anything a hotfix deploy changed outside git.

## How the archive stays self-contained

- Hashed assets never collide across versions; each archive keeps its
  own copies under `/<stamp>/assets/`.
- The capture rewrites absolute references in text files
  (`/assets/…`, `/elks-serial.img`, `/version-history.json` →
  `/<stamp>/…`). Relative references (the worker bundle, source maps)
  need no rewriting — they resolve inside the archive by construction.
- `/gh-assets/…` is deliberately NOT rewritten: the CORS proxy is
  shared, version-neutral worker infrastructure.
- Origin-scoped state (settings, image library, drive forks, TAN) is
  SHARED between `/` and `/<stamp>/` — same origin. An old version
  reads the same localStorage/IDB the new one writes. Old code
  ignores fields it never knew (the settings loader is per-field
  tolerant by design), but this is the known sharp edge: archives are
  a familiarity fallback, not a time machine for stored state.
- **Settings are key-versioned per semantic era** (2026-07-15, the
  edge's first field instance): Phase 16 M0 changed what
  `secondaryImageSource` MEANS (attach-directly → fork template)
  without changing its name or shape, so the archived 9728bb6 build
  read the current value and attached the fork TEMPLATE directly as
  its /dev/hdb (read-only-in-effect — that era had no write-back —
  but wrong, and its settings saves would bleed back). Fix: the
  current build reads/writes `emu86.settings.v2`, one-shot migrated
  from v1, and the migration nulls v1's `secondaryImageSource` so
  the archive attaches nothing. THE RULE GOING FORWARD: changing the
  semantics of any persisted settings field bumps the storage key;
  each archive era then owns its key. IDB stays shared — an archive
  can still SEE fork rows in its picker; attaching one is harmless
  in the 9728bb6 era and coherent (just another tab) in fork-aware
  eras.

## Known limits, recorded honestly

- The archived app calls shared worker endpoints (`/gh-assets`). If
  those routes ever change incompatibly, old archives degrade in
  those features only (the emulator itself is fully client-side).
- Archives add ~5–6 MB each to the repo and every deploy upload.
  Acceptable at the current cadence; revisit if promotions become
  frequent (e.g. keep the last N in publicDir and park older ones in
  a release bucket).
- The `9728bb6-dirty` archive predates the version-history code, so
  ITS header has no link onward/back. Every version from the next
  promotion on carries the link it shipped with, frozen — walking the
  chain backward works from then on.

## Incident, 2026-07-16: the shadow pipeline (READ BEFORE TRUSTING A DEPLOY)

A Cloudflare **Workers Builds** git integration had been attached to
the `emu86` (prod) Worker since ~July 13 — its bot branch predated
the repo going public. Consequence: **every push to `main` built and
deployed to STABLE**, racing the CLI procedure. `b72851d` (a proper,
gated, captured promotion) was silently replaced ~4 hours later by a
git build of an unceremonied docs commit (`05fb7ed`). The next
capture then archived `05fb7ed` honestly — correct behavior against
a wrong reality — and the `b72851d` archive had to be reconstructed
from git afterwards (its manifest entry says so; the trick: serve
the promotion commit's committed dist-web locally and run
release-capture with `CAPTURE_ORIGIN=http://localhost:<port>`).

Rules extracted, in blood:

1. **Never connect Workers Builds (or any push-deploy CI) to the
   `emu86` prod service.** If a git pipeline is ever wanted, point it
   at a dedicated `release` branch that is only fast-forwarded at
   promotion time — that is a procedure CHANGE and gets its own brief
   first. (Jonathan disconnected the integration in the dashboard,
   2026-07-16; the GitHub app remains installed for his other repos,
   so an accidental dashboard re-connect stays possible — check the
   Worker's Settings → Build panel if deploys ever look haunted.)
2. **`No targets deployed for emu86` from wrangler is NOISE** — the
   upload happened (the version list proves it). Do not diagnose from
   that line in either direction.
3. **Verify a deploy by CONTENT AND SOURCE, not reachability**: the
   live bundle's build stamp must match the commit you deployed, and
   the Worker's active deployment should say "Wrangler", not a git
   build. Tonight's lesson: it is possible to "verify" someone else's
   deploy and credit your own.
4. **Verify the capture too**: before `release:capture`, confirm the
   live stamp IS the promotion you think is outgoing. The capture
   tool archives whatever reality serves it.
