/**
 * Unit tests for the WorkerHost TX-channel wiring (Phase 9.1).
 *
 * These pin down the invariant Outcome A relies on: both the UART TX
 * sink and `BrowserConsole.writeChar` push into the same shared TX
 * buffer that `runUntil` flushes once per batch via `tx` postMessage.
 *
 * If either path becomes silently disconnected from the buffer — say a
 * future refactor wires UART straight to `post()` and forgets the BIOS
 * console — these tests fail before the user sees a 3-second blank
 * window in the browser.
 *
 * The tests use a stub 1.44 MB image filled with HLT (0xF4) so boot
 * gets to the CPU run loop without doing any real work; we then poke
 * `machine.console.writeChar` and `machine.uart.transmit` directly
 * and observe the TX flush they produce.
 */

import { describe, it, expect } from 'vitest';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';

/**
 * Fabricate a 1.44 MB floppy image whose boot sector and code area are
 * all HLT (0xF4) so the CPU halts immediately on boot. We never actually
 * need it to do anything — we just need a geometry-valid image that the
 * WorkerHost will accept.
 */
function haltImage(): Uint8Array {
  const bytes = new Uint8Array(1474560);
  bytes.fill(0xF4);
  return bytes;
}

async function bootedHost(): Promise<{
  host: WorkerHost;
  messages: WorkerToMainMessage[];
}> {
  const messages: WorkerToMainMessage[] = [];
  const host = new WorkerHost({
    post: (msg) => messages.push(msg),
    fetchImage: async () => haltImage(),
    autoRun: false,
  });
  host.handleMessage({ type: 'boot', config: { imageBytes: haltImage() } });
  await host.whenIdle();
  return { host, messages };
}

function txOnly(messages: readonly WorkerToMainMessage[]): readonly Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const m of messages) if (m.type === 'tx') out.push(m.bytes);
  return out;
}

function flatten(chunks: readonly Uint8Array[]): number[] {
  const out: number[] = [];
  for (const c of chunks) for (const b of c) out.push(b);
  return out;
}

describe('WorkerHost — TX channel wiring', () => {
  it('routes BrowserConsole.writeChar bytes into the same flush as UART TX', async () => {
    const { host, messages } = await bootedHost();
    const machine = host.machine;
    expect(machine).not.toBeNull();
    if (!machine) return;
    expect(machine.console).not.toBeNull();
    if (!machine.console) return;

    const before = messages.length;

    // Mix BIOS-console and UART writes; both are expected to land in
    // the same TX buffer that flushTx drains at the end of the batch.
    // The UART's TX path runs through writeByte(THR) → onTransmit
    // callback (the worker host's `uartTransmit` config); the BIOS
    // console path runs through console.writeChar → BrowserConsole
    // #txSink. Both terminate at the same shared txBuffer.
    const THR = 0x3F8;
    machine.console.writeChar(0x41);          // 'A' — BIOS path
    machine.uart.writeByte(THR, 0x42);        // 'B' — UART path
    machine.console.writeChar(0x43);          // 'C' — BIOS again
    machine.uart.writeByte(THR, 0x44);        // 'D' — UART again

    // Drive a one-step run to trigger the per-batch flush. The CPU's
    // first instruction is HLT, which immediately leaves the CPU
    // halted; the run loop then advances the clock for halt-spins,
    // and the loop body's `flushTx` at the end of the batch fires.
    host.runUntil(1);

    const newMessages = messages.slice(before);
    const txChunks = txOnly(newMessages);
    expect(txChunks.length).toBeGreaterThan(0);
    const all = flatten(txChunks);
    // Both BIOS writes and UART writes must appear, interleaved as
    // emitted, in the order they were submitted.
    expect(all.slice(0, 4)).toEqual([0x41, 0x42, 0x43, 0x44]);
  });

  it('coalesces multiple writeChar bytes into a single tx postMessage per batch', async () => {
    const { host, messages } = await bootedHost();
    const machine = host.machine;
    if (!machine || !machine.console) return;

    const before = messages.length;
    for (const ch of 'hello') machine.console.writeChar(ch.charCodeAt(0));
    host.runUntil(1);

    const newMessages = messages.slice(before);
    const txChunks = txOnly(newMessages);
    // Coalescing: 5 bytes should arrive in 1 tx message, not 5.
    expect(txChunks.length).toBe(1);
    expect(Array.from(txChunks[0]!)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('does not emit a tx message when no bytes have been buffered', async () => {
    const { host, messages } = await bootedHost();
    if (!host.machine) return;

    const before = messages.length;
    // Run with no console / UART writes — flushTx skips the post.
    host.runUntil(1);

    const newMessages = messages.slice(before);
    const txChunks = txOnly(newMessages);
    expect(txChunks.length).toBe(0);
  });

  it('keeps BIOS-console and UART paths independent across reset', async () => {
    const { host, messages } = await bootedHost();
    expect(host.machine?.console).not.toBeNull();
    if (!host.machine?.console) return;

    host.machine.console.writeChar(0x58);     // 'X' before reset
    host.runUntil(1);

    // Reset tears the machine down; subsequent boot rebuilds it.
    host.handleMessage({ type: 'reset' });
    await host.whenIdle();

    host.handleMessage({ type: 'boot', config: { imageBytes: haltImage() } });
    await host.whenIdle();
    if (!host.machine?.console) return;

    const before = messages.length;
    host.machine.console.writeChar(0x59);     // 'Y' after reboot
    host.runUntil(1);

    const newMessages = messages.slice(before);
    const allBytes = flatten(txOnly(newMessages));
    // The post-reboot batch carries 'Y' but not a stale 'X' from
    // before reset (the buffer was cleared in `#teardownMachine`).
    expect(allBytes).toContain(0x59);
    expect(allBytes).not.toContain(0x58);
  });
});
