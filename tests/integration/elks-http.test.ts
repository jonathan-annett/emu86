/**
 * ELKS fetches the web through the HTTP gateway (Phase 15 M1 — M3d
 * acceptance).
 *
 * Boots stock `hd32-minix.img` (serial console, ne0=5, DNSIP stamp,
 * init=/bin/sh), runs the guest's own `net start ne0`, then:
 *
 *   1. `urlget http://example.com/` — the guest's own resolver asks
 *      the DnsHost (fixture answer → 93.184.216.34), then ktcp routes
 *      the off-subnet TCP :80 to the gateway MAC, where the
 *      HttpGatewayHost terminates it, reconstructs the URL
 *      (Host-header-first: urlget sends `Host:`), "fetches" from a
 *      fixture, and streams the HTTP/1.0 response back. The body
 *      must appear on the guest's stdout byte-for-byte.
 *   2. `nslookup example.com 208.67.222.222` — OpenDNS, the
 *      resolver's no-DNSIP default. Off-subnet :53 terminates at the
 *      gateway too (DNS_DOH_REPORT.md §5 parked this "until M3d"),
 *      so zero-config resolution now works.
 *
 * Same batching rules as the DNS test: fetch/resolve promises settle
 * only between traceRun batches, so batches stay small (~20k instr)
 * with a microtask flush between them (DNS_DOH_REPORT.md §4.2).
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
import { DnsAnswerCache, DnsHost } from '../../src/net/dns.js';
import { LanGateway } from '../../src/net/gateway.js';
import { HttpGatewayHost, type GatewayFetchRequest } from '../../src/net/http.js';
import type { Ipv4 } from '../../src/net/wire.js';
import { applyBootopts } from '../probe/surveys/survey-runner.js';

const HD32_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const BOOTOPTS_SIZE = 1024;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

const WEB_IP: Ipv4 = [93, 184, 216, 34];
const BODY = 'It works! Greetings from the other side of the gateway.\n';

function buildBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 http integration',
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
  for (let off = 0; off < line.length; off += 12) {
    const chunk = line.slice(off, off + 12);
    for (let i = 0; i < chunk.length; i++) m.uart.injectByte(chunk.charCodeAt(i));
    traceRun(m, { tracer, maxInstructions: 20_000 });
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function runUntil(
  m: IBMPCMachine,
  tracer: Tracer,
  done: () => boolean,
  maxInstructions = 20_000_000,
): Promise<void> {
  const BATCH = 20_000;
  for (let spent = 0; spent < maxInstructions && !done(); spent += BATCH) {
    const r = traceRun(m, { tracer, maxInstructions: BATCH });
    expect(r.reason).not.toBe('error');
    await flush();
  }
}

describe('Phase 15 M1 — ELKS urlget fetches through the HTTP gateway', () => {
  it(
    'urlget streams a fixture body to stdout; OpenDNS :53 terminates at the gateway',
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
      const patched = applyBootopts(rawBytes, buildBootopts());

      // ---- LAN: switch + DNS host + gateway + HTTP terminator ----
      const lan = new EthernetSwitch();
      const cache = new DnsAnswerCache();
      const dns = new DnsHost({
        resolve: (query) => Promise.resolve(buildAnswer(query, WEB_IP)),
        cache,
      });
      dns.attachTo(lan);
      const gateway = new LanGateway();
      gateway.attachTo(lan);

      const fetched: GatewayFetchRequest[] = [];
      const opendnsQueries: Uint8Array[] = [];
      const http = new HttpGatewayHost({
        fetchFn: (req) => {
          fetched.push(req);
          return Promise.resolve({
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'text/plain']] as Array<[string, string]>,
            body: Uint8Array.from([...BODY].map((c) => c.charCodeAt(0))),
          });
        },
        reverseLookup: (ip) => cache.lookup(ip),
        dnsResolve: (query) => {
          opendnsQueries.push(query);
          return Promise.resolve(buildAnswer(query, WEB_IP));
        },
      });
      http.attachTo(gateway);

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

      // ---- urlget: resolve via DnsHost, then HTTP through the gateway ----
      injectLine(m, tracer, 'urlget http://example.com/\n');
      await runUntil(m, tracer, () => transcript().includes('Greetings from the other side'));

      expect(fetched).toHaveLength(1);
      expect(fetched[0]?.url).toBe('http://example.com/');
      expect(fetched[0]?.method).toBe('GET');
      // urlget's own headers arrived and were forwarded (Host consumed
      // by URL reconstruction, Connection stripped as hop-by-hop).
      const names = fetched[0]?.headers.map(([n]) => n.toLowerCase()) ?? [];
      expect(names).toContain('user-agent');
      expect(names).not.toContain('host');
      expect(names).not.toContain('connection');
      expect(transcript()).toContain(BODY.trimEnd());
      expect(http.requestsServed).toBe(1);
      expect(http.badRequests).toBe(0);

      // ---- OpenDNS interception: explicit off-subnet server ----
      injectLine(m, tracer, 'nslookup example.com 208.67.222.222\n');
      await runUntil(m, tracer, () => /example\.com is 93\.184\.216\.34/.test(transcript()));
      expect(opendnsQueries.length).toBeGreaterThan(0);
      expect(http.dnsQueriesResolved).toBeGreaterThan(0);

      // Give the guest a moment to finish its closes, then check for leaks.
      await runUntil(m, tracer, () => http.tcp.connectionCount === 0, 2_000_000);
      expect(http.tcp.connectionCount).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
