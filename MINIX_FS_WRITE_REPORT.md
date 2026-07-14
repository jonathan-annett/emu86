# MINIX-fs Write Report — Phase 16 M2: the host writes, the guest judges

2026-07-15, same session as M0 and M1 (DRIVE_FORKS_REPORT.md,
MINIX_FS_REPORT.md). Scope: brief §3 M2 — `writeFile` (create or
whole-file replace), `remove`, `mkdir`, bitmap allocation per the mfs
reference, ELKS `fsck` as the judge.

## 0. TL;DR

`src/disk/minix-fs.ts` gained the write path (~400 lines): whole-file
semantics only, mutating the caller's buffer in place (which is the
M3 contract — the panel hands the whole image back to the worker).
Allocation follows the mfs reference: first-free-bit scans, zones
wired on demand including the indirect table, all-zero blocks stored
as holes exactly like `writer.c`. Writes refuse double-indirect sizes
(> 531,456 bytes, brief §2's honest limit) but truncation walks the
full double-indirect chain — replacing the fixture's 976 KB file with
one line frees ~980 zones and stays clean. Two judges: the guest's
own `fsck` (integration), and `fsckLite` — an independent TS
invariant checker that runs after every unit case.

## 1. Found while building: TWO reference bugs, both recorded

- **ELKS mkfs never frees inode №ninodes.** `mkfs.c:253` clears
  inode-bitmap bits with `for (i = MINIX_ROOT_INO; i < INODES; i++)`
  — `<`, not `<=` — so bit `ninodes` stays set in every image the
  guest formats, and inode number `ninodes` (682 on the 2 MB fixture)
  is permanent padding. The zone loop has no such off-by-one. Found
  when fsckLite's first draft flagged "inode 682 marked but
  unreachable" on the PRISTINE fixture — the checker-sanity test
  doing exactly its job. Consequence for this module: the allocator
  treats `n >= ninodes` as full, and the checker treats bit ninodes
  as padding. (Upstream-worthy, like the urlget bug — one wasted
  inode per filesystem.)
- **mfs `dname_rem` frees the wrong block on exact-boundary
  shrinks** (`iname.c`): when removing the last dirent leaves the
  directory size on a block boundary, it calls
  `free_inoblk(dir, size/BLOCK_SIZE + 1)` — one block PAST the one
  that emptied. The freed-nothing call is a no-op and the real block
  leaks (until fsck complains). This module frees `size/BLOCK_SIZE`;
  the boundary case is unit-tested.

## 2. Decisions recorded

- **Whole-file only** (brief): no partial writes, no append. `remove`
  is files/symlinks only — rmdir is out of M2's scope and refuses
  with an honest error.
- **Holes on write**: an all-zero 1 KB block stores as zone 0, like
  the reference writer. This also gives the read path's hole handling
  a writer-side exerciser (M1 recorded that gap honestly).
- **no-space unwinding**: a half-created file is rolled back (zones
  freed, dirent dropped, inode released); a half-REPLACED file stays
  as written so far — recorded, fsck-clean either way. Replacement is
  not atomic; the editor seam's whole-image write (M3) is where
  atomicity actually lives (the panel swaps complete images).
- **Modes**: created files are 0644 root:root, directories 0755 —
  what the guest's own tools produce.
- **fsckLite parses raw bytes independently** (own superblock/inode/
  bitmap readers) — a checker that trusted the module under test
  would vouch for its own bugs. It cross-checks: zone bitmap ⟺
  reachable zones (data + both indirect levels), no double-refs, no
  out-of-range; inode bitmap ⟺ root-walk reachability; nlinks ⟺
  dirent reference counts. It passes on the pristine guest-written
  fixture first (checker sanity), then after every mutation.
- **Harness extraction at third copy**: boot/shell/snapshot machinery
  now lives in `tests/integration/guest-drive-harness.ts`, used by
  the fixture generator and the M2 oracle. The Phase 15 persistence
  test keeps its original copy untouched — it is field-proven
  acceptance code with its own lifecycle.

## 3. Verified

- Unit (`tests/unit/minix-fs-write.test.ts`, 11 tests): create small
  + indirect-sized (distinct-block patterns); replace grow across the
  indirect boundary; replace the 976 KB double-indirect file with a
  line (~980 zones freed, byte-exact); holes stored and read back;
  remove + slot reuse; last-entry directory shrink (the boundary the
  reference gets wrong); mkdir with `.`/`..` and parent nlinks;
  writes at exactly the cap succeed and one byte over refuses; every
  error kind; fsckLite green after every case. All reopen the bytes
  before asserting — on-disk truth, not module state.
- Integration (`tests/integration/minix-write-guest.test.ts`, the
  brief's killer test, one boot): host writes `/hello.c` + `mkdir
  /src` + a nested file + replaces `/README.txt` into the fixture →
  the guest boots it as /dev/hdb, `cat`s all of them back, and
  **`fsck /dev/hdb && echo FSCK-OK` passes on the host-modified
  drive**; then the guest writes its own file, sync + umount,
  snapshot, and the host `readFile`s it byte-exactly — both
  directions, one image. PASSED first run (33 s of guest time):
  FSCK-OK on the host-written filesystem, every cat matched, the
  guest's file came back byte-exact, and the host's files survived
  the guest session unchanged.
- Typecheck clean on all three configs. Suite delta: +12 tests
  (+11 unit, +1 integration). Per the cadence ruling the full suite
  runs at the next deploy gate; the targeted minix suites and the
  oracle ran here.

## 4. Deliberately NOT done

rmdir; rename; append/partial writes; atomic replace (see §2);
hardlink creation (nlinks > 1 is READ correctly and `remove`
decrements honestly, but nothing creates links); symlink creation;
free-count acceleration structures (v1 has none — bitmap scans are
the truth); any worker/protocol/panel work (M3/M4 are next).
