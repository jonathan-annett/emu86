/**
 * Placeholder bus. Reads return open-bus values (0xFF/0xFFFF), writes are
 * dropped, and any attempt to `register()` / `unregister()` throws — there
 * is no registry to write into. Use this only for tests and CPU defaults
 * that explicitly want a no-op bus; for anything that wires real devices,
 * use `BasicIOBus` from `../io/io-bus.js`.
 */
export class NullIOBus {
    inByte(_port) { return 0xFF; }
    inWord(_port) { return 0xFFFF; }
    outByte(_port, _value) { }
    outWord(_port, _value) { }
    register(_range, _handler) {
        throw new Error('NullIOBus has no registry; use BasicIOBus to register port handlers');
    }
    unregister(_handler) {
        throw new Error('NullIOBus has no registry; use BasicIOBus to register port handlers');
    }
}
