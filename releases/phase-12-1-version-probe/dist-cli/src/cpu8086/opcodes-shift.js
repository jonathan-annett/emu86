import { FLAG } from '../core/flags.js';
import { flagsLogic16, flagsLogic8 } from './flag-helpers.js';
import { decodeModRM, rmOperand } from './modrm.js';
import { OPCODE_TABLE } from './opcodes.js';
import { PARITY_TABLE } from './parity.js';
/**
 * Shifts and rotates: the 0xD0-0xD3 group.
 *
 *   0xD0  shift/rotate r/m8,  by 1
 *   0xD1  shift/rotate r/m16, by 1
 *   0xD2  shift/rotate r/m8,  by CL
 *   0xD3  shift/rotate r/m16, by CL
 *
 * The ModR/M /reg field picks the operation:
 *   0 ROL    1 ROR    2 RCL    3 RCR
 *   4 SHL    5 SHR    6 (undef; many sources alias to SHL)
 *   7 SAR
 *
 * 8086 quirks vs 80186+:
 *   - The 8086 does NOT mask the shift count. CL=255 means 255 single-bit
 *     iterations. We loop, but bail early when more iterations can't change
 *     anything (e.g. SHL has consumed all bits).
 *   - count=0: NO flags or operand modification. (8086 distinguishes
 *     "shift by zero" from "shift by 1" — the latter does write flags.)
 *
 * Flag rules:
 *   Rotates (ROL/ROR/RCL/RCR)
 *     - CF: bit rotated through. (For RCL/RCR: CF participates.)
 *     - OF: defined ONLY for count=1: MSB-of-result XOR CF (left rotates),
 *           or MSB XOR bit-just-below-MSB (right rotates). For count≠1, OF
 *           is "undefined" — we leave it as whatever the count=1 rule
 *           produced after the last iteration; many emulators do this and
 *           the SST corpus's flagsMask has bits to ignore here when needed.
 *     - PF/ZF/SF/AF: NOT modified by rotates.
 *   Shifts (SHL/SHR/SAR)
 *     - CF: last bit shifted out.
 *     - OF (count=1): SHL → MSB(before) XOR CF; SHR → MSB(before); SAR → 0.
 *     - PF/ZF/SF: set from the result.
 *     - AF: undefined; we leave it alone (cleared by some impls; SST mask
 *       handles it).
 */
// /reg sub-op identifiers.
//
// /reg=6 is the undocumented 8086 SETMO (Set to Minus One): the operand is
// unconditionally written with all-ones (0xFF / 0xFFFF) and flags are set
// like a logical op (SF/ZF/PF from result; CF=OF=0; AF=0). The 0xD2/0xD3
// variants additionally early-out when CL=0 (no operand or flag changes),
// matching the count=0 rule of the rest of this group. SST corpus case
// names: "setmo dh", "setmo dx", "setmo byte [...]".
const ROL = 0, ROR = 1, RCL = 2, RCR = 3, SHL = 4, SHR = 5, SETMO = 6, SAR = 7;
OPCODE_TABLE[0xD0] = (cpu) => {
    const m = decodeModRM(cpu);
    apply8(cpu, rmOperand(cpu, m), m.reg, 1);
};
OPCODE_TABLE[0xD1] = (cpu) => {
    const m = decodeModRM(cpu);
    apply16(cpu, rmOperand(cpu, m), m.reg, 1);
};
OPCODE_TABLE[0xD2] = (cpu) => {
    const m = decodeModRM(cpu);
    apply8(cpu, rmOperand(cpu, m), m.reg, cpu.regs.CL);
};
OPCODE_TABLE[0xD3] = (cpu) => {
    const m = decodeModRM(cpu);
    apply16(cpu, rmOperand(cpu, m), m.reg, cpu.regs.CL);
};
// ============================================================
// 8-bit dispatch
// ============================================================
function apply8(cpu, op, sub, count) {
    if (count === 0)
        return; // 8086: no flag updates either
    if (sub === SETMO) {
        op.write8(0xFF);
        flagsLogic8(cpu.flags, 0xFF);
        return;
    }
    let v = op.read8();
    let cf = (cpu.flags.value & FLAG.CF) !== 0;
    let of = (cpu.flags.value & FLAG.OF) !== 0;
    switch (sub) {
        case ROL:
            ({ v, cf, of } = rol8(v, count));
            break;
        case ROR:
            ({ v, cf, of } = ror8(v, count));
            break;
        case RCL:
            ({ v, cf, of } = rcl8(v, count, cf));
            break;
        case RCR:
            ({ v, cf, of } = rcr8(v, count, cf));
            break;
        case SHL:
            ({ v, cf, of } = shl8(v, count));
            break;
        case SHR:
            ({ v, cf, of } = shr8(v, count));
            break;
        case SAR:
            ({ v, cf, of } = sar8(v, count));
            break;
        default: return;
    }
    op.write8(v);
    writeFlags8(cpu.flags, sub, v, cf, of);
}
function apply16(cpu, op, sub, count) {
    if (count === 0)
        return;
    if (sub === SETMO) {
        op.write16(0xFFFF);
        flagsLogic16(cpu.flags, 0xFFFF);
        return;
    }
    let v = op.read16();
    let cf = (cpu.flags.value & FLAG.CF) !== 0;
    let of = (cpu.flags.value & FLAG.OF) !== 0;
    switch (sub) {
        case ROL:
            ({ v, cf, of } = rol16(v, count));
            break;
        case ROR:
            ({ v, cf, of } = ror16(v, count));
            break;
        case RCL:
            ({ v, cf, of } = rcl16(v, count, cf));
            break;
        case RCR:
            ({ v, cf, of } = rcr16(v, count, cf));
            break;
        case SHL:
            ({ v, cf, of } = shl16(v, count));
            break;
        case SHR:
            ({ v, cf, of } = shr16(v, count));
            break;
        case SAR:
            ({ v, cf, of } = sar16(v, count));
            break;
        default: return;
    }
    op.write16(v);
    writeFlags16(cpu.flags, sub, v, cf, of);
}
function rol8(v, n) {
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x80) !== 0;
        v = ((v << 1) | (cf ? 1 : 0)) & 0xFF;
    }
    // OF (count=1 rule): MSB ^ CF, where CF is the bit just rotated out (== new LSB).
    const of = ((v & 0x80) !== 0) !== cf;
    return { v, cf, of };
}
function ror8(v, n) {
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x01) !== 0;
        v = ((v >>> 1) | (cf ? 0x80 : 0)) & 0xFF;
    }
    // OF (count=1 rule): MSB ^ bit-below-MSB
    const of = ((v & 0x80) !== 0) !== ((v & 0x40) !== 0);
    return { v, cf, of };
}
function rcl8(v, n, cf) {
    for (let i = 0; i < n; i++) {
        const newCF = (v & 0x80) !== 0;
        v = ((v << 1) | (cf ? 1 : 0)) & 0xFF;
        cf = newCF;
    }
    const of = ((v & 0x80) !== 0) !== cf;
    return { v, cf, of };
}
function rcr8(v, n, cf) {
    for (let i = 0; i < n; i++) {
        const newCF = (v & 0x01) !== 0;
        v = ((v >>> 1) | (cf ? 0x80 : 0)) & 0xFF;
        cf = newCF;
    }
    const of = ((v & 0x80) !== 0) !== ((v & 0x40) !== 0);
    return { v, cf, of };
}
function shl8(v, n) {
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x80) !== 0;
        v = (v << 1) & 0xFF;
        if (v === 0 && !cf && i + 1 < n) {
            // Remaining iterations all shift in zeros — CF stays 0, value stays 0.
            cf = false;
            break;
        }
    }
    // OF: MSB(result) XOR CF — Intel rule for left shifts (defined for count=1
    // only; we leave it computed for higher counts since SST mask handles it).
    const of = ((v & 0x80) !== 0) !== cf;
    return { v, cf, of };
}
function shr8(v, n) {
    const before = v;
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x01) !== 0;
        v = v >>> 1;
        if (v === 0 && !cf && i + 1 < n) {
            cf = false;
            break;
        }
    }
    // OF (count=1 rule): MSB of the original operand (for SHR, OF = the bit
    // that would have been "lost" — since logical shift always introduces a
    // 0 at the top, OF tracks whether a 1 used to be there).
    const of = (before & 0x80) !== 0;
    return { v, cf, of };
}
function sar8(v, n) {
    // Sign-extend through the rotate: keep MSB stable.
    const sign = v & 0x80;
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x01) !== 0;
        v = ((v >>> 1) | sign) & 0xFF;
    }
    return { v, cf, of: false };
}
// ============================================================
// 16-bit primitives
// ============================================================
function rol16(v, n) {
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x8000) !== 0;
        v = ((v << 1) | (cf ? 1 : 0)) & 0xFFFF;
    }
    const of = ((v & 0x8000) !== 0) !== cf;
    return { v, cf, of };
}
function ror16(v, n) {
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x0001) !== 0;
        v = ((v >>> 1) | (cf ? 0x8000 : 0)) & 0xFFFF;
    }
    const of = ((v & 0x8000) !== 0) !== ((v & 0x4000) !== 0);
    return { v, cf, of };
}
function rcl16(v, n, cf) {
    for (let i = 0; i < n; i++) {
        const newCF = (v & 0x8000) !== 0;
        v = ((v << 1) | (cf ? 1 : 0)) & 0xFFFF;
        cf = newCF;
    }
    const of = ((v & 0x8000) !== 0) !== cf;
    return { v, cf, of };
}
function rcr16(v, n, cf) {
    for (let i = 0; i < n; i++) {
        const newCF = (v & 0x0001) !== 0;
        v = ((v >>> 1) | (cf ? 0x8000 : 0)) & 0xFFFF;
        cf = newCF;
    }
    const of = ((v & 0x8000) !== 0) !== ((v & 0x4000) !== 0);
    return { v, cf, of };
}
function shl16(v, n) {
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x8000) !== 0;
        v = (v << 1) & 0xFFFF;
        if (v === 0 && !cf && i + 1 < n) {
            cf = false;
            break;
        }
    }
    const of = ((v & 0x8000) !== 0) !== cf;
    return { v, cf, of };
}
function shr16(v, n) {
    const before = v;
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x0001) !== 0;
        v = v >>> 1;
        if (v === 0 && !cf && i + 1 < n) {
            cf = false;
            break;
        }
    }
    const of = (before & 0x8000) !== 0;
    return { v, cf, of };
}
function sar16(v, n) {
    const sign = v & 0x8000;
    let cf = false;
    for (let i = 0; i < n; i++) {
        cf = (v & 0x0001) !== 0;
        v = ((v >>> 1) | sign) & 0xFFFF;
    }
    return { v, cf, of: false };
}
// ============================================================
// Flag write-back: rotates only touch CF/OF; shifts also do PF/SF/ZF.
// ============================================================
function writeFlags8(flags, sub, v, cf, of) {
    let f = flags.value;
    f = cf ? (f | FLAG.CF) : (f & ~FLAG.CF);
    f = of ? (f | FLAG.OF) : (f & ~FLAG.OF);
    if (sub >= SHL) {
        // Shifts: also update PF/SF/ZF
        f = PARITY_TABLE[v & 0xFF] ? (f | FLAG.PF) : (f & ~FLAG.PF);
        f = (v & 0xFF) === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
        f = (v & 0x80) ? (f | FLAG.SF) : (f & ~FLAG.SF);
    }
    flags.value = f;
}
function writeFlags16(flags, sub, v, cf, of) {
    let f = flags.value;
    f = cf ? (f | FLAG.CF) : (f & ~FLAG.CF);
    f = of ? (f | FLAG.OF) : (f & ~FLAG.OF);
    if (sub >= SHL) {
        f = PARITY_TABLE[v & 0xFF] ? (f | FLAG.PF) : (f & ~FLAG.PF);
        f = (v & 0xFFFF) === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
        f = (v & 0x8000) ? (f | FLAG.SF) : (f & ~FLAG.SF);
    }
    flags.value = f;
}
