import { describe, expect, it } from 'vitest';
import { FLAG } from '../../src/core/flags.js';
import { linearAddress } from '../../src/core/types.js';
import { CPU8086 } from '../../src/cpu8086/index.js';
import { BasicInterruptController } from '../../src/interrupts/index.js';
import { PagedMemory } from '../../src/memory/index.js';

/**
 * CPU + InterruptController integration. The CPU services hardware-source
 * interrupts at instruction boundaries. These tests drive the controller
 * directly (no real timers) so each scenario is deterministic.
 *
 * Layout convention: CS=0, SS=0, SP=0x1000, IVT at 0:0, code at 0:0,
 * handlers at 0x100:0 and friends. We put HLT (0xF4) at handler entry
 * for most scenarios because halted=true is an unambiguous "we got here"
 * signal that doesn't need extra state to verify.
 */

interface Setup {
  cpu: CPU8086;
  ctrl: BasicInterruptController;
  mem: PagedMemory;
}

function setup(): Setup {
  const mem = new PagedMemory();
  const ctrl = new BasicInterruptController();
  const cpu = new CPU8086(mem, undefined, ctrl);
  cpu.reset();
  cpu.regs.CS = 0;
  cpu.regs.IP = 0;
  cpu.regs.SS = 0;
  cpu.regs.SP = 0x1000;
  return { cpu, ctrl, mem };
}

function ivt(mem: PagedMemory, vec: number, cs: number, ip: number): void {
  mem.writeWord(vec * 4, ip);
  mem.writeWord(vec * 4 + 2, cs);
}

// ============================================================
// 1. Maskable, IF=1 — basic service
// ============================================================
describe('CPU services maskable interrupts at instruction boundary', () => {
  it('IF=1 + maskable pending → service, push flags/CS/IP, clear IF/TF, jump via IVT', () => {
    const { cpu, ctrl, mem } = setup();
    ivt(mem, 0x40, 0x100, 0);
    mem.writeByte(linearAddress(0x100, 0), 0xF4); // HLT at handler entry

    cpu.flags.IF = true;
    cpu.flags.TF = true;
    cpu.flags.CF = true;
    const flagsBefore = cpu.flags.value;
    ctrl.raise(0x40);

    cpu.step();

    expect(ctrl.hasMaskable()).toBe(false);
    expect(cpu.regs.CS).toBe(0x100);
    expect(cpu.regs.IP).toBe(1);          // past the handler's HLT byte
    expect(cpu.halted).toBe(true);
    expect(cpu.flags.IF).toBe(false);
    expect(cpu.flags.TF).toBe(false);
    expect(cpu.flags.CF).toBe(true);      // unrelated flags survive
    expect(cpu.regs.SP).toBe(0x1000 - 6);
    // Stack growth: deepest is FLAGS (pushed first), then CS, then IP on top.
    expect(mem.readWord(linearAddress(0, 0x1000 - 2))).toBe(flagsBefore);
    expect(mem.readWord(linearAddress(0, 0x1000 - 4))).toBe(0);   // saved CS
    expect(mem.readWord(linearAddress(0, 0x1000 - 6))).toBe(0);   // saved IP (was 0)
  });
});

// ============================================================
// 2. Maskable, IF=0 — gated, no service
// ============================================================
describe('CPU does not service maskable when IF=0', () => {
  it('IF=0 → instruction runs normally; vector stays queued', () => {
    const { cpu, ctrl, mem } = setup();
    mem.writeByte(0, 0x90);               // NOP
    cpu.flags.IF = false;
    ctrl.raise(0x40);

    cpu.step();

    expect(cpu.regs.IP).toBe(1);
    expect(ctrl.hasMaskable()).toBe(true);
  });
});

// ============================================================
// 3. STI delayed enable — instruction after STI is inhibited
// ============================================================
describe('STI delayed-enable inhibit window', () => {
  it('STI; NOP; NOP — interrupt fires after the second NOP, not the first', () => {
    const { cpu, ctrl, mem } = setup();
    mem.writeByte(0, 0xFB); // STI
    mem.writeByte(1, 0x90); // inhibited slot
    mem.writeByte(2, 0x90); // first interruptible slot
    ivt(mem, 0x40, 0x100, 0);
    mem.writeByte(linearAddress(0x100, 0), 0xF4);

    cpu.flags.IF = false;
    ctrl.raise(0x40);

    // STI: IF was 0 at boundary check → no service. STI sets IF=1, inhibit=true.
    cpu.step();
    expect(cpu.flags.IF).toBe(true);
    expect(cpu.interruptInhibit).toBe(true);
    expect(cpu.regs.IP).toBe(1);

    // First post-STI: IF=1 but inhibit=true → no service. NOP runs. Inhibit clears.
    cpu.step();
    expect(cpu.regs.IP).toBe(2);
    expect(cpu.interruptInhibit).toBe(false);
    expect(ctrl.hasMaskable()).toBe(true);

    // Second post-STI: IF=1, !inhibit → service. Handler HLT runs.
    cpu.step();
    expect(cpu.regs.CS).toBe(0x100);
    expect(cpu.halted).toBe(true);
    expect(ctrl.hasMaskable()).toBe(false);
  });
});

// ============================================================
// 4. NMI bypasses IF
// ============================================================
describe('NMI bypasses IF', () => {
  it('IF=0 + NMI pending → still serviced via vector 2', () => {
    const { cpu, ctrl, mem } = setup();
    ivt(mem, 2, 0x100, 0);
    mem.writeByte(linearAddress(0x100, 0), 0xF4);
    cpu.flags.IF = false;
    ctrl.raiseNMI();

    cpu.step();

    expect(cpu.regs.CS).toBe(0x100);
    expect(cpu.halted).toBe(true);
    expect(ctrl.hasNMI()).toBe(false);
  });
});

// ============================================================
// 5. NMI takes priority over a pending maskable
// ============================================================
describe('NMI priority over maskable', () => {
  it('both pending → NMI services first, maskable stays queued', () => {
    const { cpu, ctrl, mem } = setup();
    ivt(mem, 2, 0x200, 0);
    ivt(mem, 0x40, 0x100, 0);
    mem.writeByte(linearAddress(0x200, 0), 0xF4); // NMI handler
    cpu.flags.IF = true;
    ctrl.raise(0x40);
    ctrl.raiseNMI();

    cpu.step();

    expect(cpu.regs.CS).toBe(0x200);
    expect(cpu.halted).toBe(true);
    expect(ctrl.hasNMI()).toBe(false);
    expect(ctrl.hasMaskable()).toBe(true); // maskable preserved for next round
  });
});

// ============================================================
// 6. POP SS inhibits exactly one instruction
// ============================================================
describe('POP SS inhibit window', () => {
  it('POP SS; NOP; NOP — interrupt suppressed for one instruction after POP SS', () => {
    const { cpu, ctrl, mem } = setup();
    // Place the SS-replacement word at SS:SP=0:0x1000 (writes 0, keeps SS=0).
    // Handler is at 0x200:0 = linear 0x2000 to avoid colliding with the
    // stack data at linear 0x1000.
    mem.writeWord(0x1000, 0x0000);
    mem.writeByte(0, 0x17); // POP SS
    mem.writeByte(1, 0x90); // inhibited
    mem.writeByte(2, 0x90); // first interruptible
    ivt(mem, 0x40, 0x200, 0);
    mem.writeByte(linearAddress(0x200, 0), 0xF4);

    cpu.flags.IF = true;

    // Step 1: POP SS runs (no pending yet, no service). Sets inhibit.
    cpu.step();
    expect(cpu.regs.SS).toBe(0);
    expect(cpu.regs.SP).toBe(0x1002);
    expect(cpu.interruptInhibit).toBe(true);

    // Raise AFTER POP SS — otherwise the boundary check on step 1 would
    // service the interrupt before POP SS even runs.
    ctrl.raise(0x40);

    // Step 2: pending+IF=1 but inhibit=true → no service. NOP runs.
    cpu.step();
    expect(cpu.regs.IP).toBe(2);
    expect(cpu.interruptInhibit).toBe(false);
    expect(ctrl.hasMaskable()).toBe(true);

    // Step 3: pending+IF=1+!inhibit → service.
    cpu.step();
    expect(cpu.regs.CS).toBe(0x200);
    expect(cpu.halted).toBe(true);
  });
});

// ============================================================
// 7. MOV SS,r/m inhibits exactly one instruction
// ============================================================
describe('MOV SS,r/m inhibit window', () => {
  it('MOV SS, AX; NOP; NOP — same shape as POP SS', () => {
    const { cpu, ctrl, mem } = setup();
    cpu.regs.AX = 0x0000;
    // 0x8E 0xD0  =  MOV SS, AX  (mod=11, reg=010 (SS), r/m=000 (AX))
    mem.writeByte(0, 0x8E);
    mem.writeByte(1, 0xD0);
    mem.writeByte(2, 0x90); // inhibited
    mem.writeByte(3, 0x90); // first interruptible
    ivt(mem, 0x40, 0x100, 0);
    mem.writeByte(linearAddress(0x100, 0), 0xF4);

    cpu.flags.IF = true;

    cpu.step();
    expect(cpu.interruptInhibit).toBe(true);
    expect(cpu.regs.IP).toBe(2);

    ctrl.raise(0x40);

    cpu.step();
    expect(cpu.interruptInhibit).toBe(false);
    expect(cpu.regs.IP).toBe(3);
    expect(ctrl.hasMaskable()).toBe(true);

    cpu.step();
    expect(cpu.regs.CS).toBe(0x100);
    expect(cpu.halted).toBe(true);
  });

  it('MOV ES, AX does NOT set the inhibit window', () => {
    const { cpu, mem } = setup();
    cpu.regs.AX = 0x1234;
    // 0x8E 0xC0  =  MOV ES, AX  (reg=000 → ES)
    mem.writeByte(0, 0x8E);
    mem.writeByte(1, 0xC0);
    cpu.step();
    expect(cpu.regs.ES).toBe(0x1234);
    expect(cpu.interruptInhibit).toBe(false);
  });
});

// ============================================================
// 8. STI; RET pattern — RET completes before pending interrupt fires
// ============================================================
describe('STI; RET delayed enable', () => {
  it('classic interrupt-handler tail: RET completes before service', () => {
    const { cpu, ctrl, mem } = setup();
    // Pre-push a return address (0x200) onto the stack
    cpu.regs.SP = 0x1000 - 2;
    mem.writeWord(0x1000 - 2, 0x0200);
    // 0:0 STI    0:1 RET    0:0x200 NOP (where RET lands)
    mem.writeByte(0, 0xFB);
    mem.writeByte(1, 0xC3);
    mem.writeByte(0x200, 0x90);
    ivt(mem, 0x40, 0x300, 0);
    mem.writeByte(linearAddress(0x300, 0), 0xF4);

    cpu.flags.IF = false;
    ctrl.raise(0x40);

    // Step 1: STI. Boundary: IF=0 → no service. STI sets IF=1 + inhibit.
    cpu.step();
    expect(cpu.flags.IF).toBe(true);
    expect(cpu.interruptInhibit).toBe(true);

    // Step 2: RET. Boundary: IF=1 but inhibit → no service. RET runs.
    cpu.step();
    expect(cpu.regs.IP).toBe(0x200);
    expect(cpu.regs.SP).toBe(0x1000);
    expect(cpu.interruptInhibit).toBe(false);
    expect(ctrl.hasMaskable()).toBe(true);

    // Step 3: Boundary: IF=1, !inhibit → service.
    cpu.step();
    expect(cpu.regs.CS).toBe(0x300);
    expect(cpu.halted).toBe(true);
  });
});

// ============================================================
// 9–11. HLT wake interactions — driven through the run loop
// ============================================================
describe('HLT wake', () => {
  // These exercise the wake decision in cpu.step() directly. (The run-loop's
  // halt-spin behaviour for real controllers is covered separately in
  // run-loop.test.ts; running it here would require stop() plumbing inside
  // each scenario for no extra coverage.)

  it('woken by a pending maskable when IF=1', () => {
    const { cpu, ctrl, mem } = setup();
    mem.writeByte(0, 0xF4);
    ivt(mem, 0x40, 0x100, 0);
    mem.writeByte(linearAddress(0x100, 0), 0xF4);
    cpu.flags.IF = true;

    // Step 1: HLT executes, halted=true.
    cpu.step();
    expect(cpu.halted).toBe(true);

    // Raise after the CPU is halted to exercise the wake path.
    ctrl.raise(0x40);

    // Step 2: boundary check sees pending+IF=1+!inhibit; halted=>false,
    // service runs, fetch+dispatch fires the handler's first byte (HLT).
    cpu.step();
    expect(cpu.regs.CS).toBe(0x100);
    expect(cpu.halted).toBe(true);
    expect(ctrl.hasMaskable()).toBe(false);
  });

  it('NOT woken by a maskable when IF=0', () => {
    const { cpu, ctrl, mem } = setup();
    mem.writeByte(0, 0xF4);
    cpu.flags.IF = false;

    cpu.step();
    expect(cpu.halted).toBe(true);

    ctrl.raise(0x40);

    // Boundary check on a halted CPU: maskable+IF=0+!inhibit → not servicable.
    // step() returns without doing anything. The vector stays queued.
    cpu.step();
    expect(cpu.halted).toBe(true);
    expect(ctrl.hasMaskable()).toBe(true);
    expect(cpu.regs.CS).toBe(0);                  // never left the original CS
  });

  it('woken by NMI even when IF=0', () => {
    const { cpu, ctrl, mem } = setup();
    mem.writeByte(0, 0xF4);
    ivt(mem, 2, 0x100, 0);
    mem.writeByte(linearAddress(0x100, 0), 0xF4);
    cpu.flags.IF = false;

    cpu.step();
    expect(cpu.halted).toBe(true);

    ctrl.raiseNMI();
    cpu.step();
    expect(cpu.regs.CS).toBe(0x100);
    expect(cpu.halted).toBe(true);
    expect(ctrl.hasNMI()).toBe(false);
  });
});

// ============================================================
// 13. TF interaction — service path clears TF; pushed flags retain it
// ============================================================
describe('TF and interrupt service', () => {
  it('service clears live TF; pushed FLAGS still has TF set', () => {
    const { cpu, ctrl, mem } = setup();
    ivt(mem, 0x40, 0x100, 0);
    mem.writeByte(linearAddress(0x100, 0), 0xF4);
    cpu.flags.IF = true;
    cpu.flags.TF = true;
    ctrl.raise(0x40);

    cpu.step();

    expect(cpu.flags.TF).toBe(false);
    // Pushed FLAGS lives at the deepest slot of the three pushes:
    // SP went from 0x1000 to 0x0FFA, FLAGS at 0x0FFE.
    const savedFlags = mem.readWord(linearAddress(0, cpu.regs.SP + 4));
    expect((savedFlags & FLAG.TF) !== 0).toBe(true);
    expect((savedFlags & FLAG.IF) !== 0).toBe(true);
  });
});

// ============================================================
// 14. No-controller default — backwards compatible
// ============================================================
describe('no-controller default', () => {
  it('CPU built without an explicit controller behaves as before', () => {
    const mem = new PagedMemory();
    mem.writeByte(0, 0x90); // NOP
    mem.writeByte(1, 0xF4); // HLT
    const cpu = new CPU8086(mem);
    cpu.reset();
    cpu.regs.CS = 0;
    cpu.regs.IP = 0;
    cpu.step();
    expect(cpu.regs.IP).toBe(1);
    cpu.step();
    expect(cpu.halted).toBe(true);
    expect(cpu.intCtrl.hasMaskable()).toBe(false);
    expect(cpu.intCtrl.hasNMI()).toBe(false);
  });
});
