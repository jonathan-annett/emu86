/**
 * In-memory console for tests. Output accumulates in a buffer; input is
 * driven from a pre-populated queue. All methods are synchronous and
 * deterministic.
 */
export class InMemoryConsole {
    // Output captured as character codes — keeping the raw bytes avoids any
    // encoding ambiguity for tests that want to assert on non-ASCII traffic.
    // We expose a string getter for the friendly common case.
    #output = [];
    #input = [];
    /** All characters written so far, as a string of code points 0-255. */
    get output() {
        let s = '';
        for (const c of this.#output)
            s += String.fromCharCode(c);
        return s;
    }
    /** Raw output bytes — useful when output may contain non-printable chars. */
    get outputBytes() {
        return this.#output;
    }
    /** Push characters into the input queue. Strings are read as char codes. */
    pushInput(chars) {
        if (typeof chars === 'string') {
            for (let i = 0; i < chars.length; i++) {
                this.#input.push(chars.charCodeAt(i) & 0xFF);
            }
        }
        else {
            for (const c of chars)
                this.#input.push(c & 0xFF);
        }
    }
    clearOutput() {
        this.#output.length = 0;
    }
    clearInput() {
        this.#input.length = 0;
    }
    // --- Console interface ---
    writeChar(charCode) {
        this.#output.push(charCode & 0xFF);
    }
    readChar() {
        return this.#input.length === 0 ? -1 : this.#input.shift();
    }
    hasInput() {
        return this.#input.length > 0;
    }
}
/**
 * Console backed by Node's `process.stdout` and `process.stdin`.
 *
 * Output: trivial — `process.stdout.write(String.fromCharCode(c))`. Node
 * handles its own buffering.
 *
 * Input: harder. By default `process.stdin` is in cooked / line-buffered
 * mode — a key isn't visible to us until the user hits Enter. For
 * BIOS-style "read a key" semantics we want raw mode where each keystroke
 * arrives as a byte. We enable raw mode iff stdin `isTTY` is true (it is
 * false when stdin is piped or redirected); the data-event handler queues
 * bytes either way, so piped input still works.
 *
 * Cleanup: raw mode mutates the user's terminal. If we exit without
 * restoring it the user is left typing blind. We register a
 * `process.on('exit')` handler that calls {@link close} (idempotent).
 *
 * Ctrl-C policy: in raw mode, byte 0x03 arrives as a character instead of
 * raising SIGINT. We deliver it as-is for now and let Phase 2/3 decide
 * whether to translate it. (A common BIOS uses Ctrl-Break = 0x03 to
 * interrupt a running program — this is the right default for that.)
 */
export class NodeConsole {
    #stdout;
    #stdin;
    #inputQueue = [];
    #rawModeEnabled = false;
    #closed = false;
    // Capture the data listener so close() can remove exactly the one we added,
    // not anything else listening on stdin.
    #dataListener = null;
    #exitListener = null;
    constructor(opts = {}) {
        this.#stdout = opts.stdout ?? process.stdout;
        this.#stdin = opts.stdin ?? process.stdin;
        // Raw mode only when stdin is a TTY and the call is supported. When
        // stdin is piped (CI, `emu86 < input.txt`) `isTTY` is false; we skip
        // setRawMode but still listen for data events, so reads work either way.
        if (this.#stdin.isTTY === true && typeof this.#stdin.setRawMode === 'function') {
            this.#stdin.setRawMode(true);
            this.#rawModeEnabled = true;
        }
        this.#dataListener = (chunk) => {
            // `for…of` on a Buffer yields bytes (numbers). Same for Uint8Array.
            for (const byte of chunk)
                this.#inputQueue.push(byte & 0xFF);
        };
        this.#stdin.on('data', this.#dataListener);
        this.#stdin.resume?.();
        // Restore terminal state on process exit so a missed `close()` doesn't
        // strand the user in raw mode. The handler is idempotent against an
        // explicit close().
        if (opts.installExitHook !== false) {
            this.#exitListener = () => { this.close(); };
            process.on('exit', this.#exitListener);
        }
    }
    /**
     * Restore terminal state and detach our stdin listener. Idempotent — calling
     * twice is fine. Always safe to call from an `'exit'` handler.
     */
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        if (this.#rawModeEnabled && typeof this.#stdin.setRawMode === 'function') {
            this.#stdin.setRawMode(false);
            this.#rawModeEnabled = false;
        }
        if (this.#dataListener && typeof this.#stdin.removeAllListeners === 'function') {
            // We could try to removeListener with the exact ref, but we don't
            // require Node's full EventEmitter interface; removeAllListeners('data')
            // is sufficient and common in this kind of cleanup.
            this.#stdin.removeAllListeners('data');
        }
        this.#dataListener = null;
        if (this.#exitListener) {
            process.off('exit', this.#exitListener);
            this.#exitListener = null;
        }
    }
    // --- Console interface ---
    writeChar(charCode) {
        this.#stdout.write(String.fromCharCode(charCode & 0xFF));
    }
    readChar() {
        return this.#inputQueue.length === 0 ? -1 : this.#inputQueue.shift();
    }
    hasInput() {
        return this.#inputQueue.length > 0;
    }
}
