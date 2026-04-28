/**
 * Maps linear instruction addresses to JS handlers. Consulted by the CPU
 * at the top of every `step()` (after the interrupt-boundary check, before
 * the instruction fetch). Empty registries impose effectively zero cost on
 * the hot path — the CPU does one optional `Map.get` and proceeds.
 *
 * Used by Phase 2 to install BIOS service handlers at trap addresses inside
 * the BIOS ROM region.
 */
export class TrapRegistry {
    // A plain Map keyed by linear address. V8 specialises small int-keyed
    // Maps very well; the lookup cost is negligible compared to instruction
    // dispatch. We keep the data structure deliberately simple.
    #handlers = new Map();
    /**
     * Register a handler for the given linear instruction address.
     * Throws if a handler is already registered at that address — overlapping
     * registrations are a configuration bug, fail loud.
     */
    register(linearAddress, handler) {
        if (this.#handlers.has(linearAddress)) {
            throw new Error(`TrapRegistry: address 0x${linearAddress.toString(16)} already has a registered handler`);
        }
        this.#handlers.set(linearAddress, handler);
    }
    /**
     * Remove a handler. Throws if no handler was registered at that address —
     * unregistering nothing is almost certainly a bug.
     */
    unregister(linearAddress) {
        if (!this.#handlers.delete(linearAddress)) {
            throw new Error(`TrapRegistry: no handler registered at 0x${linearAddress.toString(16)}`);
        }
    }
    /** Look up a handler. Returns undefined if no handler is registered. */
    get(linearAddress) {
        return this.#handlers.get(linearAddress);
    }
    /** Number of registered handlers. */
    get size() {
        return this.#handlers.size;
    }
}
