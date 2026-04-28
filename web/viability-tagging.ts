/**
 * Per-asset viability tagging for GitHub release downloads.
 *
 * The user has explicitly opted into seeing all assets including the ones
 * likely to fail; these tags inform, they don't gatekeep. Even
 * `known-incompatible` assets remain downloadable.
 *
 * Heuristic — derived from the Section 1 diagnosis of ghaerr/elks v0.9.0
 * asset names. Refreshed in Phase 10 (HD boot landed), Phase 10.1 (MBR
 * partitioning landed), and Phase 10.2 (partitionless MINIX HD pinned) —
 * the rules now reflect what genuinely boots:
 *
 *   `likely-works`        — filename matches the bundled image's pattern
 *                           (`fd*-fat-serial.img`-shaped) OR a hard-disk
 *                           image that the integration tests cover end-to-
 *                           end: `hd*-fat.img` (Phase 10), `hd*mbr-fat.img`
 *                           and `hd*mbr-minix.img` (Phase 10.1),
 *                           `hd*-minix.img` (Phase 10.2).
 *
 *   `untested`            — anything `fd*.img` (floppy-class) that isn't
 *                           obviously serial+FAT. Different filesystem
 *                           (minix), different console config (defaults to
 *                           CGA when there's no `serial`), or a rarer
 *                           geometry (1.2 MB, 720 KB, 360 KB, 2.88 MB).
 *
 *   `known-incompatible`  — none currently. The size threshold below stays
 *                           in place defensively (any asset > 10 MB that
 *                           doesn't match a known HD pattern is still
 *                           flagged), but the previous blanket `hd*` rule
 *                           has been retired.
 *
 * Rule order matters: the most specific filename patterns are checked
 * first, then the size threshold, then the broader floppy fallback. The
 * size threshold runs *after* the HD-pattern rules so a verified HD image
 * isn't downgraded by virtue of being large.
 *
 * Caveats — documented in the report:
 *   - As of v0.9.0 ghaerr/elks publishes NO `*-serial.img` assets. The
 *     `likely-works` floppy rule exists to handle a future where upstream
 *     publishes serial builds; today's known-good HD images (and the
 *     bundled floppy) cover the available paths.
 *   - All `fd*-fat.img` and `fd*-minix.img` floppy assets are tagged
 *     `untested` — the existing tests don't cover them.
 */

export type ViabilityTag = 'likely-works' | 'untested' | 'known-incompatible';

export interface ViabilityHints {
  /** Optional tag if the brief's known-incompatible size cap applies. */
  sizeBytes?: number;
}

/** Threshold above which any asset is auto-tagged as known-incompatible. */
const HARD_DISK_SIZE_THRESHOLD = 10 * 1024 * 1024;

/**
 * Returns the viability tag for an asset.
 *
 * - The size threshold is OR'd with the filename heuristic so a future
 *   `floppy-100mb.img` (hypothetical) still gets tagged `known-incompatible`
 *   on size alone.
 * - Filename matching is case-insensitive — the upstream uses lowercase but
 *   we shouldn't break if a one-off title-cases something.
 */
export function classifyAsset(
  filename: string,
  hints: ViabilityHints = {},
): ViabilityTag {
  const lower = filename.toLowerCase();

  // ---- HD images: rules are filename-first so verified shapes are not
  // downgraded by the size threshold below. Order matters: `hd*mbr-*`
  // patterns must run before the `hd*-` patterns, because `hd32mbr-fat.img`
  // would also match a looser `hd*-fat.img` rule.

  // Phase 10.1 verified: MBR-partitioned HD images, FAT and MINIX, boot
  // end-to-end via authentic chain-load.
  if (/^hd\d+mbr-fat\.img$/.test(lower)) return 'likely-works';
  if (/^hd\d+mbr-minix\.img$/.test(lower)) return 'likely-works';

  // Phase 10 verified: partitionless FAT HD images boot end-to-end.
  if (/^hd\d+-fat\.img$/.test(lower)) return 'likely-works';

  // Phase 10.2 verified: partitionless MINIX HD images boot end-to-end —
  // same disk shape and BIOS handoff as the FAT case, kernel auto-detects
  // MINIX from the on-disk superblock.
  if (/^hd\d+-minix\.img$/.test(lower)) return 'likely-works';

  // ---- Floppy / serial rules (unchanged from Phase 9.3) ----

  // Likely-works: the bundled image's pattern is `fd1440-fat-serial.img`.
  // Match `fd<size>-fat-serial.img` shape — a serial console FAT floppy.
  if (/^fd\d+-fat-serial\.img$/.test(lower)) {
    return 'likely-works';
  }

  // Floppy-class anything else — `fd*.img` of various filesystems and
  // geometries. We don't claim it works; we don't claim it doesn't.
  if (/^fd\d+/.test(lower) && lower.endsWith('.img')) {
    return 'untested';
  }

  // ---- Defensive size threshold for unknown-shape large images ----
  // Anything over the floppy cap whose filename didn't match a verified
  // HD pattern is by current emulator capability not viable. Runs last
  // so verified `hd*-fat`, `hd*mbr-*` images aren't reclassified.
  if (typeof hints.sizeBytes === 'number' && hints.sizeBytes > HARD_DISK_SIZE_THRESHOLD) {
    return 'known-incompatible';
  }

  // Default: unknown shape. Treat as untested rather than incompatible —
  // tagging an unknown image as definitively broken would be dishonest.
  return 'untested';
}

/**
 * Human-readable label for the tag, suitable for the modal.
 */
export function describeTag(tag: ViabilityTag): string {
  switch (tag) {
    case 'likely-works': return 'Likely works';
    case 'untested': return 'Untested';
    case 'known-incompatible': return 'Known incompatible';
  }
}
