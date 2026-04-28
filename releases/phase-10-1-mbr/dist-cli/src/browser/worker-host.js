/**
 * Worker-side host for the browser harness.
 *
 * Wraps an `IBMPCMachine` in a message-driven shell:
 *
 *   - Inbound: `boot` (fetch image + construct), `rx` (push keystrokes),
 *     `reset` (tear down + re-construct).
 *   - Outbound: `ready` (constructed and ready to run), `tx` (coalesced
 *     UART TX bytes), `halted` (run loop exited cleanly), `error` (uncaught
 *     exception during boot or run).
 *
 * Two execution modes:
 *
 *   - **Async (production)**: `handleMessage({type:'boot'})` constructs the
 *     machine, posts `ready`, and starts an async run loop that yields
 *     between batches via `setTimeout(0)` so the worker's inbound message
 *     queue gets drained between chunks. Without that yield, RX messages
 *     pile up and never reach the UART.
 *   - **Sync (tests)**: `runUntil(maxInstructions)` drives the same chunked
 *     loop with no yield. Tests construct the host with `autoRun: false`
 *     so `boot` doesn't spawn the async loop, then call `runUntil` directly
 *     to drive the boot to a checkpoint and inspect collected TX messages.
 *
 * TX coalescing: the UART TX callback and BrowserConsole's `writeChar` both
 * push onto a shared byte buffer. Each batch ends with a flush — one `tx`
 * postMessage per batch (5000 instructions by default), not per byte. A
 * per-byte channel would saturate postMessage on a kernel banner. Chunk
 * size 5000 was picked from the brief's recommendation; empirically it
 * gives smooth UART output without starving the postMessage channel.
 *
 * Halt-spin handling: matches `tools/elks/run-serial.ts` and the existing
 * Phase 8 integration test. ELKS HLT-waits for PIT IRQ 0 during boot; the
 * loop has to advance the virtual clock during halt-spins so that wake
 * happens. Default cap of 1000 spins × 1000 cycles = 1e6 virtual cycles
 * matches `traceRun`'s defaults — enough for the kernel's deepest HLT
 * window without letting an actually-stuck boot spin forever.
 */
import { BrowserConsole } from './browser-console.js';
import { IBMPCMachine } from '../machine/ibm-pc.js';
import { InMemoryDisk } from '../disk/disk.js';
import { NodeHostClock } from '../host-clock/host-clock.js';
import { installCGAMirror, } from '../diagnostics/cga-mirror.js';
const SIZE_TABLE = [
    // ---- Floppies ----
    { bytes: 1474560, geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 }, diskClass: 'floppy' }, // 1.44 MB
    { bytes: 1228800, geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 15 }, diskClass: 'floppy' }, // 1.2 MB
    // ---- ELKS hard disks ----
    // 32 MB partitionless: exact fit at 63 × 16 × 63.
    { bytes: 32514048, geometry: { cylinders: 63, heads: 16, sectorsPerTrack: 63 }, diskClass: 'hard-disk' },
    // 32 MB MBR variant: +1 track. 64 × 16 × 63 = 33,030,144 ≥ 32,546,304.
    { bytes: 32546304, geometry: { cylinders: 64, heads: 16, sectorsPerTrack: 63 }, diskClass: 'hard-disk' },
    // 64 MB partitionless: 130 × 16 × 63 = 67,092,480 < image; round up to 131.
    { bytes: 67107840, geometry: { cylinders: 131, heads: 16, sectorsPerTrack: 63 }, diskClass: 'hard-disk' },
    // 64 MB MBR variant: 131 × 16 × 63 = 67,608,576 ≥ 67,140,096.
    { bytes: 67140096, geometry: { cylinders: 131, heads: 16, sectorsPerTrack: 63 }, diskClass: 'hard-disk' },
];
/**
 * Match an image byte-count against the size table. Returns null on miss —
 * callers must then fall back to an explicit `BootConfig.geometry`.
 *
 * Exported for `tests/unit/disk-geometry.test.ts`.
 */
export function inferFromSize(bytes) {
    for (const entry of SIZE_TABLE) {
        if (entry.bytes === bytes) {
            return { geometry: entry.geometry, diskClass: entry.diskClass };
        }
    }
    return null;
}
/**
 * Heuristic: heads ≥ 4 means hard-disk class, else floppy. Floppy formats
 * top out at 2 heads (3.5"/5.25" double-sided); HDs start at 4 heads on
 * the small end (early ST-225 had 4) and only grow from there. Documented
 * in the brief.
 *
 * Exported for `tests/unit/disk-geometry.test.ts`.
 */
export function classFromGeometry(g) {
    return g.heads >= 4 ? 'hard-disk' : 'floppy';
}
/** Drop-everything sink for the CGA mirror — Phase 9 doesn't render it. */
class NullCGASink {
    writeChar(_byte) { }
}
export class WorkerHost {
    #post;
    #fetchImage;
    #autoRun;
    #batchSize;
    #haltSpinCycles;
    #maxHaltSpins;
    #machine = null;
    #console = null;
    #teardownMirror = null;
    #txBuffer = [];
    #stopping = false;
    /** Last in-flight async work — boot fetch + autoRun loop. */
    #pending = Promise.resolve();
    constructor(opts) {
        this.#post = opts.post;
        this.#fetchImage = opts.fetchImage;
        this.#autoRun = opts.autoRun ?? true;
        this.#batchSize = opts.batchSize ?? 5000;
        this.#haltSpinCycles = opts.haltSpinCycles ?? 1000;
        this.#maxHaltSpins = opts.maxHaltSpins ?? 1000;
    }
    /** Underlying machine. Tests poke this for low-level inspection. */
    get machine() {
        return this.#machine;
    }
    /**
     * Inbound message handler — call from the worker's `message` event
     * listener. Returns immediately; async work (fetch + run loop) is
     * tracked via `whenIdle()` so tests can await it.
     */
    handleMessage(msg) {
        if (msg.type === 'boot') {
            this.#pending = this.#pending.then(() => this.#bootAndMaybeRun(msg.config));
            return;
        }
        if (msg.type === 'rx') {
            if (this.#console)
                this.#console.injectInput(msg.bytes);
            return;
        }
        if (msg.type === 'reset') {
            this.#stopping = true;
            // The reset semantics for v0: ask the current run to bail; the next
            // boot reconstructs. The IDB page store is preserved across reset
            // because we don't touch the store; reloading the page yields the
            // same persistence behaviour. A separate "wipe" affordance is out
            // of scope.
            this.#pending = this.#pending.then(() => {
                this.#teardownMachine();
            });
            return;
        }
    }
    /**
     * Resolves once all in-flight boot/run work has settled. Tests await
     * this between message sends. Production callers don't need it.
     */
    async whenIdle() {
        await this.#pending;
    }
    /**
     * Synchronous run driver — the body of the async loop, but with no
     * `setTimeout` yields between batches. Tests call this directly after
     * `boot` to drive the kernel to a checkpoint within an instruction cap.
     *
     * Drains the BrowserConsole RX queue into the UART before each batch,
     * runs `cpu.step()` up to `batchSize` instructions, advances the virtual
     * clock, then flushes accumulated TX bytes as a `tx` message.
     *
     * Halt handling mirrors `traceRun`: when the CPU halts and no interrupt
     * is currently serviceable, advance the clock to give the PIT a chance
     * to fire IRQ 0; if `maxHaltSpins` ticks pass with no wake, return
     * `halt-spin-exhausted`.
     */
    runUntil(maxInstructions) {
        if (!this.#machine || !this.#console) {
            throw new Error('WorkerHost.runUntil: boot has not completed');
        }
        const machine = this.#machine;
        const browserConsole = this.#console;
        const cpu = machine.cpu;
        let executed = 0;
        let haltSpins = 0;
        while (executed < maxInstructions && !this.#stopping) {
            this.#drainRx(browserConsole, machine);
            if (cpu.halted) {
                const ctrl = cpu.intCtrl;
                const canService = ctrl.hasNMI() ||
                    (ctrl.hasMaskable() && cpu.flags.IF && !cpu.interruptInhibit);
                if (canService) {
                    cpu.step();
                    executed++;
                    haltSpins = 0;
                    continue;
                }
                if (haltSpins >= this.#maxHaltSpins) {
                    this.#flushTx();
                    return { executed, reason: 'halt-spin-exhausted' };
                }
                machine.clock.advance(this.#haltSpinCycles);
                haltSpins++;
                continue;
            }
            const budget = Math.min(this.#batchSize, maxInstructions - executed);
            let executedThisBatch = 0;
            try {
                for (let i = 0; i < budget; i++) {
                    if (cpu.halted)
                        break;
                    cpu.step();
                    executedThisBatch++;
                }
            }
            catch (err) {
                executed += executedThisBatch;
                this.#flushTx();
                this.#postError(err);
                return { executed, reason: 'error' };
            }
            executed += executedThisBatch;
            haltSpins = 0;
            if (executedThisBatch > 0)
                machine.clock.advance(executedThisBatch);
            this.#flushTx();
        }
        this.#flushTx();
        if (this.#stopping)
            return { executed, reason: 'stopped' };
        return { executed, reason: 'instruction-limit' };
    }
    // ============================================================
    // Internal
    // ============================================================
    async #bootAndMaybeRun(config) {
        try {
            await this.#boot(config);
        }
        catch (err) {
            this.#postError(err);
            return;
        }
        if (!this.#autoRun)
            return;
        // Production async loop. Yields to the worker's macrotask queue between
        // batches so inbound RX messages can be delivered. Without the yield,
        // postMessage events would queue forever behind a synchronous run loop.
        while (!this.#stopping && this.#machine !== null) {
            const result = this.runUntil(this.#batchSize);
            if (result.reason !== 'instruction-limit' &&
                result.reason !== 'stopped') {
                this.#post({ type: 'halted', reason: result.reason });
                return;
            }
            if (result.reason === 'stopped')
                return;
            await yieldMacrotask();
        }
    }
    async #boot(config) {
        this.#teardownMachine();
        this.#stopping = false;
        let bytes;
        if (config.imageBytes) {
            bytes = config.imageBytes;
        }
        else if (config.imageUrl) {
            if (!this.#fetchImage) {
                throw new Error('WorkerHost: imageUrl supplied but no fetchImage callback configured');
            }
            bytes = await this.#fetchImage(config.imageUrl);
        }
        else {
            throw new Error('WorkerHost: boot config must carry imageBytes or imageUrl');
        }
        let geometry = config.geometry;
        let diskClass = config.diskClass;
        if (!geometry) {
            const inferred = inferFromSize(bytes.length);
            if (!inferred) {
                throw new Error(`WorkerHost: unrecognised image size ${bytes.length} bytes. ` +
                    `Pass an explicit geometry (and optionally diskClass) in the boot ` +
                    `config to override.`);
            }
            geometry = inferred.geometry;
            diskClass ??= inferred.diskClass;
        }
        diskClass ??= classFromGeometry(geometry);
        const disk = new InMemoryDisk({ geometry, contents: bytes });
        const browserConsole = new BrowserConsole({
            txSink: (byte) => this.#txBuffer.push(byte),
        });
        this.#console = browserConsole;
        const machine = new IBMPCMachine({
            disk,
            diskClass,
            console: browserConsole,
            hostClock: new NodeHostClock(),
            cyclesPerPitTick: 4,
            uartTransmit: (byte) => this.#txBuffer.push(byte),
        });
        // Silent CGA sink — Phase 9 has no canvas. Without a sink the kernel's
        // early-printk writes to 0xB8000 still land in memory; the mirror is
        // only here to satisfy the same wiring shape `tools/elks/run-serial.ts`
        // uses and to absorb any future serial-mode-with-tee experiment.
        this.#teardownMirror = installCGAMirror(machine, { sink: new NullCGASink() });
        this.#machine = machine;
        machine.reset();
        this.#post({ type: 'ready' });
    }
    #drainRx(browserConsole, machine) {
        while (browserConsole.hasInput()) {
            const b = browserConsole.readChar();
            if (b < 0)
                break;
            machine.uart.injectByte(b);
        }
    }
    #flushTx() {
        if (this.#txBuffer.length === 0)
            return;
        const bytes = new Uint8Array(this.#txBuffer);
        this.#txBuffer.length = 0;
        this.#post({ type: 'tx', bytes });
    }
    #postError(err) {
        if (err instanceof Error) {
            this.#post({
                type: 'error',
                message: err.message,
                ...(err.stack ? { stack: err.stack } : {}),
            });
            return;
        }
        this.#post({ type: 'error', message: String(err) });
    }
    #teardownMachine() {
        if (this.#teardownMirror) {
            this.#teardownMirror();
            this.#teardownMirror = null;
        }
        if (this.#machine) {
            this.#machine.stop();
        }
        this.#machine = null;
        this.#console = null;
        this.#txBuffer.length = 0;
    }
}
/**
 * Yield to the macrotask queue. Workers process inbound `message` events as
 * macrotasks, so a microtask yield (queueMicrotask) would starve them. The
 * `setTimeout(0)` form costs ~1ms in browsers and ~0.05ms in Node — both
 * negligible compared to the ~5000-instruction batch we just executed.
 */
function yieldMacrotask() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
