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
