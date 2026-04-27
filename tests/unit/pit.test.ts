import { describe, expect, it, vi } from 'vitest';
import { Clock } from '../../src/timing/clock.js';
import { PIT8254 } from '../../src/devices/pit.js';

/**
 * Unit tests for the 8254 PIT. Tests use a real `Clock` and observe the
 * PIT's behaviour via:
 *
 *   - Mock rising-edge callbacks (count of channel-N rising edges).
 *   - Inspection getters (`getChannelOutput`, `getChannelCounter`, etc.).
 *   - Direct port reads/writes via `readByte`/`writeByte`.
 *
 * Most tests use `cyclesPerPitTick: 1` so a `clock.advance(N)` produces
 * exactly N PIT ticks. That keeps the math obvious; one test exercises
 * the real-PC default (4) to confirm the divider works.
 *
 * Port layout (default basePort = 0x40):
 *   0x40 — channel 0 data port
 *   0x41 — channel 1 data port
 *   0x42 — channel 2 data port
 *   0x43 — control port
 */

const CTRL = 0x43;
const CH0 = 0x40;
const CH1 = 0x41;
const CH2 = 0x42;

interface Setup {
  clock: Clock;
  pit: PIT8254;
  warnings: string[];
  ch0Edges: () => number;
  ch1Edges: () => number;
  ch2Edges: () => number;
}

function setup(opts?: { cyclesPerPitTick?: number }): Setup {
  const clock = new Clock();
  const warnings: string[] = [];
  const ch0 = vi.fn();
  const ch1 = vi.fn();
  const ch2 = vi.fn();
  const pit = new PIT8254(clock, {
    cyclesPerPitTick: opts?.cyclesPerPitTick ?? 1,
    warn: (m) => warnings.push(m),
    onChannel0RisingEdge: ch0,
    onChannel1RisingEdge: ch1,
    onChannel2RisingEdge: ch2,
  });
  return {
    clock,
    pit,
    warnings,
    ch0Edges: () => ch0.mock.calls.length,
    ch1Edges: () => ch1.mock.calls.length,
    ch2Edges: () => ch2.mock.calls.length,
  };
}

/**
 * Build a control word for "channel <ch>, access mode lohi, mode <mode>,
 * binary counting". This is the most common programming.
 */
function controlWord(ch: 0 | 1 | 2, mode: number, accessBits = 3, bcd = false): number {
  return ((ch & 0x03) << 6) | ((accessBits & 0x03) << 4) | ((mode & 0x07) << 1) | (bcd ? 1 : 0);
}

// ============================================================
// Programming protocol
// ============================================================

describe('PIT control-word writes', () => {
  it('selects channel, mode, access mode, BCD bit', () => {
    const { pit } = setup();
    pit.writeByte(CTRL, controlWord(1, 2, 1, true));
    expect(pit.getChannelMode(1)).toBe(2);
    expect(pit.getChannelAccessMode(1)).toBe('lobyte');
    expect(pit.getChannelBCD(1)).toBe(true);
  });

  it('warns when BCD bit is set (and counts in binary anyway)', () => {
    const { pit, clock, warnings, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 2, 3, true));
    expect(warnings.some((w) => /BCD/.test(w))).toBe(true);
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    clock.advance(100);
    // Binary counting: 100 ticks → 1 edge.
    expect(ch0Edges()).toBe(1);
  });

  it('warns on mode 1 / mode 5 (gate-triggered) and never fires', () => {
    const { pit, clock, warnings, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 1));
    pit.writeByte(CH0, 10);
    pit.writeByte(CH0, 0);
    clock.advance(1000);
    expect(ch0Edges()).toBe(0);
    expect(warnings.some((w) => /mode 1/.test(w))).toBe(true);
  });
});

describe('PIT counter-latch command (control word with bits 5-4 = 00)', () => {
  it('latches the live counter value for later reads', () => {
    const { pit, clock } = setup();
    // Program ch0 mode 2 lohi divisor 100.
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    clock.advance(40);
    // Counter is now 60. Latch it.
    pit.writeByte(CTRL, (0 << 6) | (0 << 4)); // ch0, latch
    expect(pit.hasLatchedCount(0)).toBe(true);
    // Advance more — latched value should not change.
    clock.advance(20);
    // Read low then high — should be 60.
    const lo = pit.readByte(CH0);
    const hi = pit.readByte(CH0);
    expect((hi << 8) | lo).toBe(60);
    expect(pit.hasLatchedCount(0)).toBe(false);
  });

  it('does not change the channel mode or access mode', () => {
    const { pit } = setup();
    pit.writeByte(CTRL, controlWord(0, 3));
    pit.writeByte(CH0, 50);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelMode(0)).toBe(3);
    pit.writeByte(CTRL, (0 << 6) | (0 << 4));
    expect(pit.getChannelMode(0)).toBe(3);
    expect(pit.getChannelAccessMode(0)).toBe('lohi');
  });
});

// ============================================================
// Mode 2 (rate generator)
// ============================================================

describe('PIT mode 2 (rate generator)', () => {
  it('rising edge fires every <divisor> PIT ticks', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    // Advance 99 — one short. No edge yet.
    clock.advance(99);
    expect(ch0Edges()).toBe(0);
    // One more — counter hits zero, reload, edge fires.
    clock.advance(1);
    expect(ch0Edges()).toBe(1);
  });

  it('callback fires once per batch even if many edges elapse', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    // Single batch of 1000 ticks = 10 edges analytically, but per-batch
    // dedup means callback fires once. Documented limitation.
    clock.advance(1000);
    expect(ch0Edges()).toBe(1);
    // Subsequent batch fires again.
    clock.advance(100);
    expect(ch0Edges()).toBe(2);
  });

  it('callback fires once per batch if many edges per batch', () => {
    // The same effect tested as a series of 200-tick batches: each batch
    // crosses two edges but the callback fires once. So 5 batches of 200
    // = 5 callback invocations (not 10).
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    for (let i = 0; i < 5; i++) clock.advance(200);
    expect(ch0Edges()).toBe(5);
  });

  it('counter decreases linearly between edges', () => {
    const { pit, clock } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelCounter(0)).toBe(100);
    clock.advance(30);
    expect(pit.getChannelCounter(0)).toBe(70);
    clock.advance(50);
    expect(pit.getChannelCounter(0)).toBe(20);
  });

  it('reprogramming during count: new divisor takes effect on next reload', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    clock.advance(50);
    // Mid-period reprogramming: write a new divisor of 10. Should NOT
    // disturb the running counter; current period completes at 100.
    pit.writeByte(CH0, 10);
    pit.writeByte(CH0, 0);
    clock.advance(50); // complete first period — 1 edge
    expect(ch0Edges()).toBe(1);
    // Now divisor is 10. After 30 more ticks: 3 more edges (callback
    // fires once per batch — so call count = 2 total).
    clock.advance(30);
    expect(ch0Edges()).toBe(2);
    expect(pit.getChannelCounter(0)).toBe(10);
  });

  it('output transitions: counter == 1 → output low for one tick', () => {
    const { pit, clock } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 5);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelOutput(0)).toBe(true);
    clock.advance(4); // counter = 1
    expect(pit.getChannelCounter(0)).toBe(1);
    expect(pit.getChannelOutput(0)).toBe(false);
    clock.advance(1); // wraps, counter = 5, output high (rising edge)
    expect(pit.getChannelCounter(0)).toBe(5);
    expect(pit.getChannelOutput(0)).toBe(true);
  });
});

// ============================================================
// Mode 3 (square wave)
// ============================================================

describe('PIT mode 3 (square wave)', () => {
  it('even divisor: symmetric high/low halves', () => {
    const { pit, clock } = setup();
    pit.writeByte(CTRL, controlWord(0, 3));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelOutput(0)).toBe(true); // starts high
    clock.advance(49);
    expect(pit.getChannelOutput(0)).toBe(true);
    clock.advance(1); // 50 ticks elapsed → flip to low
    expect(pit.getChannelOutput(0)).toBe(false);
    clock.advance(50); // 100 total → back high (rising edge)
    expect(pit.getChannelOutput(0)).toBe(true);
  });

  it('rising edge fires once per period (low → high transition)', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 3));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    // Advance a bit at a time so per-batch dedup doesn't hide events.
    for (let i = 0; i < 10; i++) clock.advance(100);
    expect(ch0Edges()).toBe(10);
  });

  it('odd divisor 7: high for 4, low for 3 (asymmetric)', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 3));
    pit.writeByte(CH0, 7);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelOutput(0)).toBe(true);
    clock.advance(3);
    expect(pit.getChannelOutput(0)).toBe(true); // still high, only 3/4 of high phase
    clock.advance(1);
    expect(pit.getChannelOutput(0)).toBe(false); // now into low phase (4 ticks elapsed)
    clock.advance(2);
    expect(pit.getChannelOutput(0)).toBe(false); // 6/7 of period
    clock.advance(1);
    expect(pit.getChannelOutput(0)).toBe(true);  // wrapped: edge
    expect(ch0Edges()).toBe(1);
  });

  it('reprogramming during count: takes effect at next period boundary', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 3));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    clock.advance(50);
    pit.writeByte(CH0, 10);
    pit.writeByte(CH0, 0);
    clock.advance(50); // finish first period (D=100), 1 edge
    expect(ch0Edges()).toBe(1);
    // Divisor switched to 10; one batch covers many edges → 1 more callback.
    clock.advance(100);
    expect(ch0Edges()).toBe(2);
  });
});

// ============================================================
// Mode 0 (one-shot, software-triggered)
// ============================================================

describe('PIT mode 0 (one-shot)', () => {
  it('fires exactly once after divisor ticks', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 0));
    pit.writeByte(CH0, 50);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelOutput(0)).toBe(false); // mode 0 starts low
    clock.advance(49);
    expect(ch0Edges()).toBe(0);
    expect(pit.getChannelOutput(0)).toBe(false);
    clock.advance(1);
    expect(ch0Edges()).toBe(1);
    expect(pit.getChannelOutput(0)).toBe(true); // stays high
    clock.advance(1000);
    expect(ch0Edges()).toBe(1); // no further callbacks
  });

  it('rewriting the divisor re-arms the one-shot', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 0));
    pit.writeByte(CH0, 10);
    pit.writeByte(CH0, 0);
    clock.advance(100);
    expect(ch0Edges()).toBe(1);
    // Mode 0 reprogramming: the brief says mode 0 takes the new divisor
    // immediately. The control word write resets state; then the divisor
    // load arms again.
    pit.writeByte(CTRL, controlWord(0, 0));
    pit.writeByte(CH0, 5);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelOutput(0)).toBe(false);
    clock.advance(5);
    expect(ch0Edges()).toBe(2);
  });
});

// ============================================================
// Latching and live reads
// ============================================================

describe('PIT data-port reads', () => {
  it('lohi access: live read returns low then high in alternation', () => {
    const { pit, clock } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 0x34);
    pit.writeByte(CH0, 0x12);
    expect(pit.getChannelDivisor(0)).toBe(0x1234);
    expect(pit.getChannelCounter(0)).toBe(0x1234);
    const lo1 = pit.readByte(CH0);
    expect(lo1).toBe(0x34);
    const hi1 = pit.readByte(CH0);
    expect(hi1).toBe(0x12);
    // Counter advances between reads — second pair sees a smaller value.
    clock.advance(10);
    const lo2 = pit.readByte(CH0);
    const hi2 = pit.readByte(CH0);
    expect(((hi2 << 8) | lo2)).toBe(0x1234 - 10);
  });

  it('counter-latch followed by lohi reads returns the snapshot', () => {
    const { pit, clock } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 0xE8); // 1000 = 0x03E8
    pit.writeByte(CH0, 0x03);
    clock.advance(100);
    pit.writeByte(CTRL, (0 << 6) | (0 << 4)); // latch ch0
    clock.advance(100); // counter would now be 800; latched value is 900
    const lo = pit.readByte(CH0);
    const hi = pit.readByte(CH0);
    expect(((hi << 8) | lo)).toBe(900);
    // Latch consumed: subsequent read returns live value.
    const lo2 = pit.readByte(CH0);
    const hi2 = pit.readByte(CH0);
    expect(((hi2 << 8) | lo2)).toBe(800);
  });

  it('lobyte access mode: write low byte sets divisor low, high = 0', () => {
    const { pit } = setup();
    pit.writeByte(CTRL, controlWord(0, 2, 1)); // lobyte
    pit.writeByte(CH0, 0x42);
    expect(pit.getChannelDivisor(0)).toBe(0x42);
    expect(pit.getChannelProgrammed(0)).toBe(true);
  });

  it('hibyte access mode: write high byte sets divisor high, low = 0', () => {
    const { pit } = setup();
    pit.writeByte(CTRL, controlWord(0, 2, 2)); // hibyte
    pit.writeByte(CH0, 0x42);
    expect(pit.getChannelDivisor(0)).toBe(0x4200);
    expect(pit.getChannelProgrammed(0)).toBe(true);
  });
});

// ============================================================
// Edge cases
// ============================================================

describe('PIT edge cases', () => {
  it('divisor of 0 is treated as 0x10000', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 0);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelDivisor(0)).toBe(0x10000);
    // Fast-check: 0x10000 ticks → 1 edge.
    clock.advance(0x10000);
    expect(ch0Edges()).toBe(1);
  });

  it('lohi: first byte write does not start counting (channel not programmed)', () => {
    const { pit, clock, ch0Edges } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    expect(pit.getChannelProgrammed(0)).toBe(false);
    clock.advance(1000);
    expect(ch0Edges()).toBe(0);
    pit.writeByte(CH0, 0);
    expect(pit.getChannelProgrammed(0)).toBe(true);
  });

  it('cyclesPerPitTick = 4: clock advances are divided down', () => {
    const { pit, clock, ch0Edges } = setup({ cyclesPerPitTick: 4 });
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    // 400 clock cycles = 100 PIT ticks = exactly one edge.
    clock.advance(399);
    expect(ch0Edges()).toBe(0);
    clock.advance(1);
    expect(ch0Edges()).toBe(1);
  });

  it('cyclesPerPitTick = 4: residual is preserved across advances', () => {
    const { pit, clock, ch0Edges } = setup({ cyclesPerPitTick: 4 });
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 10);
    pit.writeByte(CH0, 0);
    // Two advances of 3 cycles each = 6 cycles total = 1 PIT tick + 2
    // residual. After 5 such advances we've had 15 cycles = 3 PIT ticks
    // (with 3 cycles residual carried into a hypothetical next batch).
    for (let i = 0; i < 5; i++) clock.advance(3);
    expect(pit.getChannelCounter(0)).toBe(10 - 3);
  });

  it('channels 1 and 2 count independently and update output state', () => {
    const { pit, clock } = setup();
    pit.writeByte(CTRL, controlWord(1, 2));
    pit.writeByte(CH1, 50);
    pit.writeByte(CH1, 0);
    pit.writeByte(CTRL, controlWord(2, 3));
    pit.writeByte(CH2, 30);
    pit.writeByte(CH2, 0);
    clock.advance(40);
    expect(pit.getChannelCounter(1)).toBe(10);
    // ch2 mode 3 divisor 30: high for 15, low for 15. After 40 ticks
    // we're at phaseTick = 10 in the second period (just into high),
    // so output is high.
    expect(pit.getChannelOutput(2)).toBe(true);
  });
});

// ============================================================
// 8254 read-back command
// ============================================================

describe('PIT 8254 read-back command', () => {
  it('latches count for the selected channels', () => {
    const { pit, clock } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    pit.writeByte(CTRL, controlWord(1, 2));
    pit.writeByte(CH1, 200);
    pit.writeByte(CH1, 0);
    clock.advance(40);
    // Read-back: latch count for ch0 (bit 1) and ch1 (bit 2). bits 7-6 = 11.
    // bit 5 = 0 (latch count), bit 4 = 1 (don't latch status).
    //   1101 0110 = 0xD6
    pit.writeByte(CTRL, 0xD6);
    expect(pit.hasLatchedCount(0)).toBe(true);
    expect(pit.hasLatchedCount(1)).toBe(true);
    expect(pit.hasLatchedCount(2)).toBe(false);
    clock.advance(20);
    const lo0 = pit.readByte(CH0);
    const hi0 = pit.readByte(CH0);
    expect(((hi0 << 8) | lo0)).toBe(60); // 100 - 40
    const lo1 = pit.readByte(CH1);
    const hi1 = pit.readByte(CH1);
    expect(((hi1 << 8) | lo1)).toBe(160); // 200 - 40
  });

  it('latches status for the selected channels', () => {
    const { pit } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    // Read-back: latch status for ch0. bit 5 = 1, bit 4 = 0, bit 1 = 1.
    //   1110 0010 = 0xE2
    pit.writeByte(CTRL, 0xE2);
    expect(pit.hasLatchedStatus(0)).toBe(true);
    const status = pit.readByte(CH0);
    // OUT bit (bit 7) = 1 (mode 2 starts high).
    // null-count bit (bit 6) = 0 (programmed).
    // access mode bits 5-4 = 11 (lohi).
    // mode bits 3-1 = 010.
    // bcd bit 0 = 0.
    expect(status).toBe(0x80 | (3 << 4) | (2 << 1));
    expect(pit.hasLatchedStatus(0)).toBe(false);
  });

  it('with both count and status latched, status reads first then count', () => {
    const { pit } = setup();
    pit.writeByte(CTRL, controlWord(0, 2));
    pit.writeByte(CH0, 100);
    pit.writeByte(CH0, 0);
    // Both: bit 5 = 0, bit 4 = 0, bit 1 = 1 (ch0).
    //   1100 0010 = 0xC2
    pit.writeByte(CTRL, 0xC2);
    const status = pit.readByte(CH0);
    expect((status & 0x80) !== 0).toBe(true);
    const lo = pit.readByte(CH0);
    const hi = pit.readByte(CH0);
    expect(((hi << 8) | lo)).toBe(100);
  });
});
