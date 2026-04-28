/**
 * Thrown on an opcode with no registered handler. Distinct class so tests
 * (and eventual debuggers) can catch it specifically without swallowing
 * other errors.
 */
export class InvalidOpcodeError extends Error {
    opcode;
    cs;
    ip;
    constructor(opcode, cs, ip) {
        super(`invalid opcode 0x${opcode.toString(16).padStart(2, '0')} at ${cs.toString(16).padStart(4, '0')}:${ip.toString(16).padStart(4, '0')}`);
        this.opcode = opcode;
        this.cs = cs;
        this.ip = ip;
        this.name = 'InvalidOpcodeError';
    }
}
