/**
 * Virtual-drive persistence, end to end (Phase 15 M2 acceptance).
 *
 * The actual proof of the feature: TWO full boots of stock
 * `hd32-minix.img` through WorkerHost with a blank 8 MB secondary.
 *
 *   Boot 1: guest runs its own `mkfs /dev/hdb 8064`, mounts it, writes
 *           a file, umounts (the reliable flush —
 *           ARTIFACT_EXTRACTION_REPORT.md §4), then the harness takes
 *           a `snapshot-secondary` — exactly what the Save button does.
 *   Boot 2: a NEW WorkerHost boots with the snapshot as its secondary
 *           (what the library hands the next session); the guest
 *           mounts it and reads the file back.
 *
 * If the sentence survives the reboot, creation, formatting, guest
 * writes, snapshot, and geometry pass-through all work together.
 *
 * Skips with a pointer when the fixture image is absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { DiskSlotSpec, WorkerToMainMessage } from '../../src/browser/protocol.js';

const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const BOOT_SLICE_INSTRUCTIONS = 10_000_000;
const BOOT_MAX_SLICES = 8;
const STEP_INSTRUCTIONS = 2_000_000;
const STEP_MAX_SLICES = 40;
const PROMPT_RE = /login: *$|# *$|\$ *$/;

/** 16×16×63 CHS — the modal's "8 MB" preset; mkfs blocks = bytes/1024. */
const DRIVE_GEOMETRY = { cylinders: 16, heads: 16, sectorsPerTrack: 63 };
const DRIVE_BYTES = 16 * 16 * 63 * 512;
const MKFS_BLOCKS = DRIVE_BYTES / 1024; // 8064

const SENTENCE = 'persistent greetings from boot one';
const SENTENCE_SYNC = 'synced but never umounted';

/** Scan a byte image for an ASCII needle (MINIX dirents store names verbatim). */
function findAscii(haystack: Uint8Array, needle: string): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

interface Session {
  host: WorkerHost;
  posts: WorkerToMainMessage[];
  txText: () => string;
}

async function bootSession(secondary: DiskSlotSpec): Promise<Session> {
  const raw = readFileSync(HD32_PATH);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const posts: WorkerToMainMessage[] = [];
  const host = new WorkerHost({ post: (m) => posts.push(m), autoRun: false });
  host.handleMessage({ type: 'boot', config: { imageBytes: bytes, secondary } });
  await host.whenIdle();
  const txText = (): string => {
    let s = '';
    for (const m of posts) {
      if (m.type === 'tx') s += String.fromCharCode(...m.bytes);
    }
    return s;
  };

  // Boot to a prompt; log in if the image's init hands us a login:.
  let boot = '';
  for (let slice = 0; slice < BOOT_MAX_SLICES; slice++) {
    const r = host.runUntil(BOOT_SLICE_INSTRUCTIONS);
    expect(r.reason).not.toBe('error');
    boot = txText();
    if (PROMPT_RE.test(boot)) break;
  }
  expect(boot).toMatch(PROMPT_RE);
  if (/login: *$/.test(boot)) {
    host.handleMessage({
      type: 'rx',
      bytes: new Uint8Array([...'root\n'].map((c) => c.charCodeAt(0))),
    });
    const r = host.runUntil(STEP_INSTRUCTIONS * 2);
    expect(r.reason).not.toBe('error');
    expect(txText()).toMatch(/# *$/);
  }
  return { host, posts, txText };
}

/** Type one command and run until the shell prompt returns. */
function shell(s: Session, line: string): string {
  const before = s.txText().length;
  s.host.handleMessage({
    type: 'rx',
    bytes: new Uint8Array([...`${line}\n`].map((c) => c.charCodeAt(0))),
  });
  for (let slice = 0; slice < STEP_MAX_SLICES; slice++) {
    const r = s.host.runUntil(STEP_INSTRUCTIONS);
    expect(r.reason).not.toBe('error');
    const out = s.txText().slice(before);
    // The echoed command consumes the first line; a fresh prompt after
    // it means the command finished.
    if (/# *$/.test(out) && out.includes('\n')) return out;
  }
  throw new Error(`shell: no prompt after "${line}":\n${s.txText().slice(before)}`);
}

describe('Phase 15 M2 — a file written to /dev/hdb survives a reboot', () => {
  it(
    'mkfs + write + umount + snapshot, then a second boot reads it back',
    async () => {
      if (!existsSync(HD32_PATH)) {
        console.warn(
          `[skip] ${HD32_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }

      // ---- Boot 1: blank drive, format, write, umount, snapshot ----
      const one = await bootSession({
        imageBytes: new Uint8Array(0), // blank — zero-fill to geometry
        geometry: DRIVE_GEOMETRY,
      });
      const mkfsOut = shell(one, `mkfs /dev/hdb ${MKFS_BLOCKS}`);
      expect(mkfsOut).not.toMatch(/error|not found|No such/i);
      shell(one, 'mount /dev/hdb /mnt');
      shell(one, `echo ${SENTENCE} > /mnt/hello.txt`);
      const catOne = shell(one, 'cat /mnt/hello.txt');
      expect(catOne).toContain(SENTENCE);
      shell(one, 'umount /dev/hdb');

      const takeSnapshot = (s: Session): Uint8Array => {
        const before = s.posts.filter((m) => m.type === 'secondary-snapshot').length;
        s.host.handleMessage({ type: 'snapshot-secondary' });
        const snaps = s.posts.filter(
          (m): m is WorkerToMainMessage & { type: 'secondary-snapshot' } =>
            m.type === 'secondary-snapshot',
        );
        const snap = snaps[before];
        expect(snap).toBeDefined();
        expect(snap?.bytes?.length).toBe(DRIVE_BYTES);
        return snap?.bytes ?? new Uint8Array(0);
      };

      const savedAfterUmount = takeSnapshot(one);

      // ---- The brief's flush question: does `sync` alone flush
      // MINIX-fs, or only umount? Write a second file, sync (no
      // umount), snapshot, and let boot 2 report the truth. ----
      shell(one, 'mount /dev/hdb /mnt');
      shell(one, `echo ${SENTENCE_SYNC} > /mnt/second.txt`);
      shell(one, 'sync');
      const savedAfterSync = takeSnapshot(one);

      // ---- Boot 2: fresh machine, the sync-leg snapshot (a superset
      // of the umount leg — hello.txt was already on the platters) ----
      const two = await bootSession({ imageBytes: savedAfterSync, geometry: DRIVE_GEOMETRY });
      shell(two, 'mount /dev/hdb /mnt');
      const catTwo = shell(two, 'cat /mnt/hello.txt');
      expect(catTwo).toContain(SENTENCE);
      const catSync = shell(two, 'cat /mnt/second.txt');
      const syncFlushed = catSync.includes(SENTENCE_SYNC);
      console.log(
        `[virtual-drive] sync-only flush verdict: second.txt ` +
          `${syncFlushed ? 'SURVIVED — sync flushes MINIX-fs' : 'LOST — umount is required'}`,
      );
      // Pin the observed behavior (see VIRTUAL_DRIVES_REPORT.md): ELKS
      // sync flushes MINIX-fs data to the driver — recorded here so a
      // regression in either direction surfaces.
      expect(syncFlushed).toBe(true);

      // Belt-and-braces: the umount-leg snapshot alone must also carry
      // hello.txt — prove it with a directory-entry scan (cheaper than
      // a third boot; MINIX dirents store names verbatim).
      expect(findAscii(savedAfterUmount, 'hello.txt')).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
