/**
 * BIOS Data Area helpers.
 *
 * The BDA lives at segment 0x40 (linear 0x400-0x4FF) on a real PC. It is
 * just RAM; BIOS handlers and operating systems read/write it through the
 * normal memory bus. We surface the field offsets and a small typed wrapper
 * so the INT handlers don't sprinkle hard-coded magic numbers.
 *
 * Field set is the subset relevant to the ELKS boot path. Anything we don't
 * touch is left at 0 (the value the IBM PC BIOS conventionally initialises
 * unused fields to). Adding a field later is one line in the BDA enum and
 * one line wherever it's read.
 *
 * Reference: 8086tiny `bios.asm` lines ~3600-3680, plus the canonical IBM
 * PC BIOS Data Area listing.
 */
/** The BDA always lives at segment 0x40. Linear base = 0x400. */
export const BDA_SEGMENT = 0x40;
export const BDA_BASE = BDA_SEGMENT << 4; // 0x400
/**
 * BDA field offsets (from segment 0x40). Names mirror the historical IBM
 * names where possible — `kbbuf_head`, `clk_dtimer`, etc.
 */
export const BDA = {
    /** Equipment word — bit-packed device list. We report 0x0021 (one floppy + 80x25 colour video). */
    EQUIPMENT: 0x10,
    /** Memory size in KiB. We report 0x0280 = 640. */
    MEMORY_SIZE_KB: 0x13,
    /** Keyboard shift flags (capslock, numlock, etc.) — we leave at 0. */
    KEYFLAGS1: 0x17,
    /** Head pointer into circular keyboard buffer (offset within BDA). */
    KBBUF_HEAD: 0x1A,
    /** Tail pointer into circular keyboard buffer (offset within BDA). */
    KBBUF_TAIL: 0x1C,
    /** Start of the 32-byte keyboard buffer. */
    KBBUF_START: 0x1E,
    /** Last byte of the keyboard buffer (exclusive end = 0x3E). */
    KBBUF_END: 0x3D,
    /** Disk last-status byte for INT 13h AH=01h. */
    DISK_LASTSTATUS: 0x41,
    /** Current video mode (3 = colour text 80x25). */
    VIDEO_MODE: 0x49,
    /** Number of text columns. */
    VIDEO_COLS: 0x4A,
    /** Cursor position for video page 0 (low byte = column, high byte = row). */
    CURSOR_POS_PAGE0: 0x50,
    /** Cursor type (top/bottom scan lines). */
    CURSOR_TYPE: 0x60,
    /** 32-bit timer-tick counter, incremented by INT 8 (≈ 18.2 Hz). */
    CLK_DTIMER: 0x6C,
    /** Midnight rollover flag — set by INT 8 when the tick counter wraps a day. */
    CLK_ROLLOVER: 0x70,
    /** Keyboard buffer start pointer (BDA-offset, normally 0x1E). */
    KBBUF_START_PTR: 0x80,
    /** Keyboard buffer end pointer (BDA-offset, normally 0x3E). One past the last entry. */
    KBBUF_END_PTR: 0x82,
    /** Number of text rows minus 1 (24 for 80x25). */
    VIDEO_ROWS_MINUS_1: 0x84,
};
/**
 * Default value the BIOS init code writes to the equipment word. 0x0021 =
 * one floppy + 80x25 colour text. (Same value 8086tiny's BIOS reports.)
 */
export const EQUIPMENT_DEFAULT = 0x0021;
/** 640 KiB conventional memory — matches every PC compatible from 1984 on. */
export const MEMORY_SIZE_KB_DEFAULT = 0x0280;
/** Keyboard buffer occupies offsets 0x1E..0x3D inclusive (32 bytes). */
export const KBBUF_START_DEFAULT = 0x1E;
export const KBBUF_END_DEFAULT = 0x3E; // exclusive
export const KBBUF_BYTES = KBBUF_END_DEFAULT - KBBUF_START_DEFAULT; // 32 bytes = 16 entries
/**
 * Thin façade over a {@link Memory} that does the segment-0x40 base
 * arithmetic. Created on demand by handlers; no state of its own.
 */
export class BiosDataArea {
    memory;
    constructor(memory) {
        this.memory = memory;
    }
    // --- Byte / word access keyed by BDA-relative offset ---
    readByte(offset) {
        return this.memory.readByte(BDA_BASE + offset);
    }
    writeByte(offset, value) {
        this.memory.writeByte(BDA_BASE + offset, value & 0xFF);
    }
    readWord(offset) {
        return this.memory.readWord(BDA_BASE + offset);
    }
    writeWord(offset, value) {
        this.memory.writeWord(BDA_BASE + offset, value & 0xFFFF);
    }
    /** Read a 32-bit little-endian dword. Used for the timer-tick counter. */
    readDword(offset) {
        const lo = this.readWord(offset);
        const hi = this.readWord(offset + 2);
        // `>>> 0` keeps it unsigned in case the caller compares against numbers.
        return ((hi * 0x10000) + lo) >>> 0;
    }
    writeDword(offset, value) {
        this.writeWord(offset, value & 0xFFFF);
        this.writeWord(offset + 2, (value >>> 16) & 0xFFFF);
    }
    // --- Cursor position (page 0 only — we don't model paged video) ---
    /** Returns `[col, row]` from the page-0 cursor word. */
    getCursor() {
        const word = this.readWord(BDA.CURSOR_POS_PAGE0);
        return [word & 0xFF, (word >> 8) & 0xFF];
    }
    setCursor(col, row) {
        this.writeWord(BDA.CURSOR_POS_PAGE0, ((row & 0xFF) << 8) | (col & 0xFF));
    }
    // --- Keyboard circular buffer ---
    /** True when head == tail (no keys queued). */
    isKbBufferEmpty() {
        return this.readWord(BDA.KBBUF_HEAD) === this.readWord(BDA.KBBUF_TAIL);
    }
    /**
     * True when advancing tail by one would collide with head — i.e. the
     * next push would overflow. Real BIOSes drop the new key in this case
     * (ringing the bell instead); we follow suit.
     */
    isKbBufferFull() {
        const tail = this.readWord(BDA.KBBUF_TAIL);
        const head = this.readWord(BDA.KBBUF_HEAD);
        const start = this.readWord(BDA.KBBUF_START_PTR);
        const end = this.readWord(BDA.KBBUF_END_PTR);
        let nextTail = tail + 2;
        if (nextTail >= end)
            nextTail = start;
        return nextTail === head;
    }
    /**
     * Push a key (ASCII low byte, scancode high byte) into the buffer. Returns
     * true on success, false if the buffer was full and the key was dropped.
     */
    pushKey(asciiCode, scancode) {
        if (this.isKbBufferFull())
            return false;
        const tail = this.readWord(BDA.KBBUF_TAIL);
        const start = this.readWord(BDA.KBBUF_START_PTR);
        const end = this.readWord(BDA.KBBUF_END_PTR);
        const word = ((scancode & 0xFF) << 8) | (asciiCode & 0xFF);
        this.writeWord(tail, word);
        let nextTail = tail + 2;
        if (nextTail >= end)
            nextTail = start;
        this.writeWord(BDA.KBBUF_TAIL, nextTail);
        return true;
    }
    /**
     * Read the next key without removing it. Returns -1 if the buffer is empty.
     * Each entry is `(scancode << 8) | ascii`.
     */
    peekKey() {
        if (this.isKbBufferEmpty())
            return -1;
        const head = this.readWord(BDA.KBBUF_HEAD);
        return this.readWord(head);
    }
    /**
     * Pop the next key. Returns -1 if the buffer is empty. Each entry is
     * `(scancode << 8) | ascii`.
     */
    popKey() {
        if (this.isKbBufferEmpty())
            return -1;
        const head = this.readWord(BDA.KBBUF_HEAD);
        const word = this.readWord(head);
        const start = this.readWord(BDA.KBBUF_START_PTR);
        const end = this.readWord(BDA.KBBUF_END_PTR);
        let nextHead = head + 2;
        if (nextHead >= end)
            nextHead = start;
        this.writeWord(BDA.KBBUF_HEAD, nextHead);
        return word;
    }
}
