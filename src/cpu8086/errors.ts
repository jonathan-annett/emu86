import type { Word } from '../core/types.js';

/**
 * Thrown on an opcode with no registered handler. Distinct class so tests
 * (and eventual debuggers) can catch it specifically without swallowing
 * other errors.
 */
export class InvalidOpcodeError extends Error {
  constructor(
    public readonly opcode: number,
    public readonly cs: Word,
    public readonly ip: Word,
  ) {
    super(`invalid opcode 0x${opcode.toString(16).padStart(2, '0')} at ${
      cs.toString(16).padStart(4, '0')}:${ip.toString(16).padStart(4, '0')}`);
    this.name = 'InvalidOpcodeError';
  }
}
