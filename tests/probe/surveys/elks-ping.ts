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
import { EthernetSwitch } from '../../../src/net/switch.js';
import { LanGateway } from '../../../src/net/gateway.js';

/** The guest C source, kept as a real file for editing/review sanity. */
export const PING_C_PATH = new URL('./guest/ping.c', import.meta.url);

/** Same kernel NIC config the browser auto-patch and the dns test use. */
export const PING_BOOTOPTS_EXTRA = ['ne0=5,0x300,,0x80'];

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
    };
  }

  const raw = readFileSync(imagePath);
  const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const pingSource = readFileSync(PING_C_PATH, 'ascii');

  const bootopts = buildBootoptsWithScript(PING_BOOTOPTS_SCRIPT, PING_BOOTOPTS_EXTRA);
  const primary = applyBootopts(rawBytes, bootopts);

  const gateway = new LanGateway();
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
  };
}
