import { CPU8086 } from '../cpu8086/cpu.js';
import { TrapRegistry } from '../cpu8086/trap-registry.js';
import {
  KeyboardController8042,
  NE2000,
  NE2K_BASE,
  NE2K_IRQ,
  PIC8259,
  PIT8254,
  UART16550,
  COM1_BASE,
  COM1_IRQ,
} from '../devices/index.js';
import { BasicInterruptController } from '../interrupts/controller.js';
import { BasicIOBus } from '../io/io-bus.js';
import { PagedMemory } from '../memory/paged-memory.js';
import type { PageStore } from '../memory/page-store.js';
import { RunLoop, type RunLoopOptions, type RunResult } from '../runtime/run-loop.js';
import { RTC146818 } from '../devices/rtc.js';
import { Clock } from '../timing/clock.js';
import type { Console } from '../console/console.js';
import { InMemoryConsole } from '../console/console.js';
import type { Disk } from '../disk/disk.js';
import type { HostClock } from '../host-clock/host-clock.js';
import { NodeHostClock } from '../host-clock/host-clock.js';
import {
  buildBiosRom,
  type BiosRomLayout,
  type BuiltBiosRom,
} from '../bios/bios-rom.js';
import {
  registerBiosHandlers,
  type BiosContext,
} from '../bios/bios-services.js';

/**
 * Configuration for {@link IBMPCMachine}. Every option has a default that
 * matches a "generic 1 MiB IBM PC-compatible" — the constructor without
 * arguments is the canonical PC.
 */
export interface IBMPCMachineConfig {
  /**
   * Memory size in bytes. Default 0x100000 (1 MiB, the 8086 max). Must be a
   * positive power of two — passed through to {@link PagedMemory}.
   */
  memorySize?: number;
  /**
   * Page store for memory persistence. Optional; default is no persistence
   * (pure-RAM operation). When provided, callers are responsible for the
   * write-back lifecycle (`memory.startWriteBack()` / `memory.flush()`) —
   * the Machine does not start the loop on its behalf, because doing so
   * would force every test to await flushes it doesn't need.
   */
  pageStore?: PageStore;
  /**
   * Clock cycles per PIT tick. Default 4 — the real-PC ratio (CPU
   * 4.77 MHz, PIT 1.193 MHz). Tests usually override to 1 for clean math.
   */
  cyclesPerPitTick?: number;
  /**
   * Run-loop default batch size (instructions per yield). Default 10_000.
   * Forwarded to the underlying {@link RunLoop} as the `run()` default;
   * callers can still override per-run via the `run()` opts.
   */
  batchSize?: number;
  /**
   * Halt-spin clock advance per yield. Default = `batchSize`. Same
   * forwarding rule as above. See `RunLoopOptions.haltCyclesPerSpin` for
   * the rationale on the default.
   */
  haltCyclesPerSpin?: number;
  /**
   * Optional warning sink shared by the PIC and PIT. Default: silent.
   * Useful in tests to capture "unsupported feature" warnings from either
   * device through one channel.
   */
  warn?: (msg: string) => void;
  /**
   * Generate the BIOS ROM at construction and install it at 0xF0000-0xFFFFF,
   * registering the JS BIOS service handlers via a {@link TrapRegistry}.
   * Default `true` — the canonical PC. Set `false` for tests of the lower
   * layers that don't want the BIOS interfering with memory layout.
   */
  loadBios?: boolean;
  /**
   * Console used by INT 10h (output) and INT 16h (keyboard input). Default
   * is a fresh {@link InMemoryConsole} — production callers wire a
   * {@link NodeConsole} or browser-side equivalent. Only consulted when
   * `loadBios` is true.
   */
  console?: Console;
  /**
   * Disk attached to the BIOS for INT 13h / INT 19h. Optional; absent means
   * INT 13h returns "drive not ready" and INT 19h fails to boot. Only
   * consulted when `loadBios` is true.
   */
  disk?: Disk;
  /**
   * Class of the attached disk — `'floppy'` for the 1.44/1.2 MB diskette
   * shapes (BIOS drive `0x00`), `'hard-disk'` for ELKS HD images (BIOS
   * drive `0x80`). Determines the boot drive number the BIOS stamps into
   * `DL` at INT 19h, the AH=0x08 reply shape, and the drive-number filter
   * in the INT 13h read/write path.
   *
   * Defaults to inferring from `disk.geometry.heads` (≥ 4 → hard-disk).
   * Pre-Phase-10 callers that pass only floppy geometries see no change.
   */
  diskClass?: 'floppy' | 'hard-disk';
  /**
   * Optional secondary disk (Phase 11). When present, the BIOS surfaces
   * it as an additional drive — DL=0x01 if it's a floppy (and primary is
   * either floppy or absent), or DL=0x81 if it's an HD. The ELKS kernel
   * probes it via INT 13h AH=08h and registers `/dev/hdb` or `/dev/fd1`
   * accordingly.
   *
   * Routing rule: per-class indexing. Floppies and HDs are numbered
   * separately (floppies start at 0x00, HDs at 0x80) and slots are
   * assigned in primary-first order. So an HD primary + floppy secondary
   * gives the floppy DL=0x00, not 0x01.
   *
   * Same drive-number filter for INT 13h read/write applies; a request
   * for an absent slot returns CF=1 + AH=0x01 (the kernel skips silently).
   */
  secondaryDisk?: Disk;
  /**
   * Class of the secondary disk. Defaults to inferring from
   * `secondaryDisk.geometry.heads` the same way `diskClass` does.
   * Required when `secondaryDisk` is set and ambiguous — explicit pin
   * always wins.
   */
  secondaryDiskClass?: 'floppy' | 'hard-disk';
  /**
   * Host clock used by INT 1Ah. Default {@link NodeHostClock} (real wall
   * time). Tests usually pass an {@link InMemoryHostClock}. Only consulted
   * when `loadBios` is true.
   */
  hostClock?: HostClock;
  /**
   * Optional sink for outgoing UART (COM1) bytes. The harness wires this
   * to stdout (or to a capturing buffer in tests). Default: bytes are
   * dropped — tests that don't exercise serial don't need to set this.
   */
  uartTransmit?: (byte: number) => void;
  /**
   * Optional sink for ethernet frames the guest transmits through the
   * NE2000 (Phase 14 M3a). The harness wires this to an
   * {@link EthernetSwitch} port; default drops frames (unplugged cable).
   * Inbound frames are pushed via `nic.injectFrame`.
   */
  nicTransmit?: (frame: Uint8Array) => void;
  /** Station MAC for the NE2000. Default {@link NE2K_DEFAULT_MAC}. */
  nicMac?: readonly number[];
}

/**
 * IBM PC-compatible system: CPU, memory, interrupt controller, virtual
 * clock, I/O bus, PIC, PIT, and run loop, wired together with PC-standard
 * port assignments and IRQ routing.
 *
 * This is the first concrete machine in the project. It composes the
 * primitives the prior briefs built without changing any of them — every
 * device stays interrupt-/PIC-/CPU-agnostic, and the wiring (PIT channel 0
 * rising edge → PIC IRQ 0, PIC at 0x20-0x21, PIT at 0x40-0x43) lives here.
 *
 * The class is deliberately a thin wiring harness: every component is
 * exposed as a `readonly` property so tests and advanced consumers can
 * inspect or drive any layer directly. Lifecycle (`reset`, `loadProgram`,
 * `setEntryPoint`, `run`, `stop`) covers the common cases without locking
 * anything off.
 *
 * Memory map (v0): the entire address space is RAM. The IVT at
 * 0x00000-0x003FF and the BIOS area at 0xF0000-0xFFFFF are just plain RAM
 * that software can write. Read-only ROM regions are a future brief, where
 * the 8086tiny BIOS will need them.
 *
 * Reset semantics: CPU, controller, PIC, PIT, and clock are all reset.
 * Memory contents survive (RAM persists across a power-on reset on real
 * hardware too, and clearing it would defeat the persistence layer).
 */
export class IBMPCMachine {
  readonly cpu: CPU8086;
  readonly memory: PagedMemory;
  readonly controller: BasicInterruptController;
  readonly clock: Clock;
  readonly bus: BasicIOBus;
  readonly pic: PIC8259;
  readonly pit: PIT8254;
  /**
   * Headless 8042 PS/2 keyboard controller at ports 0x60 / 0x64. Phase 4
   * added it to unblock the ELKS A20-setup drain loop. No real keyboard
   * input is plumbed in; the controller exists so OBF (port 0x64 bit 0)
   * reads as 0 and the A20 enable command sequence is accepted.
   */
  readonly keyboardController: KeyboardController8042;
  /**
   * NS16550A-class UART at COM1 (ports 0x3F8-0x3FF) with IRQ 4 wired
   * into the PIC. Phase 8 added it so ELKS's serial driver can probe and
   * use a real serial console. The TX sink defaults to no-op; harnesses
   * that want bytes to flow somewhere wire `uartTransmit` in the config.
   * RX bytes are pushed via `uart.injectByte` / `injectBytes`.
   */
  readonly uart: UART16550;
  /**
   * NE2000-compatible NIC at 0x300 with IRQ 5 wired into the PIC
   * (Phase 14 M3a). Always present, like the other board devices — a
   * kernel that doesn't probe it never notices; ELKS prints its
   * detection line at boot. IRQ 5 (not the kernel-default 12) because
   * IRQ 8-15 are unreachable behind the single master PIC; guests
   * select it with a bootopts `ne0=5,0x300,,0x80` line.
   */
  readonly nic: NE2000;
  /**
   * MC146818 CMOS RTC at 0x70/0x71 (RTC addendum, 2026-07-15), serving
   * time from `hostClock` — so the stock image's `clock -s -u` in
   * rc.sys sets the guest date to the host's at every boot. `null`
   * only when the BIOS is disabled (no hostClock to serve from).
   */
  readonly rtc: RTC146818 | null;
  readonly runLoop: RunLoop;
  /**
   * Trap registry holding every BIOS service handler. Defined when
   * `loadBios` is true (the default); `null` when the BIOS was disabled.
   */
  readonly traps: TrapRegistry | null;
  /**
   * The BIOS ROM image installed at 0xF0000. `null` when `loadBios` is false.
   * Exposed for tests and tooling that want to inspect the layout.
   */
  readonly bios: BuiltBiosRom | null;
  /** Console wired to INT 10h / 16h, or `null` when the BIOS is disabled. */
  readonly console: Console | null;
  /** Disk wired to INT 13h / 19h. May be null even when the BIOS is loaded. */
  readonly disk: Disk | null;
  /**
   * Class of the attached disk — see {@link IBMPCMachineConfig.diskClass}.
   * Always `'floppy'` when `disk` is null (irrelevant in that case).
   */
  readonly diskClass: 'floppy' | 'hard-disk';
  /**
   * Optional secondary disk wired to INT 13h. Null when absent (the
   * common single-disk case). Phase 11.
   */
  readonly secondaryDisk: Disk | null;
  /**
   * Class of the secondary disk — see
   * {@link IBMPCMachineConfig.secondaryDiskClass}. Always `'floppy'`
   * when `secondaryDisk` is null (irrelevant in that case).
   */
  readonly secondaryDiskClass: 'floppy' | 'hard-disk';
  /** Host clock wired to INT 1Ah, or `null` when the BIOS is disabled. */
  readonly hostClock: HostClock | null;

  private readonly defaultBatchSize: number;
  private readonly defaultHaltCyclesPerSpin: number | undefined;

  constructor(config: IBMPCMachineConfig = {}) {
    const memorySize = config.memorySize ?? 0x100000;
    const cyclesPerPitTick = config.cyclesPerPitTick ?? 4;
    this.defaultBatchSize = config.batchSize ?? 10_000;
    // undefined means "let the run loop default to batchSize" — only thread
    // through if the caller actually set it.
    this.defaultHaltCyclesPerSpin = config.haltCyclesPerSpin;
    const warn = config.warn;

    // ---- Substrate (no inter-device wiring yet) ----
    this.clock = new Clock();
    this.memory = new PagedMemory({
      addressSpaceSize: memorySize,
      store: config.pageStore,
    });
    this.controller = new BasicInterruptController();
    this.bus = new BasicIOBus();

    // ---- Devices that need substrate refs ----
    // PIC: PC-standard ports 0x20 (command) / 0x21 (data).
    this.pic = new PIC8259(this.controller, warn ? { warn } : {});
    // PIT: PC-standard base port 0x40 (channels 0/1/2 at +0/+1/+2,
    // control at +3). The Machine wires channel 0's rising edge to
    // `pic.assertIRQ(0)` — the only inter-device wire in the current
    // device set. Channels 1 and 2 have no consumers yet (real PC: DRAM
    // refresh and PC speaker), so their callbacks default to no-ops.
    this.pit = new PIT8254(this.clock, {
      cyclesPerPitTick,
      onChannel0RisingEdge: () => this.pic.assertIRQ(0),
      ...(warn ? { warn } : {}),
    });

    // ---- 8042 PS/2 keyboard controller ----
    // Sits at ports 0x60 / 0x64. ELKS Setup polls bit 0 of 0x64 (OBF) and
    // then issues the A20 enable command (0xD1 → 0xDF) before jumping into
    // protected-mode-style setup; without a handler here, those polls never
    // see OBF=0 and the boot stalls. The IRQ 1 callback wires injected
    // scancodes (host stdin → ScancodeTranslator → injectScancodes) to
    // PIC IRQ 1, the same way PIT channel 0 → IRQ 0 is wired above.
    // Headless callers (no input plumbing) leave the queue empty; nothing
    // ever fires IRQ 1 and the device behaves identically to Phase 4.
    this.keyboardController = new KeyboardController8042({
      ...(warn ? { warn } : {}),
      onIRQ1: () => this.pic.assertIRQ(1),
    });

    // ---- 16550A UART at COM1 (Phase 8) ----
    // IRQ 4 wired to the PIC, mirroring the keyboard's IRQ 1 wiring. The
    // TX sink and RX injection are configurable; tests that don't drive
    // serial leave both unset and the device behaves as a quiescent
    // UART (no bytes in or out).
    const uartTransmit = config.uartTransmit;
    this.uart = new UART16550({
      basePort: COM1_BASE,
      ...(warn ? { warn } : {}),
      ...(uartTransmit ? { onTransmit: uartTransmit } : {}),
      onIRQ4: () => this.pic.assertIRQ(COM1_IRQ),
    });

    // ---- NE2000 NIC at 0x300 / IRQ 5 (Phase 14 M3a) ----
    // Same wiring shape as the UART: frame sink configurable, IRQ line
    // into the master PIC. See the property docblock for the IRQ-5
    // rationale.
    const nicTransmit = config.nicTransmit;
    this.nic = new NE2000({
      basePort: NE2K_BASE,
      ...(warn ? { warn } : {}),
      ...(config.nicMac ? { mac: config.nicMac } : {}),
      ...(nicTransmit ? { onTransmit: nicTransmit } : {}),
      onIRQ: () => this.pic.assertIRQ(NE2K_IRQ),
    });

    // ---- Bus registration ----
    this.pic.registerOn(this.bus);
    this.pit.registerOn(this.bus);
    this.keyboardController.registerOn(this.bus);
    this.uart.registerOn(this.bus);
    this.nic.registerOn(this.bus);

    // ---- BIOS ROM + trap registry (optional but on by default) ----
    // Build the BIOS first so the CPU can be constructed with the trap
    // registry already in place. We delay `loadROM` until *after* the CPU
    // constructor purely for symmetry; loadROM has no CPU dependency, but
    // doing it here means a thrown loadROM (e.g., a clash with caller-loaded
    // ROM) leaves the rest of the Machine intact.
    const loadBios = config.loadBios ?? true;
    let traps: TrapRegistry | null = null;
    let bios: BuiltBiosRom | null = null;
    let consoleRef: Console | null = null;
    let diskRef: Disk | null = null;
    let secondaryDiskRef: Disk | null = null;
    let clockRef: HostClock | null = null;
    let diskClassRef: 'floppy' | 'hard-disk' = 'floppy';
    let secondaryDiskClassRef: 'floppy' | 'hard-disk' = 'floppy';
    if (loadBios) {
      bios = buildBiosRom();
      traps = new TrapRegistry();
      consoleRef = config.console ?? new InMemoryConsole();
      diskRef = config.disk ?? null;
      secondaryDiskRef = config.secondaryDisk ?? null;
      clockRef = config.hostClock ?? new NodeHostClock();
      // Disk-class precedence: explicit config > geometry inference (heads ≥ 4
      // means HD) > default 'floppy'. The default is irrelevant when no disk
      // is attached, but keeps the field non-nullable for callers.
      if (config.diskClass !== undefined) {
        diskClassRef = config.diskClass;
      } else if (diskRef !== null) {
        diskClassRef = diskRef.geometry.heads >= 4 ? 'hard-disk' : 'floppy';
      }
      // Same precedence for the secondary slot. When no secondary is
      // attached the field is irrelevant but kept non-nullable so the
      // BiosContext can read it without a guard.
      if (config.secondaryDiskClass !== undefined) {
        secondaryDiskClassRef = config.secondaryDiskClass;
      } else if (secondaryDiskRef !== null) {
        secondaryDiskClassRef = secondaryDiskRef.geometry.heads >= 4 ? 'hard-disk' : 'floppy';
      }
    }
    this.bios = bios;
    this.traps = traps;
    this.console = consoleRef;
    this.disk = diskRef;
    this.secondaryDisk = secondaryDiskRef;
    this.hostClock = clockRef;
    this.diskClass = diskClassRef;
    this.secondaryDiskClass = secondaryDiskClassRef;

    // ---- CMOS RTC at 0x70/0x71 (RTC addendum) ----
    // Rides with the BIOS block because it serves time from hostClock.
    // Stock ELKS runs `clock -s -u` from rc.sys and adopts it at boot.
    let rtcRef: RTC146818 | null = null;
    if (clockRef !== null) {
      rtcRef = new RTC146818(clockRef);
      rtcRef.registerOn(this.bus);
    }
    this.rtc = rtcRef;

    // ---- CPU (needs memory + bus + controller, and trap registry if BIOS is on) ----
    this.cpu = traps !== null
      ? new CPU8086(this.memory, this.bus, this.controller, traps)
      : new CPU8086(this.memory, this.bus, this.controller);

    if (loadBios) {
      // Install the ROM image and register the JS handlers. The handlers
      // close over a single shared context so per-call overhead is one
      // arrow-function call, not a per-handler context lookup.
      this.memory.loadROM(bios!.baseLinear, bios!.bytes);
      const ctx: BiosContext = {
        console: consoleRef!,
        disk: diskRef,
        diskClass: diskClassRef,
        secondaryDisk: secondaryDiskRef,
        secondaryDiskClass: secondaryDiskClassRef,
        hostClock: clockRef!,
        warn: warn ?? (() => { /* silent default */ }),
        eoiPort: 0x20,
      };
      registerBiosHandlers(traps!, bios!.layout, ctx);
    }

    // ---- Run loop (needs the CPU) ----
    this.runLoop = new RunLoop(this.cpu);
  }

  /**
   * Power-on reset. Returns CPU, interrupt controller, PIC, PIT, and clock
   * to their post-construction state. Memory contents are preserved (real
   * hardware behaviour, and our memory is the persistent layer).
   *
   * Reset order does not matter for correctness — each component's reset
   * is independent of the others. We pick CPU → controller → devices →
   * clock for readability (start at the consumer, walk out to the source).
   */
  reset(): void {
    this.cpu.reset();
    this.controller.reset();
    this.pic.reset();
    this.pit.reset();
    this.rtc?.reset();
    this.keyboardController.reset();
    this.uart.reset();
    this.clock.reset();
  }

  /**
   * Copy `bytes` into memory starting at `linearAddress`. Accepts either a
   * `Uint8Array` or a plain `number[]` — both are common in tests.
   *
   * Bounds: writes one byte at a time via `memory.writeByte`, which masks
   * each address against the configured address space size. A program that
   * spills past the end of memory wraps according to the memory's mask;
   * tests should size their loads to fit.
   */
  loadProgram(bytes: Uint8Array | number[], linearAddress: number): void {
    if (!Number.isInteger(linearAddress) || linearAddress < 0) {
      throw new Error(
        `loadProgram: linearAddress must be a non-negative integer (got ${linearAddress})`,
      );
    }
    for (let i = 0; i < bytes.length; i++) {
      // Indexing both forms returns a number; the assertion is just to
      // satisfy TS's union-element-typing.
      const b = bytes[i] as number;
      this.memory.writeByte(linearAddress + i, b & 0xFF);
    }
  }

  /**
   * Override CS:IP. Useful for tests that load a program at a known address
   * and want execution to start there — the typical alternative to letting
   * the CPU's reset vector (CS:IP = 0xFFFF:0x0000) drop into a BIOS jump.
   *
   * In real PC operation a BIOS would be loaded into ROM at 0xF0000 and
   * the standard reset vector would land on its entry point; this method
   * exists because we don't yet have a BIOS to dispatch through.
   */
  setEntryPoint(segment: number, offset: number): void {
    this.cpu.regs.CS = segment & 0xFFFF;
    this.cpu.regs.IP = offset & 0xFFFF;
  }

  /**
   * Convenience wrapper around `runLoop.run()` that wires the Machine's
   * clock and applies the configured defaults for `batchSize` /
   * `haltCyclesPerSpin`. Per-call options take precedence — passing
   * `batchSize: 100` here overrides the constructor default.
   *
   * Returns the same {@link RunResult} as `RunLoop.run()`.
   */
  run(opts: RunLoopOptions = {}): Promise<RunResult> {
    const merged: RunLoopOptions = {
      clock: this.clock,
      batchSize: this.defaultBatchSize,
      ...(this.defaultHaltCyclesPerSpin !== undefined
        ? { haltCyclesPerSpin: this.defaultHaltCyclesPerSpin }
        : {}),
      ...opts,
    };
    return this.runLoop.run(merged);
  }

  /** Request a graceful stop of the active `run()`. See `RunLoop.stop()`. */
  stop(): void {
    this.runLoop.stop();
  }
}

