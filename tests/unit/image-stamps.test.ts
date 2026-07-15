/**
 * image-stamps — the Phase 17 M3 load-time stamp set.
 *
 * Surgery tests run against a COPY of the real committed
 * hd32-minix.img (the stamps' actual target; skip-if-absent per the
 * SST/vdp precedent). showPending runs against the 2 MB minix
 * fixture. Byte comparisons are plain loops where they matter — no
 * toEqual on MB arrays (the law).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HELLO_HUMAN_MARKER,
  HELLO_SH,
  SKEL_PROFILE,
  STOCK_S0_LINE,
  applyImageStamps,
  homeShText,
  showPending,
} from '../../src/browser/image-stamps.js';
import { openMinixImage } from '../../src/disk/minix-fs.js';

const HD32 = resolve('reference/elks-images-hd', 'hd32-minix.img');
const FIXTURE = resolve('tests/fixtures', 'minix-v1-2048.img');
const itHd = existsSync(HD32) ? it : it.skip;
const itFx = existsSync(FIXTURE) ? it : it.skip;

const dec = new TextDecoder();
const enc = new TextEncoder();

function hd32Copy(): Uint8Array {
  return new Uint8Array(readFileSync(HD32));
}

function readText(bytes: Uint8Array, path: string): string {
  const open = openMinixImage(bytes);
  if (!open.ok) throw new Error('not minix');
  const r = open.fs.readFile(path);
  if (!r.ok) throw new Error(`${path}: ${r.kind}`);
  return dec.decode(r.value);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('applyImageStamps on the real image', () => {
  itHd('passwd surgery moves root and user1 homes, nothing else', () => {
    const bytes = hd32Copy();
    const before = readText(bytes, '/etc/passwd');
    const result = applyImageStamps(bytes, { autologin: 'user1', secondaryBlocks: 8086 });
    expect(result.applied).toContain('passwd');

    const after = readText(bytes, '/etc/passwd');
    const lines = after.split('\n');
    expect(lines.find((l) => l.startsWith('root:'))).toBe('root::0:0:Admin:/home/root:/bin/sh');
    expect(lines.find((l) => l.startsWith('user1:'))).toBe('user1::101:101:User 1:/home/user1:/bin/sh');
    // The rescue account keeps /root; everything else is untouched.
    expect(lines.find((l) => l.startsWith('toor:'))).toBe('toor::0:0:Admin:/root:/bin/sash');
    expect(after.split('\n').length).toBe(before.split('\n').length);
  });

  itHd('inittab: user1/root swap the s0 line; off restores stock', () => {
    const bytes = hd32Copy();
    applyImageStamps(bytes, { autologin: 'user1', secondaryBlocks: null });
    let tab = readText(bytes, '/etc/inittab');
    expect(tab).toContain('s0:2346:respawn:exec /bin/login user1');
    expect(tab).not.toContain(STOCK_S0_LINE);
    expect(tab).toContain('t1:1356:respawn:/bin/getty /dev/tty1'); // neighbours untouched

    applyImageStamps(bytes, { autologin: 'root', secondaryBlocks: null });
    tab = readText(bytes, '/etc/inittab');
    expect(tab).toContain('s0:2346:respawn:exec /bin/login root');

    applyImageStamps(bytes, { autologin: 'off', secondaryBlocks: null });
    tab = readText(bytes, '/etc/inittab');
    expect(tab).toContain(STOCK_S0_LINE);
    expect(tab).not.toContain('/bin/login');
  });

  itHd('seeds and home.sh are written; mount.cfg gains the marker ONCE', () => {
    const bytes = hd32Copy();
    const r1 = applyImageStamps(bytes, { autologin: 'user1', secondaryBlocks: 8086 });
    expect(r1.skipped).toEqual([]);
    expect(readText(bytes, '/etc/skel.profile')).toBe(SKEL_PROFILE);
    expect(readText(bytes, '/etc/skel.hello')).toBe(HELLO_SH);
    const home = readText(bytes, '/etc/home.sh');
    expect(home).toContain('mkfs /dev/hdb 8086');
    expect(home).toContain('cp /etc/skel.profile /home/user1/.profile');
    // user1 can set its own password; setuid login is ELKS's su.
    expect(home).toContain('chmod 4755 /bin/passwd /bin/login');
    const cfg = readText(bytes, '/etc/mount.cfg');
    expect(cfg).toContain('test -f /etc/home.sh && sh /etc/home.sh');

    // Second boot, different drive size: home.sh refreshes (per-boot,
    // ours), mount.cfg does NOT gain a second marker (guest-owned).
    const r2 = applyImageStamps(bytes, { autologin: 'user1', secondaryBlocks: 39936 });
    expect(r2.applied).toContain('mount.cfg (marker present)');
    expect(readText(bytes, '/etc/home.sh')).toContain('mkfs /dev/hdb 39936');
    const cfg2 = readText(bytes, '/etc/mount.cfg');
    expect(cfg2.split('# emu86: home drive').length).toBe(2); // exactly one marker
  });

  itHd('stamping is idempotent at the byte level', () => {
    const bytes = hd32Copy();
    applyImageStamps(bytes, { autologin: 'user1', secondaryBlocks: 8086 });
    const once = new Uint8Array(bytes);
    const r = applyImageStamps(bytes, { autologin: 'user1', secondaryBlocks: 8086 });
    expect(r.applied).toContain('passwd (already)');
    expect(r.applied).toContain('inittab (already)');
    expect(sameBytes(bytes, once)).toBe(true);
  });

  it('a non-MINIX image skips everything and never throws', () => {
    const bytes = new Uint8Array(64 * 1024).fill(0xf4);
    const r = applyImageStamps(bytes, { autologin: 'user1', secondaryBlocks: null });
    expect(r.applied).toEqual([]);
    expect(r.skipped.join(' ')).toContain('not MINIX');
  });

  it('homeShText without a secondary mounts opportunistically, no mkfs', () => {
    const text = homeShText(null);
    expect(text).not.toContain('mkfs');
    expect(text).toContain('mount /dev/hdb /home');
    // The setuid-passwd line rides BOTH variants, ahead of the mount.
    expect(text.indexOf('chmod 4755 /bin/passwd')).toBeLessThan(text.indexOf('mount /dev/hdb'));
  });

  it('the skel profile emits the marker exactly once, guarded by .welcome', () => {
    expect(SKEL_PROFILE).toContain(HELLO_HUMAN_MARKER);
    expect(SKEL_PROFILE).toContain('test -f $HOME/.welcome');
    expect(SKEL_PROFILE).toContain('rm -f $HOME/.welcome');
    // rm → sync → marker, in that order: by marker time the deletion
    // is on the virtual disk, so main's forced persist pins it and a
    // quick refresh cannot replay the show (field, 2026-07-15).
    const rm = SKEL_PROFILE.indexOf('rm -f $HOME/.welcome');
    const sync = SKEL_PROFILE.indexOf('sync');
    const marker = SKEL_PROFILE.indexOf(HELLO_HUMAN_MARKER);
    expect(rm).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(rm);
    expect(marker).toBeGreaterThan(sync);
  });
});

describe('showPending', () => {
  it('no drive → no show; unformatted blank → show', () => {
    expect(showPending(null)).toBe(false);
    expect(showPending(new Uint8Array(8086 * 1024))).toBe(true); // all-zero blank
  });

  itFx('formatted but never populated → show; .welcome consumed → quiet', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    expect(showPending(bytes)).toBe(true); // fixture has no /user1

    const open = openMinixImage(bytes);
    if (!open.ok) throw new Error('fixture not minix');
    // /user1 present without .welcome = the show already ran → quiet.
    expect(open.fs.mkdir('/user1').ok).toBe(true);
    expect(showPending(bytes)).toBe(false);

    expect(open.fs.writeFile('/user1/.welcome', enc.encode('')).ok).toBe(true);
    expect(showPending(bytes)).toBe(true); // .welcome present is definitive

    expect(open.fs.remove('/user1/.welcome').ok).toBe(true);
    expect(showPending(bytes)).toBe(false); // consumed → the drive has had its day
  });
});
