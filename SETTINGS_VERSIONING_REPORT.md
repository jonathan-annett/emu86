# Settings key versioning — the archive settings leak, found and closed

2026-07-15, the same day archives shipped. Scope settled in-session:
Jonathan field-hit the bug minutes after the first archive went live
on dev, three options were tabled, he picked this one ("your idea #1
is better").

## 1. The field report

Checking the freshly fixed `/9728bb6-dirty/` archive on the dev tier,
Jonathan: "the previous version is trying to use the secondary disk
settings."

## 2. Diagnosis (verified against the code at both commits)

Both the current build and the archived `9728bb6` build read the SAME
localStorage key (`emu86.settings.v1`) and the same field
(`secondaryImageSource`, identical `{ kind: 'library', id } | null`
shape) — but Phase 16 M0 changed what the field MEANS without changing
its name or shape:

- **9728bb6 era** (pre-fork): "the image to attach directly as
  /dev/hdb". At that commit the attach is Phase-11 style — bytes are
  read from the shared IDB library at boot (`main.ts:433` at 9728bb6,
  `library.getImageBytes` → `config.secondary`) and guest writes die
  in worker RAM at reload. **No write-back existed yet** (that landed
  later, in Phase 15 M2), so the archive could not corrupt anything —
  verified by grepping the whole `web/` tree at 9728bb6 for any
  library write path: there is none.
- **Current era** (Phase 16 M0): "the BASE TEMPLATE every new tab
  forks". No tab mounts it directly.

So the archive validated today's value happily and attached the fork
template directly as its /dev/hdb — its era's semantics, faithfully
executed on another era's data. The leak is two-way: a settings save
made inside the archive (it writes the whole object) would silently
re-point the current build's fork template, theme, boot scripts —
everything.

This is exactly the "shared origin state" sharp edge
RELEASE_PROCEDURE.md recorded at birth, now with its first concrete
mechanism.

## 3. Options tabled, decision

1. **Version the settings key** — bump to `emu86.settings.v2` with
   one-shot migration; null v1's secondary during migration so the
   archive attaches nothing. Small, permanent, repeatable at every
   future semantic change. **Chosen.**
2. Document only — defensible (no corruption possible; 9728bb6 is
   likely the only archive straddling this particular boundary) but
   leaves the general settings leak for every future archive.
3. Origin isolation (archives on a subdomain, splitting localStorage
   AND IDB) — the only complete fix, needs DNS + worker routing + a
   procedure rewrite. **Recorded as the LATER option** if archives
   ever need to be true time machines.

Jonathan also floated per-deploy key prefixes (every deploy gets its
own era, first deploy unprefixed) — that is what key-versioning does,
minus the churn: eras split only when SEMANTICS split, so settings
keep flowing forward across the common case of compatible deploys.

## 4. What was built

`web/settings.ts`:

- `STORAGE_KEY` is now `emu86.settings.v2`; `LEGACY_STORAGE_KEY`
  (`…v1`) belongs to the archive era.
- `migrateLegacyV1()`, run only when v2 is absent: copies the v1 JSON
  to v2 verbatim (per-field validation happens on parse anyway), then
  rewrites v1 IN PLACE with `secondaryImageSource: null` — every other
  field preserved as stored, unknown fields included, so the archive
  keeps its theme/fonts/scripts and simply boots with no secondary.
  Unparseable v1 or a storage failure migrates nothing and fails open,
  like every other storage path in the module.
- All writes (`saveSettings`, `validateImageSourceAgainstLibrary`'s
  quiet correction) land in v2 only.

**The rule going forward** (recorded in RELEASE_PROCEDURE.md's known
limits): changing the semantics of any persisted settings field bumps
the storage key. Each archive era then owns its key.

## 5. What was deliberately NOT done

- **IDB stays shared.** The archive's picker still lists the shared
  image library — including 'fork' rows it never had a concept for.
  Harmless in the 9728bb6 era (attach is read-only-in-effect) and
  coherent in fork-aware eras (an archived fork-aware build is just
  another tab). Making IDB era-private means option 3.
- **No rename of `secondaryImageSource` inside the current schema.**
  The field name is fine within its era; the key IS the era boundary.
  Renaming would churn every reader for no isolation gain.
- **v1 is not deleted.** It is the archive's live settings store now;
  deleting it would reset the archive's look on every visit.

## 6. Verified

- `tests/unit/settings.test.ts`: 20 passed — 15 existing tests
  re-pointed at v2 (the shim key const), 5 new migration cases:
  adopt-and-defuse (unknown fields survive in v1), one-shot (v2
  present ⇒ v1 byte-untouched even when it names a secondary),
  saves-land-in-v2-only, unusable-v1 fails open without writing v2,
  neither-key writes nothing.
- `npm run typecheck` clean across all three configs.
- Full suite as the deploy gate + a live dev-tier field check: see the
  commit that ships this report; Jonathan's archive re-check is the
  acceptance.

## 7. Loose end for the next promotion

The NEXT capture (of the current live prod, `9728bb6-dirty`) is
already taken; the first capture of a fork-aware build will archive a
version that reads v2. If a semantic change to any v2 field ever
lands, bump to v3 first — the rule exists precisely so nobody has to
re-derive this report.
