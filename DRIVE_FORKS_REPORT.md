# Drive Forks Report — Phase 16 M0: every tab owns its /dev/hdb

2026-07-15, the session that opened with Jonathan's overnight #olfr
(SUBSTRATE_API_REPORT.md §4). Scope: Phase 16 brief, Addendum A —
drafted, approved ("go ahead", plus "8mb is enough for a basic edit
session, the upsize to 32mb is optional"), and built in-session, ahead
of M1 because the editor panel is a view of a tab's /dev/hdb and the
drive model had to be per-tab for that view to make sense.

## 0. TL;DR

The origin-global "attached secondary" is gone. Now:

- **Every tab always has a drive.** New tab: a private fork of the
  shared base image — or a fresh blank 8086 KB drive if no base is set.
  No settings step, no `?mkdrive` prerequisite.
- **Reload keeps it.** The fork pointer lives in sessionStorage; the
  bytes auto-persist to a hidden image-library row (`source: 'fork'`)
  off the stats heartbeat, throttled to one IDB write per 5 s, plus a
  flush when the tab goes hidden.
- **Duplicating a tab forks the drive.** Browsers copy sessionStorage
  on duplicate; a Web Lock named for the fork id detects the collision
  and the duplicate takes a copy under a fresh id — the octet-lease
  pattern, exactly as the session-store doc comment predicted in
  Phase 14.
- **Save = promote, human-click only.** The banner button publishes
  the tab's current drive as the base image new tabs fork. Open tabs
  keep their forks. The guest/API cannot promote (F.3 stands).
- **`?mkdrive` guard retired.** It now queues a fresh blank for THIS
  tab's next reload and never touches the base — the field complaint
  ("a brand new tab also seems to auto attach") cannot recur, because
  what a new tab gets is a fork by design, and mkdrive no longer cares.

## 1. What was built (files)

- `web/drive-session.ts` (new): the boot state machine —
  pending-swap / reload / duplicate / fork-of-base / fresh-blank — plus
  orphan-fork GC and the Web Locks wrapper. Deps-injected; unit-tested
  against the REAL ImageLibrary on fake-indexeddb with fake locks.
- `web/session-store.ts`: `driveForkId` (the tab's fork row id) and
  `pendingBlankKb` (a queued ?mkdrive swap, consumed at next boot).
- `web/image-library.ts`: `'fork'` source tag; `addImage` can carry
  explicit CHS geometry (fork rows copy it from their origin).
- `web/main.ts`: resolves the drive session before the boot banner
  (provenance line: "fork of X — this tab's own copy" etc.); a FIFO of
  snapshot resolvers multiplexes `snapshot-secondary` between
  auto-persist and promote — **no protocol change**; the Phase 15 M2
  per-image Web Lock and the "changes will NOT be saved" banner state
  are retired (they guarded a shared mutable attach that no longer
  exists); the drive pill is now: dirty count ↔ auto-saved tick +
  "Save as default".
- `web/settings-modal.ts`: the secondary section is now the BASE-image
  picker ("new tabs fork this"); fork rows are hidden from both
  pickers; the "reload to apply" notice for the secondary is gone
  (changing the base affects only tabs opened later — nothing to
  reload); "None" honestly says new tabs get a fresh blank 8086 KB.
- `web/settings.ts`: `secondaryImageSource` doc rewritten — the field
  and storage shape are unchanged, its MEANING is now "the template",
  and `null` means "blank 8086 KB default", not "no drive".
- `src/net/control.ts`: usage/doc text for per-tab mkdrive semantics.
  Worker, protocol, CPU, machine: untouched (hard rules 1/3).

## 2. Decisions recorded

- **Whole-image fork rows, not chunked.** Jonathan delegated this
  ("if it is more efficient to split the indexed db records into
  smaller chunks, that's your call"). Call: whole images. The
  auto-persist cadence (≥5 s apart, only while dirty) makes an 8 MB
  structured-clone write cheap; chunked rows would only pay off with a
  dirty-RANGE snapshot (a protocol change — today's telemetry is a
  dirty count). Recorded follow-on if 32 MB auto-persist janks in the
  field (the phone is the risk); `IndexedDBPageStore` is the in-repo
  precedent to grow toward.
- **Promote writes the fork row too**, so the tab's own persistence is
  exactly as current as the base it published.
- **Promote to a size-changed base publishes a NEW library entry** and
  repoints, rather than resizing the old one — a base image's geometry
  is its identity (updateImageBytes rejects size changes, on purpose,
  since Phase 15). The old base stays in the library, user-deletable.
- **Two tabs promoting: last click wins.** Accepted in the addendum;
  promote is one IDB write, no merge semantics pretended.
- **GC is generous**: fork rows are swept only when their lock is
  unheld AND untouched for 7 days — reopen-closed-tab and browser
  session restore resurrect sessionStorage, and those tabs should find
  their bits. No locks API (old Safari) ⇒ GC disables itself entirely:
  never delete what might be alive. Duplication detection degrades to
  last-write-wins on a shared row there, recorded and accepted.
- **A duplicated tab that inherited a queued ?mkdrive swap must not
  delete the original tab's row** — the swap path probes the old row's
  lock and retires it only if free. The converging case (the original
  reloads later and retires its own row) is unit-tested.

## 3. Honest limits (field-relevant)

- **A hard reload can lose the last ≤5 s of guest writes** — the gap
  since the last auto-persist. Same class as yanking a floppy
  mid-write; the guest `sync` habit covers it. visibilitychange
  flushes on tab-hide, but a same-tab Ctrl-R doesn't always pass
  through hidden first.
- **A duplicate's fork copies the last PERSISTED bytes**, not the
  original tab's in-RAM state — same ≤5 s class.
- **We cannot detect guest mounts** (unchanged from the brief): a
  fork swap or panel write after reload still needs the guest to
  mount/remount to see it.
- **Forks cost storage**: one drive-sized row per live tab (8 MB
  default), counted in the modal's quota line, reclaimed by GC.

## 4. Found while building (pre-existing bug, fixed)

The `?mkdrive` usage text had advertised **32256** KB for the 32 MB
preset since Phase 15. The real preset (63×16×63 CHS — the hd32 image
shape) is **31752 KB**; 32256 is that preset's *sector* count and the
16 MB preset's KB… doubled. A trap laid by round numbers. The dynamic
"size must be one of" error was always computed from DRIVE_PRESETS and
therefore always right — only the static usage string lied. Fixed in
`control.ts`; corrected in SUBSTRATE_API_REPORT.md §1. Found because
the M0 tests were written from the usage text and the 32 MB swap test
refused to swap.

## 5. Verified

- New: `tests/unit/drive-session.test.ts` — the five boot origins,
  fork-copies-not-aliases, vanished row/base degradation, swap
  retire-vs-duplicate-inheritance, unrecognized queued size, GC
  (sweeps old+unheld only; never touches non-fork rows; no-ops without
  a readable locks API). `tests/unit/session-store.test.ts` — new
  fields round-trip, pre-M0 stored sessions load with nulls.
- Suite: **1,233 passed / 112 files / 1 skipped** (SST corpus, as
  always); typecheck clean on all three configs. Baseline up from
  1,218 (+12 drive-session, +2 session-store, +1 image-library).
- Test-infra lesson, worth its own line: `expect(a).toEqual(b)` on an
  8 MB Uint8Array costs ~90 s (structural deep-equal walks elements),
  and fake-indexeddb's structured-clone polyfill is seconds-per-MB —
  the first cut of the drive-session suite took 200+ s from those two
  traps combined. Fixed with an in-memory ForkLibrary fake and a plain
  byte-compare helper; the file now runs in under 2 s.
- NOT verified here: real-browser tab duplication and reopen-closed-tab
  (fake locks model them; the field is the acceptance, as usual), and
  the ≤5 s loss window under a real Ctrl-R. Suggested field script:
  two tabs, `mkfs` + write in one, Save-as-default, open a third tab
  (should fork the saved base), duplicate it (should fork the fork),
  `?mkdrive=8086` in any tab + reload (fresh blank, base untouched).

## 5b. Field acceptance (2026-07-15, ~02:30, dev tier 916e18ac)

Jonathan, minutes after deploying: fresh drive; `ls > /mnt/test`;
duplicated the tab WITHOUT sync — fork present but empty ("as
expected": the file was still in the guest's buffer cache, so the
persisted image predated it); closed the dup, ran `sync` (no umount),
re-duplicated, mounted — file list there; then wrote a new file +
`sync` in the first tab and confirmed it did NOT appear in the dup
even after umount/mount. His verdict: "proving it was indeed a fork,
and not the same image. so looks good to me." That one sequence
exercises fork-at-duplicate, auto-persist-after-sync, and fork
independence — the three behaviors M0 exists to provide. ACCEPTED.

## 6. Deliberately NOT done

Live cross-tab sync, fork lineage/merge, per-tab primary image,
resize-in-place (upsize = fresh bigger blank; file-level migration
becomes possible after M2's MINIX write path), pre-formatting the
default blank (also an M2 follow-on — host-side mkfs), and deep links
(`#mouse`) — recorded in the brief's Addendum A with the pinning
caveat GC would need first.
