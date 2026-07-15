# Phase 17 brief — the machine keeps its own state

Drafted 2026-07-15, the same session that shipped Phase 16 M0–M4,
while the design conversation was still hot. Everything in §1 was
settled in that conversation with Jonathan (his sketches, his calls);
this brief turns it into buildable milestones. It also subsumes what
would have been Phase-16 Addendum C ("boot without the typed
script") — the two streams share their mechanism and their payoff.
Ground truth in §2 was verified tonight against the in-tree ELKS
source and against the stock image's OWN files, read with the M1
parser (the module answering questions about the system it will
provision — the dogfood is the point).

Direction check, honestly: this is the largest new machinery since
Phase 15, in a project under a consolidation order. It is here
because Jonathan asked for it in-session (the shelved COW-overlay
idea, raised by him, designed with him tonight), and because it
serves the handover: a machine that keeps its toolchain, its config,
and its user's `.profile` across reloads is a machine the editor
project can treat as a workbench instead of a demo. It also retires
the typed-boot-script friction for the daily loop. "Golden boot
overlays" sat on the Phase 14 back-burner list; its enabling pieces
(fork lifecycle patterns, minix-fs writes, protocol discipline) got
built by Phase 16 without knowing it.

## 0. What this is, and what it is NOT

Two deliverables, one mechanism:

1. **A block-level COW overlay for the BOOT disk.** Guest writes to
   the primary image survive reload, per tab, without ever writing
   the base image: hot writes pool in a worker-side sector map and
   sweep to IndexedDB as coalesced chunks. Reload = base + overlay,
   byte-identical to where the guest left off (modulo the sweep
   window, same honesty class as M0's ≤5 s).
2. **The load-time stamp set** that makes the daily boot need no
   typed script: `net=ne0` in bootopts, `mount /dev/hdb /home` in
   mount.cfg, root's home pointed at /home — so ash sources
   `/home/.profile` straight off the tab's drive fork.

NOT this phase:

- **File-level overlay interpretation** — settled against, do not
  relitigate (§1.1).
- **Lazy paging / RAM reduction.** The 32 MB base stays materialized
  in worker RAM; the overlay saves IDB space and write bandwidth,
  not memory. Paging is a different, much bigger project.
- **Migrating the hdb forks onto the chunk store.** The M0 fork
  system is field-accepted TONIGHT; it stays untouched. (Recorded
  convergence: a fresh fork's overlay-form would be near-zero bytes —
  a later unification could dedupe the 8 MB blanks. Later.)
- **The editor panel over the root fs.** The panel stays
  secondary-only this phase. (Future note: with overlays, panel
  edits to /etc would persist — real diagnostic value, real
  foot-gun; wants its own scope discussion.)
- **Removing the boot-script system.** It stays — the landing demo
  is built on it and it is field-proven. The goal is making it
  UNNECESSARY for the daily loop, not deleting it.
- **su/sudo/user1 sandboxing.** Researched tonight (§2.4): real uid
  model, no su/sudo anywhere, root and user1 both passwordless — so
  user separation here is ergonomics, not security. The root-home
  stamp gets the ergonomics without the file-ownership knob. user1
  is the recorded LATER option if the handover ever wants the
  editor's user fenced off /etc (at which point root also grows a
  password).

## 1. Settled design (do not relitigate)

### 1.1 Block-level, agnostic — never file-level

The emulator's seam is `readSector`/`writeSector` (the INT 13h line).
A file-level overlay would reverse-engineer which file a sector
belongs to MID-FLIGHT — re-implementing the MINIX driver in reverse
while racing the guest's buffer cache, whose intermediate states
(bitmap/inode/dirent order between syncs) are deliberately
incoherent. Our own minix-fs module only ever reads QUIESCENT images;
that discipline is why it works. Block level also gets crash
consistency free: an atomic sweep is always SOME point-in-time
crossing of the write stream — exactly a real disk after power loss,
which fsck already repairs — and it is fs-agnostic (FAT probe disks,
the /bootopts region, boot code, all covered). qcow2/VHD made the
same call for the same reasons.

### 1.2 The write path (Jonathan's sketch, one amendment)

- **Hot store**: worker-side `Map<lba, Uint8Array(512)>` with the
  bytes COPIED AT WRITE TIME. The copy is what makes sweep epochs
  exact and lets the drain run with zero coordination against the
  running machine — the epoch swap is the only sync point.
- **Double-write**: every `writeSector` lands in the RAM image
  (authoritative, as today) AND the hot map. **Reads touch only
  RAM.** The amendment, and it is a hard constraint, not taste:
  `readSector` executes inside `cpu.step()`, which is synchronous
  and infallible (hard rule 1, the PagedMemory principle). An IDB
  reader in the runtime read path cannot exist; the machine-stall
  trick (DNS precedent) is poison for the disk hot path. The "IDB
  reader" therefore exists ONLY at boot.
- **Sweep**: two-map epoch swap. Writes land in map A; a sweep swaps
  in fresh map B, coalesces A into chunks, writes ONE IndexedDB
  transaction, acks, drops A. Nack/timeout → merge A back over B
  (B's entries win — they are newer), retry next tick. Cadence rides
  the existing 1 Hz stats heartbeat, throttled (~5 s, the M0
  pattern), PLUS a forced sweep when the hot map crosses a byte
  threshold (proposal: 4 MB — a guest dd'ing the whole disk must not
  balloon the map), PLUS a flush on visibilitychange-hidden and on
  `reset` (teardown must not eat an epoch).
- **Chunks**: fixed-size, ALIGNED — proposal 32 KB (64 sectors), ONE
  tunable constant. Fixed alignment IS the coalescing: adjacent
  dirty sectors collapse into one record; keys `(overlayId,
  chunkIndex)` are idempotent (a chunk overwrites its prior
  version); merge at boot is trivial. Variable-length run merging
  was considered and rejected — complexity for marginal wins once
  chunks are aligned. A swept chunk carries the FULL 32 KB (read
  from RAM at sweep time for the sectors the epoch doesn't have —
  RAM is authoritative and current, so this is safe), which keeps
  chunk records self-contained. Tuning data: dirty-sector counts
  already flow through the stats heartbeat.

### 1.3 Identity, lifecycle, storage

- **Overlay validity is keyed to the EXACT base.** The worker
  computes SHA-256 of the base bytes at every boot
  (`crypto.subtle`, native, ~tens of ms over 32 MB, once, pre-run —
  no new deps) and compares against the fingerprint the overlay was
  created under. Mismatch ⇒ the overlay is NOT applied; the worker
  reports it; the UI surfaces "machine state is from a different
  base image" with keep/discard. This invariant is HARD — a silently
  mis-applied overlay is a corrupt root fs.
- **Per-tab, like everything else**: `overlayId` in sessionStorage
  beside `driveForkId`; a Web Lock named for the overlayId detects
  tab duplication (the octet-lease pattern, third deployment); a
  duplicate copies the chunks under a fresh id pre-boot. GC mirrors
  fork GC: unheld lock + stale (7 days) ⇒ chunks and meta deleted.
- **Own database** (`emu86-overlays`, stores `chunks` + `meta`), a
  separate tenant like `emu86-pages` vs `emu86-images` — the
  library is user-curated artifacts, pages are RAM cache, overlays
  are per-tab machine state; wiping one must never surprise the
  others. Meta row: overlayId → { baseFingerprint, chunkSize,
  lastTouched }. Quota: `storage.estimate()` already reports
  origin-wide, so the modal's line covers it automatically.
- **The worker never persists** (Phase 15 rule, kept): sweeps POST
  chunks to the main thread; main owns all IDB. Protocol additions:
  `overlay-sweep` (worker→main: epoch id + chunks),
  `overlay-swept` (main→worker: epoch ack/nack),
  `overlay-flush` (main→worker: sweep now), and BootConfig gains
  `overlay?: { chunks, chunkSize, fingerprint }` (main loads chunks
  pre-boot, worker folds after it has the base bytes — this keeps
  the bundled-image fetch in the worker where it lives today). The
  exhaustiveness switches will demand main.ts and tests keep up;
  they have caught every protocol addition at compile time so far —
  trust them again.
- **Factory reset is REQUIRED, same milestone as the overlay
  itself**: a settings action that drops the tab's overlay (next
  boot = pristine base = today's behavior). A guest that wrecks its
  root fs must never brick a tab. Overlay defaults ON (it is the
  point of the phase); the reset is the escape hatch.

### 1.4 The stamp set (order: base → overlay → stamps)

Stamps are applied to the in-RAM image AFTER the overlay fold,
before the machine runs. They are per-boot and EPHEMERAL by
construction (applied pre-wrapper, so they never enter the hot map)
— config, not state, exactly like today's LOCALIP/HOSTNAME bootopts
stamp. Each stamp must be idempotent and guest-respecting:

- **bootopts `net=ne0`**: joins the existing worker-side bootopts
  stamp block. That whole region is already ours-per-boot (LOCALIP,
  HOSTNAME — field-proven); guest edits to /bootopts don't survive
  today and that does not change. Stamped only when the tab wants
  networking (tied to the same setting the seed script serves now).
- **mount.cfg**: marker-guarded append via minix-fs on the folded
  image — read `/etc/mount.cfg`, and only if the marker line is
  absent, append `# emu86: home drive` + `mount /dev/hdb /home
  2>/dev/null || true`. Convergence property worth recording: if the
  guest ever edits mount.cfg itself, it edits the STAMPED text it
  sees, the overlay persists that, and next boot's marker check
  no-ops — guest edits win thereafter, including deleting our line.
- **passwd**: field-surgical, not whole-file — parse `/etc/passwd`
  from the folded image, rewrite ONLY root's home field
  (`/root` → `/home`), preserving everything else — including a
  password hash the guest may have set with `passwd` (which the
  overlay now makes durable, pleasingly).
- **inittab autologin**: OPEN (§4) — kills the last typed word
  (`root` at login:) by respawning the shell directly; pure taste.

Failure honesty: if a stamp cannot apply (unformatted base?
non-MINIX root — impossible for our images but the FAT probe boots
exist), it is skipped with a console warning; boot proceeds. Stamps
are conveniences, never gates.

### 1.5 The payoff composition (why this closes the loop)

With hdb mounted at /home and root's home there: ash (login shell)
sources `/etc/profile` then `$HOME/.profile` — so **the tab's drive
fork carries its own boot behavior**. A fresh blank fork has no fs →
mount fails quietly → stock boot, nothing typed but `root`. The user
formats it once, drops a `.profile` (via guest OR the M4 panel), and
from then on: reload → net up (bootopts) → /home mounted (mount.cfg)
→ `.profile` runs — ping restored from the fork, PATH tweaked,
whatever the user wants. "Save as default" (M0) then propagates that
`.profile` to every new tab. The keyboard-injected seed script
becomes a demo prop. The workshop MOVES: /tmp-overlay-mount (seed
rev 2) retires in favor of /home (§4 decision — ELKS has no bind
mounts, one mountpoint per device).

## 2. Ground truth (verified 2026-07-15, in-tree + in-image)

1. **`/etc/rc.sys`** (sysinit, pre-login, root) does
   `source /etc/mount.cfg` and a `case "$net"` that runs
   `net start ne0` from a bootopts variable. Read out of
   hd32-minix.img with the M1 parser. mount.cfg ships as an
   all-commented hook script ("various HD mounts") — this is ELKS's
   fstab; there is no fstab/mount -a.
2. **bootopts**: parsed by `elks/init/main.c parse_options()` —
   `init=` (≤6 args), `net=`, arbitrary `VAR=value` lines become
   init's environment (proven daily by LOCALIP/HOSTNAME).
3. **ash sources `$HOME/.profile`** for login shells after
   /etc/profile (`elkscmd/ash/main.c:162-171`, read tonight).
4. **Users**: kernel has the full uid/euid/gid model (`sys_setuid`
   SysV saved-IDs, `suser()` gates, S_ISUID honored in exec.c:583).
   Stock passwd: root AND toor uid 0, user1/2/3 uid 101–103 home
   /home — ALL passwordless. No su, no sudo (only login.c/passwd.c
   in elkscmd). Security boundary: none; don't pretend otherwise.
5. **The primary disk is NOT write-tracked today** — only the
   secondary gets the WriteTrackingDisk wrapper. M1 wraps the
   primary (or extends the wrapper); guest writes to the root fs
   currently die in RAM at reload, which is the whole point here.
6. Baseline at drafting: **1,270 passed / 117 files / 1 skipped**,
   typecheck clean. Dev tier: e4358843 (M4 panel + backspace fix);
   the drawer-handle build (272b5e4) is committed but NOT yet
   deployed/field-passed — next session starts by checking that.

## 3. Milestones

### M1 — the overlay engine (worker + protocol + store)

Hot map (bytes-at-write), epoch sweeps, chunk coalescing, the three
protocol messages, main-side chunk store (`emu86-overlays`), forced
sweep threshold, flush on reset/hidden. Unit tests with in-memory
fakes and byte-compare helpers — the Phase 16 lessons are LAW here:
fake-indexeddb costs seconds per MB (in-memory fakes for the state
machine; small payloads for the real-IDB round-trip) and `toEqual`
on MB arrays costs ~90 s per assert. Acceptance: a simulated write
storm sweeps to exactly the expected chunk set; nack merges epochs
correctly (newer wins); a full-disk rewrite stays bounded by the
forced-sweep threshold.

### M2 — boot fold, identity, lifecycle

BootConfig overlay carriage; worker-side SHA-256 fingerprint check
(mismatch ⇒ not applied + reported + UI keep/discard); fold before
stamps; overlayId/session/Web-Lock/duplication/GC (mirror M0 —
the patterns are proven, reuse their shape); factory reset in
settings; quota visibility. Integration (two-boot, the M2-report
pattern): boot, guest writes a marker file into the ROOT fs +
`sync`, sweep, tear down; second boot folds the overlay — marker
present, `fsck /dev/hda` clean. Duplication test: fork-the-overlay
via the harness' lock fakes.

### M3 — the stamp set + the un-typed boot

net= (bootopts block), mount.cfg (marker append), passwd (home
field surgery) — all on the folded image via minix-fs, each with
unit tests against fixture-grade images and honest skip-on-failure.
Field composition test (integration): blank-fork tab boots stock;
formatted fork carrying `.profile` boots to a personalized prompt
with net up and /home mounted, NOTHING typed except `root`. Seed
script rev 3 decision executed (§4). The autologin patch if §4 says
yes.

### M4 — field acceptance + report

Jonathan's pass on the dev tier; PHASE17_*_REPORT.md per the
discipline (one per milestone as they land, plus the closing field
record). The Phase 16 M5 handover doc (EMBEDDING.md) remains parked
until called — but this phase's reports should be written knowing
they feed it.

## 3.5 Back-burner (recorded 2026-07-15)

Jonathan's ordering, in his words: "the overlay comes first, then
once proven we can investigate the captured state idea."

- **Whole-machine state capture.** The pure-TS bet makes it
  tractable: RAM ~1 MB of enumerable bytes, CPU a few dozen numbers,
  devices plain TS fields — but every device needs an explicit
  serialize/restore pair, and every async host seam (DNS stall,
  gateway TCP) must be resolved deliberately at restore (fail the
  DNS, drop the sockets — laptop-resume semantics). Two shapes, same
  machinery: tab-duplicate resumes the parent's exact state (live
  BroadcastChannel handshake at duplicate-detect — exact, no
  staleness window), and reload-resume/save-states in the SAME tab
  (no identity problem; subsumes the old "golden boot overlays"
  instant-on idea). Would live beside emu86-overlays as the next
  tenant; the overlay engine's sweep/fingerprint/lifecycle patterns
  are its enablers.
- **TAN redesign: per-tab virtual NAT** (Jonathan's sketch, solves
  the snapshot-clone identity problem at the guest level). Every
  guest sees the SAME address (slirp-style fixed 10.0.2.15; gateway
  and DNS fixed too), and the fabric gives each tab a 1:1 NAT onto an
  intranet subnet (10.0.3.x) where the other tabs live. A guest's
  own address then never changes across restart or duplication —
  LOCALIP stops being per-tab (stamp becomes a constant); HOSTNAME
  stays per-tab. 1:1 (stateless) address-rewrite NAT keeps inbound
  telnet/ftpd working with no conntrack and no port rules. The
  "two copies of the same PC" worry mostly self-resolves at the
  protocol layer: the clone leases a fresh intranet address, so its
  cloned TCP state emits from an address its peers never spoke to —
  they RST, the clone's ghost connections die cleanly, the parent's
  survive untouched. What remains is HUMAN-level: the clone's in-RAM
  hostname/prompt says "mouse" until a reboot re-stamps (or a
  substrate ?whoami nudge); and self-reference needs a decision
  (what does "mouse" resolve to from inside mouse — hairpin NAT or
  loopback; ping rev 6's self-ping-is-loopback is the precedent).

## 4. Open decisions — DECIDED 2026-07-15 ("agree to all", + §4.6)

(Repair note: a same-day edit inserting §3.5 accidentally ate this
section's heading; restored here together with the decisions.)

1. **Overlay default**: ON for all tabs (reset = escape hatch) —
   YES.
2. **Chunk size / sweep throttle / forced-sweep threshold**:
   32 KB / 5 s / 4 MB — YES; tunable constants, tuned later from
   the existing telemetry.
3. **Workshop migration**: hdb mounts at /home (not over /tmp);
   seed script rev 3 drops its mount+ping lines — YES; the ping
   restore moves into the fork's `.profile`. (Jonathan,
   post-promotion, on the never-completed save-ping-to-drive step:
   "we will catch it in the next deploy which will have an
   overlayed /bin/ping".)
4. **Autologin** — YES, and bigger than proposed: see §4.6.
5. **Panel file ownership**: still parked — but user1 is no longer
   hypothetical (§4.6); the knob unparks whenever ownership starts
   to matter in the field.

### 4.6 Addendum A (Jonathan, 2026-07-15): nothing typed, ever

His words: "if we can work towards the keyboard bootscript being a
thing of the past. the one concession would be a checkbox that
turns on autologin for either root or user1. default is boot to
autologin user1, doing the first show (hello human) as a self
deleting shell script."

What this changes, recorded while fresh:

- **The direction hardens.** §0 said the goal was making the typed
  boot script unnecessary for the daily loop while the landing demo
  kept riding keystroke injection. Now the SHOW retires from the
  keyboard too: the end state has no keystroke injection at all,
  and the boot-script system becomes removable in a later phase
  once nothing ships on it.
- **Autologin is a setting, not a patch**: a checkbox — off / root
  / user1 — DEFAULT user1. Adding a settings field needs no key
  bump (per-field-tolerant loader; the v2 era rule bites only on
  SEMANTIC changes to existing fields — see
  SETTINGS_VERSIONING_REPORT.md).
- **user1 partially unparks — as a LOGIN TARGET only.** The §0
  honesty stands: both accounts are passwordless, there is no
  security boundary, and none is being pretended. The §1.4 stamp
  set was designed around root and needs reshaping for a user1
  default: the passwd home-field surgery targets user1 (whose
  stock home is under /home — VERIFY the exact path against the
  image with the M1 parser), and the blank-fork case needs care:
  mount of /home fails quietly, so user1's home must still exist
  on the base image or login must tolerate its absence — settle in
  M3, against the real image.
- **The first show becomes machine state.** hello-human runs as a
  self-deleting shell script on first boot (hooked from user1's
  autologin path), not as injected keystrokes. Self-deletion + the
  overlay = the show runs ONCE per machine, like a fresh install;
  factory reset resurrects it. Honest design note: the theatrical
  @type/@turbo typing effects are HOST-side tricks a guest script
  cannot do — either the show stops pretending to be typed, or the
  host grows a way to render a guest-initiated performance. Settle
  in M3; don't let it stall the milestone. (The demo's heredoc is
  ~100 bytes — far under the ELKS sh ~6 KB heredoc heap limit.)
- **M3's acceptance bar moves**: the field composition test becomes
  "reload → personalized prompt, net up, /home mounted, NOTHING
  typed" — not even `root`.

## 5. Hard-rule notes for the implementing session

- Rule 1 is honored BY DESIGN: the runtime read path never leaves
  RAM; all IDB is boot-time (main) or sweep-time (main, via
  postMessage). Nothing async touches cpu.step().
- Rule 2: no new deps — SHA-256 is `crypto.subtle` (native), chunk
  store is hand-rolled on the existing IDB patterns.
- Rule 3: protocol-layer + disk-wrapper additions, the same class
  as Phase 16 M3; no machine/cpu changes.
- Commit per milestone with reports; the cadence ruling applies
  (full suite gates the deploy; targeted suites between).
- Next session ALSO starts by checking: drawer-handle field pass
  (272b5e4 undeployed at drafting), any overnight #olfr.
