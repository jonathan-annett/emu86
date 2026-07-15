/**
 * /bin/ping binary generator — env-gated, the MINIX_FIXTURE_GEN
 * precedent. Not a test of the product: a TOOL that produces
 * `src/browser/ping-binary.ts` when run by hand:
 *
 *     EMU86_PING_GEN=1 npx vitest run tests/integration/ping-binary-gen.test.ts
 *
 * It boots hd32-minix.img as root, brings the network up, runs the
 * FIELD-PROVEN installer from the 8086-tab-tools repo (fetch ping.c,
 * stop net to give c86 its memory back, build with the on-image
 * toolchain, install /bin/ping), verifies the binary answers, syncs,
 * and extracts /bin/ping from the quiescent primary via minix-fs.
 * The module it writes is committed — the ping STAMP (Phase 17 M4,
 * Jonathan: "just quietly add the executable to the overlay")
 * consumes it at every boot.
 *
 * Needs live network (github fetch through the gateway's real fetch)
 * — another reason it is env-gated and manual.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';
import { openMinixImage } from '../../src/disk/minix-fs.js';
import { SECTOR_SIZE } from '../../src/disk/disk.js';
import { HD32_PATH } from './guest-drive-harness.js';

const GEN = process.env['EMU86_PING_GEN'] === '1' && existsSync(HD32_PATH);
const itgen = GEN ? it : it.skip;

const OUT_PATH = resolve('src/browser/ping-binary.ts');
const INSTALL_BASE =
  'http://raw.githubusercontent.com:443/jonathan-annett/8086-tab-tools/main';

const BOOT_SLICE = 10_000_000;
const STEP = 2_000_000;
const ROOT_PROMPT = /# *$/;

describe('ping binary generator (manual tool)', () => {
  itgen(
    'compiles ping in-VM, extracts /bin/ping, writes src/browser/ping-binary.ts',
    async () => {
      // Fetch ping.c HOST-side (live DoH through the sync test driver
      // is a timing fight the browser never has) and plant it on the
      // image pre-boot — no guest networking, so c86 also gets every
      // byte of RAM and the installer's net-stop dance is moot.
      const srcResp = await fetch(
        'https://raw.githubusercontent.com/jonathan-annett/8086-tab-tools/main/ping.c',
      );
      if (!srcResp.ok) throw new Error(`ping.c fetch failed: ${srcResp.status}`);
      const pingSource = new Uint8Array(await srcResp.arrayBuffer());
      expect(pingSource.length).toBeGreaterThan(500);

      const raw = readFileSync(HD32_PATH);
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
      const pre = openMinixImage(bytes);
      if (!pre.ok) throw new Error('hd32 not minix');
      const planted = pre.fs.writeFile('/root/ping.c', pingSource);
      if (!planted.ok) throw new Error(`plant failed: ${planted.kind}`);

      const posts: WorkerToMainMessage[] = [];
      const host = new WorkerHost({ post: (m) => posts.push(m), autoRun: false });
      host.handleMessage({
        type: 'boot',
        config: { imageBytes: bytes, autologin: 'root', autoNet: false },
      });
      await host.whenIdle();
      const txText = (): string => {
        let s = '';
        for (const m of posts) {
          if (m.type === 'tx') s += String.fromCharCode(...m.bytes);
        }
        return s;
      };
      for (let i = 0; i < 8 && !ROOT_PROMPT.test(txText()); i++) {
        host.runUntil(BOOT_SLICE);
      }
      if (!ROOT_PROMPT.test(txText())) throw new Error(`no root prompt:\n${txText().slice(-400)}`);

      const shell = async (line: string, maxSlices = 120): Promise<string> => {
        const before = txText().length;
        host.handleMessage({
          type: 'rx',
          bytes: new Uint8Array([...`${line}\n`].map((c) => c.charCodeAt(0))),
        });
        for (let i = 0; i < maxSlices; i++) {
          const r = host.runUntil(STEP);
          if (r.reason === 'error') throw new Error(`error during "${line}"`);
          // The gateway fetch settles between run slices — yield so
          // its promise can land while the machine idles.
          await new Promise((res) => setTimeout(res, 5));
          const out = txText().slice(before);
          if (ROOT_PROMPT.test(out) && out.includes('\n')) return out;
        }
        throw new Error(`no prompt after "${line}":\n${txText().slice(before)}`);
      };

      // The recorded recipe (HELLO_WORLD_COMPILE_REPORT §3 / the
      // installer's own steps), run on the planted source as root
      // with all 640K to ourselves.
      await shell('cd /root');
      console.log('[cpp]', (await shell('cpp -0 -I/usr/include -I/usr/include/c86 ping.c -o ping.i', 400)).slice(-200));
      console.log('[c86]', (await shell(
        'c86 -g -O -bas86 -separate=yes -warn=4 -lang=c99 -align=yes -stackopt=minimum -peep=all -stackcheck=no ping.i ping.as',
        2000,
      )).slice(-300));
      console.log('[as]', (await shell('as -0 -j ping.as -o ping.o', 400)).slice(-200));
      const linked = await shell('ld -0 -i -L/usr/lib -o ping ping.o -lc86', 400);
      console.log('[ld]', linked.slice(-200));
      expect(linked).not.toContain('cannot');
      await shell('cp ping /bin/ping');
      // Executes and speaks (its no-ktcp diagnostic counts) — anything
      // but "not found" proves a runnable a.out landed in /bin.
      const probe = await shell('ping', 200);
      console.log('[probe]', probe.slice(-300));
      expect(probe).not.toContain('not found');
      await shell('sync');

      // Extract from the quiescent primary.
      const disk = host.machine?.disk;
      if (!disk) throw new Error('no primary disk');
      const image = new Uint8Array(disk.sectorCount * SECTOR_SIZE);
      for (let lba = 0; lba < disk.sectorCount; lba++) {
        image.set(disk.readSector(lba), lba * SECTOR_SIZE);
      }
      const fs = openMinixImage(image);
      if (!fs.ok) throw new Error('primary not minix after build');
      const ping = fs.fs.readFile('/bin/ping');
      if (!ping.ok) throw new Error(`no /bin/ping: ${ping.kind}`);
      expect(ping.value.length).toBeGreaterThan(1000);

      const b64 = Buffer.from(ping.value).toString('base64');
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(
        OUT_PATH,
        `/**
 * /bin/ping for the boot-disk stamp — GENERATED, do not hand-edit.
 *
 * Provenance: compiled IN-VM on hd32-minix.img by the on-image c86
 * toolchain (the recorded cpp/c86/as/ld recipe) from ping.c at
 * https://raw.githubusercontent.com/jonathan-annett/8086-tab-tools/main/ping.c
 * planted pre-boot, extracted from the quiescent image via minix-fs,
 * ${today}. ${ping.value.length} bytes.
 *
 * Regenerate:
 *   EMU86_PING_GEN=1 npx vitest run tests/integration/ping-binary-gen.test.ts
 */

const PING_BASE64 =
  '${b64.replace(/(.{76})/g, "$1' +\n  '")}';

export function pingBinaryBytes(): Uint8Array {
  const raw = atob(PING_BASE64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i) & 0xff;
  return out;
}
`,
      );
      console.log(`wrote ${OUT_PATH}: ${ping.value.length} bytes of /bin/ping`);
    },
    900_000,
  );
});
