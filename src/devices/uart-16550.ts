import type { Byte } from '../core/types.js';
import type { IOBus, PortHandler } from '../core/io.js';

/**
 * NS16550A-class UART — Phase 8.
 *
 * The 16550A is a single-channel UART with two 16-byte FIFOs (RX and TX),
 * sitting on 8 contiguous I/O ports. ELKS's serial driver
 * (`reference/elks/elks/arch/i86/drivers/char/serial-8250.c`) probes for
 * 8250 / 16450 / 16550 / 16550A / 16750 generations, picks the highest the
 * UART claims to be, and (with `CONFIG_HW_SERIAL_FIFO=y`, set in
 * `ibmpc-1440.config`) enables 14-byte trigger FIFO mode at open time.
 *
 * We model 16550A: FIFO support claimed via IIR bits 7..6 = 11 when FIFO
 * is enabled, bit 5 = 0 (we are not a 16750 with 64-byte FIFO).
 *
 * What this implementation models — and what it deliberately doesn't.
 *
 * **Byte-stream forwarding only, no real baud.** The divisor latch is
 * accepted and stored but has no effect on timing — bytes pass instantly
 * between host and guest. ELKS's update_port writes a divisor for the
 * /bootopts-configured baud rate; we acknowledge it.
 *
 * **TX is always ready.** LSR bits THRE (transmit-hold empty) and TEMT
 * (transmitter empty) are permanently 1. `onTransmit(byte)` fires
 * synchronously on every THR write — the harness wires that to stdout (or
 * a capture buffer in tests). No host-side TX queue is modelled because
 * the host is infinitely fast in our virtual time.
 *
 * **RX FIFO modeled.** When FIFO mode is enabled (FCR bit 0 = 1), we
 * accept up to 16 queued bytes; reads of RBR drain one at a time. When
 * FIFO mode is disabled (the post-probe state), we keep a 1-byte holding
 * register. The host pushes bytes via `injectByte` / `injectBytes`; LSR.DR
 * tracks "RX has a byte to deliver".
 *
 * **Loopback (MCR bit 4) is implemented.** ELKS's probe doesn't use it,
 * but it's small and the brief asks for documentation either way: in
 * loopback the TX path feeds the RX FIFO instead of `onTransmit`, and MSR
 * bits 4..7 reflect MCR bits 0..3 (DTR → DSR, RTS → CTS, OUT1 → RI,
 * OUT2 → DCD).
 *
 * **Modem status register reads as "all good"** when not in loopback:
 * DSR/CTS/DCD asserted, RI clear, all delta bits 0. Reading MSR clears
 * the delta bits — we never set them, so this is a no-op. ELKS's open
 * sequence reads MSR once to clear pending interrupts; that's the only
 * use.
 *
 * **IRQ 4 firing is callback-driven.** `onIRQ4` is called whenever the
 * controller decides an interrupt should fire. The Machine wires this to
 * `pic.assertIRQ(4)`. Same structural pattern as
 * `KeyboardController8042.onIRQ1`.
 *
 * **No INT 14h BIOS services.** ELKS talks to the UART directly via port
 * I/O. The BIOS layer doesn't see this device.
 */

/** Default base port for COM1. ELKS expects this (ports.h:47). */
export const COM1_BASE = 0x3F8;
/** Default IRQ for COM1. ELKS expects this (ports.h:48). */
export const COM1_IRQ = 4;

/** RX FIFO depth in 16550A. The kernel programs 14-byte trigger but the FIFO holds 16. */
const FIFO_DEPTH = 16;

// ---- Register offsets relative to base port (DLAB-aware where noted). ----

/** RX/TX/divisor-low at offset 0. */
const REG_RBR = 0; // DLAB=0 read
const REG_THR = 0; // DLAB=0 write
const REG_DLL = 0; // DLAB=1 read/write
/** IER/divisor-high at offset 1. */
const REG_IER = 1; // DLAB=0
const REG_DLM = 1; // DLAB=1
/** IIR (read) / FCR (write) at offset 2. */
const REG_IIR = 2; // read
const REG_FCR = 2; // write
/** LCR at offset 3. Bit 7 is the DLAB. */
const REG_LCR = 3;
/** MCR at offset 4. */
const REG_MCR = 4;
/** LSR at offset 5. */
const REG_LSR = 5;
/** MSR at offset 6. */
const REG_MSR = 6;
/** Scratch register at offset 7. */
const REG_SCR = 7;

// ---- LCR bits ----
const LCR_DLAB = 0x80;

// ---- LSR bits ----
const LSR_DR    = 0x01; // Data Ready
const LSR_OE    = 0x02; // Overrun Error
const LSR_THRE  = 0x20; // Transmit Holding Register Empty
const LSR_TEMT  = 0x40; // Transmitter Empty (TX shift + holding both empty)

// ---- IER bits (which interrupt sources are enabled) ----
const IER_RDI   = 0x01; // Received Data available
const IER_THRI  = 0x02; // Transmitter Holding Register empty
const IER_RLSI  = 0x04; // Receiver Line Status
const IER_MSI   = 0x08; // Modem Status

// ---- IIR encodings (low 4 bits identify the source; bits 7..6 reflect FIFO state) ----
const IIR_NO_INT     = 0x01; // bit 0 = 1 → no interrupt pending
const IIR_RLSI       = 0x06; // Receiver Line Status (highest priority)
const IIR_RDI        = 0x04; // Received Data available
const IIR_THRI       = 0x02; // Transmitter Holding Register Empty (lowest of the four)
const IIR_MSI        = 0x00; // Modem Status (lowest)
/** Bits 7..6 set when FIFO is enabled (per 16550A datasheet). */
const IIR_FIFO_ENABLED_BITS = 0xC0;

// ---- FCR bits ----
const FCR_ENABLE_FIFO = 0x01;
const FCR_CLEAR_RCVR  = 0x02;
const FCR_CLEAR_XMIT  = 0x04;
// Trigger level (bits 6..7) is accepted but doesn't change behaviour — we
// raise IRQ on every queued RX byte when an interrupt is enabled. The
// kernel's IRQ handler drains the whole FIFO per IRQ anyway (see
// `serfast.S` — it reads RX while LSR.DR is set), so this is observably
// equivalent to "trigger of 1".

// ---- MCR bits ----
const MCR_DTR     = 0x01;
const MCR_RTS     = 0x02;
const MCR_OUT1    = 0x04;
const MCR_OUT2    = 0x08;
const MCR_LOOP    = 0x10;

// ---- MSR bits (high nibble = current state, low nibble = delta-since-last-read) ----
const MSR_CTS  = 0x10;
const MSR_DSR  = 0x20;
const MSR_RI   = 0x40;
const MSR_DCD  = 0x80;

export interface UART16550Options {
  /**
   * Base port. PC standard COM1: 0x3F8. The UART claims `[base..base+7]`.
   * ELKS reads this from `ports.h:COM1_PORT`.
   */
  basePort?: number;
  /**
   * Optional warning sink for unexpected programmer behaviour. Default
   * silent. Same shape as `KeyboardController8042Options.warn`.
   */
  warn?: (msg: string) => void;
  /**
   * Called when an outgoing byte is transmitted (the guest wrote THR).
   * The Machine wires this to stdout (or a test sink). Default: no-op.
   *
   * In loopback mode (MCR bit 4 = 1) `onTransmit` is NOT called — the
   * byte is fed back into the RX path internally. This matches real
   * silicon behaviour where the transceiver pin is detached from the
   * outside world.
   */
  onTransmit?: (byte: number) => void;
  /**
   * Called whenever the device wants to assert IRQ 4 — driven by the
   * IER bits and current state. The Machine wires this to
   * `pic.assertIRQ(4)`. Default: no-op.
   *
   * Fires once per "interrupt-pending becomes true" transition. The
   * kernel's handler reads IIR (which acknowledges the interrupt) and
   * drains RX or services THR; if more data arrives or another source
   * becomes pending afterwards, the next state transition fires
   * `onIRQ4` again.
   */
  onIRQ4?: () => void;
}

/**
 * Serialized chip state (Phase 18 M1) — every mutable register, the RX
 * FIFO, and the IRQ engine. `thriArmed` / `irqPending` /
 * `pendingIIRSource` are exactly the private trio `inspect()` doesn't
 * expose: drop them and a restored guest either misses a THRI interrupt
 * it was owed or reads a phantom IIR source.
 */
export interface Uart16550State {
  readonly v: 1;
  readonly ier: number;
  readonly lcr: number;
  readonly mcr: number;
  readonly dll: number;
  readonly dlm: number;
  readonly scratch: number;
  readonly fifoEnabled: boolean;
  readonly rxFifo: readonly number[];
  readonly overrun: boolean;
  readonly irqPending: boolean;
  readonly pendingIIRSource: number;
  readonly thriArmed: boolean;
}

/**
 * Read-only inspection state, exposed for tests and diagnostics. Shape is
 * deliberately conservative — only fields tests need to assert on.
 */
export interface UART16550InspectionState {
  readonly dlab: boolean;
  readonly fifoEnabled: boolean;
  readonly rxFifo: readonly number[];
  readonly ier: number;
  readonly lcr: number;
  readonly mcr: number;
  readonly divisor: number;
  readonly scratch: number;
  readonly loopback: boolean;
}

export class UART16550 implements PortHandler {
  // ---- programmer-visible registers ----
  private ier: number = 0x00;
  private lcr: number = 0x00;
  private mcr: number = 0x00;
  /** Stored divisor (low | high << 8). Captured but not used for timing. */
  private dll: number = 0x00;
  private dlm: number = 0x00;
  /** Scratch register — round-trips a byte. ELKS's probe writes 0x2A and reads back. */
  private scratch: number = 0x00;

  // ---- FIFO state ----
  private fifoEnabled: boolean = false;
  private readonly rxFifo: number[] = [];
  /** Sticky overrun flag (set when RX FIFO would overflow; cleared on LSR read). */
  private overrun: boolean = false;

  // ---- IRQ state ----
  private irqPending: boolean = false;
  /** Source that the next IIR read will report. Recomputed lazily. */
  private pendingIIRSource: number = IIR_NO_INT;
  /**
   * THRI source is "armed" only briefly: after IER.THRI rises 0→1, or
   * after a THR write. Cleared on IIR read. Real 16550A's THRE-empty
   * interrupt is one-shot per arming event; mirroring that prevents an
   * IRQ storm given that THRE is permanently asserted in our model.
   */
  private thriArmed: boolean = false;

  private readonly basePort: number;
  private readonly warn: (msg: string) => void;
  private readonly onTransmit: (byte: number) => void;
  private readonly onIRQ4: () => void;

  constructor(options: UART16550Options = {}) {
    this.basePort = options.basePort ?? COM1_BASE;
    this.warn = options.warn ?? (() => { /* silent */ });
    this.onTransmit = options.onTransmit ?? (() => { /* silent */ });
    this.onIRQ4 = options.onIRQ4 ?? (() => { /* silent */ });
  }

  // ============================================================
  // Bus registration
  // ============================================================

  /**
   * Reserve `[basePort..basePort+7]` on the bus. Eight contiguous ports
   * — every UART register lives in this range. Call once at machine
   * setup; throws (via the bus) if those ports are already claimed.
   */
  registerOn(bus: IOBus): void {
    bus.register({ start: this.basePort, end: this.basePort + 7 }, this);
  }

  // ============================================================
  // PortHandler implementation
  // ============================================================

  readByte(port: number): Byte {
    const offset = port - this.basePort;
    const dlab = (this.lcr & LCR_DLAB) !== 0;
    switch (offset) {
      case REG_RBR: return dlab ? this.dll : this.readRBR();
      case REG_IER: return dlab ? this.dlm : (this.ier & 0x0F);
      case REG_IIR: return this.readIIR();
      case REG_LCR: return this.lcr;
      case REG_MCR: return this.mcr;
      case REG_LSR: return this.readLSR();
      case REG_MSR: return this.readMSR();
      case REG_SCR: return this.scratch;
      default:      return 0xFF;
    }
  }

  writeByte(port: number, value: Byte): void {
    const v = value & 0xFF;
    const offset = port - this.basePort;
    const dlab = (this.lcr & LCR_DLAB) !== 0;
    switch (offset) {
      case REG_THR:
        if (dlab) this.dll = v;
        else this.writeTHR(v);
        return;
      case REG_IER:
        if (dlab) this.dlm = v;
        else this.writeIER(v);
        return;
      case REG_FCR: this.writeFCR(v); return;
      case REG_LCR: this.lcr = v; return;
      case REG_MCR: this.writeMCR(v); return;
      case REG_LSR:
        // LSR is read-only on real silicon; writes are typically dropped.
        // Some test programs write to it for debug; warn but ignore.
        this.warn(`UART: write 0x${v.toString(16)} to LSR ignored (read-only)`);
        return;
      case REG_MSR:
        this.warn(`UART: write 0x${v.toString(16)} to MSR ignored (read-only)`);
        return;
      case REG_SCR: this.scratch = v; return;
      default: return;
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Power-on reset. Returns the UART to its post-construction state.
   * Clears the RX FIFO, drops divisor / IER / LCR / MCR / scratch, and
   * deasserts any pending IRQ.
   */
  reset(): void {
    this.ier = 0;
    this.lcr = 0;
    this.mcr = 0;
    this.dll = 0;
    this.dlm = 0;
    this.scratch = 0;
    this.fifoEnabled = false;
    this.rxFifo.length = 0;
    this.overrun = false;
    this.irqPending = false;
    this.pendingIIRSource = IIR_NO_INT;
  }

  // ============================================================
  // State plane (Phase 18 M1)
  // ============================================================

  serializeState(): Uart16550State {
    return {
      v: 1,
      ier: this.ier,
      lcr: this.lcr,
      mcr: this.mcr,
      dll: this.dll,
      dlm: this.dlm,
      scratch: this.scratch,
      fifoEnabled: this.fifoEnabled,
      rxFifo: [...this.rxFifo],
      overrun: this.overrun,
      irqPending: this.irqPending,
      pendingIIRSource: this.pendingIIRSource,
      thriArmed: this.thriArmed,
    };
  }

  /**
   * Restore captured chip state verbatim. Deliberately does NOT call
   * `recomputeIRQ()`: an IRQ edge that fired before capture is already
   * in the captured PIC/controller state, and `onIRQ4` re-firing here
   * would double-assert it.
   */
  restoreState(state: Uart16550State): void {
    if (state.v !== 1) {
      throw new Error(`UART16550.restoreState: unsupported schema version ${String(state.v)}`);
    }
    this.ier = state.ier;
    this.lcr = state.lcr;
    this.mcr = state.mcr;
    this.dll = state.dll;
    this.dlm = state.dlm;
    this.scratch = state.scratch;
    this.fifoEnabled = state.fifoEnabled;
    this.rxFifo.length = 0;
    this.rxFifo.push(...state.rxFifo);
    this.overrun = state.overrun;
    this.irqPending = state.irqPending;
    this.pendingIIRSource = state.pendingIIRSource;
    this.thriArmed = state.thriArmed;
  }

  // ============================================================
  // Host-side RX injection
  // ============================================================

  /**
   * Push a byte into the RX path as if it had arrived over the wire.
   *
   * Behaviour:
   * - In FIFO mode: the byte joins the queue (up to `FIFO_DEPTH`).
   *   Overflow sets the overrun flag (visible in LSR until next LSR
   *   read) and the byte is dropped — same as a real 16550A's RX FIFO
   *   when the CPU isn't draining fast enough.
   * - In non-FIFO mode: at most one byte is queued. A second injection
   *   overruns the holding register; the new byte replaces the old one
   *   and the overrun flag latches. Real silicon overwrites the holding
   *   register on overrun; we match.
   * - LSR.DR rises on the empty → non-empty transition. If IER.RDI is
   *   set, IRQ 4 fires.
   */
  injectByte(byte: number): void {
    const v = byte & 0xFF;
    const limit = this.fifoEnabled ? FIFO_DEPTH : 1;
    if (this.rxFifo.length >= limit) {
      this.overrun = true;
      // Overwrite the holding register in non-FIFO mode (datasheet
      // behaviour: the new byte wins, overrun is latched). In FIFO mode
      // drop the new byte to preserve the queue.
      if (!this.fifoEnabled) this.rxFifo[0] = v;
      this.recomputeIRQ();
      return;
    }
    this.rxFifo.push(v);
    this.recomputeIRQ();
  }

  /** Convenience: inject a sequence of bytes in order. */
  injectBytes(bytes: Iterable<number>): void {
    for (const b of bytes) this.injectByte(b);
  }

  /** Number of bytes currently queued in the RX FIFO (or holding register). */
  get pendingRxCount(): number {
    return this.rxFifo.length;
  }

  // ============================================================
  // Inspection helpers
  // ============================================================

  inspect(): UART16550InspectionState {
    return {
      dlab: (this.lcr & LCR_DLAB) !== 0,
      fifoEnabled: this.fifoEnabled,
      rxFifo: [...this.rxFifo],
      ier: this.ier,
      lcr: this.lcr,
      mcr: this.mcr,
      divisor: (this.dlm << 8) | this.dll,
      scratch: this.scratch,
      loopback: (this.mcr & MCR_LOOP) !== 0,
    };
  }

  // ============================================================
  // Internals — reads
  // ============================================================

  private readRBR(): Byte {
    const v = this.rxFifo.shift();
    // Reading RBR clears the data-ready interrupt source as the byte is
    // consumed. Recompute IRQ pending state.
    this.recomputeIRQ();
    return v ?? 0x00;
  }

  /**
   * Read the IIR. The 16550A returns:
   *
   *   - Bits 7..6: 11 if FIFO is enabled, else 00.
   *   - Bit 0: 0 if an interrupt is pending, 1 if not.
   *   - Bits 3..1: source identifier (RLSI / RDI / THRI / MSI).
   *
   * Reading IIR with a THRE (transmitter-empty) interrupt pending
   * acknowledges and clears that source — real silicon clears the THRI
   * latch on IIR read. RX, RLS, MSR sources are not cleared by IIR read
   * (those clear by reading their own register).
   *
   * In our model: THRE is permanently asserted, so a "THRI pending"
   * interrupt would re-fire instantly and spam the CPU. We arm the THRI
   * source only momentarily — when IER.THRI flips from 0 → 1 or
   * immediately after a THR write — then clear it on IIR read.
   */
  private readIIR(): Byte {
    let value: number;
    if (this.irqPending) {
      value = this.pendingIIRSource;
    } else {
      value = IIR_NO_INT;
    }
    if (this.fifoEnabled) value |= IIR_FIFO_ENABLED_BITS;

    // Clear the THRI source on IIR read. Other sources keep firing until
    // their data clears (RBR read clears RDI; LSR read clears RLSI; MSR
    // read clears MSI).
    if (this.irqPending && this.pendingIIRSource === IIR_THRI) {
      this.thriArmed = false;
      this.recomputeIRQ();
    }
    return value & 0xFF;
  }

  private readLSR(): Byte {
    let v = LSR_THRE | LSR_TEMT; // we are always ready to TX
    if (this.rxFifo.length > 0) v |= LSR_DR;
    if (this.overrun) v |= LSR_OE;
    // Reading LSR clears OE and the RLS interrupt source.
    this.overrun = false;
    return v & 0xFF;
  }

  private readMSR(): Byte {
    if ((this.mcr & MCR_LOOP) !== 0) {
      // In loopback, MSR's high nibble reflects MCR's modem-control bits.
      let v = 0;
      if ((this.mcr & MCR_DTR)  !== 0) v |= MSR_DSR;
      if ((this.mcr & MCR_RTS)  !== 0) v |= MSR_CTS;
      if ((this.mcr & MCR_OUT1) !== 0) v |= MSR_RI;
      if ((this.mcr & MCR_OUT2) !== 0) v |= MSR_DCD;
      return v & 0xFF;
    }
    // Default: peer is happy and present. CTS / DSR / DCD asserted, RI
    // clear, no delta bits since "last read" — we never set them.
    return (MSR_CTS | MSR_DSR | MSR_DCD) & 0xFF;
  }

  // ============================================================
  // Internals — writes
  // ============================================================

  private writeTHR(byte: number): void {
    const v = byte & 0xFF;
    if ((this.mcr & MCR_LOOP) !== 0) {
      // Loopback: byte appears at RX, never reaches `onTransmit`.
      this.injectByte(v);
    } else {
      this.onTransmit(v);
    }
    // The transmitter-holding register became "empty" again instantly.
    // Re-arm the THRI source — real silicon's TX-empty interrupt fires
    // when THR transitions full→empty. Most kernel code doesn't enable
    // THRI; if it does, the IRQ fires once per write and clears on the
    // first IIR read.
    this.thriArmed = true;
    this.recomputeIRQ();
  }

  private writeIER(value: number): void {
    const newIER = value & 0x0F;
    const wasTHRI = (this.ier & IER_THRI) !== 0;
    const isTHRI  = (newIER  & IER_THRI) !== 0;
    this.ier = newIER;
    // Enabling THRI while THRE is set arms the THRI source. Real 16550A:
    // setting IER.THRI when THRE is asserted causes a spurious interrupt
    // — that's the documented behaviour — and the kernel's handler
    // tolerates it.
    if (!wasTHRI && isTHRI) this.thriArmed = true;
    this.recomputeIRQ();
  }

  /**
   * FCR is write-only; bits:
   *   0     ENABLE_FIFO  enable / disable FIFOs
   *   1     CLEAR_RCVR   clear the RX FIFO (self-clears)
   *   2     CLEAR_XMIT   clear the TX FIFO (self-clears; we have no TX queue)
   *   3     DMA_SELECT   ignored
   *   6..7  TRIGGER      RX trigger level (1, 4, 8, 14 bytes) — accepted, no behavioural effect
   *   5     16750: enable 64-byte FIFO. We always claim 16550A, so we
   *         don't act on this bit.
   */
  private writeFCR(value: number): void {
    const v = value & 0xFF;
    const newEnable = (v & FCR_ENABLE_FIFO) !== 0;
    if (newEnable !== this.fifoEnabled) {
      // Per datasheet, changing the enable bit clears the FIFO contents.
      this.rxFifo.length = 0;
    }
    this.fifoEnabled = newEnable;
    if ((v & FCR_CLEAR_RCVR) !== 0) {
      this.rxFifo.length = 0;
    }
    // CLEAR_XMIT: we have no TX queue; no-op.
    this.recomputeIRQ();
  }

  private writeMCR(value: number): void {
    const wasLoop = (this.mcr & MCR_LOOP) !== 0;
    this.mcr = value & 0x1F; // bits 0..4 are programmable; 5..7 reserved
    const isLoop = (this.mcr & MCR_LOOP) !== 0;
    if (wasLoop !== isLoop) {
      // Entering / exiting loopback discards any in-flight RX state to
      // avoid leaking host bytes into a loopback test (or vice versa).
      this.rxFifo.length = 0;
      this.overrun = false;
      this.recomputeIRQ();
    }
  }

  // ============================================================
  // IRQ pending recompute
  // ============================================================

  /**
   * Decide whether the IRQ line should be asserted right now. The 16550A
   * priority order, highest first:
   *
   *   1. Receiver Line Status (we never raise this in v0; OE is sticky
   *      but doesn't fire IRQ unless IER.RLSI is set, which the kernel
   *      doesn't enable in normal operation).
   *   2. Received Data available (LSR.DR && IER.RDI).
   *   3. THRE (always asserted; only fires once after an arming event:
   *      THRI set in IER, or THR write).
   *   4. Modem Status (we don't raise it).
   *
   * If the highest-priority enabled source has changed and the new
   * pending state is "asserted" while the previous was "deasserted", we
   * call `onIRQ4`. The PIC handles edge vs level — we just edge-fire on
   * each new pending event.
   */
  private recomputeIRQ(): void {
    const wasPending = this.irqPending;
    let source = IIR_NO_INT;
    if ((this.ier & IER_RDI) !== 0 && this.rxFifo.length > 0) {
      source = IIR_RDI;
    } else if ((this.ier & IER_THRI) !== 0 && this.thriArmed) {
      source = IIR_THRI;
    }
    const isPending = source !== IIR_NO_INT;
    this.pendingIIRSource = source;
    this.irqPending = isPending;
    if (isPending && !wasPending) {
      this.onIRQ4();
    }
  }
}
