/**
 * emu86 — runnable ELKS harness over serial console (Phase 8).
 *
 * Boots an ELKS floppy image whose `/bootopts` directs the kernel
 * console to /dev/ttyS0 (default `reference/elks-images-serial/fd1440-fat-serial.img`),
 * and presents a usable terminal session: stdin keystrokes flow as raw
 * bytes into the COM1 UART RX path, UART TX bytes flow back to host
 * stdout. The CGA framebuffer mirror stays available but is wired to a
 * silent sink — kernel output that still reaches 0xB8000 (e.g., the
 * ELKS Setup early splash) is discarded rather than double-printed.
 *
 * Usage:
 *   tsc -p tsconfig.cli.json
 *   node dist-cli/tools/elks/run-serial.js [imagePath] [maxInstructions]
 *
 * Or via the npm script:
 *   npm run start:elks-serial
 *
 * Optional secondary disk (Phase 11):
 *   --hdb <path>            mount as /dev/hdb (hard disk class)
 *   --fd1 <path>            mount as /dev/fd1 (floppy class)
 *   --secondary-class <c>   override class detection (`floppy` | `hard-disk`)
 *
 * Class is otherwise inferred from file size: standard floppy sizes
 * (1.44/1.2 MB) are floppy, ELKS HD sizes (32/64 MB) are hard-disk.
 *
 * Quit prefix: Ctrl-A x. Same as `tools/elks/run.ts` so the muscle
 * memory transfers between the two harnesses.
 *
 * Why no scancode translator: in serial mode, the kernel's tty layer
 * runs line discipline on the raw byte stream — backspace, line
 * buffering, signal generation on Ctrl-C, etc. — exactly like a
 * terminal connected via a real RS-232 cable. No PC/AT scancode
 * translation is involved.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { NodeConsole } from '../../src/console/console.js';
import { NodeHostClock } from '../../src/host-clock/host-clock.js';
import {
  installCGAMirror,
  type CGAMirrorSink,
} from '../../src/diagnostics/cga-mirror.js';

const DEFAULT_IMAGE = 'reference/elks-images-serial/fd1440-fat-serial.img';

import {
  loadDiskFromPath,
  parseSecondaryFlags,
  type DiskClass,
} from './secondary-disk.js';

function loadDisk(imagePath: string): InMemoryDisk {
  const abs = resolve(imagePath);
  if (!existsSync(abs)) {
    throw new Error(
      `Image not found: ${abs}\n` +
      `Build it with:\n` +
      `  node dist-cli/tools/elks-build/build-serial-image.js\n` +
      `or pass a different path as the first argument.`,
    );
  }
  return loadDiskFromPath(abs);
}

/** Drop-everything sink for the CGA mirror — serial mode doesn't use it. */
class NullCGASink implements CGAMirrorSink {
  writeChar(_byte: number): void { /* discard */ }
}

/**
 * Quit-prefix state machine — same as `tools/elks/run.ts`. The prefix
 * byte is Ctrl-A (0x01); after it, 'x'/'X' quits, a second 0x01 sends
 * a literal Ctrl-A through to the guest, anything else passes through
 * with the prefix consumed.
 */
class QuitPrefix {
  #armed = false;

  consume(byte: number, onQuit: () => void): number | null {
    if (this.#armed) {
      this.#armed = false;
      if (byte === 0x78 || byte === 0x58) {     // 'x' or 'X'
        onQuit();
        return null;
      }
      if (byte === 0x01) {                       // literal Ctrl-A
        return 0x01;
      }
      return byte;
    }
    if (byte === 0x01) {
      this.#armed = true;
      return null;
    }
    return byte;
  }
}

function printBanner(image: string, secondary: string | null): void {
  process.stdout.write('\x1b[2J\x1b[H');         // clear, cursor home
  process.stdout.write('emu86 — ELKS over serial console\n');
  process.stdout.write(`Image: ${image}\n`);
  if (secondary !== null) {
    process.stdout.write(`Secondary: ${secondary}\n`);
  }
  process.stdout.write('Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A\n');
  process.stdout.write('Booting...\n\n');
}

async function main(): Promise<void> {
  const parsed = parseSecondaryFlags(process.argv.slice(2));
  const image = parsed.positional[0] ?? DEFAULT_IMAGE;
  const maxArg = Number(parsed.positional[1] ?? '0');
  const maxInstructions = Number.isFinite(maxArg) && maxArg > 0 ? maxArg : Infinity;

  const disk = loadDisk(image);
  const secondary = parsed.secondary
    ? loadDiskFromPath(parsed.secondary.path)
    : null;
  const secondaryClass: DiskClass | undefined = parsed.secondary?.diskClass ?? undefined;

  printBanner(image, parsed.secondary?.path ?? null);

  const console_ = new NodeConsole();
  const machine = new IBMPCMachine({
    disk,
    ...(secondary
      ? {
          secondaryDisk: secondary,
          ...(secondaryClass ? { secondaryDiskClass: secondaryClass } : {}),
        }
      : {}),
    console: console_,
    hostClock: new NodeHostClock(),
    cyclesPerPitTick: 4,
    // UART TX bytes go straight to stdout. The kernel's tty line
    // discipline handles ANSI / control bytes; we just forward.
    uartTransmit: (byte: number) => {
      process.stdout.write(String.fromCharCode(byte));
    },
  });

  // Install a silent CGA mirror so framebuffer writes are absorbed (the
  // kernel still pokes 0xB8000 during early-printk before /bootopts is
  // parsed; without a mirror those writes go to memory but nothing
  // forwards them — which is exactly what we want in serial mode).
  const teardownMirror = installCGAMirror(machine, { sink: new NullCGASink() });

  const quitPrefix = new QuitPrefix();

  let stopping = false;
  const cleanQuit = (): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\n[emu86] quit — exiting.\n');
    machine.stop();
    teardownMirror();
    console_.close();
  };

  // Pump stdin → UART RX. NodeConsole already buffers stdin into
  // `readChar()`; we drain it on every tick of an interval timer that
  // runs concurrently with the run loop. The UART's RX FIFO absorbs
  // bursts; the kernel's serfast handler drains all queued bytes per
  // IRQ 4 delivery.
  const pumpInterval = setInterval(() => {
    while (console_.hasInput()) {
      const b = console_.readChar();
      if (b < 0) break;
      const passed = quitPrefix.consume(b, cleanQuit);
      if (passed === null) continue;
      machine.uart.injectByte(passed);
    }
  }, 10);

  machine.reset();

  process.on('SIGINT', cleanQuit);
  process.on('SIGTERM', cleanQuit);

  try {
    const result = await machine.run({ maxInstructions });
    process.stdout.write(
      `\n[emu86] run loop exited: reason=${result.reason}, executed=${result.executed}\n`,
    );
  } finally {
    clearInterval(pumpInterval);
    cleanQuit();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[emu86] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
