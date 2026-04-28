import { signedByte } from '../core/types.js';
import { OPCODE_TABLE } from './opcodes.js';
/**
 * Conditional jumps (0x70–0x7F), JCXZ (0xE3), and the LOOP family (0xE0–0xE2).
 * All take an 8-bit signed displacement relative to the IP *after* the jump
 * instruction (so a 0-displacement jump is a no-op fall-through).
 *
 * Mnemonics map (numerous synonyms; these are the most common):
 *   70 JO         OF=1
 *   71 JNO        OF=0
 *   72 JB/JNAE/JC CF=1
 *   73 JNB/JAE/JNC CF=0
 *   74 JE/JZ      ZF=1
 *   75 JNE/JNZ    ZF=0
 *   76 JBE/JNA    CF=1 OR ZF=1
 *   77 JA/JNBE    CF=0 AND ZF=0
 *   78 JS         SF=1
 *   79 JNS        SF=0
 *   7A JP/JPE     PF=1
 *   7B JNP/JPO    PF=0
 *   7C JL/JNGE    SF != OF
 *   7D JGE/JNL    SF == OF
 *   7E JLE/JNG    ZF=1 OR SF != OF
 *   7F JG/JNLE    ZF=0 AND SF == OF
 *
 * LOOP family (0xE0–0xE2): pre-decrement CX (without affecting flags),
 * then jump if the post-decrement CX is non-zero, with the LOOPE/LOOPNE
 * variants additionally requiring ZF==1 / ZF==0 respectively.
 *
 * 0xE3 JCXZ tests CX directly (no decrement). Useful as a loop guard.
 */
function makeJcc(predicate) {
    return (cpu) => {
        // Always consume the displacement byte even if we don't jump — IP must
        // advance past the full instruction either way.
        const disp = signedByte(cpu.fetchByte());
        if (predicate(cpu)) {
            cpu.regs.IP = (cpu.regs.IP + disp) & 0xFFFF;
        }
    };
}
OPCODE_TABLE[0x70] = makeJcc((c) => c.flags.OF);
OPCODE_TABLE[0x71] = makeJcc((c) => !c.flags.OF);
OPCODE_TABLE[0x72] = makeJcc((c) => c.flags.CF);
OPCODE_TABLE[0x73] = makeJcc((c) => !c.flags.CF);
OPCODE_TABLE[0x74] = makeJcc((c) => c.flags.ZF);
OPCODE_TABLE[0x75] = makeJcc((c) => !c.flags.ZF);
OPCODE_TABLE[0x76] = makeJcc((c) => c.flags.CF || c.flags.ZF);
OPCODE_TABLE[0x77] = makeJcc((c) => !c.flags.CF && !c.flags.ZF);
OPCODE_TABLE[0x78] = makeJcc((c) => c.flags.SF);
OPCODE_TABLE[0x79] = makeJcc((c) => !c.flags.SF);
OPCODE_TABLE[0x7A] = makeJcc((c) => c.flags.PF);
OPCODE_TABLE[0x7B] = makeJcc((c) => !c.flags.PF);
OPCODE_TABLE[0x7C] = makeJcc((c) => c.flags.SF !== c.flags.OF);
OPCODE_TABLE[0x7D] = makeJcc((c) => c.flags.SF === c.flags.OF);
OPCODE_TABLE[0x7E] = makeJcc((c) => c.flags.ZF || (c.flags.SF !== c.flags.OF));
OPCODE_TABLE[0x7F] = makeJcc((c) => !c.flags.ZF && (c.flags.SF === c.flags.OF));
// ============================================================
// 0x60–0x6F  Aliases of 0x70–0x7F on 8086/8088
//
// On the 80186 these become PUSHA/POPA/IMUL imm/INS/OUTS, but the 8086
// silicon decoder only looks at the low 4 bits for this opcode block, so
// 0x60+n behaves identically to 0x70+n. The SST corpus confirms this with
// case names like "jo 004Dh" (initial opcode = 0x60). Re-using the same
// handler keeps semantics in lockstep.
// ============================================================
for (let i = 0; i < 16; i++) {
    OPCODE_TABLE[0x60 + i] = OPCODE_TABLE[0x70 + i];
}
// ============================================================
// LOOP family
//   CX-- (no flag side effects), then conditionally jump.
// ============================================================
OPCODE_TABLE[0xE0] = (cpu) => {
    const disp = signedByte(cpu.fetchByte());
    cpu.regs.CX = (cpu.regs.CX - 1) & 0xFFFF;
    if (cpu.regs.CX !== 0 && !cpu.flags.ZF) {
        cpu.regs.IP = (cpu.regs.IP + disp) & 0xFFFF;
    }
};
OPCODE_TABLE[0xE1] = (cpu) => {
    const disp = signedByte(cpu.fetchByte());
    cpu.regs.CX = (cpu.regs.CX - 1) & 0xFFFF;
    if (cpu.regs.CX !== 0 && cpu.flags.ZF) {
        cpu.regs.IP = (cpu.regs.IP + disp) & 0xFFFF;
    }
};
OPCODE_TABLE[0xE2] = (cpu) => {
    const disp = signedByte(cpu.fetchByte());
    cpu.regs.CX = (cpu.regs.CX - 1) & 0xFFFF;
    if (cpu.regs.CX !== 0) {
        cpu.regs.IP = (cpu.regs.IP + disp) & 0xFFFF;
    }
};
OPCODE_TABLE[0xE3] = (cpu) => {
    const disp = signedByte(cpu.fetchByte());
    if (cpu.regs.CX === 0) {
        cpu.regs.IP = (cpu.regs.IP + disp) & 0xFFFF;
    }
};
