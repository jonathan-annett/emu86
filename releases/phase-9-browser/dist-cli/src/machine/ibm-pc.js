import { CPU8086 } from '../cpu8086/cpu.js';
import { TrapRegistry } from '../cpu8086/trap-registry.js';
import { KeyboardController8042, PIC8259, PIT8254, UART16550, COM1_BASE, COM1_IRQ, } from '../devices/index.js';
import { BasicInterruptController } from '../interrupts/controller.js';
import { BasicIOBus } from '../io/io-bus.js';
import { PagedMemory } from '../memory/paged-memory.js';
import { RunLoop } from '../runtime/run-loop.js';
import { Clock } from '../timing/clock.js';
import { InMemoryConsole } from '../console/console.js';
import { NodeHostClock } from '../host-clock/host-clock.js';
import { buildBiosRom, } from '../bios/bios-rom.js';
import { registerBiosHandlers, } from '../bios/bios-services.js';
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
    cpu;
    memory;
    controller;
    clock;
    bus;
    pic;
    pit;
    /**
     * Headless 8042 PS/2 keyboard controller at ports 0x60 / 0x64. Phase 4
     * added it to unblock the ELKS A20-setup drain loop. No real keyboard
     * input is plumbed in; the controller exists so OBF (port 0x64 bit 0)
     * reads as 0 and the A20 enable command sequence is accepted.
     */
    keyboardController;
    /**
     * NS16550A-class UART at COM1 (ports 0x3F8-0x3FF) with IRQ 4 wired
     * into the PIC. Phase 8 added it so ELKS's serial driver can probe and
     * use a real serial console. The TX sink defaults to no-op; harnesses
     * that want bytes to flow somewhere wire `uartTransmit` in the config.
     * RX bytes are pushed via `uart.injectByte` / `injectBytes`.
     */
    uart;
    runLoop;
    /**
     * Trap registry holding every BIOS service handler. Defined when
     * `loadBios` is true (the default); `null` when the BIOS was disabled.
     */
    traps;
    /**
     * The BIOS ROM image installed at 0xF0000. `null` when `loadBios` is false.
     * Exposed for tests and tooling that want to inspect the layout.
     */
    bios;
    /** Console wired to INT 10h / 16h, or `null` when the BIOS is disabled. */
    console;
    /** Disk wired to INT 13h / 19h. May be null even when the BIOS is loaded. */
    disk;
    /** Host clock wired to INT 1Ah, or `null` when the BIOS is disabled. */
    hostClock;
    defaultBatchSize;
    defaultHaltCyclesPerSpin;
    constructor(config = {}) {
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
        // ---- Bus registration ----
        this.pic.registerOn(this.bus);
        this.pit.registerOn(this.bus);
        this.keyboardController.registerOn(this.bus);
        this.uart.registerOn(this.bus);
        // ---- BIOS ROM + trap registry (optional but on by default) ----
        // Build the BIOS first so the CPU can be constructed with the trap
        // registry already in place. We delay `loadROM` until *after* the CPU
        // constructor purely for symmetry; loadROM has no CPU dependency, but
        // doing it here means a thrown loadROM (e.g., a clash with caller-loaded
        // ROM) leaves the rest of the Machine intact.
        const loadBios = config.loadBios ?? true;
        let traps = null;
        let bios = null;
        let consoleRef = null;
        let diskRef = null;
        let clockRef = null;
        if (loadBios) {
            bios = buildBiosRom();
            traps = new TrapRegistry();
            consoleRef = config.console ?? new InMemoryConsole();
            diskRef = config.disk ?? null;
            clockRef = config.hostClock ?? new NodeHostClock();
        }
        this.bios = bios;
        this.traps = traps;
        this.console = consoleRef;
        this.disk = diskRef;
        this.hostClock = clockRef;
        // ---- CPU (needs memory + bus + controller, and trap registry if BIOS is on) ----
        this.cpu = traps !== null
            ? new CPU8086(this.memory, this.bus, this.controller, traps)
            : new CPU8086(this.memory, this.bus, this.controller);
        if (loadBios) {
            // Install the ROM image and register the JS handlers. The handlers
            // close over a single shared context so per-call overhead is one
            // arrow-function call, not a per-handler context lookup.
            this.memory.loadROM(bios.baseLinear, bios.bytes);
            const ctx = {
                console: consoleRef,
                disk: diskRef,
                hostClock: clockRef,
                warn: warn ?? (() => { }),
                eoiPort: 0x20,
            };
            registerBiosHandlers(traps, bios.layout, ctx);
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
    reset() {
        this.cpu.reset();
        this.controller.reset();
        this.pic.reset();
        this.pit.reset();
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
    loadProgram(bytes, linearAddress) {
        if (!Number.isInteger(linearAddress) || linearAddress < 0) {
            throw new Error(`loadProgram: linearAddress must be a non-negative integer (got ${linearAddress})`);
        }
        for (let i = 0; i < bytes.length; i++) {
            // Indexing both forms returns a number; the assertion is just to
            // satisfy TS's union-element-typing.
            const b = bytes[i];
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
    setEntryPoint(segment, offset) {
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
    run(opts = {}) {
        const merged = {
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
    stop() {
        this.runLoop.stop();
    }
}
