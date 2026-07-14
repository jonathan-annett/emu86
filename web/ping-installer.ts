/**
 * The ping-installer boot script (Phase 15 M3 follow-on).
 *
 * Jonathan's design: the autoexec layer only pastes and runs — ALL the
 * logic lives in the guest shell, which can actually branch. What this
 * module does is assemble the paste, and the assembly is where the
 * real constraints live.
 *
 * # Two hard-won constraints (field, 2026-07-14 — `ping-paste-log.txt`)
 *
 * 1. **Never nest heredocs.** The first version wrapped the whole
 *    installer — including a 14 KB `ping.c` — inside one
 *    `cat > getping.sh << 'EOS'`. ELKS `sh` buffers a heredoc body in
 *    its heap, so it tried to hold the entire thing at once and died:
 *    `(7)SBRK 8226 FAIL, OUT OF HEAP SPACE`. The shell then fell out of
 *    heredoc mode and interpreted the C source as commands.
 * 2. **Chunk the source.** Even un-nested, one 14 KB heredoc would hit
 *    the same wall (the failure came ~6 KB in). The source is written
 *    in {@link CHUNK_LINES}-line appends, each its own small heredoc —
 *    the shell's buffer is freed between them.
 *
 * Flow control is the `> ` continuation prompt (see web/autoexec.ts):
 * every heredoc body line waits for it, so the guest tty paces the
 * paste and it cannot outrun the kernel's raw tty queue.
 *
 * The source of truth for the C is `web/guest/ping.c` — the same file
 * the Node probe harness compiles in-VM (tests/probe/surveys/elks-ping.ts).
 * One file, two consumers, no drift.
 */

/**
 * Source lines per heredoc chunk. ~20 lines ≈ 1 KB — comfortably under
 * the ~6 KB at which ELKS sh's heredoc buffer blew up, with room for a
 * machine already loaded with other work.
 */
export const CHUNK_LINES = 20;

/** Heredoc terminators chosen not to collide with any line of C or shell. */
const SH_EOF = 'EOF_GETPING_SH';
const C_EOF = 'EOF_PING_C';

/**
 * Revision of `guest/ping.c`. **Bump it whenever that file changes**, or
 * a drive holding an older binary will keep restoring it forever — the
 * installer stops asking questions the moment /bin/ping exists.
 *
 * rev 3: /etc/hosts name lookup, and an honest ARP-failure message
 *        (a running ktcp eats the replies — the old text blamed the
 *        open(), which actually succeeds).
 * rev 4: the `.tabs` namespace — `ping cat`, `ping cat.tabs`, `ping elk`.
 *        The table is compiled in because ping cannot use DNS.
 */
export const PING_REV = 4;
const REV_MARKER = `pingrev${PING_REV}`;

/**
 * The installer proper — a normal shell script, idempotent by design:
 *
 *   /bin/ping exists        → nothing to do
 *   ping found on /dev/hdb  → copy it in (a second boot costs no compile)
 *   otherwise               → build /tmp/ping.c with the on-disk c86
 *                             toolchain, install it, and stash a copy on
 *                             the drive when one is mounted
 *
 * The drive is only written when the mount actually succeeded — writing
 * to /mnt with nothing mounted silently lands on the root filesystem
 * (found reading the field log; the first version had that bug).
 */
const INSTALLER_SH: readonly string[] = [
  '# emu86 ping installer -- idempotent, safe to run at every boot.',
  '# ping drives the NIC directly, so it needs the device to itself:',
  '# run it before "net start", or "net stop" first.',
  'if test -f /bin/ping',
  'then',
  'echo "ping: already installed"',
  'exit 0',
  'fi',
  'drive=no',
  'if mount /dev/hdb /mnt 2>/dev/null',
  'then',
  'drive=yes',
  'fi',
  // The rev marker is how a saved drive learns its binary is stale. The
  // filename carries the revision (`pingrev3`), so the check is a plain
  // `test -f` — ELKS sh has no `$(...)`, and this needs no grep either.
  // Without it, a drive holding an old ping would keep serving it
  // forever: the installer sees /bin/ping appear and stops asking.
  `if test -f /mnt/${REV_MARKER}`,
  'then',
  'echo "ping: restoring from /dev/hdb"',
  'cp /mnt/ping /bin/ping',
  'umount /mnt',
  'exit 0',
  'fi',
  'if test -f /mnt/ping',
  'then',
  'echo "ping: the copy on /dev/hdb is out of date -- rebuilding"',
  'fi',
  'echo "ping: building it with the in-VM c86 toolchain, please wait..."',
  'cd /tmp',
  'cpp -0 -I/usr/include -I/usr/include/c86 ping.c -o ping.i',
  'c86 -g -O -bas86 -separate=yes -warn=4 -lang=c99 -align=yes -stackopt=minimum -peep=all -stackcheck=no ping.i ping.as',
  'as -0 -j ping.as -o ping.o',
  'ld -0 -i -L/usr/lib -o ping ping.o -lc86',
  'if test -f /tmp/ping',
  'then',
  'cp /tmp/ping /bin/ping',
  'echo "ping: installed /bin/ping"',
  'if test "$drive" = yes',
  'then',
  'cp /tmp/ping /mnt/ping',
  `echo ${PING_REV} > /mnt/${REV_MARKER}`,
  'sync',
  'echo "ping: copied to /dev/hdb -- press Save to keep it for good"',
  'fi',
  'else',
  'echo "ping: BUILD FAILED -- transcript above has the reason"',
  'fi',
  'if test "$drive" = yes',
  'then',
  'umount /mnt',
  'fi',
];

/**
 * Assemble the boot script that installs ping. `pingSource` is the
 * contents of `web/guest/ping.c`.
 */
export function buildPingInstallerScript(pingSource: string): string {
  const source = pingSource.replace(/\n+$/, '').split('\n');
  for (const line of source) {
    if (line === C_EOF || line === SH_EOF) {
      throw new Error(`ping-installer: source line collides with a heredoc terminator: ${line}`);
    }
  }

  const out: string[] = [
    'root',
    // Turbo for the paste AND the build — the paste is hundreds of
    // prompt round-trips, and at 4.77 MHz that is a slow minute of
    // nothing much. Back to authentic before the demo ping, so its
    // RTTs are the machine's honest ones.
    '@turbo',
    'echo "installing ping -- pasting sources, then building in-VM"',
    // 1. The installer script (small: no nested heredoc, ever).
    `cat > /tmp/getping.sh << '${SH_EOF}'`,
    '@here',
    ...INSTALLER_SH,
    SH_EOF,
    '@end',
  ];

  // 2. The C source, in chunks small enough for the shell's heredoc heap.
  for (let i = 0; i < source.length; i += CHUNK_LINES) {
    out.push(
      `cat ${i === 0 ? '>' : '>>'} /tmp/ping.c << '${C_EOF}'`,
      '@here',
      ...source.slice(i, i + CHUNK_LINES),
      C_EOF,
      '@end',
    );
  }

  // 3. Drop the shell that swallowed the paste.
  //
  // ELKS `sh` grows its heap to parse everything typed at it and never
  // gives it back, so after ~450 lines the login shell's data segment
  // is fat — and every later fork has to COPY it. Field symptom
  // (2026-07-14): the build and the ping worked, then `net start`
  // brought ktcp up but `/bin/net`'s own shell died on `SBRK 1028
  // FAIL` — it could not spare a kilobyte for an `echo`, and the
  // telnetd/ftpd daemons never started. `exec sh` replaces the process
  // image with a clean one; the bloat goes with the old image.
  out.push(
    'exec sh',
    // 4. Run the installer, show it working, then join the LAN.
    'sh /tmp/getping.sh',
    '@authentic',
    'ping 10.0.2.2 3',
    'net start ne0',
    '',
  );
  return out.join('\n');
}
