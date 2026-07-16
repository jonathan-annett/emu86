# Phase 18 M2 report — capture/restore protocol, save-states, reload-resume

Landed 2026-07-16, same day as M1. Brief: `emu86-phase18-brief.md` §3
M2 plus its recorded design addendum, under D2 (a — decided via the
M2 go-ahead), D4 (as recommended), and §1.3's laptop-resume law. The
in-repo acceptance — **the equivalence harness green across the
protocol round trip** — is met; the crown telnet scenario and the
mid-compile save are field acceptance (M4, Jonathan's pass).

## 1. What landed

**Protocol** (`src/browser/protocol.ts`):
- `capture-state` (main→worker): requestId + `disks: 'embedded' |
  'reference'`.
- `state-captured` (worker→main): machine state (M1's structured
  form), capture timestamp, this boot's base fingerprint, SHA-256 of
  the primary/secondary images at capture, secondary bytes in BOTH
  modes (the fork row's one-snapshot-one-truth), primary bytes in
  embedded mode only. Disk buffers ride as Transferables.
- `restore-result` (worker→main): ok/refused + why + the capture's
  timestamp, posted just before `ready`.
- `BootConfig.restore`: the captured state + either `embedded`
  (verbatim disk bytes) or `expected` (SHA-256s the normally-resolved
  disks must match).

**Worker** (`worker-host.ts`):
- Capture runs its machine-touching part synchronously at the message
  boundary (the snapshot-secondary coherence precedent), with the
  §1.4 two-phase built in: a final overlay sweep posts FIRST (pending
  epoch nacked back so the sweep is complete — the reset-path flush
  precedent), then machine + disk copies; hashing and the reply
  complete async over the copies while the machine keeps running.
  The secondary snapshot is a PEEK — the dirty count survives, so a
  capture can never starve the fork auto-persist.
- Restore is a boot variant per §1.1: embedded restores bypass the
  entire resolve pipeline (no fold, no bootopts patch, no M3 stamps —
  re-stamping would fight the captured RAM's buffer cache); reference
  restores run the NORMAL pipeline and are hash-verified. Then reset
  as the clean baseline, `restoreMachineState` overwrites, and any
  refusal or failure cold-boots the resolved disk — the user always
  gets a working machine, and `restore-result` says which one.
- `WorkerHostOptions.hostClock` injection (default `NodeHostClock`,
  unchanged) — the protocol equivalence tests need the M1 harness's
  frozen-clock ground rule.
- `snapshotDisk` generalized from `InMemoryDisk` to `Disk` (overlay
  writes pass through to the inner disk, so sector-looping the
  wrapper IS the current image).

**Storage** (`web/machine-store.ts`) — `emu86-machines`, the fourth
IDB tenant, on the OverlayStore template (own DB, meta + payload
stores, one-tx writes, lazy ready(), onclose self-heal). Meta from
day one: stateId, label, kind, createdAt (survives overwrites — slot
identity), lastTouched, baseFingerprint, schemaVersion (non-
negotiable; restore refuses other eras), sizeBytes. Named-save disk
images are gzipped at rest (`web/gzip.ts` grew `gzipBytes`, the
compress half the tree never had — same explicit feed/drain pump as
the inflate side, still zero dependencies).

**Main** (`web/main.ts`, `web/settings-modal.ts`,
`web/session-store.ts`):
- Settings → Machine state grew **named save-states** (D4 library
  semantics: never aged out, user-deletable): Save captures the
  running machine with embedded disks; Restore queues
  `pendingRestoreStateId` in sessionStorage and reloads (the
  overlayResetPending pattern — a running machine can't un-write its
  RAM); the list shows label, time, stored size.
- **Reload-resume** rides `visibilitychange → hidden` (the overlay
  flush's hook and its exact best-effort assumptions): a 'reference'
  capture refreshes the tab's resume slot (`resume-<sessionId>` — the
  session store's documented intended key) and writes the fork row
  from the capture's own secondary bytes. At the next boot the slot
  restores ONLY when the overlay session verdict is 'reload' (the
  Web-Lock duplicate detect): duplicates and degraded mode cold-boot,
  per the brief's mandatory fallback.
- Honesty: a fresh resume is silent; older than 10 s (field-tunable
  constant) prints `[resumed machine state from <age> ago]`; a
  refusal prints why and deletes the stale resume slot (the next
  hidden-capture rewrites it). A successful restore touches its row
  (GC warmth).
- Resume slots are GC'd by the unheld-lock + 7-day-staleness
  conjunction (`gcOrphanResumeSlots`, the gcOrphanForks pattern);
  each tab holds a Web Lock on its own slot.

## 2. The two disk carriages (the load-bearing design call)

Named saves embed the disks (D2(a) as decided): gzip ~10:1, byte-
exact including stamps, GC-safe, restorable months later regardless
of what happened to the base image or the overlay rows.

The reload-resume slot uses D2(b) REFERENCE form — machine state +
SHA-256s only (~1 MB written at hidden), with the primary
reconstructed at boot by the normal base → overlay fold → bootopts
patch → M3 stamps pipeline and verified against the capture hash.
This is the design addendum recorded in the brief before
implementation: a 32 MB embedded capture cannot reliably win the
unload race at refresh, while the disks are ALREADY continuously
persisted (overlay sweeps + fork row). The verification makes every
drift case — lost final sweep, changed autologin setting, a
different octet's identity stamps, a consumed factory reset, an
mkdrive fork swap — land in the same honest refusal + cold boot.
That unification is why the refusal path gets its own tests.

Why reference reconstruction is byte-exact when nothing drifted: the
capture's final sweep put every boot-disk write in the overlay store;
the bootopts patch and image stamps are idempotent pure functions of
(identity lines, autologin, fork size); the sticky octet re-lease
reproduces the identity lines (recon: the MAC is a pure function of
the octet, `tanIdentityFor`). Same inputs, same bytes, same hash.

## 3. What is deliberately NOT carried (laptop-resume, §1.3)

Host-terminated flows die with the page and are not serialized: DoH
resolves (guest's 2 s alarm), gateway fetches, host TcpStack
connections (the stack RSTs segments for unknown conns — restored
ktcp sockets to host services die cleanly on first use), control
round-trips (10 s honest timeout). The TAN lease is never cloned —
the restore boot re-acquires with the sticky octet exactly like any
reload. Guest↔guest TCP is deliberately NOT dropped: both ends'
connection state lives in guest RAM, which is exactly what the
snapshot carries; the fabric is pure L2 and cat's ktcp bridges the
gap by ordinary retransmission (frames that arrive while the tab is
down drop harmlessly; RTO covers it). The pacer needs no new work:
the paced loop opens with `pacer.skip()` on every boot, restore
included.

## 4. Findings / seams for the field pass

- **Octet drift posture (v1)**: if the sticky octet fails to re-land
  (another tab claimed it while this one was gone — possible for old
  resumes), the reference restore refuses via the stamp hash and
  cold-boots. An EMBEDDED restore proceeds regardless — its RAM and
  PROM carry the captured identity while the lease may have settled
  elsewhere: the D5(b) ghost-until-reboot class, accepted for v1 and
  recorded here. The honest notice covers it; a reboot re-stamps.
- **Restored screen state**: the CGA mirror only sees writeByte
  traffic, and M1's RAM restore writes slabs directly — a restored
  machine's B8000 region is correct in RAM but not re-rendered. The
  browser is a serial console, so in practice the xterm simply
  starts empty until the guest next prints; pressing Enter at a
  shell redraws the prompt. Recorded, not fixed.
- **BrowserConsole RX queue**: keystrokes queued main-side but not
  yet drained into the UART at capture vanish (sub-16-byte seam,
  matches the FIFO pacing design).
- **Archived-build caveat** (session store): `pendingRestoreStateId`
  is additive — an archived build's session save drops it, costing
  at most one queued restore across a version hop.
- The hidden-handler capture replaces the old maybeAutoPersist(true) +
  overlay-flush pair (both effects now ride the capture itself); the
  old pair remains as the fallback when the capture path throws.

## 5. Test evidence

- `npm run typecheck` — clean across all three configs.
- New units: `machine-store.test.ts` (6 — round-trip incl. typed
  arrays through fake IDB, createdAt-survives-overwrite, GC
  lock+staleness conjunction, degraded mode), `gzip.test.ts` +2
  (compress round trip, node:zlib interop), `worker-host-state.test.ts`
  (6 — capture semantics incl. the dirty-count peek, embedded round
  trip + lockstep continuation, reference reconstruction from
  collected sweeps + verify + lockstep, hash-mismatch refusal →
  cold boot, corrupt-schema refusal → cold boot).
- Integration: `state-equivalence.test.ts` grew the **protocol round
  trip over real ELKS** — 500k boot through WorkerHost,
  `capture-state` embedded, restore into a fresh host via
  `BootConfig.restore`, 250k more on both, byte-identical machine
  state. All three harness tests green (~23 s).
- Full suite (2026-07-16): **1,385 passed | 1 skipped tests; 129
  test files passed, 2 skipped** (the standing skips), zero
  failures, 873 s. Prior baseline 1,370 (M1 close); the +15 delta is
  exactly the new tests (6 store + 2 gzip + 6 protocol + 1
  integration round trip).

## 6. Not done here (M3/M4)

- The clone (M3): D3 transport stays open; the handshake at
  duplicate-detect, parent-side capture at request time, and D5(b)'s
  trunk-detached posture are all unbuilt.
- Field acceptance (M4): the crown telnet scenario (mouse telnets
  cat, refresh, <500 ms, session resumes), the mid-compile save →
  reload → compile-finishes pass, and threshold tuning are Jonathan's
  pass on the dev tier. Deploys stay his.
