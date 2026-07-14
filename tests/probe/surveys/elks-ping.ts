/**
 * In-VM ping build + live LAN probe (Phase 15 M3).
 *
 * Boots `hd32-minix.img` with the ne0= bootopts line and a LAN
 * (switch + gateway) attached through the probe harness's
 * `createNetwork` hook, ships `ping.c` (the raw-frame standalone —
 * see `guest/ping.c`) on the probe floppy, compiles it with the
 * on-disk C86 toolchain, and then RUNS it against live targets:
 *
 *   - `ping 10.0.2.2 3` — the LanGateway echo-replies; three honest
 *     RTT lines. ktcp is never started, so /dev/eth is free — no
 *     `net stop` dance needed in the probe.
 *   - `ping 8.8.8.8 1` — routed to the gateway MAC, answered with
 *     ICMP host-unreachable (decision D6); the tool prints
 *     `Destination Host Unreachable` and exits 1 (recorded as its
 *     own stage rc — the harness asserts the value, not zero).
 *
 * Since the tab-pings-tab fix (2026-07-14) this survey also proves
 * ping's two identity duties, because nothing else would:
 *
 *   - the boot stamps `LOCALIP=10.0.2.42` — the same bootopts line
 *     every TAN tab boots with — and the banner must say
 *     `from 10.0.2.42`, not the old hardcoded .15;
 *   - an ARP PROBER on the LAN asks `who-has 10.0.2.42` while ping
 *     runs, and ping itself must answer (with ktcp stopped there is
 *     nobody else to). The prober asks twice — its second ask is
 *     triggered by the first answer, landing in a later wait loop.
 *     A peer that cannot resolve us cannot send its echo reply; this
 *     is exactly the question a far tab's ktcp asks before replying.
 *
 * The binary is exported to the probe floppy with an md5 receipt,
 * same fidelity scheme as the hello-world probe.
 */

import { existsSync, readFileSync } from 'node:fs';
import { runProbe, readProbeDiskFile, type ProbeResult } from '../probe-harness.js';
import { applyBootopts, buildBootoptsWithScript, extractSurveyOutput } from './survey-runner.js';
import {
  classifyStages,
  parseGuestMd5,
  splitSections,
  HD32_HELLO_UNMOUNT_SCRIPT,
  type SectionMap,
  type StageStatus,
} from './hd32-hello-world.js';
import { EthernetSwitch, type SwitchPort } from '../../../src/net/switch.js';
import { LanGateway } from '../../../src/net/gateway.js';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  MAC_BROADCAST,
  buildArp,
  buildEthernetFrame,
  formatIp,
  formatMac,
  parseArp,
  type Ipv4,
  type Mac,
} from '../../../src/net/wire.js';

/**
 * The guest C source — canonical home is web/guest/ping.c, shared
 * with the browser's seeded ping-installer boot script (settings.ts
 * imports it `?raw`). One file, two consumers, zero drift.
 */
export const PING_C_PATH = new URL('../../../web/guest/ping.c', import.meta.url);

/**
 * The address the boot stamps into the guest's environment — the same
 * `LOCALIP=10.0.2.<octet>` line every TAN tab boots with. Ping must
 * take its source address from it (the hardcoded 10.0.2.15 was half of
 * the tab-pings-tab bug), so the survey deliberately uses an octet
 * that is NOT the .15 default.
 */
export const PING_LOCALIP: Ipv4 = [10, 0, 2, 42];

/** Same kernel NIC config the browser auto-patch and the dns test use,
 *  plus the TAN-style identity stamp (an env line for init, so it costs
 *  ~18 bytes of the 160-byte argv_slen budget — fine at this size). */
export const PING_BOOTOPTS_EXTRA = ['ne0=5,0x300,,0x80', `LOCALIP=${formatIp(PING_LOCALIP)}`];

export const PING_BOOTOPTS_SCRIPT = 'mount /dev/fd0 /mnt;sh /mnt/go.sh';

/**
 * Budgets. The whole init-script pipeline (compile + pings + unmount)
 * runs inside the BOOT phase (init -c), so the boot budget must cover
 * it all: hello-world fit in 48M, but ping.c is ~350 lines through
 * c86 -O — measured to need beyond 48M (first run died mid-ld).
 * The LAN waits are cheap in instructions (blocked selects idle in
 * HLT); the compile is what costs.
 */
export const PING_BOOT_BUDGET = 140_000_000;
export const PING_TIMEOUT = 150_000_000;
export const PING_OUTPUT_CAP = 1024 * 1024;

export const PING_STAGES: readonly string[] = [
  'copy',
  'cpp',
  'c86',
  'as',
  'ld',
  'pinggw',
  'pingfar',
  'pingself',
  'md5',
  'export',
  'unmount',
];

export const PING_BUILD_SCRIPT = [
  'echo __B__',
  'echo @@copy@@',
  'cp /mnt/ping.c /tmp/ping.c',
  'echo rc=$?',
  'cd /tmp',
  'echo @@cpp@@',
  'cpp -0 -I/usr/include -I/usr/include/c86 ping.c -o ping.i',
  'echo rc=$?',
  'echo @@c86@@',
  'c86 -g -O -bas86 -separate=yes -warn=4 -lang=c99 -align=yes -stackopt=minimum -peep=all -stackcheck=no ping.i ping.as',
  'echo rc=$?',
  'echo @@as@@',
  'as -0 -j ping.as -o ping.o',
  'echo rc=$?',
  'echo @@ld@@',
  'ld -0 -i -L/usr/lib -o ping ping.o -lc86',
  'echo rc=$?',
  // ---- live LAN runs (ktcp never started; /dev/eth is free) ----
  'echo @@pinggw@@',
  './ping 10.0.2.2 3',
  'echo rc=$?',
  'echo @@pingfar@@',
  './ping 8.8.8.8 1',
  'echo rc=$?',
  // Self-ping (rev 6): loopback, no wire — the one ping that must
  // work regardless of the network. 10.0.2.42 is the stamped LOCALIP.
  'echo @@pingself@@',
  './ping 10.0.2.42 2',
  'echo rc=$?',
  'echo @@md5@@',
  'md5sum /tmp/ping',
  'echo rc=$?',
  'echo @@export@@',
  'cp /tmp/ping /mnt/ping.bin',
  'echo rc=$?',
  // umount tail runs from /tmp (the FAT flush dance — see hello-world).
  'cp /mnt/unmnt.sh /tmp/unmnt.sh',
  'cd /',
  'exec sh /tmp/unmnt.sh',
  '',
].join('\n');

export interface ElksPingResult {
  readonly imagePath: string;
  readonly fixtureMissing: boolean;
  readonly probe: ProbeResult | null;
  readonly extractedText: string;
  readonly extractedComplete: boolean;
  readonly sections: SectionMap;
  readonly stages: readonly StageStatus[];
  /** Echo-reply lines seen in the gateway ping section. */
  readonly gatewayReplies: number;
  /** True if the off-LAN ping printed the unreachable verdict. */
  readonly farUnreachable: boolean;
  readonly pingBin: Uint8Array | null;
  readonly guestMd5: string | null;
  /** Gateway counters after the run (echoes answered, unreachables sent). */
  readonly gatewayEchoReplies: number;
  readonly gatewayUnreachables: number;
  /** ARP replies the gateway sent — proves guest frames reached the LAN. */
  readonly gatewayArpReplies: number;
  /** who-has 10.0.2.42 requests the prober put on the wire. */
  readonly proberWhoHasSent: number;
  /** ARP replies the GUEST sent back to the prober — the tab-pings-tab
   *  fix in action: with ktcp stopped, only ping can answer these. */
  readonly guestArpReplies: number;
  /** sender IP claimed in the guest's ARP reply (must be the LOCALIP). */
  readonly guestArpReplyIp: string | null;
  /** sender MAC in the guest's ARP reply. */
  readonly guestArpReplyMac: string | null;
}

export async function runElksPing(imagePath: string): Promise<ElksPingResult> {
  if (!existsSync(imagePath)) {
    return {
      imagePath,
      fixtureMissing: true,
      probe: null,
      extractedText: '',
      extractedComplete: false,
      sections: {},
      stages: [],
      gatewayReplies: 0,
      farUnreachable: false,
      pingBin: null,
      guestMd5: null,
      gatewayEchoReplies: 0,
      gatewayUnreachables: 0,
      gatewayArpReplies: 0,
      proberWhoHasSent: 0,
      guestArpReplies: 0,
      guestArpReplyIp: null,
      guestArpReplyMac: null,
    };
  }

  const raw = readFileSync(imagePath);
  const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const pingSource = readFileSync(PING_C_PATH, 'ascii');

  const bootopts = buildBootoptsWithScript(PING_BOOTOPTS_SCRIPT, PING_BOOTOPTS_EXTRA);
  const primary = applyBootopts(rawBytes, bootopts);

  const gateway = new LanGateway();

  // The ARP prober: a silent LAN resident that plays the role of a far
  // tab's ktcp — "before I can send you my echo reply, who-has
  // 10.0.2.42?". The old ping never answered (and claimed .15 anyway),
  // which is why tab could not ping tab. Cue on the guest's OWN ARP
  // who-has (the one broadcast frame the prober is guaranteed to see —
  // by then ping owns the NIC and is in a wait loop), ask again when
  // the first answer arrives (that one lands in a LATER wait loop), and
  // record what the guest claims to be.
  const proberMac: Mac = [0x02, 0xaa, 0xaa, 0xaa, 0xaa, 0x01];
  const proberIp: Ipv4 = [10, 0, 2, 9];
  let prober: SwitchPort | null = null;
  let proberWhoHasSent = 0;
  let guestArpReplies = 0;
  let guestArpReplyIp: string | null = null;
  let guestArpReplyMac: string | null = null;
  const sendWhoHas = (): void => {
    proberWhoHasSent++;
    prober?.transmit(
      buildEthernetFrame(
        MAC_BROADCAST,
        proberMac,
        ETHERTYPE_ARP,
        buildArp(ARP_OP_REQUEST, proberMac, proberIp, [0, 0, 0, 0, 0, 0], PING_LOCALIP),
      ),
    );
  };

  const probe = await runProbe({
    primaryImage: primary,
    probe: {
      filename: 'go.sh',
      script: PING_BUILD_SCRIPT,
      extraFiles: [
        { name: 'ping.c', content: pingSource },
        { name: 'unmnt.sh', content: HD32_HELLO_UNMOUNT_SCRIPT },
      ],
    },
    bootInstructionBudget: PING_BOOT_BUDGET,
    timeoutInstructions: PING_TIMEOUT,
    maxOutputBytes: PING_OUTPUT_CAP,
    createNetwork: (inject) => {
      const lan = new EthernetSwitch();
      gateway.attachTo(lan);
      prober = lan.attach({
        name: 'arp-prober',
        onFrame: (frame) => {
          if ((((frame[12] ?? 0) << 8) | (frame[13] ?? 0)) !== ETHERTYPE_ARP) return;
          const arp = parseArp(frame.subarray(14));
          if (arp === null) return;
          if (
            arp.op === ARP_OP_REQUEST
            && formatIp(arp.senderIp) === formatIp(PING_LOCALIP)
            && proberWhoHasSent === 0
          ) {
            // The guest's own who-has: ping is up and waiting. Ask it
            // who it is, mid-resolve.
            sendWhoHas();
            return;
          }
          if (arp.op === ARP_OP_REPLY && formatIp(arp.targetIp) === formatIp(proberIp)) {
            guestArpReplies++;
            guestArpReplyIp = formatIp(arp.senderIp);
            guestArpReplyMac = formatMac(arp.senderMac);
            // Ask once more — this one arrives while ping waits for an
            // echo reply (or sits in the gap between pings), proving
            // the responder stays live for the whole run.
            if (proberWhoHasSent === 1) sendWhoHas();
          }
        },
      });
      const nicPort = lan.attach({ name: 'ne2000', onFrame: inject });
      return (frame) => nicPort.transmit(frame);
    },
  });

  const region = extractSurveyOutput(probe.bootStdout);
  const sections = splitSections(region.text);
  const stages = classifyStages(sections, PING_STAGES);
  const gwSection = sections['pinggw'] ?? '';
  const farSection = sections['pingfar'] ?? '';

  return {
    imagePath,
    fixtureMissing: false,
    probe,
    extractedText: region.text,
    extractedComplete: region.complete,
    sections,
    stages,
    gatewayReplies: (gwSection.match(/bytes from 10\.0\.2\.2/g) ?? []).length,
    farUnreachable: farSection.includes('Destination Host Unreachable'),
    pingBin: readProbeDiskFile(probe.probeDiskFinal, 'ping.bin'),
    guestMd5: parseGuestMd5(sections['md5'] ?? ''),
    gatewayEchoReplies: gateway.echoRepliesSent,
    gatewayUnreachables: gateway.unreachablesSent,
    gatewayArpReplies: gateway.arpRepliesSent,
    proberWhoHasSent,
    guestArpReplies,
    guestArpReplyIp,
    guestArpReplyMac,
  };
}
