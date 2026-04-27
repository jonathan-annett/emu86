/**
 * Worker-host end-to-end integration test (Phase 9).
 *
 * Drives `WorkerHost` through its message API only — boot via the same
 * serial-console image the Phase 8 harness uses, assert the expected boot
 * banner appears in collected `tx` messages, then inject `echo
 * browser-ok\n` via an `rx` message and assert the kernel echoes it back
 * + prints `browser-ok`.
 *
 * Same image-prep strategy as `tests/integration/elks-serial.test.ts`: load
 * `fd1440-fat.img`, in-place /bootopts overwrite to switch the kernel to
 * `console=ttyS0,9600` + `init=/bin/sh`. Sharing this byte-for-byte with
 * the Phase 8 test is deliberate — both tests boot the same kernel image,
 * but through different I/O surfaces.
 *
 * Instruction caps: 8M for boot to `# `, 4M for the command round-trip.
 * Same caps as Phase 8 — empirically the worker host's chunked loop runs
 * in roughly the same wall time as `traceRun`. The `runUntil` driver
 * returns synchronously (autoRun: false), so the test reads collected TX
 * messages immediately without awaiting macrotasks.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type {
  WorkerToMainMessage,
} from '../../src/browser/protocol.js';

const BOOTOPTS_HEADER = '## /bootopts';
const BOOTOPTS_SIZE = 1024;

function buildBootopts(): Buffer {
  const text = [
    '## /bootopts emu86 serial console build',
    'hma=kernel',
    'console=ttyS0,9600',
    'init=/bin/sh',
    '',
  ].join('\n');
  const buf = Buffer.alloc(BOOTOPTS_SIZE, 0x00);
  buf.write(text, 0, 'ascii');
  return buf;
}

function loadSerialImage(): Uint8Array | null {
  // Prefer the pre-built serial image (same source the browser harness
  // serves at `/elks-serial.img`). Fall back to in-place /bootopts edit
  // of the legacy fd1440-fat.img, identical to the Phase 8 test.
  const prebuilt = resolve('reference/elks-images-serial', 'fd1440-fat-serial.img');
  if (existsSync(prebuilt)) {
    return new Uint8Array(readFileSync(prebuilt));
  }
  const legacy = resolve('reference/elks-images', 'fd1440-fat.img');
  if (!existsSync(legacy)) return null;
  const original = readFileSync(legacy);
  const offset = original.indexOf(Buffer.from(BOOTOPTS_HEADER, 'ascii'));
  if (offset < 0) {
    throw new Error('No /bootopts header found in fd1440-fat.img');
  }
  const modified = Buffer.from(original);
  buildBootopts().copy(modified, offset);
  return new Uint8Array(modified);
}

function collectTxString(messages: readonly WorkerToMainMessage[]): string {
  let s = '';
  for (const m of messages) {
    if (m.type === 'tx') {
      for (const b of m.bytes) s += String.fromCharCode(b);
    }
  }
  return s;
}

describe('WorkerHost — browser harness end-to-end', () => {
  it('boots to a # prompt, echoes injected input, prints command output', async () => {
    const imageBytes = loadSerialImage();
    if (imageBytes === null) {
      throw new Error(
        'No serial-console image found. Build via `npm run build:elks-serial-image` ' +
        'or place fd1440-fat.img under reference/elks-images/.',
      );
    }

    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({
      post: (msg) => messages.push(msg),
      // Stub fetch — the test passes imageBytes directly via the boot
      // config, so the URL path is never taken. This mirrors how the
      // production worker would behave with a successful HTTP fetch.
      fetchImage: async () => imageBytes,
      autoRun: false,
    });

    // ----- Phase 1: boot + reach `# ` prompt -----
    host.handleMessage({ type: 'boot', config: { imageBytes } });
    await host.whenIdle();

    // The `ready` message is emitted by boot.
    expect(messages.find((m) => m.type === 'ready')).toBeDefined();

    const r1 = host.runUntil(8_000_000);
    expect(r1.reason).not.toBe('error');
    expect(r1.reason).not.toBe('halt-spin-exhausted');

    const txAfterBoot = collectTxString(messages);
    expect(txAfterBoot).toContain('Direct console, scan kbd');
    expect(txAfterBoot).toContain('VFS: Mounted root device');
    expect(txAfterBoot).toMatch(/# *$/);

    // ----- Phase 2: inject "echo browser-ok\n" via an rx message -----
    const cmd = 'echo browser-ok\n';
    const rxBytes = new Uint8Array(cmd.length);
    for (let i = 0; i < cmd.length; i++) rxBytes[i] = cmd.charCodeAt(i);
    const txCountBeforeCmd = messages.length;
    host.handleMessage({ type: 'rx', bytes: rxBytes });

    const r2 = host.runUntil(4_000_000);
    expect(r2.reason).not.toBe('error');
    expect(r2.reason).not.toBe('halt-spin-exhausted');

    const phase2Tx = collectTxString(messages.slice(txCountBeforeCmd));
    expect(phase2Tx).toContain('echo browser-ok');
    expect(phase2Tx).toContain('browser-ok');
    expect(phase2Tx).toMatch(/# *$/);
  }, 30_000);

  it('coalesces TX bytes into chunked tx messages, not one-per-byte', async () => {
    // Spot-check the brief's "TX coalescing matters" requirement: across
    // a full boot we expect dozens of tx messages with multi-byte payloads,
    // not thousands of single-byte messages.
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

    const txMessages = messages.filter((m) => m.type === 'tx');
    expect(txMessages.length).toBeGreaterThan(0);

    // Count single-byte vs multi-byte TX messages. The default batch size
    // (5000 instructions) almost always produces multi-byte coalesced
    // messages once the kernel banner is streaming. This bound is loose
    // (>= 5 bytes/message average) — it's just a regression guard against
    // an accidental "post per byte" change.
    let totalBytes = 0;
    for (const m of txMessages) {
      if (m.type === 'tx') totalBytes += m.bytes.length;
    }
    expect(totalBytes / txMessages.length).toBeGreaterThan(5);
  }, 30_000);

  it('reports unrecognised image sizes via an error message', async () => {
    const messages: WorkerToMainMessage[] = [];
    const host = new WorkerHost({
      post: (msg) => messages.push(msg),
      autoRun: false,
    });
    host.handleMessage({
      type: 'boot',
      // 1024 bytes is neither 1.44M nor 1.2M — should error out.
      config: { imageBytes: new Uint8Array(1024) },
    });
    await host.whenIdle();

    const err = messages.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    if (err && err.type === 'error') {
      expect(err.message).toMatch(/unrecognised image size/i);
    }
  });
});
