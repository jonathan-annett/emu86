import { flagsAdd16, flagsAdd8, flagsLogic16, flagsLogic8, flagsSub16, flagsSub8, } from './flag-helpers.js';
import { decodeModRM, regOperand, rmOperand } from './modrm.js';
import { OPCODE_TABLE } from './opcodes.js';
import { signedByte } from '../core/types.js';
function add8(cpu, a, b) {
    const r = a + b;
    flagsAdd8(cpu.flags, a, b, r);
    return r & 0xFF;
}
function or8(cpu, a, b) {
    const r = (a | b) & 0xFF;
    flagsLogic8(cpu.flags, r);
    return r;
}
function adc8(cpu, a, b) {
    const cf = cpu.flags.CF ? 1 : 0;
    const r = a + b + cf;
    // The (a ^ b ^ result) AF identity also holds with a 3-input add because
    // the XOR cancels the carry-flag contribution at every bit but bit 0.
    flagsAdd8(cpu.flags, a, b, r);
    return r & 0xFF;
}
function sbb8(cpu, a, b) {
    const cf = cpu.flags.CF ? 1 : 0;
    const r = a - b - cf;
    flagsSub8(cpu.flags, a, b, r);
    return r & 0xFF;
}
function and8(cpu, a, b) {
    const r = (a & b) & 0xFF;
    flagsLogic8(cpu.flags, r);
    return r;
}
function sub8(cpu, a, b) {
    const r = a - b;
    flagsSub8(cpu.flags, a, b, r);
    return r & 0xFF;
}
function xor8(cpu, a, b) {
    const r = (a ^ b) & 0xFF;
    flagsLogic8(cpu.flags, r);
    return r;
}
function cmp8(cpu, a, b) {
    // SUB with the result discarded by the caller (we still return it for
    // a uniform signature; the CMP dispatch path doesn't write it back).
    const r = a - b;
    flagsSub8(cpu.flags, a, b, r);
    return r & 0xFF;
}
function add16(cpu, a, b) {
    const r = a + b;
    flagsAdd16(cpu.flags, a, b, r);
    return r & 0xFFFF;
}
function or16(cpu, a, b) {
    const r = (a | b) & 0xFFFF;
    flagsLogic16(cpu.flags, r);
    return r;
}
function adc16(cpu, a, b) {
    const cf = cpu.flags.CF ? 1 : 0;
    const r = a + b + cf;
    flagsAdd16(cpu.flags, a, b, r);
    return r & 0xFFFF;
}
function sbb16(cpu, a, b) {
    const cf = cpu.flags.CF ? 1 : 0;
    const r = a - b - cf;
    flagsSub16(cpu.flags, a, b, r);
    return r & 0xFFFF;
}
function and16(cpu, a, b) {
    const r = (a & b) & 0xFFFF;
    flagsLogic16(cpu.flags, r);
    return r;
}
function sub16(cpu, a, b) {
    const r = a - b;
    flagsSub16(cpu.flags, a, b, r);
    return r & 0xFFFF;
}
function xor16(cpu, a, b) {
    const r = (a ^ b) & 0xFFFF;
    flagsLogic16(cpu.flags, r);
    return r;
}
function cmp16(cpu, a, b) {
    const r = a - b;
    flagsSub16(cpu.flags, a, b, r);
    return r & 0xFFFF;
}
const ALU8 = [add8, or8, adc8, sbb8, and8, sub8, xor8, cmp8];
const ALU16 = [add16, or16, adc16, sbb16, and16, sub16, xor16, cmp16];
/** Index in the sub-op tables for CMP (no writeback). */
const SUBOP_CMP = 7;
// ============================================================
// Handler factories: r/m vs reg, both directions
// ============================================================
/** OP r/m8, r8  — base + 0  (write result to r/m) */
function makeRM_R_8(sub) {
    const fn = ALU8[sub];
    return (cpu) => {
        const m = decodeModRM(cpu);
        const dst = rmOperand(cpu, m);
        const src = regOperand(cpu, m.reg);
        const r = fn(cpu, dst.read8(), src.read8());
        if (sub !== SUBOP_CMP)
            dst.write8(r);
    };
}
/** OP r/m16, r16  — base + 1 */
function makeRM_R_16(sub) {
    const fn = ALU16[sub];
    return (cpu) => {
        const m = decodeModRM(cpu);
        const dst = rmOperand(cpu, m);
        const src = regOperand(cpu, m.reg);
        const r = fn(cpu, dst.read16(), src.read16());
        if (sub !== SUBOP_CMP)
            dst.write16(r);
    };
}
/** OP r8, r/m8  — base + 2  (write result to reg) */
function makeR_RM_8(sub) {
    const fn = ALU8[sub];
    return (cpu) => {
        const m = decodeModRM(cpu);
        const dst = regOperand(cpu, m.reg);
        const src = rmOperand(cpu, m);
        const r = fn(cpu, dst.read8(), src.read8());
        if (sub !== SUBOP_CMP)
            dst.write8(r);
    };
}
/** OP r16, r/m16  — base + 3 */
function makeR_RM_16(sub) {
    const fn = ALU16[sub];
    return (cpu) => {
        const m = decodeModRM(cpu);
        const dst = regOperand(cpu, m.reg);
        const src = rmOperand(cpu, m);
        const r = fn(cpu, dst.read16(), src.read16());
        if (sub !== SUBOP_CMP)
            dst.write16(r);
    };
}
/** OP AL, imm8  — base + 4 */
function makeAccImm8(sub) {
    const fn = ALU8[sub];
    return (cpu) => {
        const a = cpu.regs.AL;
        const b = cpu.fetchByte();
        const r = fn(cpu, a, b);
        if (sub !== SUBOP_CMP)
            cpu.regs.AL = r;
    };
}
/** OP AX, imm16  — base + 5 */
function makeAccImm16(sub) {
    const fn = ALU16[sub];
    return (cpu) => {
        const a = cpu.regs.AX;
        const b = cpu.fetchWord();
        const r = fn(cpu, a, b);
        if (sub !== SUBOP_CMP)
            cpu.regs.AX = r;
    };
}
// ============================================================
// Register all six encodings for each family
// ============================================================
const FAMILY_BASES = [
    { sub: 0, base: 0x00 }, // ADD
    { sub: 1, base: 0x08 }, // OR
    { sub: 2, base: 0x10 }, // ADC
    { sub: 3, base: 0x18 }, // SBB
    { sub: 4, base: 0x20 }, // AND
    { sub: 5, base: 0x28 }, // SUB
    { sub: 6, base: 0x30 }, // XOR
    { sub: 7, base: 0x38 }, // CMP
];
for (const { sub, base } of FAMILY_BASES) {
    OPCODE_TABLE[base + 0] = makeRM_R_8(sub);
    OPCODE_TABLE[base + 1] = makeRM_R_16(sub);
    OPCODE_TABLE[base + 2] = makeR_RM_8(sub);
    OPCODE_TABLE[base + 3] = makeR_RM_16(sub);
    OPCODE_TABLE[base + 4] = makeAccImm8(sub);
    OPCODE_TABLE[base + 5] = makeAccImm16(sub);
}
// ============================================================
// 0x80 / 0x81 / 0x82 / 0x83 — immediate-to-r/m group
//
// The /reg field of the ModR/M byte selects the ALU sub-op (0..7).
// 0x82 is a documented alias of 0x80 on real 8086 (the sign-extension
// distinction would only matter for word ops, and 0x82 is byte-width).
// 0x83 sign-extends an 8-bit immediate to 16 bits before applying the op.
// ============================================================
OPCODE_TABLE[0x80] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = rmOperand(cpu, m);
    const imm = cpu.fetchByte();
    const sub = m.reg;
    const fn = ALU8[sub];
    const r = fn(cpu, dst.read8(), imm);
    if (sub !== SUBOP_CMP)
        dst.write8(r);
};
OPCODE_TABLE[0x82] = OPCODE_TABLE[0x80]; // alias on 8086
OPCODE_TABLE[0x81] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = rmOperand(cpu, m);
    const imm = cpu.fetchWord();
    const sub = m.reg;
    const fn = ALU16[sub];
    const r = fn(cpu, dst.read16(), imm);
    if (sub !== SUBOP_CMP)
        dst.write16(r);
};
OPCODE_TABLE[0x83] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = rmOperand(cpu, m);
    // signedByte returns a JS-signed number; mask to 16 bits to get the
    // sign-extended unsigned representation the ALU functions expect.
    const imm = signedByte(cpu.fetchByte()) & 0xFFFF;
    const sub = m.reg;
    const fn = ALU16[sub];
    const r = fn(cpu, dst.read16(), imm);
    if (sub !== SUBOP_CMP)
        dst.write16(r);
};
