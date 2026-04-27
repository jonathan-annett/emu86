import { FLAG } from '../core/flags.js';
import { linearAddress } from '../core/types.js';
import { InvalidOpcodeError } from './errors.js';
import { flagsLogic16, flagsLogic8 } from './flag-helpers.js';
import { decodeModRM, regOperand, rmOperand } from './modrm.js';
import { OPCODE_TABLE } from './opcodes.js';

/**
 * Misc opcodes that don't fit a larger family.
 *
 *   0x86 XCHG r/m8, r8        — swap memory/register byte
 *   0x87 XCHG r/m16, r16
 *
 *   0x98 CBW                  AX = sign_extend(AL)
 *   0x99 CWD                  DX:AX = sign_extend(AX)
 *   0x9B WAIT                 wait for FPU; no-op without one
 *   0x9C PUSHF                push FLAGS
 *   0x9D POPF                 pop FLAGS
 *   0x9E SAHF                 low byte of FLAGS = AH (CF/PF/AF/ZF/SF only)
 *   0x9F LAHF                 AH = low byte of FLAGS
 *
 *   0xD7 XLAT                 AL = [DS:BX + AL]   (DS overridable)
 *
 *   0xF0 LOCK                 prefix; we just consume it and run the next op
 *   0xD8-0xDF ESC             8087 escape; no-op that consumes a ModR/M byte
 */

// ============================================================
// 0x84 / 0x85  TEST r/m, r  — bitwise AND, flags only, no writeback.
// 0xA8 / 0xA9  TEST AL/AX, imm
//
// All forms set flags via flagsLogic{8,16} (CF=OF=0, AF undefined,
// PF/SF/ZF from the AND result).
// ============================================================

OPCODE_TABLE[0x84] = (cpu) => {                    // TEST r/m8, r8
  const m = decodeModRM(cpu);
  const a = rmOperand(cpu, m).read8();
  const b = regOperand(cpu, m.reg).read8();
  flagsLogic8(cpu.flags, a & b);
};

OPCODE_TABLE[0x85] = (cpu) => {                    // TEST r/m16, r16
  const m = decodeModRM(cpu);
  const a = rmOperand(cpu, m).read16();
  const b = regOperand(cpu, m.reg).read16();
  flagsLogic16(cpu.flags, a & b);
};

OPCODE_TABLE[0xA8] = (cpu) => {                    // TEST AL, imm8
  const imm = cpu.fetchByte();
  flagsLogic8(cpu.flags, cpu.regs.AL & imm);
};

OPCODE_TABLE[0xA9] = (cpu) => {                    // TEST AX, imm16
  const imm = cpu.fetchWord();
  flagsLogic16(cpu.flags, cpu.regs.AX & imm);
};

// ============================================================
// 0x86 / 0x87  XCHG r/m, r
// ============================================================

OPCODE_TABLE[0x86] = (cpu) => {
  const m = decodeModRM(cpu);
  const rm = rmOperand(cpu, m);
  const r = regOperand(cpu, m.reg);
  const a = rm.read8();
  const b = r.read8();
  rm.write8(b);
  r.write8(a);
};

OPCODE_TABLE[0x87] = (cpu) => {
  const m = decodeModRM(cpu);
  const rm = rmOperand(cpu, m);
  const r = regOperand(cpu, m.reg);
  const a = rm.read16();
  const b = r.read16();
  rm.write16(b);
  r.write16(a);
};

// ============================================================
// 0x98 CBW / 0x99 CWD
// ============================================================

OPCODE_TABLE[0x98] = (cpu) => {                    // CBW
  cpu.regs.AH = (cpu.regs.AL & 0x80) ? 0xFF : 0x00;
};

OPCODE_TABLE[0x99] = (cpu) => {                    // CWD
  cpu.regs.DX = (cpu.regs.AX & 0x8000) ? 0xFFFF : 0x0000;
};

// ============================================================
// 0x9B WAIT — without an 8087 attached, there's nothing to wait for.
// ============================================================

OPCODE_TABLE[0x9B] = (_cpu) => {
  /* no-op */
};

// ============================================================
// 0x9C PUSHF / 0x9D POPF / 0x9E SAHF / 0x9F LAHF
// ============================================================

OPCODE_TABLE[0x9C] = (cpu) => {                    // PUSHF
  cpu.push(cpu.flags.value);
};

OPCODE_TABLE[0x9D] = (cpu) => {                    // POPF
  cpu.flags.value = cpu.pop();
};

// SAHF/LAHF only touch the low byte; bits 1, 3, 5 are reserved (Intel forces
// 1, 0, 0 respectively). The Flags setter masks reserved bits, so writing the
// raw AH value gives correct semantics for SAHF.
const SAHF_MASK = FLAG.CF | FLAG.PF | FLAG.AF | FLAG.ZF | FLAG.SF;

OPCODE_TABLE[0x9E] = (cpu) => {                    // SAHF
  cpu.flags.value = (cpu.flags.value & ~SAHF_MASK) | (cpu.regs.AH & SAHF_MASK);
};

OPCODE_TABLE[0x9F] = (cpu) => {                    // LAHF
  // Low byte of flags. Reserved bits already enforced by Flags getter.
  cpu.regs.AH = cpu.flags.value & 0xFF;
};

// ============================================================
// 0xD6 SALC — undocumented 8086 instruction. AL = CF ? 0xFF : 0x00.
// Flags: not modified. The mnemonic is "Set AL on Carry"; no Intel docs
// list it, but every 8088/86 silicon variant implements it identically
// and the SST corpus has a SALC opcode file. See also Hennessy &
// Patterson errata, and the AMD K6/K7 manuals which finally documented it.
// ============================================================

OPCODE_TABLE[0xD6] = (cpu) => {
  cpu.regs.AL = cpu.flags.CF ? 0xFF : 0x00;
};

// ============================================================
// 0xD7 XLAT — table lookup (AL = [DS:BX + AL], DS overridable)
// ============================================================

OPCODE_TABLE[0xD7] = (cpu) => {
  const seg = cpu.dataSegment();
  const offset = (cpu.regs.BX + cpu.regs.AL) & 0xFFFF;
  cpu.regs.AL = cpu.memory.readByte(linearAddress(seg, offset));
};

// ============================================================
// 0xF0 LOCK prefix — assert bus lock for the next instruction. We don't
// model the bus, so it's a no-op prefix that simply runs the next opcode.
// ============================================================

OPCODE_TABLE[0xF0] = (cpu) => {
  const next = cpu.fetchByte();
  const handler = OPCODE_TABLE[next];
  if (!handler) {
    const ip = (cpu.regs.IP - 1) & 0xFFFF;
    throw new InvalidOpcodeError(next, cpu.regs.CS, ip);
  }
  handler(cpu);
};

// ============================================================
// 0xD8-0xDF ESC — 8087 floating-point escape. The opcode owns a ModR/M
// byte (and any disp); we decode it to advance IP correctly, then drop
// the operation. With no FPU attached, the result is observable only as
// IP movement.
// ============================================================

for (let i = 0; i < 8; i++) {
  OPCODE_TABLE[0xD8 + i] = (cpu) => { decodeModRM(cpu); };
}
