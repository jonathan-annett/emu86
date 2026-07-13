/**
 * In-memory /bootopts serial-console patch (Phase 14 M2).
 *
 * The browser harness's terminal speaks UART — there is no CGA renderer.
 * ELKS HD images ship with the default (CGA) console, so booting one in
 * the browser gives a machine you can't see or type at. This module
 * rewrites the image's 1024-byte `/bootopts` block in memory to add
 * `console=ttyS0,9600`, the same edit `tools/elks-build/
 * build-serial-image.ts` makes to the committed serial floppies and the
 * probe-harness surveys make before HD boots.
 *
 * Differences from those precedents, both deliberate:
 *
 *   - **Existing options are preserved, not replaced.** The stock
 *     `hd32-minix.img` block carries `hma=kernel` plus a library of
 *     commented-out examples (`#ne0=12,0x300,,0x80`, ...). An interactive
 *     user keeps all of that; we only drop active `console=` lines (to
 *     avoid two console claims) and append ours.
 *   - **`init=` is NOT overridden.** Test bootopts force `init=/bin/sh`
 *     for deterministic prompts; a browser session should get the
 *     image's real init (getty/login on the serial console).
 *
 * MINIX keeps `/bootopts` at a fixed inode block-list, so an in-place
 * overwrite of the block keeps the filesystem coherent (same argument as
 * the Phase 10.2 boot test). The patch never touches the stored library
 * copy — `WorkerHost` applies it to the boot-time byte copy only.
 *
 * Browser-safe: no Buffer, no node imports — plain Uint8Array scanning.
 */

/** Marker line that opens every ELKS image's /bootopts block. */
export const BOOTOPTS_MARKER = '## /bootopts';

/** Fixed size of the /bootopts region in ELKS images. */
export const BOOTOPTS_SIZE = 1024;

/** The console option the patch appends. */
export const SERIAL_CONSOLE_LINE = 'console=ttyS0,9600';

/**
 * Runlevel word the patch appends. `console=` only redirects the KERNEL
 * console; getty targets come from /etc/inittab, whose stock
 * `initdefault` is runlevel 1 — "single user tty1 only" — so a login
 * prompt would sit on the invisible CGA console forever (observed on
 * the stock hd32-minix.img: boot completes rc.sys, then silence on
 * serial). Bare words in /bootopts become init argv
 * (`elks/init/main.c:677`), and a leading digit argv overrides the
 * inittab default (`elkscmd/sys_utils/init.c:589`). Runlevel 3 =
 * "multiuser tty1 and ttyS0": getty on serial, plus a harmless one on
 * the unseen CGA.
 */
export const SERIAL_RUNLEVEL_LINE = '3';

/**
 * NIC configuration the patch appends (Phase 14 M3b). The kernel's
 * default ne0 probe expects IRQ 12 — unreachable behind emu86's single
 * master PIC — while the emulated NE2000 sits at 0x300/IRQ 5. With
 * this line, `net start ne0` in the browser xterm just works against
 * the worker's LAN (switch + gateway at 10.0.2.2).
 */
export const NE0_BOOTOPTS_LINE = 'ne0=5,0x300,,0x80';

/**
 * Nameserver the patch appends (Phase 14 M3c). ELKS's resolver
 * (`libc/net/in_resolv.c`) defaults to OpenDNS 208.67.222.222 —
 * unreachable until M3d's off-subnet TCP exists — overridden by the
 * `DNSIP` env var. Bare `key=value` bootopts words become init's
 * environment and reach login shells (the TAN's LOCALIP precedent),
 * so `nslookup example.com` and telnet-by-hostname hit the worker's
 * DNS pseudo-host at 10.0.2.3 with no explicit server argument.
 */
export const DNSIP_BOOTOPTS_LINE = 'DNSIP=10.0.2.3';

/**
 * Locate the /bootopts block. Returns the byte offset of the marker, or
 * null when the image has no marker (non-ELKS images, or a marker so
 * close to the end that a full 1024-byte block can't follow — treated
 * as absent rather than corrupt).
 */
export function findBootopts(image: Uint8Array): number | null {
  const marker = BOOTOPTS_MARKER;
  const first = marker.charCodeAt(0);
  const limit = image.length - marker.length;
  for (let i = 0; i <= limit; i++) {
    if (image[i] !== first) continue;
    let match = true;
    for (let j = 1; j < marker.length; j++) {
      if (image[i + j] !== marker.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) {
      return i + BOOTOPTS_SIZE <= image.length ? i : null;
    }
  }
  return null;
}

/**
 * True when the image's /bootopts block already carries an ACTIVE
 * (uncommented) `console=ttyS0...` line — i.e. the image is already
 * serial-console and needs no patch. False when there is no block.
 */
export function hasSerialConsole(image: Uint8Array): boolean {
  const offset = findBootopts(image);
  if (offset === null) return false;
  return readBlockLines(image, offset).some((line) =>
    line.trim().startsWith('console=ttyS0'),
  );
}

/**
 * Return a copy of `image` whose /bootopts block gained
 * {@link SERIAL_CONSOLE_LINE}, {@link NE0_BOOTOPTS_LINE},
 * {@link DNSIP_BOOTOPTS_LINE}, and {@link SERIAL_RUNLEVEL_LINE}.
 * Existing lines are preserved verbatim except active
 * `console=`/`ne0=`/`DNSIP=` lines and bare runlevel digits, which
 * are dropped so exactly one claim of each remains. Returns null
 * when the image has no /bootopts block (caller boots it unpatched —
 * nothing sensible to edit).
 *
 * Throws if the resulting text exceeds the 1024-byte region — can only
 * happen on an image whose block is already nearly full.
 */
export function patchBootoptsForSerial(
  image: Uint8Array,
  extraLines: readonly string[] = [],
): Uint8Array | null {
  const offset = findBootopts(image);
  if (offset === null) return null;

  const lines = readBlockLines(image, offset);
  // Drop trailing blank lines so the appended options don't float after
  // padding artifacts; drop active console= lines and bare runlevel
  // digits (commented ones stay). Active lines sharing a KEY= prefix
  // with an extraLine (e.g. LOCALIP= from the TAN lease) are dropped
  // too, so exactly one claim of each key remains.
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop();
  }
  const extraKeys = extraLines
    .map((l) => l.split('=')[0])
    .filter((k): k is string => k !== undefined && k !== '')
    .map((k) => `${k}=`);
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (
      t.startsWith('console=') ||
      t.startsWith('ne0=') ||
      t.startsWith('DNSIP=') ||
      /^[0-9]$/.test(t)
    ) {
      return false;
    }
    return !extraKeys.some((k) => t.startsWith(k));
  });
  kept.push(SERIAL_CONSOLE_LINE);
  kept.push(NE0_BOOTOPTS_LINE);
  kept.push(DNSIP_BOOTOPTS_LINE);
  kept.push(...extraLines);
  kept.push(SERIAL_RUNLEVEL_LINE);

  const text = kept.join('\n') + '\n';
  if (text.length > BOOTOPTS_SIZE - 1) {
    throw new Error(
      `patchBootoptsForSerial: rewritten /bootopts is ${text.length} bytes ` +
        `(max ${BOOTOPTS_SIZE - 1}) — image's block is too full to patch`,
    );
  }

  const out = new Uint8Array(image);
  out.fill(0x00, offset, offset + BOOTOPTS_SIZE);
  for (let i = 0; i < text.length; i++) {
    out[offset + i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Decode the block's text region (up to the first NUL) into lines.
 * The block is ASCII, LF-separated, NUL-padded to 1024 bytes.
 */
function readBlockLines(image: Uint8Array, offset: number): string[] {
  let text = '';
  for (let i = 0; i < BOOTOPTS_SIZE; i++) {
    const byte = image[offset + i] ?? 0;
    if (byte === 0x00) break;
    text += String.fromCharCode(byte);
  }
  return text.split('\n');
}
