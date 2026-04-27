/**
 * emu86 — runnable ELKS harness (Phase 7).
 *
 * Boots an ELKS floppy image and presents a usable terminal session:
 * stdin keystrokes flow into the 8042 keyboard controller as scancodes,
 * CGA framebuffer writes flow back to host stdout, and the host
 * terminal's natural line discipline + ANSI handling do the rest.
 *
 * Usage:
 *   tsc -p tsconfig.cli.json
 *   node dist-cli/tools/elks/run.js [imagePath] [maxInstructions]
 *
 * Or via the npm script:
 *   npm run start:elks
 *
 * The default image is `reference/elks-images/fd1440-minix.img` — the
 * Phase 6 baseline. `maxInstructions` is optional; omit (or pass 0 / a
 * negative value) for unbounded operation, which is what an interactive
 * session wants.
 *
 * Quit prefix: Ctrl-A x. Send a literal Ctrl-A by typing Ctrl-A twice.
 * The choice mirrors `screen` / `tmux` so anyone familiar with terminal
 * multiplexers will reach for it instinctively. Ctrl-C is delivered to
 * the guest as a real Ctrl-C scancode (not host SIGINT — raw mode
 * disables that anyway), which is the correct default for an
 * interactive shell.
 *
 * Output strategy: the InMemoryConsole captures the early-boot prefix
 * (BIOS INT 10h AH=0Eh — about 187 bytes through the kernel's
 * `early_printk` window). Once `console_init` swaps to the
 * `console-direct` driver, every banner write hits 0xB8000, and the CGA
 * mirror takes over forwarding to stdout. The two paths never overlap
 * in time, so there's no double-printing.
 *
 * At the boundary between the two phases, the host terminal cursor is
 * sitting at end-of-last-early-line. The framebuffer-driven phase is
 * position-aware (each character is preceded by an ANSI cursor-position
 * sequence), so we wrap the stdout sink in a `OneShotPrefixSink` that
 * emits `ESC [ 2J ESC [ H` exactly once before the first framebuffer
 * write — clearing the early-printk transcript out of the visible region
 * and giving the framebuffer phase a clean canvas. The early-printk
 * lines remain in the terminal's scroll-back.
 *
 * What's deliberately NOT here:
 *   - A full ANSI-terminal-aware CGA emulator. The mirror is a v0
 *     stream of character bytes; full-screen redraws look ugly.
 *   - Arrow keys / function keys (no multi-byte scancode translator).
 *   - Pause/resume controls. Quit is the only meta command for v0.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { NodeConsole } from '../../src/console/console.js';
import { ScancodeTranslator } from '../../src/console/scancode-translator.js';
import { NodeHostClock } from '../../src/host-clock/host-clock.js';
import {
  installCGAMirror,
  OneShotPrefixSink,
  CLEAR_AND_HOME,
  type CGAMirrorSink,
} from '../../src/diagnostics/cga-mirror.js';

const DEFAULT_IMAGE = 'reference/elks-images/fd1440-minix.img';

const FD1440 = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };
const FD1200 = { cylinders: 80, heads: 2, sectorsPerTrack: 15 };

function geometryForSize(bytes: number): { cylinders: number; heads: number; sectorsPerTrack: number } | null {
  if (bytes === 1474560) return FD1440;
  if (bytes === 1228800) return FD1200;
  return null;
}

function loadDisk(imagePath: string): InMemoryDisk {
  const abs = resolve(imagePath);
  if (!existsSync(abs)) {
    throw new Error(
      `Image not found: ${abs}\n` +
      `Place an ELKS floppy image at that path, or pass a different one as the first argument.`,
    );
  }
  const bytes = readFileSync(abs);
  const geom = geometryForSize(bytes.length);
  if (!geom) {
    throw new Error(
      `Unrecognised image size ${bytes.length} bytes — only 1.44M (1474560) and ` +
      `1.2M (1228800) floppy images are wired up.`,
    );
  }
  return new InMemoryDisk({ geometry: geom, contents: bytes });
}

/**
 * stdout sink that filters CGA character bytes for terminal-friendly
 * output. CGA cells are filled with 0x00 by the kernel's clear-screen
 * routines; we drop those (printing NUL would do nothing visible but
 * accumulates noise in piped output). Other control characters are
 * forwarded — the host terminal interprets BEL, BS, CR, LF, ESC, etc.
 */
class StdoutCGASink implements CGAMirrorSink {
  writeChar(byte: number): void {
    if (byte === 0x00) return;
    process.stdout.write(String.fromCharCode(byte));
  }
}

/**
 * Quit-prefix state machine. The prefix byte is Ctrl-A (0x01).
 *
 *   - Default state: bytes pass through to the translator.
 *   - After receiving 0x01: wait for the next byte.
 *     - 'x' or 'X': clean exit.
 *     - 0x01: pass a single 0x01 through to the guest (the "send literal
 *       Ctrl-A" escape).
 *     - anything else: drop the prefix and pass the byte through. The
 *       prefix itself is consumed (mirrors `screen`'s behaviour).
 */
class QuitPrefix {
  #armed = false;

  /**
   * Process one stdin byte. Returns the byte the harness should hand to
   * the scancode translator, or `null` if the byte was consumed by the
   * prefix machinery. Calls `onQuit()` for clean shutdown.
   */
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
      return byte;                               // unknown prefix-arg, pass through
    }
    if (byte === 0x01) {
      this.#armed = true;
      return null;
    }
    return byte;
  }
}

function printBanner(image: string): void {
  process.stdout.write('\x1b[2J\x1b[H');         // clear, cursor home
  process.stdout.write('emu86 — ELKS in a terminal\n');
  process.stdout.write(`Image: ${image}\n`);
  process.stdout.write('Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A\n');
  process.stdout.write('Booting...\n\n');
}

async function main(): Promise<void> {
  const image = process.argv[2] ?? DEFAULT_IMAGE;
  const maxArg = Number(process.argv[3] ?? '0');
  const maxInstructions = Number.isFinite(maxArg) && maxArg > 0 ? maxArg : Infinity;

  const disk = loadDisk(image);

  printBanner(image);

  const console_ = new NodeConsole();
  const machine = new IBMPCMachine({
    disk,
    console: console_,
    hostClock: new NodeHostClock(),
    cyclesPerPitTick: 4,
  });

  // Wrap stdout in a one-shot clear-and-home so the framebuffer phase
  // starts with a clean visible region. Test sinks deliberately don't
  // get this wrapper — those assert on raw per-emit byte streams.
  const sink = new OneShotPrefixSink(new StdoutCGASink(), CLEAR_AND_HOME);
  const teardownMirror = installCGAMirror(machine, { sink });

  const translator = new ScancodeTranslator();
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

  // Pump stdin → translator → keyboard controller. NodeConsole already
  // buffers stdin into `readChar()`; we drain it on every tick of an
  // interval timer that runs concurrently with the run loop. The
  // controller's queue absorbs bursts; the kernel processes scancodes
  // in order as it services IRQ 1 between batches.
  const pumpInterval = setInterval(() => {
    while (console_.hasInput()) {
      const b = console_.readChar();
      if (b < 0) break;
      const passed = quitPrefix.consume(b, cleanQuit);
      if (passed === null) continue;
      const scans = translator.feed([passed]);
      if (scans.length > 0) machine.keyboardController.injectScancodes(scans);
    }
  }, 10);

  // Reset the machine *after* wiring; reset() re-initialises CPU + devices
  // but doesn't touch our wrapper or the stdin pump.
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
