/**
 * Phase 18 M1 — per-component serialize/restore pairs.
 *
 * Contract under test, for every pair:
 *
 *   1. Round-trip identity: serialize → restore into a FRESH instance →
 *      serialize again ≡ the original state (diffStates, plain loops).
 *   2. Mid-operation states survive: latches, flip-flops, half-written
 *      lohi divisors, mid-ICW init, mid-remote-DMA, pending multi-byte
 *      8042 commands. These are exactly where reset-plus-fixups breeds
 *      heisenbugs (brief §1.6 / D6).
 *   3. Restore fires NO callbacks: every IRQ edge that fired before
 *      capture already lives in the captured controller/PIC state.
 *   4. Restored instances CONTINUE identically to the original under
 *      the same subsequent operations.
 *
 * The whole-machine version of (4) over a real ELKS boot lives in
 * tests/integration/state-equivalence.test.ts — the harness the brief
 * declares LAW.
 */

import { describe, expect, it } from 'vitest';
import { CPU8086 } from '../../src/cpu8086/cpu.js';
import { BasicInterruptController } from '../../src/interrupts/controller.js';
import { PagedMemory } from '../../src/memory/paged-memory.js';
import { Clock } from '../../src/timing/clock.js';
import { PIC8259 } from '../../src/devices/pic.js';
import { PIT8254 } from '../../src/devices/pit.js';
import { UART16550, COM1_BASE } from '../../src/devices/uart-16550.js';
import { KeyboardController8042 } from '../../src/devices/keyboard-controller.js';
import { RTC146818 } from '../../src/devices/rtc.js';
import { NE2000, NE2K_BASE } from '../../src/devices/ne2000.js';
import { EthernetSwitch } from '../../src/net/switch.js';
import { LanGateway, GATEWAY_IP } from '../../src/net/gateway.js';
import { DnsHost, DNS_IP } from '../../src/net/dns.js';
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  MAC_BROADCAST,
  buildArp,
  buildEthernetFrame,
} from '../../src/net/wire.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import {
  captureMachineState,
  restoreMachineState,
} from '../../src/machine/machine-state.js';
import { diffStates } from '../state-diff.js';

function expectNoDiff(a: unknown, b: unknown): void {
  expect(diffStates(a, b)).toEqual([]);
}

// ============================================================
// PagedMemory
// ============================================================

describe('PagedMemory state plane', () => {
  it('round-trips resident RAM pages and excludes ROM', () => {
    const mem = new PagedMemory();
    mem.writeByte(0x1234, 0xAB);
    mem.writeByte(0x8FFF, 0xCD);
    mem.loadROM(0xF0000, new Uint8Array(4096).fill(0x90));

    const state = mem.serializeState();
    expect(state.pages.map((p) => p.pageId)).toEqual([0x1, 0x8]);

    const fresh = new PagedMemory();
    fresh.restoreState(state);
    expect(fresh.readByte(0x1234)).toBe(0xAB);
    expect(fresh.readByte(0x8FFF)).toBe(0xCD);
    expectNoDiff(fresh.serializeState(), state);
  });

  it('restore drops resident RAM pages absent from the snapshot', () => {
    const source = new PagedMemory();
    source.writeByte(0x1000, 0x11);
    const state = source.serializeState();

    const target = new PagedMemory();
    target.writeByte(0x1000, 0x99);   // will be overwritten
    target.writeByte(0x50000, 0x77);  // stale — must read as 0 post-restore
    target.restoreState(state);
    // Resident-set identity holds immediately after restore (reads
    // re-materialise zero pages by design, so compare BEFORE reading).
    expectNoDiff(target.serializeState(), state);
    expect(target.readByte(0x1000)).toBe(0x11);
    expect(target.readByte(0x50000)).toBe(0x00);
  });

  it('restore marks restored pages dirty (a store must see the change)', () => {
    const source = new PagedMemory();
    source.writeByte(0x2000, 0x42);
    const target = new PagedMemory();
    target.restoreState(source.serializeState());
    expect(Array.from(target.dirtyPages())).toContain(0x2);
  });

  it('refuses pageSize mismatches and RAM-over-ROM collisions', () => {
    const source = new PagedMemory();
    source.writeByte(0xF0000, 0x01); // page 0xF0 as RAM
    const state = source.serializeState();

    const other = new PagedMemory({ pageSize: 8192 });
    expect(() => other.restoreState(state)).toThrow(/pageSize mismatch/);

    const romTarget = new PagedMemory();
    romTarget.loadROM(0xF0000, new Uint8Array(4096).fill(0x90));
    expect(() => romTarget.restoreState(state)).toThrow(/ROM here but RAM/);
  });

  it('getPageBytes copies; null for never-materialised pages', () => {
    const mem = new PagedMemory();
    mem.writeByte(0x3000, 0x55);
    const bytes = mem.getPageBytes(0x3);
    expect(bytes?.[0]).toBe(0x55);
    bytes![0] = 0x00;
    expect(mem.readByte(0x3000)).toBe(0x55); // copy, not alias
    expect(mem.getPageBytes(0x99)).toBeNull();
  });
});

// ============================================================
// Clock
// ============================================================

describe('Clock.restoreCycles', () => {
  it('restores the counter silently — no subscriber notification', () => {
    const clock = new Clock();
    let notified = 0;
    clock.subscribe({ onAdvance: () => { notified++; } });
    clock.restoreCycles(123_456);
    expect(clock.now()).toBe(123_456);
    expect(notified).toBe(0);
  });

  it('rejects negative and non-integer values', () => {
    const clock = new Clock();
    expect(() => clock.restoreCycles(-1)).toThrow();
    expect(() => clock.restoreCycles(1.5)).toThrow();
  });
});

// ============================================================
// CPU snapshot — the interruptInhibit fix
// ============================================================

describe('CPUSnapshot interruptInhibit (the 13-phase gap)', () => {
  it('carries and restores the inhibit window', () => {
    const cpu = new CPU8086(new PagedMemory());
    cpu.interruptInhibit = true;
    const snap = cpu.snapshot();
    expect(snap.interruptInhibit).toBe(true);

    const fresh = new CPU8086(new PagedMemory());
    fresh.restore(snap);
    expect(fresh.interruptInhibit).toBe(true);
  });

  it('a restored inhibit window suppresses the next boundary check', () => {
    // STI-shadow semantics across a snapshot: an interrupt pending at
    // restore time must NOT be serviced on the first step when the
    // captured machine had the window set.
    const program = [0x90, 0x90]; // NOP; NOP
    const mem = new PagedMemory();
    program.forEach((b, i) => mem.writeByte(0x100 + i, b));
    const ctrl = new BasicInterruptController();
    const cpu = new CPU8086(mem, undefined, ctrl);
    cpu.regs.CS = 0; cpu.regs.IP = 0x100;
    cpu.flags.IF = true;
    cpu.interruptInhibit = true;
    ctrl.raise(0x20);
    // IVT[0x20] = 0000:0200, handler = HLT
    mem.writeWord(0x20 * 4, 0x200);
    mem.writeWord(0x20 * 4 + 2, 0);
    mem.writeByte(0x200, 0xF4);

    const fresh = new CPU8086(mem, undefined, ctrl);
    fresh.restore(cpu.snapshot());
    fresh.step(); // inhibited: runs the NOP, does NOT service
    expect(fresh.regs.IP).toBe(0x101);
    fresh.step(); // window expired: services INT 0x20 → handler HLT
    expect(fresh.regs.IP).toBe(0x201);
  });
});

// ============================================================
// BasicInterruptController
// ============================================================

describe('BasicInterruptController state plane', () => {
  it('round-trips the FIFO and nmiPending, preserving order', () => {
    const src = new BasicInterruptController();
    src.raise(8); src.raise(9); src.raise(8);
    src.raiseNMI();
    const state = src.serializeState();

    const dst = new BasicInterruptController();
    dst.restoreState(state);
    expectNoDiff(dst.serializeState(), state);
    expect(dst.consumeNMI()).toBe(true);
    expect(dst.consumeMaskable()).toBe(8);
    expect(dst.consumeMaskable()).toBe(9);
    expect(dst.consumeMaskable()).toBe(8);
    expect(dst.hasMaskable()).toBe(false);
  });
});

// ============================================================
// PIC8259
// ============================================================

describe('PIC8259 state plane', () => {
  it('round-trips a fully programmed chip with pending + in-service IRQs', () => {
    const ctrl = new BasicInterruptController();
    const pic = new PIC8259(ctrl);
    pic.writeByte(0x20, 0x13); // ICW1: single PIC (no ICW3), ICW4 follows
    pic.writeByte(0x21, 0x20); // ICW2: base 0x20
    pic.writeByte(0x21, 0x01); // ICW4: 8086 mode
    pic.writeByte(0x21, 0x00); // OCW1: unmask all
    pic.assertIRQ(0);          // forwarded: IRR → ISR, vector 0x20 raised to ctrl
    pic.assertIRQ(3);          // stays in IRR — lower priority than in-service IRQ 0
    const state = pic.serializeState();

    const freshCtrl = new BasicInterruptController();
    const fresh = new PIC8259(freshCtrl);
    fresh.restoreState(state);
    expectNoDiff(fresh.serializeState(), state);
    // Restore must not have forwarded anything to the fresh controller.
    expect(freshCtrl.hasMaskable()).toBe(false);

    // Identical subsequent behaviour: EOI on both → IRQ 3 forwards.
    pic.writeByte(0x20, 0x20);
    fresh.writeByte(0x20, 0x20);
    expectNoDiff(fresh.serializeState(), pic.serializeState());
    expect(freshCtrl.consumeMaskable()).toBe(0x23);
  });

  it('captures mid-ICW init state', () => {
    const pic = new PIC8259(new BasicInterruptController());
    pic.writeByte(0x20, 0x11); // ICW1 — now awaiting ICW2
    const state = pic.serializeState();
    expect(state.initState).toBe('awaitingIcw2');

    const fresh = new PIC8259(new BasicInterruptController());
    fresh.restoreState(state);
    fresh.writeByte(0x21, 0x40); // completes as ICW2, not OCW1
    expect(fresh.getVectorBase()).toBe(0x40);
  });
});

// ============================================================
// PIT8254
// ============================================================

describe('PIT8254 state plane', () => {
  function programmedPit(): { pit: PIT8254; clock: Clock; edges: { n: number } } {
    const clock = new Clock();
    const edges = { n: 0 };
    const pit = new PIT8254(clock, {
      cyclesPerPitTick: 1,
      onChannel0RisingEdge: () => { edges.n++; },
    });
    pit.writeByte(0x43, 0x34); // ch0, lohi, mode 2
    pit.writeByte(0x40, 100);  // divisor lo
    pit.writeByte(0x40, 0);    // divisor hi → 100
    clock.advance(37);         // counter 63
    pit.writeByte(0x43, 0xE2); // read-back: latch STATUS for ch0
    pit.writeByte(0x40, 50);   // lo byte of a new divisor — flip-flop half-open
    return { pit, clock, edges };
  }

  it('round-trips latches, flip-flops, and the half-written divisor', () => {
    const { pit } = programmedPit();
    const state = pit.serializeState();
    expect(state.channels[0].latchedStatus).not.toBeNull();
    expect(state.channels[0].writeFlipflop).toBe('awaitingHigh');
    expect(state.channels[0].pendingDivisorLow).toBe(50);
    expect(state.channels[0].counter).toBe(63);

    const fresh = new PIT8254(new Clock(), { cyclesPerPitTick: 1 });
    fresh.restoreState(state);
    expectNoDiff(fresh.serializeState(), state);
  });

  it('restored PIT continues counting identically (edges included)', () => {
    const { pit, clock, edges } = programmedPit();
    const state = pit.serializeState();

    const freshClock = new Clock();
    const freshEdges = { n: 0 };
    const fresh = new PIT8254(freshClock, {
      cyclesPerPitTick: 1,
      onChannel0RisingEdge: () => { freshEdges.n++; },
    });
    fresh.restoreState(state);

    const edgesBefore = edges.n;
    clock.advance(200);
    freshClock.advance(200);
    expect(freshEdges.n).toBe(edges.n - edgesBefore);
    expectNoDiff(fresh.serializeState(), pit.serializeState());

    // Reads drain the status latch then stream the live count identically.
    for (let i = 0; i < 5; i++) {
      expect(fresh.readByte(0x40)).toBe(pit.readByte(0x40));
    }
    expectNoDiff(fresh.serializeState(), pit.serializeState());
  });
});

// ============================================================
// UART16550
// ============================================================

describe('UART16550 state plane', () => {
  it('round-trips FIFO + IRQ engine; restore fires no IRQ edge', () => {
    let srcEdges = 0;
    const src = new UART16550({ onIRQ4: () => { srcEdges++; } });
    src.writeByte(COM1_BASE + 2, 0x01); // FCR: enable FIFO
    src.writeByte(COM1_BASE + 1, 0x01); // IER: RDI
    src.injectBytes([0x41, 0x42, 0x43]); // edge fires once
    src.writeByte(COM1_BASE + 7, 0x5A); // scratch
    expect(srcEdges).toBe(1);
    const state = src.serializeState();
    expect(state.rxFifo).toEqual([0x41, 0x42, 0x43]);
    expect(state.irqPending).toBe(true);

    let freshEdges = 0;
    const fresh = new UART16550({ onIRQ4: () => { freshEdges++; } });
    fresh.restoreState(state);
    expect(freshEdges).toBe(0); // the captured edge is the PIC's memory, not ours
    expectNoDiff(fresh.serializeState(), state);

    // Subsequent reads behave identically on both.
    for (let i = 0; i < 3; i++) {
      expect(fresh.readByte(COM1_BASE + 5)).toBe(src.readByte(COM1_BASE + 5)); // LSR
      expect(fresh.readByte(COM1_BASE)).toBe(src.readByte(COM1_BASE));         // RBR
    }
    expectNoDiff(fresh.serializeState(), src.serializeState());
  });

  it('carries the one-shot thriArmed latch', () => {
    const src = new UART16550();
    src.writeByte(COM1_BASE + 1, 0x02); // IER: THRI — arms the one-shot
    const state = src.serializeState();
    expect(state.thriArmed).toBe(true);
    expect(state.irqPending).toBe(true);

    const fresh = new UART16550();
    fresh.restoreState(state);
    // IIR read reports THRI then clears the latch, exactly like the source.
    expect(fresh.readByte(COM1_BASE + 2)).toBe(src.readByte(COM1_BASE + 2));
    expectNoDiff(fresh.serializeState(), src.serializeState());
  });
});

// ============================================================
// KeyboardController8042
// ============================================================

describe('KeyboardController8042 state plane', () => {
  it('round-trips mid-command state and the scancode queue; no IRQ on restore', () => {
    let srcIrqs = 0;
    const src = new KeyboardController8042({ onIRQ1: () => { srcIrqs++; } });
    src.injectScancodes([0x1E, 0x9E]); // first fills OBF (IRQ), second queues
    src.writeByte(0x64, 0xD1);         // next data write is the output port
    expect(srcIrqs).toBe(1);
    const state = src.serializeState();
    expect(state.nextDataWriteIs).toBe('outputPort');
    expect(state.outputBufferFull).toBe(true);
    expect(state.scancodeQueue).toEqual([0x9E]);

    let freshIrqs = 0;
    const fresh = new KeyboardController8042({ onIRQ1: () => { freshIrqs++; } });
    fresh.restoreState(state);
    expect(freshIrqs).toBe(0);
    expectNoDiff(fresh.serializeState(), state);

    // The pending 0xD1 completes identically: data byte lands in P2.
    src.writeByte(0x60, 0xDD);
    fresh.writeByte(0x60, 0xDD);
    expect(fresh.outputPort).toBe(0xDD);
    expect(fresh.a20Enabled).toBe(src.a20Enabled);

    // Draining the OBF promotes the queued scancode on both (IRQ 1 each).
    expect(fresh.readByte(0x60)).toBe(src.readByte(0x60));
    expect(freshIrqs).toBe(1);
    expectNoDiff(fresh.serializeState(), src.serializeState());
  });
});

// ============================================================
// RTC146818
// ============================================================

describe('RTC146818 state plane', () => {
  it('round-trips index + CMOS scratch; time stays wall-served', () => {
    const hostClock = new InMemoryHostClock();
    const src = new RTC146818(hostClock);
    src.writeByte(0x70, 0x20);
    src.writeByte(0x71, 0x99); // scratch write
    src.writeByte(0x70, 0x00); // index parked on seconds
    const state = src.serializeState();

    const fresh = new RTC146818(hostClock);
    fresh.restoreState(state);
    expectNoDiff(fresh.serializeState(), state);
    // Scratch readable where we left it; time registers still live.
    fresh.writeByte(0x70, 0x20);
    expect(fresh.readByte(0x71)).toBe(0x99);
    fresh.writeByte(0x70, 0x00);
    expect(fresh.readByte(0x71)).toBe(0x00); // seconds=0 in BCD at the fixed test time
  });
});

// ============================================================
// NE2000
// ============================================================

describe('NE2000 state plane', () => {
  function receivingNic(): { nic: NE2000; edges: { n: number } } {
    const edges = { n: 0 };
    const nic = new NE2000({ onIRQ: () => { edges.n++; } });
    nic.writeByte(NE2K_BASE, 0x22);        // STA, page 0
    nic.writeByte(NE2K_BASE + 0x01, 0x46); // PSTART
    nic.writeByte(NE2K_BASE + 0x02, 0x60); // PSTOP
    nic.writeByte(NE2K_BASE + 0x03, 0x46); // BNRY
    nic.writeByte(NE2K_BASE + 0x0f, 0x01); // IMR: PRX
    nic.writeByte(NE2K_BASE, 0x62);        // page 1
    nic.writeByte(NE2K_BASE + 0x07, 0x47); // CURR
    nic.writeByte(NE2K_BASE, 0x22);        // page 0
    const frame = new Uint8Array(60);
    for (let i = 0; i < frame.length; i++) frame[i] = i & 0xff;
    expect(nic.injectFrame(frame)).toBe(true);
    // Start a remote-DMA read of the packet and consume 8 of 20 bytes.
    nic.writeByte(NE2K_BASE + 0x08, 0x00); // RSAR0
    nic.writeByte(NE2K_BASE + 0x09, 0x47); // RSAR1
    nic.writeByte(NE2K_BASE + 0x0a, 20);   // RBCR0
    nic.writeByte(NE2K_BASE + 0x0b, 0);    // RBCR1
    nic.writeByte(NE2K_BASE, 0x0A);        // CR: remote read + STA
    for (let i = 0; i < 8; i++) nic.readByte(NE2K_BASE + 0x10);
    return { nic, edges };
  }

  it('round-trips the ring, PROM, and the mid-flight remote-DMA engine', () => {
    const { nic, edges } = receivingNic();
    expect(edges.n).toBe(1); // PRX edge at inject
    const state = nic.serializeState();
    expect(state.remoteMode).toBe('read');
    expect(state.dmaRemaining).toBe(12);
    expect(state.irqLevel).toBe(true);

    const freshEdges = { n: 0 };
    const fresh = new NE2000({ onIRQ: () => { freshEdges.n++; } });
    fresh.restoreState(state);
    expect(freshEdges.n).toBe(0);
    expectNoDiff(fresh.serializeState(), state);

    // The interrupted DMA read completes identically on both.
    for (let i = 0; i < 12; i++) {
      expect(fresh.readByte(NE2K_BASE + 0x10)).toBe(nic.readByte(NE2K_BASE + 0x10));
    }
    expectNoDiff(fresh.serializeState(), nic.serializeState());
    // RDC latched on both, no fresh edge (IMR only unmasks PRX).
    expect(fresh.readByte(NE2K_BASE + 0x07) & 0x40).toBe(0x40);
    expect(freshEdges.n).toBe(0);
  });

  it('a restored NIC keeps receiving into the same ring', () => {
    const { nic } = receivingNic();
    const fresh = new NE2000({});
    fresh.restoreState(nic.serializeState());
    const frame = new Uint8Array(60).fill(0x77);
    expect(nic.injectFrame(frame)).toBe(true);
    expect(fresh.injectFrame(frame)).toBe(true);
    expectNoDiff(fresh.serializeState(), nic.serializeState());
  });
});

// ============================================================
// EthernetSwitch CAM
// ============================================================

describe('EthernetSwitch state plane', () => {
  const MAC_A = [0x02, 0, 0, 0, 0, 0x0a];
  const MAC_B = [0x02, 0, 0, 0, 0, 0x0b];

  function frame(dst: readonly number[], src: readonly number[]): Uint8Array {
    const f = new Uint8Array(20);
    f.set(dst, 0);
    f.set(src, 6);
    return f;
  }

  it('restores the CAM against same-named ports — unicast without flooding', () => {
    const sw = new EthernetSwitch();
    const portA = sw.attach({ name: 'a', onFrame: () => { /* sink */ } });
    sw.attach({ name: 'b', onFrame: () => { /* sink */ } });
    // Learn A's MAC by transmitting FROM a.
    portA.transmit(frame(MAC_B, MAC_A));
    const state = sw.serializeState();
    expect(state.cam).toEqual([[['02', '00', '00', '00', '00', '0a'].join(''), 'a']]);

    const sw2 = new EthernetSwitch();
    const seenA2: Uint8Array[] = [];
    const seenC2: Uint8Array[] = [];
    sw2.attach({ name: 'a', onFrame: (f) => seenA2.push(f) });
    const b2 = sw2.attach({ name: 'b', onFrame: () => { /* sink */ } });
    sw2.attach({ name: 'c', onFrame: (f) => seenC2.push(f) });
    sw2.restoreState(state);

    b2.transmit(frame(MAC_A, MAC_B));
    expect(seenA2.length).toBe(1); // learned unicast — delivered
    expect(seenC2.length).toBe(0); // NOT flooded
  });

  it('fails loud when a CAM entry names a missing port', () => {
    const sw = new EthernetSwitch();
    const port = sw.attach({ name: 'ne2000', onFrame: () => { /* sink */ } });
    port.transmit(frame(MAC_B, MAC_A));
    const state = sw.serializeState();

    const sw2 = new EthernetSwitch();
    sw2.attach({ name: 'gateway', onFrame: () => { /* sink */ } });
    expect(() => sw2.restoreState(state)).toThrow(/no attached port named 'ne2000'/);
  });
});

// ============================================================
// LanGateway + DnsHost ARP tables
// ============================================================

describe('LanGateway / DnsHost state plane', () => {
  const GUEST_MAC = [0x02, 0x65, 0x6d, 0x75, 0x38, 0x36];
  const GUEST_IP = [10, 0, 2, 15];

  function arpWhoHas(targetIp: readonly number[]): Uint8Array {
    return buildEthernetFrame(
      MAC_BROADCAST,
      GUEST_MAC,
      ETHERTYPE_ARP,
      buildArp(ARP_OP_REQUEST, GUEST_MAC, GUEST_IP, [0, 0, 0, 0, 0, 0], targetIp),
    );
  }

  it('gateway round-trips its ARP table, ipId, and counters', () => {
    const lan = new EthernetSwitch();
    const gw = new LanGateway();
    gw.attachTo(lan);
    const guest = lan.attach({ name: 'guest', onFrame: () => { /* sink */ } });
    guest.transmit(arpWhoHas(GATEWAY_IP));
    expect(gw.arpRepliesSent).toBe(1);
    const state = gw.serializeState();
    expect(state.arpTable).toEqual([['10.0.2.15', GUEST_MAC]]);

    const fresh = new LanGateway();
    fresh.restoreState(state);
    expectNoDiff(fresh.serializeState(), state);
    expect(fresh.arpTable.get('10.0.2.15')).toEqual(GUEST_MAC);
  });

  it('dns host round-trips its ARP table and counters', () => {
    const lan = new EthernetSwitch();
    const dns = new DnsHost({ resolve: async () => new Uint8Array(12) });
    dns.attachTo(lan);
    const guest = lan.attach({ name: 'guest', onFrame: () => { /* sink */ } });
    guest.transmit(arpWhoHas(DNS_IP));
    const state = dns.serializeState();
    expect(state.arpTable).toEqual([['10.0.2.15', GUEST_MAC]]);

    const fresh = new DnsHost({ resolve: async () => new Uint8Array(12) });
    fresh.restoreState(state);
    expectNoDiff(fresh.serializeState(), state);
  });
});

// ============================================================
// Whole-machine compose
// ============================================================

describe('captureMachineState / restoreMachineState', () => {
  function makeMachine(): IBMPCMachine {
    return new IBMPCMachine({
      console: new InMemoryConsole(),
      hostClock: new InMemoryHostClock(),
      cyclesPerPitTick: 1,
    });
  }

  /** inc ax; mov [0x9000],ax; jmp back — touches regs, RAM, and time. */
  const PROGRAM = [0xB8, 0x00, 0x00, 0x40, 0xA3, 0x00, 0x90, 0xEB, 0xFA];

  function stepN(m: IBMPCMachine, n: number): void {
    for (let i = 0; i < n; i++) {
      m.cpu.step();
      m.clock.advance(1);
    }
  }

  it('restore into a fresh machine is state-identical and stays identical', () => {
    const a = makeMachine();
    a.reset();
    a.loadProgram(PROGRAM, 0x8000);
    a.setEntryPoint(0, 0x8000);
    stepN(a, 50);
    const state = captureMachineState(a);

    const b = makeMachine();
    restoreMachineState(b, state);
    expect(diffStates(captureMachineState(b), state)).toEqual([]);

    stepN(a, 50);
    stepN(b, 50);
    expect(diffStates(captureMachineState(b), captureMachineState(a))).toEqual([]);
    expect(b.memory.readWord(0x9000)).toBe(a.memory.readWord(0x9000));
  });

  it('refuses an RTC-posture mismatch', () => {
    const withBios = makeMachine();
    withBios.reset();
    const state = captureMachineState(withBios);

    const noBios = new IBMPCMachine({ loadBios: false });
    expect(() => restoreMachineState(noBios, state)).toThrow(/RTC/);
  });
});
