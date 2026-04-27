/**
 * Trace-driven step loop for ELKS-boot debugging.
 *
 * `traceRun` replaces `RunLoop.run()` for tests that want per-instruction
 * inspection. It:
 *
 *   1. Installs IO + memory-write instrumentation via `instrumentMachine`.
 *   2. Runs `cpu.step()` in a tight synchronous loop up to `maxInstructions`.
 *   3. Before each step, records:
 *        - an `instruction` event (CS:IP, opcode bytes, register snapshot);
 *        - an `int` event if the byte at CS:IP is a software-INT opcode;
 *        - a `trap` event if the linear address has a registered handler;
 *        - an `intService` event if a pending interrupt is about to fire
 *          (NMI; or maskable when IF=1 and inhibit clear).
 *   4. Tears down instrumentation in `finally`.
 *
 * The runner is synchronous — it doesn't yield to the event loop, doesn't
 * await anything. That's fine for boot tracing where there are no async
 * sources (the disk is in-memory, the host clock is deterministic, the
 * PIT is driven from the virtual clock which we advance manually).
 *
 * Halt handling: if the CPU halts, we advance the virtual clock by a
 * batch of cycles (so a PIT-driven IRQ 0 can wake it) and re-check.
 * After a configurable number of unsuccessful halt-spins we bail out as
 * `'halted'` — without this, a kernel that HLTs waiting for a serial
 * IRQ that never comes would hang the test forever.
 */

import type { IBMPCMachine } from '../machine/ibm-pc.js';
import type { CPU8086 } from '../cpu8086/cpu.js';
import { instrumentMachine } from './instrument.js';
import type { Tracer, TraceEvent } from './tracer.js';

export interface TraceRunOptions {
  tracer: Tracer;
  /** Hard cap on instructions executed. Always set this; loops are real. */
  maxInstructions: number;
  /**
   * Whether to wire IO + memory-write instrumentation. Default `true`.
   * Tests that only care about instruction / INT / trap / intService events
   * can disable this for a tiny perf bump.
   */
  instrument?: boolean;
  /**
   * Cycles to advance the virtual clock per halt-spin tick. Default `1000`.
   * Small enough to not burn through too much virtual time per HLT, large
   * enough that PIT-driven IRQ 0 (default divisor 65536 → ~18 Hz) fires
   * within a reasonable number of spins.
   */
  haltSpinCycles?: number;
  /**
   * Maximum number of halt-spin iterations with no wake before bailing out.
   * Default `1_000`. Default × `haltSpinCycles` = 1e6 virtual cycles, which
   * at ~18 Hz IRQ 0 should fire many times. If we hit the cap, the kernel
   * is genuinely waiting on something that never comes (serial, keyboard).
   */
  maxHaltSpins?: number;
}

export interface TraceRunResult {
  executed: number;
  reason: 'halted' | 'instruction-limit' | 'error' | 'halt-spin-exhausted';
  /** Populated when `reason === 'error'`. */
  error?: { name: string; message: string; stack?: string };
}

/**
 * Pre-step inspector. Reads the current CS:IP, decodes whether the upcoming
 * instruction is an INT or a BIOS trap, and emits the corresponding events
 * BEFORE calling `cpu.step()`.
 *
 * Note on event ordering: when an interrupt is about to be serviced AND the
 * upcoming opcode is an INT, the service fires first (the CPU's `step()`
 * services the boundary, then fetches — and after service the new CS:IP is
 * in the handler, so the post-service "INT" event would no longer apply
 * here). To keep events accurate without double-recording, we record the
 * `intService` event and skip the INT/trap/instruction events when service
 * is pending — the next step's pre-record captures the handler's first
 * instruction cleanly.
 */
function preStepRecord(machine: IBMPCMachine, cpu: CPU8086, tracer: Tracer): void {
  const ctrl = cpu.intCtrl;
  const nmiPending = ctrl.hasNMI();
  const maskableServicable =
    ctrl.hasMaskable() && cpu.flags.IF && !cpu.interruptInhibit;
  if (nmiPending || maskableServicable) {
    if (tracer.enabled('intService')) {
      tracer.record({
        type: 'intService',
        // For maskable we can't peek the vector without consuming; tag -1.
        vector: nmiPending ? 2 : -1,
        cs: cpu.regs.CS,
        ip: cpu.regs.IP,
      });
    }
    return;
  }

  const cs = cpu.regs.CS;
  const ip = cpu.regs.IP;
  const linear = ((cs << 4) + ip) & 0xFFFFF;

  if (tracer.enabled('instruction')) {
    const bytes: number[] = [];
    for (let i = 0; i < 6; i++) {
      bytes.push(cpu.memory.readByte(linear + i));
    }
    tracer.record({
      type: 'instruction',
      cs, ip, linear, bytes,
      ax: cpu.regs.AX, bx: cpu.regs.BX, cx: cpu.regs.CX, dx: cpu.regs.DX,
      si: cpu.regs.SI, di: cpu.regs.DI, bp: cpu.regs.BP, sp: cpu.regs.SP,
      ds: cpu.regs.DS, es: cpu.regs.ES, ss: cpu.regs.SS,
      flags: cpu.flags.value,
    });
  }

  // Software-INT detection. 0xCD imm8 / 0xCC (INT 3) / 0xCE (INTO).
  if (tracer.enabled('int')) {
    const opcode = cpu.memory.readByte(linear);
    if (opcode === 0xCD || opcode === 0xCC || opcode === 0xCE) {
      const vector =
        opcode === 0xCC ? 3 :
        opcode === 0xCE ? 4 :
        cpu.memory.readByte(linear + 1);
      tracer.record({
        type: 'int',
        vector,
        cs, ip,
        ax: cpu.regs.AX, bx: cpu.regs.BX, cx: cpu.regs.CX, dx: cpu.regs.DX,
      });
    }
  }

  // BIOS trap detection. The trap registry is keyed on linear CS:IP.
  if (tracer.enabled('trap') && machine.traps !== null) {
    const handler = machine.traps.get(linear);
    if (handler !== undefined) {
      const vector =
        machine.bios !== null && linear >= 0xF1000 && linear <= 0xF10FF
          ? linear - 0xF1000
          : null;
      tracer.record({
        type: 'trap',
        linear,
        vector,
        cs, ip,
        ah: cpu.regs.AH, al: cpu.regs.AL,
        bx: cpu.regs.BX, cx: cpu.regs.CX, dx: cpu.regs.DX,
        ds: cpu.regs.DS, es: cpu.regs.ES,
      });
    }
  }
}

/**
 * Drive the machine's CPU under tracer instrumentation. See module doc.
 */
export function traceRun(
  machine: IBMPCMachine,
  opts: TraceRunOptions,
): TraceRunResult {
  const { tracer, maxInstructions } = opts;
  const haltSpinCycles = opts.haltSpinCycles ?? 1000;
  const maxHaltSpins = opts.maxHaltSpins ?? 1000;
  const cpu = machine.cpu;

  const teardown =
    opts.instrument !== false
      ? instrumentMachine(machine, { tracer })
      : () => { /* no-op */ };

  let executed = 0;
  let haltSpins = 0;
  try {
    while (executed < maxInstructions) {
      if (cpu.halted) {
        const ctrl = cpu.intCtrl;
        const can =
          ctrl.hasNMI() ||
          (ctrl.hasMaskable() && cpu.flags.IF && !cpu.interruptInhibit);
        if (can) {
          // step() will service the pending interrupt and unhalt.
          preStepRecord(machine, cpu, tracer);
          cpu.step();
          executed++;
          haltSpins = 0;
          continue;
        }
        if (haltSpins >= maxHaltSpins) {
          return { executed, reason: 'halt-spin-exhausted' };
        }
        machine.clock.advance(haltSpinCycles);
        haltSpins++;
        continue;
      }
      preStepRecord(machine, cpu, tracer);
      cpu.step();
      executed++;
      haltSpins = 0;
      // Drive the virtual clock so the PIT can fire IRQ 0. Without this
      // a kernel that polls jiffies via INT 8 increments wouldn't see them
      // tick. We advance by 1 cycle per instruction — the same convention
      // the run loop uses with cyclesPerPitTick=1 in tests.
      machine.clock.advance(1);
    }
    return { executed, reason: 'instruction-limit' };
  } catch (err) {
    const e = err as Error;
    return {
      executed,
      reason: 'error',
      error: { name: e.name, message: e.message, stack: e.stack },
    };
  } finally {
    teardown();
  }
}

/**
 * Format a single trace event as a single line of text. Useful for digests.
 */
export function formatEvent(e: TraceEvent): string {
  switch (e.type) {
    case 'instruction': {
      const bytes = e.bytes
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      return (
        `INSTR ${hex4(e.cs)}:${hex4(e.ip)} (${hex5(e.linear)}) ` +
        `bytes=${bytes} ` +
        `AX=${hex4(e.ax)} BX=${hex4(e.bx)} CX=${hex4(e.cx)} DX=${hex4(e.dx)} ` +
        `SI=${hex4(e.si)} DI=${hex4(e.di)} BP=${hex4(e.bp)} SP=${hex4(e.sp)} ` +
        `DS=${hex4(e.ds)} ES=${hex4(e.es)} SS=${hex4(e.ss)} F=${hex4(e.flags)}`
      );
    }
    case 'int':
      return (
        `INT  vec=${hex2(e.vector)} from=${hex4(e.cs)}:${hex4(e.ip)} ` +
        `AX=${hex4(e.ax)} BX=${hex4(e.bx)} CX=${hex4(e.cx)} DX=${hex4(e.dx)}`
      );
    case 'trap':
      return (
        `TRAP at=${hex5(e.linear)} ` +
        (e.vector !== null ? `vec=${hex2(e.vector)} ` : '') +
        `AH=${hex2(e.ah)} AL=${hex2(e.al)} ` +
        `BX=${hex4(e.bx)} CX=${hex4(e.cx)} DX=${hex4(e.dx)} ` +
        `DS=${hex4(e.ds)} ES=${hex4(e.es)}`
      );
    case 'io':
      return (
        `IO   ${e.dir.toUpperCase()}.${e.size} port=${hex4(e.port)} ` +
        `value=${e.size === 'b' ? hex2(e.value) : hex4(e.value)}`
      );
    case 'memWrite':
      return (
        `MEM  W.${e.size} ${hex5(e.addr)} <- ` +
        (e.size === 'b' ? hex2(e.value) : hex4(e.value))
      );
    case 'intService':
      return `SVC  vec=${e.vector === -1 ? 'maskable' : hex2(e.vector)} at=${hex4(e.cs)}:${hex4(e.ip)}`;
  }
}

function hex2(n: number): string { return n.toString(16).padStart(2, '0'); }
function hex4(n: number): string { return n.toString(16).padStart(4, '0'); }
function hex5(n: number): string { return n.toString(16).padStart(5, '0'); }
