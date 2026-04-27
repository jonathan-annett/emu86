import { linearAddress } from '../core/types.js';
import { InvalidOpcodeError } from './errors.js';
import { flagsSub16, flagsSub8 } from './flag-helpers.js';
import { OPCODE_TABLE } from './opcodes.js';
/**
 * String operations and the REP prefixes.
 *
 * Per-iteration semantics (no implicit CX involvement):
 *   0xA4 MOVSB     [ES:DI] = [seg(SI)]            ; SI±=1; DI±=1
 *   0xA5 MOVSW     word                           ; SI±=2; DI±=2
 *   0xA6 CMPSB     CMP [seg(SI)], [ES:DI]         ; SI±=1; DI±=1   (sets flags)
 *   0xA7 CMPSW     word
 *   0xAA STOSB     [ES:DI] = AL                   ; DI±=1
 *   0xAB STOSW     [ES:DI] = AX                   ; DI±=2
 *   0xAC LODSB     AL = [seg(SI)]                 ; SI±=1
 *   0xAD LODSW     AX                             ; SI±=2
 *   0xAE SCASB     CMP AL, [ES:DI]                ; DI±=1   (sets flags)
 *   0xAF SCASW     CMP AX, [ES:DI]                ; DI±=2
 *
 * Direction: DF=0 → increment, DF=1 → decrement.
 *
 * Segment routing:
 *   - Source side of MOVS/CMPS/LODS uses cpu.dataSegment() — defaults to DS,
 *     honours segment-override prefix.
 *   - Destination side (MOVS/STOS) and the [DI] operand of CMPS/SCAS always
 *     use ES. Override prefixes have NO effect there.
 *
 * REP prefixes:
 *   0xF2 REPNE/REPNZ
 *   0xF3 REP/REPE/REPZ
 *
 *   Loop the next instruction up to CX times, decrementing CX each iteration.
 *   With CMPS/SCAS the loop additionally exits when ZF disagrees with the
 *   prefix flavour:
 *      REP/REPE/REPZ  : continue while ZF=1
 *      REPNE/REPNZ    : continue while ZF=0
 *   With MOVS/STOS/LODS the ZF check is skipped (those ops don't touch ZF).
 *
 * Real 8086 makes REP interruptible, leaving CS:IP pointing back at the
 * prefix on resume. We're synchronous and have no async interrupt source,
 * so the loop runs to completion within a single step().
 */
// Per-opcode "this op updates ZF, so REP should treat it as conditional"
// table. CMPS and SCAS only.
const STRING_CHECKS_ZF = new Uint8Array(256);
STRING_CHECKS_ZF[0xA6] = 1; // CMPSB
STRING_CHECKS_ZF[0xA7] = 1; // CMPSW
STRING_CHECKS_ZF[0xAE] = 1; // SCASB
STRING_CHECKS_ZF[0xAF] = 1; // SCASW
// Set of opcodes that participate in REP loops (loop CX times, decrement,
// optional ZF break). All others, when REP-prefixed, run exactly once with
// cpu.repPrefix set so the handler can react to the prefix if it wants
// (currently only IDIV does, for the quotient-negate quirk). Real silicon
// does not loop non-string ops under REP — looping IDIV would corrupt CX
// and execute thousands of divisions per step().
const IS_STRING_OP = new Uint8Array(256);
IS_STRING_OP[0xA4] = 1; // MOVSB
IS_STRING_OP[0xA5] = 1; // MOVSW
IS_STRING_OP[0xA6] = 1; // CMPSB
IS_STRING_OP[0xA7] = 1; // CMPSW
IS_STRING_OP[0xAA] = 1; // STOSB
IS_STRING_OP[0xAB] = 1; // STOSW
IS_STRING_OP[0xAC] = 1; // LODSB
IS_STRING_OP[0xAD] = 1; // LODSW
IS_STRING_OP[0xAE] = 1; // SCASB
IS_STRING_OP[0xAF] = 1; // SCASW
// ============================================================
// One-iteration string handlers
// ============================================================
OPCODE_TABLE[0xA4] = (cpu) => {
    const srcSeg = cpu.dataSegment();
    const v = cpu.memory.readByte(linearAddress(srcSeg, cpu.regs.SI));
    cpu.memory.writeByte(linearAddress(cpu.regs.ES, cpu.regs.DI), v);
    const d = cpu.flags.DF ? -1 : 1;
    cpu.regs.SI = (cpu.regs.SI + d) & 0xFFFF;
    cpu.regs.DI = (cpu.regs.DI + d) & 0xFFFF;
};
OPCODE_TABLE[0xA5] = (cpu) => {
    const srcSeg = cpu.dataSegment();
    const lo = cpu.memory.readByte(linearAddress(srcSeg, cpu.regs.SI));
    const hi = cpu.memory.readByte(linearAddress(srcSeg, (cpu.regs.SI + 1) & 0xFFFF));
    const v = ((hi << 8) | lo) & 0xFFFF;
    cpu.memory.writeByte(linearAddress(cpu.regs.ES, cpu.regs.DI), v & 0xFF);
    cpu.memory.writeByte(linearAddress(cpu.regs.ES, (cpu.regs.DI + 1) & 0xFFFF), (v >>> 8) & 0xFF);
    const d = cpu.flags.DF ? -2 : 2;
    cpu.regs.SI = (cpu.regs.SI + d) & 0xFFFF;
    cpu.regs.DI = (cpu.regs.DI + d) & 0xFFFF;
};
OPCODE_TABLE[0xA6] = (cpu) => {
    const srcSeg = cpu.dataSegment();
    const a = cpu.memory.readByte(linearAddress(srcSeg, cpu.regs.SI));
    const b = cpu.memory.readByte(linearAddress(cpu.regs.ES, cpu.regs.DI));
    flagsSub8(cpu.flags, a, b, a - b);
    const d = cpu.flags.DF ? -1 : 1;
    cpu.regs.SI = (cpu.regs.SI + d) & 0xFFFF;
    cpu.regs.DI = (cpu.regs.DI + d) & 0xFFFF;
};
OPCODE_TABLE[0xA7] = (cpu) => {
    const srcSeg = cpu.dataSegment();
    const a = readWord(cpu, srcSeg, cpu.regs.SI);
    const b = readWord(cpu, cpu.regs.ES, cpu.regs.DI);
    flagsSub16(cpu.flags, a, b, a - b);
    const d = cpu.flags.DF ? -2 : 2;
    cpu.regs.SI = (cpu.regs.SI + d) & 0xFFFF;
    cpu.regs.DI = (cpu.regs.DI + d) & 0xFFFF;
};
OPCODE_TABLE[0xAA] = (cpu) => {
    cpu.memory.writeByte(linearAddress(cpu.regs.ES, cpu.regs.DI), cpu.regs.AL);
    cpu.regs.DI = (cpu.regs.DI + (cpu.flags.DF ? -1 : 1)) & 0xFFFF;
};
OPCODE_TABLE[0xAB] = (cpu) => {
    const v = cpu.regs.AX;
    cpu.memory.writeByte(linearAddress(cpu.regs.ES, cpu.regs.DI), v & 0xFF);
    cpu.memory.writeByte(linearAddress(cpu.regs.ES, (cpu.regs.DI + 1) & 0xFFFF), (v >>> 8) & 0xFF);
    cpu.regs.DI = (cpu.regs.DI + (cpu.flags.DF ? -2 : 2)) & 0xFFFF;
};
OPCODE_TABLE[0xAC] = (cpu) => {
    const srcSeg = cpu.dataSegment();
    cpu.regs.AL = cpu.memory.readByte(linearAddress(srcSeg, cpu.regs.SI));
    cpu.regs.SI = (cpu.regs.SI + (cpu.flags.DF ? -1 : 1)) & 0xFFFF;
};
OPCODE_TABLE[0xAD] = (cpu) => {
    const srcSeg = cpu.dataSegment();
    cpu.regs.AX = readWord(cpu, srcSeg, cpu.regs.SI);
    cpu.regs.SI = (cpu.regs.SI + (cpu.flags.DF ? -2 : 2)) & 0xFFFF;
};
OPCODE_TABLE[0xAE] = (cpu) => {
    const a = cpu.regs.AL;
    const b = cpu.memory.readByte(linearAddress(cpu.regs.ES, cpu.regs.DI));
    flagsSub8(cpu.flags, a, b, a - b);
    cpu.regs.DI = (cpu.regs.DI + (cpu.flags.DF ? -1 : 1)) & 0xFFFF;
};
OPCODE_TABLE[0xAF] = (cpu) => {
    const a = cpu.regs.AX;
    const b = readWord(cpu, cpu.regs.ES, cpu.regs.DI);
    flagsSub16(cpu.flags, a, b, a - b);
    cpu.regs.DI = (cpu.regs.DI + (cpu.flags.DF ? -2 : 2)) & 0xFFFF;
};
// ============================================================
// REP prefixes
// ============================================================
/**
 * Common loop body used by both REP and REPNE.
 *
 * `zfBreaksOn` is the ZF state that should TERMINATE the loop when the
 * inner op updates ZF. For REP/REPE this is `false` (we continue while
 * ZF=1, exit when ZF=0). For REPNE this is `true` (continue while ZF=0,
 * exit when ZF=1).
 *
 * For non-CMPS/SCAS string ops (`STRING_CHECKS_ZF` is 0), the ZF check is
 * skipped — those ops don't touch ZF and the loop just runs CX times.
 */
function repLoop(cpu, zfBreaksOn, prefix) {
    const next = cpu.fetchByte();
    const handler = OPCODE_TABLE[next];
    if (!handler) {
        const ip = (cpu.regs.IP - 1) & 0xFFFF;
        throw new InvalidOpcodeError(next, cpu.regs.CS, ip);
    }
    // String ops know how to participate in a REP loop (CX-driven, optional
    // ZF break). Non-string ops don't loop — but IDIV reads cpu.repPrefix
    // for the documented-quirk quotient negation, and other ops legitimately
    // ignore the prefix (real silicon does the same). Looping non-string
    // ops would corrupt CX and run the instruction thousands of times.
    if (IS_STRING_OP[next] !== 1) {
        cpu.repPrefix = prefix;
        try {
            handler(cpu);
        }
        finally {
            cpu.repPrefix = null;
        }
        return;
    }
    const checksZF = STRING_CHECKS_ZF[next] === 1;
    while (cpu.regs.CX !== 0) {
        handler(cpu);
        cpu.regs.CX = (cpu.regs.CX - 1) & 0xFFFF;
        if (checksZF && cpu.flags.ZF === zfBreaksOn)
            break;
    }
}
OPCODE_TABLE[0xF3] = (cpu) => repLoop(cpu, /* zfBreaksOn */ false, 'F3'); // REP / REPE / REPZ
OPCODE_TABLE[0xF2] = (cpu) => repLoop(cpu, /* zfBreaksOn */ true, 'F2'); // REPNE / REPNZ
// ============================================================
// Helpers
// ============================================================
function readWord(cpu, segment, offset) {
    const lo = cpu.memory.readByte(linearAddress(segment, offset));
    const hi = cpu.memory.readByte(linearAddress(segment, (offset + 1) & 0xFFFF));
    return ((hi << 8) | lo) & 0xFFFF;
}
