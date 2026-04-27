/**
 * ELKS-boot integration test — Phase 6 (root mount).
 *
 * Phase 5 (`elks-boot-phase4.test.ts` + the unblocked PIC vector base) got
 * the kernel cycling work + idle past `printk("START\n")`. Phase 6's brief
 * was: bump the cap, see how far the kernel goes.
 *
 * Outcome: with the existing devices and a higher instruction cap, the
 * kernel finishes init, exercises BIOS INT 13h sector reads to load the
 * Minix root filesystem, runs `/etc/rc.sys`, and lands on a `login:`
 * prompt — well past root mount.
 *
 * Why this assertion targets video memory (0xB8000):
 *   ELKS's `console_init()` in this image uses the `console-direct`
 *   driver, which writes characters straight to CGA text-mode video
 *   memory (one byte per char + one byte per attribute, 80x25 cells).
 *   The early-boot path (`early_putchar` → INT 10h AH=0Eh) only handles
 *   the first two `printk`s before `console_init()` swaps the kputc
 *   pointer. So everything from "Direct console..." onwards lives in
 *   the framebuffer, not the InMemoryConsole. The InMemoryConsole still
 *   captures the early-boot prefix; both are asserted here.
 *
 * The 4M-instruction cap is generously above the empirical first-mount
 * point (~2M with `cyclesPerPitTick: 4`); padding leaves slack against
 * minor performance changes elsewhere.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';

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

describe('ELKS boot — Phase 6: kernel mounts root and reaches login', () => {
  it('fd1440-minix.img: VFS mount banner appears in video memory within 4M instructions', () => {
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
    // Untraced-fast-path style tracer: drop instruction events. Keep the
    // light kinds so a regression that breaks IRQ delivery (no intService)
    // or BIOS dispatch (no trap fires) is observable from the trace alone.
    const tracer = new Tracer({
      capacity: 50_000,
      kinds: ['intService', 'trap'],
    });
    m.reset();

    const result = traceRun(m, { tracer, maxInstructions: 4_000_000 });

    // Run shouldn't error or halt-spin-exhaust. "instruction-limit" or
    // "halted" (kernel idling on HLT after work is done) are both fine.
    expect(result.reason).not.toBe('error');
    expect(result.reason).not.toBe('halt-spin-exhausted');

    // ----- Early-boot prefix made it into the InMemoryConsole -----
    // Phase 5's invariant: the kernel issues two early-printk INT 10h
    // calls before swapping the console driver. We see "INT f002 START".
    const early = console_.outputBytes
      .map((c) => String.fromCharCode(c))
      .join('');
    expect(early).toContain('INT f002 START');

    // ----- IRQs were serviced (sanity for the Phase 5 fix) -----
    const events = tracer.drain();
    const intServiceCount = events.filter((e) => e.type === 'intService').length;
    expect(intServiceCount).toBeGreaterThan(50);

    // ----- Floppy was read by the kernel (post-init disk activity) -----
    // The kernel's INT 13h sector-read handler fires at 0xF1013. ELKS
    // reads the kernel image during boot (~10s of reads) and then more
    // when mounting Minix root.
    const trap13Count = events.filter(
      (e) => e.type === 'trap' && e.vector === 0x13,
    ).length;
    expect(trap13Count).toBeGreaterThan(20);

    // ----- VFS mount banner appears in CGA video memory -----
    // This is the brief's headline assertion. ELKS's `fs/super.c` prints
    // 'VFS: Mounted root device <name> (<dev>) <fstype> filesystem.'
    // through the now-installed direct-console driver. We assert the
    // exact substring "Mounted root device" plus the device label
    // "/dev/fd0" — the kernel deduces the root device from the BIOS
    // boot-drive number.
    const screen = dumpVideoText(m);
    expect(screen).toContain('Mounted root device');
    expect(screen).toContain('/dev/fd0');
  });
});
