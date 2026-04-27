/**
 * ELKS interactive harness integration test (Phase 7).
 *
 * Drives the same ELKS boot Phase 6 used, but with the new keyboard +
 * CGA-mirror plumbing wired and a scripted "root\n" sequence delivered
 * via the 8042 controller. Asserts:
 *
 *   - Boot still reaches the post-mount banner (no regression).
 *   - The CGA mirror captured the kernel banner stream.
 *   - The framebuffer contains a shell prompt indicator after login —
 *     specifically, the BusyBox-style hash prompt or the working
 *     directory marker that ELKS's `/bin/sh` writes after `/etc/profile`.
 *
 * Why scripted bytes rather than real stdin: tests must be deterministic
 * and headless. The harness's stdin pump is bypassed; we feed the
 * keyboard controller directly via `injectScancodes`, exactly as the
 * pump would have.
 *
 * Why inject before the run rather than between phases: ELKS's
 * `console-direct` keyboard driver puts every received byte into the
 * console ring buffer (`Console_conin`). Whatever process reads from
 * `/dev/tty1` (init, login, sh) drains that buffer in arrival order.
 * Pre-injecting "root\n" sits the bytes in the buffer until login()
 * reads them; this is robust against minor timing changes in the boot
 * cadence.
 *
 * Instruction cap: 15M is well past the empirical login: prompt
 * (~7M per the Phase 6 report) plus several million for /etc/rc.sys,
 * the login program, /etc/profile, and /bin/sh's first prompt write.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';
import {
  installCGAMirror,
  CapturingCGASink,
} from '../../src/diagnostics/cga-mirror.js';
import { ScancodeTranslator } from '../../src/console/scancode-translator.js';

const FD1440 = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };

function loadImage(filename: string): InMemoryDisk | null {
  const path = resolve('reference/elks-images', filename);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return new InMemoryDisk({ geometry: FD1440, contents: bytes });
}

/** Read the 80x25 CGA text framebuffer at 0xB8000 as printable lines. */
function dumpVideoText(machine: IBMPCMachine): string {
  const lines: string[] = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
      const ch = machine.memory.readByte(0xB8000 + (row * 80 + col) * 2);
      line += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

describe('ELKS Phase 7 — interactive harness wiring', () => {
  it('scripted "root\\n" reaches the # shell prompt', () => {
    const disk = loadImage('fd1440-minix.img');
    if (disk === null) {
      throw new Error(
        'reference/elks-images/fd1440-minix.img not found. Place ELKS images in that directory before running.',
      );
    }

    const console_ = new InMemoryConsole();
    const m = new IBMPCMachine({
      disk,
      console: console_,
      hostClock: new InMemoryHostClock(),
      cyclesPerPitTick: 4,
    });

    const sink = new CapturingCGASink();
    installCGAMirror(m, { sink });

    m.reset();

    // Two-phase run mirroring how a live user interacts: the kernel
    // boots to the `login:` prompt with no input, then we inject
    // "root\n" and let the run continue. Why two-phase: ELKS's
    // `kbd_init()` calls `kb_read()` once with IRQs disabled, which
    // drains a single scancode from the controller's output buffer
    // *before* `keyboard_irq` is wired in. Pre-injecting "root\n"
    // would lose the leading 'r'-press to that drain. The live harness
    // never hits this because the user types after the prompt; the
    // scripted test follows the same pattern.
    const tracer = new Tracer({
      capacity: 50_000,
      kinds: ['intService', 'trap'],
    });

    const r1 = traceRun(m, { tracer, maxInstructions: 8_000_000 });
    expect(r1.reason).not.toBe('error');
    expect(r1.reason).not.toBe('halt-spin-exhausted');

    // Sanity: the boot reached login: in phase 1.
    const screenAfterBoot = dumpVideoText(m);
    expect(screenAfterBoot).toContain('login:');

    // Inject "root\n" via the same translator path the live harness uses.
    const translator = new ScancodeTranslator();
    const scans = translator.feed([
      0x72, 0x6F, 0x6F, 0x74, 0x0A,            // "root\n"
    ]);
    expect(scans.length).toBeGreaterThan(0);
    m.keyboardController.injectScancodes(scans);

    const r2 = traceRun(m, { tracer, maxInstructions: 5_000_000 });
    expect(r2.reason).not.toBe('error');
    expect(r2.reason).not.toBe('halt-spin-exhausted');

    const screen = dumpVideoText(m);

    // ----- Phase 6 invariant still holds (no regression on boot path) -----
    expect(screen).toContain('Mounted root device');
    expect(screen).toContain('/dev/fd0');

    // ----- CGA mirror captured the banner stream -----
    expect(sink.text).toContain('Mounted root device');

    // ----- The login prompt received "root" (echoed by the kernel tty) -----
    expect(screen).toContain('login: root');

    // ----- All injected scancodes were consumed by the kernel -----
    const remaining =
      m.keyboardController.pendingScancodeCount +
      (m.keyboardController.outputBufferFull ? 1 : 0);
    expect(remaining).toBe(0);

    // ----- Shell prompt: BusyBox-style `#` in column 0 of some row -----
    const promptRowFound = screen
      .split('\n')
      .some((line) => line.startsWith('# '));
    expect(promptRowFound).toBe(true);

    // ----- The CGA mirror positioned the cursor before writing the prompt -----
    // Phase 7.1: the mirror prefixes each character byte with an ANSI
    // cursor-position sequence `ESC [ row ; col H` derived from the
    // framebuffer write address. Don't pin the row aggressively (it
    // depends on whether the screen scrolled by the time the prompt
    // landed, which depends on the boot transcript length); just
    // require that *some* positioning sequence precedes the `#` cell
    // somewhere in the captured stream.
    expect(sink.text).toMatch(/\x1B\[\d+;\d+H#/);
  });

  it('harness-style wiring (mirror + translator + IRQ 1) does not regress the boot path', () => {
    // Smoke check: install the same plumbing the live harness uses but
    // never inject any input. The boot must still reach the post-mount
    // banner, exactly as Phase 6's test asserted with no plumbing.
    const disk = loadImage('fd1440-minix.img');
    if (disk === null) return;
    const console_ = new InMemoryConsole();
    const m = new IBMPCMachine({
      disk,
      console: console_,
      hostClock: new InMemoryHostClock(),
      cyclesPerPitTick: 4,
    });
    const sink = new CapturingCGASink();
    const teardown = installCGAMirror(m, { sink });

    // Construct the translator + check that no input means no scancode
    // injection. The keyboard controller stays headless-quiet.
    const translator = new ScancodeTranslator();
    expect(translator.feed([])).toEqual([]);

    m.reset();
    const tracer = new Tracer({ capacity: 1000, kinds: ['intService'] });
    const result = traceRun(m, { tracer, maxInstructions: 4_000_000 });

    expect(result.reason).not.toBe('error');
    expect(result.reason).not.toBe('halt-spin-exhausted');
    expect(sink.text).toContain('Mounted root device');
    expect(m.keyboardController.outputBufferFull).toBe(false);
    expect(m.keyboardController.pendingScancodeCount).toBe(0);

    teardown();
  });
});
