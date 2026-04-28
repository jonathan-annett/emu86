import { linearAddress, signedByte } from '../core/types.js';
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
export function decodeModRM(cpu) {
    const b = cpu.fetchByte();
    const mod = (b >>> 6) & 0x3;
    const reg = (b >>> 3) & 0x7;
    const rm = b & 0x7;
    if (mod === 0b11) {
        return { mod, reg, rm, isMemory: false, segment: 0, offset: 0 };
    }
    // Memory mode — compute the 16-bit effective offset and pick the segment.
    let offset;
    let usesBP; // determines default segment (BP → SS, else DS)
    if (mod === 0b00 && rm === 0b110) {
        // Special case: direct address [disp16], default DS (NOT BP-based).
        offset = cpu.fetchWord();
        usesBP = false;
    }
    else {
        const r = cpu.regs;
        switch (rm) {
            case 0b000:
                offset = (r.BX + r.SI) & 0xFFFF;
                usesBP = false;
                break;
            case 0b001:
                offset = (r.BX + r.DI) & 0xFFFF;
                usesBP = false;
                break;
            case 0b010:
                offset = (r.BP + r.SI) & 0xFFFF;
                usesBP = true;
                break;
            case 0b011:
                offset = (r.BP + r.DI) & 0xFFFF;
                usesBP = true;
                break;
            case 0b100:
                offset = r.SI & 0xFFFF;
                usesBP = false;
                break;
            case 0b101:
                offset = r.DI & 0xFFFF;
                usesBP = false;
                break;
            case 0b110:
                offset = r.BP & 0xFFFF;
                usesBP = true;
                break;
            default:
                offset = (r.BX) & 0xFFFF;
                usesBP = false;
                break; // 0b111
        }
        if (mod === 0b01) {
            offset = (offset + signedByte(cpu.fetchByte())) & 0xFFFF;
        }
        else if (mod === 0b10) {
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
export function rmOperand(cpu, m) {
    if (m.isMemory)
        return memoryOperand(cpu, m.segment, m.offset);
    return registerOperand(cpu, m.rm);
}
/** Operand for the /reg field — always a register. */
export function regOperand(cpu, reg) {
    return registerOperand(cpu, reg);
}
// ----- Internal operand implementations -----
function registerOperand(cpu, idx) {
    return {
        isMemory: false,
        segment: 0,
        offset: 0,
        read8: () => cpu.regs.getReg8(idx),
        write8: (v) => cpu.regs.setReg8(idx, v & 0xFF),
        read16: () => cpu.regs.getReg16(idx),
        write16: (v) => cpu.regs.setReg16(idx, v & 0xFFFF),
    };
}
function memoryOperand(cpu, segment, offset) {
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
        read8: () => cpu.memory.readByte(linear),
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
