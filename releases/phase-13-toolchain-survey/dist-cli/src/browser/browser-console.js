/**
 * Browser-side console. Same `Console` interface as `NodeConsole`, but the
 * I/O endpoints are a TX sink (a callback the worker host wires to a `tx`
 * postMessage) and an in-memory input queue (fed by inbound `rx` messages
 * from the main thread).
 *
 * Lives intentionally close to the Node analogue's shape: `writeChar` →
 * sink, `readChar` / `hasInput` → drain a queue. No raw-mode TTY handling
 * — xterm.js owns keystroke encoding on the main thread; the worker just
 * sees bytes.
 *
 * In Phase 9 the BIOS INT 16h path is unused (ELKS in serial mode reads
 * from /dev/ttyS0 via the UART, not via INT 16h). The input queue is here
 * to satisfy the interface contract and to mirror `NodeConsole`'s shape;
 * worker-host wiring drives RX bytes directly into the UART's RX FIFO.
 */
export class BrowserConsole {
    #txSink;
    #inputQueue = [];
    constructor(opts) {
        this.#txSink = opts.txSink;
    }
    /**
     * Push input bytes onto the queue. Used by the worker host when it
     * receives a `rx` message from the main thread. Bytes are masked to
     * 8 bits for safety against accidental higher-bit values from a buggy
     * encoder.
     */
    injectInput(bytes) {
        for (const b of bytes)
            this.#inputQueue.push(b & 0xFF);
    }
    // --- Console interface ---
    writeChar(charCode) {
        this.#txSink(charCode & 0xFF);
    }
    readChar() {
        return this.#inputQueue.length === 0 ? -1 : this.#inputQueue.shift();
    }
    hasInput() {
        return this.#inputQueue.length > 0;
    }
}
