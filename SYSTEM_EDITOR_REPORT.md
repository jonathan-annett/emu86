# System Editor Report — Phase 16 M4: the panel over /dev/hdb

2026-07-15, closing the M0→M4 arc (DRIVE_FORKS, MINIX_FS,
MINIX_FS_WRITE, EDITOR_PLUMBING reports). Scope: brief §3 M4 — the
minimal file editor the huxley/lite editor will sit on, small enough
to stay as a permanent diagnostic fallback.

## 0. What was built

- **`web/vendor/codejar.ts`** — CodeJar vendored VERBATIM from
  github.com/antonmedv/codejar master (2026-07-15), MIT license
  retained in the header (Jonathan's hard-rule-2 authorization: "MIT
  all the way"). FIVE local patches, each marked `// emu86:`, all
  strict-mode appeasement (noUncheckedIndexedAccess ?? guards,
  noImplicitReturns explicit returns) — zero behavior change. The
  highlight callback is a no-op: plain text, per the brief ("leave
  that for huxley/lite to decide").
- **`web/editor-files.ts`** — the PURE policy half: recursive tree
  walk (files vs honestly-listed skips), the binary sniff (NUL in the
  first 512 bytes), the 256 KB editor cap, latin1 codecs (lossless
  for all byte values; ELKS is ASCII). Split from the DOM half
  because CodeJar reads `window` at module scope — the policy is
  unit-tested against the guest-written fixture, the DOM is not (the
  repo has no DOM test environment; recorded, the field is the judge
  as usual).
- **`web/editor-panel.ts`** — the DOM half: a `/mnt files` toggle
  (bottom-left pill, styled with the page's idiom) opening a
  right-side drawer: file list (+ skip list + counts) → open → edit →
  **write to drive**. The write flow: fresh M3 peek (keeps concurrent
  guest writes since the panel opened), `writeFile` via the M2
  module, persist to THIS tab's fork row (reload safety first), then
  `write-secondary` into the running machine, then the REMOUNT NOTICE
  — "the guest owns the fs while mounted" — notice, not guard,
  exactly as the brief settled. The persistence hint points at the
  existing Save-as-default button; the panel never writes the image
  library's base.
- Empty states: no drive in the worker → says so; unformatted drive →
  the M1 verdict plus the exact `mkfs /dev/hdb <blocks>` to run.
  (Addendum A dissolved the old solo/no-drive bullet: every tab has a
  drive now.)

## 1. Decisions recorded

- **Edit-existing-only.** No create/delete/rename UI — the M2 module
  can create files, but the panel staying a viewer-editor means the
  14-char name-mangling question never arises here (it stays the
  editor project's problem, brief §2). If the field wants "new file",
  it is a small addendum, not a redesign.
- **Whole-image write path** (peek → mutate → persist fork →
  write-secondary) rather than surgical sector patches: atomicity
  lives in swapping complete images, and the fork row is updated
  BEFORE the machine so a reload mid-write can only see the newer
  bytes.
- **The write takes a FRESH peek** rather than reusing the bytes the
  file was opened from — guest writes that landed between open and
  save survive. The remaining window (guest writes DURING the panel
  write) is floppy-passing's documented race; `sync` discipline
  covers it, same as every other seam in this phase.
- **256 KB cap**: far above any source file the guest toolchain can
  compile (640 K RAM), far below drive-sized blobs. Skips are listed
  with reasons, never silently hidden.

## 2. Verified

- Unit: `tests/unit/editor-panel-files.test.ts` — the walk against
  the guest-written fixture (six text files found in path order;
  `/binblob` skipped as binary; `/huge.txt` skipped as too-large —
  both LISTED), sniff edges (NUL past the 512-byte window is policy-
  invisible, empty file is text), latin1 round-trip of all 256 byte
  values.
- Typecheck clean on all three configs; `npm run build:browser`
  bundles the panel + minix-fs + CodeJar (index chunk 342→367 KB).
- Full suite at this deploy gate: **1,270 passed / 117 files /
  1 skipped** (SST corpus, as always), typecheck clean — the arc's
  running total: 1,218 at the brief → 1,233 (M0) → 1,251 (M1) →
  1,270 (M2+M3+M4).
- NOT verified here: the DOM flow end-to-end (no DOM test env — see
  §0) and the real-browser feel. Field script for the dev tier:
  boot; guest `mkfs`+`mount`+write a file+`sync`; panel `/mnt files`
  → file appears; edit it; write to drive; guest `umount`+`mount`+
  `cat` → panel's edit visible; reload the tab → edit survived (fork
  row); duplicate the tab → edit rode along.

## 2b. Field results (2026-07-15, dev e4358843)

Jonathan ran the §2 script: **steps 2–5 pass as expected** — including
an unprompted boundary probe: he skipped a `sync` and observed the
expected NO data update, then `echo >> /mnt/test` + `sync` let the
editor pick up the new copy. That is floppy-passing semantics
field-verified in both directions.

Two observations from the same pass:
- He saw no UI banner notifying that the drive changed ("but i may
  have not waited a full 5 seconds"). The pill appears on the 1 Hz
  dirty heartbeat and flips to auto-saved within ~5 s; WATCH this —
  if the next pass still sees nothing, the pill's post-M0 states may
  be too quiet.
- **The `/mnt files` badge sat on the console's entry line**
  (bottom-left strikes again — the same corner that forced the drive
  pill to go draggable in Phase 15). His design, implemented same
  night: the badge becomes a skeuomorphic DRAWER HANDLE on the right
  screen edge, above console height, attached to the panel and
  sliding out with it.

## 3. Where this leaves Phase 16

M0–M4 built. M5 (EMBEDDING.md, the huxley/lite handover doc) stays
parked until Jonathan calls for the handover itself, per the brief.
The dev tier needs a deploy (Jonathan's) to field-test the panel.
