import { describe, expect, it, vi } from 'vitest';
import { linearAddress } from '../../src/core/types.js';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { BasicInterruptController } from '../../src/interrupts/index.js';
import { PagedMemory } from '../../src/memory/index.js';
import { RunLoop } from '../../src/runtime/index.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0;
  cpu.regs.IP = 0;
  return cpu;
}

describe('RunLoop', () => {
  it('runs until HLT and reports reason=halted', async () => {
    // 5 × NOP, then HLT
    const cpu = cpuWith([0x90, 0x90, 0x90, 0x90, 0x90, 0xF4]);
    const loop = new RunLoop(cpu);
    const result = await loop.run();
    expect(result.reason).toBe('halted');
    expect(result.executed).toBe(6);      // 5 NOPs + HLT
    expect(cpu.halted).toBe(true);
    expect(cpu.regs.IP).toBe(6);
  });

  it('respects maxInstructions', async () => {
    // Infinite loop: EB FE jumps to itself
    const cpu = cpuWith([0xEB, 0xFE]);
    const loop = new RunLoop(cpu);
    const result = await loop.run({ maxInstructions: 100 });
    expect(result.reason).toBe('instruction-limit');
    expect(result.executed).toBe(100);
  });

  it('stop() halts a running loop', async () => {
    const cpu = cpuWith([0xEB, 0xFE]);    // infinite loop
    const loop = new RunLoop(cpu);
    // Small batch so we see stop quickly
    const runPromise = loop.run({ batchSize: 100 });
    // Let it run a bit then stop
    await new Promise((r) => setTimeout(r, 10));
    loop.stop();
    const result = await runPromise;
    expect(result.reason).toBe('stopped');
    expect(result.executed).toBeGreaterThan(0);
  });

  it('yields between batches so setTimeout callbacks can run', async () => {
    const cpu = cpuWith([0xEB, 0xFE]);
    const loop = new RunLoop(cpu);
    let timerFired = false;

    // Kick off the loop with a small batch; if we don't yield between
    // batches, the setTimeout below will starve.
    const runPromise = loop.run({ batchSize: 10, maxInstructions: 1000 });
    setTimeout(() => { timerFired = true; }, 0);

    await runPromise;
    expect(timerFired).toBe(true);
  });

  it('running two run() calls concurrently returns the same promise', async () => {
    const cpu = cpuWith([0x90, 0xF4]);
    const loop = new RunLoop(cpu);
    const p1 = loop.run();
    const p2 = loop.run();
    expect(p1).toBe(p2);
    await p1;
  });

  it('halted CPU is woken by maskable interrupt from async source', async () => {
    // Fake-timer-driven source. The loop hits HLT, halt-spins (yields in a
    // loop while halted with a real controller). The source fires at t=50,
    // calls ctrl.raise(), and the next yield resolution sees the queue.
    // We use stop() to terminate the halt-spin once we've verified the
    // service happened.
    vi.useFakeTimers();
    try {
      const mem = new PagedMemory();
      mem.writeByte(0, 0xF4);                                 // HLT
      mem.writeWord(0x40 * 4, 0);                             // IVT[0x40].IP
      mem.writeWord(0x40 * 4 + 2, 0x100);                     // IVT[0x40].CS
      mem.writeByte(linearAddress(0x100, 0), 0xF4);           // HLT in handler

      const ctrl = new BasicInterruptController();
      const cpu = new CPU8086(mem, undefined, ctrl);
      cpu.reset();
      cpu.regs.CS = 0; cpu.regs.IP = 0;
      cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
      cpu.flags.IF = true;

      setTimeout(() => ctrl.raise(0x40), 50);

      const loop = new RunLoop(cpu);
      const runPromise = loop.run();

      // Advance past the source's deadline. While the loop is halted with
      // empty queue, it halt-spins (yield + recheck). When time hits 50ms
      // the source raises, and the next yield resolution services it.
      await vi.advanceTimersByTimeAsync(60);
      expect(cpu.regs.CS).toBe(0x100);
      expect(ctrl.hasMaskable()).toBe(false);

      // Loop is now halt-spinning at the handler's HLT. Stop it.
      loop.stop();
      await vi.advanceTimersByTimeAsync(1);
      const result = await runPromise;

      expect(result.reason).toBe('stopped');
      expect(result.executed).toBeGreaterThan(0);
      expect(cpu.halted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() while halted with a controller exits with reason=stopped', async () => {
    // With a real interrupt controller, the loop halt-spins after HLT
    // (waiting for an async source). stop() flips running=false; the
    // next yield resolution sees it and exits with reason='stopped'.
    const mem = new PagedMemory();
    mem.writeByte(0, 0xF4);                                   // HLT
    const ctrl = new BasicInterruptController();
    const cpu = new CPU8086(mem, undefined, ctrl);
    cpu.reset();
    cpu.regs.CS = 0; cpu.regs.IP = 0;

    const loop = new RunLoop(cpu);
    const runPromise = loop.run();
    // Give the loop a tick to hit HLT and suspend on its halt-spin yield.
    await new Promise((r) => setTimeout(r, 5));
    loop.stop();
    const result = await runPromise;
    expect(result.reason).toBe('stopped');
    expect(cpu.halted).toBe(true);
  });

  it('a second run() after the first completes starts fresh', async () => {
    // Program with HLT at end
    const cpu = cpuWith([0x90, 0xF4]);
    const loop = new RunLoop(cpu);
    const r1 = await loop.run();
    expect(r1.executed).toBe(2);

    // Clear halted, reset IP — simulates an interrupt service waking the CPU
    cpu.halted = false;
    cpu.regs.IP = 0;
    const r2 = await loop.run();
    expect(r2.executed).toBe(2);
    expect(r2.reason).toBe('halted');
  });
});
