/**
 * ELKS resolves DNS through the pseudo-host (Phase 14 M3c acceptance).
 *
 * Boots stock `hd32-minix.img` (serial console, ne0=5, DNSIP stamp,
 * init=/bin/sh), runs the guest's own `net start ne0`, then the
 * guest's own `nslookup` — whose resolver (`libc/net/in_resolv.c`)
 * speaks DNS-over-TCP to port 53. The DnsHost at 10.0.2.3 answers
 * from a fixture resolver (deterministic, offline; the browser uses
 * DoH instead). Two lookups prove both config paths:
 *
 *   1. `nslookup example.com 10.0.2.3` — explicit server argument.
 *   2. `nslookup example.com`          — the DNSIP env var from the
 *      bootopts stamp, i.e. the zero-config path browser users get.
 *
 * The resolve promise settles between traceRun batches (the LAN is
 * synchronous; only the resolver is async) — the test flushes the
 * microtask queue after the query lands, then lets the guest read.
 *
 * Skips with a pointer when the fixture image is absent.
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
import { DnsHost } from '../../src/net/dns.js';
import type { Ipv4 } from '../../src/net/wire.js';
import { applyBootopts } from '../probe/surveys/survey-runner.js';

const HD32_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const BOOTOPTS_SIZE = 1024;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

function buildDnsBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 dns integration',
    'console=ttyS0,9600',
    'ne0=5,0x300,,0x80',
    'DNSIP=10.0.2.3',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

/** Fixture answer: echo the guest's question, append one A record. */
function buildAnswer(query: Uint8Array, ip: Ipv4): Uint8Array {
  const r = new Uint8Array(query.length + 16);
  r.set(query, 0);
  r[2] = 0x81; // QR, RD
  r[3] = 0x80; // RA, RCODE 0
  r[7] = 0x01; // ancount 1
  let o = query.length;
  r[o++] = 0xc0; r[o++] = 0x0c; // name pointer to the question
  r[o++] = 0x00; r[o++] = 0x01; // type A
  r[o++] = 0x00; r[o++] = 0x01; // class IN
  r[o++] = 0x00; r[o++] = 0x00; r[o++] = 0x0e; r[o++] = 0x10; // TTL 3600
  r[o++] = 0x00; r[o++] = 0x04; // rdlength
  r[o++] = ip[0] ?? 0; r[o++] = ip[1] ?? 0; r[o++] = ip[2] ?? 0; r[o++] = ip[3] ?? 0;
  return r;
}

function injectLine(m: IBMPCMachine, tracer: Tracer, line: string): void {
  // 20k per chunk, not the ping test's 200k: the final chunk carries
  // the newline, so the command starts executing inside this run — a
  // large budget would let nslookup's whole 2 s alarm expire in here,
  // before the caller's first flush point (blocked reads idle in HLT
  // and burn virtual time far faster than instructions).
  for (let off = 0; off < line.length; off += 12) {
    const chunk = line.slice(off, off + 12);
    for (let i = 0; i < chunk.length; i++) m.uart.injectByte(chunk.charCodeAt(i));
    traceRun(m, { tracer, maxInstructions: 20_000 });
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Run in small batches with a microtask flush between them until
 * `done()` or the budget runs out. The flush is what lets the DNS
 * host's resolve promise settle mid-exchange — one synchronous
 * traceRun would burn the guest's entire 2-second `alarm()` (blocked
 * reads idle in HLT, and halt spins advance virtual time far faster
 * than one cycle per instruction) before the answer could ever
 * transmit. The browser worker yields the same way between batches.
 */
async function runUntil(
  m: IBMPCMachine,
  tracer: Tracer,
  done: () => boolean,
  maxInstructions = 20_000_000,
): Promise<void> {
  // Small batches on purpose: a blocked guest executes only a few
  // hundred instructions per 47,728-cycle jiffy (timer wake + HLT), so
  // a large instruction budget spans many guest-seconds and the 2 s
  // alarm expires inside one batch, before any flush can run.
  const BATCH = 20_000;
  for (let spent = 0; spent < maxInstructions && !done(); spent += BATCH) {
    const r = traceRun(m, { tracer, maxInstructions: BATCH });
    expect(r.reason).not.toBe('error');
    await flush();
  }
}

describe('Phase 14 M3c — ELKS nslookup resolves through the DNS pseudo-host', () => {
  it(
    'explicit-server and DNSIP-env lookups both return the fixture answers',
    async () => {
      if (!existsSync(HD32_PATH)) {
        console.warn(
          `[skip] ${HD32_PATH} not found. Run ` +
            `\`npm run build:elks-hd-image -- hd32-minix\` to fetch it.`,
        );
        return;
      }

      const raw = readFileSync(HD32_PATH);
      const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const patched = applyBootopts(rawBytes, buildDnsBootopts());

      // ---- LAN: switch + DNS host, machine NIC as a port ----
      const lan = new EthernetSwitch();
      const queries: Uint8Array[] = [];
      // First lookup answers 93.184.216.34, second 34.216.184.93 — the
      // distinct addresses prove each config path independently.
      const answers: Ipv4[] = [[93, 184, 216, 34], [34, 216, 184, 93]];
      const dns = new DnsHost({
        resolve: (query) => {
          const ip = answers[queries.length] ?? [0, 0, 0, 0];
          queries.push(query);
          return Promise.resolve(buildAnswer(query, ip));
        },
      });
      dns.attachTo(lan);

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

      // ---- boot to shell, join the LAN ----
      const r1 = traceRun(m, { tracer, maxInstructions: 16_000_000 });
      expect(r1.reason).not.toBe('error');
      expect(transcript()).toContain('eth: ne0 at 300, irq 5');
      expect(transcript()).toMatch(/# *$/);

      injectLine(m, tracer, 'net start ne0\n');
      const r2 = traceRun(m, { tracer, maxInstructions: 10_000_000 });
      expect(r2.reason).not.toBe('error');

      // ---- lookup 1: explicit server argument ----
      // The TCP exchange up to the query is synchronous within the run
      // (SYN|ACK and the query's ACK inject mid-instruction); in_resolv
      // then blocks in read() until a batch boundary lets the resolver
      // promise settle and the answer transmit.
      injectLine(m, tracer, 'nslookup example.com 10.0.2.3\n');
      await runUntil(m, tracer, () => /example\.com is /.test(transcript()));
      expect(queries).toHaveLength(1);
      expect(transcript()).toMatch(/example\.com is 93\.184\.216\.34/);

      // ---- lookup 2: no server argument — the DNSIP bootopts stamp ----
      injectLine(m, tracer, 'nslookup example.com\n');
      await runUntil(m, tracer, () => /example\.com is 34\./.test(transcript()));
      expect(queries).toHaveLength(2);
      expect(transcript()).toMatch(/example\.com is 34\.216\.184\.93/);

      // Both connections closed cleanly (in_resolv closes after read).
      expect(dns.tcp.connectionCount).toBe(0);
      expect(dns.queriesResolved).toBe(2);
      expect(dns.servfailsSent).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
