/**
 * ELKS reads the CMOS RTC (RTC addendum acceptance, 2026-07-15).
 *
 * Boots stock `hd32-minix.img` (init=/bin/sh) and runs the guest's own
 * `clock -s -u` — the exact command /etc/rc.sys runs at every real
 * boot — then `date`. Before the RTC existed the guest was stuck at
 * its kernel default (observed in the field: Mon Oct 21 1991); with
 * the chip at 0x70/0x71 the guest adopts the host clock, which in this
 * test is the deterministic InMemoryHostClock default of
 * 2026-01-01 00:00 (a Thursday).
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
import { applyBootopts } from '../probe/surveys/survey-runner.js';

const HD32_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const BOOTOPTS_SIZE = 1024;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

function buildBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 rtc integration',
    'console=ttyS0,9600',
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
    traceRun(m, { tracer, maxInstructions: 20_000 });
  }
}

describe('RTC — the guest sets its date from the CMOS chip', () => {
  it(
    "the stock image's own `clock -s -u` adopts the host clock",
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
      const patched = applyBootopts(rawBytes, buildBootopts());

      const txBytes: number[] = [];
      const m = new IBMPCMachine({
        disk: new InMemoryDisk({ geometry: HD32_GEOMETRY, contents: patched }),
        diskClass: 'hard-disk',
        console: new InMemoryConsole(),
        hostClock: new InMemoryHostClock(), // 2026-01-01 00:00:00, Thursday
        cyclesPerPitTick: 4,
        uartTransmit: (byte: number) => txBytes.push(byte),
      });
      m.reset();

      const tracer = new Tracer({ capacity: 50_000, kinds: ['intService', 'trap'] });
      const transcript = (): string => String.fromCharCode(...txBytes);

      const r1 = traceRun(m, { tracer, maxInstructions: 16_000_000 });
      expect(r1.reason).not.toBe('error');
      expect(transcript()).toMatch(/# *$/);

      // The exact command rc.sys runs at every real boot.
      injectLine(m, tracer, 'clock -s -u\n');
      const r2 = traceRun(m, { tracer, maxInstructions: 2_000_000 });
      expect(r2.reason).not.toBe('error');

      injectLine(m, tracer, 'date\n');
      const r3 = traceRun(m, { tracer, maxInstructions: 2_000_000 });
      expect(r3.reason).not.toBe('error');

      // Thu Jan  1 00:00:0x 2026 — and definitely not Oct 1991.
      const out = transcript();
      expect(out).toMatch(/Thu Jan {1,2}1 00:0\d:\d\d 2026/);
      expect(out).not.toMatch(/1991/);
    },
    TEST_TIMEOUT_MS,
  );
});
