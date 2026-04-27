import { describe, expect, it } from 'vitest';
import { CPU8086, InvalidOpcodeError } from '../../src/cpu8086/index.js';
import { linearAddress } from '../../src/core/types.js';
import { PagedMemory } from '../../src/memory/index.js';

/** Helper: build a CPU pointed at CS:IP = 0:0 with a given program at 0:0. */
function cpuWithProgram(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  for (let i = 0; i < bytes.length; i++) {
    mem.writeByte(i, bytes[i]!);
  }
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0;
  cpu.regs.IP = 0;
  return cpu;
}

describe('CPU8086 basics', () => {
  it('reset puts CS:IP at FFFF:0000', () => {
    const cpu = new CPU8086(new PagedMemory());
    cpu.reset();
    expect(cpu.regs.CS).toBe(0xFFFF);
    expect(cpu.regs.IP).toBe(0);
    expect(cpu.halted).toBe(false);
    expect(cpu.flags.value).toBe(0xF002);
  });

  it('fetchByte reads CS:IP then advances IP', () => {
    const mem = new PagedMemory();
    mem.writeByte(linearAddress(0x1000, 0x0005), 0xAB);
    const cpu = new CPU8086(mem);
    cpu.regs.CS = 0x1000;
    cpu.regs.IP = 0x0005;
    expect(cpu.fetchByte()).toBe(0xAB);
    expect(cpu.regs.IP).toBe(0x0006);
  });

  it('fetchWord reads little-endian and advances IP by 2', () => {
    const mem = new PagedMemory();
    mem.writeByte(0, 0x34);
    mem.writeByte(1, 0x12);
    const cpu = new CPU8086(mem);
    cpu.regs.CS = 0; cpu.regs.IP = 0;
    expect(cpu.fetchWord()).toBe(0x1234);
    expect(cpu.regs.IP).toBe(2);
  });

  it('IP wraps at 16 bits', () => {
    const mem = new PagedMemory();
    mem.writeByte(linearAddress(0, 0xFFFF), 0x90);   // NOP at the wrap point
    const cpu = new CPU8086(mem);
    cpu.regs.CS = 0; cpu.regs.IP = 0xFFFF;
    cpu.fetchByte();
    expect(cpu.regs.IP).toBe(0);
  });

  it('throws InvalidOpcodeError when a prefix is followed by a byte that fails to dispatch', () => {
    // After the 0x60-0x6F / 0xC0/C1/C8/C9 / 0xD6 / 0xF6.1 / 0xF7.1 silicon
    // aliases were added, every top-level opcode byte 0x00-0xFF is mapped.
    // The remaining trigger for InvalidOpcodeError is a prefix (LOCK 0xF0,
    // segment overrides, REP) followed by a byte that's still unmapped at
    // dispatch time — there are no such bytes in the table after init, but
    // we keep the error class wired up because the 0xFF group's far-pointer
    // sub-ops still throw it for register-mode operands (see below).
    //
    // FF /3 (CALL far) with mod=11 (register operand) is illegal: the
    // sub-op requires a memory operand. Our 0xFF handler raises
    // InvalidOpcodeError for that case.
    const cpu = cpuWithProgram([0xFF, 0xD8]);   // FF /3 mod=11 rm=000 (AX)
    expect(() => cpu.step()).toThrow(InvalidOpcodeError);
  });

  it('InvalidOpcodeError reports the offending opcode and address', () => {
    const cpu = cpuWithProgram([0xFF, 0xD8]);   // same trigger as above
    try {
      cpu.step();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidOpcodeError);
      const err = e as InvalidOpcodeError;
      expect(err.opcode).toBe(0xFF);
      expect(err.cs).toBe(0);
      // FF /3 throws after the ModR/M is decoded; the recorded IP is the
      // ModR/M byte's offset (1), not the opcode byte's (0). Sufficient for
      // diagnostics; exact alignment varies by which group throws.
      expect(err.ip).toBe(1);
    }
  });

  it('push wraps within SS when SP=0x0001 (high byte lands at SS:0000)', () => {
    // SST corpus exposed this: PUSH CS at SS:SP=0x9626:0x0001 must end with
    // SP=0xFFFF and the *high* byte of CS at SS:0x0000 (linear 0x96260),
    // not at one byte past SS:FFFF in linear space.
    const mem = new PagedMemory();
    const cpu = new CPU8086(mem);
    cpu.reset();
    cpu.regs.SS = 0x9626;
    cpu.regs.SP = 0x0001;
    cpu.push(0xABCD);
    expect(cpu.regs.SP).toBe(0xFFFF);
    // low byte at SS:FFFF, high byte wraps to SS:0000
    expect(mem.readByte(linearAddress(0x9626, 0xFFFF))).toBe(0xCD);
    expect(mem.readByte(linearAddress(0x9626, 0x0000))).toBe(0xAB);
  });

  it('pop wraps within SS when SP=0xFFFF (high byte read from SS:0000)', () => {
    const mem = new PagedMemory();
    mem.writeByte(linearAddress(0x9626, 0xFFFF), 0xCD);
    mem.writeByte(linearAddress(0x9626, 0x0000), 0xAB);
    const cpu = new CPU8086(mem);
    cpu.reset();
    cpu.regs.SS = 0x9626;
    cpu.regs.SP = 0xFFFF;
    expect(cpu.pop()).toBe(0xABCD);
    expect(cpu.regs.SP).toBe(0x0001);
  });

  it('step() is a no-op when halted', () => {
    const cpu = cpuWithProgram([0xF4, 0x90]);   // HLT, NOP
    cpu.step();   // HLT
    expect(cpu.halted).toBe(true);
    const ipAfterHlt = cpu.regs.IP;
    cpu.step();   // should not execute NOP
    expect(cpu.regs.IP).toBe(ipAfterHlt);
  });
});
