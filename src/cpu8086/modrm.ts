import { linearAddress, signedByte, type Word } from '../core/types.js';
import type { CPU8086 } from './cpu.js';

/**
 * ModR/M byte decoder.
 *
 * The ModR/M byte is the second byte of most "addressing" 8086 instructions.
 * Layout:
 *   bits 7-6  mod   addressing mode (00, 01, 10, 11)
 *   bits 5-3  reg   /reg field — usually a register, sometimes an opcode sub-select
 *   bits 2-0  r/m   register or memory operand selector
 *
 * Memory effective-address formulas (mod ≠ 11):
 *   rm=000  [BX+SI]      default DS
 *   rm=001  [BX+DI]      default DS
 *   rm=010  [BP+SI]      default SS  (BP-based)
 *   rm=011  [BP+DI]      default SS  (BP-based)
 *   rm=100  [SI]         default DS
 *   rm=101  [DI]         default DS
 *   rm=110  [BP]         default SS  (BP-based)
 *           — but mod=00, rm=110 is the SPECIAL CASE [disp16], default DS.
 *           Forgetting this corrupts addresses silently; treat as the textbook
 *           example of "always read the EA table from the manual".
 *   rm=111  [BX]         default DS
 *
 * Displacement by mod:
 *   mod=00  none, except the rm=110 special case → disp16
 *   mod=01  signed 8-bit displacement (sign-extended to 16)
 *   mod=10  16-bit displacement
 *   mod=11  no memory access — operand is a register
 *
 * Segment override prefixes (0x26/0x2E/0x36/0x3E) replace the default segment
 * for ALL memory accesses produced by the next instruction. The CPU's
 * `dataSegment()` / `stackSegment()` helpers already apply that override.
 *
 * Operand abstraction:
 *   `decodeRM*` returns an {@link Operand} that exposes read/write at the
 *   chosen width plus the resolved (segment, offset) for memory operands
 *   (used by LEA, LDS, LES). Callers don't branch on register-vs-memory.
 */

/** Decoded ModR/M byte. For register operands `segment`/`offset` are 0. */
export interface DecodedModRM {
  readonly mod: number;
  readonly reg: number;
  readonly rm: number;
  readonly isMemory: boolean;
  /** Segment selected for the EA, after override resolution. 0 if register. */
  readonly segment: Word;
  /** 16-bit effective offset within `segment`. 0 if register. */
  readonly offset: Word;
}

/**
 * Operand wrapper. The decoder hands one of these back so call sites work
 * uniformly whether the source/dest is a register or a memory location.
 *
 * Both read8/write8 and read16/write16 are present; the caller picks the
 * width its opcode demands. Calling read16 on a register operand uses the
 * 16-bit register at index `rm`; read8 uses the byte register at index `rm`
 * (per the standard reg8/reg16 mapping in `Registers`).
 */
export interface Operand {
  read8(): number;
  write8(v: number): void;
  read16(): number;
  write16(v: number): void;
  readonly isMemory: boolean;
  /** For memory operands: resolved segment selector. */
  readonly segment: Word;
  /** For memory operands: 16-bit offset within `segment`. */
  readonly offset: Word;
}

// ============================================================
// Decode entry point
// ============================================================

/**
 * Read the ModR/M byte at IP, advance IP past any displacement, and return
 * the decomposed fields plus the resolved EA (for memory modes).
 *
 * IP after this call points at whatever follows the ModR/M+disp — typically
 * an immediate or the next opcode.
 */
export function decodeModRM(cpu: CPU8086): DecodedModRM {
  const b = cpu.fetchByte();
  const mod = (b >>> 6) & 0x3;
  const reg = (b >>> 3) & 0x7;
  const rm  =  b        & 0x7;

  if (mod === 0b11) {
    return { mod, reg, rm, isMemory: false, segment: 0, offset: 0 };
  }

  // Memory mode — compute the 16-bit effective offset and pick the segment.
  let offset: number;
  let usesBP: boolean;   // determines default segment (BP → SS, else DS)

  if (mod === 0b00 && rm === 0b110) {
    // Special case: direct address [disp16], default DS (NOT BP-based).
    offset = cpu.fetchWord();
    usesBP = false;
  } else {
    const r = cpu.regs;
    switch (rm) {
      case 0b000: offset = (r.BX + r.SI) & 0xFFFF; usesBP = false; break;
      case 0b001: offset = (r.BX + r.DI) & 0xFFFF; usesBP = false; break;
      case 0b010: offset = (r.BP + r.SI) & 0xFFFF; usesBP = true;  break;
      case 0b011: offset = (r.BP + r.DI) & 0xFFFF; usesBP = true;  break;
      case 0b100: offset =  r.SI         & 0xFFFF; usesBP = false; break;
      case 0b101: offset =  r.DI         & 0xFFFF; usesBP = false; break;
      case 0b110: offset =  r.BP         & 0xFFFF; usesBP = true;  break;
      default:    offset = (r.BX)        & 0xFFFF; usesBP = false; break;  // 0b111
    }
    if (mod === 0b01) {
      offset = (offset + signedByte(cpu.fetchByte())) & 0xFFFF;
    } else if (mod === 0b10) {
      // 16-bit displacement is added as a *signed* value; since we mask to 16
      // bits the unsigned addition gives the same result.
      offset = (offset + cpu.fetchWord()) & 0xFFFF;
    }
  }

  const segment = usesBP ? cpu.stackSegment() : cpu.dataSegment();
  return { mod, reg, rm, isMemory: true, segment, offset };
}

// ============================================================
// Operand factories
// ============================================================

/**
 * Operand for the r/m side of a decoded ModR/M.
 *   - mod=11: register operand at index `rm`
 *   - else:    memory operand at the resolved (segment:offset)
 */
export function rmOperand(cpu: CPU8086, m: DecodedModRM): Operand {
  if (m.isMemory) return memoryOperand(cpu, m.segment, m.offset);
  return registerOperand(cpu, m.rm);
}

/** Operand for the /reg field — always a register. */
export function regOperand(cpu: CPU8086, reg: number): Operand {
  return registerOperand(cpu, reg);
}

// ----- Internal operand implementations -----

function registerOperand(cpu: CPU8086, idx: number): Operand {
  return {
    isMemory: false,
    segment: 0,
    offset: 0,
    read8:  () => cpu.regs.getReg8(idx),
    write8: (v) => cpu.regs.setReg8(idx, v & 0xFF),
    read16: () => cpu.regs.getReg16(idx),
    write16: (v) => cpu.regs.setReg16(idx, v & 0xFFFF),
  };
}

function memoryOperand(cpu: CPU8086, segment: Word, offset: Word): Operand {
  // Capture segment/offset by value; the segment override is applied at
  // decode time, so the operand carries the resolved segment with it and
  // is unaffected by later mutations to cpu.segOverride.
  const linear = linearAddress(segment, offset);
  // Word reads can straddle a page; PagedMemory handles that. For the rare
  // case of an offset of 0xFFFF, the byte at offset+1 wraps inside the
  // segment on real 8086 — match that with a separate linear computation.
  const linearHi = linearAddress(segment, (offset + 1) & 0xFFFF);
  return {
    isMemory: true,
    segment,
    offset,
    read8:  () => cpu.memory.readByte(linear),
    write8: (v) => cpu.memory.writeByte(linear, v & 0xFF),
    read16: () => {
      const lo = cpu.memory.readByte(linear);
      const hi = cpu.memory.readByte(linearHi);
      return ((hi << 8) | lo) & 0xFFFF;
    },
    write16: (v) => {
      cpu.memory.writeByte(linear, v & 0xFF);
      cpu.memory.writeByte(linearHi, (v >>> 8) & 0xFF);
    },
  };
}
