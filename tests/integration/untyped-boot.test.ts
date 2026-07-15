/**
 * Phase 17 M3 acceptance — the un-typed boot (§4.6 Addendum A).
 *
 * Boot 1: blank 8086 KB fork + autologin user1 + autoNet. NOTHING is
 * typed: sysinit's stamped /etc/home.sh formats the blank, mounts it
 * at /home and seeds /home/root + /home/user1; inittab's stamped s0
 * line logs user1 straight in; the seeded .profile consumes .welcome
 * and emits the hello-human marker. net=ne0 must be ABSENT (the 640K
 * ktcp-vs-c86 constraint — this is the show boot).
 *
 * Boot 2 (same drive): the show stays quiet (once per drive), the
 * home survives, and net=ne0 is stamped now the show is done.
 *
 * Boot 3 (root autologin, same drive): root's home is /home/root on
 * the drive, and ELKS fsck judges the STAMPED root device clean —
 * the oracle passing judgment on the host's minix-fs surgery.
 *
 * Skips without reference/elks-images-hd/hd32-minix.img.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';
import { HELLO_HUMAN_MARKER } from '../../src/browser/image-stamps.js';
import { openMinixImage } from '../../src/disk/minix-fs.js';
import { HD32_PATH, DRIVE_8086_GEOMETRY } from './guest-drive-harness.js';

const itif = existsSync(HD32_PATH) ? it : it.skip;

const BOOT_SLICE = 10_000_000;
const BOOT_MAX_SLICES = 8;
const STEP = 2_000_000;
const STEP_MAX_SLICES = 40;

interface Session {
  host: WorkerHost;
  posts: WorkerToMainMessage[];
  txText: () => string;
}

/** Boot with the M3 stamps; run until `promptRe` shows. NO typing. */
async function bootUntyped(
  secondaryBytes: Uint8Array,
  autologin: 'root' | 'user1',
  promptRe: RegExp,
): Promise<Session> {
  const raw = readFileSync(HD32_PATH);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const posts: WorkerToMainMessage[] = [];
  const host = new WorkerHost({ post: (m) => posts.push(m), autoRun: false });
  host.handleMessage({
    type: 'boot',
    config: {
      imageBytes: bytes,
      secondary: { imageBytes: secondaryBytes, geometry: DRIVE_8086_GEOMETRY },
      autologin,
      autoNet: true,
    },
  });
  await host.whenIdle();
  const txText = (): string => {
    let s = '';
    for (const m of posts) {
      if (m.type === 'tx') s += String.fromCharCode(...m.bytes);
    }
    return s;
  };
  for (let slice = 0; slice < BOOT_MAX_SLICES; slice++) {
    const r = host.runUntil(BOOT_SLICE);
    if (r.reason === 'error') throw new Error(`boot error: ${JSON.stringify(r)}`);
    if (promptRe.test(txText())) break;
  }
  if (!promptRe.test(txText())) {
    throw new Error(`no ${String(promptRe)} prompt, NOTHING was typed:\n${txText().slice(-600)}`);
  }
  return { host, posts, txText };
}

/** Type one command, wait for `promptRe`, return its output. */
function shell(s: Session, line: string, promptRe: RegExp): string {
  const before = s.txText().length;
  s.host.handleMessage({
    type: 'rx',
    bytes: new Uint8Array([...`${line}\n`].map((c) => c.charCodeAt(0))),
  });
  for (let slice = 0; slice < STEP_MAX_SLICES; slice++) {
    const r = s.host.runUntil(STEP);
    if (r.reason === 'error') throw new Error(`error during "${line}"`);
    const out = s.txText().slice(before);
    if (promptRe.test(out) && out.includes('\n')) return out;
  }
  throw new Error(`shell: no prompt after "${line}":\n${s.txText().slice(before)}`);
}

function snapshotSecondary(s: Session): Uint8Array {
  const before = s.posts.filter((m) => m.type === 'secondary-snapshot').length;
  s.host.handleMessage({ type: 'snapshot-secondary' });
  const snaps = s.posts.filter(
    (m): m is WorkerToMainMessage & { type: 'secondary-snapshot' } =>
      m.type === 'secondary-snapshot',
  );
  const snap = snaps[before];
  if (snap?.bytes == null) throw new Error('no secondary snapshot bytes');
  return snap.bytes;
}

const USER_PROMPT = /\$ *$/;
const ROOT_PROMPT = /# *$/;

describe('the un-typed boot (Phase 17 M3)', () => {
  itif(
    'blank fork → formatted home + autologin + show once; then quiet + net; fsck clean',
    async () => {
      // ---- Boot 1: virgin drive, user1, the show boot ----
      const blank = new Uint8Array(
        DRIVE_8086_GEOMETRY.cylinders *
          DRIVE_8086_GEOMETRY.heads *
          DRIVE_8086_GEOMETRY.sectorsPerTrack *
          512,
      );
      const s1 = await bootUntyped(blank, 'user1', USER_PROMPT);
      const boot1 = s1.txText();
      expect(boot1).not.toContain('login:');
      expect(boot1).not.toContain('Password');
      expect(boot1).toContain(HELLO_HUMAN_MARKER); // .profile fired the show

      expect(shell(s1, 'echo HOME=$HOME USER=$USER', USER_PROMPT))
        .toContain('HOME=/home/user1 USER=user1');
      // user1 can CREATE files in its own home — the assertion the
      // field taught us to make (unlink succeeding proved nothing:
      // a root-owned dir still let .welcome go, but creates fail).
      expect(shell(s1, 'echo probe-1 > $HOME/w1 && cat $HOME/w1', USER_PROMPT))
        .toContain('probe-1');
      // home.sh made passwd setuid (field: user1 couldn't set its own
      // password). 'rws' in the owner triad is the guest-visible proof.
      expect(shell(s1, 'ls -l /bin/passwd', USER_PROMPT)).toContain('rws');
      // Setuid login IS su (field: nested login died on fchown/setgid
      // twice). Passwordless root → straight in; exit returns to user1.
      expect(shell(s1, 'login root', ROOT_PROMPT)).toContain('#');
      expect(shell(s1, 'echo NESTED=$USER', ROOT_PROMPT)).toContain('NESTED=root');
      shell(s1, 'exit', USER_PROMPT);
      // The show boot must NOT have net staged (640K vs the compile).
      // Behavioral probe: rc.sys's `net start` announces itself at
      // sysinit. (`cat /bootopts` CANNOT see the stamp: the patch is
      // a raw 1024-byte block write the kernel reads whole, but the
      // inode still says 692 bytes, so the fs truncates at the
      // pristine prefix — pre-existing since Phase 14, recorded in
      // the M3 report.)
      expect(boot1).not.toContain('Starting networking');

      shell(s1, 'sync', USER_PROMPT);
      const drive1 = snapshotSecondary(s1);
      const fs1 = openMinixImage(drive1);
      if (!fs1.ok) throw new Error('fork did not get formatted');
      expect(fs1.fs.readFile('/user1/.profile').ok).toBe(true);
      expect(fs1.fs.readFile('/user1/hello.sh').ok).toBe(true);
      expect(fs1.fs.readFile('/user1/.welcome').ok).toBe(false); // consumed
      expect(fs1.fs.list('/root').ok).toBe(true);

      // ---- Boot 2: same drive — quiet show, net up, home persists ----
      const s2 = await bootUntyped(drive1, 'user1', USER_PROMPT);
      expect(s2.txText()).not.toContain(HELLO_HUMAN_MARKER); // once per drive
      // Show consumed → net=ne0 stamped → rc.sys brought the NIC up.
      expect(s2.txText()).toContain('Starting networking');
      expect(shell(s2, 'test -f /home/user1/hello.sh && echo HOME-OK', USER_PROMPT))
        .toContain('HOME-OK');
      // Still writable after the round trip (per-boot chown healing).
      expect(shell(s2, 'echo probe-2 > $HOME/w2 && cat $HOME/w2', USER_PROMPT))
        .toContain('probe-2');
      // The panel's remount dance, as user1, via the stamped /bin/resync
      // (field: umount was root-gated AND $HOME-busy — setuid
      // mount/umount plus the cd-off-the-fs step make it work). First
      // the honest busy case from inside $HOME, then the real thing.
      expect(shell(s2, 'resync', USER_PROMPT)).toContain('busy');
      expect(shell(s2, 'cd /; resync && cd && echo REMOUNT-OK', USER_PROMPT))
        .toContain('REMOUNT-OK');
      // The quietly-stamped /bin/ping is present and executable — its
      // usage line proves a runnable a.out. (A LIVE ping still needs
      // ping.c's historical net-stop dance: it opens /dev/ne0 raw and
      // contends with ktcp — its own diagnostic says so. Field flow,
      // unchanged; not this test's fight.)
      const pong = shell(s2, 'ping', USER_PROMPT);
      expect(pong).not.toContain('not found');
      expect(pong).toContain('[count]');
      shell(s2, 'sync', USER_PROMPT);
      const drive2 = snapshotSecondary(s2);

      // ---- Boot 3: root autologin — home on the drive, fsck verdict ----
      const s3 = await bootUntyped(drive2, 'root', ROOT_PROMPT);
      expect(s3.txText()).not.toContain('login:');
      expect(shell(s3, 'echo HOME=$HOME', ROOT_PROMPT)).toContain('HOME=/home/root');
      // The oracle: ELKS fsck on the STAMPED root device. Silent = the
      // host's passwd/inittab/skel/home.sh surgery kept the fs coherent.
      expect(shell(s3, 'sync; fsck /dev/hda && echo FSCK-OK', ROOT_PROMPT))
        .toContain('FSCK-OK');
    },
    600_000,
  );
});
