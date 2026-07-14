/**
 * In-VM-compiled ping against the live LAN (Phase 15 M3 acceptance).
 *
 * The dogfooding milestone: `ping.c` (raw-frame, standalone — see
 * `web/guest/ping.c`, shared with the browser's seeded installer
 * script) is compiled INSIDE the emulated machine by the on-disk C86
 * toolchain, then run in the same boot:
 *
 *   - `ping 10.0.2.2 3` answers three times from the LanGateway with
 *     honest RTTs (the guest's own ARP resolves the gateway first);
 *   - `ping 8.8.8.8 1` gets ICMP host-unreachable (D6) — a browser
 *     cannot send real ICMP and emu86 does not fake RTTs.
 *
 * The complement of the Phase 14 M3b test (`elks-ping.test.ts`, where
 * the GATEWAY pings the GUEST): now the guest originates, with a tool
 * it built itself. The binary is exported to the probe floppy and its
 * md5 receipt is verified host-side — the artifact is real.
 *
 * Verbose transcript: EMU86_PING_VERBOSE=1. Skips with a pointer when
 * the fixture image is absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runElksPing } from '../probe/surveys/elks-ping.js';

const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');
const VERBOSE = process.env['EMU86_PING_VERBOSE'] === '1';
const TEST_TIMEOUT_MS = 15 * 60 * 1000;

describe('Phase 15 M3 — in-VM-compiled ping pings the LAN', () => {
  it(
    'builds ping.c with c86, pings the gateway, gets unreachable for 8.8.8.8',
    async () => {
      if (!existsSync(HD32_PATH)) {
        console.warn(
          `[skip] ${HD32_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }

      const result = await runElksPing(HD32_PATH);

      if (VERBOSE) {
        for (const [name, body] of Object.entries(result.sections)) {
          console.log(`--- @@${name}@@ ---\n${body}\n`);
        }
        console.log(
          `[ping] timeoutPhase=${result.probe?.timeoutPhase} ` +
            `arpReplies=${result.gatewayArpReplies} ` +
            `echoReplies=${result.gatewayEchoReplies} ` +
            `unreachables=${result.gatewayUnreachables} ` +
            `proberWhoHas=${result.proberWhoHasSent} ` +
            `guestArpReplies=${result.guestArpReplies} ` +
            `guestSays=${result.guestArpReplyIp} ${result.guestArpReplyMac}`,
        );
        console.log('--- transcript tail ---\n' + (result.probe?.fullTranscript ?? '').slice(-800));
      }

      expect(result.fixtureMissing).toBe(false);
      expect(result.probe?.kernelPanicked).toBe(false);
      expect(result.extractedComplete).toBe(true);

      // ---- the compile pipeline: every stage exits 0 ----
      for (const stage of result.stages) {
        if (stage.name === 'pingfar') continue; // asserted separately below
        expect(
          stage.rc,
          `stage ${stage.name} rc (output: ${stage.output.slice(0, 400)})`,
        ).toBe(0);
      }

      // ---- gateway ping: three honest replies ----
      expect(result.gatewayReplies).toBe(3);
      expect(result.sections['pinggw']).toContain('3 packets transmitted, 3 received');
      expect(result.gatewayEchoReplies).toBe(3);

      // ---- identity: the source address is $LOCALIP, not the old
      // hardcoded 10.0.2.15 (half of the tab-pings-tab bug) ----
      expect(result.sections['pinggw']).toContain('from 10.0.2.42');

      // ---- and ping ANSWERS who-has for that address (the other
      // half): the prober asked twice — once cued by ping's own ARP,
      // once cued by the first answer — and only ping can answer, ktcp
      // being stopped. This is the question a far tab's ktcp must have
      // answered before it can send its echo reply back. ----
      expect(result.proberWhoHasSent).toBe(2);
      expect(result.guestArpReplies).toBe(2);
      expect(result.guestArpReplyIp).toBe('10.0.2.42');

      // ---- self-ping (rev 6): loopback, no ARP, no wire — the probe
      // stamps LOCALIP=10.0.2.42 and pings it. Before rev 6 this hung
      // on a self-ARP nothing may answer (field: "pinging mouse from
      // mouse fails"). rc=0 asserted by the all-stages loop above. ----
      expect(result.sections['pingself']).toContain('loopback');
      expect(result.sections['pingself']).toContain('2 packets transmitted, 2 received');

      // ---- off-LAN ping: unreachable, not a hang, exit code 1 ----
      expect(result.farUnreachable).toBe(true);
      expect(result.gatewayUnreachables).toBe(1);
      const far = result.stages.find((s) => s.name === 'pingfar');
      expect(far?.rc).toBe(1); // no replies → the tool says so in its exit code

      // ---- the artifact is real: extracted + md5 receipt ----
      expect(result.pingBin).not.toBeNull();
      expect(result.guestMd5).not.toBeNull();
      if (result.pingBin !== null && result.guestMd5 !== null) {
        const hostMd5 = createHash('md5').update(result.pingBin).digest('hex');
        expect(hostMd5).toBe(result.guestMd5);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
