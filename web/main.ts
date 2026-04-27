/**
 * Main-thread bootstrap for the browser harness.
 *
 * - Constructs an xterm.js Terminal.
 * - Spawns the emulator worker.
 * - Wires worker → terminal (`tx` → `term.write(bytes)`) and terminal →
 *   worker (`term.onData` → `rx` postMessage).
 * - Triggers boot by posting `{type:'boot', config:{imageUrl:'/elks-serial.img'}}`.
 *
 * No frameworks. The `<div id="terminal">` is the host container; xterm.js
 * fills it. Resize is handled by xterm's FitAddon.
 *
 * The first ~few seconds of boot before `set_console(boot_console)`
 * redirects produce no UART output (same as the Node serial harness); the
 * terminal will look blank for that window after the welcome line.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from '../src/browser/protocol.js';

const IMAGE_URL = '/elks-serial.img';

function init(): void {
  const container = document.getElementById('terminal');
  if (!container) {
    throw new Error('main.ts: missing #terminal container');
  }

  const term = new Terminal({
    cursorBlink: false,
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
    fontSize: 14,
    theme: {
      background: '#000000',
      foreground: '#e0e0e0',
      cursor: '#e0e0e0',
    },
    convertEol: false,
    scrollback: 10_000,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();
  window.addEventListener('resize', () => {
    try { fit.fit(); } catch { /* ignore — first paint can race resize */ }
  });

  term.writeln('emu86 — ELKS in the browser');
  term.writeln(`Image: ${IMAGE_URL}`);
  term.writeln('Booting... (the first few seconds before the kernel redirects');
  term.writeln('printk to ttyS0 produce no output; this is expected.)');
  term.writeln('');

  // Vite picks up the worker via the `new URL(...) + { type: 'module' }`
  // pattern — keeps imports type-checked and lets the bundler emit the
  // worker as a separate chunk.
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'emu86-worker',
  });

  worker.addEventListener('message', (event: MessageEvent<WorkerToMainMessage>) => {
    const msg = event.data;
    if (msg.type === 'tx') {
      term.write(msg.bytes);
      return;
    }
    if (msg.type === 'ready') {
      // Boot started. The kernel banner streams via TX as soon as
      // set_console redirects.
      return;
    }
    if (msg.type === 'halted') {
      term.writeln('');
      term.writeln(`[emu86: halted — ${msg.reason}]`);
      return;
    }
    if (msg.type === 'error') {
      term.writeln('');
      term.writeln(`[emu86: error — ${msg.message}]`);
      if (msg.stack) {
        for (const line of msg.stack.split('\n')) term.writeln(line);
      }
      return;
    }
  });

  const encoder = new TextEncoder();
  term.onData((data: string) => {
    const bytes = encoder.encode(data);
    const msg: MainToWorkerMessage = { type: 'rx', bytes };
    worker.postMessage(msg);
  });

  const boot: MainToWorkerMessage = {
    type: 'boot',
    config: { imageUrl: IMAGE_URL },
  };
  worker.postMessage(boot);

  // Page unload cleans up workers automatically; no manual teardown needed.
}

init();
