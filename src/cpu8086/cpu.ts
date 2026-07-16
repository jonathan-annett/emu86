import { Flags } from '../core/flags.js';
import { NullIOBus, type IOBus } from '../core/io.js';
import { Registers, type RegisterSnapshot } from '../core/registers.js';
import { linearAddress, type Byte, type LinearAddress, type Word } from '../core/types.js';
import { NullInterruptController, type InterruptController } from '../interrupts/controller.js';
import type { Memory } from '../memory/memory.js';
import { InvalidOpcodeError } from './errors.js';
import { serviceInterrupt } from './opcodes-int.js';
import { OPCODE_TABLE } from './opcodes.js';
import type { TrapRegistry } from './trap-registry.js';
// Side-effect imports: each opcode module self-registers its handlers into
// OPCODE_TABLE on load. Listing them here ensures the registrations happen
// before any CPU8086 instance is constructed.
import './opcodes-alu.js';
import './opcodes-arith.js';
import './opcodes-bcd.js';
import './opcodes-int.js';
import './opcodes-io.js';
import './opcodes-stack.js';
import './opcodes-jumps.js';
import './opcodes-lea.js';
import './opcodes-misc.js';
import './opcodes-misc2.js';
import './opcodes-mov.js';
import './opcodes-shift.js';
import './opcodes-string.js';

/**
 * Full CPU state snapshot, for debugging, breakpoints, and future use by the
 * interrupt service boundary. Cheap to produce (~30 bytes of copy).
 */
export interface CPUSnapshot {
  readonly regs: RegisterSnapshot;
  readonly flags: Word;
  readonly halted: boolean;
  readonly segOverride: SegmentOverride;
  /**
   * The one-instruction interrupt-inhibit window (STI / POP SS / MOV SS).
   * Legal cross-boundary state — a snapshot taken right after an STI that
   * set it must restore with it set, or the very next boundary check
   * services an interrupt real silicon would have held off. Missing from
   * the snapshot for 13 phases (found by Phase 18 recon); `repPrefix` by
   * contrast is set and cleared inside a single `step()` dispatch and can
   * never be non-null at a boundary, so it stays out.
   */
  readonly interruptInhibit: boolean;
}

export type SegmentOverride = 0 | 1 | 2 | 3 | null;  // ES | CS | SS | DS | none

/**
 * 8086 CPU core.
 *
 * Executes one instruction per `step()` call, synchronously. The class
 * holds no async methods by design — everything that could await (device
 * I/O, write-back persistence, interrupt delivery from async sources) is
 * the run loop's concern, not this one.
 *
 * Memory is read through the injected {@link Memory} instance. In v0 that's
 * a {@link PagedMemory}, but the CPU never depends on that concretely —
 * anything satisfying the interface works (useful for targeted tests that
 * want to instrument every access).
 */
export class CPU8086 {
  readonly regs = new Registers();
  readonly flags = new Flags();
  readonly memory: Memory;
  readonly io: IOBus;
  readonly intCtrl: InterruptController;
  /**
   * Optional trap registry. When present, the CPU consults it at the top of
   * every `step()` (before the instruction fetch). A registered handler at
   * the current linear `CS:IP` runs first; the CPU then fetches and executes
   * whatever instruction is actually at that address. Phase 2 uses this to
   * implement BIOS services in JS while the guest sees normal `INT` / `IRET`.
   *
   * Default is `undefined` — the empty-registry case is effectively free
   * (one optional-chained `Map.get` per instruction on a `Map<number, …>`
   * that doesn't even exist). Existing tests construct the CPU without a
   * registry and remain unchanged.
   */
  readonly traps: TrapRegistry | undefined;

  /** Set by HLT; the run loop checks this to stop stepping. */
  halted = false;

  /**
   * One-instruction interrupt-inhibit window. Set by STI, POP SS, and
   * MOV SS,r/m to suppress maskable interrupt service for the duration
   * of the *very next* instruction-boundary check after the setter ran.
   *
   *   - STI sets it so that `STI; RET` doesn't get interrupted between
   *     the STI and the RET — the classic "delayed enable" tail used at
   *     the end of an interrupt service routine.
   *   - POP SS / MOV SS set it so the next instruction (typically a
   *     load of SP) can complete before any interrupt fires; an interrupt
   *     between an SS write and a matching SP write would push to a
   *     half-loaded SS:SP and corrupt state.
   *
   * Single flag covers all three cases. NMI bypasses this flag — see the
   * boundary-check logic in `step()`. The flag clears at the end of each
   * `step()`, AFTER the boundary check, so the setter's "set during this
   * step" affects the NEXT step's check (and only that one).
   */
  interruptInhibit = false;

  /**
   * Segment override for the next memory access. Reset to null at the start
   * of each `step()`. In v0 no handler uses this yet; it'll come in when we
   * add the 0x26/0x2E/0x36/0x3E prefix opcodes.
   */
  segOverride: SegmentOverride = null;

  /**
   * Active REP/REPNZ prefix state, set by the 0xF3/0xF2 handler before it
   * dispatches the next opcode. Null when no REP is in flight. String ops
   * don't consult this directly (the REP handler runs them in a loop) —
   * but IDIV reads it to apply the silicon quirk that REP-IDIV negates the
   * quotient (verified against SST corpus). Cleared after the inner op.
   */
  repPrefix: 'F2' | 'F3' | null = null;

  constructor(
    memory: Memory,
    io: IOBus = new NullIOBus(),
    intCtrl: InterruptController = NullInterruptController,
    traps?: TrapRegistry,
  ) {
    this.memory = memory;
    this.io = io;
    this.intCtrl = intCtrl;
    this.traps = traps;
  }

  /** Reset to power-on state. CS:IP = FFFF:0000, which on a real PC jumped
   *  into the ROM BIOS. Here it's just where fetching starts after reset. */
  reset(): void {
    this.regs.reset();
    this.flags.reset();
    this.regs.CS = 0xFFFF;
    this.regs.IP = 0x0000;
    this.halted = false;
    this.segOverride = null;
    this.interruptInhibit = false;
  }

  // ============================================================
  // Main entry point
  // ============================================================

  /**
   * Execute one instruction.
   *
   * Boundary actions performed at the top of every step:
   *   1. Halt break: NMI always wakes; a maskable wakes iff IF=1 and the
   *      inhibit window isn't active.
   *   2. Pending-interrupt service (NMI takes priority over maskable).
   *      Service runs `serviceInterrupt`, which pushes flags+CS+IP, clears
   *      IF/TF, and far-jumps through the IVT. We then fall through to
   *      fetch+dispatch — which fetches the *first* instruction of the
   *      handler at the new CS:IP. (Interrupts service "between"
   *      instructions, not "instead of" one.)
   *   3. Clear the inhibit window. The clear happens AFTER the boundary
   *      check so the setter (STI/POP SS/MOV SS) running in the previous
   *      step's dispatch suppresses exactly THIS step's interrupt check
   *      and no other.
   *
   * If halted with no servicable interrupt, returns without doing anything;
   * the run loop is responsible for yielding so async sources can run.
   */
  step(): void {
    // 1. Halt break + 2. boundary service. Combined into one decision point
    //    so the wake conditions and the service conditions stay in lock-step.
    const ctrl = this.intCtrl;
    const nmiPending = ctrl.hasNMI();
    const maskableServicable =
      ctrl.hasMaskable() && this.flags.IF && !this.interruptInhibit;

    if (this.halted) {
      if (nmiPending || maskableServicable) {
        this.halted = false;
      } else {
        // Stay halted. Don't clear interruptInhibit — leaving it set is
        // harmless because nothing will service while halted, and clearing
        // it across a halt boundary would silently lengthen the inhibit
        // window beyond one instruction in pathological setups.
        return;
      }
    }

    if (nmiPending) {
      ctrl.consumeNMI();
      serviceInterrupt(this, 2);
    } else if (maskableServicable) {
      const vec = ctrl.consumeMaskable();
      serviceInterrupt(this, vec);
    }

    // 3. Clear the inhibit window now that the boundary check is done. Any
    //    setter that fires later in this step's dispatch (STI, POP SS, MOV
    //    SS,r/m) will set it again and the NEXT step's check will see it.
    this.interruptInhibit = false;

    this.segOverride = null;

    // 4. Trap check. If a JS handler is registered at the current linear
    //    CS:IP, run it before fetching the instruction. The CPU then
    //    proceeds to fetch and execute whatever is actually at CS:IP —
    //    the handler is "before", not "instead of". A handler that
    //    modifies CS:IP simply means the next iteration sees a new IP and
    //    (correctly) doesn't re-trigger the same trap. Halted CPUs bail
    //    out above before reaching here, so traps never fire in halt-spin.
    if (this.traps !== undefined) {
      const linearIP = (this.regs.CS << 4) + this.regs.IP;
      const handler = this.traps.get(linearIP);
      if (handler !== undefined) {
        handler(this);
      }
    }

    const opcode = this.fetchByte();
    const handler = OPCODE_TABLE[opcode];
    if (!handler) {
      // IP is already advanced past the opcode; back it up for the error
      // so the reported address is the opcode itself.
      const ip = (this.regs.IP - 1) & 0xFFFF;
      throw new InvalidOpcodeError(opcode, this.regs.CS, ip);
    }
    handler(this);
  }

  // ============================================================
  // Fetch path (CS:IP is the PC, fetch advances IP)
  // ============================================================

  fetchByte(): Byte {
    const b = this.memory.readByte(linearAddress(this.regs.CS, this.regs.IP));
    this.regs.IP = (this.regs.IP + 1) & 0xFFFF;
    return b;
  }

  fetchWord(): Word {
    const lo = this.fetchByte();
    const hi = this.fetchByte();
    return ((hi << 8) | lo) & 0xFFFF;
  }

  // ============================================================
  // Stack (not used by v0 opcodes, but this is where it lives)
  // ============================================================

  push(value: Word): void {
    // Word push wraps within the SS segment: when SP=0x0001 we decrement to
    // 0xFFFF and the high byte must land at SS:0x0000, not at the linear
    // byte one past SS:0xFFFF (which would be in the next segment). The 8086
    // computes each access as SS:offset with a 16-bit offset, so we split
    // the word into two byte writes here. (Real silicon does the same; the
    // SST corpus exercises the wrap case explicitly.)
    this.regs.SP = (this.regs.SP - 2) & 0xFFFF;
    const sp = this.regs.SP;
    this.memory.writeByte(linearAddress(this.regs.SS, sp), value & 0xFF);
    this.memory.writeByte(linearAddress(this.regs.SS, (sp + 1) & 0xFFFF), (value >> 8) & 0xFF);
  }

  pop(): Word {
    // See push() — same wrap reasoning, in reverse.
    const sp = this.regs.SP;
    const lo = this.memory.readByte(linearAddress(this.regs.SS, sp));
    const hi = this.memory.readByte(linearAddress(this.regs.SS, (sp + 1) & 0xFFFF));
    this.regs.SP = (sp + 2) & 0xFFFF;
    return ((hi << 8) | lo) & 0xFFFF;
  }

  // ============================================================
  // Effective segment for data accesses (honours segment override prefix)
  // ============================================================

  /** Segment to use for a default-DS memory access, with override applied. */
  dataSegment(): Word {
    return this.segOverride !== null
      ? this.regs.getSreg(this.segOverride)
      : this.regs.DS;
  }

  /** Segment to use for a default-SS memory access (BP-based EAs), with override. */
  stackSegment(): Word {
    return this.segOverride !== null
      ? this.regs.getSreg(this.segOverride)
      : this.regs.SS;
  }

  resolve(segment: Word, offset: Word): LinearAddress {
    return linearAddress(segment, offset);
  }

  // ============================================================
  // Snapshot / restore (debugging, future interrupt boundary work)
  // ============================================================

  snapshot(): CPUSnapshot {
    return {
      regs: this.regs.snapshot(),
      flags: this.flags.value,
      halted: this.halted,
      segOverride: this.segOverride,
      interruptInhibit: this.interruptInhibit,
    };
  }

  restore(s: CPUSnapshot): void {
    this.regs.restore(s.regs);
    this.flags.value = s.flags;
    this.halted = s.halted;
    this.segOverride = s.segOverride;
    this.interruptInhibit = s.interruptInhibit;
  }
}
