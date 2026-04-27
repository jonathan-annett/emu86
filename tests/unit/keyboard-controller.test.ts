import { beforeEach, describe, expect, it } from 'vitest';
import { KeyboardController8042 } from '../../src/devices/keyboard-controller.js';

/**
 * Unit tests for the headless 8042 PS/2 keyboard controller.
 *
 * The most important test in this file (and the reason this device exists
 * at Phase 4) is "fresh controller: status read returns OBF=0". Everything
 * else is supporting cast — A20 sequence acceptance, command-byte plumbing,
 * the "next data write" state machine, and resilience against unknown
 * commands.
 */

const DATA = 0x60;
const STATUS = 0x64;

interface Setup {
  kbc: KeyboardController8042;
  warnings: string[];
}

function setup(): Setup {
  const warnings: string[] = [];
  const kbc = new KeyboardController8042({ warn: (m) => warnings.push(m) });
  return { kbc, warnings };
}

// ============================================================
// Status register
// ============================================================

describe('8042 status register', () => {
  it('fresh controller: OBF=0, system flag=1, keyboard enabled=1', () => {
    const { kbc } = setup();
    const s = kbc.readByte(STATUS);
    expect(s & 0x01).toBe(0);          // OBF clear
    expect(s & 0x02).toBe(0);          // IBF clear
    expect(s & 0x04).toBe(0x04);       // system flag set
    expect(s & 0x10).toBe(0x10);       // keyboard enabled
  });

  it('after a command that loads OBF (0xAA self-test), OBF=1', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xAA);
    expect(kbc.readByte(STATUS) & 0x01).toBe(0x01);
  });

  it('reading the data port drains OBF', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xAA);          // load 0x55 into OBF
    kbc.readByte(DATA);                   // drain
    expect(kbc.readByte(STATUS) & 0x01).toBe(0);
  });

  it('command/data bit reflects the most recent write', () => {
    const { kbc } = setup();
    // After a command write to 0x64, bit 3 should be set on next status read.
    kbc.writeByte(STATUS, 0xAA);
    expect(kbc.readByte(STATUS) & 0x08).toBe(0x08);
    // After a data write to 0x60, bit 3 should clear.
    kbc.writeByte(STATUS, 0x60);          // arm "next data write is command byte"
    kbc.writeByte(DATA, 0x65);            // data write
    expect(kbc.readByte(STATUS) & 0x08).toBe(0);
  });
});

// ============================================================
// Phase 3 drain loop unblocks
// ============================================================

describe('8042 drain-loop unblock (the Phase 4 raison d\'être)', () => {
  it('reading port 0x64 with no input returns OBF=0 on the first iteration', () => {
    const { kbc } = setup();
    // The Phase 3 stuck loop:
    //   IN AL, 0x60   ; doesn't matter, returns 0
    //   IN AL, 0x64   ; status — bit 0 must be 0 to escape
    //   TEST AL, 1
    //   JNZ -16
    // Verify bit 0 is 0 immediately, so JNZ falls through.
    expect(kbc.readByte(STATUS) & 0x01).toBe(0);
  });

  it('repeated polls keep OBF=0 (no spurious key arrival in headless mode)', () => {
    const { kbc } = setup();
    for (let i = 0; i < 1000; i++) {
      kbc.readByte(DATA);                 // sometimes the loop reads data first
      expect(kbc.readByte(STATUS) & 0x01).toBe(0);
    }
  });

  it('reading port 0x60 with no buffered byte returns 0x00', () => {
    const { kbc } = setup();
    expect(kbc.readByte(DATA)).toBe(0x00);
  });
});

// ============================================================
// A20 sequence
// ============================================================

describe('8042 A20 gate command sequence', () => {
  it('initial state: A20 is enabled (default per BIOS convention)', () => {
    const { kbc } = setup();
    expect(kbc.a20Enabled).toBe(true);
  });

  it('canonical enable sequence (0xD1 then 0xDF) leaves A20 enabled', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xD1);
    kbc.writeByte(DATA, 0xDF);
    expect(kbc.a20Enabled).toBe(true);
    expect(kbc.outputPort).toBe(0xDF);
  });

  it('disable sequence (0xD1 then 0xDD) clears A20', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xD1);
    kbc.writeByte(DATA, 0xDD);
    expect(kbc.a20Enabled).toBe(false);
    expect(kbc.outputPort).toBe(0xDD);
  });

  it('reading P2 via 0xD0 returns the current output port value', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xD1);
    kbc.writeByte(DATA, 0xDF);
    kbc.writeByte(STATUS, 0xD0);
    expect(kbc.readByte(STATUS) & 0x01).toBe(0x01);   // OBF set
    expect(kbc.readByte(DATA)).toBe(0xDF);
  });

  it('after 0xD1 + one data write, the next 0x60 write is back to keyboard data', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xD1);
    kbc.writeByte(DATA, 0xDF);
    // The state machine must have rearmed to 'keyboard'. Writing 0xAB to
    // port 0x60 should NOT update the output port a second time.
    kbc.writeByte(DATA, 0xAB);
    expect(kbc.outputPort).toBe(0xDF);
  });
});

// ============================================================
// Self-test
// ============================================================

describe('8042 self-test command (0xAA)', () => {
  it('returns 0x55 (pass) and sets OBF', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xAA);
    expect(kbc.readByte(STATUS) & 0x01).toBe(0x01);
    expect(kbc.readByte(DATA)).toBe(0x55);
    expect(kbc.readByte(STATUS) & 0x01).toBe(0);   // drained
  });
});

// ============================================================
// Command byte read/write
// ============================================================

describe('8042 command byte (0x20 / 0x60)', () => {
  it('default command byte is the post-POST value 0x65', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0x20);
    expect(kbc.readByte(DATA)).toBe(0x65);
  });

  it('0x60 followed by a data write updates the command byte', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0x60);
    kbc.writeByte(DATA, 0x47);
    expect(kbc.commandByte).toBe(0x47);
    // And reading it back confirms.
    kbc.writeByte(STATUS, 0x20);
    expect(kbc.readByte(DATA)).toBe(0x47);
  });

  it('disable keyboard (0xAD) sets bit 4 of the command byte', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xAD);
    expect(kbc.commandByte & 0x10).toBe(0x10);
    // Status bit 4 (keyboard enabled in status semantics) is now 0.
    expect(kbc.readByte(STATUS) & 0x10).toBe(0);
  });

  it('enable keyboard (0xAE) clears bit 4 of the command byte', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xAD);              // disable first
    kbc.writeByte(STATUS, 0xAE);              // re-enable
    expect(kbc.commandByte & 0x10).toBe(0);
    expect(kbc.readByte(STATUS) & 0x10).toBe(0x10);
  });
});

// ============================================================
// Auxiliary commands
// ============================================================

describe('8042 aux/test commands', () => {
  it('test aux (0xA9) returns 0x00', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xA9);
    expect(kbc.readByte(DATA)).toBe(0x00);
  });

  it('test keyboard line (0xAB) returns 0x00', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xAB);
    expect(kbc.readByte(DATA)).toBe(0x00);
  });

  it('read input port (0xC0) returns 0x00', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xC0);
    expect(kbc.readByte(DATA)).toBe(0x00);
  });

  it('disable/enable aux (0xA7/0xA8) are no-ops with no warnings', () => {
    const { kbc, warnings } = setup();
    kbc.writeByte(STATUS, 0xA7);
    kbc.writeByte(STATUS, 0xA8);
    expect(warnings).toEqual([]);
  });

  it('write-aux-byte (0xD4) consumes the next 0x60 write silently, then resumes default state', () => {
    const { kbc, warnings } = setup();
    kbc.writeByte(STATUS, 0xD4);
    kbc.writeByte(DATA, 0xFF);              // consumed by 'aux' branch — silent
    expect(warnings.length).toBe(0);
    kbc.writeByte(DATA, 0xAA);              // now routes to 'keyboard', logs once
    expect(warnings.length).toBe(1);
  });
});

// ============================================================
// Pulse-reset (0xFE family) is a no-op + warns
// ============================================================

describe('8042 pulse output port (0xF0..0xFF)', () => {
  it('0xFE pulse-reset logs a warning and does not crash', () => {
    const { kbc, warnings } = setup();
    kbc.writeByte(STATUS, 0xFE);
    expect(warnings.length).toBe(1);
    // State should be unchanged — a20Enabled still default true, etc.
    expect(kbc.a20Enabled).toBe(true);
  });
});

// ============================================================
// Reset
// ============================================================

describe('8042 reset()', () => {
  it('returns to defaults after state mutation', () => {
    const { kbc } = setup();
    kbc.writeByte(STATUS, 0xD1);
    kbc.writeByte(DATA, 0xDD);                // disable A20
    kbc.writeByte(STATUS, 0x60);
    kbc.writeByte(DATA, 0x00);                // wipe command byte
    kbc.writeByte(STATUS, 0xAA);              // load OBF with 0x55

    kbc.reset();

    expect(kbc.a20Enabled).toBe(true);
    expect(kbc.outputPort).toBe(0x03);
    expect(kbc.commandByte).toBe(0x65);
    expect(kbc.outputBufferFull).toBe(false);
    expect(kbc.readByte(STATUS) & 0x01).toBe(0);
  });
});

// ============================================================
// Unknown commands
// ============================================================

describe('8042 unknown command tolerance', () => {
  let warnings: string[];
  let kbc: KeyboardController8042;
  beforeEach(() => {
    const s = setup();
    warnings = s.warnings;
    kbc = s.kbc;
  });

  it('write 0x99 to 0x64: warned, no crash, OBF unchanged', () => {
    kbc.writeByte(STATUS, 0x99);
    expect(warnings.length).toBe(1);
    expect(kbc.readByte(STATUS) & 0x01).toBe(0);
  });

  it('data write to "keyboard" (default state) warns once and is discarded', () => {
    kbc.writeByte(DATA, 0xED);                // would be a "set LEDs" cmd to a real keyboard
    expect(warnings.length).toBe(1);
  });
});
