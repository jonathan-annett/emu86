# Phase 18 brief — frozen in amber (whole-machine state capture)

Drafted 2026-07-15, the same session that shipped Phase 17 end to
end (promoted stable b72851d). Jonathan called it minutes after the
promotion: "i think the next thing on the agenda is the full capture
of running state? so tab duplicate = frozen in amber." This is §3.5's
first back-burner item, unblocked by his own recorded sequencing —
"the overlay comes first, then once proven we can investigate the
captured state idea" — and the overlay is proven in the field as of
tonight. Ground truth in §2 was surveyed tonight (two parallel
recon passes over the machine's state surface and the cross-tab
plumbing); the §4 decisions are OPEN until Jonathan rules.

## 0. What this is, and what it is NOT

One mechanism, three payoffs, in order of increasing difficulty:

1. **Save-states**: freeze the RUNNING machine to a named artifact;
   restore it later in the same tab. No identity problem.
2. **Reload-resume**: the tab comes back exactly where it was —
   subsumes the old "golden boot overlays" instant-on idea. Same
   no-identity-problem shape, automatic trigger.
3. **Tab duplicate = frozen in amber**: a duplicated tab resumes the
   parent's LIVE state via handshake at duplicate-detect. THE
   headline, and the only shape with an identity problem (§2.5
   hard problem 1).

NOT this phase:

- **The TAN per-tab-NAT redesign** (§3.5's second item) — unless D5
  rules otherwise, the clone ships with the recorded ghost-until-
  reboot wart, and the NAT redesign stays next on the back burner.
- **Cross-machine portability of save-states** (export/import
  files) — the artifacts live in this origin's IDB. Later.
- **Pause/resume UI beyond what save/restore needs** — no debugger,
  no single-step UI. The probe harness owns that world.
- **Serializing in-flight host I/O.** Laptop-resume semantics are
  the LAW of this phase (§1.3): pending DNS/fetches fail, TCP
  conns drop and RST, wall time re-anchors. Recorded in §3.5 and
  confirmed cheap by recon (the guest's own timeouts and the
  stack's RST-unknown-conn behavior do most of the work).

## 1. Design settled by recon (do not relitigate without new facts)

### 1.1 Coherence is free; capture is a message

Worker messages land between run turns, never mid-`step()` — the
`snapshot-secondary` handler already relies on this
(worker-host.ts:369). A capture request needs NO pause flag; the
machine is coherent at every message boundary. Restore = boot
variant: run `#boot` up to where `machine.reset()` fires
(worker-host.ts:982), reset AS the clean baseline, then overwrite —
RAM first (before the CGA mirror installs — the mirror wraps
memory.writeByte and would stream 0xB8000+ into the xterm), then
devices in the machine's own reset order (ibm-pc.ts:429), CPU
registers LAST, `#pacer.skip()` (its docstring is literally
"stalled wall time must not become guest time"), then run.
Reset-then-overwrite, never reset-after-restore.

### 1.2 What a snapshot carries (~1 MiB + small change, before disks)

- RAM: ≤256 × 4 KiB resident pages (ROM pages excluded — rebuilt
  deterministically by `buildBiosRom()`); the BDA rides along free
  (tick count, keyboard ring — it's guest RAM).
- CPU: registers/flags/halted via the EXISTING snapshot pair
  (cpu.ts:290) — which recon caught missing `interruptInhibit`
  (legal cross-boundary state, the STI window). Fix ships in M1
  regardless of everything else.
- Interrupt controller FIFO + nmiPending (a PIC-raised vector can
  legally sit queued).
- Devices, each gaining an explicit serialize/restore pair — none
  have one today, and existing inspect()/getters are decorative,
  not sufficient (UART's thriArmed/irqPending, PIT's latched VALUES
  and flip-flops, KBC's multi-byte command state, PIC's mid-ICW
  state, NE2000's 16 KiB packet ring + remote-DMA engine). RTC =
  index + CMOS scratch only (time is wall-served — resume-correct
  by construction). Clock = the cycle counter.
- Gateway/DNS ARP tables + switch CAM (tiny): recon hard problem 5
  — they learn only from ARP frames, the restored guest may never
  re-ARP, so dropping them kills networking SILENTLY. Serialize
  them consistent with the restored RAM.

### 1.3 Laptop-resume seams (fail deliberately, at restore)

DNS pendingResolves → dropped (guest's 2 s alarm handles it).
Gateway fetches + TcpStack conns → dropped; the stack already RSTs
segments for unknown conns, so ktcp's ESTABLISHED sockets in
restored RAM die cleanly on first use. Control round-trips → the
existing 10 s honest timeout. TAN lease → NEVER cloned; re-acquire
(defend/repick was built for copied-sessionStorage octets). Pacer →
skip(). Overlay timing anchors → reset (epoch seq already survives
teardown by design).

### 1.4 The two-phase disk truth

A snapshot is consistent only with its disks: capture forces an
overlay sweep and awaits the ack (the reset-path flush precedent),
and force-persists the fork (maybeAutoPersist(true) precedent),
BEFORE declaring the state saved. What restore feeds the primary is
D2's call (§4) — the subtlety recon surfaced: per-boot stamps never
enter the overlay, so base+overlay+re-stamp is byte-exact only when
the identity stamps match, while restored guest RAM holds the
PARENT's stamped blocks in its buffer cache.

### 1.5 Storage: `emu86-machines`, the fourth tenant

OverlayStore is the template (own DB, meta + blob rows, compound
keys, one-transaction writes, fingerprint discipline: null never
restored silently, real never downgraded). Meta from day one:
{ stateId, label, createdAt, lastTouched, baseFingerprint,
schemaVersion, sizeBytes } — schemaVersion is non-negotiable;
device formats will churn (the settings key-per-era lesson).
The gzip helper is in-tree (web/gzip.ts): RAM images and full disk
images compress ~10:1.

### 1.6 The equivalence harness is LAW

Every device pair lands with the test: run N steps → snapshot →
restore into a fresh machine → M steps ≡ run N+M steps straight,
byte-compared over RAM + device serializations (plain-loop
compares; the toEqual-on-MB lesson stands). Recon's judgment,
adopted: missing any one private field produces rare post-restore
heisenbugs, and the harness is the only honest defense. The CPU
snapshot's interruptInhibit gap — drifted for 13 phases unnoticed —
is the proof it's needed.

## 2. Ground truth (surveyed 2026-07-15, file:line in the session
reports; load-bearing subset here)

1. CPU8086.snapshot/restore exists (cpu.ts:290-304), missing
   `interruptInhibit` (cpu.ts:95; snapshot shape :32-37). The
   repo's ONLY true serialize pair today.
2. PagedMemory has NO page-bytes accessor (per-byte reads only,
   paged-memory.ts:95); writeByte silently drops ROM writes and is
   wrapped by the CGA mirror when installed. Clock can only
   advance() (ticks the PIT!) or reset-to-zero (clock.ts:82-114).
   Both need small state-plane additions — surfaced here per hard
   rule 3, not quietly refactored.
3. No browser PageStore: #boot constructs IBMPCMachine without one
   (worker-host.ts:956-973) — the dirty-page machinery is inert in
   the browser; snapshot enumerates residentPages().
4. Duplicate-detect happens MAIN-side, pre-worker, with the
   parent's ids in hand and the parent provably alive (the held
   Web Lock): drive-session.ts:160, overlay-session.ts:134. In the
   no-Web-Locks degraded mode duplication is undetectable —
   cold-boot fallback is mandatory, not optional.
5. The TAN channel is the tree's only BroadcastChannel
   (worker-side, web/worker.ts:57); its claim/here discipline
   (announce, reply-once, never reply to a reply — tan.ts:93-120)
   is the only cross-tab request/reply precedent. BroadcastChannel
   cannot carry transferables — a snapshot on it structured-clones
   to every listener.
6. Hard problem 1 (recon, verbatim class): restored RAM carries the
   parent's LOCALIP/hostname/MAC — the MAC is also baked into the
   NE2000 PROM — while the lease correctly repicks. A trunk-attached
   clone either duplicates MAC+IP on the fabric or contradicts what
   the guest already read at driver init. Same-tab shapes have no
   such problem. (§3.5's TAN-NAT sketch is the recorded real fix.)
7. Baseline at drafting: 1,342 passed / 2 skipped (SST corpus +
   env-gated ping generator); stable = b72851d, promoted tonight.

## 3. Milestones

### M1 — the state plane + equivalence harness

**LANDED 2026-07-16 — `PHASE18_M1_REPORT.md` is the record.** Every
§1.2 pair exact-state (no D6 downgrades); harness green at two ELKS
checkpoints including a post-prompt live-command continuation.

Serialize/restore pairs for every §1.2 component; the CPUSnapshot
interruptInhibit fix; PagedMemory page-bytes accessor + Clock
silent cycle setter (the two rule-3 additions, scoped here);
versioned per-device schemas; the N/M equivalence harness running
over a real ELKS boot checkpoint. No protocol, no UI, no IDB.

### M2 — capture/restore protocol + save-states + reload-resume

**BUILT 2026-07-16 — `PHASE18_M2_REPORT.md` is the record; the
in-repo acceptance (equivalence harness green across the protocol
round trip, refusal honesty, the tenant) is met. The crown telnet
scenario + mid-compile save are M4's field pass.**

**The crown acceptance (Jonathan's scenario, 2026-07-16, verbatim
goal): "mouse telnets to cat, mouse's browser is refreshed. on
restore, timestamps are compared, and < 500ms, nothing breaks. the
telnet fake tcp connection is resumed."** Why this is sound, not
hope: guest-to-guest TCP is real ktcp on BOTH ends and our fabric is
pure L2 — the connection state lives in the two guests' RAMs, which
is exactly what the snapshot carries. Cat's ktcp bridges the gap by
ordinary retransmission (its RTO tolerates far more than 500 ms);
mouse restores with seq/ack state intact, the SAME octet (the
sticky-IP reload flow already re-offers it) and the same derived
MAC; the rebuilt switch floods-then-learns. So §1.3's laptop-resume
drops apply ONLY to HOST-terminated flows (gateway fetches, DoH,
host TcpStack conns — their browser promises died with the page);
guest↔guest TCP is deliberately NOT dropped. The capture carries a
timestamp; restore compares age and gates messaging/expectations on
it (fresh ⇒ silent resume; stale ⇒ honest "resumed from <when>"
notice — thresholds field-tuned).

`capture-state` / `state-captured` messages (two-phase with the
overlay sweep + fork persist per §1.4); `BootConfig.restore`
carriage; the `emu86-machines` tenant; settings "Machine state"
section grows save/restore-named-states; reload-resume as an
automatic slot (D4 shapes ownership/GC). Acceptance: mid-compile
save → reload → restore → the compile FINISHES; equivalence
harness green across the protocol round trip; fingerprint mismatch
refuses with the M2-overlay honesty.

**M2 design addendum (2026-07-16, recon-driven, recorded before
implementation):** named saves = D2(a) embedded disks, as decided;
the reload-resume slot = D2(b) REFERENCE disks — machine state only
(~1 MB), captured at `visibilitychange→hidden` (the overlay-flush
hook), because a 32 MB embedded capture cannot reliably win the
unload race at refresh. The slot's primary is reconstructed at boot
by the NORMAL pipeline (base → overlay fold → bootopts patch → M3
stamps) and verified against the capture-time SHA-256; the fork
bytes ride in the capture reply itself (one snapshot, one truth —
the row is written from the same bytes the hash was computed over).
ANY mismatch — stamp drift, lost final sweep, changed autologin,
different octet — refuses the resume and cold-boots with the
honest notice. Same-tab-ness gates the slot: resume only when the
overlay-session verdict is 'reload' (the Web-Lock duplicate detect);
duplicates and degraded mode cold-boot. Restore of either shape
rides one code path: a sessionStorage pending-restore pointer +
`location.reload()`, threading `BootConfig.restore` at boot.

### M3 — the clone (headline, gated on D1/D5)

Handshake at duplicate-detect (shape per D3), parent snapshots at
request time (no staleness window), child boots restore-variant
with fresh TAN identity and D5's chosen identity posture.
Degraded-mode cold-boot fallback with a timeout, always.

### M4 — field acceptance + reports

Jonathan's pass; PHASE18_*_REPORT.md per milestone; the closing
field record. The promotion cadence stays his.

## 4. Open decisions — Jonathan rules

- **D1. Sequencing — DECIDED YES (Jonathan, 2026-07-16)**: same-tab
  shapes first ("the capture is sufficient for a tab to survive a
  refresh ... reasonable for the first step"), clone last.
- **D2. Disk capture — DECIDED (a) (Jonathan, 2026-07-16: "go ahead
  for m2" after the M1 report flagged D2/D4 as M2's needs; the
  recommendations stand)**: SELF-CONTAINED — snapshot embeds the
  full primary image (+ fork bytes), gzip ~10:1, byte-exact
  including stamps, GC-safe, ~3-6 MB stored. (b) REFERENCE —
  base+overlay+re-stamp reconstruction — stays recorded for the
  auto reload-resume slot if quota bites.
- **D3. Clone transport — DECIDED (a) (Jonathan, 2026-07-16, "ok
  lets do these in order" over the queue that named it)**: parent
  writes the snapshot to `emu86-machines`, broadcasts only the
  stateId, child reads IDB — no N-tab structured clones, one code
  path shared with save-states. Implementation notes settled with
  it: a two-phase handshake (request → accepted → ready, timeouts
  on both phases, cold boot on any miss); the child MINTS A FRESH
  sessionId at duplicate-detect (also fixes the standing wart of a
  duplicate fighting its parent for one resume-slot row); clone
  rows are kind 'clone', deleted by the child after the restore
  reads them, age-swept at boot as a backstop; the clone session is
  embedded-verbatim, so like a named-save restore it has NO
  reload-resume until its first reboot — recorded v1 wart, heals on
  reboot, consistent with D5(b)'s detached-cable posture.
- **D4. Save-state ownership — DECIDED as recommended (Jonathan,
  2026-07-16, same go-ahead as D2)**: named saves = user-curated
  artifacts (never aged out, user-deletable — library semantics);
  the reload-resume slot = tab-owned, lock+staleness GC'd (overlay
  semantics).
- **D5. Clone network identity, v1 — DECIDED (b), Jonathan,
  2026-07-16**: trunk-detached clones ("the duplicate tab problem is
  fine as (b) we can work on a rational plan to deal with that in a
  later phase"). The clone is fully frozen-in-amber on disk and RAM;
  its network cable hangs loose until a reboot re-leases fresh
  identity. Options (a)/(c) stay recorded for that later phase.
- **D6. v1 fidelity bar**: exact-state for EVERY §1.2 device, the
  harness enforcing — RECOMMENDED (reset-plus-fixups for "boring"
  devices is where heisenbugs breed); flag any device that proves
  intractable in M1 rather than quietly downgrading.

## 5. Hard-rule notes

- Rule 1 untouched: capture/restore live at message boundaries;
  nothing async enters cpu.step().
- Rule 2: no new deps — gzip helper exists, IDB patterns exist,
  crypto.subtle fingerprints exist.
- Rule 3: the PagedMemory/Clock state-plane additions are the
  scoped exceptions, declared in §2.2/M1; everything else is
  protocol-layer + new modules.
- Rule 6 cadence unchanged: full suite gates deploys; the
  equivalence harness gates every M1 device pair.

## 6. Field fix #4 — the torn resume pair (addendum 2026-07-16,
## approved in-session: "go for #4")

Field (M4 loop, the telnet scenario): "managed to get the telnet
test to work once. most of the time the disk does not reconstruct
properly" — the reference restore's honest refusal, nearly every F5.

**Diagnosis (traced in source, this session).** The resume pair —
overlay chunks in `emu86-overlays`, slot row in `emu86-machines` —
is written by two independent IDB transactions in different
databases, so it can never commit atomically. The capture's flush
posts its chunks BEFORE the reply (the sweep message beats the
32 MiB snapshot+SHA by hundreds of ms), so the chunk write always
gets a head start on the slot write; on the forced
visibilitychange-hidden capture the chunk transaction wins the old
page's teardown grace and the slot write (queued behind the hash
AND the fork-row `updateImageBytes`) loses it. The store ends AHEAD
of the slot's `primarySha`; the reconstruction is refused — the
check working as designed against genuinely incoherent state we
ourselves created. Field fix #2 closed the maintenance-sweep race;
the capture's OWN flush at teardown was the remaining (dominant)
tear. Same class exists for the secondary via the fork row (masked
today by the primary refusing first). The one field success = no
boot-disk writes since the last completed pair (empty flush,
nothing to tear).

**Fix — the slot carries its own delta.** No write ordering can fix
this (either surviving half mismatches); atomicity across three IDB
databases doesn't exist; so make every tear resolve to a consistent
pair:

1. Reference captures stop posting `overlay-sweep`. The final epoch
   rides INSIDE the `state-captured` reply; the worker keeps it
   pending until main acks (existing `overlay-swept` message) and
   the 10 s ack-timeout still nacks abandoned epochs. Embedded
   captures stop sweeping entirely (their flush only advanced the
   store past the resume slot — a smaller cousin of the same tear).
2. The slot row gains the carried deltas: `carriedPrimary` (the
   reply's epoch chunks) and `carriedSecondary` (the dirty sectors
   at capture, bytes sliced from the reply's own secondary
   snapshot). Main's write order per capture: **slot row FIRST**,
   then fork row, then overlay chunks, then the acks. A failure
   anywhere nacks, and the worker folds the delta back.
3. Secondary dirty-tracking becomes two-phase (`beginClean` /
   `ackClean` / `nackClean`, the overlay epoch pattern): dirt only
   clears when main CONFIRMS the fork write committed (new
   `secondary-persisted` message). Carried is thus always a
   superset of "differs from the committed row" — over-carrying is
   idempotent and safe; under-carrying was the bug.
4. Restore reconstructs base → store fold → carried, hash-checking
   on SNAPSHOTS (no live-disk mutation until both hashes pass, so a
   refusal falls back to today's cold boot untouched). On success
   the carried deltas are written through the OverlayDisk/tracker
   wrappers — re-hot-mapping them so they re-enter the persistence
   chain (the bootDeltaLbas seeding precedent; without this, a
   slot-committed/store-lost resume would strand the carried bytes
   outside every future reconstruction).

Invariant restored: whatever subset of {slot, fork, chunks}
survives a teardown, the newest COMMITTED slot row always
reconstructs — carried ⊇ writes-since-last-acked ⊇
writes-since-last-committed, and nothing newer than the slot can
reach the store because chunk/fork writes are ordered after it.

**Residual accepted (unchanged from M2):** the forced 4 MiB sweep
still writes the store mid-pair under heavy I/O; an F5 inside that
≤5 s window cold-boots honestly and the next capture heals it.
Sweep suppression (field fix #2) stays load-bearing.

## 7. The 0-stale capture (addendum 2026-07-16, approved: "ok lets
## do these in order" — first in the queue)

Field result that motivates it: with fix #4 in, the IDLE telnet
crown passes ("sitting at the command line in a remote tab was
absolutely fine") but an ACTIVE-flow session dies — tetris on the
remote tab, F5 the client, and the peer's ktcp exhausts retransmits
("tcp retrans: max retries exceeded"). Cause: the resume slot rides
the 5 s heartbeat, so a restore rewinds the client's TCP state to
before bytes the peer has already seen ACKed and discarded —
unrecoverable by construction, however patient the peer. The only
fix is freshness: capture AT the F5, not near it.

What blocks freshness: every reference capture copies and SHA-256s
the whole 32 MiB boot disk to produce `expected.primarySha`
(~300 ms+), so the visibilitychange-forced capture loses the
teardown race and the slot stays heartbeat-stale.

**The change: verify the INPUTS, not the output.** The
reconstruction is base → store fold → carried delta; byte-identity
is guaranteed by construction if the inputs are pinned:

1. base: the fingerprint gate (exists, unchanged);
2. carried: rides the slot row itself (fix #4, trusted);
3. the store: NEW — pinned by a **store digest**: sha-256 over the
   sorted (chunkIndex, sha-256(chunkBytes)) pairs of the store's
   rows, EXCLUDING indexes the carried delta covers. The worker
   maintains the acked-chunk hash mirror incrementally (hash each
   epoch's chunks at sweep time — O(delta); ≤2048 entries even for
   a 64 MB disk), seeded at boot from the offered fold's rows.
   Capture computes digest(mirror \ carried) in microseconds.

The exclusion is what makes committed-but-unacked epochs harmless:
a nacked epoch's sectors fold back into the hot map, so the next
carried delta SUBSUMES it — both sides of the comparison drop those
indexes, and the fold overwrites them with capture-time bytes
anyway (the fix-#4 invariant, reused).

Consequences:
- Reference captures stop copying/hashing the image entirely (the
  writesSeen sha cache retires with it). Forced-capture critical
  path becomes RAM copy + drive snapshot + delta hashes + one IDB
  put — expected to land inside the teardown grace; F5 resumes
  from NOW. The crown's boundary moves: active-flow sessions
  survive if the peer's retry budget outlasts the reload gap.
- The secondary keeps its full-image sha for v1 (drives are small;
  ~40-80 ms). If the field pass says the window is still tight,
  the recorded escalation is fork-row generation pinning
  (accepted-generations = {this beat, last confirmed} — the
  beginClean invariant in uuid form).
- `expected.primarySha` leaves the reference path; named saves keep
  their embedded-bytes sha untouched. Pre-upgrade resume slots
  (no storeDigest) refuse once, honestly — one cold boot per tab
  at deploy, and the next heartbeat writes a new-style slot.
- Chunk-size era guard: the mirror only composes when the store's
  chunkSizeBytes equals the engine's; a mismatch refuses resume
  (rare-to-never; 32 KB since Phase 17).
- Fix #2's sweep suppression and fix #4's ordering stay
  load-bearing and unchanged.

## 8. Field fix #5 — sticky terminal modes across restore
## (addendum 2026-07-17, from the field: the invaders cursor)

Field (Jonathan, 2026-07-17): restoring a saved session with a
running invaders game brings the xterm cursor back — "all the
bullets have big fat cursors flying with them."

**Diagnosis (traced in source, this session).** The restored screen
is the M4-loop tail replay (main.ts): the last 48 KiB of raw serial
TX, written through xterm after a `term.reset()`. The replay
reproduces exactly what the tail CONTAINS — but cursor visibility
is a terminal MODE, set once by `ESC[?25l` when the game starts and
never re-sent by its redraw loop. Seconds of invaders traffic push
that sequence out of the 48 KiB window; reset() restores the
default (visible) cursor and nothing in the tail corrects it. Same
class: any sticky DEC private mode set before the tail window.

**Fix — track the modes beside the tail.** A tiny incremental
parser (`web/tx-modes.ts`, TxModeTracker) watches the same TX
stream the tail is cut from and remembers the final h/l state of
the sticky, side-effect-free-to-re-assert DEC private modes:
DECCKM (?1, application cursor keys), DECAWM (?7, autowrap),
DECTCEM (?25, cursor visibility). The snapshot rides the
`terminal` payload (optional `modes` field — pre-fix rows restore
exactly as before); restore re-asserts it AFTER the tail replay
(final state wins wherever the setting sequence fell) and seeds
the live tracker so future captures carry the state forward. One
application point — the restore-result handler — covers
reload-resume, named restores, and the clone.

Deliberately NOT tracked: the alt screen (?47/?1047/?1049 —
re-entering clears the just-replayed buffer) and origin mode (?6 —
set/reset homes the cursor); both would fight the replay, and the
ELKS serial console emits neither. Also out: DECKPAM/DECKPNM
(ESC =/ESC >) and SGR carry-over — redraw self-corrects SGR, and
nothing observed emits keypad modes. If a field case surfaces for
any of these, extend TRACKED_MODES with its own side-effect
analysis, don't blanket-track.
