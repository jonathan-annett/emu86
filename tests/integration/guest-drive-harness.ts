/**
 * Boot-a-guest-with-a-drive harness (Phase 16 M2).
 *
 * The boot/shell/snapshot machinery from
 * virtual-drive-persistence.test.ts (Phase 15 M2), extracted on its
 * THIRD copy — the fixture generator (minix-fixture-gen.test.ts) and
 * the write-path oracle (minix-write-guest.test.ts) both need it. The
 * persistence test keeps its own original copy on purpose: it is the
 * field-proven Phase 15 acceptance and gets edited for its own
 * reasons only.
 *
 * Everything here drives WorkerHost exactly the way the browser main
 * thread does — boot message, rx keystrokes, snapshot-secondary — so
 * what these tests prove is the same path the Save button and the M3
 * editor plumbing use.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type {
  BootConfig,
  DiskSlotSpec,
  WorkerToMainMessage,
} from '../../src/browser/protocol.js';

export const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

/** Canonical 8086 KB preset (311×4×13) — brief §2's test geometry. */
export const DRIVE_8086_GEOMETRY = { cylinders: 311, heads: 4, sectorsPerTrack: 13 };
export const DRIVE_8086_BYTES = 311 * 4 * 13 * 512;

const BOOT_SLICE_INSTRUCTIONS = 10_000_000;
const BOOT_MAX_SLICES = 8;
const STEP_INSTRUCTIONS = 2_000_000;
const STEP_MAX_SLICES = 40;
const PROMPT_RE = /login: *$|# *$|\$ *$/;

export interface GuestSession {
  host: WorkerHost;
  posts: WorkerToMainMessage[];
  txText: () => string;
}

/**
 * Boot hd32-minix.img with `secondary` attached; log in as root.
 * `opts.overlay` (Phase 17 M2) rides the boot config so the two-boot
 * overlay acceptance drives the exact fold path the browser uses.
 */
export async function bootGuest(
  secondary: DiskSlotSpec,
  opts: { overlay?: BootConfig['overlay'] } = {},
): Promise<GuestSession> {
  const raw = readFileSync(HD32_PATH);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const posts: WorkerToMainMessage[] = [];
  const host = new WorkerHost({ post: (m) => posts.push(m), autoRun: false });
  host.handleMessage({
    type: 'boot',
    config: {
      imageBytes: bytes,
      secondary,
      ...(opts.overlay !== undefined ? { overlay: opts.overlay } : {}),
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

  let boot = '';
  for (let slice = 0; slice < BOOT_MAX_SLICES; slice++) {
    const r = host.runUntil(BOOT_SLICE_INSTRUCTIONS);
    if (r.reason === 'error') throw new Error(`boot error: ${JSON.stringify(r)}`);
    boot = txText();
    if (PROMPT_RE.test(boot)) break;
  }
  if (!PROMPT_RE.test(boot)) throw new Error(`no prompt after boot:\n${boot.slice(-500)}`);
  if (/login: *$/.test(boot)) {
    host.handleMessage({
      type: 'rx',
      bytes: new Uint8Array([...'root\n'].map((c) => c.charCodeAt(0))),
    });
    const r = host.runUntil(STEP_INSTRUCTIONS * 2);
    if (r.reason === 'error') throw new Error('error during login');
    if (!/# *$/.test(txText())) throw new Error(`no root prompt:\n${txText().slice(-300)}`);
  }
  return { host, posts, txText };
}

/** Type one command; run until the shell prompt returns; return its output. */
export function guestShell(s: GuestSession, line: string, maxSlices = STEP_MAX_SLICES): string {
  const before = s.txText().length;
  s.host.handleMessage({
    type: 'rx',
    bytes: new Uint8Array([...`${line}\n`].map((c) => c.charCodeAt(0))),
  });
  for (let slice = 0; slice < maxSlices; slice++) {
    const r = s.host.runUntil(STEP_INSTRUCTIONS);
    if (r.reason === 'error') throw new Error(`error during "${line}"`);
    const out = s.txText().slice(before);
    if (/# *$/.test(out) && out.includes('\n')) return out;
  }
  throw new Error(`guestShell: no prompt after "${line}":\n${s.txText().slice(before)}`);
}

/** Take a secondary snapshot — the Save button's exact message. */
export function takeSecondarySnapshot(s: GuestSession): Uint8Array {
  const before = s.posts.filter((m) => m.type === 'secondary-snapshot').length;
  s.host.handleMessage({ type: 'snapshot-secondary' });
  const snaps = s.posts.filter(
    (m): m is WorkerToMainMessage & { type: 'secondary-snapshot' } =>
      m.type === 'secondary-snapshot',
  );
  const snap = snaps[before];
  if (snap?.bytes == null) throw new Error('snapshot-secondary returned no bytes');
  return snap.bytes;
}
