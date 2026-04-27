import { FLAG } from '../core/flags.js';
import { flagsDec16, flagsInc16 } from './flag-helpers.js';
import { OPCODE_TABLE } from './opcodes.js';
/**
 * Flag manipulation, single-byte INC/DEC reg16, XCHG-with-AX, and other
 * "no decoding required" opcodes that don't fit a larger family.
 *
 *   0xF5 CMC      CF ^= 1
 *   0xF8 CLC      CF = 0
 *   0xF9 STC      CF = 1
 *   0xFA CLI      IF = 0
 *   0xFB STI      IF = 1
 *   0xFC CLD      DF = 0
 *   0xFD STD      DF = 1
 *
 *   0x40–0x47 INC r16 (AX/CX/DX/BX/SP/BP/SI/DI)
 *   0x48–0x4F DEC r16
 *
 *   0x90 NOP   (already in opcodes.ts as XCHG AX,AX with no observable effect)
 *   0x91–0x97 XCHG AX, r16
 */
// ============================================================
// Flag ops — direct bit twiddling against cpu.flags.value to skip the
// individual setter overhead. Reserved bits stay correct because the
// setter masks on assignment.
// ============================================================
OPCODE_TABLE[0xF5] = (cpu) => { cpu.flags.value = cpu.flags.value ^ FLAG.CF; };
OPCODE_TABLE[0xF8] = (cpu) => { cpu.flags.value = cpu.flags.value & ~FLAG.CF; };
OPCODE_TABLE[0xF9] = (cpu) => { cpu.flags.value = cpu.flags.value | FLAG.CF; };
OPCODE_TABLE[0xFA] = (cpu) => { cpu.flags.value = cpu.flags.value & ~FLAG.IF; };
// STI: set IF=1 AND arm the one-instruction inhibit window. The next
// `step()` will see IF=1 but interruptInhibit=true and skip maskable
// service for that one boundary; the canonical effect is that
// `STI; RET` doesn't take an interrupt between the two instructions —
// the RET completes first. (Real 8086 silicon does this.)
OPCODE_TABLE[0xFB] = (cpu) => {
    cpu.flags.value = cpu.flags.value | FLAG.IF;
    cpu.interruptInhibit = true;
};
OPCODE_TABLE[0xFC] = (cpu) => { cpu.flags.value = cpu.flags.value & ~FLAG.DF; };
OPCODE_TABLE[0xFD] = (cpu) => { cpu.flags.value = cpu.flags.value | FLAG.DF; };
// ============================================================
// 0x40–0x47  INC r16    |    0x48–0x4F  DEC r16
//   reg encoded in low 3 bits. INC/DEC do NOT touch CF — the flag-helpers
//   handle that.
// ============================================================
for (let reg = 0; reg < 8; reg++) {
    const r = reg;
    OPCODE_TABLE[0x40 + r] = (cpu) => {
        const before = cpu.regs.getReg16(r);
        const result = (before + 1) & 0xFFFF;
        flagsInc16(cpu.flags, before, result);
        cpu.regs.setReg16(r, result);
    };
    OPCODE_TABLE[0x48 + r] = (cpu) => {
        const before = cpu.regs.getReg16(r);
        const result = (before - 1) & 0xFFFF;
        flagsDec16(cpu.flags, before, result);
        cpu.regs.setReg16(r, result);
    };
}
// ============================================================
// 0x91–0x97  XCHG AX, r16
//   0x90 is XCHG AX,AX which is a no-op; opcodes.ts handles it as NOP.
// ============================================================
for (let reg = 1; reg < 8; reg++) {
    const r = reg;
    OPCODE_TABLE[0x90 + r] = (cpu) => {
        const tmp = cpu.regs.AX;
        cpu.regs.AX = cpu.regs.getReg16(r);
        cpu.regs.setReg16(r, tmp);
    };
}
