/**
 * Phase 17 M3 — the load-time stamp set (brief §1.4 + Addendum B).
 *
 * Applied by the worker to the PRIMARY image bytes after the overlay
 * fold and the bootopts patch, before the machine is constructed —
 * per-boot and ephemeral by construction (pre-wrapper, so stamps
 * never enter the overlay hot map). Config, not state.
 *
 * The set (each independent; failure = skip with a note, never a
 * boot gate — stamps are conveniences):
 *
 *   - **passwd**: field-surgical home moves — root → /home/root,
 *     user1 → /home/user1 — so both accounts live on the tab's
 *     drive fork once /etc/home.sh mounts it at /home. Only the
 *     home field changes; hashes the guest set with `passwd` stay
 *     (and the overlay makes them durable). `toor` (the sash rescue
 *     account) deliberately keeps /root.
 *   - **inittab**: the ttyS0 line is OURS-per-boot, like the
 *     bootopts block: autologin 'user1'/'root' swaps the getty for
 *     `exec /bin/login <user>` (login's passwordless fast path
 *     prompts for NOTHING and execs a dash-argv[0] login shell —
 *     login.c:150, ash/main.c:160); 'off' restores the stock getty
 *     line. init's parser splits on ':' — commands must stay
 *     colon-free.
 *   - **skel.profile + skel.hello** (under /etc): per-boot seeds
 *     that /etc/home.sh copies into a fresh drive's /home/user1. The
 *     .profile's first-run block consumes $HOME/.welcome and emits
 *     {@link HELLO_HUMAN_MARKER}; the main thread renders the show
 *     through the typing relay (key-click off — Jonathan's call).
 *   - **home.sh** (under /etc): per-boot, regenerated with the CURRENT
 *     secondary's block count baked into its mkfs line (D5 made
 *     ?mkdrive the resize path, so a stale size would be
 *     mainstream, not an edge). Mount-or-mkfs + populate-once.
 *   - **mount.cfg**: the ONLY marker-guarded stamp — one size-free
 *     line calling /etc/home.sh. Convergence per brief §1.4: if the
 *     guest ever edits mount.cfg, the marker survives or the guest
 *     deleted it on purpose — guest edits win thereafter.
 *
 * `net=ne0` is NOT stamped here — it rides the existing bootopts
 * patch's extraLines at the worker-host call site, gated on autoNet
 * AND the show not being pending (the recorded 640K constraint:
 * ktcp+telnetd+ftpd are the difference between c86 compiling and
 * not — and the show compiles).
 */

import { openMinixImage } from '../disk/minix-fs.js';
import { pingBinaryBytes } from './ping-binary.js';

/** The line skel.profile emits exactly once per drive — main.ts
 *  watches the TX stream for it and starts the show relay. */
export const HELLO_HUMAN_MARKER = '[[emu86:hello-human]]';

/** Stock ttyS0 getty line — what autologin 'off' restores. */
export const STOCK_S0_LINE = 's0:2346:respawn:/bin/getty /dev/ttyS0';

export type AutologinMode = 'off' | 'root' | 'user1';

export interface ImageStampOptions {
  autologin: AutologinMode;
  /**
   * Secondary drive size in 1 KB MINIX blocks, for /etc/home.sh's
   * mkfs line. Null = no secondary this boot (home.sh still mounts
   * opportunistically but cannot format).
   */
  secondaryBlocks: number | null;
}

export interface ImageStampResult {
  applied: string[];
  /** Stamp name + reason for anything that could not apply. */
  skipped: string[];
}

/** The hello-world-compile ceremony (HELLO_WORLD_COMPILE_REPORT §3
 *  recipe, toolchain in-image) as a re-runnable script — seeded to
 *  /home/user1/hello.sh, and the same commands the show relay types. */
export const HELLO_SH = `# hello.sh -- the first-boot show, yours to re-run or remix
cat > hello.c << 'EOF'
#include <stdio.h>

int main(void)
{
    printf("hello, human\\n");
    return 0;
}
EOF
cpp -0 -I/usr/include -I/usr/include/c86 hello.c -o hello.i
c86 -g -O -bas86 -separate=yes -warn=4 -lang=c99 -align=yes -stackopt=minimum -peep=all -stackcheck=no hello.i hello.as
as -0 -j hello.as -o hello.o
ld -0 -i -L/usr/lib -o hello hello.o -lc86
./hello
`;

/** /bin/resync (per-boot stamp, Jonathan's ask): the panel-coherence
 *  remount as one word. It cannot free the CALLER's cwd (any process
 *  sitting on /home keeps the fs busy), so on EBUSY it teaches the
 *  incantation instead of failing cryptically. */
export const RESYNC_SH = `# /bin/resync -- remount the home drive to pick up host-side edits
cd /
if umount /home 2>/dev/null; then
\tmount /dev/hdb /home && echo "resync: /home remounted"
else
\techo "resync: /home is busy (your shell is probably sitting in it)"
\techo "run:  cd /; resync; cd"
\texit 1
fi
`;

export const SKEL_PROFILE = `# seeded by emu86 to your home drive -- edit freely, it's yours
if test -f $HOME/.welcome; then
\trm -f $HOME/.welcome
\tsync
\techo '${HELLO_HUMAN_MARKER}'
fi
`;
// ^ the sync between rm and the marker is load-bearing: without it
// the deletion can sit in the guest buffer cache where the fork
// auto-persist snapshot can't see it, and a quick refresh replays
// the show (field, Jonathan). By marker time the deletion is
// on-disk, and main force-persists the fork the moment it sees the
// marker — the two ends of the same seam.

/** Build /etc/home.sh for this boot. Exported for tests. */
export function homeShText(secondaryBlocks: number | null): string {
  const mountLine = secondaryBlocks !== null
    ? `mount /dev/hdb /home 2>/dev/null || { mkfs /dev/hdb ${secondaryBlocks} && mount /dev/hdb /home; } || exit 0`
    : 'mount /dev/hdb /home 2>/dev/null || exit 0';
  return `# /etc/home.sh -- emu86 per-boot stamp; regenerated every boot, edits do not survive
# Mounts the tab's home drive (formatting a fresh blank on first use)
# and seeds /home/root + /home/user1 once per drive. Ownership of the
# seeded artifacts re-asserts EVERY boot: a field drive escaped with
# root-owned homes once (user1 couldn't create files in its own
# $HOME) -- ownership is config, not state, so heal it, don't
# archaeology it. User-created files are never touched.
# passwd was always MEANT to be setuid (passwd.c line 7's own todo;
# the binary already restricts non-root to its own password), and
# setuid login is ELKS's su -- there is no other path to root from a
# user1 autologin session, and non-setuid nested login dies on
# fchown/setgid (and SysV chown-giveaway leaves tty debris). mount +
# umount join them (field: user1 couldn't do the panel's remount
# dance — the kernel's suser gate reads euid, and neither binary
# second-guesses in userland). /dev/null world-writable is plain
# unix correctness (a 644 null broke net stop's redirect for user1);
# ping is stamped fresh each boot and needs its execute bit. Before
# the mount line so all of this applies no matter what state the
# drive is in.
chmod 4755 /bin/passwd /bin/login /bin/mount /bin/umount
chmod 666 /dev/null /dev/ne0
chmod 755 /bin/ping /bin/resync
${mountLine}
test -d /home/user1 || {
\tmkdir /home/root
\tmkdir /home/user1
\tcp /etc/skel.profile /home/user1/.profile
\tcp /etc/skel.hello /home/user1/hello.sh
\ttouch /home/user1/.welcome
}
chown user1 /home/user1 /home/user1/.profile /home/user1/hello.sh 2>/dev/null
chown user1 /home/user1/.welcome 2>/dev/null
sync
`;
}

const MOUNT_CFG_MARKER = '# emu86: home drive';
const MOUNT_CFG_BLOCK = `${MOUNT_CFG_MARKER}\ntest -f /etc/home.sh && sh /etc/home.sh\n`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Apply the M3 stamp set to `bytes` in place (minix-fs writes mutate
 * the buffer). Never throws for per-stamp failures — the result
 * carries what applied and what was skipped, and the worker logs the
 * skips. Throws only on programmer errors (bad options).
 */
export function applyImageStamps(
  bytes: Uint8Array,
  opts: ImageStampOptions,
): ImageStampResult {
  const applied: string[] = [];
  const skipped: string[] = [];

  const open = openMinixImage(bytes);
  if (!open.ok) {
    return { applied, skipped: [`all: image is not MINIX (${open.kind})`] };
  }
  const fs = open.fs;

  // ---- passwd: home-field surgery ----
  const passwd = fs.readFile('/etc/passwd');
  if (!passwd.ok) {
    skipped.push(`passwd: ${passwd.kind}`);
  } else {
    const lines = decoder.decode(passwd.value).split('\n');
    let changed = false;
    const next = lines.map((line) => {
      const f = line.split(':');
      if (f.length < 7) return line;
      if (f[0] === 'root' && f[5] !== '/home/root') {
        f[5] = '/home/root';
        changed = true;
        return f.join(':');
      }
      if (f[0] === 'user1' && f[5] !== '/home/user1') {
        f[5] = '/home/user1';
        changed = true;
        return f.join(':');
      }
      return line;
    });
    if (changed) {
      const w = fs.writeFile('/etc/passwd', encoder.encode(next.join('\n')));
      if (w.ok) applied.push('passwd');
      else skipped.push(`passwd: write ${w.kind}`);
    } else {
      applied.push('passwd (already)');
    }
  }

  // ---- inittab: the ttyS0 line is ours-per-boot ----
  const s0Line =
    opts.autologin === 'off'
      ? STOCK_S0_LINE
      : `s0:2346:respawn:exec /bin/login ${opts.autologin}`;
  const inittab = fs.readFile('/etc/inittab');
  if (!inittab.ok) {
    skipped.push(`inittab: ${inittab.kind}`);
  } else {
    const lines = decoder.decode(inittab.value).split('\n');
    const at = lines.findIndex((l) => l.startsWith('s0:'));
    if (at === -1) {
      skipped.push('inittab: no s0: line (guest-owned shape, left alone)');
    } else if (lines[at] === s0Line) {
      applied.push('inittab (already)');
    } else {
      lines[at] = s0Line;
      const w = fs.writeFile('/etc/inittab', encoder.encode(lines.join('\n')));
      if (w.ok) applied.push(`inittab (${opts.autologin})`);
      else skipped.push(`inittab: write ${w.kind}`);
    }
  }

  // ---- per-boot seeds: skel.profile, skel.hello, home.sh ----
  for (const [name, path, text] of [
    ['skel.profile', '/etc/skel.profile', SKEL_PROFILE],
    ['skel.hello', '/etc/skel.hello', HELLO_SH],
    ['home.sh', '/etc/home.sh', homeShText(opts.secondaryBlocks)],
    ['resync', '/bin/resync', RESYNC_SH],
  ] as const) {
    const w = fs.writeFile(path, encoder.encode(text));
    if (w.ok) applied.push(name);
    else skipped.push(`${name}: write ${w.kind}`);
  }

  // ---- /bin/ping: the quietly-present executable (M4, Jonathan:
  // "just quietly add the executable to the overlay"). Compiled once
  // IN-VM by our own generator (see ping-binary.ts provenance),
  // stamped per-boot like everything ours; home.sh restores its
  // execute bit. Present even after factory reset — part of the
  // machine, like the serial console.
  const ping = fs.writeFile('/bin/ping', pingBinaryBytes());
  if (ping.ok) applied.push('ping');
  else skipped.push(`ping: write ${ping.kind}`);

  // ---- mount.cfg: marker-guarded append (guest edits win) ----
  const mountCfg = fs.readFile('/etc/mount.cfg');
  if (!mountCfg.ok) {
    skipped.push(`mount.cfg: ${mountCfg.kind}`);
  } else {
    const text = decoder.decode(mountCfg.value);
    if (text.includes(MOUNT_CFG_MARKER)) {
      applied.push('mount.cfg (marker present)');
    } else {
      const joined = text.endsWith('\n')
        ? text + MOUNT_CFG_BLOCK
        : text + '\n' + MOUNT_CFG_BLOCK;
      const w = fs.writeFile('/etc/mount.cfg', encoder.encode(joined));
      if (w.ok) applied.push('mount.cfg');
      else skipped.push(`mount.cfg: write ${w.kind}`);
    }
  }

  return { applied, skipped };
}

/**
 * Does this secondary need the first-boot show — i.e. will mounting
 * it at /home fire the hello-human? True when the drive is
 * unformatted (populate will seed it this boot), has no /home/user1
 * yet (ditto), or still carries .welcome. Only a formatted drive
 * whose .welcome is consumed returns false. The worker suppresses
 * `net=ne0` while this is true: ktcp+telnetd+ftpd are the recorded
 * difference between c86 compiling and not, and the show compiles.
 *
 * Note the path is relative to the DRIVE's own root (it mounts AT
 * /home): the seeded layout lives at /user1 on the fork.
 */
export function showPending(secondaryBytes: Uint8Array | null): boolean {
  if (secondaryBytes === null) return false; // no drive → no show
  const open = openMinixImage(secondaryBytes);
  if (!open.ok) return true; // unformatted blank → populate + show this boot
  const user1 = open.fs.list('/user1');
  if (!user1.ok) return true; // never populated → populate + show this boot
  return open.fs.readFile('/user1/.welcome').ok; // .welcome still there?
}
