import { linearAddress } from '../core/types.js';
import { decodeModRM } from './modrm.js';
import { OPCODE_TABLE } from './opcodes.js';
/**
 * Address-loading instructions:
 *
 *   0x8D  LEA r16, m       r16 = effective offset of m  (no memory read)
 *   0xC4  LES r16, m       r16 = [m]; ES = [m+2]
 *   0xC5  LDS r16, m       r16 = [m]; DS = [m+2]
 *
 * All three require a memory operand (mod ≠ 11). With mod=11 the encoding
 * is undefined on real 8086 — we throw to surface bad input.
 *
 * Flags are not affected.
 *
 * LEA reuses the EA computation done by decodeModRM. Since the decoder
 * already resolves segment + offset (and segment override has been honoured),
 * LEA just writes m.offset into the destination — the segment is irrelevant.
 *
 * LDS/LES read a 32-bit far-pointer from memory: low word goes to the GP
 * register, high word goes to the segment register.
 */
OPCODE_TABLE[0x8D] = (cpu) => {
    const m = decodeModRM(cpu);
    if (!m.isMemory)
        throw new Error('LEA with register operand is undefined');
    cpu.regs.setReg16(m.reg, m.offset);
};
OPCODE_TABLE[0xC4] = (cpu) => {
    const m = decodeModRM(cpu);
    if (!m.isMemory)
        throw new Error('LES with register operand is undefined');
    const offLo = cpu.memory.readByte(linearAddress(m.segment, m.offset));
    const offHi = cpu.memory.readByte(linearAddress(m.segment, (m.offset + 1) & 0xFFFF));
    const segLo = cpu.memory.readByte(linearAddress(m.segment, (m.offset + 2) & 0xFFFF));
    const segHi = cpu.memory.readByte(linearAddress(m.segment, (m.offset + 3) & 0xFFFF));
    cpu.regs.setReg16(m.reg, ((offHi << 8) | offLo) & 0xFFFF);
    cpu.regs.ES = ((segHi << 8) | segLo) & 0xFFFF;
};
OPCODE_TABLE[0xC5] = (cpu) => {
    const m = decodeModRM(cpu);
    if (!m.isMemory)
        throw new Error('LDS with register operand is undefined');
    const offLo = cpu.memory.readByte(linearAddress(m.segment, m.offset));
    const offHi = cpu.memory.readByte(linearAddress(m.segment, (m.offset + 1) & 0xFFFF));
    const segLo = cpu.memory.readByte(linearAddress(m.segment, (m.offset + 2) & 0xFFFF));
    const segHi = cpu.memory.readByte(linearAddress(m.segment, (m.offset + 3) & 0xFFFF));
    cpu.regs.setReg16(m.reg, ((offHi << 8) | offLo) & 0xFFFF);
    cpu.regs.DS = ((segHi << 8) | segLo) & 0xFFFF;
};
