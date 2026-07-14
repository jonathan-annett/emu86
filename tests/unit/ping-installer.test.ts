/**
 * Ping-installer script assembly (Phase 15 M3 follow-on).
 *
 * These pin the two constraints the field log taught us
 * (`ping-paste-log.txt`, 2026-07-14): ELKS `sh` buffers heredoc bodies
 * in a heap that blew up at ~6 KB, so the installer must NEVER nest
 * heredocs and must chunk the C source. A regression here is a boot
 * script that turns to soup on a real machine — cheap to assert,
 * expensive to discover.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHUNK_LINES, buildPingInstallerScript } from '../../web/ping-installer.js';

const PING_C = readFileSync(resolve('web/guest/ping.c'), 'ascii');

/**
 * Split the script into its heredoc bodies — the lines the SHELL must
 * buffer. `@here`/`@end` are autoexec directives consumed by the
 * runner (web/autoexec.ts), never sent to the guest, so they are not
 * part of any body.
 */
function heredocBodies(script: string): string[][] {
  const bodies: string[][] = [];
  const lines = script.split('\n');
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === '@here' || line === '@end') continue; // runner directives
    const open = /<< '([A-Z_0-9]+)'$/.exec(line);
    if (open !== null) {
      if (current !== null) {
        throw new Error(`nested heredoc opened while one was still open: ${line}`);
      }
      current = [];
      continue;
    }
    if (current === null) continue;
    if (/^EOF_[A-Z_]+$/.test(line.trim())) {
      bodies.push(current);
      current = null;
      continue;
    }
    current.push(line);
  }
  expect(current).toBeNull(); // every heredoc closed
  return bodies;
}

describe('buildPingInstallerScript', () => {
  const script = buildPingInstallerScript(PING_C);

  it('never nests heredocs (the OUT OF HEAP SPACE cascade)', () => {
    // heredocBodies throws on a nested open — the original installer
    // wrapped a 14 KB ping.c inside the getping.sh heredoc, and ELKS
    // sh died trying to buffer the lot: (7)SBRK 8226 FAIL.
    expect(() => heredocBodies(script)).not.toThrow();
  });

  it('keeps every heredoc body well under the shell heredoc heap', () => {
    // Bytes are what the shell buffers, and the observed failure came
    // ~6 KB in. 2 KB is a 3x margin on a machine that may already be
    // carrying other work.
    const bodies = heredocBodies(script);
    for (const body of bodies) {
      expect(body.join('\n').length).toBeLessThan(2048);
    }
    // The C source chunks additionally honour the line cap (the
    // installer script itself is one small body, longer in lines but
    // trivial in bytes).
    for (const body of bodies.slice(1)) {
      expect(body.length).toBeLessThanOrEqual(CHUNK_LINES);
    }
  });

  it('writes the C source exactly once, in order, first > then >>', () => {
    const opens = script.split('\n').filter((l) => l.includes('/tmp/ping.c <<'));
    expect(opens.length).toBeGreaterThan(1); // chunked, by construction
    expect(opens[0]).toContain('cat > /tmp/ping.c');
    for (const open of opens.slice(1)) {
      expect(open).toContain('cat >> /tmp/ping.c'); // append, never truncate
    }

    // The reassembled heredoc bodies for ping.c must equal the source.
    const bodies = heredocBodies(script);
    const cBodies = bodies.slice(1); // body 0 is getping.sh
    const rebuilt = cBodies.flat().join('\n');
    expect(rebuilt).toBe(PING_C.replace(/\n+$/, ''));
  });

  it('the installer logic is idempotent and drive-safe', () => {
    const logic = heredocBodies(script)[0]?.join('\n') ?? '';
    expect(logic).toContain('if test -f /bin/ping'); // already installed → exit
    expect(logic).toContain('if test -f /mnt/ping'); // on the drive → copy in
    // The drive is only written when the mount actually succeeded —
    // writing to /mnt unmounted silently lands on the root filesystem.
    expect(logic).toContain('drive=yes');
    expect(logic).toContain('if test "$drive" = yes');
  });

  it('runs before net start (ping needs the NIC to itself)', () => {
    const lines = script.split('\n');
    const install = lines.indexOf('sh /tmp/getping.sh');
    const net = lines.indexOf('net start ne0');
    expect(install).toBeGreaterThan(0);
    expect(net).toBeGreaterThan(install);
  });

  it('rejects a source that would collide with a heredoc terminator', () => {
    expect(() => buildPingInstallerScript('int main(void)\nEOF_PING_C\n')).toThrow(
      /collides with a heredoc terminator/,
    );
  });
});
