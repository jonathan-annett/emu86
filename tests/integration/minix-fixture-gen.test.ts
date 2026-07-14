/**
 * MINIX v1 fixture GENERATOR (Phase 16 M1) — not a test of anything.
 *
 * Boots the real ELKS guest (hd32-minix.img) with a blank secondary on
 * the canonical 8086 KB geometry (311×4×13), has the guest's own mkfs
 * format the first 2048 blocks, populates the known tree the unit
 * tests assert against (tests/unit/minix-fs.test.ts — keep the two in
 * lockstep), umounts, snapshots, and commits the first 2 MB as
 * `tests/fixtures/minix-v1-2048.img`. The point of the ceremony: the
 * fixture's bytes come out of ELKS itself, so the TS parser is tested
 * against the REAL writer, not against my reading of the reference.
 *
 * SKIPPED by default — this is the brief's "generator kept as a probe,
 * NOT run in CI". Rerun when the fixture must change:
 *
 *   MINIX_FIXTURE_GEN=1 npx vitest run tests/integration/minix-fixture-gen.test.ts
 *
 * …then update tests/fixtures/README.md (provenance) and the unit
 * test's expected tree if the population script changed.
 *
 * Boot/shell machinery: guest-drive-harness.ts — extracted there on
 * its third copy (this file was the second; the Phase 15 persistence
 * test keeps its own original on purpose).
 */

import { describe, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openMinixImage } from '../../src/disk/minix-fs.js';
import {
  bootGuest,
  guestShell,
  takeSecondarySnapshot,
  DRIVE_8086_GEOMETRY,
  HD32_PATH,
} from './guest-drive-harness.js';

const FIXTURE_DIR = resolve('tests/fixtures');
const FIXTURE_PATH = resolve(FIXTURE_DIR, 'minix-v1-2048.img');

const TEST_TIMEOUT_MS = 15 * 60 * 1000;

/** Only the first 2048 blocks of the canonical 8086 KB drive are
 *  formatted: a 2 MB fixture is big enough for every case in the
 *  tree and small enough to commit. */
const MKFS_BLOCKS = 2048;

describe('MINIX v1 fixture generator (env-gated probe, not CI)', () => {
  it(
    'guest mkfs + known tree → tests/fixtures/minix-v1-2048.img',
    async () => {
      if (process.env.MINIX_FIXTURE_GEN !== '1') {
        console.warn(
          '[skip] fixture generator idle. To regenerate: ' +
            'MINIX_FIXTURE_GEN=1 npx vitest run tests/integration/minix-fixture-gen.test.ts',
        );
        return;
      }
      if (!existsSync(HD32_PATH)) {
        throw new Error(`${HD32_PATH} not found — npm run build:elks-hd-image -- hd32-minix`);
      }

      const s = await bootGuest({
        imageBytes: new Uint8Array(0), // blank, zero-filled to geometry
        geometry: DRIVE_8086_GEOMETRY,
      });

      const log: string[] = [];
      const run = (line: string, maxSlices?: number): string => {
        const out = guestShell(s, line, maxSlices);
        log.push(`$ ${line}\n${out}`);
        return out;
      };

      const mkfsOut = run(`mkfs /dev/hdb ${MKFS_BLOCKS}`);
      if (/error|not found|No such/i.test(mkfsOut)) {
        throw new Error(`mkfs failed:\n${mkfsOut}`);
      }
      run('mount /dev/hdb /mnt');

      // The known tree — tests/unit/minix-fs.test.ts asserts EXACTLY
      // this. Every content byte is derivable on the host.
      run('echo emu86 minix-fs fixture rev 1 > /mnt/README.txt');
      run('echo fourteen > /mnt/abcdefghijklmn'); // exactly 14 chars — the name-limit case
      run('mkdir /mnt/dir1');
      run('echo nested file content > /mnt/dir1/nested.txt');
      run('mkdir /mnt/dir1/sub');
      run('cat /dev/null > /mnt/dir1/sub/empty.txt'); // zero-byte file

      // big.txt — crosses the 7-direct-zone boundary (needs > 7 KB)
      // with DISTINCT content per 1 KB block, so an indirect-table
      // indexing bug cannot hide behind repeating blocks: 16 chunks,
      // each "chunk-<x>\n" + ~1 KB of seed, ≈ 16 KB total.
      run('echo 0123456789-emu86-minix-v1-fixture-seed-line-0123456789abcdef > /mnt/seed.txt');
      for (let i = 0; i < 4; i += 1) {
        run('cat /mnt/seed.txt /mnt/seed.txt > /mnt/t.txt');
        run('mv /mnt/t.txt /mnt/seed.txt');
      }
      run(
        'for f in a b c d e f g h i j k l m n o p; do echo chunk-$f; cat /mnt/seed.txt; done > /mnt/big.txt',
      );

      // huge.txt — crosses the DOUBLE-indirect boundary (> 7+512 KB):
      // seed doubled 10 more times → 976 KB. The 61-byte seed line is
      // coprime with the 1024-byte block, so every block carries a
      // different phase of the pattern — cheap distinctness, real
      // guest-written double-indirect chains. Later doublings shuttle
      // ~1 MB through the guest, so they get a fat instruction budget.
      run('cat /mnt/seed.txt /mnt/seed.txt > /mnt/huge.txt');
      for (let i = 0; i < 9; i += 1) {
        run('cat /mnt/huge.txt /mnt/huge.txt > /mnt/t.txt', 400);
        run('mv /mnt/t.txt /mnt/huge.txt', 100);
      }
      log.push(run('ls -l /mnt/huge.txt'));

      // Binary blob: a real ELKS executable (a.out header, NUL bytes).
      run('cp /bin/ls /mnt/binblob');
      const lsSize = run('ls -l /mnt/binblob');
      log.push(`binblob listing: ${lsSize.trim()}`);

      // A deleted directory slot (inode 0) for the skip-deleted path.
      run('echo doomed > /mnt/doomed.txt');
      run('rm /mnt/doomed.txt');

      log.push(run('ls -l /mnt'));
      log.push(run('ls -l /mnt/dir1'));
      run('sync');
      run('umount /dev/hdb');
      // fsck verdict if the image carries it — provenance gold, not a gate.
      log.push(run('fsck /dev/hdb || echo NO-FSCK'));

      // Snapshot — exactly what the Save button takes.
      const full = takeSecondarySnapshot(s);
      const fixture = full.slice(0, MKFS_BLOCKS * 1024);

      // Sanity before committing: our own parser must at least open it
      // (the REAL verification is the unit suite's byte-exact pass).
      const opened = openMinixImage(fixture);
      if (!opened.ok) {
        throw new Error(`generated fixture does not open: ${opened.kind} — ${opened.detail}`);
      }
      const rootList = opened.fs.list('/');
      if (!rootList.ok) throw new Error(`list('/') failed: ${rootList.detail}`);
      console.log('[fixture] root entries:', rootList.value.map((e) => e.name).join(' '));

      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(FIXTURE_PATH, fixture);
      console.log(`[fixture] wrote ${FIXTURE_PATH} (${fixture.byteLength} bytes)`);
      console.log('[fixture] generation log:\n' + log.join('\n'));
    },
    TEST_TIMEOUT_MS,
  );
});
