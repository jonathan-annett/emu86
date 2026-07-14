# MINIX-fs Report — Phase 16 M1: the host reads the guest's drive

2026-07-15, same session as M0 (DRIVE_FORKS_REPORT.md). Scope: brief
§3 M1 — `src/disk/minix-fs.ts`, read-only, the enabling piece of the
editor seam: the panel that edits `/dev/hdb` needs to read the
filesystem ELKS built on it.

## 0. TL;DR

- `src/disk/minix-fs.ts` (new, ~450 lines): pure TS, no deps, no DOM,
  no Node APIs — the same bytes parse in the browser panel and in
  vitest. `openMinixImage(bytes)` → superblock facts + `list(path)` /
  `readFile(path)` / `stat(path)`. Errors are values with honest
  kinds: open verdicts `not-minix` / `unsupported` / `corrupt`; path
  results `not-found` / `not-a-directory` / `not-a-file` / `corrupt`.
- Written against the in-tree authoritative reference
  (`reference/elks/elks/tools/mfs/` — layouts from `minix_fs.h`, zone
  resolution from `inode.c ino_zone()`, dir lookup from
  `iname.c ilookup_name()`, path walk from `inode.c find_inode()`),
  cross-checked with the kernel's `linuxmt/minix_fs.h`. Not internet
  lore.
- **The oracle is ELKS itself**: the committed fixture
  (`tests/fixtures/minix-v1-2048.img`, provenance in its README) was
  formatted and populated by the real guest's own mkfs/shell/cp inside
  the emulator, `fsck`-clean, snapshotted by the same message the Save
  button uses. The generator stays as an env-gated probe
  (`MINIX_FIXTURE_GEN=1`), never in CI.
- All three zone chains are exercised by guest-written data: direct
  (small files), indirect (`big.txt`, 16 distinct chunks so index bugs
  can't hide), double-indirect (`huge.txt`, 976 KB, line length
  coprime with the block size so every block has a distinct phase).

## 1. Decisions recorded

- **v1 only, zones == blocks.** Magic 0x137F (and 0x138F, the 30-char
  variant — same layout, free to support). MINIX v2 answers
  `unsupported`, named as such; so does a non-zero `s_log_zone_size` —
  the mfs reference assumes both, and every image this project makes
  satisfies both.
- **Holes read as zeros** (zone pointer 0), exactly like
  `mfs/reader.c`. The fixture has no sparse file — ELKS shell can't
  make one — so this path is code-reviewed against the reference, not
  fixture-proven. Recorded honestly.
- **`list()` returns `.` and `..` and skips inode-0 slots** — the
  filesystem's truth; filtering is caller policy (the panel will hide
  them). The fixture contains a real deleted slot (`doomed.txt`,
  created and `rm`'d by the guest) to pin the skip.
- **Names longer than nameLen are honestly `not-found`** — they cannot
  exist on the fs. Mangling is the editor project's problem (brief
  §2), not this module's.
- **Zone pointers are validated against the data area** — a pointer
  below `s_firstdatazone` or past `s_nzones` is a `corrupt` value with
  the offending zone in the detail, not a wild read into the
  superblock or off the buffer.
- **The root inode is verified at open** so a wiped inode table fails
  at `openMinixImage` with a verdict, not at first `stat`.
- **Bytes are not copied at open.** The caller owns the buffer (a
  worker snapshot or a fixture read); M3's peek message will hand the
  panel a fresh snapshot each time, so aliasing is a non-issue there.

## 2. What the fixture pins (tests/unit/minix-fs.test.ts, 17 tests)

Byte-exact `readFile` for every content-bearing file — including
across both indirect boundaries — with expected bytes computed
host-side from the population script (the guest's `ls -l` sizes
reconciled exactly: 976 = 61×16, 15,744 = 16×(8+976),
999,424 = 976×1024). Tree listings for `/`, `/dir1`, `/dir1/sub`;
root `.`/`..` both inode 1; a zero-byte file; a real ELKS a.out
binary (`cp /bin/ls`, header magic 0x01 0x03); stat facts; path
normalization (`//dir1///sub`); every error kind. Graceful verdicts:
zeros, a real FAT12 image (the Phase 12 probe-disk builder), a
too-small buffer, a v2 superblock, a truncated image, a wiped inode
table.

## 3. Found while building

- **`toEqual` on megabyte typed arrays strikes again** — see
  DRIVE_FORKS_REPORT.md §5; the byte-exact comparisons here use plain
  loops from the start.
- The guest's `fsck /dev/hdb` on the freshly-populated drive exits 0
  and prints nothing — recorded as the provenance baseline M2 will
  reuse as its judge.

## 4. Verified

- Suite: **1,251 passed / 114 files / 1 skipped** (SST corpus, as
  always) — typecheck clean on all three configs. Baseline up from
  1,233 (+17 minix-fs, +1 generator shell). This was the
  milestone-closing full run; per Jonathan's cadence ruling
  (2026-07-15, now CLAUDE.md rule 6) the full suite gates deploys and
  milestone commits, with judgment in between.
- The generator run itself is part of the evidence: the guest booted,
  formatted, populated, fsck'd clean, and the parser opened the
  snapshot and listed the tree before the fixture was written.

## 5. Deliberately NOT done (M2+ boundaries)

No write path (M2: `writeFile`/`remove`/`mkdir`, ELKS fsck as judge).
No symlink read (ELKS images don't lean on them; `stat` reports the
type, `readFile` refuses politely — add a `readLink` when something
needs it). No sparse-file fixture (see §1). No worker plumbing (M3)
and no panel (M4). The 14-char name mangling stays the editor
project's problem.
