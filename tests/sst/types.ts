/**
 * Shape of a single test case from the SingleStepTests/8088 corpus.
 *
 * Each file in the corpus corresponds to one opcode (or opcode+ModR/M group)
 * and contains an array of these cases. Each case describes a starting state,
 * one instruction to execute, and the expected final state.
 *
 * Register names are lowercase in the JSON. Our harness maps them.
 *
 * Note: the instruction bytes themselves are *included* in `initial.ram` at
 * the CS:IP address — no separate "bytes" field is needed to load them.
 * Some distributions include a `bytes` array for human reference; we ignore it.
 */
export interface SSTCase {
  name: string;
  bytes?: number[];                       // optional, informational
  initial: SSTState;
  final: SSTState;
  /** Cycle trace (we don't validate cycle accuracy yet). */
  cycles?: unknown;
}

export interface SSTState {
  regs: SSTRegs;
  /** Pairs of [linearAddress, value]. */
  ram: Array<readonly [number, number]>;
}

export interface SSTRegs {
  ax?: number; bx?: number; cx?: number; dx?: number;
  sp?: number; bp?: number; si?: number; di?: number;
  cs?: number; ds?: number; es?: number; ss?: number;
  ip?: number; flags?: number;
}
