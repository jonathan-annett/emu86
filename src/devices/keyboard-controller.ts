import type { Byte } from '../core/types.js';
import type { IOBus, PortHandler } from '../core/io.js';

/**
 * Headless 8042 PS/2 keyboard controller — Phase 4.
 *
 * The 8042 sits between the keyboard (and an optional PS/2 aux/mouse channel)
 * and the host CPU. It exposes two ports on a PC:
 *
 *   - 0x60 (data): byte stream to/from the keyboard, plus configuration
 *     bytes belonging to the controller itself (the "command byte" and
 *     the output port P2).
 *   - 0x64 (status/command): status bits on read; command byte on write.
 *
 * What this implementation models — and, importantly, what it does NOT.
 *
 * **Headless.** No real keyboard is plumbed in. There is no scancode
 * source, the controller never raises IRQ 1, and reading port 0x60 with
 * no buffered byte returns 0x00. The only reason this device exists at
 * Phase 4 is to unblock ELKS Setup's "drain the keyboard buffer, then
 * enable A20" sequence — which polls bit 0 of port 0x64 (OBF) waiting
 * for it to clear, and which our previous open-bus 0xFF kept stuck
 * forever.
 *
 * **A20 acceptance, not A20 enforcement.** Writes to the output port (P2)
 * via the 0xD1 command sequence flip an internal `a20Enabled` flag. That
 * flag is observable for tests but does NOT mask bit 20 of any memory
 * address — the address mask in `PagedMemory` stays at 0xFFFFF (1 MiB).
 * Real A20 modeling matters once the address space exceeds 1 MiB
 * (80286+ with HMA, etc.); when we tackle that, the A20 plumbing here
 * is what the memory mask should consume. Documented in
 * `PS2_A20_REPORT.md`.
 *
 * **Default state: A20 enabled.** Real BIOSes vary — original IBM AT
 * leaves A20 disabled until the OS enables it; some clones leave it
 * enabled after POST. ELKS Setup explicitly enables it, so the choice
 * has no effect on the boot path. We default to enabled because some
 * early-boot code paths in other OSes assume it.
 *
 * **Command set.** Only the commands ELKS demonstrably issues, plus a
 * handful of common bracketing commands (self-test, read/write command
 * byte, enable/disable keyboard, A20-related output-port writes). Any
 * unrecognised command produces a `warn` callback and is otherwise
 * ignored — same "warn and proceed" pattern used by `PIC8259` and
 * `PIT8254`.
 *
 * **Pulse-reset (0xFE) is a no-op.** On real hardware, command 0xFE
 * pulses bit 0 of P2 low, which is wired to the CPU's RESET line, so the
 * machine reboots. We log and ignore — actually resetting the emulator
 * mid-run would defeat any meaningful trace.
 */

export interface KeyboardController8042Options {
  /** Optional warning sink for unsupported commands. Default: silent. */
  warn?: (msg: string) => void;
  /**
   * Callback fired on the empty → full transition of the output buffer
   * (i.e., when a queued scancode becomes visible to the CPU). The
   * machine wires this to `pic.assertIRQ(1)` so the keyboard IRQ is
   * raised the same way a real 8042 would. Default: silent (tests can
   * call `injectScancode` without an IRQ wired).
   *
   * The controller fires this once per OBF-empty-to-full transition: a
   * burst of injected scancodes raises IRQ 1 once for the first byte,
   * then again every time the CPU drains the buffer and another queued
   * byte takes its place. This matches real 8042 behaviour where each
   * delivered byte produces one falling edge on the IRQ 1 line.
   */
  onIRQ1?: () => void;
}

/**
 * Tracks what the *next* write to port 0x60 means. After a 0xD1 command
 * to 0x64, for example, the next byte written to 0x60 is the new P2
 * value, NOT a keyboard scancode. After that single byte the state
 * machine returns to the default ("data going to the keyboard").
 */
type NextDataWrite = 'keyboard' | 'commandByte' | 'outputPort' | 'aux';

/**
 * Default command byte after reset. Bits chosen to look like a sane
 * post-POST 8042:
 *
 *   bit 0 = 1   keyboard interrupt enabled (we don't actually fire IRQ 1)
 *   bit 1 = 0   aux interrupt disabled
 *   bit 2 = 1   system flag set (POST passed)
 *   bit 3 = 0   reserved
 *   bit 4 = 0   keyboard NOT disabled (so "enabled" — bit is active-low)
 *   bit 5 = 1   aux disabled (no PS/2 mouse modeled)
 *   bit 6 = 1   scancode translation on (PC-AT default)
 *   bit 7 = 0   reserved
 *
 * Hex: 0b01100101 = 0x65.
 */
const DEFAULT_COMMAND_BYTE = 0x65;

/**
 * Default output port (P2) after reset. Bit 1 = A20 enabled. Bit 0 = 1
 * (system reset is active-low, so 1 = "not asserting reset"). The other
 * bits are unused in our model.
 */
const DEFAULT_OUTPUT_PORT = 0x03;

/**
 * Status byte bits emitted by reads of port 0x64.
 *
 *   bit 0  OBF              output buffer has a byte the CPU can read
 *   bit 1  IBF              input buffer holds a byte the controller hasn't processed
 *   bit 2  system flag      set after self-test pass; we keep it set
 *   bit 3  command/data     0 = last write to 0x60 (data), 1 = last write to 0x64 (command)
 *   bit 4  keyboard enabled tied to !commandByte.bit4 — we keep it 1
 *   bit 5  aux OBF          1 if the byte in OBF came from aux. We never set this.
 *   bit 6  timeout error    0 (we never time out)
 *   bit 7  parity error     0 (we never observe a parity error)
 */
const STATUS_OBF = 0x01;
const STATUS_IBF = 0x02;
const STATUS_SYSTEM_FLAG = 0x04;
const STATUS_LAST_WRITE_WAS_CMD = 0x08;
const STATUS_KEYBOARD_ENABLED = 0x10;

export class KeyboardController8042 implements PortHandler {
  // ---- output buffer (the byte port 0x60 read returns) ----
  private _outputBuffer: number = 0;
  private _outputBufferFull: boolean = false;

  // ---- the "input buffer full" status bit. Mostly stays 0 in headless. ----
  private _inputBufferFull: boolean = false;

  // ---- last-write-was-command bit (status bit 3). ----
  private _lastWriteWasCommand: boolean = false;

  // ---- state machine for "what does the next 0x60 write mean?" ----
  private _nextDataWriteIs: NextDataWrite = 'keyboard';

  // ---- internal config registers ----
  private _commandByte: number = DEFAULT_COMMAND_BYTE;
  private _outputPort: number = DEFAULT_OUTPUT_PORT;

  /** Cached A20 flag derived from `_outputPort`. */
  private _a20Enabled: boolean = (DEFAULT_OUTPUT_PORT & 0x02) !== 0;

  /**
   * Host-side queue of scancodes waiting to enter the output buffer.
   * The 8042's "output buffer" is a single byte; bursts that arrive
   * faster than the CPU drains them sit here until OBF clears.
   */
  private readonly _scancodeQueue: number[] = [];

  private readonly warn: (msg: string) => void;
  private readonly onIRQ1: () => void;

  constructor(options: KeyboardController8042Options = {}) {
    this.warn = options.warn ?? (() => { /* silent */ });
    this.onIRQ1 = options.onIRQ1 ?? (() => { /* silent */ });
  }

  // ============================================================
  // Bus registration
  // ============================================================

  /**
   * Register on the IOBus at ports 0x60 (data) and 0x64 (status/command).
   *
   * Two single-port registrations rather than one [0x60..0x64] range so
   * we don't silently claim 0x61-0x63 (which on a real PC are the system
   * control port, NMI mask, etc. — likely to host future devices).
   */
  registerOn(bus: IOBus): void {
    bus.register({ start: 0x60, end: 0x60 }, this);
    bus.register({ start: 0x64, end: 0x64 }, this);
  }

  // ============================================================
  // PortHandler implementation
  // ============================================================

  readByte(port: number): Byte {
    if (port === 0x60) return this.readData();
    if (port === 0x64) return this.readStatus();
    // The bus only routes our registered ports here, but be defensive.
    return 0xFF;
  }

  writeByte(port: number, value: Byte): void {
    const v = value & 0xFF;
    if (port === 0x60) {
      this.writeData(v);
      return;
    }
    if (port === 0x64) {
      this.writeCommand(v);
      return;
    }
    // Unreachable in normal operation; ignore.
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Power-on reset. Returns the controller to its post-construction state.
   * Clears any buffered output byte; restores the default command byte
   * and output port (so A20 returns to enabled).
   */
  reset(): void {
    this._outputBuffer = 0;
    this._outputBufferFull = false;
    this._inputBufferFull = false;
    this._lastWriteWasCommand = false;
    this._nextDataWriteIs = 'keyboard';
    this._commandByte = DEFAULT_COMMAND_BYTE;
    this._outputPort = DEFAULT_OUTPUT_PORT;
    this._a20Enabled = (DEFAULT_OUTPUT_PORT & 0x02) !== 0;
    this._scancodeQueue.length = 0;
  }

  // ============================================================
  // Scancode injection (Phase 7 — host-driven keyboard input)
  // ============================================================

  /**
   * Queue a scancode for delivery to the CPU. If the output buffer is
   * empty the byte goes straight in and OBF rises (firing IRQ 1 if a
   * callback is wired); otherwise it joins the host-side queue and
   * surfaces when the CPU next drains the buffer by reading port 0x60.
   *
   * Scancodes are bytes in PC/AT set 1 — see `ScancodeTranslator` for
   * the host-side stdin → scancode mapping. The controller does not
   * interpret them, so multi-byte sequences (Ctrl-modifier wrapping,
   * E0-prefixed extended scancodes) work just as well as single bytes
   * provided the caller delivers them in order.
   */
  injectScancode(byte: number): void {
    const v = byte & 0xFF;
    if (this._outputBufferFull) {
      this._scancodeQueue.push(v);
      return;
    }
    this._outputBuffer = v;
    this._outputBufferFull = true;
    this.onIRQ1();
  }

  /**
   * Convenience for delivering a multi-byte sequence (e.g., a Ctrl-A
   * combo: Ctrl-down, 'a', 'a'-release, Ctrl-up). The first byte that
   * lands in an empty output buffer raises IRQ 1; later bytes wait in
   * the queue and raise IRQ 1 again as the CPU drains them one at a
   * time.
   */
  injectScancodes(bytes: Iterable<number>): void {
    for (const b of bytes) this.injectScancode(b);
  }

  /** Number of scancodes still waiting in the host-side queue. */
  get pendingScancodeCount(): number {
    return this._scancodeQueue.length;
  }

  // ============================================================
  // Inspection helpers (tests + diagnostics)
  // ============================================================

  get a20Enabled(): boolean { return this._a20Enabled; }
  get outputPort(): number { return this._outputPort; }
  get commandByte(): number { return this._commandByte; }
  get outputBufferFull(): boolean { return this._outputBufferFull; }

  // ============================================================
  // Internals
  // ============================================================

  private readData(): Byte {
    if (this._outputBufferFull) {
      const v = this._outputBuffer & 0xFF;
      this._outputBufferFull = false;
      this._outputBuffer = 0;
      // Promote the next queued scancode if the host has more pending.
      // OBF goes empty → full again, so IRQ 1 fires for the new byte
      // exactly as a real 8042 would on the next falling edge from the
      // keyboard line.
      const next = this._scancodeQueue.shift();
      if (next !== undefined) {
        this._outputBuffer = next & 0xFF;
        this._outputBufferFull = true;
        this.onIRQ1();
      }
      return v;
    }
    // No byte queued. Real hardware varies — many controllers return 0
    // (or the last byte read), some return 0xFF. We pick 0x00 because
    // it's the least surprising "no scancode here" indicator. The
    // important invariant is that OBF (status bit 0) stays 0, which is
    // what unblocks ELKS Setup's drain loop.
    return 0x00;
  }

  private readStatus(): Byte {
    let s = 0;
    if (this._outputBufferFull) s |= STATUS_OBF;
    if (this._inputBufferFull) s |= STATUS_IBF;
    s |= STATUS_SYSTEM_FLAG;
    if (this._lastWriteWasCommand) s |= STATUS_LAST_WRITE_WAS_CMD;
    // Keyboard-enabled bit: bit 4 of the command byte is "keyboard
    // *disabled*" (active-low), so the status bit is its inverse.
    if ((this._commandByte & 0x10) === 0) s |= STATUS_KEYBOARD_ENABLED;
    return s & 0xFF;
  }

  private writeData(value: Byte): void {
    this._lastWriteWasCommand = false;
    const target = this._nextDataWriteIs;
    // Reset to default *before* dispatch so any handler that wants to
    // arm a new transition can do so without us clobbering it.
    this._nextDataWriteIs = 'keyboard';
    switch (target) {
      case 'commandByte':
        this._commandByte = value & 0xFF;
        return;
      case 'outputPort':
        this.writeOutputPort(value & 0xFF);
        return;
      case 'aux':
        // No PS/2 aux/mouse channel modeled. Discard silently — guests
        // that probe for a mouse will see the absence elsewhere.
        return;
      case 'keyboard':
      default:
        // Real hardware would forward this byte to the keyboard. We have
        // no keyboard to forward to. Log so unexpected commands surface
        // in the trace; otherwise discard.
        this.warn(`8042: data 0x${value.toString(16)} written to keyboard, discarded (headless)`);
        return;
    }
  }

  private writeCommand(cmd: Byte): void {
    this._lastWriteWasCommand = true;
    switch (cmd) {
      case 0x20: // Read command byte → load OBF with current command byte
        this.loadOutputBuffer(this._commandByte);
        return;
      case 0x60: // Write command byte: next 0x60 write is the new value
        this._nextDataWriteIs = 'commandByte';
        return;
      case 0xA7: // Disable aux device — no aux modeled, no-op
        return;
      case 0xA8: // Enable aux device — no aux modeled, no-op
        return;
      case 0xA9: // Test aux device → 0x00 (no error)
        this.loadOutputBuffer(0x00);
        return;
      case 0xAA: // Self-test → 0x55 (pass)
        this.loadOutputBuffer(0x55);
        return;
      case 0xAB: // Test keyboard line → 0x00 (no error)
        this.loadOutputBuffer(0x00);
        return;
      case 0xAD: // Disable keyboard (set bit 4 of command byte)
        this._commandByte |= 0x10;
        return;
      case 0xAE: // Enable keyboard (clear bit 4 of command byte)
        this._commandByte &= ~0x10 & 0xFF;
        return;
      case 0xC0: // Read input port (P1) → plausible default 0x00
        this.loadOutputBuffer(0x00);
        return;
      case 0xD0: // Read output port (P2) → load current value
        this.loadOutputBuffer(this._outputPort);
        return;
      case 0xD1: // Write output port (P2) — A20 enable path
        this._nextDataWriteIs = 'outputPort';
        return;
      case 0xD2: // Write keyboard output buffer (simulates key event)
        this._nextDataWriteIs = 'keyboard';
        return;
      case 0xD3: // Write aux output buffer — ignored (no aux)
        this._nextDataWriteIs = 'aux';
        return;
      case 0xD4: // Write to aux device — ignored (no aux)
        this._nextDataWriteIs = 'aux';
        return;
      case 0xE0: // Read test inputs → 0x00
        this.loadOutputBuffer(0x00);
        return;
      default:
        if (cmd >= 0xF0 && cmd <= 0xFF) {
          // Pulse output port. The canonical 0xFE (pulse bit 0 low) is a
          // CPU reset on real PCs. We log and ignore — actually resetting
          // mid-run would destroy the trace and serve no purpose here.
          this.warn(`8042: pulse output port command 0x${cmd.toString(16)} ignored (reset out of scope)`);
          return;
        }
        this.warn(`8042: unknown command 0x${cmd.toString(16)} ignored`);
        return;
    }
  }

  private writeOutputPort(value: Byte): void {
    this._outputPort = value & 0xFF;
    this._a20Enabled = (this._outputPort & 0x02) !== 0;
    // Bit 0 low would be a system reset on real hardware; we intentionally
    // don't act on it. Bit 4 / 5 carry IBF / OBF interrupt info on some
    // 8042 revisions, but ELKS doesn't drive them and we don't model them.
  }

  /** Load a byte into the output buffer and set OBF. Used by self-test, read-cmd, etc. */
  private loadOutputBuffer(value: Byte): void {
    this._outputBuffer = value & 0xFF;
    this._outputBufferFull = true;
  }
}
