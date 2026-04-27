import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/cpu.js';
import { TrapRegistry, type TrapHandler } from '../../src/cpu8086/trap-registry.js';
import { PagedMemory } from '../../src/memory/paged-memory.js';
import { linearAddress } from '../../src/core/types.js';

describe('TrapRegistry', () => {
  describe('registry semantics', () => {
    it('register + get returns the handler', () => {
      const reg = new TrapRegistry();
      const h: TrapHandler = () => {};
      reg.register(0x1000, h);
      expect(reg.get(0x1000)).toBe(h);
    });

    it('get returns undefined for an unregistered address', () => {
      const reg = new TrapRegistry();
      expect(reg.get(0x1000)).toBeUndefined();
    });

    it('unregister removes the handler', () => {
      const reg = new TrapRegistry();
      reg.register(0x2000, () => {});
      reg.unregister(0x2000);
      expect(reg.get(0x2000)).toBeUndefined();
    });

    it('unregister of an unregistered address throws', () => {
      const reg = new TrapRegistry();
      expect(() => reg.unregister(0x1234)).toThrow(/no handler registered/);
    });

    it('register twice at the same address throws', () => {
      const reg = new TrapRegistry();
      reg.register(0x4000, () => {});
      expect(() => reg.register(0x4000, () => {})).toThrow(/already has a registered handler/);
    });

    it('size reflects registrations', () => {
      const reg = new TrapRegistry();
      expect(reg.size).toBe(0);
      reg.register(0x100, () => {});
      reg.register(0x200, () => {});
      expect(reg.size).toBe(2);
      reg.unregister(0x100);
      expect(reg.size).toBe(1);
    });
  });

  describe('CPU integration', () => {
    function makeCpu(opts: { traps?: TrapRegistry } = {}) {
      const mem = new PagedMemory();
      // Full 4-arg form to exercise the optional registry parameter.
      const cpu = new CPU8086(mem, undefined, undefined, opts.traps);
      cpu.reset();
      // Land somewhere predictable rather than the FFFF:0000 reset vector.
      cpu.regs.CS = 0x1000;
      cpu.regs.IP = 0x0000;
      return { cpu, mem };
    }

    it('CPU constructed with no trap registry runs unchanged', () => {
      const { cpu, mem } = makeCpu();
      expect(cpu.traps).toBeUndefined();
      // MOV AX, 0x1234; HLT
      const base = linearAddress(0x1000, 0x0000);
      mem.writeByte(base + 0, 0xB8);
      mem.writeByte(base + 1, 0x34);
      mem.writeByte(base + 2, 0x12);
      mem.writeByte(base + 3, 0xF4);    // HLT
      cpu.step();                       // MOV
      cpu.step();                       // HLT
      expect(cpu.regs.AX).toBe(0x1234);
      expect(cpu.halted).toBe(true);
    });

    it('CPU with empty trap registry runs unchanged', () => {
      const traps = new TrapRegistry();
      const { cpu, mem } = makeCpu({ traps });
      const base = linearAddress(0x1000, 0x0000);
      mem.writeByte(base + 0, 0xB8);
      mem.writeByte(base + 1, 0x78);
      mem.writeByte(base + 2, 0x56);
      mem.writeByte(base + 3, 0xF4);
      cpu.step();
      cpu.step();
      expect(cpu.regs.AX).toBe(0x5678);
      expect(cpu.halted).toBe(true);
    });

    it('handler runs before the instruction at the trap address', () => {
      // Trap sets AX=0x1234; instruction at trap address is MOV BX, AX.
      // After step+step we expect BX=0x1234 — proves the handler ran first
      // and the MOV still executed afterward.
      const traps = new TrapRegistry();
      const { cpu, mem } = makeCpu({ traps });
      const base = linearAddress(0x1000, 0x0000);
      // MOV BX, AX = 0x89 0xC3 (MOV r/m16, r16 with mod=11 reg=AX r/m=BX)
      mem.writeByte(base + 0, 0x89);
      mem.writeByte(base + 1, 0xC3);
      mem.writeByte(base + 2, 0xF4);   // HLT
      traps.register(base, (cpu) => {
        cpu.regs.AX = 0x1234;
      });
      cpu.step();   // trap fires, sets AX, then MOV BX, AX runs
      expect(cpu.regs.AX).toBe(0x1234);
      expect(cpu.regs.BX).toBe(0x1234);
    });

    it('handler fires once per instruction execution at that address', () => {
      // Tight loop: JMP back to a trap address. Counter increments each time
      // the handler runs. Run for 10 steps; expect counter = 10.
      const traps = new TrapRegistry();
      const { cpu, mem } = makeCpu({ traps });
      const base = linearAddress(0x1000, 0x0000);
      // JMP rel8 -2 => 0xEB 0xFE, an infinite loop on itself.
      // The trap is at `base`; each iteration: trap fires, then JMP runs,
      // returning IP to `base`. Next step: trap fires again.
      mem.writeByte(base + 0, 0xEB);
      mem.writeByte(base + 1, 0xFE);
      let count = 0;
      traps.register(base, () => { count++; });
      for (let i = 0; i < 10; i++) cpu.step();
      expect(count).toBe(10);
    });

    it('handler does NOT fire while the CPU is halted', () => {
      const traps = new TrapRegistry();
      const { cpu, mem } = makeCpu({ traps });
      const base = linearAddress(0x1000, 0x0000);
      mem.writeByte(base + 0, 0xF4);   // HLT
      let count = 0;
      // Register at the address AFTER HLT — IP after HLT is base+1.
      traps.register(base + 1, () => { count++; });
      cpu.step();                       // executes HLT, halts
      expect(cpu.halted).toBe(true);
      // Spin a few halted steps; trap must not fire (early return path).
      cpu.step();
      cpu.step();
      cpu.step();
      expect(count).toBe(0);
    });

    it('handler may modify CS:IP and the next step honours the new address', () => {
      const traps = new TrapRegistry();
      const { cpu, mem } = makeCpu({ traps });
      const base = linearAddress(0x1000, 0x0000);
      // At base: MOV AX, 1 — but the trap will redirect IP to base+5 first.
      mem.writeByte(base + 0, 0xB8); mem.writeByte(base + 1, 0x01); mem.writeByte(base + 2, 0x00);
      // At base+5: MOV AX, 2; HLT
      mem.writeByte(base + 5, 0xB8); mem.writeByte(base + 6, 0x02); mem.writeByte(base + 7, 0x00);
      mem.writeByte(base + 8, 0xF4);
      traps.register(base, (cpu) => {
        cpu.regs.IP = 0x0005;   // jump past the MOV AX,1
      });
      cpu.step();   // trap fires, IP→5; then MOV AX,2 fetches at base+5
      cpu.step();   // HLT
      expect(cpu.regs.AX).toBe(0x0002);
      expect(cpu.halted).toBe(true);
    });

    it('handler is keyed on the linear CS:IP address', () => {
      // Register a handler at one linear address; reach it via two different
      // CS:IP encodings (CS:IP forms a linear address, and many encodings
      // resolve to the same one). Both should fire the same handler.
      const traps = new TrapRegistry();
      const mem = new PagedMemory();
      const cpu = new CPU8086(mem, undefined, undefined, traps);
      cpu.reset();
      const target = linearAddress(0x1000, 0x0010);   // = 0x10010
      // Place a NOP+HLT at target.
      mem.writeByte(target + 0, 0x90);   // NOP
      mem.writeByte(target + 1, 0xF4);   // HLT
      let count = 0;
      traps.register(target, () => { count++; });

      // First reach: CS=0x1000, IP=0x0010
      cpu.regs.CS = 0x1000; cpu.regs.IP = 0x0010;
      cpu.step();                          // NOP (trap fires)
      expect(count).toBe(1);
      // Second reach: CS=0x1001, IP=0x0000 — same linear address 0x10010
      cpu.regs.CS = 0x1001; cpu.regs.IP = 0x0000;
      cpu.halted = false;
      cpu.step();
      expect(count).toBe(2);
    });
  });
});
