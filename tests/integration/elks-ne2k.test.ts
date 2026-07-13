/**
 * ELKS ↔ NE2000 end-to-end (Phase 14 M3a acceptance).
 *
 * Boots the stock `hd32-minix.img` with a /bootopts carrying
 * `ne0=5,0x300,,0x80` (IRQ 5 — the kernel default 12 is unreachable
 * behind emu86's single master PIC) and proves, against the unmodified
 * ELKS ne2k driver:
 *
 *   1. **Detection**: boot log prints `eth: ne0 at 300, irq 5` with
 *      the emu86 MAC — not `not found`.
 *   2. **Transmit**: `echo ... > /dev/ne0` in the guest opens the
 *      device (request_irq(5), reset, init, start — the full
 *      ne2k-asm.S path) and the frame arrives at the host `nicTransmit`
 *      sink, padded to the driver's 64-byte minimum.
 *   3. **Receive**: with the guest blocked in `dd if=/dev/ne0`, a
 *      host-injected frame wakes it via PIC IRQ 5 and the guest's
 *      md5sum of the first 64 bytes matches the host's — byte-exact
 *      delivery through the ring buffer.
 *
 * Skips with a pointer when the fixture is absent (Phase 13.1
 * convention).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';
import { NE2K_DEFAULT_MAC } from '../../src/devices/ne2000.js';
import { applyBootopts } from '../probe/surveys/survey-runner.js';

const HD32_GEOMETRY = { cylinders: 63, heads: 16, sectorsPerTrack: 63 };
const HD32_PATH = resolve('reference/elks-images-hd', 'hd32-minix.img');

const BOOTOPTS_SIZE = 1024;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Serial console + shell init (deterministic, like the Phase 10.2
 * test) + the ne0 line that moves the driver to IRQ 5. `ne0=` is a
 * kernel option (netif_parms), consumed before init argv assembly, so
 * MAX_INIT_SLEN is not in play.
 */
function buildNe2kBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 ne2k integration',
    'console=ttyS0,9600',
    'ne0=5,0x300,,0x80',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

/** Feed a command line through the UART in FIFO-sized chunks. */
function injectLine(m: IBMPCMachine, tracer: Tracer, line: string): void {
  for (let off = 0; off < line.length; off += 12) {
    const chunk = line.slice(off, off + 12);
    for (let i = 0; i < chunk.length; i++) m.uart.injectByte(chunk.charCodeAt(i));
    traceRun(m, { tracer, maxInstructions: 200_000 });
  }
}

describe('Phase 14 M3a — stock ELKS drives the NE2000', () => {
  it(
    'detects ne0 at boot, transmits guest frames to the host, receives injected frames byte-exactly',
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
      const patched = applyBootopts(rawBytes, buildNe2kBootopts());

      const txBytes: number[] = [];
      const frames: Uint8Array[] = [];
      const m = new IBMPCMachine({
        disk: new InMemoryDisk({ geometry: HD32_GEOMETRY, contents: patched }),
        diskClass: 'hard-disk',
        console: new InMemoryConsole(),
        hostClock: new InMemoryHostClock(),
        cyclesPerPitTick: 4,
        uartTransmit: (byte: number) => txBytes.push(byte),
        nicTransmit: (frame: Uint8Array) => frames.push(frame),
      });
      m.reset();

      const tracer = new Tracer({ capacity: 50_000, kinds: ['intService', 'trap'] });
      const transcript = (): string => String.fromCharCode(...txBytes);

      // ---- 1. boot to shell; assert detection line ----
      const r1 = traceRun(m, { tracer, maxInstructions: 16_000_000 });
      expect(r1.reason).not.toBe('error');
      const boot = transcript();
      expect(boot).toContain('VFS: Mounted root device');
      expect(boot).toMatch(/# *$/);
      // The whole point of M3a, in one kernel log line:
      expect(boot).toContain('eth: ne0 at 300, irq 5');
      expect(boot).not.toContain('irq 5 not found');
      const macText = NE2K_DEFAULT_MAC.map((b) => b.toString(16).padStart(2, '0')).join(':');
      expect(boot).toContain(`MAC ${macText}`);

      // ---- 2. transmit: guest → host ----
      injectLine(m, tracer, 'echo NE2K-TX-FRAME > /dev/ne0\n');
      const r2 = traceRun(m, { tracer, maxInstructions: 6_000_000 });
      expect(r2.reason).not.toBe('error');
      expect(frames.length).toBeGreaterThanOrEqual(1);
      const sent = frames[0]!;
      // Driver pads every write to 64 bytes (ne2k.c:153, issue #133).
      expect(sent.length).toBe(64);
      const sentText = String.fromCharCode(...sent.slice(0, 14));
      expect(sentText).toBe('NE2K-TX-FRAME\n');

      // ---- 3. receive: host → guest, verified by in-guest md5 ----
      // Unicast to the device MAC (RCR=0x04 accepts unicast-to-PAR).
      const rxFrame = new Uint8Array(100);
      rxFrame.set(NE2K_DEFAULT_MAC, 0);
      rxFrame.set([0x02, 0x11, 0x22, 0x33, 0x44, 0x55], 6);
      rxFrame[12] = 0x08;
      rxFrame[13] = 0x00;
      for (let i = 14; i < rxFrame.length; i++) rxFrame[i] = (i * 7) & 0xff;

      injectLine(m, tracer, 'dd if=/dev/ne0 bs=64 count=1 2>/dev/null | md5sum\n');
      // Let dd open the device and block in read (device restarts:
      // fresh ring, running state).
      const r3 = traceRun(m, { tracer, maxInstructions: 3_000_000 });
      expect(r3.reason).not.toBe('error');

      expect(m.nic.injectFrame(rxFrame)).toBe(true);
      const r4 = traceRun(m, { tracer, maxInstructions: 8_000_000 });
      expect(r4.reason).not.toBe('error');

      const expectedMd5 = createHash('md5').update(rxFrame.slice(0, 64)).digest('hex');
      expect(transcript()).toContain(expectedMd5);
    },
    TEST_TIMEOUT_MS,
  );
});
