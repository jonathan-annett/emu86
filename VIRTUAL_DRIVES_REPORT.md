# Virtual Drives Report — Phase 15 M2 (/dev/hdb persistence)

2026-07-14. Brief: `emu86-phase15-brief.md` §M2 (approved in-session).
Commit: `e4015b1` (+ the sync-verdict test extension in the report
commit). Everything below was run, not assumed.

## 0. TL;DR

The wish-list's virtual drive is real: **Create blank drive** in the
settings modal (8/16/32 MB presets) → guest `mkfs /dev/hdb 8064 &&
mount /dev/hdb /mnt` → write files → **Save** (bottom-left banner) →
the drive persists in the image library and comes back on the next
boot with the files intact. Proven by a two-boot integration test
(`tests/integration/virtual-drive-persistence.test.ts`): a fresh
WorkerHost boots the saved snapshot and `cat`s the file back. It
passed on its first run.

Bonus finding that shapes the UX copy: **ELKS `sync` alone flushes
MINIX-fs data** — unlike FAT, where `ARTIFACT_EXTRACTION_REPORT.md` §4
proved only `umount` was reliable. Verified by a sync-only leg in the
same test (file written, `sync`, snapshot with the fs still mounted,
rebooted, file present). The banner's "umount (or sync) first" is
therefore accurate on both filesystems the machine encounters.

## 1. What landed

The scouting was right: Phase 11 had already plumbed the secondary
slot end-to-end (BIOS DL=0x81 routing, `DiskSlotSpec`, the settings
picker), so M2 is creation + persistence, no kernel driver, no new
device, no `src/` substrate changes beyond one decorator:

- **`WriteTrackingDisk`** (`src/disk/disk.ts`): wraps any `Disk`;
  counts distinct written sectors (the unsaved-changes signal) and
  snapshots the full image by the probe-disk sector loop. The worker
  mounts the secondary through it.
- **Protocol pair** (`src/browser/protocol.ts`): `snapshot-secondary`
  → `secondary-snapshot { bytes | null, dirtySectors }`. Taking a
  snapshot marks the disk clean — persistence is the main thread's
  job; a failed IDB write just means the user saves again. The 1 Hz
  stats heartbeat gained optional `secondaryDirtySectors`.
- **Library** (`web/image-library.ts`): entries can carry explicit
  CHS `geometry` (additive optional field, the `viability` trick, so
  pre-M2 entries are untouched); `createBlankImage` (all zeros,
  geometry-derived size, source `'blank'`), `updateImageBytes`
  (size-pinned write-back + `modifiedAt`), `getImageEntry` (bytes +
  geometry for boot).
- **Modal** (`web/settings-modal.ts`): Create blank drive with
  8/16/32 MB presets — cylinder counts against 16 heads × 63 spt, so
  every size is CHS-exact and the 32 MB shape equals the hd32
  images'. Creating selects it as the secondary immediately and
  prints the exact `mkfs` line (blocks = bytes/1024).
- **Main page** (`web/main.ts`): boot passes stored geometry through
  (blank sizes bypass the worker's inference table); a bottom-left
  banner appears while the booted secondary has unsaved writes and
  offers the explicit **Save**; saving snapshots the worker and
  writes back to the library entry.
- **Single-writer guard, advisory v1**: the first tab holds a Web
  Lock on the drive id for the page's lifetime; a second tab booting
  the same drive still runs, but its banner warns changes there will
  not be saved (`driveLockHeld` gates the dirty indicator and Save).
  Web Locks is a platform API — no dependency.

## 2. Deviations from the brief (recorded, with reasons)

- **Full-bytes write-back instead of sector-diff (D4).** The brief
  recommended the golden-overlay-style save-time diff. Implementing,
  the trade turned out lopsided: the diff buys only IDB space (origin
  quota is gigabytes; drives are 8–32 MB) and costs a second record
  shape, a compose step on every boot, and the base-identity pinning
  rule. The library entry's bytes are simply the drive's current
  state — `getImageBytes` needed zero changes. The diff machinery
  properly belongs to the golden-overlay milestone, where composing
  against a shared base is the point. If Jonathan wants the diff
  anyway, `updateImageBytes` is the single seam to swap.
- **Custom sizes deferred.** The brief floated size presets "plus a
  validated custom size"; v1 ships presets only. The validation
  seam exists (`createBlankImage` rejects non-CHS-exact geometry),
  and a custom-size input is UI-only work when wanted.

## 3. The flush question (brief question, answered)

The brief required: "verify what MINIX-fs actually needs and record
it." Verified by construction in the integration test:

- Leg 1 (umount): file written, `umount /dev/hdb`, snapshot → the
  directory entry is present in the snapshot bytes.
- Leg 2 (sync-only): second file written on the remounted fs, `sync`,
  snapshot **with the fs still mounted**, fresh boot from that
  snapshot → `cat /mnt/second.txt` returns the sentence. Verdict
  pinned in the test with a console log:
  `sync-only flush verdict: second.txt SURVIVED — sync flushes MINIX-fs`.

So: MINIX-fs needs `sync` at minimum; FAT (per the Phase 14 artifact
extraction) needs `umount`. The banner says "umount (or sync)", which
is the union of both truths. A snapshot taken with NO flush at all
remains unsafe (buffer-cache pages still dirty in guest RAM) — the
banner exists precisely to say so.

## 4. Verified

- **Two-boot integration test, passed first run** (then extended with
  the sync leg, passed again, 43 s): create-blank shape → guest
  `mkfs /dev/hdb 8064` → mount → write → umount → snapshot →
  **new WorkerHost** boots the snapshot with the same geometry →
  mount → byte-exact `cat`. Also pins: snapshot size = C×H×S×512,
  dirty count > 0 after guest writes.
- **Unit tests** (12 new): `WriteTrackingDisk` (passthrough, distinct
  dirty counting, snapshot byte-exactness, markClean); worker
  snapshot protocol (full bytes + dirty count, clean-reset on
  snapshot, `bytes: null` with no secondary — simulated guest writes
  go through `machine.secondaryDisk`, which asserts the machine
  really mounts the tracked wrapper); library (blank creation with
  geometry, garbage-geometry rejection, size-pinned write-back,
  unknown-id rejection, mutation-safe reads). Protocol exhaustiveness
  switches extended — they caught the new variants at compile time
  exactly as designed.
- **Unit suite 1,061 green, typecheck clean on all three configs**
  at commit time; the full-suite number lands in the phase close.

## 5. Limits / not done (recorded)

- **Save is explicit; a crash or reload loses unsaved writes.** By
  recorded design (no write-behind). The banner keeps the state
  visible; `beforeunload` nagging was deliberately skipped for v1.
- **The lock guard is advisory.** A second tab CAN mount and write
  the drive — it just can't save. True read-only mounting (BIOS
  write-protect on the slot) would be the strict version; noted for
  a follow-on if the field shows people corrupting drives anyway
  (they'd need to ignore a yellow banner to do it).
- **The banner's dirty count includes mkfs's own writes** — after
  formatting, ~dozens of sectors show unsaved before the user has
  "done" anything. Arguably correct (the format IS unsaved state);
  noted in case the field finds it confusing.
- **Browser-side end-to-end (real IDB, real Web Locks, real click on
  Save) is field work** — the dev tier run. Node covers the worker
  half and the library against fake-indexeddb.
- **MINIX v1 filesystem ceiling** (~64 MB / 16-bit block counts) was
  not probed; presets stop at 32 MB, inside any plausible limit.

## 6a. Field verification — THE LOOP CLOSES (2026-07-14)

Jonathan, dev tier, real browser: a boot script (using the full
directive set — @turbo for the compile, @here/@end for the heredoc,
@authentic for the run) typed hello.c, built it with the on-disk
toolchain, ran it, `cp ./hello /mnt` onto the persistent drive,
sync + umount, Save; after reboot, `/mnt/hello` printed
`hello human` cold. Compile once in a browser tab, keep the binary
forever — M2 and the in-VM toolchain composing exactly as intended.

**Finding from the same pass — the sticky "unchecked filesystem"
warning (refines §3):** the kernel clears MINIX_VALID_FS at mount
and umount only restores the *pre-mount* state
(`fs/minix/inode.c:63-79`) — so a snapshot saved while the drive was
mounted bakes the cleared flag in, and every later mount warns
"running fsck recommended" forever, clean umounts included. Plain
`fsck /dev/hdb` is read-only and silently repairs nothing; the cure
is one `fsck -a /dev/hdb` while unmounted (repair mode rewrites the
flag, `fsck.c:495`), then Save. Cosmetic only — data integrity was
never affected — but §3's "sync suffices" gains a footnote: sync
flushes *data*; only umount-before-Save keeps the *clean flag*
intact too. The Save banner copy already says umount first.

## 6. Field verification (dev tier only, per the standing constraint)

`npm run deploy:dev`, then: create an 8 MB drive in settings → reload
→ `mkfs /dev/hdb 8064 && mount /dev/hdb /mnt` → write something →
watch the banner count up → `umount /dev/hdb` (or `sync`) → Save →
reload → mount → the file is there. Cross-tab: open the same drive in
a second tab and confirm the yellow warning. 8086-tab.net untouched
until explicit promotion.
