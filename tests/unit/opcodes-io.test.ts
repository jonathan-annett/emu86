import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';
import type { IOBus } from '../../src/core/io.js';

class MockBus implements IOBus {
  byteReads: Array<{ port: number }> = [];
  byteWrites: Array<{ port: number; value: number }> = [];
  wordReads: Array<{ port: number }> = [];
  wordWrites: Array<{ port: number; value: number }> = [];

  byteReadValue = 0;
  wordReadValue = 0;

  inByte(port: number): number { this.byteReads.push({ port }); return this.byteReadValue; }
  inWord(port: number): number { this.wordReads.push({ port }); return this.wordReadValue; }
  outByte(port: number, value: number): void { this.byteWrites.push({ port, value }); }
  outWord(port: number, value: number): void { this.wordWrites.push({ port, value }); }

  // Registry side of IOBus is unused by these CPU-opcode tests; the mock is
  // a "what did the CPU call" recorder, not a real registry.
  register(): never { throw new Error('MockBus does not support register()'); }
  unregister(): never { throw new Error('MockBus does not support unregister()'); }
}

function cpuWith(bytes: number[], bus: IOBus): CPU8086 {
  const mem = new PagedMemory();
  bytes.forEach((b, i) => mem.writeByte(i, b));
  const cpu = new CPU8086(mem, bus);
  cpu.reset();
  cpu.regs.CS = 0; cpu.regs.IP = 0;
  return cpu;
}

describe('IN port immediate (0xE4 / 0xE5)', () => {
  it('IN AL, imm8 reads from the bus', () => {
    const bus = new MockBus(); bus.byteReadValue = 0x55;
    const cpu = cpuWith([0xE4, 0x42], bus);
    cpu.step();
    expect(cpu.regs.AL).toBe(0x55);
    expect(bus.byteReads).toEqual([{ port: 0x42 }]);
  });

  it('IN AX, imm8 reads a word', () => {
    const bus = new MockBus(); bus.wordReadValue = 0xCAFE;
    const cpu = cpuWith([0xE5, 0x10], bus);
    cpu.step();
    expect(cpu.regs.AX).toBe(0xCAFE);
    expect(bus.wordReads).toEqual([{ port: 0x10 }]);
  });
});

describe('OUT port immediate (0xE6 / 0xE7)', () => {
  it('OUT imm8, AL writes byte', () => {
    const bus = new MockBus();
    const cpu = cpuWith([0xE6, 0x42], bus);
    cpu.regs.AL = 0xAB;
    cpu.step();
    expect(bus.byteWrites).toEqual([{ port: 0x42, value: 0xAB }]);
  });

  it('OUT imm8, AX writes word', () => {
    const bus = new MockBus();
    const cpu = cpuWith([0xE7, 0x80], bus);
    cpu.regs.AX = 0xBEEF;
    cpu.step();
    expect(bus.wordWrites).toEqual([{ port: 0x80, value: 0xBEEF }]);
  });
});

describe('IN/OUT via DX (0xEC-0xEF)', () => {
  it('IN AL, DX uses DX as port', () => {
    const bus = new MockBus(); bus.byteReadValue = 0x77;
    const cpu = cpuWith([0xEC], bus);
    cpu.regs.DX = 0x3F8;        // serial port-ish address
    cpu.step();
    expect(cpu.regs.AL).toBe(0x77);
    expect(bus.byteReads).toEqual([{ port: 0x3F8 }]);
  });

  it('OUT DX, AX writes word to port DX', () => {
    const bus = new MockBus();
    const cpu = cpuWith([0xEF], bus);
    cpu.regs.DX = 0x1234; cpu.regs.AX = 0xDEAD;
    cpu.step();
    expect(bus.wordWrites).toEqual([{ port: 0x1234, value: 0xDEAD }]);
  });
});

describe('NullIOBus default behaviour through IN', () => {
  it('IN AL with no IOBus override returns 0xFF', () => {
    const mem = new PagedMemory();
    mem.writeByte(0, 0xE4); mem.writeByte(1, 0x10);
    const cpu = new CPU8086(mem);   // default NullIOBus
    cpu.reset(); cpu.regs.CS = 0; cpu.regs.IP = 0;
    cpu.step();
    expect(cpu.regs.AL).toBe(0xFF);
  });
});
