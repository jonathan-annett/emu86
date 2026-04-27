import { beforeEach, describe, expect, it } from 'vitest';
import { UART16550 } from '../../src/devices/uart-16550.js';

/**
 * Unit tests for the 16550A UART.
 *
 * The shape mirrors `tests/unit/keyboard-controller.test.ts`: a setup
 * factory captures TX bytes and IRQ4 events, individual cases drive
 * port reads/writes through the device's `readByte` / `writeByte`
 * methods (the same surface the IOBus would use).
 *
 * The cases focus on the behaviours ELKS's serial driver actually
 * exercises: probe (IER round-trip + FCR + IIR + SCR), open (FCR
 * enable, IER enable, MCR), and runtime (RX FIFO drain via IRQ
 * handler, DLAB-gated divisor latch). Each block of tests cites the
 * corresponding ELKS source location to make the link traceable.
 */

const COM1 = 0x3F8;
const RBR = COM1 + 0; // DLAB=0
const THR = COM1 + 0;
const DLL = COM1 + 0; // DLAB=1
const IER = COM1 + 1; // DLAB=0
const DLM = COM1 + 1; // DLAB=1
const IIR = COM1 + 2; // read
const FCR = COM1 + 2; // write
const LCR = COM1 + 3;
const MCR = COM1 + 4;
const LSR = COM1 + 5;
const MSR = COM1 + 6;
const SCR = COM1 + 7;

const LCR_DLAB = 0x80;
const LCR_WLEN8 = 0x03;

interface Setup {
  uart: UART16550;
  /** Bytes the guest transmitted (THR writes when not in loopback). */
  tx: number[];
  /** Number of times `onIRQ4` fired. */
  irqCount: { n: number };
  warnings: string[];
}

function setup(): Setup {
  const tx: number[] = [];
  const irqCount = { n: 0 };
  const warnings: string[] = [];
  const uart = new UART16550({
    onTransmit: (b) => tx.push(b),
    onIRQ4: () => { irqCount.n++; },
    warn: (m) => warnings.push(m),
  });
  return { uart, tx, irqCount, warnings };
}

// ============================================================
// Reset state
// ============================================================

describe('UART16550 reset state', () => {
  it('all registers are 0 at construction; FIFO disabled; DLAB=0', () => {
    const { uart } = setup();
    expect(uart.readByte(IER)).toBe(0);
    expect(uart.readByte(LCR)).toBe(0);
    expect(uart.readByte(MCR)).toBe(0);
    expect(uart.readByte(SCR)).toBe(0);
    // LSR THRE+TEMT permanently asserted (we never block on TX).
    expect(uart.readByte(LSR)).toBe(0x60);
    // MSR: peer happy and present (CTS+DSR+DCD), no delta bits.
    expect(uart.readByte(MSR)).toBe(0xB0);
    expect(uart.inspect().fifoEnabled).toBe(false);
    expect(uart.inspect().dlab).toBe(false);
  });

  it('reset() restores construction state after writes', () => {
    const { uart } = setup();
    uart.writeByte(LCR, LCR_DLAB | LCR_WLEN8);
    uart.writeByte(IER, 0x01);
    uart.writeByte(SCR, 0xAA);
    uart.writeByte(FCR, 0x01); // enable FIFO
    uart.injectByte(0x42);
    uart.reset();
    expect(uart.readByte(IER)).toBe(0);
    expect(uart.readByte(LCR)).toBe(0);
    expect(uart.readByte(SCR)).toBe(0);
    expect(uart.inspect().fifoEnabled).toBe(false);
    expect(uart.pendingRxCount).toBe(0);
  });
});

// ============================================================
// Scratch register — ELKS probe writes 0x2A and reads back
// (`serial-8250.c:132` rs_probe).
// ============================================================

describe('Scratch register (SCR)', () => {
  it('round-trips a byte (ELKS probe writes 0x2A, expects 0x2A back)', () => {
    const { uart } = setup();
    uart.writeByte(SCR, 0x2A);
    expect(uart.readByte(SCR)).toBe(0x2A);
  });

  it('subsequent writes overwrite the stored value', () => {
    const { uart } = setup();
    uart.writeByte(SCR, 0xFF);
    uart.writeByte(SCR, 0x00);
    expect(uart.readByte(SCR)).toBe(0x00);
  });
});

// ============================================================
// IER probe — `serial-8250.c:111-116` rs_probe
//
// The probe reads IER, writes 0, reads IER, expects 0. If the read-back
// is non-zero, the UART is declared absent. Then the original IER is
// restored.
// ============================================================

describe('IER probe (rs_probe in ELKS)', () => {
  it('writing 0 to IER and reading back yields 0 (passes ELKS probe)', () => {
    const { uart } = setup();
    uart.writeByte(IER, 0);
    expect(uart.readByte(IER)).toBe(0);
  });

  it('writing arbitrary values to IER round-trips through bits 0..3', () => {
    const { uart } = setup();
    uart.writeByte(IER, 0x0F);
    expect(uart.readByte(IER)).toBe(0x0F);
  });
});

// ============================================================
// FCR / IIR — FIFO probe and identification
//
// `serial-8250.c:118-129` rs_probe writes 0xE7 to FCR (enable FIFO,
// 14-byte trigger, ...). It then reads IIR. For 16550A: bit 7 set
// (FIFO available) and bit 6 set (16-byte FIFO functional).
// ============================================================

describe('FCR + IIR — 16550A identification', () => {
  it('after FIFO enable (FCR bit 0 = 1), IIR bits 7..6 = 11 (16550A signature)', () => {
    const { uart } = setup();
    uart.writeByte(FCR, 0xE7); // ELKS's probe value
    const iir = uart.readByte(IIR);
    expect(iir & 0xC0).toBe(0xC0); // FIFO enabled (16550A)
    expect(iir & 0x20).toBe(0);    // not 16750 (no 64-byte FIFO)
  });

  it('with FIFO disabled, IIR bits 7..6 = 00', () => {
    const { uart } = setup();
    uart.writeByte(FCR, 0x06); // clear RX/TX FIFOs, FIFO disabled
    expect(uart.readByte(IIR) & 0xC0).toBe(0);
  });

  it('FCR clear-RCVR bit empties the RX FIFO without disabling FIFO mode', () => {
    const { uart } = setup();
    uart.writeByte(FCR, 0x01); // enable FIFO
    uart.injectBytes([0x41, 0x42, 0x43]);
    expect(uart.pendingRxCount).toBe(3);
    uart.writeByte(FCR, 0x01 | 0x02); // FIFO + clear RCVR
    expect(uart.pendingRxCount).toBe(0);
    expect(uart.inspect().fifoEnabled).toBe(true);
  });
});

// ============================================================
// DLAB switching
// ============================================================

describe('DLAB-gated divisor latch', () => {
  it('with DLAB=1, reads/writes at base+0/+1 hit DLL/DLM', () => {
    const { uart } = setup();
    uart.writeByte(LCR, LCR_DLAB | LCR_WLEN8);
    uart.writeByte(DLL, 0x0C); // 9600 baud divisor low
    uart.writeByte(DLM, 0x00);
    expect(uart.readByte(DLL)).toBe(0x0C);
    expect(uart.readByte(DLM)).toBe(0x00);
    expect(uart.inspect().divisor).toBe(0x000C);
  });

  it('writing to DLL/DLM under DLAB=1 does not disturb RBR/THR', () => {
    const { uart, tx } = setup();
    uart.injectByte(0x55);
    uart.writeByte(LCR, LCR_DLAB | LCR_WLEN8); // DLAB=1
    uart.writeByte(DLL, 0xAA);
    uart.writeByte(DLM, 0xBB);
    uart.writeByte(LCR, LCR_WLEN8); // DLAB=0
    // RBR still has the queued byte
    expect(uart.readByte(RBR)).toBe(0x55);
    // THR sends without picking up DLL/DLM
    uart.writeByte(THR, 0x33);
    expect(tx).toEqual([0x33]);
  });

  it('with DLAB=0, reads at base+0 drain RBR (not DLL)', () => {
    const { uart } = setup();
    uart.writeByte(LCR, LCR_DLAB | LCR_WLEN8);
    uart.writeByte(DLL, 0x77);
    uart.writeByte(LCR, LCR_WLEN8); // DLAB=0
    uart.injectByte(0x44);
    expect(uart.readByte(RBR)).toBe(0x44); // RBR, not 0x77
  });
});

// ============================================================
// TX path
// ============================================================

describe('Transmit path (THR write)', () => {
  it('writing THR fires onTransmit exactly once with the byte', () => {
    const { uart, tx } = setup();
    uart.writeByte(THR, 0x48); // 'H'
    uart.writeByte(THR, 0x69); // 'i'
    expect(tx).toEqual([0x48, 0x69]);
  });

  it('LSR.THRE and LSR.TEMT are permanently 1 (we never block TX)', () => {
    const { uart } = setup();
    expect(uart.readByte(LSR) & 0x60).toBe(0x60);
    uart.writeByte(THR, 0x00);
    expect(uart.readByte(LSR) & 0x60).toBe(0x60);
  });
});

// ============================================================
// RX path + LSR.DR
// ============================================================

describe('Receive path (injectByte / RBR read)', () => {
  it('after injectByte(0x41), LSR.DR = 1 and RBR returns 0x41', () => {
    const { uart } = setup();
    uart.injectByte(0x41);
    expect(uart.readByte(LSR) & 0x01).toBe(0x01);
    expect(uart.readByte(RBR)).toBe(0x41);
  });

  it('reading RBR drains one byte and clears DR if FIFO empties', () => {
    const { uart } = setup();
    uart.injectByte(0x41);
    uart.readByte(RBR);
    expect(uart.readByte(LSR) & 0x01).toBe(0);
  });

  it('with FIFO enabled, multiple bytes queue and drain in order', () => {
    const { uart } = setup();
    uart.writeByte(FCR, 0x01); // enable FIFO
    uart.injectBytes([0x41, 0x42, 0x43]);
    expect(uart.readByte(RBR)).toBe(0x41);
    expect(uart.readByte(RBR)).toBe(0x42);
    expect(uart.readByte(RBR)).toBe(0x43);
    expect(uart.readByte(LSR) & 0x01).toBe(0);
  });

  it('with FIFO disabled, second injection overruns; LSR.OE latches', () => {
    const { uart } = setup();
    uart.injectByte(0x41);
    uart.injectByte(0x42); // overrun (1-byte holding)
    const lsr = uart.readByte(LSR);
    expect(lsr & 0x01).toBe(0x01); // DR set
    expect(lsr & 0x02).toBe(0x02); // OE set
    // After LSR read, OE should clear
    expect(uart.readByte(LSR) & 0x02).toBe(0);
  });
});

// ============================================================
// IRQ 4 firing
// ============================================================

describe('IRQ 4 (RX data available)', () => {
  it('with IER.RDI=0, RX byte arrival does not raise IRQ', () => {
    const { uart, irqCount } = setup();
    uart.injectByte(0x41);
    expect(irqCount.n).toBe(0);
  });

  it('with IER.RDI=1, RX byte arrival raises IRQ once', () => {
    const { uart, irqCount } = setup();
    uart.writeByte(IER, 0x01); // enable RDI
    uart.injectByte(0x41);
    expect(irqCount.n).toBe(1);
  });

  it('subsequent injections while IRQ already pending do not re-fire', () => {
    const { uart, irqCount } = setup();
    uart.writeByte(FCR, 0x01); // FIFO on
    uart.writeByte(IER, 0x01); // enable RDI
    uart.injectByte(0x41);
    uart.injectByte(0x42);
    uart.injectByte(0x43);
    expect(irqCount.n).toBe(1);
  });

  it('drain via RBR then new arrival re-fires IRQ', () => {
    const { uart, irqCount } = setup();
    uart.writeByte(IER, 0x01);
    uart.injectByte(0x41);
    uart.readByte(RBR); // drain
    uart.injectByte(0x42); // new arrival
    expect(irqCount.n).toBe(2);
  });

  it('enabling IER.RDI while a byte is already queued raises IRQ', () => {
    const { uart, irqCount } = setup();
    uart.injectByte(0x41); // before enable
    expect(irqCount.n).toBe(0);
    uart.writeByte(IER, 0x01);
    expect(irqCount.n).toBe(1);
  });

  it('IIR with RDI pending reports source 0x04 + FIFO bits when enabled', () => {
    const { uart } = setup();
    uart.writeByte(FCR, 0x01); // FIFO on
    uart.writeByte(IER, 0x01);
    uart.injectByte(0x41);
    const iir = uart.readByte(IIR);
    expect(iir & 0x0E).toBe(0x04); // RDI
    expect(iir & 0x01).toBe(0);    // pending
    expect(iir & 0xC0).toBe(0xC0); // FIFO enabled bits
  });

  it('IIR with no interrupt pending reports bit 0 = 1', () => {
    const { uart } = setup();
    expect(uart.readByte(IIR) & 0x01).toBe(0x01);
  });
});

describe('IRQ 4 (THR empty)', () => {
  it('enabling IER.THRI fires IRQ once (THRE is permanently asserted)', () => {
    const { uart, irqCount } = setup();
    uart.writeByte(IER, 0x02); // enable THRI
    expect(irqCount.n).toBe(1);
  });

  it('reading IIR clears THRI source (one-shot)', () => {
    const { uart, irqCount } = setup();
    uart.writeByte(IER, 0x02);
    expect(irqCount.n).toBe(1);
    const iir = uart.readByte(IIR);
    expect(iir & 0x0E).toBe(0x02); // THRI source
    // After IIR read, source clears
    expect(uart.readByte(IIR) & 0x01).toBe(0x01); // no int pending
  });

  it('THR write re-arms THRI (so a future IIR read sees a new THRI source)', () => {
    const { uart, tx } = setup();
    uart.writeByte(IER, 0x02);
    uart.readByte(IIR); // ack first THRI
    uart.writeByte(THR, 0x55);
    expect(tx).toEqual([0x55]);
    expect(uart.readByte(IIR) & 0x0E).toBe(0x02); // THRI armed again
  });
});

// ============================================================
// Loopback mode
// ============================================================

describe('Loopback mode (MCR bit 4)', () => {
  it('TX bytes feed RX path; onTransmit is not called', () => {
    const { uart, tx } = setup();
    uart.writeByte(MCR, 0x10); // loopback only
    uart.writeByte(THR, 0x77);
    expect(tx).toEqual([]);
    expect(uart.readByte(LSR) & 0x01).toBe(0x01); // DR set
    expect(uart.readByte(RBR)).toBe(0x77);
  });

  it('MSR in loopback reflects MCR modem-control bits', () => {
    const { uart } = setup();
    // DTR → DSR, RTS → CTS, OUT1 → RI, OUT2 → DCD
    uart.writeByte(MCR, 0x10 | 0x01 | 0x02); // loop + DTR + RTS
    const msr = uart.readByte(MSR);
    expect(msr & 0x10).toBe(0x10); // CTS
    expect(msr & 0x20).toBe(0x20); // DSR
    expect(msr & 0x40).toBe(0);    // RI off (OUT1 not set)
    expect(msr & 0x80).toBe(0);    // DCD off (OUT2 not set)
  });

  it('exiting loopback discards pending RX (avoids leaking loopback bytes)', () => {
    const { uart } = setup();
    uart.writeByte(MCR, 0x10);
    uart.writeByte(THR, 0x42);
    expect(uart.pendingRxCount).toBe(1);
    uart.writeByte(MCR, 0x00); // exit loopback
    expect(uart.pendingRxCount).toBe(0);
  });
});

// ============================================================
// End-to-end: ELKS probe sequence
//
// Replays the full rs_probe (`serial-8250.c:106-152`) and asserts the
// driver would identify us as 16550A.
// ============================================================

describe('ELKS rs_probe sequence', () => {
  it('full probe identifies 16550A and leaves device clean', () => {
    const { uart } = setup();

    // 1. INB IER (read scratch — original value is 0)
    const original = uart.readByte(IER);
    expect(original).toBe(0);
    // 2. OUTB(0, IER)
    uart.writeByte(IER, 0);
    // 3. INB IER must return 0 (our claim of UART presence)
    expect(uart.readByte(IER)).toBe(0);
    // 4. Restore original IER
    uart.writeByte(IER, original);

    // 5. OUTB(0xE7, FCR) — try to enable 14-byte FIFO with full features
    uart.writeByte(FCR, 0xE7);
    // 6. INB IIR — must show FIFO available + 16-byte (16550A signature)
    const status = uart.readByte(IIR);
    expect(status & 0x80).toBe(0x80); // FIFO available
    expect(status & 0x40).toBe(0x40); // 16-byte FIFO functional
    expect(status & 0x20).toBe(0);    // not 16750

    // 7. OUTB(0, MCR) — chip reset
    uart.writeByte(MCR, 0);
    // 8. OUTB(0x06, FCR) — clear FIFOs, FIFO off
    uart.writeByte(FCR, 0x06);
    expect(uart.inspect().fifoEnabled).toBe(false);
    // 9. flush_input: read RX while LSR.DR is set (no bytes queued, so nothing happens)
    expect(uart.readByte(LSR) & 0x01).toBe(0);
  });
});
