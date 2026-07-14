/**
 * The ping-installer boot script (Phase 15 M3 follow-on).
 *
 * **The machine downloads its own tools.** The whole installer is now
 * three guest commands: bring the LAN up, fetch a shell script from
 * GitHub through the M3d HTTP gateway, run it. The script fetches
 * `ping.c` from the same repo, builds it with the C compiler on the
 * image, and installs it — a 1986 machine pulling source off the modern
 * internet and compiling it.
 *
 * # Why this replaced 722 lines of paste (field, 2026-07-14)
 *
 * The first design typed all of `ping.c` into the guest through the tty
 * as chunked heredocs, and it was a losing battle against ELKS `sh`:
 *
 *   - heredoc bodies are buffered in the shell's heap, which blew up at
 *     ~6 KB (`SBRK 8226 FAIL, OUT OF HEAP SPACE`) — so the source had to
 *     be split across 28 separate heredocs;
 *   - the shell grows its heap to parse everything typed at it and never
 *     returns it, so after the paste every `fork` copied a fat data
 *     segment and `net start` couldn't spare a kilobyte for an `echo`;
 *   - and each time `ping.c` grew (the `.tabs` name table added 50%),
 *     the paste crept back toward the wall.
 *
 * Jonathan's call: `urlget … | sh`. The paste problem doesn't get
 * managed, it gets *deleted* — nothing large ever goes through the tty
 * again, and shipping a fix to ping means pushing to the tools repo,
 * with no emu86 release at all.
 *
 * Requires the network (it is, after all, a network tool). The guest
 * fetches over plain HTTP/1.0; the `:443` suffix is what tells the
 * gateway to fetch over HTTPS on the host side — GitHub serves
 * `access-control-allow-origin: *`, which is what puts it on the
 * reachable side of the browser's CORS wall.
 */

/**
 * Public repo the machine installs from —
 * https://github.com/jonathan-annett/8086-tab-tools
 *
 * The short `/main/` form, not `/refs/heads/main/`: both work on
 * raw.githubusercontent.com, and eleven characters matter here (see
 * {@link MAX_GUEST_LINE}).
 */
export const TOOLS_REPO_RAW =
  'http://raw.githubusercontent.com:443/jonathan-annett/8086-tab-tools/main';

/** The installer script fetched and run in the guest. */
export const INSTALL_PING_URL = `${TOOLS_REPO_RAW}/install-ping.sh`;

/**
 * **A typed command line longer than this is silently truncated.**
 *
 * ELKS cooks tty input in a fixed buffer, and the tail of an over-long
 * line simply vanishes — no error, no warning. It cost a full debugging
 * cycle (2026-07-14): a 129-character `urlget … > /tmp/install-ping.sh`
 * lost its last two characters, so the download landed in a file called
 * `/tmp/install-ping.` and the next line failed with "Can't open
 * /tmp/install-ping.sh". The fetch had worked perfectly.
 *
 * Every line the field has *proved* works is under this: Jonathan's
 * `urlget … | sh` (111), `… | md5sum` (115), the old heredoc's monster
 * c86 invocation (117). Only the 129 failed. So: keep typed lines
 * short — put long things in a shell variable, which costs one cheap
 * line and removes the cliff entirely. A test enforces this.
 */
export const MAX_GUEST_LINE = 110;

/**
 * Revision of the ping the tools repo currently ships. Bump when
 * `ping.c` changes there — AND bump `REV=` in `install-ping.sh` to
 * match (the integration test pins the two equal). The installer
 * writes `pingrev<N>` marker files beside everything it installs —
 * the revision is in the *name*, because ELKS sh has no `$(...)` to
 * compare a version with — and treats a missing marker as stale, so a
 * drive holding an older binary rebuilds instead of restoring it
 * forever.
 *
 * (Confession, 2026-07-14: revs ≤4 DOCUMENTED this mechanism but the
 * script never implemented it — an old drive really would have
 * restored its rev-4 ping forever. Found while shipping rev 5.)
 *
 *   rev 4: the .tabs name table (ping cat / ping elk)
 *   rev 5: the tab-pings-tab fix — source address from $LOCALIP
 *          (hardcoded .15 claimed an address no tab owns) + answer
 *          ARP who-has while running (nothing else speaks for a
 *          ktcp-stopped machine); plus the marker mechanism itself.
 */
export const PING_REV = 5;

/**
 * Build the boot script. `@turbo` for the fetch and the compile (a c86
 * build at 4.77 MHz is a long minute of nothing), `@authentic` for the
 * demo ping, so its RTTs are the machine's honest ones.
 *
 * The `net stop` before pinging is not optional: ping opens the NIC
 * directly and ktcp drains every inbound frame, so a running stack eats
 * the replies. It goes back up afterwards.
 */
export function buildPingInstallerScript(): string {
  const lines = [
    'root',
    // Bring up ktcp, and NOTHING else. `/etc/net.cfg` ends with
    // `netstart="telnetd ftpd"`, and `/bin/net` sources the file — so a
    // later assignment wins. Those two daemons are pure overhead here
    // (we only ever need to download), and on a 640K machine with ~472K
    // free they are the difference between compiling and not: with all
    // three resident the shell could not even FORK ("net: Cannot fork"),
    // let alone run c86. Field, 2026-07-14.
    'echo netstart= >> /etc/net.cfg',
    'net start ne0',
    '@turbo',
    'echo "installing ping -- fetching the installer from github"',
    // The URL goes in a VARIABLE, not inline: typed inline this is a
    // 129-character line, and ELKS silently truncates the tail (see
    // MAX_GUEST_LINE — it ate the `sh` off the redirect target and cost
    // a debugging cycle). Split this way, no line is even close.
    `U=${TOOLS_REPO_RAW}`,
    'urlget $U/install-ping.sh > /tmp/ip.sh',
    // The installer takes the network down itself before compiling (it
    // needs the memory, and ping needs the NIC to itself anyway).
    'sh /tmp/ip.sh',
    '@authentic',
    'ping elk 3',
    'net start ne0',
    '',
  ];

  // Belt and braces: never emit a line the tty would quietly eat.
  for (const line of lines) {
    if (line.length > MAX_GUEST_LINE) {
      throw new Error(
        `ping-installer: line of ${line.length} chars exceeds the ELKS tty ` +
          `limit and would be silently truncated: ${line}`,
      );
    }
  }
  return lines.join('\n');
}
