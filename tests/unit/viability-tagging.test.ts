/**
 * Tests for the per-asset viability heuristic.
 *
 * The heuristic is a small pure function — the cost of pinning known
 * cases here is low and the value (catching a regression that re-tags
 * everything as `untested`) is high.
 */

import { describe, expect, it } from 'vitest';
import { classifyAsset, describeTag } from '../../web/viability-tagging.js';

describe('viability-tagging', () => {
  it('tags fd*-fat-serial.img as likely-works', () => {
    expect(classifyAsset('fd1440-fat-serial.img', { sizeBytes: 1474560 }))
      .toBe('likely-works');
    expect(classifyAsset('fd1200-fat-serial.img', { sizeBytes: 1228800 }))
      .toBe('likely-works');
  });

  it('tags partitionless HD FAT images as likely-works (Phase 10)', () => {
    // Phase 10 pinned `hd*-fat.img` boot end-to-end via the
    // tests/integration/elks-hd-boot.test.ts integration test.
    expect(classifyAsset('hd32-fat.img', { sizeBytes: 32514048 }))
      .toBe('likely-works');
    expect(classifyAsset('hd64-fat.img', { sizeBytes: 67107840 }))
      .toBe('likely-works');
  });

  it('tags partitionless HD MINIX images as likely-works (Phase 10.2)', () => {
    // Phase 10.2 pinned `hd*-minix.img` boot end-to-end via the
    // tests/integration/elks-hd-minix-boot.test.ts integration test —
    // the partitionless MINIX path uses the same disk shape and BIOS
    // handoff as the FAT case.
    expect(classifyAsset('hd32-minix.img', { sizeBytes: 32514048 }))
      .toBe('likely-works');
    expect(classifyAsset('hd64-minix.img', { sizeBytes: 67107840 }))
      .toBe('likely-works');
  });

  it('tags MBR-partitioned HD images as likely-works (Phase 10.1)', () => {
    // Phase 10.1 pinned authentic MBR chain-load boot end-to-end — both
    // FAT and MINIX VBR variants — via tests/integration/elks-mbr-boot.test.ts.
    expect(classifyAsset('hd32mbr-fat.img', { sizeBytes: 32546304 }))
      .toBe('likely-works');
    expect(classifyAsset('hd64mbr-fat.img', { sizeBytes: 67140096 }))
      .toBe('likely-works');
    expect(classifyAsset('hd32mbr-minix.img', { sizeBytes: 32546304 }))
      .toBe('likely-works');
    expect(classifyAsset('hd64mbr-minix.img', { sizeBytes: 67140096 }))
      .toBe('likely-works');
  });

  it('tags unknown-shape > 10 MB assets as known-incompatible (size threshold)', () => {
    // Even an "fd*"-named asset above the floppy cap is incompatible —
    // belt-and-braces in case upstream publishes an oddly-shaped asset
    // that doesn't match one of the verified HD patterns above.
    expect(classifyAsset('fd-something-large.img', { sizeBytes: 50 * 1024 * 1024 }))
      .toBe('known-incompatible');
    // A bizarre future image we don't recognise — keep tagging defensively.
    expect(classifyAsset('weird-large.img', { sizeBytes: 50 * 1024 * 1024 }))
      .toBe('known-incompatible');
  });

  it('tags fd*.img without serial+fat as untested', () => {
    expect(classifyAsset('fd1440-fat.img', { sizeBytes: 1474560 }))
      .toBe('untested');
    expect(classifyAsset('fd1440-minix.img', { sizeBytes: 1474560 }))
      .toBe('untested');
    expect(classifyAsset('fd1440.img', { sizeBytes: 1474560 }))
      .toBe('untested');
    expect(classifyAsset('fd360-fat.img', { sizeBytes: 368640 }))
      .toBe('untested');
    expect(classifyAsset('fd2880-fat.img', { sizeBytes: 2949120 }))
      .toBe('untested');
  });

  it('falls back to untested for unrecognised shapes', () => {
    expect(classifyAsset('something-weird.img', { sizeBytes: 1024 }))
      .toBe('untested');
    expect(classifyAsset('elks.img', { sizeBytes: 1474560 }))
      .toBe('untested');
  });

  it('rule order: hd*mbr-fat.img matches the MBR rule, not the partitionless rule', () => {
    // Defensive — `hd32mbr-fat.img` should NOT match a looser
    // `^hd\d+-fat.img$` regex; the `mbr` infix is what selects the
    // MBR-partitioned rule. If a future refactor reorders or generalises
    // the regexes this test catches a silent re-tagging.
    expect(classifyAsset('hd32mbr-fat.img', { sizeBytes: 32546304 }))
      .toBe('likely-works');
    expect(classifyAsset('hd32mbr-minix.img', { sizeBytes: 32546304 }))
      .toBe('likely-works');
  });

  it('classification is case-insensitive', () => {
    // Upstream uses lowercase, but a one-off title-cased asset shouldn't
    // be mis-tagged.
    expect(classifyAsset('HD32MBR-FAT.IMG', { sizeBytes: 32546304 }))
      .toBe('likely-works');
    expect(classifyAsset('Hd32-Fat.Img', { sizeBytes: 32514048 }))
      .toBe('likely-works');
  });

  it('verified HD shapes are not downgraded by the size threshold', () => {
    // The size threshold runs *after* HD pattern rules in classifyAsset,
    // so a 67 MB hd64*-fat.img stays `likely-works` rather than being
    // re-tagged `known-incompatible` by the > 10 MB defensive rule.
    expect(classifyAsset('hd64-fat.img', { sizeBytes: 67107840 }))
      .toBe('likely-works');
    expect(classifyAsset('hd64mbr-fat.img', { sizeBytes: 67140096 }))
      .toBe('likely-works');
  });

  it('rule order: hd*mbr-minix.img matches the MBR rule, not the partitionless MINIX rule (Phase 10.2)', () => {
    // Phase 10.2 promoted the partitionless MINIX rule to `likely-works`,
    // so both rules now return the same tag — but the regexes must still
    // match the right one (otherwise the tag is right by accident, and a
    // future demotion of one rule would silently leak into the other).
    // The `\d+` in `^hd\d+-minix\.img$` matches digits only, so
    // `hd32mbr-minix.img` does NOT match the partitionless rule — it
    // falls through to the MBR rule, which also returns `likely-works`.
    expect(classifyAsset('hd32mbr-minix.img', { sizeBytes: 32546304 }))
      .toBe('likely-works');
    expect(classifyAsset('hd32-minix.img', { sizeBytes: 32514048 }))
      .toBe('likely-works');
  });

  it('does not match malformed HD-style filenames', () => {
    // Defensive: filename must end with `.img` exactly. A `.imag` typo
    // or a stray suffix should fall through to the unknown-shape path.
    expect(classifyAsset('hd32-fat.imag', { sizeBytes: 32514048 }))
      .toBe('known-incompatible'); // > 10 MB threshold catches it
    expect(classifyAsset('hd32-fat.img.bak', { sizeBytes: 32514048 }))
      .toBe('known-incompatible');
  });

  it('size hint is optional — filename rules work without it', () => {
    // `sizeBytes` is a hint, not a requirement. Filename-only callers
    // (e.g., a cached listing) still get the right tag.
    expect(classifyAsset('hd32mbr-fat.img')).toBe('likely-works');
    expect(classifyAsset('hd32-fat.img')).toBe('likely-works');
    expect(classifyAsset('hd32-minix.img')).toBe('likely-works');
    expect(classifyAsset('fd1440-fat-serial.img')).toBe('likely-works');
  });

  it('describeTag returns a human-readable label for each tag', () => {
    expect(describeTag('likely-works')).toBe('Likely works');
    expect(describeTag('untested')).toBe('Untested');
    expect(describeTag('known-incompatible')).toBe('Known incompatible');
  });
});
