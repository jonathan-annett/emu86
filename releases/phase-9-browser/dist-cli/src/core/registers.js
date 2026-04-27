/**
 * 8086 register file.
 *
 * Key trick: one ArrayBuffer, viewed as both Uint16Array (word regs) and
 * Uint8Array (byte halves). Because x86 is little-endian and JS typed arrays
 * use the host's native endianness (LE on every browser/runtime that ships),
 * AL naturally sits at the low byte of AX. So `AX = 0x1234` makes
 * `AL == 0x34` and `AH == 0x12` for free.
 *
 * If we ever needed big-endian portability we'd switch to DataView; in
 * practice every target is LE and the direct typed-array approach is both
 * faster and clearer.
 *
 * ModR/M encoding (x86 standard, matters for the decoder):
 *   reg16 index: 0=AX 1=CX 2=DX 3=BX 4=SP 5=BP 6=SI 7=DI
 *   reg8  index: 0=AL 1=CL 2=DL 3=BL 4=AH 5=CH 6=DH 7=BH
 *   sreg  index: 0=ES 1=CS 2=SS 3=DS
 *
 * We arrange the GP buffer to match the reg16 layout, then use a small
 * lookup to translate reg8 indices to byte offsets.
 */
export const R16 = {
    AX: 0, CX: 1, DX: 2, BX: 3,
    SP: 4, BP: 5, SI: 6, DI: 7,
};
export const R8 = {
    AL: 0, CL: 1, DL: 2, BL: 3,
    AH: 4, CH: 5, DH: 6, BH: 7,
};
export const SREG = {
    ES: 0, CS: 1, SS: 2, DS: 3,
};
export class Registers {
    // GP registers: 8 × 16 bits = 16 bytes, shared buffer for AX/AH/AL aliasing
    gpBuf = new ArrayBuffer(16);
    gpWords = new Uint16Array(this.gpBuf);
    gpBytes = new Uint8Array(this.gpBuf);
    // Segment registers (separate buffer; no byte aliasing needed)
    segWords = new Uint16Array(4);
    /** Instruction pointer. Accessed enough that a plain field beats an accessor. */
    IP = 0;
    /**
     * Maps reg8 encoded index (0..7) to byte offset in the GP buffer.
     *   AL(0)→0, CL(1)→2, DL(2)→4, BL(3)→6  (low bytes of AX/CX/DX/BX)
     *   AH(4)→1, CH(5)→3, DH(6)→5, BH(7)→7  (high bytes of same)
     */
    static REG8_OFFSET = new Uint8Array([0, 2, 4, 6, 1, 3, 5, 7]);
    // --- Generic indexed accessors (used by decoder, hot path) ---
    getReg16(i) {
        return this.gpWords[i & 7];
    }
    setReg16(i, v) {
        this.gpWords[i & 7] = v;
    }
    getReg8(i) {
        return this.gpBytes[Registers.REG8_OFFSET[i & 7]];
    }
    setReg8(i, v) {
        this.gpBytes[Registers.REG8_OFFSET[i & 7]] = v;
    }
    getSreg(i) {
        return this.segWords[i & 3];
    }
    setSreg(i, v) {
        this.segWords[i & 3] = v;
    }
    // --- Named GP accessors ---
    get AX() { return this.gpWords[R16.AX]; }
    set AX(v) { this.gpWords[R16.AX] = v; }
    get CX() { return this.gpWords[R16.CX]; }
    set CX(v) { this.gpWords[R16.CX] = v; }
    get DX() { return this.gpWords[R16.DX]; }
    set DX(v) { this.gpWords[R16.DX] = v; }
    get BX() { return this.gpWords[R16.BX]; }
    set BX(v) { this.gpWords[R16.BX] = v; }
    get SP() { return this.gpWords[R16.SP]; }
    set SP(v) { this.gpWords[R16.SP] = v; }
    get BP() { return this.gpWords[R16.BP]; }
    set BP(v) { this.gpWords[R16.BP] = v; }
    get SI() { return this.gpWords[R16.SI]; }
    set SI(v) { this.gpWords[R16.SI] = v; }
    get DI() { return this.gpWords[R16.DI]; }
    set DI(v) { this.gpWords[R16.DI] = v; }
    // --- Named byte accessors ---
    get AL() { return this.gpBytes[0]; }
    set AL(v) { this.gpBytes[0] = v; }
    get AH() { return this.gpBytes[1]; }
    set AH(v) { this.gpBytes[1] = v; }
    get CL() { return this.gpBytes[2]; }
    set CL(v) { this.gpBytes[2] = v; }
    get CH() { return this.gpBytes[3]; }
    set CH(v) { this.gpBytes[3] = v; }
    get DL() { return this.gpBytes[4]; }
    set DL(v) { this.gpBytes[4] = v; }
    get DH() { return this.gpBytes[5]; }
    set DH(v) { this.gpBytes[5] = v; }
    get BL() { return this.gpBytes[6]; }
    set BL(v) { this.gpBytes[6] = v; }
    get BH() { return this.gpBytes[7]; }
    set BH(v) { this.gpBytes[7] = v; }
    // --- Named segment accessors ---
    get ES() { return this.segWords[SREG.ES]; }
    set ES(v) { this.segWords[SREG.ES] = v; }
    get CS() { return this.segWords[SREG.CS]; }
    set CS(v) { this.segWords[SREG.CS] = v; }
    get SS() { return this.segWords[SREG.SS]; }
    set SS(v) { this.segWords[SREG.SS] = v; }
    get DS() { return this.segWords[SREG.DS]; }
    set DS(v) { this.segWords[SREG.DS] = v; }
    /** Zero everything. Caller should set power-on values (CS=0xFFFF etc.) itself. */
    reset() {
        this.gpWords.fill(0);
        this.segWords.fill(0);
        this.IP = 0;
    }
    /** Shallow snapshot for debugging / tests. Returns independent typed arrays. */
    snapshot() {
        return {
            gp: new Uint16Array(this.gpWords),
            seg: new Uint16Array(this.segWords),
            ip: this.IP,
        };
    }
    restore(snap) {
        this.gpWords.set(snap.gp);
        this.segWords.set(snap.seg);
        this.IP = snap.ip;
    }
}
