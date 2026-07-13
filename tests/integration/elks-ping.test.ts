/**
 * ELKS joins the LAN and answers pings (Phase 14 M3b acceptance).
 *
 * Boots stock `hd32-minix.img` (bootopts: serial console, ne0=5,
 * init=/bin/sh), runs the guest's own `net start ne0` — which launches
 * ktcp against /dev/ne0 with /etc/net.cfg's defaults (guest 10.0.2.15,
 * gateway 10.0.2.2) — and proves, with a LanGateway on the switch:
 *
 *   1. ktcp's startup gratuitous ARP (`deveth.c:57`) teaches the
 *      gateway the guest's MAC without a single query.
 *   2. The gateway pings 10.0.2.15 three times; ktcp's `icmp.c`
 *      echo-replies to each, ids/seqs/payloads intact.
 *   3. In-guest `netstat` prints matching ICMP counters — the
 *      guest-visible half of the proof (ELKS ships no ping client;
 *      reply-side ICMP is what its stack supports).
 *
 * Skips with a pointer when the fixture is absent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';
import { EthernetSwitch } from '../../src/net/switch.js';
import { LanGateway, type EchoReplyEvent } from '../../src/net/gateway.js';
import { applyBootopts } from '../probe/surveys/survey-runner.js';

const HD32_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');
const GUEST_IP = [10, 0, 2, 15] as const;

const BOOTOPTS_SIZE = 1024;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

function buildPingBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 ping integration',
    'console=ttyS0,9600',
    'ne0=5,0x300,,0x80',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

function injectLine(m: IBMPCMachine, tracer: Tracer, line: string): void {
  for (let off = 0; off < line.length; off += 12) {
    const chunk = line.slice(off, off + 12);
    for (let i = 0; i < chunk.length; i++) m.uart.injectByte(chunk.charCodeAt(i));
    traceRun(m, { tracer, maxInstructions: 200_000 });
  }
}

describe('Phase 14 M3b — the LAN pings ELKS and ELKS answers', () => {
  it(
    'net start ne0 joins the LAN; gateway pings are echo-replied; netstat shows the counters',
    () => {
      if (!existsSync(HD32_PATH)) {
        console.warn(
          `[skip] ${HD32_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }

      const raw = readFileSync(HD32_PATH);
      const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const patched = applyBootopts(rawBytes, buildPingBootopts());

      // ---- LAN: switch + gateway, machine NIC as a port (the same
      // wiring WorkerHost does in the browser) ----
      const lan = new EthernetSwitch();
      const replies: EchoReplyEvent[] = [];
      const gateway = new LanGateway({ onEchoReply: (ev) => replies.push(ev) });
      gateway.attachTo(lan);

      const txBytes: number[] = [];
      let machineRef: IBMPCMachine | null = null;
      const nicPort = lan.attach({
        name: 'ne2000',
        onFrame: (frame) => {
          machineRef?.nic.injectFrame(frame);
        },
      });

      const m = new IBMPCMachine({
        disk: new InMemoryDisk({ geometry: HD32_GEOMETRY, contents: patched }),
        diskClass: 'hard-disk',
        console: new InMemoryConsole(),
        hostClock: new InMemoryHostClock(),
        cyclesPerPitTick: 4,
        uartTransmit: (byte: number) => txBytes.push(byte),
        nicTransmit: (frame: Uint8Array) => nicPort.transmit(frame),
      });
      machineRef = m;
      m.reset();

      const tracer = new Tracer({ capacity: 50_000, kinds: ['intService', 'trap'] });
      const transcript = (): string => String.fromCharCode(...txBytes);

      // ---- boot to shell ----
      const r1 = traceRun(m, { tracer, maxInstructions: 16_000_000 });
      expect(r1.reason).not.toBe('error');
      expect(transcript()).toContain('eth: ne0 at 300, irq 5');
      expect(transcript()).toMatch(/# *$/);

      // ---- guest joins the LAN with its own tooling ----
      injectLine(m, tracer, 'net start ne0\n');
      const r2 = traceRun(m, { tracer, maxInstructions: 10_000_000 });
      expect(r2.reason).not.toBe('error');

      // ktcp's gratuitous ARP announced the guest — no query needed.
      expect(gateway.arpTable.get('10.0.2.15')).toBeDefined();

      // ---- the LAN pings the VM ----
      const payload = Uint8Array.from({ length: 32 }, (_, i) => (0x20 + i) & 0xff);
      for (let seq = 1; seq <= 3; seq++) {
        const outcome = gateway.ping(GUEST_IP, 0xe86, seq, payload);
        expect(outcome).toBe('sent'); // MAC already learned
        const r = traceRun(m, { tracer, maxInstructions: 2_000_000 });
        expect(r.reason).not.toBe('error');
      }

      expect(replies).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        const reply = replies[i]!;
        expect(reply.fromIp).toEqual(Array.from(GUEST_IP));
        expect(reply.id).toBe(0xe86);
        expect(reply.seq).toBe(i + 1);
        expect(Array.from(reply.payload)).toEqual(Array.from(payload));
      }

      // ---- guest-visible proof: netstat's ICMP counters ----
      injectLine(m, tracer, 'netstat\n');
      const r3 = traceRun(m, { tracer, maxInstructions: 4_000_000 });
      expect(r3.reason).not.toBe('error');
      const out = transcript();
      // "ICMP Packets   3  ICMP Packets   3" — received / sent.
      expect(out).toMatch(/ICMP Packets\s+3\s+ICMP Packets\s+3/);
    },
    TEST_TIMEOUT_MS,
  );
});
