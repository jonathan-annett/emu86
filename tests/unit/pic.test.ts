import { beforeEach, describe, expect, it } from 'vitest';
import { PIC8259 } from '../../src/devices/pic.js';
import type { InterruptController } from '../../src/interrupts/controller.js';

/**
 * Unit tests for the 8259 PIC. Each test uses a recording fake
 * `InterruptController` so we can observe exactly which vectors the PIC
 * forwards, in what order, with no CPU in the loop.
 *
 * IO conventions: command port = 0x20, data port = 0x21 (PC standard,
 * the PIC's defaults).
 */

class RecordingController implements InterruptController {
  raised: number[] = [];
  nmis: number = 0;
  hasNMI(): boolean { return false; }
  hasMaskable(): boolean { return false; }
  consumeNMI(): boolean { return false; }
  consumeMaskable(): number { throw new Error('not used'); }
  raise(vector: number): void { this.raised.push(vector); }
  raiseNMI(): void { this.nmis++; }
  reset(): void { this.raised.length = 0; this.nmis = 0; }
}

const CMD = 0x20;
const DATA = 0x21;

interface Setup {
  pic: PIC8259;
  ctrl: RecordingController;
  warnings: string[];
}

function setup(): Setup {
  const ctrl = new RecordingController();
  const warnings: string[] = [];
  const pic = new PIC8259(ctrl, { warn: (m) => warnings.push(m) });
  return { pic, ctrl, warnings };
}

/** Standard "single-PIC, ICW4 in 8086 mode, vector base 0x40, all unmasked" init. */
function programStandard(pic: PIC8259, vectorBase = 0x40, imr = 0x00): void {
  // ICW1: bit 4 = 1 (init), bit 1 = 1 (single, no ICW3), bit 0 = 1 (expect ICW4)
  pic.writeByte(CMD, 0x13);
  // ICW2: vector base
  pic.writeByte(DATA, vectorBase);
  // ICW4: bit 0 = 1 (8086 mode)
  pic.writeByte(DATA, 0x01);
  // OCW1: IMR
  pic.writeByte(DATA, imr);
}

// ============================================================
// Programming sequence — state-machine plumbing
// ============================================================

describe('PIC init: ICW1 → ICW2 → ICW4 (single-PIC mode)', () => {
  it('lands in idle after ICW4', () => {
    const { pic } = setup();
    pic.writeByte(CMD, 0x13);  // ICW1: single, ICW4 expected
    expect(pic.getInitState()).toBe('awaitingIcw2');
    pic.writeByte(DATA, 0x40); // ICW2
    expect(pic.getInitState()).toBe('awaitingIcw4');
    pic.writeByte(DATA, 0x01); // ICW4 (8086 mode)
    expect(pic.getInitState()).toBe('idle');
  });

  it('lands in idle directly after ICW2 when no ICW4 is expected', () => {
    const { pic } = setup();
    pic.writeByte(CMD, 0x12);  // ICW1: single, no ICW4
    pic.writeByte(DATA, 0x40); // ICW2
    expect(pic.getInitState()).toBe('idle');
  });

  it('resets IMR to 0xFF and ISR to 0 on ICW1', () => {
    const { pic } = setup();
    programStandard(pic, 0x40, 0x12);
    // Force ISR to a known value via IRQ + check via OCW3.
    pic.assertIRQ(2);
    expect(pic.getISR()).toBe(1 << 2);
    // Re-init.
    pic.writeByte(CMD, 0x13);
    expect(pic.getIMR()).toBe(0xFF);
    expect(pic.getISR()).toBe(0);
  });
});

describe('PIC init: ICW1 → ICW2 → ICW3 → ICW4 (cascade signaled)', () => {
  it('consumes ICW3 byte and ends in idle; warns about cascade-as-single', () => {
    const { pic, warnings } = setup();
    pic.writeByte(CMD, 0x11);  // ICW1: cascade (bit 1 = 0), ICW4 expected
    expect(pic.getInitState()).toBe('awaitingIcw2');
    pic.writeByte(DATA, 0x40); // ICW2
    expect(pic.getInitState()).toBe('awaitingIcw3');
    pic.writeByte(DATA, 0x04); // ICW3 (master with slave on IRQ 2)
    expect(pic.getInitState()).toBe('awaitingIcw4');
    pic.writeByte(DATA, 0x01); // ICW4 (8086 mode)
    expect(pic.getInitState()).toBe('idle');
    expect(warnings.some((w) => /cascade/i.test(w))).toBe(true);
  });
});

describe('PIC init: re-init mid-sequence', () => {
  it('a fresh ICW1 restarts the state machine', () => {
    const { pic } = setup();
    pic.writeByte(CMD, 0x13);  // ICW1
    pic.writeByte(DATA, 0x40); // ICW2 → awaitingIcw4
    pic.writeByte(CMD, 0x13);  // ICW1 again
    expect(pic.getInitState()).toBe('awaitingIcw2');
  });
});

describe('PIC IMR set/get round-trip', () => {
  it('writes to data port when idle become IMR; reads return IMR', () => {
    const { pic } = setup();
    programStandard(pic);
    pic.writeByte(DATA, 0x5A);
    expect(pic.getIMR()).toBe(0x5A);
    expect(pic.readByte(DATA)).toBe(0x5A);
  });
});

describe('PIC vector base: ICW2 high 5 bits set base, low 3 ignored', () => {
  it('writes 0x40 → IRQ 0 vector = 0x40, IRQ 7 vector = 0x47', () => {
    const { pic, ctrl } = setup();
    programStandard(pic, 0x40, 0x00);
    pic.assertIRQ(0);
    expect(ctrl.raised).toEqual([0x40]);
    // Acknowledge so IRQ 7 (lower priority) can fire.
    pic.writeByte(CMD, 0x20); // non-specific EOI
    pic.assertIRQ(7);
    expect(ctrl.raised).toEqual([0x40, 0x47]);
  });

  it('writes 0x47 to ICW2 → low 3 bits ignored, IRQ 0 still uses 0x40 not 0x47', () => {
    const { pic, ctrl } = setup();
    pic.writeByte(CMD, 0x13);
    pic.writeByte(DATA, 0x47);
    pic.writeByte(DATA, 0x01);
    pic.writeByte(DATA, 0x00); // unmask all
    pic.assertIRQ(0);
    expect(ctrl.raised).toEqual([0x40]);
  });
});

describe('PIC ICW4 unsupported flags', () => {
  it('ICW4 bit 0 = 0 (MCS-80 mode) is warned but accepted', () => {
    const { pic, warnings } = setup();
    pic.writeByte(CMD, 0x13);
    pic.writeByte(DATA, 0x40);
    pic.writeByte(DATA, 0x00); // ICW4 with 8086 bit clear
    expect(warnings.some((w) => /MCS-80/i.test(w))).toBe(true);
    expect(pic.getInitState()).toBe('idle');
  });

  it('ICW4 bit 1 = 1 (auto-EOI) is warned but accepted', () => {
    const { pic, warnings } = setup();
    pic.writeByte(CMD, 0x13);
    pic.writeByte(DATA, 0x40);
    pic.writeByte(DATA, 0x03); // 8086 mode + auto-EOI
    expect(warnings.some((w) => /auto-EOI/i.test(w))).toBe(true);
  });
});

// ============================================================
// IRR / ISR / IMR semantics
// ============================================================

describe('PIC IRQ delivery', () => {
  let env: Setup;
  beforeEach(() => { env = setup(); programStandard(env.pic); });

  it('asserting an unmasked IRQ raises one vector and moves IRR → ISR', () => {
    const { pic, ctrl } = env;
    pic.assertIRQ(3);
    expect(ctrl.raised).toEqual([0x40 + 3]);
    expect(pic.getIRR()).toBe(0);
    expect(pic.getISR()).toBe(1 << 3);
  });

  it('a masked IRQ does not raise; unmasking later raises it', () => {
    const { pic, ctrl } = env;
    // Mask IRQ 3.
    pic.writeByte(DATA, 1 << 3);
    pic.assertIRQ(3);
    expect(ctrl.raised).toEqual([]);
    expect(pic.getIRR()).toBe(1 << 3); // latched in IRR
    // Unmask all → IMR write triggers serviceability check.
    pic.writeByte(DATA, 0x00);
    expect(ctrl.raised).toEqual([0x40 + 3]);
  });

  it('multiple IRQs asserted simultaneously: highest-priority (lowest #) raised first', () => {
    const { pic, ctrl } = env;
    pic.assertIRQ(5);
    pic.assertIRQ(2);
    pic.assertIRQ(7);
    // Only the first call (IRQ 5) raises (it preempts an empty ISR), but
    // then IRQ 2 preempts IRQ 5 because 2 < 5 (higher priority). IRQ 7
    // can't preempt either. So the sequence is [5, 2].
    expect(ctrl.raised).toEqual([0x40 + 5, 0x40 + 2]);
    expect(pic.getISR()).toBe((1 << 5) | (1 << 2));
    expect(pic.getIRR()).toBe(1 << 7);
  });

  it('a lower-priority IRQ asserted while a higher one is in service stays pending', () => {
    const { pic, ctrl } = env;
    pic.assertIRQ(3);
    pic.assertIRQ(5);
    expect(ctrl.raised).toEqual([0x40 + 3]);
    expect(pic.getIRR()).toBe(1 << 5);
    expect(pic.getISR()).toBe(1 << 3);
  });

  it('a higher-priority IRQ preempts a lower-priority handler in service', () => {
    const { pic, ctrl } = env;
    pic.assertIRQ(3);
    pic.assertIRQ(1);
    expect(ctrl.raised).toEqual([0x40 + 3, 0x40 + 1]);
    expect(pic.getISR()).toBe((1 << 3) | (1 << 1));
  });
});

// ============================================================
// EOI
// ============================================================

describe('PIC EOI', () => {
  let env: Setup;
  beforeEach(() => { env = setup(); programStandard(env.pic); });

  it('non-specific EOI clears the highest-priority bit currently in ISR', () => {
    const { pic } = env;
    pic.assertIRQ(3);
    pic.assertIRQ(1); // preempts → ISR has bits 1 and 3
    expect(pic.getISR()).toBe((1 << 1) | (1 << 3));
    pic.writeByte(CMD, 0x20); // non-specific EOI clears IRQ 1 (highest-priority)
    expect(pic.getISR()).toBe(1 << 3);
  });

  it('specific EOI clears the named bit only', () => {
    const { pic } = env;
    pic.assertIRQ(3);
    pic.assertIRQ(1);
    pic.writeByte(CMD, 0x60 | 3); // specific EOI for IRQ 3 (skips IRQ 1)
    expect(pic.getISR()).toBe(1 << 1);
  });

  it('after EOI, a queued lower-priority IRQ becomes serviceable and raises', () => {
    const { pic, ctrl } = env;
    pic.assertIRQ(3);
    pic.assertIRQ(5);              // queued in IRR while 3 is in service
    expect(ctrl.raised).toEqual([0x40 + 3]);
    pic.writeByte(CMD, 0x20);      // EOI for IRQ 3
    expect(ctrl.raised).toEqual([0x40 + 3, 0x40 + 5]);
    expect(pic.getISR()).toBe(1 << 5);
    expect(pic.getIRR()).toBe(0);
  });

  it('EOI when ISR is empty is a no-op', () => {
    const { pic } = env;
    expect(() => pic.writeByte(CMD, 0x20)).not.toThrow();
    expect(pic.getISR()).toBe(0);
  });
});

// ============================================================
// Reads (OCW3 register selector)
// ============================================================

describe('PIC OCW3 register selector', () => {
  let env: Setup;
  beforeEach(() => { env = setup(); programStandard(env.pic); });

  it('default read of command port returns IRR', () => {
    const { pic } = env;
    pic.writeByte(DATA, 0xFF); // mask everything so the IRQ stays in IRR
    pic.assertIRQ(2);
    expect(pic.readByte(CMD)).toBe(1 << 2);
  });

  it('OCW3 with RR=10 selects IRR for subsequent command-port reads', () => {
    const { pic } = env;
    pic.writeByte(DATA, 0xFF);   // mask everything
    pic.assertIRQ(4);
    pic.writeByte(CMD, 0x0B);    // OCW3, RR=11 → ISR
    pic.writeByte(CMD, 0x0A);    // OCW3, RR=10 → IRR
    expect(pic.readByte(CMD)).toBe(1 << 4);
  });

  it('OCW3 with RR=11 selects ISR for subsequent command-port reads', () => {
    const { pic } = env;
    pic.assertIRQ(2); // 2 → ISR (unmasked)
    pic.writeByte(CMD, 0x0B);    // OCW3, RR=11 → ISR
    expect(pic.readByte(CMD)).toBe(1 << 2);
  });

  it('data port read always returns IMR regardless of OCW3 selector', () => {
    const { pic } = env;
    pic.writeByte(DATA, 0x33);
    pic.writeByte(CMD, 0x0B);    // pick ISR
    expect(pic.readByte(DATA)).toBe(0x33);
  });
});

// ============================================================
// Edge cases
// ============================================================

describe('PIC edge cases', () => {
  it('assertIRQ(8) throws (out of range)', () => {
    const { pic } = setup();
    programStandard(pic);
    expect(() => pic.assertIRQ(8)).toThrow();
    expect(() => pic.assertIRQ(-1)).toThrow();
  });

  it('deassertIRQ in edge-triggered mode is a no-op (request remains latched)', () => {
    const { pic, ctrl } = setup();
    programStandard(pic, 0x40, 0xFF);  // mask everything so IRR holds the bit
    pic.assertIRQ(3);
    expect(pic.getIRR()).toBe(1 << 3);
    pic.deassertIRQ(3);
    expect(pic.getIRR()).toBe(1 << 3); // still latched (edge-triggered default)
    pic.writeByte(DATA, 0x00);          // unmask
    expect(ctrl.raised).toEqual([0x40 + 3]);
  });

  it('deassertIRQ in level-triggered mode clears the IRR bit before raise', () => {
    const { pic, ctrl } = setup();
    // ICW1 with bit 3 = 1 (level-triggered)
    pic.writeByte(CMD, 0x1B);
    pic.writeByte(DATA, 0x40);
    pic.writeByte(DATA, 0x01);
    pic.writeByte(DATA, 0xFF);          // mask everything
    pic.assertIRQ(3);
    pic.deassertIRQ(3);
    expect(pic.getIRR()).toBe(0);
    pic.writeByte(DATA, 0x00);          // unmask: nothing to fire
    expect(ctrl.raised).toEqual([]);
  });

  it('IRQ asserted before init is held in IRR; first raises only after init+unmask', () => {
    const { pic, ctrl } = setup();
    // Pre-init: IRR exists but updatePending no-ops because initState !== 'idle'.
    // We can't observe IRR before init because the only path that sets it
    // is assertIRQ, which our v0 design *does* allow even pre-init: the bit
    // is latched but not delivered.
    pic.assertIRQ(3);
    pic.assertIRQ(5);
    expect(ctrl.raised).toEqual([]);   // nothing fired during init/non-init
    expect(pic.getIRR()).toBe((1 << 3) | (1 << 5));
    // Now program (this clears IMR to 0xFF so still nothing fires yet).
    pic.writeByte(CMD, 0x13);
    pic.writeByte(DATA, 0x40);
    pic.writeByte(DATA, 0x01);
    expect(ctrl.raised).toEqual([]);
    // Unmask all.
    pic.writeByte(DATA, 0x00);
    // Only the highest-priority pending fires.
    expect(ctrl.raised).toEqual([0x40 + 3]);
    expect(pic.getISR()).toBe(1 << 3);
    expect(pic.getIRR()).toBe(1 << 5);
  });

  it('OCW2 rotate-priority commands are warned and ignored', () => {
    const { pic, warnings } = setup();
    programStandard(pic);
    pic.writeByte(CMD, 0x80); // rotate-on-non-specific EOI bit set, no EOI bit
    expect(warnings.some((w) => /rotate/i.test(w))).toBe(true);
  });
});

// ============================================================
// Configuration
// ============================================================

describe('PIC configuration', () => {
  it('throws if dataPort is not commandPort + 1', () => {
    const ctrl = new RecordingController();
    expect(() => new PIC8259(ctrl, { commandPort: 0x20, dataPort: 0x30 })).toThrow();
  });

  it('honours custom commandPort/dataPort', () => {
    const ctrl = new RecordingController();
    const pic = new PIC8259(ctrl, { commandPort: 0xA0, dataPort: 0xA1 });
    pic.writeByte(0xA0, 0x13);
    pic.writeByte(0xA1, 0x40);
    pic.writeByte(0xA1, 0x01);
    pic.writeByte(0xA1, 0x00);
    pic.assertIRQ(0);
    expect(ctrl.raised).toEqual([0x40]);
  });
});
