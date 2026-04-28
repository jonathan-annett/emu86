/**
 * Early-printk regression test (Phase 9.1).
 *
 * Asserts the brief's Outcome A invariant: bytes that ELKS emits via
 * BIOS INT 10h teletype output during the early-boot window — before
 * `set_console(/dev/ttyS0)` redirects printk to the UART — reach
 * xterm.js through the worker host's shared TX channel, just like the
 * later UART traffic does.
 *
 * The wiring path under test:
 *
 *     ELKS early_putchar (crt0.S, INT 10h AH=0x0E)
 *       → bios-services.ts int10Handler case 0x0E
 *       → ctx.console.writeChar(byte)            (Console abstraction)
 *       → BrowserConsole.writeChar               (browser-console.ts)
 *       → BrowserConsole #txSink                 (callback the host wires)
 *       → WorkerHost #txBuffer                   (shared coalescing buffer)
 *       → WorkerHost #flushTx                    (per-batch postMessage)
 *       → `tx` postMessage on the worker channel
 *       → main.ts term.write                     (xterm.js render)
 *
 * If any link breaks, xterm.js shows a blank window for ~3 seconds at
 * boot until set_console fires and UART TX takes over. The brief calls
 * that the "early-printk dead window" — closing it is what Phase 9.1
 * is about.
 *
 * The instruction budget (2_000_000) is tuned to land well before
 * set_console fires (verified empirically: the first UART TX byte
 * appears around instruction ~3M on this image), so anything that
 * shows up in TX during this window is unambiguously from the BIOS
 * console path, not the UART.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';

/** Instruction cap chosen to land before set_console / UART TX activates. */
const EARLY_PRINTK_CAP = 2_000_000;

function loadSerialImage(): Uint8Array | null {
  const p = resolve('reference/elks-images-serial', 'fd1440-fat-serial.img');
  if (!existsSync(p)) return null;
  return new Uint8Array(readFileSync(p));
}

function collectTxBytes(messages: readonly WorkerToMainMessage[]): Uint8Array {
  let total = 0;
  for (const m of messages) if (m.type === 'tx') total += m.bytes.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const m of messages) {
    if (m.type === 'tx') {
      out.set(m.bytes, off);
      off += m.bytes.length;
    }
  }
  return out;
}

function asString(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe('early-printk reaches the browser TX channel', () => {
  it('captures the ELKS Setup banner well before set_console fires', async () => {
    const imageBytes = loadSerialImage();
    if (imageBytes === null) {
      throw new Error(
        'No serial-console image found. Build via `npm run build:elks-serial-image` ' +
        'or place fd1440-fat-serial.img under reference/elks-images-serial/.',
      );
    }

    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({
      post: (msg) => messages.push(msg),
      fetchImage: async () => imageBytes,
      autoRun: false,
    });

    host.handleMessage({ type: 'boot', config: { imageBytes } });
    await host.whenIdle();

    const result = host.runUntil(EARLY_PRINTK_CAP);
    expect(result.reason).not.toBe('error');
    expect(result.reason).not.toBe('halt-spin-exhausted');

    const txBytes = collectTxBytes(messages);
    const tx = asString(txBytes);

    // The ELKS Setup banner is emitted by setup.S `putc` (which uses
    // INT 10h AH=0x0E for IBM PC builds) before the kernel even runs
    // start_kernel. If `BrowserConsole.writeChar` is wired to the TX
    // buffer, this string lands in `tx` messages within the cap.
    expect(tx).toContain('ELKS Setup');

    // The ttyS0 probe-success line is emitted by the kernel's serial
    // driver *before* `set_console` redirects printk to ttyS0; it
    // therefore travels via early_putchar (INT 10h AH=0x0E), not via
    // the UART. Same wiring as the banner.
    expect(tx).toContain('ttyS0 3f8 irq 4 16550A');

    // Coalescing is real: the bytes arrived as multi-byte tx messages,
    // not one postMessage per byte. (The brief's "TX coalescing matters"
    // requirement, scoped to the early window.)
    const txMessages = messages.filter((m) => m.type === 'tx');
    expect(txMessages.length).toBeGreaterThan(0);
    expect(txBytes.length / txMessages.length).toBeGreaterThan(5);
  }, 30_000);

  it('produces no double-print as boot crosses the set_console boundary', async () => {
    // Outcome A's failure mode if mis-implemented (e.g. wiring BIOS console
    // *and* a CGA bridge concurrently) is double-output across the
    // BIOS→UART handover. We don't have a CGA bridge in this build, but the
    // assertion guards against a future regression that adds one without
    // disabling at the boundary.
    const imageBytes = loadSerialImage();
    if (imageBytes === null) return;

    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({
      post: (msg) => messages.push(msg),
      fetchImage: async () => imageBytes,
      autoRun: false,
    });
    host.handleMessage({ type: 'boot', config: { imageBytes } });
    await host.whenIdle();
    host.runUntil(8_000_000);

    const tx = asString(collectTxBytes(messages));

    // Each unique kernel banner line should appear exactly once.
    // ("VFS: Mounted root device" is post-set_console, so it travels
    // strictly via UART; "ttyS0 3f8 irq 4 16550A" is pre-set_console
    // and travels strictly via BIOS console. Both should appear once
    // each, never twice.)
    const ttySCount = (tx.match(/ttyS0 3f8 irq 4 16550A/g) ?? []).length;
    const vfsCount = (tx.match(/VFS: Mounted root device/g) ?? []).length;
    expect(ttySCount).toBe(1);
    expect(vfsCount).toBe(1);
  }, 30_000);
});
