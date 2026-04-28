import { linearAddress } from '../core/types.js';
import { InvalidOpcodeError } from './errors.js';
import { flagsDec16, flagsInc16 } from './flag-helpers.js';
import { decodeModRM, rmOperand } from './modrm.js';
import { OPCODE_TABLE } from './opcodes.js';
/**
 * Stack and control-flow opcodes:
 *   PUSH/POP reg (0x50–0x5F)
 *   PUSH/POP sreg (0x06/0x07, 0x0E, 0x0F, 0x16/0x17, 0x1E/0x1F)
 *   POP r/m16 (0x8F /0)
 *   PUSH r/m16 (handled in 0xFF group below as sub-op 6)
 *   CALL/RET (near + far, with optional stack adjust)
 *   JMP near + far + indirect
 *   The 0xFF group's CALL/JMP sub-ops; the INC/DEC sub-ops are in opcodes-arith.ts
 *
 * Stack accesses always go through SS — they never honour a segment override
 * prefix. Use cpu.push()/cpu.pop() throughout, EXCEPT for PUSH SP (see note).
 *
 * 8086 PUSH SP quirk: the chip pushes the *post*-decrement SP value (the
 * value already decremented). The 80286 silently changed this to push the
 * original SP. The SST corpus is 8088 silicon, and verified this — both
 * 0x54 (PUSH SP) and FF /6 with r/m=SP push the new SP. Calling
 * cpu.push(cpu.regs.SP) would capture the *old* SP via JS arg-evaluation
 * order, so PUSH SP gets its own implementation that writes after the
 * decrement.
 */
// ============================================================
// 0x50–0x57  PUSH r16   |   0x58–0x5F  POP r16
//
//   reg encoded in low 3 bits of opcode (AX/CX/DX/BX/SP/BP/SI/DI).
//
// 0x54 PUSH SP is the silicon quirk: push the post-decrement SP.
// ============================================================
for (let reg = 0; reg < 8; reg++) {
    const r = reg;
    if (r === 4) {
        OPCODE_TABLE[0x50 + r] = pushPostDecrementSP;
    }
    else {
        OPCODE_TABLE[0x50 + r] = (cpu) => cpu.push(cpu.regs.getReg16(r));
    }
}
function pushPostDecrementSP(cpu) {
    cpu.regs.SP = (cpu.regs.SP - 2) & 0xFFFF;
    const sp = cpu.regs.SP;
    cpu.memory.writeByte(linearAddress(cpu.regs.SS, sp), sp & 0xFF);
    cpu.memory.writeByte(linearAddress(cpu.regs.SS, (sp + 1) & 0xFFFF), (sp >> 8) & 0xFF);
}
for (let reg = 0; reg < 8; reg++) {
    const r = reg;
    OPCODE_TABLE[0x58 + r] = (cpu) => cpu.regs.setReg16(r, cpu.pop());
}
// ============================================================
// PUSH/POP segment registers
//
//   0x06 PUSH ES   0x07 POP ES
//   0x0E PUSH CS   0x0F POP CS  (yes, on 8086 — undefined on 80186+)
//   0x16 PUSH SS   0x17 POP SS
//   0x1E PUSH DS   0x1F POP DS
// ============================================================
function pushSreg(idx) {
    return (cpu) => cpu.push(cpu.regs.getSreg(idx));
}
function popSreg(idx) {
    return (cpu) => cpu.regs.setSreg(idx, cpu.pop());
}
OPCODE_TABLE[0x06] = pushSreg(0); // ES
OPCODE_TABLE[0x07] = popSreg(0);
OPCODE_TABLE[0x0E] = pushSreg(1); // CS
OPCODE_TABLE[0x0F] = popSreg(1); // POP CS — 8086 executes; 186+ is a prefix
OPCODE_TABLE[0x16] = pushSreg(2); // SS
// POP SS arms the one-instruction interrupt-inhibit window. The next
// instruction is typically a load of SP (the matching half of an SS:SP
// pair); an interrupt between the two would push to a half-loaded
// stack and corrupt state. Real 8086 silicon enforces this.
OPCODE_TABLE[0x17] = (cpu) => {
    cpu.regs.setSreg(2, cpu.pop());
    cpu.interruptInhibit = true;
};
OPCODE_TABLE[0x1E] = pushSreg(3); // DS
OPCODE_TABLE[0x1F] = popSreg(3);
// ============================================================
// 0x8F /0  POP r/m16
//
// Other /reg values are undefined/reserved on 8086. Real silicon executes
// them as POP anyway, so to match the SST corpus we treat all sub-ops as POP.
// ============================================================
OPCODE_TABLE[0x8F] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = rmOperand(cpu, m);
    dst.write16(cpu.pop());
};
// ============================================================
// 0xE8  CALL near (rel16)
//   Push return address (IP-after-this-instruction), then IP += rel16.
// ============================================================
OPCODE_TABLE[0xE8] = (cpu) => {
    const rel = cpu.fetchWord(); // unsigned read
    // After fetchWord, IP points to the next instruction = the return address.
    cpu.push(cpu.regs.IP);
    // Add rel as signed 16-bit. Mask to 16 bits handles wrap.
    cpu.regs.IP = (cpu.regs.IP + rel) & 0xFFFF;
};
// ============================================================
// 0x9A  CALL far (ptr16:16)
//   Operand is offset (lo word) then segment (hi word).
//   Push CS, push IP-after-this-instruction, then jump to seg:off.
// ============================================================
OPCODE_TABLE[0x9A] = (cpu) => {
    const off = cpu.fetchWord();
    const seg = cpu.fetchWord();
    cpu.push(cpu.regs.CS);
    cpu.push(cpu.regs.IP);
    cpu.regs.CS = seg;
    cpu.regs.IP = off;
};
// ============================================================
// 0xC3  RET near
//   Pop IP.
// ============================================================
OPCODE_TABLE[0xC3] = (cpu) => {
    cpu.regs.IP = cpu.pop();
};
// ============================================================
// 0xC2  RET near, imm16
//   Pop IP, then SP += imm16. Used for callee-cleanup conventions.
// ============================================================
OPCODE_TABLE[0xC2] = (cpu) => {
    const adjust = cpu.fetchWord();
    cpu.regs.IP = cpu.pop();
    cpu.regs.SP = (cpu.regs.SP + adjust) & 0xFFFF;
};
// ============================================================
// 0xCB  RET far
//   Pop IP, then CS.
// ============================================================
OPCODE_TABLE[0xCB] = (cpu) => {
    cpu.regs.IP = cpu.pop();
    cpu.regs.CS = cpu.pop();
};
// ============================================================
// 0xCA  RET far, imm16
// ============================================================
OPCODE_TABLE[0xCA] = (cpu) => {
    const adjust = cpu.fetchWord();
    cpu.regs.IP = cpu.pop();
    cpu.regs.CS = cpu.pop();
    cpu.regs.SP = (cpu.regs.SP + adjust) & 0xFFFF;
};
// ============================================================
// 0xC0/0xC1/0xC8/0xC9 — RET aliases on 8086/8088
//
// On the 80186 these became shift-by-imm8 (C0/C1) and ENTER/LEAVE (C8/C9).
// 8086 silicon ignores the low bit and the high-bit-set form, so:
//   0xC0 ≡ 0xC2 (RET imm16),  0xC1 ≡ 0xC3 (RET)
//   0xC8 ≡ 0xCA (RETF imm16), 0xC9 ≡ 0xCB (RETF)
// SST corpus confirms via case names like "retn 5706h" / "retf".
// ============================================================
OPCODE_TABLE[0xC0] = OPCODE_TABLE[0xC2];
OPCODE_TABLE[0xC1] = OPCODE_TABLE[0xC3];
OPCODE_TABLE[0xC8] = OPCODE_TABLE[0xCA];
OPCODE_TABLE[0xC9] = OPCODE_TABLE[0xCB];
// ============================================================
// 0xE9  JMP near (rel16)
// ============================================================
OPCODE_TABLE[0xE9] = (cpu) => {
    const rel = cpu.fetchWord();
    cpu.regs.IP = (cpu.regs.IP + rel) & 0xFFFF;
};
// ============================================================
// 0xEA  JMP far (ptr16:16)
// ============================================================
OPCODE_TABLE[0xEA] = (cpu) => {
    const off = cpu.fetchWord();
    const seg = cpu.fetchWord();
    cpu.regs.CS = seg;
    cpu.regs.IP = off;
};
// 0xEB JMP short rel8 already lives in opcodes.ts (v0).
// ============================================================
// 0xFF group  —  sub-op selected by ModR/M /reg field
//
//   0  INC r/m16
//   1  DEC r/m16
//   2  CALL near r/m16        — push IP, jump to operand value
//   3  CALL far m16:16        — operand MUST be memory (loads off, seg)
//   4  JMP near r/m16
//   5  JMP far m16:16
//   6  PUSH r/m16
//   7  alias of /6 on 8086 silicon (SST corpus confirms; not in Intel SDM) —
//      the chip ignores the high bit of /reg here just like the F6/F7 /1=/0
//      and C6/C7 /reg quirks.
//
// INC/DEC r/m8 (the 0xFE group) and the 0xF6/0xF7 family live in
// opcodes-arith.ts; we keep the 16-bit INC/DEC inline here because they
// share the dispatcher.
// ============================================================
OPCODE_TABLE[0xFF] = (cpu) => {
    const m = decodeModRM(cpu);
    const op = rmOperand(cpu, m);
    switch (m.reg) {
        case 0: { // INC r/m16
            const before = op.read16();
            const r = (before + 1) & 0xFFFF;
            flagsInc16(cpu.flags, before, r);
            op.write16(r);
            return;
        }
        case 1: { // DEC r/m16
            const before = op.read16();
            const r = (before - 1) & 0xFFFF;
            flagsDec16(cpu.flags, before, r);
            op.write16(r);
            return;
        }
        case 2: { // CALL near r/m16
            const target = op.read16();
            cpu.push(cpu.regs.IP);
            cpu.regs.IP = target;
            return;
        }
        case 3: { // CALL far m16:16
            if (!op.isMemory) {
                throw new InvalidOpcodeError(0xFF, cpu.regs.CS, (cpu.regs.IP - 1) & 0xFFFF);
            }
            const newIP = readWordAt(cpu, op.segment, op.offset);
            const newCS = readWordAt(cpu, op.segment, (op.offset + 2) & 0xFFFF);
            cpu.push(cpu.regs.CS);
            cpu.push(cpu.regs.IP);
            cpu.regs.CS = newCS;
            cpu.regs.IP = newIP;
            return;
        }
        case 4: { // JMP near r/m16
            cpu.regs.IP = op.read16();
            return;
        }
        case 5: { // JMP far m16:16
            if (!op.isMemory) {
                throw new InvalidOpcodeError(0xFF, cpu.regs.CS, (cpu.regs.IP - 1) & 0xFFFF);
            }
            cpu.regs.IP = readWordAt(cpu, op.segment, op.offset);
            cpu.regs.CS = readWordAt(cpu, op.segment, (op.offset + 2) & 0xFFFF);
            return;
        }
        case 6: // PUSH r/m16
        case 7: { // /7 aliases /6 on 8086
            // 8086 PUSH SP quirk: when the operand is the SP register itself, the
            // chip writes the *post*-decrement SP value (the new SP), not the old.
            // Same quirk as the 0x54 PUSH SP encoding above. SST corpus confirms.
            // mod=11 r/m=100 selects SP register-direct; isMemory=false catches
            // the register form.
            if (!op.isMemory && m.rm === 4) {
                pushPostDecrementSP(cpu);
                return;
            }
            cpu.push(op.read16());
            return;
        }
        default:
            throw new InvalidOpcodeError(0xFF, cpu.regs.CS, (cpu.regs.IP - 1) & 0xFFFF);
    }
};
// Helper for the far-pointer fetches above. Reads a word at (seg:off),
// honouring 16-bit offset wrap inside the segment.
function readWordAt(cpu, segment, offset) {
    const lo = cpu.memory.readByte(linearAddress(segment, offset));
    const hi = cpu.memory.readByte(linearAddress(segment, (offset + 1) & 0xFFFF));
    return ((hi << 8) | lo) & 0xFFFF;
}
