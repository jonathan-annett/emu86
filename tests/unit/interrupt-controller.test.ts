import { describe, expect, it } from 'vitest';
import {
  BasicInterruptController,
  NullInterruptController,
} from '../../src/interrupts/index.js';

describe('BasicInterruptController — maskable queue', () => {
  it('raise enqueues a vector visible to hasMaskable / consumeMaskable', () => {
    const c = new BasicInterruptController();
    expect(c.hasMaskable()).toBe(false);
    c.raise(0x40);
    expect(c.hasMaskable()).toBe(true);
    expect(c.consumeMaskable()).toBe(0x40);
    expect(c.hasMaskable()).toBe(false);
  });

  it('drains in FIFO order', () => {
    const c = new BasicInterruptController();
    c.raise(0x10);
    c.raise(0x20);
    c.raise(0x30);
    expect(c.consumeMaskable()).toBe(0x10);
    expect(c.consumeMaskable()).toBe(0x20);
    expect(c.consumeMaskable()).toBe(0x30);
    expect(c.hasMaskable()).toBe(false);
  });

  it('does not deduplicate — same vector raised twice services twice', () => {
    const c = new BasicInterruptController();
    c.raise(0x21);
    c.raise(0x21);
    expect(c.consumeMaskable()).toBe(0x21);
    expect(c.hasMaskable()).toBe(true);
    expect(c.consumeMaskable()).toBe(0x21);
    expect(c.hasMaskable()).toBe(false);
  });

  it('throws on out-of-range or non-integer vectors', () => {
    const c = new BasicInterruptController();
    expect(() => c.raise(-1)).toThrow();
    expect(() => c.raise(256)).toThrow();
    expect(() => c.raise(1.5)).toThrow();
    expect(() => c.raise(Number.NaN)).toThrow();
    // Boundaries are inclusive on both ends.
    expect(() => c.raise(0)).not.toThrow();
    expect(() => c.raise(255)).not.toThrow();
  });

  it('consumeMaskable throws when nothing is queued', () => {
    const c = new BasicInterruptController();
    expect(() => c.consumeMaskable()).toThrow();
  });
});

describe('BasicInterruptController — NMI', () => {
  it('raiseNMI sets hasNMI; consumeNMI clears it and returns true', () => {
    const c = new BasicInterruptController();
    expect(c.hasNMI()).toBe(false);
    c.raiseNMI();
    expect(c.hasNMI()).toBe(true);
    expect(c.consumeNMI()).toBe(true);
    expect(c.hasNMI()).toBe(false);
  });

  it('consumeNMI returns false when nothing pending', () => {
    const c = new BasicInterruptController();
    expect(c.consumeNMI()).toBe(false);
  });

  it('raiseNMI is idempotent — two raises with no consume between is one', () => {
    const c = new BasicInterruptController();
    c.raiseNMI();
    c.raiseNMI();
    expect(c.consumeNMI()).toBe(true);
    expect(c.consumeNMI()).toBe(false);
  });
});

describe('BasicInterruptController — coexistence', () => {
  it('NMI and maskables track independently', () => {
    const c = new BasicInterruptController();
    c.raise(0x40);
    c.raiseNMI();
    expect(c.hasNMI()).toBe(true);
    expect(c.hasMaskable()).toBe(true);
    // Consume in either order; the other stays
    expect(c.consumeNMI()).toBe(true);
    expect(c.hasNMI()).toBe(false);
    expect(c.hasMaskable()).toBe(true);
    expect(c.consumeMaskable()).toBe(0x40);
  });
});

describe('NullInterruptController', () => {
  it('reports nothing pending and accepts raise without effect', () => {
    expect(NullInterruptController.hasNMI()).toBe(false);
    expect(NullInterruptController.hasMaskable()).toBe(false);
    expect(NullInterruptController.consumeNMI()).toBe(false);
    NullInterruptController.raise(0x40);
    NullInterruptController.raiseNMI();
    expect(NullInterruptController.hasNMI()).toBe(false);
    expect(NullInterruptController.hasMaskable()).toBe(false);
  });

  it('consumeMaskable throws (the queue is always empty)', () => {
    expect(() => NullInterruptController.consumeMaskable()).toThrow();
  });
});
