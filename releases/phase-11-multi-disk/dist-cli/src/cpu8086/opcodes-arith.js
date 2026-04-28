import { FLAG } from '../core/flags.js';
import { signedByte, signedWord } from '../core/types.js';
import { flagsDec8, flagsInc8, flagsLogic16, flagsLogic8, flagsSub16, flagsSub8 } from './flag-helpers.js';
import { decodeModRM, rmOperand } from './modrm.js';
import { OPCODE_TABLE } from './opcodes.js';
import { serviceInterrupt } from './opcodes-int.js';
/**
 * The 0xF6 / 0xF7 multi-op groups, plus 0xFE (INC/DEC r/m8).
 *
 *   0xF6  r/m8 group     0xF7  r/m16 group
 *     /0  TEST r/m, imm                         (read+AND, no writeback)
 *     /1  alias of /0 on 8086 silicon (SST corpus confirms; not in Intel SDM)
 *     /2  NOT  r/m                              (~x; no flag changes)
 *     /3  NEG  r/m                              (0 - x; flags like SUB; CF=(x≠0))
 *     /4  MUL  r/m                              unsigned widening
 *     /5  IMUL r/m                              signed widening
 *     /6  DIV  r/m                              unsigned; INT 0 on overflow/0
 *     /7  IDIV r/m                              signed
 *
 *   0xFE  r/m8 group
 *     /0  INC r/m8        /1  DEC r/m8
 *     /others undefined on 8086 — we throw.
 *
 * MUL/IMUL flag rule (per Intel):
 *   MUL:  CF=OF=1 iff the high half of the product is nonzero. PF/SF/ZF/AF
 *         are "undefined" — we leave them alone.
 *   IMUL: CF=OF=1 iff the high half is NOT just sign-extension of the low
 *         half (i.e., the product doesn't fit in the source width).
 *
 * Division: real 8086 raises a #DE (divide error) interrupt 0 on:
 *   - divisor == 0, or
 *   - quotient won't fit in the destination half.
 * We invoke `serviceInterrupt(cpu, 0)` directly, which mirrors hardware:
 * flags+CS+IP get pushed and CS:IP loads from the IVT entry at 0:0.
 * Tests that observe a divide error should set up a vector and check the
 * post-INT state (CS:IP jumped, SP decreased) rather than catching.
 */
// ============================================================
// 0xF6  r/m8 group
// ============================================================
OPCODE_TABLE[0xF6] = (cpu) => {
    const m = decodeModRM(cpu);
    const op = rmOperand(cpu, m);
    switch (m.reg) {
        case 0:
        case 1: { // TEST r/m8, imm8 (/1 aliases /0)
            const imm = cpu.fetchByte();
            flagsLogic8(cpu.flags, op.read8() & imm);
            return;
        }
        case 2: // NOT r/m8 (no flag changes)
            op.write8(~op.read8() & 0xFF);
            return;
        case 3: { // NEG r/m8
            const x = op.read8();
            const r = (-x) & 0xFF;
            // NEG x is SUB(0, x) — same flags.
            flagsSub8(cpu.flags, 0, x, -x);
            // Intel: CF = (operand ≠ 0). The flagsSub8 bit-8 trick lands on the
            // same answer (0 - 0 has no borrow; 0 - n for n>0 borrows), so we get
            // the right CF for free. No fix-up needed.
            op.write8(r);
            return;
        }
        case 4:
            mul8(cpu, op.read8());
            return; // MUL r/m8
        case 5:
            imul8(cpu, op.read8());
            return; // IMUL r/m8
        case 6:
            div8(cpu, op.read8());
            return; // DIV r/m8
        case 7:
            idiv8(cpu, op.read8());
            return; // IDIV r/m8
    }
};
// ============================================================
// Type aliases for the per-op helper signatures. Using `CPU8086` directly
// keeps these honest now that DIV/IDIV need the full CPU to deliver INT 0.
// ============================================================
// ============================================================
// 0xF7  r/m16 group
// ============================================================
OPCODE_TABLE[0xF7] = (cpu) => {
    const m = decodeModRM(cpu);
    const op = rmOperand(cpu, m);
    switch (m.reg) {
        case 0:
        case 1: { // TEST r/m16, imm16 (/1 aliases /0)
            const imm = cpu.fetchWord();
            flagsLogic16(cpu.flags, op.read16() & imm);
            return;
        }
        case 2: // NOT r/m16
            op.write16(~op.read16() & 0xFFFF);
            return;
        case 3: { // NEG r/m16
            const x = op.read16();
            const r = (-x) & 0xFFFF;
            flagsSub16(cpu.flags, 0, x, -x);
            op.write16(r);
            return;
        }
        case 4:
            mul16(cpu, op.read16());
            return;
        case 5:
            imul16(cpu, op.read16());
            return;
        case 6:
            div16(cpu, op.read16());
            return;
        case 7:
            idiv16(cpu, op.read16());
            return;
    }
};
// ============================================================
// 0xFE  r/m8 group: INC / DEC r/m8
// ============================================================
OPCODE_TABLE[0xFE] = (cpu) => {
    const m = decodeModRM(cpu);
    const op = rmOperand(cpu, m);
    switch (m.reg) {
        case 0: { // INC r/m8
            const before = op.read8();
            const result = (before + 1) & 0xFF;
            flagsInc8(cpu.flags, before, result);
            op.write8(result);
            return;
        }
        case 1: { // DEC r/m8
            const before = op.read8();
            const result = (before - 1) & 0xFF;
            flagsDec8(cpu.flags, before, result);
            op.write8(result);
            return;
        }
        default: throw new Error(`0xFE /${m.reg} is undefined on 8086`);
    }
};
// ============================================================
// MUL / IMUL helpers
// ============================================================
function mul8(cpu, x) {
    const product = cpu.regs.AL * x;
    cpu.regs.AX = product & 0xFFFF;
    const upperNonZero = (product & 0xFF00) !== 0;
    let f = cpu.flags.value;
    f = upperNonZero ? (f | FLAG.CF | FLAG.OF) : (f & ~(FLAG.CF | FLAG.OF));
    cpu.flags.value = f;
}
function mul16(cpu, x) {
    // 16x16 = 32 bits; JS Number handles this without precision loss.
    const product = cpu.regs.AX * x;
    cpu.regs.AX = product & 0xFFFF;
    cpu.regs.DX = (product / 0x10000) & 0xFFFF;
    const upperNonZero = cpu.regs.DX !== 0;
    let f = cpu.flags.value;
    f = upperNonZero ? (f | FLAG.CF | FLAG.OF) : (f & ~(FLAG.CF | FLAG.OF));
    cpu.flags.value = f;
}
function imul8(cpu, x) {
    const sa = signedByte(cpu.regs.AL);
    const sb = signedByte(x);
    const product = sa * sb;
    cpu.regs.AX = product & 0xFFFF;
    // CF=OF=1 iff product can't be represented as a sign-extended 8-bit value.
    const fits = product >= -0x80 && product <= 0x7F;
    let f = cpu.flags.value;
    f = fits ? (f & ~(FLAG.CF | FLAG.OF)) : (f | FLAG.CF | FLAG.OF);
    cpu.flags.value = f;
}
function imul16(cpu, x) {
    const sa = signedWord(cpu.regs.AX);
    const sb = signedWord(x);
    const product = sa * sb;
    // For 16x16=32-bit signed product, store low 16 in AX, high 16 in DX.
    // Use Math.floor for the divide so negative products get the correct
    // two's-complement upper half (Math.trunc rounds toward zero, which
    // would land on 0 for any product in (-0x10000, 0) — wrong sign-extend).
    const lo = ((product % 0x10000) + 0x10000) % 0x10000;
    const hi = Math.floor(product / 0x10000) & 0xFFFF;
    cpu.regs.AX = lo;
    cpu.regs.DX = hi;
    const fits = product >= -0x8000 && product <= 0x7FFF;
    let f = cpu.flags.value;
    f = fits ? (f & ~(FLAG.CF | FLAG.OF)) : (f | FLAG.CF | FLAG.OF);
    cpu.flags.value = f;
}
// ============================================================
// DIV / IDIV helpers — flags are all "undefined" per Intel; we leave them.
// ============================================================
function div8(cpu, divisor) {
    if (divisor === 0) {
        serviceInterrupt(cpu, 0);
        return;
    }
    const dividend = cpu.regs.AX;
    const q = Math.trunc(dividend / divisor);
    const r = dividend - q * divisor;
    if (q > 0xFF) {
        serviceInterrupt(cpu, 0);
        return;
    }
    cpu.regs.AL = q & 0xFF;
    cpu.regs.AH = r & 0xFF;
}
function div16(cpu, divisor) {
    if (divisor === 0) {
        serviceInterrupt(cpu, 0);
        return;
    }
    // 32-bit dividend = DX:AX, fits in JS Number safely (max 2^32 - 1).
    const dividend = cpu.regs.DX * 0x10000 + cpu.regs.AX;
    const q = Math.trunc(dividend / divisor);
    const r = dividend - q * divisor;
    if (q > 0xFFFF) {
        serviceInterrupt(cpu, 0);
        return;
    }
    cpu.regs.AX = q & 0xFFFF;
    cpu.regs.DX = r & 0xFFFF;
}
function idiv8(cpu, divisor) {
    if (divisor === 0) {
        serviceInterrupt(cpu, 0);
        return;
    }
    const sd = signedByte(divisor);
    const dividend = signedWord(cpu.regs.AX);
    // 8086: quotient truncated toward zero, remainder takes sign of dividend.
    // JS Math.trunc + the standard `dividend - q*divisor` identity matches.
    let q = Math.trunc(dividend / sd);
    let r = dividend - q * sd;
    // 8086 silicon quirk: REP/REPNZ prefix on IDIV negates the quotient
    // (the chip's microcode performs |dividend|/|divisor| then signs the
    // result, and REP flips the sign-application). Verified against SST
    // corpus — every REP-prefixed IDIV case has the quotient inverted.
    // Remainder is unchanged.
    if (cpu.repPrefix !== null)
        q = -q;
    // Real 8086 overflow check is |q| > 0x7F (not q outside [-0x80..0x7F]).
    // The microcode computes |q| via DIV-style logic and traps when the
    // magnitude won't fit in 7 bits — so q=-128 also overflows even though
    // it would fit in a signed byte. SST corpus confirms.
    if (q < -0x7F || q > 0x7F) {
        serviceInterrupt(cpu, 0);
        return;
    }
    cpu.regs.AL = q & 0xFF;
    cpu.regs.AH = r & 0xFF;
}
function idiv16(cpu, divisor) {
    if (divisor === 0) {
        serviceInterrupt(cpu, 0);
        return;
    }
    const sd = signedWord(divisor);
    // Sign-extend DX:AX to 32 bits as a signed value. JS bit ops auto-sign,
    // but we have to combine the halves manually since they exceed 32 bits
    // when treated unsigned. Use sign of DX for the high half.
    const hi = signedWord(cpu.regs.DX);
    const dividend = hi * 0x10000 + cpu.regs.AX;
    let q = Math.trunc(dividend / sd);
    let r = dividend - q * sd;
    if (cpu.repPrefix !== null)
        q = -q;
    if (q < -0x7FFF || q > 0x7FFF) {
        serviceInterrupt(cpu, 0);
        return;
    }
    cpu.regs.AX = q & 0xFFFF;
    cpu.regs.DX = r & 0xFFFF;
}
