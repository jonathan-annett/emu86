/**
 * ELKS-boot integration test — Phase 4 (PS/2 + A20).
 *
 * Re-runs the ELKS boot scenario on top of the headless 8042 keyboard
 * controller added in this brief. The Phase 3 stuck point — a polling
 * loop on port 0x64 bit 0 (OBF) that never escaped because the open-bus
 * 0xFF kept OBF set — should now exit on the first iteration.
 *
 * Asserts on observable progress past that point:
 *
 *   - Trace shows port 0x64 was both read AND written with command 0xD1
 *     (the canonical "Write Output Port" command, used to enable A20).
 *   - The keyboard controller's `a20Enabled` flag ends up true (ELKS
 *     completed the A20-enable sequence).
 *   - The Console captured strictly more bytes than Phase 3's 154-byte
 *     ceiling — i.e. the kernel got further than just "ELKS Setup .........FHt".
 *
 * The "what's the new stuck point" question is documented in
 * `PS2_A20_REPORT.md`; this test only proves we got past the old one.
 *
 * XMS-era rewrite (2026-07-16): the honest INT 15h AH=88h (the
 * emu86-xms-brief M1 fix that killed the 0x8800 phantom) ended the
 * A20 dance this test used to observe — and it went red for the
 * right reason. On a 1 MiB machine ELKS now sees 0 extended KB and
 * skips the 8042 A20 sequence entirely; on a >1 MiB machine A20 is
 * already on (no 1 MB wrap under the wider address mask), so the
 * test-first kernel never pokes the controller either. The 0xD1
 * enable path is unreachable BY DESIGN now ("A20 always-on; the 8042
 * flag stays decorative" — the xms brief superseding PS2_A20_REPORT).
 *
 * What this test guards TODAY: (1) the phantom stays dead — if
 * AH=88h ever regresses to leaving AX untouched, ELKS believes in
 * 34 MB again and resumes poking the 8042, which fails the
 * no-A20-attempt assertions below; (2) the boot still makes it past
 * the old Phase 3 wall.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import {
  Tracer,
  traceRun,
  type TraceEvent,
  type IoEvent,
} from '../../src/diagnostics/index.js';

const FD1440 = { cylinders: 80, heads: 2, sectorsPerTrack: 18 };

function loadImage(filename: string): InMemoryDisk | null {
  const path = resolve('reference/elks-images', filename);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return new InMemoryDisk({ geometry: FD1440, contents: bytes });
}

function iosOf(events: ReadonlyArray<TraceEvent>): IoEvent[] {
  return events.filter((e): e is IoEvent => e.type === 'io');
}

describe('ELKS boot — Phase 4 wall stays passed; the A20 dance stays retired (XMS era)', () => {
  it('fd1440-minix.img: honest AH=88h means no 8042 A20 attempt, and boot prints past the Phase 3 wall', () => {
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
    // The drain loop alone burns ~200k IO events in Phase 3 timing terms.
    // We keep IO events here (the A20-sequence assertion needs them) but
    // drop instructions/memWrites — we don't assert on those, and they'd
    // dominate the ring buffer over a 2M-instruction run.
    const tracer = new Tracer({
      capacity: 200_000,
      kinds: ['int', 'trap', 'io', 'intService'],
    });
    m.reset();

    const result = traceRun(m, { tracer, maxInstructions: 2_000_000 });
    const events = tracer.drain();

    // The run shouldn't error. Either it halts (CPU executed HLT) or hits
    // the instruction limit; both are acceptable outcomes for this test —
    // we're proving forward progress, not that the kernel completes.
    expect(result.reason).not.toBe('error');

    // ----- The phantom stays dead: no 8042 A20 attempt -----
    // With AH=88h honestly reporting 0 extended KB on this 1 MiB
    // machine, ELKS never issues the A20-enable command. A 0xD1 write
    // to port 0x64 reappearing here means the honest sizing regressed
    // (an unhandled AH=88h leaves AX = 0x8800 — the 34 MB phantom —
    // and ELKS resumes the dance this test used to watch).
    const ios = iosOf(events);
    const writesTo64 = ios.filter((e) => e.dir === 'out' && e.port === 0x64);
    const d1Writes = writesTo64.filter((e) => e.value === 0xD1);
    expect(d1Writes.length).toBe(0);

    // The decorative flag sits at its always-on default — the boot
    // never needed to touch the output port to get there.
    expect(m.keyboardController.a20Enabled).toBe(true);

    // ----- Console captured more than Phase 3's 154 bytes -----
    // This is the "we got further" assertion. The exact extra content is
    // not pinned (see report) — different kernel versions print different
    // banners post-A20. We assert a permissive lower bound that any forward
    // progress past the Phase 3 wall must beat.
    expect(console_.outputBytes.length).toBeGreaterThan(154);
  });
});
