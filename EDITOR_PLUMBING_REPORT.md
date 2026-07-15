# Editor Plumbing Report — Phase 16 M3: read and write the RUNNING drive

2026-07-15, following M0–M2 in the same arc (DRIVE_FORKS_REPORT.md,
MINIX_FS_REPORT.md, MINIX_FS_WRITE_REPORT.md). Scope: brief §3 M3 —
protocol-layer only, no cpu/machine/architecture changes (hard rules
1/3), same shape as M2's snapshot work.

## 0. What was built

- **Read side — the `keepDirty` peek.** The brief left the choice
  between a new `peek-secondary` message and a flag on the existing
  one ("smallest diff wins"): the flag won.
  `snapshot-secondary { keepDirty: true }` returns the same full
  snapshot but does NOT mark the disk clean. This mattered more after
  M0 than when the brief was written: marking clean on a panel READ
  would zero the dirty counter that triggers the fork auto-persist —
  a reader starving the persistence of the thing it reads. Default
  (absent/false) is Phase 15 semantics, untouched: Save and
  auto-persist still mark clean.
- **Write side — `write-secondary { bytes }` → `secondary-written
  { ok, detail? }`.** Wholesale in-RAM replace via a new
  `WriteTrackingDisk.replaceContents()` that goes through the inner
  disk's own `writeSector` (wrapper invariants preserved), refuses
  size mismatches (a drive's geometry is its identity), and marks the
  disk CLEAN — the sender is the main thread handing over bytes it
  already persisted to the fork row, so RAM and IDB agree by
  construction and the heartbeat won't re-persist what was just
  written. The machine keeps running throughout; coherence is
  floppy-passing (brief §1) — the guest must (re)mount to see panel
  writes, and since mounts are undetectable that is a NOTICE the M4
  panel shows, never a guard.
- **main.ts**: `requestSnapshot(keepDirty)` + a `secondaryWriteAcks`
  FIFO mirroring the snapshot-sink pattern (postMessage ordering
  makes FIFO matching sound). The panel (M4) is the pusher; an
  unsolicited ack warns loudly. No new persistence paths — M0's
  auto-persist and promote are untouched.

## 1. Verified

- Protocol exhaustiveness switches extended — they caught both new
  variants at compile time, as designed (third time this pattern has
  paid for itself).
- `tests/unit/worker-host-secondary.test.ts` +4: peek preserves the
  dirty count across a subsequent real snapshot; write-secondary
  replaces wholesale, acks, is visible to the running guest's next
  read, and leaves dirty at 0; size-mismatch nacks with the drive and
  its dirt untouched; no-drive nacks honestly.
- Typecheck clean on all three configs; targeted suites green
  (worker-host-secondary, browser-protocol, pacing neighbours —
  25/25). Full suite runs at the M4 deploy gate per the cadence
  ruling.

## 2. Deliberately NOT done

The panel itself, the remount notice UI, and any caller of
`write-secondary` (all M4 — next); guest-mount detection (impossible
from the host, recorded in the brief and honored as a notice);
partial/sector-range writes (whole image only — the fs-level
atomicity story lives in the panel swapping complete images).
