import type { LinearAddress } from '../core/types.js';
import type { CPU8086 } from './cpu.js';

/**
 * A trap handler is a JS function that runs at the top of `cpu.step()` when
 * the CPU is about to execute the instruction at a registered linear address.
 *
 * The handler runs *before* the instruction at the trap address is fetched
 * and dispatched. It receives the live CPU and may read/write registers,
 * flags, or memory. After the handler returns, the CPU continues with its
 * normal fetch/dispatch — i.e. the instruction at the trap address still
 * runs (this is the BIOS pattern: JS does the work, then the real `IRET`
 * already at that address pops flags/CS/IP back to the caller).
 *
 * Handlers should not throw. If one does, the exception propagates out of
 * `cpu.step()`, which is observable behaviour but never desired in normal
 * BIOS operation.
 */
export type TrapHandler = (cpu: CPU8086) => void;

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
  readonly #handlers = new Map<number, TrapHandler>();

  /**
   * Register a handler for the given linear instruction address.
   * Throws if a handler is already registered at that address — overlapping
   * registrations are a configuration bug, fail loud.
   */
  register(linearAddress: LinearAddress, handler: TrapHandler): void {
    if (this.#handlers.has(linearAddress)) {
      throw new Error(
        `TrapRegistry: address 0x${linearAddress.toString(16)} already has a registered handler`,
      );
    }
    this.#handlers.set(linearAddress, handler);
  }

  /**
   * Remove a handler. Throws if no handler was registered at that address —
   * unregistering nothing is almost certainly a bug.
   */
  unregister(linearAddress: LinearAddress): void {
    if (!this.#handlers.delete(linearAddress)) {
      throw new Error(
        `TrapRegistry: no handler registered at 0x${linearAddress.toString(16)}`,
      );
    }
  }

  /** Look up a handler. Returns undefined if no handler is registered. */
  get(linearAddress: LinearAddress): TrapHandler | undefined {
    return this.#handlers.get(linearAddress);
  }

  /** Number of registered handlers. */
  get size(): number {
    return this.#handlers.size;
  }
}
