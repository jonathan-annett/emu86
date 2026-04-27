import { describe, expect, it, vi } from 'vitest';
import { linearAddress } from '../../src/core/types.js';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PIC8259 } from '../../src/devices/pic.js';
import { BasicInterruptController } from '../../src/interrupts/index.js';
import { BasicIOBus } from '../../src/io/io-bus.js';
import { PagedMemory } from '../../src/memory/index.js';
import { RunLoop } from '../../src/runtime/index.js';

/**
 * End-to-end: real CPU + real memory + real interrupt controller + real
 * IOBus + real PIC. The CPU programs the PIC over I/O ports, the test code
 * raises an IRQ from the device side, and the CPU services it through the
 * controller, runs the handler, sends an EOI, and IRETs.
 *
 * This is a single test by design — the unit tests cover the corners
 * exhaustively. The integration test's job is just to demonstrate that the
 * whole pipeline composes.
 */

describe('CPU + IOBus + PIC integration', () => {
  it('programs the PIC, halts, services an IRQ, runs the handler, EOIs, and IRETs', async () => {
    vi.useFakeTimers();
    try {
      // ---- Memory layout ----
      //   0000:0000   main program (PIC init → STI → HLT → HLT)
      //   0100:0000   ISR for IRQ 0 (vector 8) — does work, EOIs, IRETs
      //   0000:1000   stack top
      //   0000:0020   IVT entry for vector 8 (vector base 8 + IRQ 0)
      const mem = new PagedMemory();

      // -- Main program at 0:0 --
      // MOV AL, 0x13   ; ICW1 — single-PIC, expect ICW4
      // OUT 0x20, AL
      // MOV AL, 0x08   ; ICW2 — vector base 8 (so IRQ 0 → vector 8)
      // OUT 0x21, AL
      // MOV AL, 0x01   ; ICW4 — 8086 mode
      // OUT 0x21, AL
      // MOV AL, 0xFE   ; OCW1 — IMR: only IRQ 0 unmasked
      // OUT 0x21, AL
      // STI
      // HLT
      // HLT            ; second HLT — IRET returns here, CPU halts again
      const main = [
        0xB0, 0x13,   //  0: MOV AL, 0x13
        0xE6, 0x20,   //  2: OUT 0x20, AL
        0xB0, 0x08,   //  4: MOV AL, 0x08
        0xE6, 0x21,   //  6: OUT 0x21, AL
        0xB0, 0x01,   //  8: MOV AL, 0x01
        0xE6, 0x21,   // 10: OUT 0x21, AL
        0xB0, 0xFE,   // 12: MOV AL, 0xFE
        0xE6, 0x21,   // 14: OUT 0x21, AL
        0xFB,         // 16: STI
        0xF4,         // 17: HLT     ← CPU sleeps here, IP advances to 18
        0xF4,         // 18: HLT     ← IRET returns here
      ];
      main.forEach((b, i) => mem.writeByte(i, b));

      // -- IRQ 0 handler at 0x100:0 --
      // MOV AL, 0x20   ; non-specific EOI command
      // OUT 0x20, AL
      // MOV AX, 0x1234 ; sentinel — proves the handler ran
      // IRET
      const handler = [
        0xB0, 0x20,                   //  0: MOV AL, 0x20  (EOI command byte)
        0xE6, 0x20,                   //  2: OUT 0x20, AL
        0xB8, 0x34, 0x12,             //  4: MOV AX, 0x1234
        0xCF,                         //  7: IRET
      ];
      handler.forEach((b, i) => mem.writeByte(linearAddress(0x100, i), b));

      // -- IVT entry for vector 8 (IRQ 0 with vectorBase = 8) --
      mem.writeWord(8 * 4, 0);            // IP = 0
      mem.writeWord(8 * 4 + 2, 0x100);    // CS = 0x100

      // ---- Wire it up ----
      const ctrl = new BasicInterruptController();
      const bus = new BasicIOBus();
      const pic = new PIC8259(ctrl);
      pic.registerOn(bus);
      const cpu = new CPU8086(mem, bus, ctrl);
      cpu.reset();
      cpu.regs.CS = 0; cpu.regs.IP = 0;
      cpu.regs.SS = 0; cpu.regs.SP = 0x1000;

      // Schedule the IRQ assertion for after the CPU has finished programming
      // the PIC and reached HLT. The halt-spin in the run loop yields between
      // attempts, which gives setTimeout callbacks a chance to fire.
      setTimeout(() => pic.assertIRQ(0), 50);

      const loop = new RunLoop(cpu);
      const runPromise = loop.run();

      // Drive the fake clock past the source's deadline. The loop:
      //   1. Executes the PIC programming sequence (8 OUT instructions).
      //   2. STI (sets inhibit window for one instruction).
      //   3. HLT (CPU halts, run-loop enters halt-spin).
      //   4. setTimeout fires at t=50 → pic.assertIRQ(0) → controller.raise(8).
      //   5. Next halt-spin iteration sees pending; CPU services interrupt.
      //   6. Handler runs: OUT 0x20, AL (EOI clears ISR), MOV AX, IRET.
      //   7. CPU returns to HLT at offset 18, halts again, halt-spins.
      await vi.advanceTimersByTimeAsync(100);

      // ---- Assertions: the whole pipeline did its job ----
      expect(cpu.regs.AX).toBe(0x1234);            // handler ran to completion
      expect(pic.getISR()).toBe(0);                // EOI cleared in-service bit
      expect(pic.getIRR()).toBe(0);                // no pending IRQs
      expect(ctrl.hasMaskable()).toBe(false);      // controller queue drained
      expect(cpu.halted).toBe(true);               // re-halted at offset 18
      expect(cpu.regs.CS).toBe(0);                 // back in main code segment
      expect(cpu.regs.IP).toBe(19);                // past the second HLT
      // IF was set (STI before the first HLT) and IRET restored the pre-service
      // FLAGS, where IF was also set by the time of HLT. So IF stays set.
      expect(cpu.flags.IF).toBe(true);

      loop.stop();
      await vi.advanceTimersByTimeAsync(1);
      const result = await runPromise;
      expect(result.reason).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });
});
