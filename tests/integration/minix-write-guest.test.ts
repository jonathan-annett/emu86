/**
 * The M2 killer test (brief §3): the guest is the oracle for the
 * host-side MINIX write path, in BOTH directions, in one boot.
 *
 *   1. The HOST writes /hello.c into the fixture image with
 *      minix-fs.ts (create), plus a directory + nested file (mkdir),
 *      and replaces an existing file (whole-file replace).
 *   2. The guest boots with that image as /dev/hdb, mounts it, `cat`s
 *      the host-written bytes back, and — the judge — runs
 *      `fsck /dev/hdb` after umount: silent exit means the host's
 *      bitmap/inode/dirent bookkeeping satisfies ELKS itself.
 *   3. The guest then writes its own file, sync + umount, the harness
 *      snapshots (the Save button's message), and the HOST reads the
 *      guest's file back byte-exactly — half of this direction was
 *      already proven by the Phase 15 persistence test; here it lands
 *      on the actual parser.
 *
 * Skips with a pointer when the hd32 image or the fixture is absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openMinixImage } from '../../src/disk/minix-fs.js';
import {
  bootGuest,
  guestShell,
  takeSecondarySnapshot,
  DRIVE_8086_GEOMETRY,
  DRIVE_8086_BYTES,
  HD32_PATH,
} from './guest-drive-harness.js';

const FIXTURE_PATH = resolve('tests/fixtures', 'minix-v1-2048.img');
const TEST_TIMEOUT_MS = 15 * 60 * 1000;

const HELLO_C = [
  '#include <stdio.h>',
  '',
  'int main(void)',
  '{',
  '    printf("written by the host, read by the guest\\n");',
  '    return 0;',
  '}',
  '',
].join('\n');

const ascii = (s: string): Uint8Array =>
  new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('Phase 16 M2 — guest oracle for the host write path', () => {
  it(
    'host writes → guest cats + fsck; guest writes → host reads',
    async () => {
      if (!existsSync(HD32_PATH) || !existsSync(FIXTURE_PATH)) {
        console.warn(
          `[skip] needs ${HD32_PATH} and ${FIXTURE_PATH} — ` +
            'see tests/fixtures/README.md',
        );
        return;
      }

      // ---- 1: host-side writes onto the fixture ----
      const image = new Uint8Array(DRIVE_8086_BYTES); // pad 2 MB fs onto the 8086 KB device
      image.set(new Uint8Array(readFileSync(FIXTURE_PATH)));
      const opened = openMinixImage(image);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const fs = opened.fs;

      expect(fs.writeFile('/hello.c', ascii(HELLO_C)).ok).toBe(true);
      expect(fs.mkdir('/src').ok).toBe(true);
      expect(fs.writeFile('/src/note.txt', ascii('made by mkdir+writeFile\n')).ok).toBe(true);
      expect(fs.writeFile('/README.txt', ascii('replaced by the host\n')).ok).toBe(true);

      // ---- 2: the guest reads them and fsck judges the bookkeeping ----
      const s = await bootGuest({ imageBytes: image, geometry: DRIVE_8086_GEOMETRY });
      guestShell(s, 'mount /dev/hdb /mnt');
      const cat = guestShell(s, 'cat /mnt/hello.c');
      expect(cat).toContain('written by the host, read by the guest');
      const catNote = guestShell(s, 'cat /mnt/src/note.txt');
      expect(catNote).toContain('made by mkdir+writeFile');
      const catReadme = guestShell(s, 'cat /mnt/README.txt');
      expect(catReadme).toContain('replaced by the host');

      // ---- 3: the guest writes; the host parses the snapshot ----
      guestShell(s, 'echo guest wrote this back > /mnt/guest.txt');
      guestShell(s, 'sync');
      guestShell(s, 'umount /dev/hdb');

      // The judge: ELKS fsck on the drive the HOST modified. Silent
      // exit 0 = the host's bookkeeping passed the guest's own tool.
      const fsck = guestShell(s, 'fsck /dev/hdb && echo FSCK-OK');
      expect(fsck).toContain('FSCK-OK');
      expect(fsck).not.toMatch(/bad|wrong|corrupt|unable|error/i);

      const snap = takeSecondarySnapshot(s);
      const reopened = openMinixImage(snap);
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) return;
      const guestFile = reopened.fs.readFile('/guest.txt');
      expect(guestFile.ok).toBe(true);
      if (!guestFile.ok) return;
      expect(String.fromCharCode(...guestFile.value)).toBe('guest wrote this back\n');

      // The host's own files survived the guest session, byte-exact.
      const hello = reopened.fs.readFile('/hello.c');
      expect(hello.ok).toBe(true);
      if (hello.ok) expect(String.fromCharCode(...hello.value)).toBe(HELLO_C);
    },
    TEST_TIMEOUT_MS,
  );
});
