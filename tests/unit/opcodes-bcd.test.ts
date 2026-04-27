import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';

function cpuWith(bytes: number[]): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem);
  cpu.reset();
  cpu.regs.CS = 0; cpu.regs.IP = 0;
  cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
  return cpu;
}

describe('DAA (0x27)', () => {
  it('DAA after 0x05 + 0x05 = 0x0A → 0x10', () => {
    const cpu = cpuWith([0x27]);
    cpu.regs.AL = 0x0A;       // result of binary 5+5
    cpu.flags.AF = false; cpu.flags.CF = false;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x10);
    expect(cpu.flags.AF).toBe(true);
    expect(cpu.flags.CF).toBe(false);
  });

  it('DAA propagates to upper digit when AL > 0x99', () => {
    const cpu = cpuWith([0x27]);
    cpu.regs.AL = 0x9A;       // top nibble 9, low nibble A → both fixups
    cpu.step();
    // low nibble fix: 0x9A + 6 = 0xA0
    // high check: oldAL was 0x9A > 0x99 → +0x60 = 0x100 & 0xFF = 0x00, CF=1
    expect(cpu.regs.AL).toBe(0x00);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.ZF).toBe(true);
  });
});

describe('DAS (0x2F)', () => {
  it('DAS after BCD subtract 0x10 - 0x01 (binary AL=0x0F)', () => {
    const cpu = cpuWith([0x2F]);
    cpu.regs.AL = 0x0F;       // borrowed-from-AH binary result
    cpu.flags.AF = true; cpu.flags.CF = false;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x09);
    expect(cpu.flags.AF).toBe(true);
  });

  it('DAS subtracts 0x60 when oldAL > 0x99', () => {
    const cpu = cpuWith([0x2F]);
    cpu.regs.AL = 0xA0;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x40);
    expect(cpu.flags.CF).toBe(true);
  });

  it('DAS does not propagate AL-6 byte borrow into CF (8086 quirk)', () => {
    // Intel SDM ORs the borrow into CF; real 8086 (per SST corpus) does
    // not. AL=2, AF=1, CF=0 → AL=0xFC, CF stays 0.
    const cpu = cpuWith([0x2F]);
    cpu.regs.AL = 0x02;
    cpu.flags.AF = true; cpu.flags.CF = false;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFC);
    expect(cpu.flags.CF).toBe(false);
  });

  it('DAS skips high-fix when oldAL in 0x9A..0x9F and oldAF=1 (8086 quirk)', () => {
    // SST corpus shows the threshold is 0x9F (not 0x99) when AF was set
    // on entry. AL=0x9A with AF=1 → low fix only: AL = 0x9A-6 = 0x94, CF=0.
    const cpu = cpuWith([0x2F]);
    cpu.regs.AL = 0x9A;
    cpu.flags.AF = true; cpu.flags.CF = false;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x94);
    expect(cpu.flags.CF).toBe(false);
  });
});

describe('AAA (0x37)', () => {
  it('AAA after 5 + 5 = 0x0A: AL→0, AH+=1, AF=CF=1', () => {
    const cpu = cpuWith([0x37]);
    cpu.regs.AX = 0x000A;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x00);
    expect(cpu.regs.AH).toBe(0x01);
    expect(cpu.flags.CF).toBe(true);
    expect(cpu.flags.AF).toBe(true);
  });

  it('AAA when low nibble already valid: no fixup, just mask AL', () => {
    const cpu = cpuWith([0x37]);
    cpu.regs.AX = 0x0007;
    cpu.flags.AF = false;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x07);
    expect(cpu.regs.AH).toBe(0);
    expect(cpu.flags.CF).toBe(false);
    expect(cpu.flags.AF).toBe(false);
  });

  it('AAA: AL+6 byte-overflow does NOT cascade into AH', () => {
    // Real 8086 increments AH by 1 once, independent of any byte carry
    // from AL+6. We previously did AX += 0x106 which produced a second
    // increment when AL was 0xFA..0xFF. SST: AL=0xFF AH=0x72 → AH=0x73.
    const cpu = cpuWith([0x37]);
    cpu.regs.AX = 0x72FF;
    cpu.flags.AF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x05);
    expect(cpu.regs.AH).toBe(0x73);
    expect(cpu.flags.CF).toBe(true);
  });
});

describe('AAS (0x3F)', () => {
  it('AAS after 0 - 1 = 0xFF: AL→9, AH-=1, AF=CF=1', () => {
    const cpu = cpuWith([0x3F]);
    cpu.regs.AX = 0x00FF;     // simulating subtract underflow
    cpu.step();
    expect(cpu.regs.AL).toBe(0x09);
    expect(cpu.regs.AH).toBe(0xFF);
    expect(cpu.flags.AF).toBe(true);
    expect(cpu.flags.CF).toBe(true);
  });

  it('AAS: AL-6 byte-borrow does NOT cascade into AH', () => {
    // Mirror of AAA — independent byte ops. AL=0x05 AH=0x70 with low<=9
    // but AF=1 → AL = 0x05-6 = 0xFF, AH = 0x70-1 = 0x6F. Previously
    // AX -= 6 borrowed into AH, then AH -= 1 over-decremented it to 0x6E.
    const cpu = cpuWith([0x3F]);
    cpu.regs.AX = 0x7005;
    cpu.flags.AF = true;
    cpu.step();
    expect(cpu.regs.AL).toBe(0x0F);   // (0xFF) & 0x0F
    expect(cpu.regs.AH).toBe(0x6F);
    expect(cpu.flags.CF).toBe(true);
  });
});

describe('AAM (0xD4)', () => {
  it('AAM 0x0A: AH = AL/10, AL = AL%10', () => {
    // D4 0A
    const cpu = cpuWith([0xD4, 0x0A]);
    cpu.regs.AL = 53;
    cpu.step();
    expect(cpu.regs.AH).toBe(5);
    expect(cpu.regs.AL).toBe(3);
    expect(cpu.flags.ZF).toBe(false);
  });

  it('AAM with imm=0 services INT 0', () => {
    // Place program at 0x100 so the IVT entry doesn't overlap our opcode.
    const mem = new PagedMemory();
    mem.writeByte(0x100, 0xD4);
    mem.writeByte(0x101, 0x00);
    const cpu = new CPU8086(mem); cpu.reset();
    cpu.regs.CS = 0; cpu.regs.IP = 0x100;
    cpu.regs.SS = 0; cpu.regs.SP = 0x1000;
    cpu.memory.writeWord(0, 0x9999);
    cpu.memory.writeWord(2, 0x8888);
    cpu.step();
    expect(cpu.regs.IP).toBe(0x9999);
    expect(cpu.regs.CS).toBe(0x8888);
  });
});

describe('AAD (0xD5)', () => {
  it('AAD 0x0A: AL = AH*10 + AL, AH = 0', () => {
    // D5 0A
    const cpu = cpuWith([0xD5, 0x0A]);
    cpu.regs.AH = 5; cpu.regs.AL = 3;
    cpu.step();
    expect(cpu.regs.AL).toBe(53);
    expect(cpu.regs.AH).toBe(0);
  });

  it('AAD ZF set when result is 0', () => {
    const cpu = cpuWith([0xD5, 0x0A]);
    cpu.regs.AH = 0; cpu.regs.AL = 0;
    cpu.step();
    expect(cpu.flags.ZF).toBe(true);
  });
});
