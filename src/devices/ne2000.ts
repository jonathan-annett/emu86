/**
 * NE2000-compatible NIC (DP8390 core) — Phase 14 M3a.
 *
 * Evidence-based model: every behaviour below is what ELKS's ne2k driver
 * (`reference/elks/elks/arch/i86/drivers/net/{ne2k.c,ne2k-asm.S}`)
 * actually exercises, cross-checked against QEMU's ne2000 semantics
 * because that driver is developed and tested against QEMU
 * (`ne2k.c:NETIF_IS_QEMU` handling).
 *
 * What the driver requires, and where this file honours it:
 *
 *   - **Probe** (`ne2k.c:ne2k_probe`): write 0x21 to the command
 *     register, read it back, expect 0x21/0x23. CR reads return the
 *     last written value with TXP forced low (transmits complete
 *     instantly here — the `tx_rdy_wait` poll in `ne2k_pack_put`
 *     passes on its first iteration).
 *   - **PROM** (`ne2k_get_hw_addr`): remote-DMA read of 32 bytes from
 *     address 0. We present a 16-bit card: each 16-bit word carries a
 *     PROM byte in the low half and 0x00 in the high half, so the
 *     driver's 8-vs-16-bit heuristic (`ne2k.c:475-489`, sum of high
 *     bytes == 0) selects the 16-bit path and compresses the words
 *     back to bytes. PROM[0..5] = MAC, PROM[14] = PROM[15] = 0x57
 *     ("true ne2k clone" signature, unchecked by ELKS but authentic).
 *   - **Remote DMA**: RSAR/RBCR then CR with RD0 (read, 0x0A) or RD1
 *     (write, 0x12); byte or word transfers through the data port at
 *     base+0x10 per DCR.WTS; ISR.RDC (0x40) latches when the byte
 *     count exhausts — both `dma_read` and `dma_write` spin on it.
 *   - **Transmit**: guest fills NIC RAM at TPSR<<8 via remote write,
 *     sets TBCR, writes CR=0x06 (TXP|STA). The frame is delivered to
 *     `onTransmit` synchronously; ISR.PTX latches; TSR reads 0x01.
 *   - **Receive** ({@link NE2000.injectFrame}): frames land in the
 *     ring between PSTART/PSTOP with the 4-byte header QEMU writes —
 *     [status 0x01, next page, total lo, total hi] where total =
 *     padded length + 4 — CURR advances, ISR.PRX latches. Writing
 *     onto the BOUNDARY page instead raises ISR.OVW and drops the
 *     frame (`ne2k_clr_oflow` recovery path).
 *   - **Reset**: reading base+0x1F (or any CR write with STP) parks
 *     the chip and latches ISR.RST — `ne2k_reset` and
 *     `ne2k_clr_oflow` both HLT-spin on that bit. STA clears it.
 *   - **ISR** is write-1-to-clear for bits 0..6 (`out 0x7f` in
 *     `ne2k_clr_int_reg`); RST clears only via STA.
 *
 * IRQ: `onIRQ` fires on the 0→1 transition of `(ISR & IMR & 0x7f)`,
 * the same edge discipline the UART/keyboard models use. The ELKS
 * handler loops until `ne2k_int_stat()` reads zero, so one edge per
 * event is sufficient.
 *
 * Constraint carried from the substrate: emu86 has a single master
 * PIC, so IRQ 8-15 (including the kernel's default ne0 IRQ 12) are
 * unreachable. The canonical emu86 wiring is IRQ 5 with a bootopts
 * `ne0=5,0x300,,0x80` line guest-side (see the Phase 14 brief M3
 * addendum).
 */

import type { Byte, Word } from '../core/types.js';
import type { IOBus, PortHandler } from '../core/io.js';

/** Canonical emu86 NIC base port — the kernel's default probe address. */
export const NE2K_BASE = 0x300;

/**
 * Canonical emu86 NIC IRQ. NOT the kernel default (12) — that line is
 * unreachable behind a single master PIC; guests select 5 via bootopts.
 */
export const NE2K_IRQ = 5;

/**
 * Default MAC: locally-administered (bit 1 of first octet), spelling
 * "emu86" in the tail — 02:65:6d:75:38:36.
 */
export const NE2K_DEFAULT_MAC: readonly number[] = [0x02, 0x65, 0x6d, 0x75, 0x38, 0x36];

/** On-board packet RAM: 16 KB window at DMA addresses 0x4000..0x7FFF. */
const RAM_BASE = 0x4000;
const RAM_SIZE = 0x4000;

/** Ethernet minimum payload (sans FCS) — short RX frames pad to this. */
const MIN_FRAME = 60;
/** Sanity cap for injected frames (1500 MTU + 14 header + slack). */
const MAX_FRAME = 1600;

// ---- register offsets (page 0 unless noted) ----
const REG_CR = 0x00;
const REG_PSTART = 0x01; // page 1: PAR0
const REG_PSTOP = 0x02;
const REG_BNRY = 0x03;
const REG_TPSR_TSR = 0x04;
const REG_TBCR0 = 0x05;
const REG_TBCR1 = 0x06;
const REG_ISR = 0x07;    // page 1: CURR
const REG_RSAR0 = 0x08;
const REG_RSAR1 = 0x09;
const REG_RBCR0 = 0x0a;
const REG_RBCR1 = 0x0b;
const REG_RSR_RCR = 0x0c;
const REG_CNTR0_TCR = 0x0d;
const REG_CNTR1_DCR = 0x0e;
const REG_CNTR2_IMR = 0x0f;
const REG_DATA = 0x10;
const REG_RESET = 0x1f;

// ---- CR bits ----
const CR_STP = 0x01;
const CR_STA = 0x02;
const CR_TXP = 0x04;
const CR_RD0 = 0x08; // remote read
const CR_RD1 = 0x10; // remote write
const CR_RD2 = 0x20; // abort/complete

// ---- ISR bits ----
const ISR_PRX = 0x01;
const ISR_PTX = 0x02;
const ISR_OVW = 0x10;
const ISR_RDC = 0x40;
const ISR_RST = 0x80;

/** DCR.WTS — word transfer select. */
const DCR_WTS = 0x01;

type RemoteMode = 'idle' | 'read' | 'write';

export interface NE2000Options {
  /** Base port. Default {@link NE2K_BASE}; claims `[base..base+0x1F]`. */
  basePort?: number;
  /** Station MAC (6 bytes). Default {@link NE2K_DEFAULT_MAC}. */
  mac?: readonly number[];
  /**
   * Called with a copy of each frame the guest transmits. The Machine
   * wires this to the host/browser network fabric. Default: no-op
   * (frames vanish into an unplugged cable).
   */
  onTransmit?: (frame: Uint8Array) => void;
  /** IRQ edge callback — Machine wires to `pic.assertIRQ(NE2K_IRQ)`. */
  onIRQ?: () => void;
  /** Warning sink for out-of-contract guest behaviour. Default silent. */
  warn?: (msg: string) => void;
}

export class NE2000 implements PortHandler {
  readonly basePort: number;

  readonly #onTransmit: (frame: Uint8Array) => void;
  readonly #onIRQ: () => void;
  readonly #warn: (msg: string) => void;

  /** 32-byte PROM backing: even bytes = PROM content, odd bytes = 0. */
  readonly #prom = new Uint8Array(32);
  readonly #ram = new Uint8Array(RAM_SIZE);

  // ---- register file ----
  #cr = CR_STP | CR_RD2;      // powers up stopped
  #isr = ISR_RST;
  #imr = 0;
  #dcr = 0;
  #tcr = 0;
  #rcr = 0;
  #rsr = 0;
  #tsr = 0;
  #pstart = 0;
  #pstop = 0;
  #bnry = 0;
  #curr = 0;
  #tpsr = 0;
  #tbcr = 0;
  #rsar = 0;
  #rbcr = 0;
  readonly #par = new Uint8Array(6);
  readonly #mar = new Uint8Array(8);

  // ---- remote DMA engine ----
  #remoteMode: RemoteMode = 'idle';
  #dmaAddr = 0;
  #dmaRemaining = 0;

  /** Tracks the (ISR & IMR) level for edge-triggered onIRQ delivery. */
  #irqLevel = false;

  // Diagnostics: injectFrame outcomes. Callers routinely discard the
  // boolean (fire-and-forget wire semantics), so silent drops need a
  // counter to be visible at all.
  rxAccepted = 0;
  rxDropped = 0;
  /** Count of onIRQ edge deliveries (0→1 transitions of ISR&IMR). */
  irqEdges = 0;

  constructor(opts: NE2000Options = {}) {
    this.basePort = opts.basePort ?? NE2K_BASE;
    this.#onTransmit = opts.onTransmit ?? (() => { /* unplugged */ });
    this.#onIRQ = opts.onIRQ ?? (() => { /* unwired */ });
    this.#warn = opts.warn ?? (() => { /* silent */ });

    const mac = opts.mac ?? NE2K_DEFAULT_MAC;
    if (mac.length !== 6) {
      throw new Error(`NE2000: MAC must be 6 bytes (got ${mac.length})`);
    }
    for (let i = 0; i < 6; i++) this.#prom[i * 2] = (mac[i] ?? 0) & 0xff;
    // Clone signature at PROM bytes 14/15 (backing offsets 28/30).
    this.#prom[28] = 0x57;
    this.#prom[30] = 0x57;
  }

  registerOn(bus: IOBus): void {
    bus.register({ start: this.basePort, end: this.basePort + 0x1f }, this);
  }

  /** The station MAC as configured (reads the PROM's even bytes). */
  get mac(): Uint8Array {
    const out = new Uint8Array(6);
    for (let i = 0; i < 6; i++) out[i] = this.#prom[i * 2] ?? 0;
    return out;
  }

  /** True after STA, until STP/reset — receive path is live. */
  get running(): boolean {
    return (this.#cr & CR_STA) !== 0 && (this.#cr & CR_STP) === 0;
  }

  // ============================================================
  // Host-side frame injection (the "wire" pushing a frame at us)
  // ============================================================

  /**
   * Deliver a frame to the guest through the receive ring. Returns
   * true if accepted, false if dropped (chip stopped, monitor mode,
   * ring not configured, or ring overflow — the last also latches
   * ISR.OVW exactly like a real ring collision with BOUNDARY).
   */
  injectFrame(frame: Uint8Array): boolean {
    if (!this.running) {
      this.rxDropped++;
      return false;
    }
    if ((this.#rcr & 0x20) !== 0) {
      this.rxDropped++;
      return false; // monitor mode (PROM read window)
    }
    if (this.#pstart === 0 || this.#pstop <= this.#pstart) {
      this.rxDropped++;
      return false;
    }
    if (frame.length > MAX_FRAME) {
      this.#warn(`ne2000: dropping oversized injected frame (${frame.length} B)`);
      this.rxDropped++;
      return false;
    }

    const dataLen = Math.max(frame.length, MIN_FRAME);
    const total = dataLen + 4; // QEMU-compatible: header included in count
    const pages = Math.ceil(total / 256);
    const ringPages = this.#pstop - this.#pstart;
    if (pages >= ringPages) {
      this.#raiseISR(ISR_OVW);
      this.rxDropped++;
      return false;
    }

    // Overflow check: writing onto the BOUNDARY page means the ring is
    // full (BNRY trails the read point by one — driver convention,
    // ne2k-asm.S header comment).
    for (let i = 0; i < pages; i++) {
      let page = this.#curr + i;
      if (page >= this.#pstop) page = this.#pstart + (page - this.#pstop);
      if (page === this.#bnry) {
        this.#raiseISR(ISR_OVW);
        this.rxDropped++;
        return false;
      }
    }

    let next = this.#curr + pages;
    if (next >= this.#pstop) next = this.#pstart + (next - this.#pstop);
    // Refuse a packet whose acceptance would leave CURR == BNRY: the
    // driver reads that state as "ring empty" (BOUNDARY trails the read
    // point by one), so the packet would be silently lost. The real
    // 8390 raises overflow when CURR would advance onto BNRY.
    if (next === this.#bnry) {
      this.#raiseISR(ISR_OVW);
      this.rxDropped++;
      return false;
    }

    // 4-byte receive header, then the (padded) frame, wrapping at PSTOP.
    const writeRing = (offsetInPacket: number, value: number): void => {
      let page = this.#curr + Math.floor(offsetInPacket / 256);
      if (page >= this.#pstop) page = this.#pstart + (page - this.#pstop);
      const addr = page * 256 + (offsetInPacket % 256);
      this.#ram[addr - RAM_BASE] = value & 0xff;
    };
    writeRing(0, 0x01); // RSR: packet received intact
    writeRing(1, next);
    writeRing(2, total & 0xff);
    writeRing(3, (total >> 8) & 0xff);
    for (let i = 0; i < dataLen; i++) {
      writeRing(4 + i, i < frame.length ? (frame[i] ?? 0) : 0);
    }

    this.#curr = next;
    this.#rsr = 0x01;
    this.rxAccepted++;
    this.#raiseISR(ISR_PRX);
    return true;
  }


  /** Diagnostic snapshot of receive-path state. */
  inspectRx(): {
    running: boolean; curr: number; bnry: number; pstart: number; pstop: number;
    isr: number; imr: number; rcr: number; accepted: number; dropped: number;
    irqEdges: number;
  } {
    return {
      running: this.running, curr: this.#curr, bnry: this.#bnry,
      pstart: this.#pstart, pstop: this.#pstop, isr: this.#isr,
      imr: this.#imr, rcr: this.#rcr, accepted: this.rxAccepted, dropped: this.rxDropped,
      irqEdges: this.irqEdges,
    };
  }

  // ============================================================
  // PortHandler
  // ============================================================

  readByte(port: number): Byte {
    const offset = port - this.basePort;
    if (offset === REG_DATA) return this.#dataRead();
    if (offset === REG_RESET) {
      this.#softReset();
      return 0x00;
    }
    const page = (this.#cr >> 6) & 0x03;
    if (page === 1) return this.#readPage1(offset);
    return this.#readPage0(offset);
  }

  writeByte(port: number, value: Byte): void {
    const offset = port - this.basePort;
    const v = value & 0xff;
    if (offset === REG_DATA) {
      this.#dataWrite(v);
      return;
    }
    if (offset === REG_RESET) return; // write half of the reset pulse — no-op
    if (offset === REG_CR) {
      this.#writeCR(v);
      return;
    }
    const page = (this.#cr >> 6) & 0x03;
    if (page === 1) this.#writePage1(offset, v);
    else this.#writePage0(offset, v);
  }

  /**
   * Word access exists for the data port only (`in %ax,%dx` /
   * `out %ax,%dx` in ne2k-asm.S word loops). Other offsets degrade to
   * a byte access with an open-bus high half, matching an 8-bit
   * register file on a 16-bit bus.
   */
  readWord(port: number): Word {
    const offset = port - this.basePort;
    if (offset === REG_DATA) {
      const lo = this.#dataRead();
      const hi = this.#dataRead();
      return ((hi << 8) | lo) & 0xffff;
    }
    return (0xff00 | this.readByte(port)) & 0xffff;
  }

  writeWord(port: number, value: Word): void {
    const offset = port - this.basePort;
    if (offset === REG_DATA) {
      this.#dataWrite(value & 0xff);
      this.#dataWrite((value >> 8) & 0xff);
      return;
    }
    this.writeByte(port, value & 0xff);
  }

  // ============================================================
  // Register pages
  // ============================================================

  #readPage0(offset: number): Byte {
    switch (offset) {
      case REG_CR: return this.#crRead();
      case REG_BNRY: return this.#bnry;
      case REG_TPSR_TSR: return this.#tsr;
      case REG_ISR: return this.#isr;
      case REG_RSR_RCR: return this.#rsr;
      // Tally counters: clear-on-read, never accumulate here (no
      // wire errors exist in this fabric).
      case REG_CNTR0_TCR:
      case REG_CNTR1_DCR:
      case REG_CNTR2_IMR:
        return 0x00;
      // Write-only registers read back as open bus on real cards;
      // nothing in the driver reads them.
      default:
        return 0xff;
    }
  }

  #writePage0(offset: number, v: number): void {
    switch (offset) {
      case REG_PSTART: this.#pstart = v; return;
      case REG_PSTOP: this.#pstop = v; return;
      case REG_BNRY: this.#bnry = v; return;
      case REG_TPSR_TSR: this.#tpsr = v; return;
      case REG_TBCR0: this.#tbcr = (this.#tbcr & 0xff00) | v; return;
      case REG_TBCR1: this.#tbcr = (this.#tbcr & 0x00ff) | (v << 8); return;
      case REG_ISR:
        // Write-1-to-clear, bits 0..6. RST clears only via STA.
        this.#isr &= ~(v & 0x7f);
        this.#updateIRQ();
        return;
      case REG_RSAR0: this.#rsar = (this.#rsar & 0xff00) | v; return;
      case REG_RSAR1: this.#rsar = (this.#rsar & 0x00ff) | (v << 8); return;
      case REG_RBCR0: this.#rbcr = (this.#rbcr & 0xff00) | v; return;
      case REG_RBCR1: this.#rbcr = (this.#rbcr & 0x00ff) | (v << 8); return;
      case REG_RSR_RCR: this.#rcr = v; return;
      case REG_CNTR0_TCR: this.#tcr = v; return;
      case REG_CNTR1_DCR: this.#dcr = v; return;
      case REG_CNTR2_IMR:
        this.#imr = v;
        this.#updateIRQ();
        return;
      default:
        this.#warn(`ne2000: write to unimplemented page-0 register +0x${offset.toString(16)}`);
        return;
    }
  }

  #readPage1(offset: number): Byte {
    if (offset >= 0x01 && offset <= 0x06) return this.#par[offset - 1] ?? 0;
    if (offset === REG_ISR) return this.#curr; // page 1 +0x07 = CURR
    if (offset >= 0x08 && offset <= 0x0f) return this.#mar[offset - 8] ?? 0;
    if (offset === REG_CR) return this.#crRead();
    return 0xff;
  }

  #writePage1(offset: number, v: number): void {
    if (offset >= 0x01 && offset <= 0x06) {
      this.#par[offset - 1] = v;
      return;
    }
    if (offset === REG_ISR) {
      this.#curr = v;
      return;
    }
    if (offset >= 0x08 && offset <= 0x0f) {
      this.#mar[offset - 8] = v;
      return;
    }
    this.#warn(`ne2000: write to unimplemented page-1 register +0x${offset.toString(16)}`);
  }

  // ============================================================
  // Command register
  // ============================================================

  #crRead(): Byte {
    // TXP reads 0: transmits complete synchronously, so the driver's
    // "previous transmit done?" polls always pass.
    return this.#cr & ~CR_TXP & 0xff;
  }

  #writeCR(v: number): void {
    this.#cr = v & 0xff;

    if ((v & CR_STP) !== 0) {
      // Datasheet: STOP parks the chip and sets ISR.RST once internal
      // activity drains — instantly, here. ne2k_clr_oflow spins on it.
      this.#raiseISR(ISR_RST);
    } else if ((v & CR_STA) !== 0) {
      this.#isr &= ~ISR_RST;
      this.#updateIRQ();
    }

    // Remote DMA command (bits 3..5). RD2 aborts; RD0/RD1 latch the
    // address/count registers into a live transfer.
    if ((v & CR_RD2) !== 0) {
      this.#remoteMode = 'idle';
    } else if ((v & (CR_RD0 | CR_RD1)) !== 0) {
      this.#remoteMode = (v & CR_RD0) !== 0 ? 'read' : 'write';
      this.#dmaAddr = this.#rsar;
      this.#dmaRemaining = this.#rbcr;
      if (this.#dmaRemaining === 0) {
        this.#remoteMode = 'idle';
        this.#raiseISR(ISR_RDC);
      }
    }

    if ((v & CR_TXP) !== 0) this.#transmit();
  }

  #transmit(): void {
    const len = this.#tbcr;
    if (len === 0 || len > MAX_FRAME) {
      this.#warn(`ne2000: transmit with implausible TBCR=${len}; dropping`);
      this.#tsr = 0x01;
      this.#raiseISR(ISR_PTX);
      return;
    }
    const start = this.#tpsr << 8;
    const frame = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      frame[i] = this.#readMem(start + i);
    }
    this.#tsr = 0x01; // PTX: transmitted without error
    this.#onTransmit(frame);
    this.#raiseISR(ISR_PTX);
  }

  // ============================================================
  // Remote DMA + data port
  // ============================================================

  #dataRead(): Byte {
    if (this.#remoteMode !== 'read' || this.#dmaRemaining === 0) {
      return 0xff; // open bus — driver never reads outside a transfer
    }
    const b = this.#readMem(this.#dmaAddr);
    this.#dmaAddr = (this.#dmaAddr + 1) & 0xffff;
    this.#dmaRemaining--;
    if (this.#dmaRemaining === 0) {
      this.#remoteMode = 'idle';
      this.#raiseISR(ISR_RDC);
    }
    return b;
  }

  #dataWrite(v: number): void {
    if (this.#remoteMode !== 'write' || this.#dmaRemaining === 0) {
      this.#warn('ne2000: data-port write outside an active remote-write transfer');
      return;
    }
    this.#writeMem(this.#dmaAddr, v);
    this.#dmaAddr = (this.#dmaAddr + 1) & 0xffff;
    this.#dmaRemaining--;
    if (this.#dmaRemaining === 0) {
      this.#remoteMode = 'idle';
      this.#raiseISR(ISR_RDC);
    }
  }

  #readMem(addr: number): number {
    if (addr < 32) return this.#prom[addr] ?? 0;
    if (addr >= RAM_BASE && addr < RAM_BASE + RAM_SIZE) {
      return this.#ram[addr - RAM_BASE] ?? 0;
    }
    return 0xff;
  }

  #writeMem(addr: number, v: number): void {
    if (addr >= RAM_BASE && addr < RAM_BASE + RAM_SIZE) {
      this.#ram[addr - RAM_BASE] = v & 0xff;
    }
    // Writes outside packet RAM are silently ignored (PROM is ROM).
  }

  // ============================================================
  // Reset + IRQ plumbing
  // ============================================================

  #softReset(): void {
    this.#cr = CR_STP | CR_RD2;
    this.#isr = ISR_RST;
    this.#remoteMode = 'idle';
    this.#dmaRemaining = 0;
    this.#irqLevel = false;
    // Register file survives reset on real 8390s except run state;
    // the driver re-initialises everything anyway.
  }

  #raiseISR(bits: number): void {
    this.#isr |= bits;
    this.#updateIRQ();
  }

  #updateIRQ(): void {
    const level = (this.#isr & this.#imr & 0x7f) !== 0;
    if (level && !this.#irqLevel) {
      this.irqEdges++;
      this.#onIRQ();
    }
    this.#irqLevel = level;
  }
}
