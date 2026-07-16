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
- **D3. Clone transport**: (a) parent writes the snapshot to
  `emu86-machines`, broadcasts only the stateId, child reads IDB —
  RECOMMENDED (no N-tab structured clones, one code path shared
  with save-states); or (b) payload over the channel.
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
