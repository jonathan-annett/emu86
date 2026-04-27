import { describe, expect, it } from 'vitest';
import { linearAddress } from '../../src/core/types.js';
import { CPU8086 } from '../../src/cpu8086/cpu.js';
import { PIC8259, PIT8254 } from '../../src/devices/index.js';
import { BasicInterruptController } from '../../src/interrupts/controller.js';
import { BasicIOBus } from '../../src/io/io-bus.js';
import { IBMPCMachine } from '../../src/machine/index.js';
import { InMemoryPageStore, PagedMemory } from '../../src/memory/index.js';
import { RunLoop } from '../../src/runtime/index.js';
import { Clock } from '../../src/timing/index.js';

/**
 * Tests for the {@link IBMPCMachine} composition class. These are
 * deliberately *narrow* — every device's individual behaviour is covered
 * by its own unit suite. What we test here is the wiring the Machine adds
 * on top: construction, lifecycle, and one end-to-end program that
 * exercises CPU + PIC + PIT + IRQ delivery through the assembled system.
 */

describe('IBMPCMachine — construction and component wiring', () => {
  it('exposes all components with the right concrete types', () => {
    const m = new IBMPCMachine();
    expect(m.cpu).toBeInstanceOf(CPU8086);
    expect(m.memory).toBeInstanceOf(PagedMemory);
    expect(m.controller).toBeInstanceOf(BasicInterruptController);
    expect(m.clock).toBeInstanceOf(Clock);
    expect(m.bus).toBeInstanceOf(BasicIOBus);
    expect(m.pic).toBeInstanceOf(PIC8259);
    expect(m.pit).toBeInstanceOf(PIT8254);
    expect(m.runLoop).toBeInstanceOf(RunLoop);
  });

  it('uses the documented defaults: 1 MiB memory, 4 cycles/PIT tick', () => {
    const m = new IBMPCMachine();
    expect(m.memory.addressSpaceSize).toBe(0x100000);
    // The PIT's cyclesPerPitTick is private; verify indirectly by ticking
    // the clock once and checking we did NOT advance a programmed channel
    // by a full tick.
    // Program ch0 mode 2 divisor 1000 so we can observe the live counter.
    m.bus.outByte(0x43, 0x34); // ch0, lohi, mode 2
    m.bus.outByte(0x40, 0xE8); // 1000 low
    m.bus.outByte(0x40, 0x03); // 1000 high
    expect(m.pit.getChannelCounter(0)).toBe(1000);
    m.clock.advance(3); // less than cyclesPerPitTick (4) → counter unchanged
    expect(m.pit.getChannelCounter(0)).toBe(1000);
    m.clock.advance(1); // total 4 → exactly one PIT tick
    expect(m.pit.getChannelCounter(0)).toBe(999);
  });

  it('honours custom memorySize and cyclesPerPitTick', () => {
    const m = new IBMPCMachine({ memorySize: 0x10000, cyclesPerPitTick: 1 });
    expect(m.memory.addressSpaceSize).toBe(0x10000);
    // With cyclesPerPitTick=1, every clock cycle is one PIT tick.
    m.bus.outByte(0x43, 0x34);
    m.bus.outByte(0x40, 0x05);
    m.bus.outByte(0x40, 0x00);
    expect(m.pit.getChannelCounter(0)).toBe(5);
    m.clock.advance(1);
    expect(m.pit.getChannelCounter(0)).toBe(4);
  });

  it('registers PIC at ports 0x20-0x21 and PIT at ports 0x40-0x43', () => {
    // Overlapping registration of either port range should throw — the
    // simplest proof that those ports are already claimed.
    const m = new IBMPCMachine();
    const dummy = { readByte: () => 0, writeByte: () => { /* */ } };
    expect(() => m.bus.register({ start: 0x20, end: 0x20 }, dummy)).toThrow();
    expect(() => m.bus.register({ start: 0x21, end: 0x21 }, dummy)).toThrow();
    expect(() => m.bus.register({ start: 0x40, end: 0x40 }, dummy)).toThrow();
    expect(() => m.bus.register({ start: 0x43, end: 0x43 }, dummy)).toThrow();
  });

  it('wires PIT channel 0 rising edges to PIC IRQ 0', () => {
    const m = new IBMPCMachine({ cyclesPerPitTick: 1 });
    // Program PIC: standard single-PIC init, vector base 0x08, only IRQ 0 unmasked.
    m.bus.outByte(0x20, 0x13);
    m.bus.outByte(0x21, 0x08);
    m.bus.outByte(0x21, 0x01);
    m.bus.outByte(0x21, 0xFE);
    // Program PIT ch0 mode 3 divisor 4 — fires on every period boundary.
    m.bus.outByte(0x43, 0x36);
    m.bus.outByte(0x40, 0x04);
    m.bus.outByte(0x40, 0x00);
    // Drive the clock through one full PIT period; the rising-edge
    // callback should reach the PIC and forward vector 8 to the controller.
    m.clock.advance(4);
    expect(m.controller.hasMaskable()).toBe(true);
    expect(m.controller.consumeMaskable()).toBe(0x08);
  });
});

describe('IBMPCMachine — loadProgram / setEntryPoint', () => {
  it('loadProgram writes the bytes at the given linear address (number[])', () => {
    const m = new IBMPCMachine();
    m.loadProgram([0xAA, 0xBB, 0xCC, 0xDD], 0x1234);
    expect(m.memory.readByte(0x1234)).toBe(0xAA);
    expect(m.memory.readByte(0x1235)).toBe(0xBB);
    expect(m.memory.readByte(0x1236)).toBe(0xCC);
    expect(m.memory.readByte(0x1237)).toBe(0xDD);
  });

  it('loadProgram accepts a Uint8Array', () => {
    const m = new IBMPCMachine();
    m.loadProgram(new Uint8Array([0x90, 0xF4]), 0x500);
    expect(m.memory.readByte(0x500)).toBe(0x90);
    expect(m.memory.readByte(0x501)).toBe(0xF4);
  });

  it('setEntryPoint updates CS:IP', () => {
    const m = new IBMPCMachine();
    m.cpu.reset(); // CS = 0xFFFF, IP = 0x0000
    m.setEntryPoint(0x1000, 0x0042);
    expect(m.cpu.regs.CS).toBe(0x1000);
    expect(m.cpu.regs.IP).toBe(0x0042);
  });
});

describe('IBMPCMachine — reset semantics', () => {
  it('returns CPU, controller, PIC, PIT, and clock to power-on state', () => {
    const m = new IBMPCMachine({ cyclesPerPitTick: 1 });
    // Mutate every component.
    m.bus.outByte(0x20, 0x13);
    m.bus.outByte(0x21, 0x08);
    m.bus.outByte(0x21, 0x01);
    m.bus.outByte(0x21, 0x55); // IMR set to non-default
    m.bus.outByte(0x43, 0x36);
    m.bus.outByte(0x40, 0x04);
    m.bus.outByte(0x40, 0x00);
    m.clock.advance(100);
    m.controller.raise(42);
    m.cpu.regs.CS = 0x1234;
    m.cpu.regs.IP = 0x5678;

    m.reset();

    // CPU at the standard reset vector.
    expect(m.cpu.regs.CS).toBe(0xFFFF);
    expect(m.cpu.regs.IP).toBe(0x0000);
    // Controller drained.
    expect(m.controller.hasMaskable()).toBe(false);
    expect(m.controller.hasNMI()).toBe(false);
    // PIC back to uninitialized state.
    expect(m.pic.getInitState()).toBe('idle');
    expect(m.pic.getIMR()).toBe(0xFF);
    expect(m.pic.getISR()).toBe(0);
    expect(m.pic.getIRR()).toBe(0);
    expect(m.pic.getVectorBase()).toBe(0);
    // PIT back to "not programmed" on every channel.
    expect(m.pit.getChannelProgrammed(0)).toBe(false);
    expect(m.pit.getChannelProgrammed(1)).toBe(false);
    expect(m.pit.getChannelProgrammed(2)).toBe(false);
    // Clock back to 0.
    expect(m.clock.now()).toBe(0);
  });

  it('preserves memory contents across reset', () => {
    const m = new IBMPCMachine();
    m.memory.writeByte(0x1000, 0x42);
    m.memory.writeByte(0xABCDE, 0x99);
    m.reset();
    expect(m.memory.readByte(0x1000)).toBe(0x42);
    expect(m.memory.readByte(0xABCDE)).toBe(0x99);
  });

  it('keeps PIT subscribed to the clock after reset', () => {
    // Reset must not detach the PIT — otherwise the next program would
    // count down a phantom counter that never gets ticked.
    const m = new IBMPCMachine({ cyclesPerPitTick: 1 });
    m.reset();
    m.bus.outByte(0x43, 0x34);
    m.bus.outByte(0x40, 0x10);
    m.bus.outByte(0x40, 0x00);
    expect(m.pit.getChannelCounter(0)).toBe(0x10);
    m.clock.advance(1);
    expect(m.pit.getChannelCounter(0)).toBe(0x0F);
  });

  it('still wires PIT channel 0 → PIC IRQ 0 after reset', () => {
    // Re-prove the rising-edge wire after a power cycle. A fresh `reset()`
    // on the PIC and PIT must not detach the constructor-time callback.
    const m = new IBMPCMachine({ cyclesPerPitTick: 1 });
    m.reset();
    m.bus.outByte(0x20, 0x13);
    m.bus.outByte(0x21, 0x08);
    m.bus.outByte(0x21, 0x01);
    m.bus.outByte(0x21, 0xFE);
    m.bus.outByte(0x43, 0x36);
    m.bus.outByte(0x40, 0x04);
    m.bus.outByte(0x40, 0x00);
    m.clock.advance(4);
    expect(m.controller.hasMaskable()).toBe(true);
  });
});

describe('IBMPCMachine — pageStore wiring', () => {
  it('threads a custom pageStore through to memory persistence', async () => {
    const store = new InMemoryPageStore();
    const m = new IBMPCMachine({ pageStore: store });
    m.memory.writeByte(0x2000, 0x77);
    const written = await m.memory.flushDirty();
    expect(written).toBeGreaterThan(0);
    // Reconstruct a fresh machine with the same store and hydrate to
    // confirm the byte made it through.
    const m2 = new IBMPCMachine({ pageStore: store });
    await m2.memory.hydrate();
    expect(m2.memory.readByte(0x2000)).toBe(0x77);
  });
});

describe('IBMPCMachine — end-to-end PIC + PIT + IRQ program', () => {
  /**
   * The headline test of this brief: the same program shape as
   * `cpu-pit-pic-integration.test.ts`, but driven through the Machine's
   * wiring instead of hand-wired components. The Machine earns its keep
   * if this test passes with significantly less setup boilerplate.
   *
   * Memory layout (chosen to match the existing integration test exactly,
   * so the program bytes are reused verbatim):
   *
   *   0000:0000   main program
   *   0100:0000   IRQ 0 ISR (vector 8)
   *   0000:1000   stack top
   *   0000:0020   IVT entry for vector 8
   *   0000:2000   tick counter (word)
   */
  it('runs PIT-driven IRQ 0 handler through the Machine wiring', async () => {
    const m = new IBMPCMachine({
      cyclesPerPitTick: 1,
      batchSize: 100,
      haltCyclesPerSpin: 100,
    });

    // Main program at 0:0. See `cpu-pit-pic-integration.test.ts` for the
    // line-by-line annotation; this is the same byte sequence.
    const main = [
      0xB0, 0x13, 0xE6, 0x20,    //  0: MOV AL, 0x13; OUT 0x20, AL  (ICW1)
      0xB0, 0x08, 0xE6, 0x21,    //  4: MOV AL, 0x08; OUT 0x21, AL  (ICW2: vector base 8)
      0xB0, 0x01, 0xE6, 0x21,    //  8: MOV AL, 0x01; OUT 0x21, AL  (ICW4: 8086 mode)
      0xB0, 0xFE, 0xE6, 0x21,    // 12: MOV AL, 0xFE; OUT 0x21, AL  (IMR: only IRQ 0 unmasked)
      0xB0, 0x36, 0xE6, 0x43,    // 16: MOV AL, 0x36; OUT 0x43, AL  (ch0 mode 3 lohi)
      0xB0, 0x64, 0xE6, 0x40,    // 20: MOV AL, 0x64; OUT 0x40, AL  (divisor low = 100)
      0xB0, 0x00, 0xE6, 0x40,    // 24: MOV AL, 0x00; OUT 0x40, AL  (divisor high)
      0xFB,                       // 28: STI
      0xF4,                       // 29: HLT
      0xEB, 0xFD,                 // 30: JMP -3 (back to HLT at 29)
    ];
    m.loadProgram(main, 0);

    // IRQ 0 ISR at 0100:0000 — increments counter at 0:0x2000, EOIs, IRETs.
    const handler = [
      0xFF, 0x06, 0x00, 0x20,    //  0: INC word ptr ds:[0x2000]
      0xB0, 0x20, 0xE6, 0x20,    //  4: MOV AL, 0x20; OUT 0x20, AL  (non-specific EOI)
      0xCF,                       //  8: IRET
    ];
    m.loadProgram(handler, linearAddress(0x100, 0));

    // IVT entry for vector 8 (linear 0x20): IP=0, CS=0x100.
    m.memory.writeWord(8 * 4, 0);
    m.memory.writeWord(8 * 4 + 2, 0x100);

    // Counter starts at 0. (PagedMemory zero-initialises pages, but be
    // explicit so the test reads as a self-contained scenario.)
    m.memory.writeWord(0x2000, 0);

    // Reset to clear any prior CPU state, then place the entry point at
    // 0:0 and prepare a stack at 0:0x1000.
    m.reset();
    m.setEntryPoint(0, 0);
    m.cpu.regs.SS = 0;
    m.cpu.regs.SP = 0x1000;
    m.cpu.regs.DS = 0;

    const result = await m.run({ maxInstructions: 1000 });

    const ticks = m.memory.readWord(0x2000);
    // Same envelope as the prior hand-wired integration test: any
    // non-trivial number of handler invocations proves the loop is stable
    // through the Machine wiring. With cyclesPerPitTick=1, divisor=100,
    // and haltCyclesPerSpin=100, each spin produces ~1 IRQ; per-handler
    // cost is ~8 instructions, so 1000 instructions delivers up to ~120
    // ticks. The upper bound is loose on purpose — the test cares about
    // "the loop is stable and doesn't run away," not exact arithmetic.
    expect(ticks).toBeGreaterThan(3);
    expect(ticks).toBeLessThan(500);

    // No spurious in-service IRQ above IRQ 0 should remain after the run.
    expect(m.pic.getISR() & 0xFE).toBe(0);

    // Should have executed somewhere between "past init" and the cap.
    expect(result.executed).toBeLessThanOrEqual(1000);
    expect(result.executed).toBeGreaterThan(20);
  });
});
