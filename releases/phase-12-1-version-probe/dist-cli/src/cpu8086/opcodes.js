import { signedByte } from '../core/types.js';
import { InvalidOpcodeError } from './errors.js';
/**
 * 256-slot dispatch table. Entries are `undefined` for unimplemented opcodes,
 * at which point the CPU throws InvalidOpcodeError.
 */
export const OPCODE_TABLE = new Array(256);
// ALU family (ADD/OR/ADC/SBB/AND/SUB/XOR/CMP) handlers, including the legacy
// 0x04 ADD AL, imm8 / 0x05 ADD AX, imm16 entries from v0, are registered by
// the side-effect import of './opcodes-alu.js' (see cpu.ts).
// ============================================================
// 0x90  NOP   (technically XCHG AX, AX — observable effect is nil)
// ============================================================
OPCODE_TABLE[0x90] = (_cpu) => {
    /* no-op */
};
// ============================================================
// 0xB0 – 0xB7  MOV r8, imm8
//   reg8 encoded in the low 3 bits of the opcode:
//     B0=AL B1=CL B2=DL B3=BL B4=AH B5=CH B6=DH B7=BH
// ============================================================
for (let reg = 0; reg < 8; reg++) {
    const regIndex = reg; // capture per-iteration binding
    OPCODE_TABLE[0xB0 + reg] = (cpu) => {
        const imm = cpu.fetchByte();
        cpu.regs.setReg8(regIndex, imm);
    };
}
// ============================================================
// 0xB8 – 0xBF  MOV r16, imm16
//   reg16 encoded in the low 3 bits:
//     B8=AX B9=CX BA=DX BB=BX BC=SP BD=BP BE=SI BF=DI
// ============================================================
for (let reg = 0; reg < 8; reg++) {
    const regIndex = reg;
    OPCODE_TABLE[0xB8 + reg] = (cpu) => {
        const imm = cpu.fetchWord();
        cpu.regs.setReg16(regIndex, imm);
    };
}
// ============================================================
// 0xEB  JMP short (rel8)
//   Target = IP-after-fetch + signed(disp8).
//   The "IP-after-fetch" part is automatic since fetchByte advances IP
//   before we add the displacement.
// ============================================================
OPCODE_TABLE[0xEB] = (cpu) => {
    const disp = signedByte(cpu.fetchByte());
    cpu.regs.IP = (cpu.regs.IP + disp) & 0xFFFF;
};
// ============================================================
// 0x26 / 0x2E / 0x36 / 0x3E  Segment override prefixes
//
// Each prefix sets cpu.segOverride to the override sreg index, then
// fetches and dispatches the *next* opcode within the same step(). We
// can't recursively call step() because step() resets segOverride; we
// have to do the fetch+dispatch ourselves.
//
// Multiple prefixes back-to-back: each just overwrites the previous
// segOverride. Real 8086 keeps only the last one — same effect here.
//
//   0x26  ES override   (sreg index 0)
//   0x2E  CS override   (sreg index 1)
//   0x36  SS override   (sreg index 2)
//   0x3E  DS override   (sreg index 3)
// ============================================================
function makeSegmentPrefix(sregIndex) {
    return (cpu) => {
        cpu.segOverride = sregIndex;
        const next = cpu.fetchByte();
        const handler = OPCODE_TABLE[next];
        if (!handler) {
            const ip = (cpu.regs.IP - 1) & 0xFFFF;
            throw new InvalidOpcodeError(next, cpu.regs.CS, ip);
        }
        handler(cpu);
    };
}
OPCODE_TABLE[0x26] = makeSegmentPrefix(0); // ES:
OPCODE_TABLE[0x2E] = makeSegmentPrefix(1); // CS:
OPCODE_TABLE[0x36] = makeSegmentPrefix(2); // SS:
OPCODE_TABLE[0x3E] = makeSegmentPrefix(3); // DS:
// ============================================================
// 0xF4  HLT
//   Real 8086: CPU stops until an interrupt arrives. The run loop polls
//   `halted` and will skip stepping until something clears it (interrupt
//   service routine, in the future).
// ============================================================
OPCODE_TABLE[0xF4] = (cpu) => {
    cpu.halted = true;
};
