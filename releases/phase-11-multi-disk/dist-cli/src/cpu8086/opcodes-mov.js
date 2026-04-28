import { linearAddress } from '../core/types.js';
import { decodeModRM, regOperand, rmOperand } from './modrm.js';
import { OPCODE_TABLE } from './opcodes.js';
/**
 * MOV instructions that need ModR/M decoding, plus the moffs accumulator
 * forms and the immediate-to-r/m forms.
 *
 *   0x88  MOV r/m8, r8
 *   0x89  MOV r/m16, r16
 *   0x8A  MOV r8, r/m8
 *   0x8B  MOV r16, r/m16
 *   0x8C  MOV r/m16, sreg     (/reg field selects sreg index 0..3)
 *   0x8E  MOV sreg, r/m16     (/reg field selects sreg index 0..3)
 *
 *   0xA0  MOV AL, [moffs8]    (16-bit offset, segment from cpu.dataSegment())
 *   0xA1  MOV AX, [moffs16]
 *   0xA2  MOV [moffs8], AL
 *   0xA3  MOV [moffs16], AX
 *
 *   0xC6  MOV r/m8,  imm8     (group: only /reg=0 is MOV; others undefined)
 *   0xC7  MOV r/m16, imm16
 *
 * MOV never touches flags. Segment-register MOV ignores the high bit of the
 * /reg field on real 8086 (only 4 sregs exist) — we mirror that with `& 3`.
 *
 * MOV sreg, r/m16 to CS (/reg=1) is not legal in real software but the
 * 8086 doesn't fault on it; we just let it happen. The next fetch will then
 * read from the new CS:IP.
 *
 * The 8C/8E /reg field also disables interrupts for one instruction when
 * loading SS — we don't model interrupt timing, so this is a no-op for us.
 */
// ============================================================
// 0x88 / 0x89  MOV r/m, r
// ============================================================
OPCODE_TABLE[0x88] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = rmOperand(cpu, m);
    const src = regOperand(cpu, m.reg);
    dst.write8(src.read8());
};
OPCODE_TABLE[0x89] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = rmOperand(cpu, m);
    const src = regOperand(cpu, m.reg);
    dst.write16(src.read16());
};
// ============================================================
// 0x8A / 0x8B  MOV r, r/m
// ============================================================
OPCODE_TABLE[0x8A] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = regOperand(cpu, m.reg);
    const src = rmOperand(cpu, m);
    dst.write8(src.read8());
};
OPCODE_TABLE[0x8B] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = regOperand(cpu, m.reg);
    const src = rmOperand(cpu, m);
    dst.write16(src.read16());
};
// ============================================================
// 0x8C / 0x8E  MOV with segment register
//
// /reg field selects the sreg (mask & 3 since only 4 sregs exist).
// ============================================================
OPCODE_TABLE[0x8C] = (cpu) => {
    const m = decodeModRM(cpu);
    const dst = rmOperand(cpu, m);
    dst.write16(cpu.regs.getSreg(m.reg & 3));
};
OPCODE_TABLE[0x8E] = (cpu) => {
    const m = decodeModRM(cpu);
    const src = rmOperand(cpu, m);
    const sregIdx = m.reg & 3;
    cpu.regs.setSreg(sregIdx, src.read16());
    // MOV SS, r/m arms the one-instruction interrupt-inhibit window. Same
    // hardware reason as POP SS — the matching SP load comes next, and
    // an interrupt between them would push to a half-loaded stack. Only
    // SS (sreg index 2) gets the inhibit; the other segment registers
    // don't share the corrupt-stack hazard.
    if (sregIdx === 2) {
        cpu.interruptInhibit = true;
    }
};
// ============================================================
// 0xA0–0xA3  MOV moffs accumulator forms
//
// The 16-bit displacement immediately follows the opcode. Segment is
// cpu.dataSegment() — defaults DS, honours an override prefix.
// ============================================================
OPCODE_TABLE[0xA0] = (cpu) => {
    const offset = cpu.fetchWord();
    cpu.regs.AL = cpu.memory.readByte(linearAddress(cpu.dataSegment(), offset));
};
OPCODE_TABLE[0xA1] = (cpu) => {
    const offset = cpu.fetchWord();
    const seg = cpu.dataSegment();
    const lo = cpu.memory.readByte(linearAddress(seg, offset));
    const hi = cpu.memory.readByte(linearAddress(seg, (offset + 1) & 0xFFFF));
    cpu.regs.AX = ((hi << 8) | lo) & 0xFFFF;
};
OPCODE_TABLE[0xA2] = (cpu) => {
    const offset = cpu.fetchWord();
    cpu.memory.writeByte(linearAddress(cpu.dataSegment(), offset), cpu.regs.AL);
};
OPCODE_TABLE[0xA3] = (cpu) => {
    const offset = cpu.fetchWord();
    const seg = cpu.dataSegment();
    const v = cpu.regs.AX;
    cpu.memory.writeByte(linearAddress(seg, offset), v & 0xFF);
    cpu.memory.writeByte(linearAddress(seg, (offset + 1) & 0xFFFF), (v >>> 8) & 0xFF);
};
// ============================================================
// 0xC6 / 0xC7  MOV r/m, imm
//
// Group encoding: nominally only /reg=0 is MOV. On 8086 silicon, the /reg
// field is not actually decoded for this opcode — all eight sub-ops behave
// identically to MOV r/m, imm. The SST corpus exercises every /reg and
// expects MOV semantics throughout. The immediate is fetched AFTER the
// ModR/M (and any displacement), per encoding order.
// ============================================================
OPCODE_TABLE[0xC6] = (cpu) => {
    const m = decodeModRM(cpu);
    const imm = cpu.fetchByte();
    rmOperand(cpu, m).write8(imm);
};
OPCODE_TABLE[0xC7] = (cpu) => {
    const m = decodeModRM(cpu);
    const imm = cpu.fetchWord();
    rmOperand(cpu, m).write16(imm);
};
