# Phase 17 M2 Report — boot fold, identity, lifecycle

2026-07-15, the same session as M1 — built while Jonathan
field-tested the M1 dev deploy in parallel (his live #olfr notes are
in §4). Scope: brief §3 M2 — BootConfig overlay carriage, worker-side
SHA-256 fingerprint check, fold before stamps, the
overlayId/lock/duplication/GC lifecycle, factory reset, the two-boot
integration acceptance.

## 0. TL;DR

**The machine now keeps its own state.** Reload a tab and the guest's
root filesystem comes back exactly where it left off (modulo the
recorded ≤5 s sweep window): main resolves the tab's overlay session
pre-boot (fresh / reload / duplicate / queued-reset), ships the
stored chunks in `BootConfig.overlay`, and the worker folds them into
the base image ONLY when the SHA-256 it computes over the pristine
bytes matches the fingerprint the chunks were swept under. Mismatch =
fold refused + reported + the tab's sweeps move to a fresh id so the
kept state can't be clobbered; discard is a settings action. Factory
reset ("Reset machine state…" in settings) queues a pristine boot for
the next reload. The two-boot acceptance passed first run: marker
survives the reboot, ELKS fsck judges the FOLDED root device clean,
and a wrong fingerprint leaves the base untouched.

## 1. What was built (files)

- `src/disk/overlay.ts`: `foldOverlay` (chunks over a zero-padded
  full-disk buffer; self-describing chunkSizeBytes so a future
  retune can't misread old rows; throws on out-of-range — after a
  fingerprint match that's a corrupt store, not a tolerable
  mismatch) and `sha256Hex` (crypto.subtle, no deps).
- `src/browser/protocol.ts`: `BootConfig.overlay?` ({ chunks,
  chunkSizeBytes, fingerprint }) and `overlay-identity`
  (worker→main, every boot, BEFORE `ready`: fingerprint + applied +
  chunksOffered).
- `src/browser/worker-host.ts`: `#resolveSlot` hashes the pristine
  primary every boot, folds on match, and then — the one subtle
  ordering decision, §2 — runs the bootopts stamp UNCONDITIONALLY
  after a fold.
- `web/overlay-session.ts` (new): the lifecycle state machine,
  mirroring drive-session.ts shape-for-shape — `overlayLockName`
  funnel, `resolveOverlaySession` (fresh / reload /
  duplicate-copies-under-fresh-id / queued-reset-with-probeFree),
  `gcOrphanOverlays` (unheld + 7-day stale, never guesses),
  M1-era null-fingerprint rows deleted silently on first touch.
- `web/session-store.ts`: `overlayResetPending` (the pendingBlankKb
  pattern: queued by settings, consumed at next boot).
- `web/main.ts`: overlay session resolved pre-boot beside the drive
  fork (same `createWebForkLocks` instance — the wrapper was already
  generic); chunks ride the boot postMessage as Transferables;
  `overlay-identity` handler stamps the fingerprint into future
  sweeps and runs the mismatch flow (fresh id + terminal notice);
  settings modal gains the machine-state callbacks.
- `web/settings-modal.ts`: "Machine state" section — factory reset
  (queues, "reload to apply"), plus a "Discard state from previous
  base image" row that appears only after a mismatch this session.
- `tests/integration/guest-drive-harness.ts`: `bootGuest` gains an
  optional overlay param (additive; existing callers untouched).

## 2. Decisions recorded

- **After a fold, the bootopts stamp runs unconditionally.** The
  folded image carries the PREVIOUS session's stamped block —
  console=ttyS0 present, stale LOCALIP — so the old
  `!hasSerialConsole(bytes)` guard would SKIP the patch and leave a
  stale address stamped (wrong after a duplicate re-leases). The
  patch is idempotent by construction (drops active
  console=/ne0=/DNSIP=/LOCALIP= claims, re-appends ours), so
  re-running it is exactly the brief's §1.4 semantic: the stamp
  region is ours-per-boot, fold or no fold; the guest's OTHER
  bootopts lines survive. A guest-crammed block that throws the
  patch's 1023-byte limit boots unpatched with a console warning —
  stamps are conveniences, never gates; factory reset is the escape
  hatch.
- **The fingerprint hashes the PRISTINE bytes**, before fold and
  before stamps — identity is the base image, not our per-boot
  decorations (which vary by tab via LOCALIP/HOSTNAME).
- **Mismatch = keep, by construction.** The worker refuses the fold;
  main moves this session's sweeps to a freshly minted overlayId and
  keeps holding the OLD id's lock (acquired at resolve), which
  shields the kept rows from GC for the tab's lifetime. Discard is
  explicit (settings). Honesty: once no tab holds that lock, the
  kept rows age into the 7-day GC like any closed tab's — "keep"
  means "not deleted now", not "archived forever".
- **Factory reset queues rather than acting live** (the mkdrive
  pendingBlankKb precedent): a running machine can't un-write its
  RAM, so the settings button sets `overlayResetPending`, consumed
  at the next boot — with the probeFree guard so a duplicated tab
  that inherited the flag can't delete rows the original is still
  sweeping onto.
- **M1-era rows (null fingerprint) are deleted silently at first M2
  resolve** — never folded, no UI. M1's report §3 recorded why:
  they're incoherent cross-session mixtures swept without ever
  folding, and they were only ever writable by the one-day dev-tier
  M1 build.
- **The identity report posts on every boot** (not just overlay
  boots) and before `ready` — main needs the fingerprint to stamp
  sweeps from the first epoch, and needs the mismatch verdict before
  any user-visible state claims.
- **Lock wrapper reused as-is** from drive-session.ts
  (`createWebForkLocks` / `ForkLocks`) — it was already
  name-agnostic; renaming/moving it would be refactor-for-taste
  (rule 3). Noted, not changed.

## 3. Honest limits

- **The loss window stands** (M1 §3, unchanged): up to ~5 s of guest
  writes between the last sweep and a hard tab kill. The fold
  restores "byte-identical to where the guest left off (modulo the
  sweep window)" — the brief's own honesty class.
- **A fold ships the whole overlay through one postMessage.** Chunk
  buffers transfer (zero-copy), but a machine with tens of MB of
  divergence still costs one IDB read + one worker fold pass per
  boot. Unmeasured beyond the integration test's scale; the phone is
  the risk, telemetry (overlayHotSectors) is the watch.
- **Mismatch UI is a terminal notice + settings row**, not a modal —
  keep-by-default. The brief asked for "keep/discard" surfacing;
  this is the smallest honest version. If the field wants a louder
  prompt, that's a UI iteration, not a mechanism change.
- **fsck runs on the mounted root** (`sync; fsck /dev/hda`) in the
  acceptance — same as a real admin would on ELKS (no unmount of
  root exists). It exited silent; that's the oracle's verdict on the
  folded image's bookkeeping.
- **The stale-overlay discard button lives for this session only**
  (the stale id is main-thread state) — after a reload with the
  mismatch still present, the notice and the row simply reappear.

## 4. What was verified

- `tests/integration/overlay-two-boot.test.ts` — the brief's M2
  acceptance, first-run pass (~54 s, three full ELKS boots): marker
  written + synced + swept (flush AND the reset-path final sweep,
  merged idempotently as the store would); boot 2 folds → `cat
  /root/m` returns the marker, `fsck /dev/hda && echo FSCK-OK`
  silent-clean; boot 3 with a wrong fingerprint → fold refused,
  marker absent, base pristine.
- `tests/unit/overlay-session.test.ts` (11) — fresh / reload /
  reload-empty / duplicate-copy (rows independent after copy) /
  duplicate-never-swept / M1-era disposal / queued reset (flag
  cleared, fresh id) / inherited-reset-can't-delete-parent / GC
  sweep-spare matrix / GC never guesses.
- `tests/unit/disk-overlay.test.ts` (+3) — foldOverlay offsets,
  zero-pad, short tail, out-of-range + oversize rejection; sha256Hex
  against the empty-string and "abc" NIST vectors.
- `tests/unit/worker-host-overlay.test.ts` (+3) — identity on every
  boot (and ordered before `ready`); fold applied (folded state is
  RAM baseline, NOT hot-map content); fold refused on mismatch.
- `tests/unit/session-store.test.ts`, `browser-protocol.test.ts` —
  new field + new message shapes; the exhaustiveness switches
  tripped on `overlay-identity` as designed.
- Typecheck clean across all three configs.
- **Full suite: 1,328 passed / 122 files / 1 skipped — the new
  baseline** (was 1,308 / 120 after M1).
- **Field (Jonathan, live on the M1 dev deploy while M2 was built)**:
  dev tier confirmed on 9beefce; chunks + meta visible in
  emu86-overlays; meta.lastTouched advanced after `rm` + `sync`
  (sweep + hidden-flush paths); refresh boots pristine — the M1
  write-only contract, observed working before M2 changed it. His
  focus ask (terminal focus after refresh) shipped separately
  (6b5076a).
- **M2 FIELD PASS (Jonathan, 2026-07-15, dev tier @ 12a2f5b): all
  five behaviors check out** — persistent rm across reload, queued
  factory reset, duplicate-then-diverge, base-switch mismatch notice
  + discard, terminal focus. One suggestion, applied same session:
  the reset button names WHOSE state it resets ("Reset 'mouse'
  machine state…" — the tab's .tabs name at render time).

## 5. Pointer for M3

The stamp set (net= bootopts / mount.cfg marker append / passwd home
surgery) applies to the FOLDED image — the fold-then-stamp order and
the unconditional-restamp precedent from §2 are the pattern to
extend. §4.6's autologin (default user1) needs the passwd surgery
retargeted at user1 and a decision on the blank-fork /home case —
settle against the real image with the minix-fs module, per the
brief. The un-typed boot's acceptance bar: reload → personalized
prompt, net up, /home mounted, NOTHING typed.
