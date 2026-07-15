# Phase 17 M1 Report — the overlay engine (worker + protocol + store)

2026-07-15, the session after the brief's §4 decisions landed
("agree to all", plus Addendum A). Scope: `emu86-phase17-brief.md`
§3 M1 exactly — hot map, epoch sweeps, chunk coalescing, the three
protocol messages, the `emu86-overlays` chunk store, forced-sweep
threshold, flush on reset/hidden. Session-start checks from brief §5:
the drawer-handle build (272b5e4) is no longer pending — it rode the
settings-v2 dev deploys into `c1f26b1-dirty`, which was PROMOTED to
stable (commit 238ee47); no overnight #olfr in the repo.

## 0. TL;DR

Guest writes to the BOOT disk are now captured per-sector in the
worker (bytes copied at write time), swept to the main thread as
coalesced 32 KB chunks on the stats heartbeat (~5 s throttle, 4 MB
forced threshold, flush on reset and on tab-hidden), and persisted
per-tab into a new `emu86-overlays` IndexedDB database — one
transaction per epoch, ack/nack'd back to the worker so a failed
IDB write folds the epoch into the hot map and retries with nothing
lost. **Nothing reads these chunks back yet.** The fold-at-boot, the
SHA-256 identity check, and the lifecycle (duplication, GC, factory
reset) are M2, by design. A reload today still boots the pristine
base — behavior is unchanged for the user; the machinery underneath
is live and persisting.

## 1. What was built (files)

- `src/disk/overlay.ts` (new): `OverlayDisk` — a `Disk` decorator
  plus the epoch state machine. Double-write (RAM authoritative, hot
  map copies at write time), reads delegate straight to the inner
  disk (never the map — hard rule 1 by construction), two-map epoch
  swap, aligned-chunk coalescing with RAM fill-in, nack merge with
  newer-wins. Also home of the two §4.2 constants:
  `OVERLAY_CHUNK_BYTES = 32 KB`, `FORCED_SWEEP_BYTES = 4 MB`.
- `src/browser/protocol.ts`: `overlay-sweep` (worker→main: epochId +
  chunkSizeBytes + chunks), `overlay-swept` (main→worker ack/nack,
  correlated by epochId — the control-request precedent, not FIFO,
  because stale replies must be discardable across resets),
  `overlay-flush` (main→worker: sweep now); `StatsMessage` gains
  `overlayHotSectors` (the §4.2 "retune from telemetry" input).
- `src/browser/worker-host.ts`: the primary now boots wrapped in
  `OverlayDisk` (always on, §4.1 — the secondary's Phase 15 tracker
  is untouched, brief §0). Sweep cadence rides the existing 1 Hz
  stats heartbeat under a 5 s throttle; a per-turn check in the
  paced loop enforces the 4 MB forced threshold; a 10 s ack timeout
  nacks a never-answered epoch. `reset` posts one final COMPLETE
  sweep (pending epoch folded back first) before teardown — teardown
  must not eat an epoch. Epoch ids are host-owned and survive
  teardown so a late ack can never match a fresh boot's epoch.
- `web/worker.ts`: overlay chunk buffers ride postMessage as
  Transferables (each chunk is freshly allocated at sweep — the tx
  precedent).
- `web/overlay-store.ts` (new): the `emu86-overlays` database, the
  origin's third IDB tenant (own DB on purpose — brief §1.3: wiping
  the library or pages must never surprise machine state). Stores
  `chunks` (keyPath `[overlayId, chunkIndex]` — idempotent records,
  per-overlay key-range ops) and `meta` (`{ baseFingerprint,
  chunkSizeBytes, lastTouched }`). One readwrite transaction per
  epoch — all chunks + the meta touch land atomically. Copy /
  delete / list primitives are already shaped for M2's duplication
  and GC.
- `web/main.ts`: persists each `overlay-sweep` and acks/nacks with
  the epoch id; sends `overlay-flush` on visibilitychange-hidden
  (riding the existing fork-flush listener).
- `web/session-store.ts`: new `overlayId` tenant (provisional
  identity — see §3).

## 2. Decisions recorded

- **One class, not two.** The brief allowed "wraps the primary (or
  extends the wrapper)". `WriteTrackingDisk` keeps a bytes-free
  `Set<lba>` with snapshot/markClean semantics the overlay doesn't
  want, and the overlay needs bytes + epochs the secondary doesn't —
  so `OverlayDisk` is a sibling, not an extension, and the two
  trackers stay independent (the field-accepted M0 fork system is
  untouched down to the class it rides on).
- **Epoch ids are host-owned.** The engine takes the id as a
  `beginSweep(epochId)` argument; `WorkerHost` mints them from a
  counter that survives teardown. Rationale: a reset's final sweep
  can be acked AFTER the next boot constructs a fresh engine; if
  both sides restarted their counters at 1, that late ack could be
  misattributed to the new machine's first epoch. Found by thinking
  through the reset test, not by hitting it in the field.
- **Chunk contents: epoch bytes where the epoch has them, RAM
  fill-in for the rest of the aligned span** (brief §1.2 verbatim).
  A sector written in BOTH the in-flight epoch and the newer hot map
  sweeps the OLDER value now and the newer value next epoch — a
  legitimate point-in-time crossing either way; idempotent chunk
  records converge on the newest. The tail chunk is short when the
  disk isn't a chunk multiple (ELKS hd32 images divide evenly; the
  floppies don't).
- **Two flush flavors, deliberately different.** `overlay-flush`
  with an epoch in flight defers — a flag sweeps the remainder the
  moment the pending epoch settles (no double-persist of an epoch
  main is mid-transaction on). `reset` cannot wait for a round trip,
  so it nacks the pending epoch locally, folds it under any newer
  writes, and posts one final complete sweep; if main also persists
  the original epoch, chunk records are idempotent and postMessage
  order guarantees the newer transaction commits last. Correct
  either way, and the reset path never depends on being answered.
- **Forced threshold is checked every paced-loop turn**, not just at
  the heartbeat — a turbo-mode `dd` can dirty tens of MB inside one
  1 s stats window. Cost is one integer compare per turn. The bound
  is threshold + (writes during one ack round-trip), since a second
  sweep can't start while one is pending.
- **Provisional identity in M1** (see §3 for the honesty). Main
  mints a per-tab `overlayId` on first sweep and stores rows under
  it with `baseFingerprint: null`. The store's merge rule — null
  never downgrades a real fingerprint — is already in place for M2.
- **`overlayHotSectors` rides stats now, not later**: §4.2 says the
  constants get retuned from telemetry, so the telemetry ships with
  the engine, not with the tuning.

## 3. Honest limits (all deliberate, all M2-or-later)

- **Write-only persistence.** No boot fold exists, so a reload boots
  the pristine base and the tab's chunks just sit there (and get
  overwritten by the next session's sweeps under the same
  overlayId). M1 is the engine milestone; two-boot round-trip
  acceptance is M2's, per the brief.
- **No identity check.** `baseFingerprint` is null ("pre-identity
  era"). M2's fold must treat null as a mismatch — do NOT apply
  M1-era chunks silently. The worker-side SHA-256 is M2.
- **Duplicated tabs share an overlayId** until M2's Web-Lock
  lifecycle lands — both tabs sweep onto the same rows, last chunk
  wins. Harmless today precisely because nothing folds at boot; it
  becomes a correctness issue the moment M2 lands, which is why the
  brief puts the lock in the same milestone as the fold.
- **No GC and no factory reset yet** — orphaned overlay rows
  accumulate (bounded: one overlay per tab ever opened, chunks only
  for written spans). M2 mirrors `gcOrphanForks`; `deleteOverlay`
  is already the reset primitive, unwired.
- **Sweeps ride the paced loop only.** The sync `runUntil` driver
  (tests, headless) accumulates a hot map and never sweeps — same
  honesty class as mkdrive's "nobody answered on the main thread".
  Integration boots pay one 512-byte copy per primary write;
  unmeasured, judged negligible against INT 13h overhead, flagging
  that it was NOT measured.
- **A `boot` without a preceding `reset` would eat the hot map**
  (boot's own teardown doesn't flush; the reset handler does).
  main.ts today never does that — one boot per page load, reload in
  between, and visibilitychange-hidden flushes first. Recorded as a
  trap for any future in-app "reboot" affordance.
- **The loss window stands**: up to ~5 s of writes (throttle) plus
  anything between the last sweep and a hard tab kill —
  visibilitychange-hidden is the best close predictor we get, same
  class as the fork auto-persist (M0's recorded ≤5 s).

## 4. What was verified

- `tests/unit/disk-overlay.test.ts` (15) — the engine, including all
  three M1 acceptance scenarios from the brief: **write storm →
  exactly the expected chunk set** (byte-exact against RAM);
  **nack merges epochs, newer wins**; **full-disk rewrite stays
  bounded by the (scaled) forced threshold** and the collected
  epochs' idempotent replay reproduces the final disk byte-for-byte.
  Copy-at-write pinned by mutating the caller's buffer after the
  write. All in-memory; byte compares are plain loops (the Phase 16
  `toEqual`-at-90-s lesson is law).
- `tests/unit/worker-host-overlay.test.ts` (8) — host wiring: boot
  wraps the primary; flush/ack/nack-retry/deferred-flush lifecycles;
  reset posts one final complete sweep and late acks are inert;
  epoch ids unique across reboots. Paced-loop rig (fake
  pacerTimeSource, pacing-test law): stats carries
  `overlayHotSectors`, the 4 MB forced threshold fires with time
  frozen (no heartbeat involved), the 5 s throttle sweeps via the
  heartbeat.
- `tests/unit/overlay-store.test.ts` (8) — real-IDB round-trips on
  fake-indexeddb with SMALL payloads (the 177-s lesson): atomic
  epoch write, chunk idempotence, fingerprint never-downgrade,
  key-range isolation, delete/copy primitives.
- `tests/unit/browser-protocol.test.ts` (+2) — the exhaustiveness
  switches now cover all three messages (they refused to compile
  until updated, as designed); overlay-sweep structured-clone shape.
- `tests/unit/session-store.test.ts` (+1) — overlayId round-trip,
  pre-Phase-17 sessions load with null.
- `npm run typecheck` clean across all three configs.
- **Full suite: 1,308 passed / 120 files / 1 skipped** (the SST
  corpus skip, as always) — the new baseline; was 1,275 / 117.
  No existing test changed behavior except `drive-session.test.ts`'s
  in-memory SessionState fake gaining the new field (compile-time
  only).

Not verified here: no browser field test this milestone — there is
deliberately nothing user-visible to field-test until M2 folds
chunks at boot. The dev-tier deploy decision belongs to M2/M4.

## 5. Pointer for M2

The seams M2 needs are in place and named: `BootConfig.overlay`
carriage (protocol), fold-before-stamps in `#boot` (worker-host),
`crypto.subtle.digest` fingerprint pre-run, `OverlayStore.getChunks`
/ `copyOverlay` / `deleteOverlay` / `listMeta` (main), `overlayId`
in the session store, and `forkLockName`/`gcOrphanForks` as the
lifecycle template (drive-session.ts). The store's meta merge rule
(null never downgrades) means M2 can stamp fingerprints without a
schema bump.
