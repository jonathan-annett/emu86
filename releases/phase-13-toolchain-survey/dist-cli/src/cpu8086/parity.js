/**
 * Precomputed parity lookup.
 *
 * PF = 1 when the low byte of a result has an EVEN number of set bits.
 * Computing it by counting bits per instruction would be wasteful; a 256-
 * entry table is negligible and makes every ALU-op's flag update O(1).
 *
 * Note: even for 16-bit results, x86 only parity-checks the low 8 bits.
 */
export const PARITY_TABLE = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let bits = 0;
        for (let j = 0; j < 8; j++) {
            if ((i >>> j) & 1)
                bits++;
        }
        t[i] = (bits & 1) === 0 ? 1 : 0;
    }
    return t;
})();
