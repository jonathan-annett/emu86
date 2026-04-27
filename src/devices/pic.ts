import type { Byte, Word } from '../core/types.js';
import type { IOBus, PortHandler } from '../core/io.js';
import type { InterruptController } from '../interrupts/controller.js';

/**
 * Intel 8259A Programmable Interrupt Controller — single-PIC v0.
 *
 * The PIC owns a small priority-and-EOI state machine sitting between
 * device IRQ lines and the CPU's interrupt controller. Devices call
 * {@link PIC8259.assertIRQ} when their line goes high; the PIC decides
 * when (and which) IRQ becomes a CPU interrupt and forwards the resolved
 * vector to the {@link InterruptController} via `raise()`. The CPU then
 * services the interrupt at the next instruction boundary as it would for
 * any other source.
 *
 * Implemented bits of the 8259A spec:
 *
 *   - ICW1 → ICW2 → (ICW3) → (ICW4) initialization sequence with re-init
 *     via a fresh ICW1 from any state.
 *   - OCW1: IMR set/get via the data port.
 *   - OCW2: non-specific EOI and specific EOI.
 *   - OCW3: select IRR / ISR for the next command-port read.
 *   - Fixed priority: IRQ 0 highest, IRQ 7 lowest.
 *   - Priority-based preemption (a higher-priority IRQ can be raised while
 *     a lower-priority handler is in service; the PIC raises it and lets
 *     the CPU's IF gating decide whether it actually fires).
 *
 * Out of scope (deliberately, per the brief):
 *
 *   - Cascaded master/slave PICs.
 *   - Auto-EOI mode.
 *   - Special fully nested mode (only meaningful with cascading).
 *   - Polling mode.
 *   - Spurious-IRQ-7 modeling.
 *   - Buffered-mode signalling we don't simulate.
 *
 * Each unsupported feature either logs a warning and proceeds, or is
 * silently ignored where the spec calls for that. See the relevant
 * write handlers for specifics.
 */

export interface PIC8259Options {
  /** Command-register port. PC standard: 0x20 (master) / 0xA0 (slave). */
  commandPort?: number;
  /** Data-register port. PC standard: 0x21 (master) / 0xA1 (slave). */
  dataPort?: number;
  /**
   * Optional logger for "we got something we don't support but kept going"
   * cases. Default: silent — tests don't want noise on stderr, and the
   * cases we'd warn about are programming bugs in guest software, not
   * emulator bugs we want to surface here.
   */
  warn?: (msg: string) => void;
}

type InitState = 'idle' | 'awaitingIcw2' | 'awaitingIcw3' | 'awaitingIcw4';

export class PIC8259 implements PortHandler {
  // ---- programmer-visible registers ----
  /** Interrupt Request Register: bit n = IRQ n line currently asserted (or latched edge). */
  private irr: number = 0;
  /** In-Service Register: bit n = IRQ n currently being handled by the CPU (awaiting EOI). */
  private isr: number = 0;
  /** Interrupt Mask Register: bit n = 1 means IRQ n is masked (suppressed). */
  private imr: number = 0xFF;
  /** Vector base set via ICW2: IRQ n delivers vector (vectorBase + n). */
  private vectorBase: number = 0;

  // ---- init state machine ----
  private initState: InitState = 'idle';
  private expectIcw3: boolean = false;
  private expectIcw4: boolean = false;
  private levelTriggered: boolean = false;

  /** Which register a read of the command port returns (set by OCW3). Default IRR. */
  private readSelector: 'irr' | 'isr' = 'irr';

  private readonly commandPort: number;
  private readonly dataPort: number;
  private readonly warn: (msg: string) => void;

  constructor(
    private readonly controller: InterruptController,
    options: PIC8259Options = {},
  ) {
    this.commandPort = options.commandPort ?? 0x20;
    this.dataPort = options.dataPort ?? 0x21;
    this.warn = options.warn ?? (() => { /* silent */ });
    if (this.dataPort !== this.commandPort + 1) {
      // Real 8259s use adjacent ports; our IOBus registration assumes a
      // contiguous range. Reject the unusual configurations early.
      throw new Error(
        `PIC8259: dataPort (0x${this.dataPort.toString(16)}) must be ` +
        `commandPort + 1 (0x${(this.commandPort + 1).toString(16)})`,
      );
    }
  }

  // ============================================================
  // PortHandler implementation — IOBus wires reads/writes here.
  // ============================================================

  readByte(port: number): Byte {
    if (port === this.commandPort) {
      return this.readSelector === 'isr' ? this.isr : this.irr;
    }
    if (port === this.dataPort) {
      return this.imr;
    }
    // Unreachable as long as the IOBus only routes our registered range
    // here, but a defensive open-bus return matches the bus's policy.
    return 0xFF;
  }

  writeByte(port: number, value: Byte): void {
    const v = value & 0xFF;
    if (port === this.commandPort) {
      this.writeCommand(v);
      return;
    }
    if (port === this.dataPort) {
      this.writeData(v);
      return;
    }
    // Unreachable in normal operation; ignore.
  }

  // ============================================================
  // Convenience: register on an IOBus.
  // ============================================================

  /**
   * Reserve `[commandPort, dataPort]` on the bus and route all four port
   * accesses at those addresses through this PIC. Call once at machine
   * setup. Throws (via the bus) if those ports are already claimed.
   */
  registerOn(bus: IOBus): void {
    bus.register({ start: this.commandPort, end: this.dataPort }, this);
  }

  /**
   * Power-on reset: returns the PIC to its post-construction state. Equivalent
   * to constructing a fresh `PIC8259` with the same options:
   *
   *   - IRR / ISR cleared, IMR back to 0xFF (everything masked).
   *   - Vector base back to 0.
   *   - Init state machine returned to `'idle'` (so software must reissue
   *     ICW1 → ICW2 → … to use the chip again, just like real silicon
   *     after the /RES line is asserted).
   *   - Read-register selector back to IRR.
   *
   * The `controller` reference and port assignments are preserved (those
   * are construction-time wiring, not chip state).
   */
  reset(): void {
    this.irr = 0;
    this.isr = 0;
    this.imr = 0xFF;
    this.vectorBase = 0;
    this.initState = 'idle';
    this.expectIcw3 = false;
    this.expectIcw4 = false;
    this.levelTriggered = false;
    this.readSelector = 'irr';
  }

  // ============================================================
  // Device-side API (called by IRQ sources, e.g. PIT, keyboard).
  // ============================================================

  /**
   * Assert IRQ line `n` (0..7).
   *
   * - For both edge- and level-triggered modes (per ICW1 bit 3), this
   *   sets bit n of IRR. We don't model the rising-edge detector at a
   *   finer grain than "the device called assertIRQ" — devices are
   *   responsible for not spamming `assertIRQ` repeatedly when the line
   *   is supposed to be already high. Real silicon's edge-vs-level
   *   distinction matters mainly for EOI behaviour with continuously
   *   asserted lines (level-triggered: re-fires automatically; edge:
   *   needs a fresh edge). In our simulation that distinction would
   *   only matter if a future device modeled "line stays high through
   *   service"; we'll add that nuance when a device needs it.
   */
  assertIRQ(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 7) {
      throw new Error(`assertIRQ(${n}): IRQ line must be integer 0..7`);
    }
    this.irr |= (1 << n);
    this.updatePending();
  }

  /**
   * De-assert IRQ line `n` (0..7).
   *
   * - In level-triggered mode this clears bit n of IRR (the line dropped
   *   before the PIC managed to forward the request to the CPU, so the
   *   request is withdrawn). If the IRQ has already moved to ISR, the
   *   ISR bit is unaffected — the CPU is already handling that one and
   *   only EOI clears ISR.
   * - In edge-triggered mode this is a no-op. The request was latched
   *   at the rising edge; the level going low afterwards doesn't undo it.
   */
  deassertIRQ(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 7) {
      throw new Error(`deassertIRQ(${n}): IRQ line must be integer 0..7`);
    }
    if (this.levelTriggered) {
      this.irr &= ~(1 << n);
    }
  }

  // ============================================================
  // Inspection helpers — handy for tests, not used at runtime.
  // ============================================================

  getIRR(): number { return this.irr; }
  getISR(): number { return this.isr; }
  getIMR(): number { return this.imr; }
  getVectorBase(): number { return this.vectorBase; }
  getInitState(): InitState { return this.initState; }
  getReadSelector(): 'irr' | 'isr' { return this.readSelector; }

  // ============================================================
  // Internals — the writes split into helpers for readability.
  // ============================================================

  /**
   * Write to the command port (0x20 by default).
   *
   * Decoded by bits [4,3]:
   *   - bit 4 = 1            → ICW1 (init or re-init)
   *   - bit 4 = 0, bit 3 = 0 → OCW2 (EOI / priority commands)
   *   - bit 4 = 0, bit 3 = 1 → OCW3 (read-register select / poll / mask)
   */
  private writeCommand(v: Byte): void {
    if ((v & 0x10) !== 0) {
      this.startInit(v);
      return;
    }
    if (this.initState !== 'idle') {
      // Mid-init, the data port carries ICW2/3/4. A non-ICW1 write to the
      // command port mid-sequence is undefined behaviour on real silicon.
      // Warn and ignore.
      this.warn(`PIC: command-port write 0x${v.toString(16)} ignored — init in progress (state=${this.initState})`);
      return;
    }
    if ((v & 0x08) === 0) {
      this.handleOcw2(v);
    } else {
      this.handleOcw3(v);
    }
  }

  /**
   * Write to the data port (0x21 by default).
   *
   *   - During init: ICW2 / ICW3 / ICW4 depending on `initState`.
   *   - When idle: OCW1 (IMR write).
   */
  private writeData(v: Byte): void {
    switch (this.initState) {
      case 'awaitingIcw2': this.handleIcw2(v); return;
      case 'awaitingIcw3': this.handleIcw3(v); return;
      case 'awaitingIcw4': this.handleIcw4(v); return;
      case 'idle':
        this.imr = v & 0xFF;
        this.updatePending();
        return;
    }
  }

  // ---- Initialisation (ICW1 → ICW2 → ICW3? → ICW4? → idle) ----

  private startInit(icw1: Byte): void {
    // ICW1 bit decoding (per Intel datasheet):
    //   bit 4: 1 (init signal — caller already verified this)
    //   bit 3: 1 = level-triggered, 0 = edge-triggered
    //   bit 1: 1 = single PIC (no ICW3), 0 = cascade (expect ICW3)
    //   bit 0: 1 = ICW4 will be sent, 0 = no ICW4
    // Bits 2, 5, 6, 7 are MCS-80/85 mode bits and don't apply to 8086 mode.
    this.expectIcw3 = (icw1 & 0x02) === 0; // bit 1 inverted: 0 means cascade
    this.expectIcw4 = (icw1 & 0x01) !== 0;
    this.levelTriggered = (icw1 & 0x08) !== 0;
    if (this.expectIcw3) {
      // Single-PIC v0: we accept the cascade-mode signal so the state
      // machine consumes ICW3, but we don't model master/slave routing.
      // Software written for a cascaded pair will program both PICs and
      // expect IRQs 8..15 on the slave; for now we treat the (master)
      // PIC as if it were single, just consuming the byte. A future brief
      // adds the second PIC and the cascade plumbing.
      this.warn('PIC: ICW1 cascade mode — treated as single PIC for v0');
    }
    // Real hardware also clears IRR's edge-detect latches and resets
    // priority assignments. For v0 our IRR is a plain bitmask without
    // edge-detect state, and priority is fixed (IRQ 0 highest). We do
    // mask everything (IMR = 0xFF) and clear ISR per the brief — IRR
    // is left intact so an IRQ asserted before init eventually delivers
    // when software unmasks it.
    this.imr = 0xFF;
    this.isr = 0;
    this.readSelector = 'irr';
    this.initState = 'awaitingIcw2';
  }

  private handleIcw2(v: Byte): void {
    // Low 3 bits are forced to zero by hardware (the IRQ number replaces
    // them at delivery). Software typically writes them as zero, but we
    // mask defensively.
    this.vectorBase = v & 0xF8;
    this.advancePastIcw2();
  }

  private advancePastIcw2(): void {
    if (this.expectIcw3) {
      this.initState = 'awaitingIcw3';
    } else if (this.expectIcw4) {
      this.initState = 'awaitingIcw4';
    } else {
      this.initState = 'idle';
    }
  }

  private handleIcw3(_v: Byte): void {
    // ICW3 describes cascade wiring (which IRQ line connects to a slave on
    // a master, or this slave's ID on a slave). Single-PIC v0 ignores the
    // value but consumes the byte to keep the state machine honest.
    if (this.expectIcw4) {
      this.initState = 'awaitingIcw4';
    } else {
      this.initState = 'idle';
    }
  }

  private handleIcw4(v: Byte): void {
    // bit 0: 1 = 8086/8088 mode, 0 = MCS-80/85 mode
    // bit 1: 1 = auto-EOI, 0 = normal EOI
    // bits 2..3: buffered-mode flags (we don't simulate the buffered bus)
    // bit 4: special-fully-nested (cascading; out of scope)
    if ((v & 0x01) === 0) {
      this.warn('PIC: ICW4 bit 0 = 0 (MCS-80/85 mode) — only 8086 mode is supported');
    }
    if ((v & 0x02) !== 0) {
      this.warn('PIC: ICW4 bit 1 = 1 (auto-EOI) — auto-EOI is not supported, treating as normal EOI');
    }
    if ((v & 0x10) !== 0) {
      this.warn('PIC: ICW4 bit 4 = 1 (special fully nested) — cascading is out of scope, ignored');
    }
    this.initState = 'idle';
  }

  // ---- OCW2: EOI and priority commands ----

  private handleOcw2(v: Byte): void {
    // bit 5 (EOI), bit 6 (specific), bit 7 (rotate)
    const eoi = (v & 0x20) !== 0;
    const specific = (v & 0x40) !== 0;
    const rotate = (v & 0x80) !== 0;
    if (rotate) {
      this.warn('PIC: OCW2 rotate-priority commands are not supported, ignored');
      return;
    }
    if (!eoi) {
      // No EOI bit + no rotate: this is a no-op encoding (bits 5..7 = 000).
      // Real PICs use that encoding for "rotate in auto-EOI clear" with
      // the rotate bit set, which we already rejected above.
      this.warn(`PIC: OCW2 0x${v.toString(16)} not supported, ignored`);
      return;
    }
    if (!specific) {
      // Non-specific EOI: clear the highest-priority bit (lowest IRQ #) in ISR.
      if (this.isr === 0) return;            // EOI with no in-service IRQ: documented no-op
      const n = lowestSetBit(this.isr);
      this.isr &= ~(1 << n);
    } else {
      // Specific EOI: low 3 bits identify the IRQ to clear.
      const n = v & 0x07;
      this.isr &= ~(1 << n);
    }
    this.updatePending();
  }

  // ---- OCW3: register-read selector (and other unsupported features) ----

  private handleOcw3(v: Byte): void {
    // Caller already verified bit 4 = 0, bit 3 = 1.
    // bits 0..1: read-register command (10 = read IRR, 11 = read ISR)
    // bit 2: poll command (we don't support poll mode)
    // bits 5..6: special-mask command (we don't support special mask)
    if ((v & 0x04) !== 0) {
      this.warn('PIC: OCW3 poll mode is not supported, ignored');
    }
    if ((v & 0x40) !== 0) {
      this.warn('PIC: OCW3 special-mask command is not supported, ignored');
    }
    if ((v & 0x02) !== 0) {
      // RR bit set
      this.readSelector = (v & 0x01) !== 0 ? 'isr' : 'irr';
    }
    // RR=0: leave selector as-is (this is the "no-op for read-register" encoding).
  }

  // ---- Serviceability check ----

  /**
   * Decide whether any IRQ should now be raised to the CPU.
   *
   *   1. `pending = IRR & ~IMR` — lines asserted and not masked.
   *   2. If ISR is empty, pick the highest-priority pending bit (lowest #).
   *      Otherwise only pick if its priority is *higher* than the
   *      highest-priority bit currently in service. Equal priority can
   *      never happen (a bit can't be in both IRR and ISR after we move
   *      it across), so "strictly higher than the lowest ISR bit" is the
   *      right test.
   *   3. Move the chosen bit from IRR to ISR and call `controller.raise`.
   *
   * Called after every state change that could affect serviceability:
   * assertIRQ, IMR write, EOI. Crucially: every path goes through here
   * exactly once per change, so the "raise no more than one IRQ at a time"
   * invariant is enforced structurally.
   *
   * No-op while init is in progress — software hasn't told us the vector
   * base yet, and the brief calls for IRQs to wait until init completes.
   */
  private updatePending(): void {
    if (this.initState !== 'idle') return;
    const pending = this.irr & ~this.imr & 0xFF;
    if (pending === 0) return;

    const candidate = lowestSetBit(pending);
    if (this.isr !== 0) {
      const inServiceTop = lowestSetBit(this.isr);
      if (candidate >= inServiceTop) {
        // Lower or equal priority than the in-service top — wait for EOI.
        return;
      }
    }
    // Move IRR → ISR and forward to the CPU's controller.
    this.irr &= ~(1 << candidate);
    this.isr |= (1 << candidate);
    this.controller.raise((this.vectorBase + candidate) & 0xFF);
  }
}

/** Index of the lowest set bit, 0..7. Caller must check `mask !== 0`. */
function lowestSetBit(mask: number): number {
  // Plain loop is fast enough for an 8-bit mask and avoids the BigInt /
  // Math.log2 corner cases. For a 16-bit slave PIC later, same shape works.
  for (let i = 0; i < 8; i++) {
    if ((mask & (1 << i)) !== 0) return i;
  }
  // Unreachable: caller guarantees mask !== 0.
  return -1;
}

/** Re-exported for tests / typing convenience. */
export type { Word, Byte };
