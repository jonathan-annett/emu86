import { FLAG } from '../core/flags.js';
import { linearAddress } from '../core/types.js';
import type { CPU8086 } from './cpu.js';
import { OPCODE_TABLE } from './opcodes.js';

/**
 * Software interrupts and the shared "service interrupt" routine.
 *
 *   0xCC  INT 3     1-byte trap to vector 3   (debugger breakpoint)
 *   0xCD  INT imm8  call vector imm8
 *   0xCE  INTO      if OF=1, call vector 4    (overflow trap)
 *   0xCF  IRET      pop IP, CS, flags
 *
 * INT n / INT 3 / INTO / divide-error all call into {@link serviceInterrupt},
 * which performs the standard 8086 interrupt entry sequence:
 *   push FLAGS; clear IF, TF; push CS; push IP; load CS:IP from vec*4
 *
 * IRET reverses it. The TF (single-step trap) flag also gets pushed and
 * popped, so the trap state survives across an IRET — the 8086 way.
 *
 * Async interrupts (hardware INTR pin) aren't modelled yet; when they land
 * they'll use the same `serviceInterrupt` helper. The "no async sources"
 * v0 stance means software interrupts are the only callers right now.
 */

/**
 * Push flags+CS+IP and far-jump through the vector table at `0:vec*4`.
 *
 * Used by INT/INT3/INTO opcode handlers and by DIV/IDIV when they encounter
 * a divide error (vector 0). Always reads the vector from segment 0 — the
 * IVT is fixed at the bottom of physical memory on the 8086.
 */
export function serviceInterrupt(cpu: CPU8086, vec: number): void {
  cpu.push(cpu.flags.value);
  // Clear IF (interrupt enable) and TF (trap) — handled in this order so a
  // single-step trap doesn't fire on the first instruction of the handler.
  cpu.flags.value = cpu.flags.value & ~(FLAG.IF | FLAG.TF);
  cpu.push(cpu.regs.CS);
  cpu.push(cpu.regs.IP);
  const base = (vec & 0xFF) * 4;
  const newIP = readWord0(cpu, base);
  const newCS = readWord0(cpu, base + 2);
  cpu.regs.IP = newIP;
  cpu.regs.CS = newCS;
}

function readWord0(cpu: CPU8086, offset: number): number {
  const lo = cpu.memory.readByte(linearAddress(0, offset));
  const hi = cpu.memory.readByte(linearAddress(0, (offset + 1) & 0xFFFF));
  return ((hi << 8) | lo) & 0xFFFF;
}

// ============================================================
// Opcode handlers
// ============================================================

OPCODE_TABLE[0xCC] = (cpu) => {                    // INT 3
  serviceInterrupt(cpu, 3);
};

OPCODE_TABLE[0xCD] = (cpu) => {                    // INT imm8
  const vec = cpu.fetchByte();
  serviceInterrupt(cpu, vec);
};

OPCODE_TABLE[0xCE] = (cpu) => {                    // INTO
  if (cpu.flags.OF) serviceInterrupt(cpu, 4);
};

OPCODE_TABLE[0xCF] = (cpu) => {                    // IRET
  cpu.regs.IP = cpu.pop();
  cpu.regs.CS = cpu.pop();
  cpu.flags.value = cpu.pop();
};
