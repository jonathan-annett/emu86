/**
 * Mirror writes to the CGA text-mode framebuffer (0xB8000-0xBFFFF) into
 * a host-side sink (stdout in the harness, an in-memory buffer in tests).
 *
 * Background: ELKS's `console-direct` driver, which the kernel installs
 * after early boot, writes directly to video memory rather than going
 * through INT 10h. The InMemoryConsole wired to the BIOS only sees the
 * pre-`console_init` early-printk output; everything from "Direct
 * console..." onwards lands in the framebuffer. To get a usable terminal
 * session we have to surface those writes somewhere.
 *
 * Design constraints: the brief locks `src/memory/`, so we cannot add a
 * subscription mechanism inside `PagedMemory.writeByte`. We use the same
 * method-replacement instrumentation pattern as Phase 3's
 * `instrumentMachine` — capture the original `writeByte`, install a
 * wrapper that filters on the framebuffer range and forwards to the sink,
 * return a tear-down callback. Pure overlay, no architecture change.
 *
 * Position-aware emit (Phase 7.1): the kernel never writes CR/LF into
 * the framebuffer; it writes characters at cell positions and lets the
 * CRTC cursor advance. To put characters where they belong on the host
 * terminal, we compute (row, col) from the write address and prefix
 * each character with an ANSI cursor-position sequence
 * `ESC [ row+1 ; col+1 H`. Sequential writes (the dominant case for
 * boot banners and shell output) get a small optimisation: when the
 * next write lands at (row, col+1), the host terminal cursor is already
 * there from the previous emit, so we skip the positioning prefix.
 *
 * Attribute bytes (odd offsets) are filtered out: they encode foreground
 * / background colour and would emit garbage if printed verbatim.
 *
 * Out of scope for this version: CRTC port subscription (cursor tracking
 * for the guest's own cursor render), colour / attribute rendering via
 * ANSI SGR, scroll-as-scroll translation, mode changes. A future brief
 * can pick these up.
 */
/** Linear address of the CGA text-mode framebuffer base. */
export const CGA_TEXT_BASE = 0xB8000;
/** End of the CGA text region (exclusive). 32 KiB total — 80x25 with eight pages. */
export const CGA_TEXT_END = 0xC0000;
/** CGA text-mode column count per row. */
export const CGA_TEXT_COLS = 80;
/**
 * Install the mirror on `machine.memory`. Returns a tear-down function
 * that restores the original `writeByte` binding.
 *
 * Idempotent against the tear-down callback: calling it twice is fine.
 * The mirror does not stack on top of itself — installing twice without
 * tearing down first creates two layers; tear them down in reverse
 * install order if you need that.
 */
export function installCGAMirror(machine, opts) {
    const { sink } = opts;
    const start = opts.start ?? CGA_TEXT_BASE;
    const end = opts.end ?? CGA_TEXT_END;
    const mem = machine.memory;
    // PagedMemory.writeWord delegates to writeByte twice (see paged-memory.ts),
    // so a single wrapper on writeByte intercepts both byte and word writes
    // without double-counting. We deliberately do NOT wrap writeWord — doing
    // so would double-emit because the inner writeByte calls already pass
    // through this wrapper.
    const origWriteByte = mem.writeByte.bind(mem);
    // Track the (row, col) of the last emitted character. -1 / -1 sentinels
    // force positioning on the first emit. This enables the run-length
    // optimisation: when consecutive writes land at (row, col+1), we skip
    // the positioning prefix because the host terminal cursor is already
    // there from the previous emit's natural advance.
    let lastRow = -1;
    let lastCol = -1;
    mem.writeByte = (addr, v) => {
        origWriteByte(addr, v);
        if (addr < start || addr >= end || (addr & 1) !== 0)
            return;
        const cellOffset = (addr - start) >> 1;
        const row = Math.floor(cellOffset / CGA_TEXT_COLS);
        const col = cellOffset % CGA_TEXT_COLS;
        if (!(row === lastRow && col === lastCol + 1)) {
            emitCursorPosition(sink, row + 1, col + 1);
        }
        sink.writeChar(v & 0xFF);
        lastRow = row;
        lastCol = col;
    };
    let torn = false;
    return () => {
        if (torn)
            return;
        torn = true;
        mem.writeByte = origWriteByte;
    };
}
/** Emit `ESC [ row ; col H` as raw bytes to the sink. ANSI is 1-indexed. */
function emitCursorPosition(sink, row, col) {
    sink.writeChar(0x1B); // ESC
    sink.writeChar(0x5B); // [
    emitDecimal(sink, row);
    sink.writeChar(0x3B); // ;
    emitDecimal(sink, col);
    sink.writeChar(0x48); // H
}
function emitDecimal(sink, n) {
    const s = String(n);
    for (let i = 0; i < s.length; i++)
        sink.writeChar(s.charCodeAt(i));
}
/**
 * In-memory sink for tests. Captures every emitted byte; exposes a string
 * getter for the friendly common case.
 */
export class CapturingCGASink {
    #bytes = [];
    writeChar(byte) {
        this.#bytes.push(byte & 0xFF);
    }
    get bytes() {
        return this.#bytes;
    }
    get text() {
        let s = '';
        for (const c of this.#bytes)
            s += String.fromCharCode(c);
        return s;
    }
    clear() {
        this.#bytes.length = 0;
    }
}
/**
 * Wraps another sink and emits a fixed byte prefix exactly once, just
 * before the first forwarded `writeChar`. Used by the live harness to
 * clear the host terminal (`ESC [ 2J ESC [ H`) at the boundary between
 * early-printk output (raw stdout) and framebuffer-driven output (this
 * mirror), giving the framebuffer phase a clean canvas to draw on.
 *
 * Lives outside `installCGAMirror` so that test sinks never receive the
 * prefix — pollution would invalidate per-emit assertions.
 */
export class OneShotPrefixSink {
    #inner;
    #prefix;
    #fired = false;
    constructor(inner, prefix) {
        this.#inner = inner;
        this.#prefix = prefix;
    }
    writeChar(byte) {
        if (!this.#fired) {
            this.#fired = true;
            for (const b of this.#prefix)
                this.#inner.writeChar(b);
        }
        this.#inner.writeChar(byte);
    }
}
/**
 * Bytes for `ESC [ 2J ESC [ H` — clear the entire screen and home the
 * cursor. The default boundary-clear prefix used by the live harness.
 */
export const CLEAR_AND_HOME = [0x1B, 0x5B, 0x32, 0x4A, 0x1B, 0x5B, 0x48];
