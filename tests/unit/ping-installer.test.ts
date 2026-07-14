/**
 * The ping-installer boot script (Phase 15 M3 follow-on).
 *
 * The script's job is to be SMALL. Its predecessor typed 722 lines of
 * chunked heredoc into the guest and kept losing to the ELKS shell's
 * heap; this one fetches. So what's worth pinning is exactly that: it
 * stays tiny, it never pastes source, and the ordering constraints that
 * make it work at all (network up before the fetch, network down before
 * the ping) hold.
 */

import { describe, it, expect } from 'vitest';
import {
  INSTALL_PING_URL,
  MAX_GUEST_LINE,
  PING_REV,
  TOOLS_REPO_RAW,
  buildPingInstallerScript,
} from '../../web/ping-installer.js';

describe('buildPingInstallerScript', () => {
  const script = buildPingInstallerScript();
  const lines = script.split('\n').filter((l) => l.length > 0);

  it('is a handful of lines and pastes no source at all', () => {
    // The whole point. If a heredoc ever reappears here, the shell-heap
    // war is back on.
    expect(lines.length).toBeLessThan(12);
    expect(script).not.toContain('<<'); // no heredoc, ever again
    expect(script).not.toContain('@here');
    expect(script).not.toContain('#include'); // no C through the tty
    expect(script.length).toBeLessThan(500); // vs 20,806 bytes before
  });

  it('fetches the installer from the public tools repo over the :443 bridge', () => {
    // Assembled from the variable, so match on the pieces, not the whole.
    expect(script).toContain(TOOLS_REPO_RAW);
    expect(script).toContain('urlget $U/install-ping.sh');
    expect(INSTALL_PING_URL.startsWith(TOOLS_REPO_RAW)).toBe(true);
    // :443 is what tells the gateway to fetch over HTTPS host-side.
    expect(INSTALL_PING_URL).toContain('raw.githubusercontent.com:443');
    // raw.githubusercontent.com serves ACAO:*, which is what puts it on
    // the reachable side of the browser's CORS wall.
    expect(INSTALL_PING_URL).toContain('/8086-tab-tools/');
  });

  it('brings the network UP before fetching, and pings only after', () => {
    // Ordering is load-bearing: urlget needs ktcp running, and ping needs
    // the NIC to itself (a running ktcp drains every inbound frame, so the
    // replies never reach it). The installer script drops the network
    // itself before compiling — it needs that memory.
    const start = lines.indexOf('net start ne0');
    const fetch = lines.findIndex((l) => l.startsWith('urlget '));
    const run = lines.findIndex((l) => l.startsWith('sh /tmp/'));
    const ping = lines.findIndex((l) => l.startsWith('ping '));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(fetch); // network up, then download
    expect(fetch).toBeLessThan(run); // download, then run
    expect(run).toBeLessThan(ping); // install, then ping
    expect(lines.lastIndexOf('net start ne0')).toBeGreaterThan(ping); // back up after
  });

  it('starts ktcp WITHOUT telnetd/ftpd — the machine cannot afford them', () => {
    // 640K machine, ~472K free, and c86 wants most of it. With all three
    // daemons resident the shell could not even fork. Emptying `netstart`
    // in /etc/net.cfg (which /bin/net sources — last assignment wins)
    // keeps ktcp and drops the other two.
    const cfg = lines.findIndex((l) => l.includes('netstart') && l.includes('net.cfg'));
    const start = lines.indexOf('net start ne0');
    expect(cfg).toBeGreaterThanOrEqual(0);
    expect(cfg).toBeLessThan(start); // must land BEFORE the stack comes up
  });

  it('compiles in turbo and pings at authentic speed', () => {
    const turbo = lines.indexOf('@turbo');
    const authentic = lines.indexOf('@authentic');
    const ping = lines.findIndex((l) => l.startsWith('ping '));
    expect(turbo).toBeGreaterThanOrEqual(0);
    expect(turbo).toBeLessThan(authentic);
    // The demo ping's RTTs should be the machine's real ones, not turbo's.
    expect(authentic).toBeLessThan(ping);
  });

  it('pings by name — the .tabs namespace, not a memorised octet', () => {
    expect(script).toContain('ping elk'); // the gateway, ELK-S
  });

  it('tracks the revision the tools repo ships', () => {
    expect(PING_REV).toBeGreaterThanOrEqual(4);
  });

  it('never types a line the ELKS tty would silently truncate', () => {
    // THE bug of 2026-07-14. A 129-char `urlget ... > /tmp/install-ping.sh`
    // lost its last two characters at the tty: the download succeeded, the
    // file landed as `/tmp/install-ping.` and the next line died with
    // "Can't open /tmp/install-ping.sh". No error, no warning — the tail
    // just evaporates. Every line the field proved works is under this
    // bound; only the 129 failed.
    for (const line of script.split('\n')) {
      expect(line.length, `line would be truncated: ${line}`)
        .toBeLessThanOrEqual(MAX_GUEST_LINE);
    }
  });

  it('puts the long URL in a shell variable rather than inline', () => {
    // The fix, and the reason the bound above holds: one cheap assignment
    // removes the cliff entirely.
    expect(script).toContain(`U=${TOOLS_REPO_RAW}`);
    expect(script).toContain('urlget $U/install-ping.sh');
    expect(script).not.toContain(`urlget ${INSTALL_PING_URL}`); // never inline
  });
});
