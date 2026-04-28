import { OPCODE_TABLE } from './opcodes.js';
/**
 * I/O port instructions.
 *
 *   0xE4 ib   IN  AL, imm8     read byte from port imm8
 *   0xE5 ib   IN  AX, imm8     read word from port imm8 (port pair imm8/imm8+1)
 *   0xE6 ib   OUT imm8, AL     write byte to port imm8
 *   0xE7 ib   OUT imm8, AX     write word to port imm8
 *
 *   0xEC      IN  AL, DX       read byte from port (DX)
 *   0xED      IN  AX, DX       read word
 *   0xEE      OUT DX, AL       write byte to port (DX)
 *   0xEF      OUT DX, AX       write word to port (DX)
 *
 * Flags are not affected. The IOBus implementation handles port semantics;
 * the default {@link NullIOBus} returns 0xFF/0xFFFF and drops writes, which
 * matches "open bus" behaviour on real hardware where no device responds.
 */
OPCODE_TABLE[0xE4] = (cpu) => {
    const port = cpu.fetchByte();
    cpu.regs.AL = cpu.io.inByte(port);
};
OPCODE_TABLE[0xE5] = (cpu) => {
    const port = cpu.fetchByte();
    cpu.regs.AX = cpu.io.inWord(port);
};
OPCODE_TABLE[0xE6] = (cpu) => {
    const port = cpu.fetchByte();
    cpu.io.outByte(port, cpu.regs.AL);
};
OPCODE_TABLE[0xE7] = (cpu) => {
    const port = cpu.fetchByte();
    cpu.io.outWord(port, cpu.regs.AX);
};
OPCODE_TABLE[0xEC] = (cpu) => {
    cpu.regs.AL = cpu.io.inByte(cpu.regs.DX);
};
OPCODE_TABLE[0xED] = (cpu) => {
    cpu.regs.AX = cpu.io.inWord(cpu.regs.DX);
};
OPCODE_TABLE[0xEE] = (cpu) => {
    cpu.io.outByte(cpu.regs.DX, cpu.regs.AL);
};
OPCODE_TABLE[0xEF] = (cpu) => {
    cpu.io.outWord(cpu.regs.DX, cpu.regs.AX);
};
