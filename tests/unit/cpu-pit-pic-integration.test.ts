import { describe, expect, it } from 'vitest';
import { linearAddress } from '../../src/core/types.js';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PIC8259, PIT8254 } from '../../src/devices/index.js';
import { BasicInterruptController } from '../../src/interrupts/index.js';
import { BasicIOBus } from '../../src/io/io-bus.js';
import { PagedMemory } from '../../src/memory/index.js';
import { RunLoop } from '../../src/runtime/index.js';
import { Clock } from '../../src/timing/index.js';

/**
 * End-to-end: real CPU + memory + interrupt controller + IOBus + PIC + PIT
 * + clock. The CPU programs the PIC and PIT over I/O ports, then halts.
 * The run loop's halt-spin advances the virtual clock; the PIT counts down
 * and fires its rising-edge callback; the callback (wired by this test)
 * calls `pic.assertIRQ(0)`; the PIC resolves and raises the vector to the
 * controller; the next halt-spin iteration sees pending and services it.
 *
 * The handler increments a memory counter and EOIs. After enough virtual
 * ticks the counter has been incremented multiple times.
 */

describe('CPU + IOBus + PIC + PIT + Clock integration', () => {
  it('PIT channel 0 mode 3 → IRQ 0 → handler runs N times', async () => {
    // ---- Memory layout ----
    //   0000:0000   main program
    //   0100:0000   ISR for IRQ 0 (vector 8)
    //   0000:1000   stack top
    //   0000:0020   IVT entry for vector 8 (vectorBase=8 + IRQ 0)
    //   0000:2000   tick counter (word)
    const mem = new PagedMemory();

    // -- Main program at 0:0 --
    // PIC init:
    //   MOV AL, 0x13   ; ICW1 — single-PIC, expect ICW4
    //   OUT 0x20, AL
    //   MOV AL, 0x08   ; ICW2 — vector base 8
    //   OUT 0x21, AL
    //   MOV AL, 0x01   ; ICW4 — 8086 mode
    //   OUT 0x21, AL
    //   MOV AL, 0xFE   ; OCW1 — IMR: only IRQ 0 unmasked
    //   OUT 0x21, AL
    // PIT init for ch0 mode 3 divisor 100 (square wave):
    //   MOV AL, 0x36   ; control: ch0, lohi, mode 3, binary
    //   OUT 0x43, AL
    //   MOV AL, 0x64   ; divisor low (100)
    //   OUT 0x40, AL
    //   MOV AL, 0x00   ; divisor high
    //   OUT 0x40, AL
    //   STI
    //   HLT            ; CPU sleeps; halt-spin advances clock; PIT fires
    //   JMP $-1        ; on IRET, jump back to HLT (loop forever)
    const main = [
      0xB0, 0x13, 0xE6, 0x20,    //  0: MOV AL, 0x13; OUT 0x20, AL
      0xB0, 0x08, 0xE6, 0x21,    //  4: MOV AL, 0x08; OUT 0x21, AL
      0xB0, 0x01, 0xE6, 0x21,    //  8: MOV AL, 0x01; OUT 0x21, AL
      0xB0, 0xFE, 0xE6, 0x21,    // 12: MOV AL, 0xFE; OUT 0x21, AL
      0xB0, 0x36, 0xE6, 0x43,    // 16: MOV AL, 0x36; OUT 0x43, AL
      0xB0, 0x64, 0xE6, 0x40,    // 20: MOV AL, 0x64; OUT 0x40, AL
      0xB0, 0x00, 0xE6, 0x40,    // 24: MOV AL, 0x00; OUT 0x40, AL
      0xFB,                       // 28: STI
      0xF4,                       // 29: HLT
      0xEB, 0xFD,                 // 30: JMP -3 (back to HLT at 29)
    ];
    main.forEach((b, i) => mem.writeByte(i, b));

    // -- IRQ 0 handler at 0x100:0 --
    // INC word ptr [0x2000]   ; bump tick counter
    // MOV AL, 0x20            ; non-specific EOI
    // OUT 0x20, AL
    // IRET
    const handler = [
      0xFF, 0x06, 0x00, 0x20,    //  0: INC word ptr ds:[0x2000]
      0xB0, 0x20, 0xE6, 0x20,    //  4: MOV AL, 0x20; OUT 0x20, AL
      0xCF,                       //  8: IRET
    ];
    handler.forEach((b, i) => mem.writeByte(linearAddress(0x100, i), b));

    // -- IVT entry for vector 8 --
    mem.writeWord(8 * 4, 0);            // IP = 0
    mem.writeWord(8 * 4 + 2, 0x100);    // CS = 0x100

    // -- Tick counter starts at 0 --
    mem.writeWord(0x2000, 0);

    // ---- Wire it up ----
    const ctrl = new BasicInterruptController();
    const bus = new BasicIOBus();
    const pic = new PIC8259(ctrl);
    pic.registerOn(bus);
    const clock = new Clock();
    // Wire PIT channel 0's rising edge to the PIC's IRQ 0 line. This is
    // the integration the future Machine config will install for real.
    const pit = new PIT8254(clock, {
      // cyclesPerPitTick = 1 keeps the math obvious and tightens the test.
      cyclesPerPitTick: 1,
      onChannel0RisingEdge: () => pic.assertIRQ(0),
    });
    pit.registerOn(bus);

    const cpu = new CPU8086(mem, bus, ctrl);
    cpu.reset();
    cpu.regs.CS = 0; cpu.regs.IP = 0;
    cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
    cpu.regs.DS = 0;

    const loop = new RunLoop(cpu);
    // Modest budget: run long enough for several timer ticks. With
    //   - cyclesPerPitTick = 1
    //   - PIT divisor = 100
    //   - haltCyclesPerSpin defaulting to batchSize = 100
    // each halt-spin advances 100 cycles → 1 PIT tick edge → 1 IRQ.
    // 50 iterations of the loop = ~50 ticks = ~50 IRQs handled. Capping
    // maxInstructions cleanly bounds the test.
    const result = await loop.run({
      clock,
      batchSize: 100,
      haltCyclesPerSpin: 100,
      maxInstructions: 1000,
    });

    // ---- Assertions: the whole pipeline did its job ----
    const ticks = mem.readWord(0x2000);
    // We expect *some* ticks. Exact count depends on the budget vs how many
    // instructions each handler invocation costs (init: 16 instrs, then
    // each tick: HLT, INC, MOV, OUT, IRET, JMP, HLT — 7-ish instructions
    // per tick). 1000 / 10 = 100 max, but the halt-spin's 100-cycle
    // advance + PIT divisor 100 produces ~1 IRQ per spin. We just want
    // the handler to have run multiple times — anything > 3 demonstrates
    // the loop is stable.
    expect(ticks).toBeGreaterThan(3);

    // The PIC should have no spurious in-service or pending IRQs at exit.
    // (After the last EOI inside the handler, the next halt-spin will
    // typically not fire another IRQ before maxInstructions hits, but if
    // it does, the IRR bit may be set.)
    expect(pic.getISR() & 0xFE).toBe(0); // no in-service IRQ above IRQ 0

    // The CPU should have made it past init and reached the HLT loop.
    expect(result.executed).toBeLessThanOrEqual(1000);
    expect(result.executed).toBeGreaterThan(20); // past the init sequence
  });
});
