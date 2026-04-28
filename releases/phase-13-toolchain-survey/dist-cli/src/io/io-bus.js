export class BasicIOBus {
    entries = [];
    // ---------------- CPU side ----------------
    inByte(port) {
        const e = this.find(port);
        if (!e || !e.handler.readByte)
            return 0xFF;
        return e.handler.readByte(port) & 0xFF;
    }
    inWord(port) {
        const e = this.find(port);
        if (e?.handler.readWord) {
            return e.handler.readWord(port) & 0xFFFF;
        }
        // Word access without a word handler: split into two byte reads. Each
        // byte routes independently — the high byte may land on a different
        // handler or on open-bus.
        const lo = this.inByte(port);
        const hi = this.inByte((port + 1) & 0xFFFF);
        return ((hi << 8) | lo) & 0xFFFF;
    }
    outByte(port, value) {
        const e = this.find(port);
        if (!e || !e.handler.writeByte)
            return; // open-bus: drop
        e.handler.writeByte(port, value & 0xFF);
    }
    outWord(port, value) {
        const e = this.find(port);
        if (e?.handler.writeWord) {
            e.handler.writeWord(port, value & 0xFFFF);
            return;
        }
        // Split into two byte writes; each routes independently.
        this.outByte(port, value & 0xFF);
        this.outByte((port + 1) & 0xFFFF, (value >> 8) & 0xFF);
    }
    // ---------------- Device side ----------------
    register(range, handler) {
        if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
            throw new Error(`PortRange bounds must be integers (got start=${range.start}, end=${range.end})`);
        }
        if (range.start < 0 || range.end > 0xFFFF) {
            throw new Error(`PortRange out of bounds [${range.start}, ${range.end}]; must lie within 0..0xFFFF`);
        }
        if (range.start > range.end) {
            throw new Error(`PortRange.start (${range.start}) must be <= end (${range.end})`);
        }
        // Find insertion point and verify no overlap with neighbours. Cheap
        // because `entries` is small.
        let i = 0;
        while (i < this.entries.length) {
            const cur = this.entries[i];
            if (!cur || cur.range.start >= range.start)
                break;
            i++;
        }
        const prev = i > 0 ? this.entries[i - 1] : undefined;
        const next = i < this.entries.length ? this.entries[i] : undefined;
        if (prev && prev.range.end >= range.start) {
            throw new Error(`Port range [0x${hex(range.start)}..0x${hex(range.end)}] overlaps existing ` +
                `[0x${hex(prev.range.start)}..0x${hex(prev.range.end)}]`);
        }
        if (next && next.range.start <= range.end) {
            throw new Error(`Port range [0x${hex(range.start)}..0x${hex(range.end)}] overlaps existing ` +
                `[0x${hex(next.range.start)}..0x${hex(next.range.end)}]`);
        }
        this.entries.splice(i, 0, { range, handler });
    }
    unregister(handler) {
        const i = this.entries.findIndex((e) => e.handler === handler);
        if (i < 0) {
            throw new Error('unregister(): handler is not currently registered on this bus');
        }
        this.entries.splice(i, 1);
    }
    // ---------------- Internals ----------------
    /** Linear scan for the entry covering `port`, or undefined. */
    find(port) {
        for (const e of this.entries) {
            if (port < e.range.start)
                return undefined; // sorted: no later entry can match
            if (port <= e.range.end)
                return e;
        }
        return undefined;
    }
}
function hex(n) {
    return n.toString(16).toUpperCase();
}
