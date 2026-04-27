import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { OPCODE_TABLE } from '../../src/cpu8086/opcodes.js';
import { PagedMemory } from '../../src/memory/index.js';
import { linearAddress } from '../../src/core/types.js';

/* eslint-disable @typescript-eslint/no-unused-vars */

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0; cpu.regs.IP = 0;
  cpu.regs.DS = 0; cpu.regs.ES = 0;
  cpu.regs.SS = 0x1000;
  cpu.regs.SP = 0x0100;
  return cpu;
}

describe('PUSH/POP r16 (0x50–0x5F)', () => {
  it('PUSH AX decrements SP by 2 and writes AX to the new stack top', () => {
    const cpu = cpuWith([0x50]);
    cpu.regs.AX = 0x1234;
    const spBefore = cpu.regs.SP;
    cpu.step();
    expect(cpu.regs.SP).toBe(spBefore - 2);
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, cpu.regs.SP))).toBe(0x1234);
  });

  it('POP CX increments SP by 2 and loads CX from the popped slot', () => {
    const cpu = cpuWith([0x59]);                        // POP CX
    cpu.regs.SP = 0x00FE;                               // pretend something was pushed
    cpu.memory.writeWord(linearAddress(cpu.regs.SS, 0x00FE), 0xABCD);
    cpu.step();
    expect(cpu.regs.CX).toBe(0xABCD);
    expect(cpu.regs.SP).toBe(0x0100);
  });

  it('PUSH SP pushes the *new* SP value (8086 quirk)', () => {
    // 8086 silicon stores SP-after-decrement (0x00FE) at the new top of
    // stack. 80286+ silently changed this to push the original SP. The SST
    // 8088 corpus confirms post-decrement is the right behavior for us.
    const cpu = cpuWith([0x54]);
    cpu.regs.SP = 0x0100;
    cpu.step();
    expect(cpu.regs.SP).toBe(0x00FE);
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, 0x00FE))).toBe(0x00FE);
  });

  it('PUSH then POP roundtrips a register', () => {
    const cpu = cpuWith([0x53, 0x5B]);                  // PUSH BX; POP BX
    cpu.regs.BX = 0xCAFE;
    cpu.step();   // PUSH
    cpu.regs.BX = 0;
    cpu.step();   // POP
    expect(cpu.regs.BX).toBe(0xCAFE);
  });
});

describe('PUSH/POP segment registers', () => {
  it('PUSH ES (0x06) / POP ES (0x07)', () => {
    const cpu = cpuWith([0x06, 0x07]);
    cpu.regs.ES = 0x1234;
    cpu.step();
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, cpu.regs.SP))).toBe(0x1234);
    cpu.regs.ES = 0;
    cpu.step();
    expect(cpu.regs.ES).toBe(0x1234);
  });

  it('PUSH CS (0x0E) pushes current CS', () => {
    // Load the opcode at a non-zero CS so we can verify CS is what gets pushed.
    const mem = new PagedMemory();
    mem.writeByte(linearAddress(0xBEEF, 0), 0x0E);
    const cpu = new CPU8086(mem);
    cpu.reset();
    cpu.regs.CS = 0xBEEF; cpu.regs.IP = 0;
    cpu.regs.SS = 0x1000; cpu.regs.SP = 0x0100;
    cpu.step();
    expect(cpu.memory.readWord(linearAddress(0x1000, cpu.regs.SP))).toBe(0xBEEF);
  });
});

describe('CALL / RET near', () => {
  it('CALL near (0xE8) pushes return IP, then jumps relative', () => {
    // E8 03 00  — CALL +3.  Return IP = 3 (after the 3-byte CALL).
    // Target IP = 3 + 3 = 6.
    const cpu = cpuWith([0xE8, 0x03, 0x00, 0, 0, 0, 0x90]);
    cpu.step();
    expect(cpu.regs.IP).toBe(6);
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, cpu.regs.SP))).toBe(3);
  });

  it('RET near (0xC3) pops IP', () => {
    const cpu = cpuWith([0xC3]);
    // Pre-load return address at top of stack.
    cpu.regs.SP = 0x00FE;
    cpu.memory.writeWord(linearAddress(cpu.regs.SS, 0x00FE), 0x4321);
    cpu.step();
    expect(cpu.regs.IP).toBe(0x4321);
    expect(cpu.regs.SP).toBe(0x0100);
  });

  it('RET imm16 (0xC2) pops IP then advances SP by imm', () => {
    // C2 04 00  — RET 4
    const cpu = cpuWith([0xC2, 0x04, 0x00]);
    cpu.regs.SP = 0x00FE;
    cpu.memory.writeWord(linearAddress(cpu.regs.SS, 0x00FE), 0x5678);
    cpu.step();
    expect(cpu.regs.IP).toBe(0x5678);
    expect(cpu.regs.SP).toBe(0x0100 + 4);
  });

  it('CALL near can be undone by RET (round trip)', () => {
    // 0: E8 03 00     CALL to IP=6
    // 3: 00 00 00     padding
    // 6: C3           RET
    const cpu = cpuWith([0xE8, 0x03, 0x00, 0, 0, 0, 0xC3]);
    cpu.step();   // CALL
    expect(cpu.regs.IP).toBe(6);
    cpu.step();   // RET
    expect(cpu.regs.IP).toBe(3);
  });
});

describe('CALL / RET far', () => {
  it('CALL far (0x9A) pushes CS:IP and jumps to literal seg:off', () => {
    // 9A 34 12 78 56  — CALL far 5678:1234
    const cpu = cpuWith([0x9A, 0x34, 0x12, 0x78, 0x56]);
    cpu.regs.CS = 0; cpu.regs.IP = 0;
    cpu.step();
    expect(cpu.regs.CS).toBe(0x5678);
    expect(cpu.regs.IP).toBe(0x1234);
    // Top of stack: IP after instruction (5), then CS=0 above it.
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, cpu.regs.SP))).toBe(5);     // IP
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, (cpu.regs.SP + 2) & 0xFFFF))).toBe(0);  // CS
  });

  it('RET far (0xCB) pops IP then CS', () => {
    const cpu = cpuWith([0xCB]);
    cpu.regs.SP = 0x00FC;
    cpu.memory.writeWord(linearAddress(cpu.regs.SS, 0x00FC), 0x1111);   // IP
    cpu.memory.writeWord(linearAddress(cpu.regs.SS, 0x00FE), 0x2222);   // CS
    cpu.step();
    expect(cpu.regs.IP).toBe(0x1111);
    expect(cpu.regs.CS).toBe(0x2222);
    expect(cpu.regs.SP).toBe(0x0100);
  });
});

describe('JMP variants', () => {
  it('JMP near (0xE9) — relative 16-bit', () => {
    // E9 03 00 — jump +3 from IP=3 → IP=6
    const cpu = cpuWith([0xE9, 0x03, 0x00, 0, 0, 0, 0x90]);
    cpu.step();
    expect(cpu.regs.IP).toBe(6);
  });

  it('JMP near with negative rel16', () => {
    // E9 FB FF — jump -5
    const cpu = cpuWith([0xE9, 0xFB, 0xFF]);
    cpu.regs.IP = 0;
    cpu.step();
    expect(cpu.regs.IP).toBe(0xFFFE);   // 3 + (-5) wraps in 16 bits
  });

  it('JMP far (0xEA) — literal seg:off', () => {
    // EA 34 12 78 56 — JMP far 5678:1234
    const cpu = cpuWith([0xEA, 0x34, 0x12, 0x78, 0x56]);
    cpu.step();
    expect(cpu.regs.CS).toBe(0x5678);
    expect(cpu.regs.IP).toBe(0x1234);
  });
});

describe('0xFF group', () => {
  it('/2 CALL near r/m16 (register operand)', () => {
    // FF D3  — CALL BX  (mod=11, /reg=2, /rm=BX=3)
    const cpu = cpuWith([0xFF, 0xD3]);
    cpu.regs.BX = 0x4000;
    cpu.step();
    expect(cpu.regs.IP).toBe(0x4000);
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, cpu.regs.SP))).toBe(2);  // return IP
  });

  it('/3 CALL far m16:16 (memory operand)', () => {
    // FF 1F  — CALL FAR [BX]  (mod=00, /reg=3=CALL far, /rm=BX=7)
    const cpu = cpuWith([0xFF, 0x1F]);
    cpu.regs.BX = 0x0200; cpu.regs.DS = 0;
    // far pointer at [0:0x0200] = offset 0x4321, segment 0x8765
    cpu.memory.writeWord(0x0200, 0x4321);
    cpu.memory.writeWord(0x0202, 0x8765);
    cpu.step();
    expect(cpu.regs.CS).toBe(0x8765);
    expect(cpu.regs.IP).toBe(0x4321);
  });

  it('/4 JMP near r/m16', () => {
    // FF E3 — JMP BX
    const cpu = cpuWith([0xFF, 0xE3]);
    cpu.regs.BX = 0x1000;
    cpu.step();
    expect(cpu.regs.IP).toBe(0x1000);
  });

  it('/6 PUSH r/m16 with memory operand', () => {
    // FF 37 — PUSH [BX]  (/reg=6=PUSH, /rm=BX=7)
    const cpu = cpuWith([0xFF, 0x37]);
    cpu.regs.BX = 0x0200; cpu.regs.DS = 0;
    cpu.memory.writeWord(0x0200, 0xCAFE);
    cpu.step();
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, cpu.regs.SP))).toBe(0xCAFE);
  });

  it('/6 PUSH SP register-direct uses post-decrement quirk', () => {
    // FF F4 — PUSH SP  (mod=11, /reg=6, /rm=4=SP). Same 8086 quirk as
    // 0x54 PUSH SP: writes the *new* SP (after decrement), not the old.
    const cpu = cpuWith([0xFF, 0xF4]);
    cpu.regs.SP = 0x0100;
    cpu.step();
    expect(cpu.regs.SP).toBe(0x00FE);
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, 0x00FE))).toBe(0x00FE);
  });

  it('/7 aliases /6 PUSH r/m16 on 8086 silicon (memory operand)', () => {
    // FF 3F — PUSH [BX] via /reg=7. Real 8086 ignores the high bit of
    // /reg here (same family of quirks as F6/F7 /1=/0 and C6/C7 ignore).
    // SST corpus has 10000 cases at FF.7 that it expects to behave as PUSH.
    const cpu = cpuWith([0xFF, 0x3F]);
    cpu.regs.BX = 0x0200; cpu.regs.DS = 0;
    cpu.memory.writeWord(0x0200, 0xBEEF);
    cpu.step();
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, cpu.regs.SP))).toBe(0xBEEF);
  });

  it('/7 PUSH SP register-direct also uses post-decrement quirk', () => {
    // FF FC — PUSH SP via /reg=7. Both the /6 vs /7 alias and the
    // SP-quirk routes need to compose; this case exercises both.
    const cpu = cpuWith([0xFF, 0xFC]);
    cpu.regs.SP = 0x0100;
    cpu.step();
    expect(cpu.regs.SP).toBe(0x00FE);
    expect(cpu.memory.readWord(linearAddress(cpu.regs.SS, 0x00FE))).toBe(0x00FE);
  });

  it('/0 INC r/m16 — does NOT touch CF', () => {
    // FF C0 — INC AX
    const cpu = cpuWith([0xFF, 0xC0]);
    cpu.regs.AX = 0x0001;
    cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.AX).toBe(0x0002);
    expect(cpu.flags.CF).toBe(true);    // preserved
  });

  it('/1 DEC r/m16 sets ZF on result of 0', () => {
    // FF C8 — DEC AX
    const cpu = cpuWith([0xFF, 0xC8]);
    cpu.regs.AX = 0x0001;
    cpu.flags.CF = true;
    cpu.step();
    expect(cpu.regs.AX).toBe(0);
    expect(cpu.flags.ZF).toBe(true);
    expect(cpu.flags.CF).toBe(true);    // preserved
  });
});

describe('POP r/m16 (0x8F)', () => {
  it('pops into a memory destination', () => {
    // 8F 07  — POP [BX]  (/reg=0, /rm=[BX])
    const cpu = cpuWith([0x8F, 0x07]);
    cpu.regs.BX = 0x0300; cpu.regs.DS = 0;
    cpu.regs.SP = 0x00FE;
    cpu.memory.writeWord(linearAddress(cpu.regs.SS, 0x00FE), 0xDEAD);
    cpu.step();
    expect(cpu.memory.readWord(0x0300)).toBe(0xDEAD);
    expect(cpu.regs.SP).toBe(0x0100);
  });
});

describe('RET aliases (0xC0/0xC1/0xC8/0xC9)', () => {
  it('0xC0 aliases 0xC2 (RET imm16)', () => {
    expect(OPCODE_TABLE[0xC0]).toBe(OPCODE_TABLE[0xC2]);
  });
  it('0xC1 aliases 0xC3 (RET)', () => {
    expect(OPCODE_TABLE[0xC1]).toBe(OPCODE_TABLE[0xC3]);
  });
  it('0xC8 aliases 0xCA (RETF imm16)', () => {
    expect(OPCODE_TABLE[0xC8]).toBe(OPCODE_TABLE[0xCA]);
  });
  it('0xC9 aliases 0xCB (RETF)', () => {
    expect(OPCODE_TABLE[0xC9]).toBe(OPCODE_TABLE[0xCB]);
  });

  it('0xC1 actually pops IP (executable check)', () => {
    // SS:SP = 0:0x100, set [SS:SP] = 0x4321 then run 0xC1
    const cpu = cpuWith([0xC1]);
    cpu.regs.SS = 0; cpu.regs.SP = 0x100;
    cpu.memory.writeWord(0x100, 0x4321);
    cpu.step();
    expect(cpu.regs.IP).toBe(0x4321);
    expect(cpu.regs.SP).toBe(0x102);
  });
});
