# Phase 16 brief — the system-level editor (the editor seam, built)

Drafted 2026-07-15 ~00:30, at the close of the field session that
shipped ping rev 5/6, the resident trunk filter, and substrate API v1
— deliberately written while that session's context was still hot.
Design decisions below were settled in-session with Jonathan (Phase 15
brief, post-close addendum E/G, `SUBSTRATE_API_REPORT.md` §3); this
brief turns them into buildable milestones. First pass = M1 (+M2 if it
flows). Approval for the direction exists ("good to go. MIT all the
way"); each milestone still lands against this brief in-session.

## 0. What this is, and what it is NOT

A minimal file editor in the emu86 web UI that edits **the same
`/dev/hdb` the guest builds on** — so `grep funcName /mnt/*.c` inside
the machine and "open file.c in the panel" outside it see one truth.
Purpose (Jonathan): it is the mechanism the huxley/lite editor will
sit on, built small enough to double as a permanent diagnostic
fallback. **This is handover surface, not a new frontier** — the
consolidation direction applies to every scope question below.

NOT this phase: syntax highlighting (Prism/highlight.js judged too
heavy in-session, 2026-07-15 — "leave that for huxley/lite to decide;
might end up CodeMirror or Ace"); a third BIOS drive slot (retired —
unnecessary, not hard); `?file=` transfer APIs (retired — the drive IS
the file interface); live bidirectional sync (coherence is
floppy-passing, below); multi-file tabs, undo stacks, or any editor
luxury. CodeJar arrives in M4 as ONE vendored MIT file with its
highlight callback unused.

## 1. Settled design (do not relitigate)

- **One drive, one truth.** No second image, no staging area.
- **Coherence = floppy-passing semantics**: the guest owns the fs
  while it has it mounted; the editor reads/writes between guest
  `sync`/`umount`s; the guest remounts to see editor writes. The M2
  Web Lock still arbitrates tab-vs-tab persistence only.
- **Persistence is unchanged**: the panel edits the RUNNING machine's
  in-RAM disk (via the worker), and the existing explicit **Save**
  button persists to the image library exactly as today. The editor
  adds NO new persistence path — this keeps the lock semantics and
  the "unsaved changes" banner exactly as field-proven.
- **Binary files are skipped** by the panel (sniff: NUL byte in the
  first 512 bytes, or size > a sane cap — editor policy, guest
  unaffected).

## 2. Ground truth for the MINIX module (verified in-tree, 2026-07-15)

- The guest's `mkfs` (`reference/elks/elkscmd/disk_utils/mkfs.c`)
  writes **MINIX v1: `MINIX_SUPER_MAGIC` (0x137F), 1 KB blocks,
  16-byte directory entries = 2-byte inode + 14-char names**. The
  14-char limit is a REAL seam constraint for huxley (name-mangling is
  the editor project's problem, not ours).
- **The authoritative reference implementation is in-tree**:
  `reference/elks/elks/tools/mfs/` — ELKS's own host-side MINIX fs
  tool (C): superblock/bitmap/inode layouts, path walk, file add.
  Write the TS module against it, not against internet lore. Also
  `reference/elks/Documentation/text/minix_fs.txt` and the kernel's
  `elks/include/linuxmt/minix_fs.h`.
- v1 inodes: 32 bytes, 7 direct zones + 1 indirect + 1 double
  indirect. Drives are ≤32 MB, so double-indirect is rare but real
  (files > ~7+512 KB); the READ path must handle all three, the WRITE
  path may refuse double-indirect-sized files in v1 with an honest
  error (drive-sized source files are not the use case).
- The 8086 KB preset (311×4×13 CHS) is the canonical test geometry;
  `mkfs /dev/hdb 8086` is the canonical guest format command.

## 3. Milestones

### M1 — `src/disk/minix-fs.ts`, read-only (the first pass)

Pure TS, no deps, no DOM: `openMinixImage(bytes)` → superblock facts +
`list(path)`, `readFile(path)`, `stat(path)`. Errors are values, not
throws, where the caller can act (missing file vs corrupt fs).

Tests, two layers:
1. Unit against a **committed fixture image** (~1–2 MB MINIX image,
   generated ONCE by the real guest: boot, mkfs, populate a known tree
   — dirs, a 14-char name, a file crossing the indirect-zone boundary,
   a binary blob — snapshot, commit). Provenance documented in the
   fixture's sibling README: the bytes came out of ELKS itself, so
   the parser is tested against the real writer.
2. The generator script kept as a probe survey (rerunnable when the
   fixture needs regenerating), NOT run in CI.

Acceptance: `readFile` returns byte-exact content for every fixture
file, including the indirect-zone one; `list('/')` matches the tree;
graceful verdicts on a FAT image and on zeros.

### M2 — write path + the guest oracle

`writeFile(path, bytes)` (create or whole-file replace), `remove(path)`,
`mkdir(path)`. Whole-file semantics only — no partial writes, no
append. Bitmap allocation per the mfs reference; timestamps set;
free-count bookkeeping correct (ELKS `fsck` is the judge).

The killer test (integration, the M2-report two-boot pattern):
1. Host writes `hello.c` into a blank-mkfs'd... no — into the FIXTURE
   image; boot the guest with it as hdb; guest `mount` + `cat` shows
   the bytes and `fsck /dev/hdb` (if present on image; else remount +
   ls) stays clean.
2. Guest writes a file, `sync`; snapshot; host `readFile` returns it
   byte-exact. (Half of this is already proven machinery — the M2
   drives test.)

### M3 — worker plumbing: read and write the RUNNING drive

- Read side needs NOTHING new: the existing `snapshot-secondary`
  message already returns the disk bytes (and marks clean — M3 must
  NOT reuse it blindly for reads; add a `peek-secondary` variant that
  does not mark clean, or a `keepDirty` flag — decide at build time,
  smallest diff wins).
- Write side: one new message pair, `write-secondary { bytes }` →
  ack. Replaces the in-RAM disk content wholesale; the machine keeps
  running (floppy-passing: the UI shows a "guest must remount" notice
  after every panel write; we cannot detect guest mounts, so it is a
  notice, not a guard — document honestly).
- Protocol exhaustiveness switches will demand main.ts + tests keep
  up (they caught control-request/-response at compile time; trust
  them again).

### M4 — the panel: vendored CodeJar, no highlighter

- `web/vendor/codejar.ts` — one file, MIT header retained ("MIT all
  the way" — Jonathan, 2026-07-15; hard-rule-2 authorization on
  record). Highlight callback: none (plain text).
- Panel UI in the existing page (a toggle near the drive banner):
  file list (text files only) → open → edit → "write to drive"
  (M3 message + remount notice). Persistence hint points at the
  existing Save button; the panel NEVER writes the library itself.
- Solo/no-drive states: panel says so and points at `?mkdrive` /
  settings.

### M5 — (later, with Jonathan) handover doc

`EMBEDDING.md` for huxley/lite: boot API, optional-network memory
tiers, the drive/editor seam, substrate API v1, the 14-char name
constraint, what CodeJar proved and where CodeMirror/Ace would slot.
Written when Jonathan calls for the handover itself.

## Addendum A (2026-07-15) — M0: per-tab drive forks (lands before M1)

Field trigger: Jonathan's overnight #olfr (SUBSTRATE_API_REPORT.md §4)
— a brand-new tab answered `?mkdrive` with "a drive is already
attached", because `secondaryImageSource` lives in localStorage and is
therefore origin-global. His call, in-session: **nail the drive model
before the editor**, because the editor panel is a view of a tab's
`/dev/hdb`, and the drive model must be per-tab for that view to make
sense.

### The model (Jonathan's spec, verbatim intent)

1. **Every tab gets its own drive** — no explicit create step. A tab
   with no base to fork gets a **blank 8086 KB drive automatically**;
   upsizing to the other presets stays available (settings/`?mkdrive`).
2. **A tab's drive survives reload** (soft reboot): the bits live in
   IDB, keyed by a fork id held in sessionStorage.
3. **The Save button promotes**: it writes THIS tab's current drive
   state to the shared **base image — the thing new tabs fork**. Tabs
   already open keep their forks; nothing invalidates.
4. **Duplicating a tab forks the drive** of the tab being duplicated.
5. **Promote is human-click only.** The guest/API can never write the
   base (the F.3 `?save`-absent decision, unchanged).

### Mechanics (mapped to existing seams)

- **Fork id**: a new `driveForkId` field in session-store — NOT
  `sessionId` (forking mints a new drive id; the tab id stays). The
  session-store doc comment (2026-07-14) reserved exactly this use and
  prescribed the collision handling below (octet-lease precedent).
- **Working copies**: rows in the existing IDB library with a new
  source tag (`'fork'`), hidden from the settings-modal list, counted
  in quota.
- **Duplication detection**: a Web Lock named for the fork id, held
  for the tab's life. At boot: no id → fork the base (or fresh blank
  8086 KB) under a new id; id present + lock acquired → normal reload,
  load the bits; id present + lock **held elsewhere** → this is a
  duplicated tab: copy the bits under a fresh id and take that.
- **Reload survival = auto-persist**: the stats heartbeat already
  reports `secondaryDirtySectors` ~1/s; when dirty > 0, run
  `snapshot-secondary` + write the working copy, throttled to ~5 s,
  plus best-effort on `visibilitychange`. HONEST LIMIT: a reload can
  lose the last ≤5 s of guest writes — same class as yanking a floppy
  mid-write; the guest `sync` habit already covers it.
- **Promote (Save)**: snapshot now; write base AND working copy.
  `settings.secondaryImageSource` stays but its MEANING changes to
  "what new tabs fork"; `null` now means "fork a fresh blank 8086 KB"
  (was: no drive). First promote with no base creates the library
  entry. Two tabs promoting: last click wins, accepted and recorded.
- **The old per-image Web Lock and its "changes will NOT be saved"
  banner state: RETIRED** — it guarded a shared mutable attach that no
  longer exists. The banner becomes: fork provenance + auto-saved
  tick + a [save as default for new tabs] button.
- **`?mkdrive`: guard retired.** Per-tab now — swaps THIS tab's
  next-boot drive for a fresh blank of the asked size; never touches
  the base. "Upsize" v1 = a fresh bigger blank (no data migration —
  file-level copy between images becomes possible host-side after
  M2's write path, recorded as a follow-on; likewise pre-formatting
  the auto-blank so the guest's `mkfs` step disappears).
- **GC**: on library open, delete fork rows whose lock nobody holds
  (`navigator.locks.query()`) and whose lastTouched is > 7 days.
  Generous on purpose: reopen-closed-tab and browser session restore
  resurrect sessionStorage, and those tabs should find their bits.
- **Migration: none.** An existing attached image simply becomes the
  base template; tabs start forking it on their next load. (Jonathan's
  workshop drive survives as the base, unchanged bytes.)

### NOT in M0

Live cross-tab drive sync (forks are forks — coherence between tabs is
sneakernet by design); fork lineage/merge tooling; per-tab primary
image; resize-in-place.

### Recorded for later (Jonathan, 2026-07-15, mid-M0): deep links

"Not urgent for this iteration": a bookmarkable link that restores a
specific tab — `#mouse` / `#cat`, or `#<guid>` if names are too vague.
M0's mechanics already carry most of it: a fork row + its Web Lock IS
a tab's identity, so a deep link is "adopt this fork id from the URL
fragment instead of sessionStorage", and the anti-stomp guard Jonathan
asked for is the same lock — held ⇒ that tab is already open ⇒ refuse
with a pointer at it (or fork a copy, decide then). Open design points,
deliberately unsettled: names are TAN leases, not stable identities
(#mouse needs a name→guid map in localStorage, and a re-leased name
must not hijack the wrong drive); and a bookmarked fork must survive
GC — the 7-day sweep needs a `pinned` flag (or equivalent) before deep
links exist, or a bookmark can dangle.

### Effect on the rest of the phase

M1/M2 untouched. M3 unchanged in shape (the peek-vs-snapshot note
matters MORE now — an editor read must not mark clean, or it would
starve the auto-persist trigger). M4's "solo/no-drive states" bullet
mostly dissolves — there is always a drive; the panel's empty state is
only "unformatted" (no MINIX magic), which the M1 module reports as a
verdict, not an error.

### Tests

Unit: the boot state machine (fresh fork / reload / duplicate / GC)
using the image-library test pattern; promote semantics; `?mkdrive`
swap. Integration: the existing drives tests keep passing behind the
fork layer; the two-boot persistence test round-trips through a
fork + promote.

## Addendum B (2026-07-15) — field item, TODO: guest line-editor keys

Jonathan, same session M4 landed (verbatim symptoms): "the elks
command line editor seems to be getting the wrong key when i hit
backspace (or the xterm is sending confusing keys). if i am at the
end of a line i have just typed it works fine. if i use the arrowkeys
it deletes forwards instead of backwards. i also notice that the
insert point (or delete point if i use backspace or delete) is one
character off — meaning whatever i type or delete is one character to
the right of what the cursor suggests."

REFINED same night: "the insert point under the cursor is correct —
it's just the backspace key that's wrong — it's deleting forwards
instead of backwards." So there is ONE bug, not two: mid-line
Backspace acts as delete-forward; insertion and the cursor agree.
(At end of line it "works" because the editor apparently takes a
simpler erase path there — or because deleting forward at EOL has
nothing to eat and the observed delete came from that simpler path.)

DIAGNOSED AND FIXED same night:
1. **DEL vs BS — CONFIRMED**: xterm.js sends 0x7F for Backspace; the
   ELKS line editor binds 0x7F to DELETE-FORWARD and 0x08 (Ctrl-H) to
   backspace. Jonathan ran the probe ("yes ctrl-h seems to work") and
   asked for the fix now ("it will help with my tests in the
   browser"). Fix is host-side, one line at the single seam between
   the human keyboard and the guest: `term.onData` maps 0x7F → 0x08
   (web/main.ts). Scripted input (autoexec, agent bridge) never
   carries 0x7F; guest-to-guest telnet never touches this path.
   Field verification rides the M4 deploy.
2. ~~CSI parser off-by-one drifting the insert point~~ — mooted by
   the refinement: the insert point is correct.
3. ~~Prompt-length assumption (the `cat# ` HOSTNAME prompt)~~ —
   RULED OUT by Jonathan same night: "this off by one observation
   predates cat# etc". The bug is older than the API v1 prompt.

Diagnostics when picked up: `stty` in the guest for the erase char;
compare behavior over tab-to-tab telnet (different input path);
check whether it reproduces under other terminals against real ELKS
(upstream issue tracker may already know). May well be an UPSTREAM
ELKS bug like the urlget overflow — diagnose before touching
anything on our side.

## 4. Hard-rule notes for the implementing session

- Rule 2 (no new deps): CodeJar is vendored source, not an npm dep;
  nothing else new. The MINIX module is hand-written TS.
- Rule 1/3 untouched: no cpu/machine/architecture changes anywhere in
  this phase (M3 is protocol-layer only, same shape as M2's snapshot).
- The next session should START by checking the pending field items:
  `?peers` and `?mkdrive` (API v1 report §2 — whoami is confirmed,
  those two are not), and any overnight #olfr from Jonathan.
- Baseline at brief time: **1,218 passed / 111 files / 1 skipped**;
  typecheck clean; dev tier = substrate API v1 build (b370345a);
  stable = still pre-Phase-15, promotion pending Jonathan.
