const MASK16 = 0xFFFF;
const MAX16P1 = 0x10000;
export class PIT8254 {
    basePort;
    cyclesPerPitTick;
    warn;
    risingEdgeCallbacks;
    /** Cycle residual carried between advances (sub-PIT-tick accumulation). */
    cyclesAccumulated = 0;
    channels;
    clock;
    clockUnsubscribe = null;
    constructor(clock, options = {}) {
        this.clock = clock;
        this.basePort = options.basePort ?? 0x40;
        this.cyclesPerPitTick = options.cyclesPerPitTick ?? 4;
        if (!Number.isInteger(this.cyclesPerPitTick) || this.cyclesPerPitTick < 1) {
            throw new Error(`PIT8254: cyclesPerPitTick must be a positive integer (got ${this.cyclesPerPitTick})`);
        }
        this.warn = options.warn ?? (() => { });
        this.risingEdgeCallbacks = [
            options.onChannel0RisingEdge ?? (() => { }),
            options.onChannel1RisingEdge ?? (() => { }),
            options.onChannel2RisingEdge ?? (() => { }),
        ];
        this.channels = [
            makeChannel(0),
            makeChannel(1),
            makeChannel(2),
        ];
        this.clockUnsubscribe = clock.subscribe(this);
    }
    /**
     * Detach from the clock. After `dispose()` the PIT no longer counts.
     * Useful for tests that swap clocks or for shutdown paths.
     */
    dispose() {
        if (this.clockUnsubscribe) {
            this.clockUnsubscribe();
            this.clockUnsubscribe = null;
        }
    }
    /**
     * Reserve `[basePort..basePort+3]` on the bus and route reads/writes
     * here. Call once at machine setup.
     */
    registerOn(bus) {
        bus.register({ start: this.basePort, end: this.basePort + 3 }, this);
    }
    /**
     * Override channel 2's gate input. Real PC wires this to PPI port 0x61
     * bit 0 (the speaker enable / counter gate). v0 has no PPI, so default
     * is `true` (gate held high); a future Machine wiring may flip it.
     */
    setChannel2Gate(high) {
        this.channels[2].gate = high;
    }
    /**
     * Power-on reset: returns the PIT to its post-construction state.
     *
     *   - All three channels rewound to fresh `makeChannel()` state: mode 0,
     *     access mode lobyte, divisor 0x10000, output low, gate high, not
     *     programmed, no latches, no pending divisor.
     *   - The cycles-accumulated residual is cleared, so the next clock
     *     advance starts fresh (the previous run's leftover sub-tick cycles
     *     do not bleed across reset).
     *
     * Clock subscription, `cyclesPerPitTick`, port assignments, and the
     * rising-edge callbacks are preserved — those are construction-time
     * wiring, not chip state.
     */
    reset() {
        this.cyclesAccumulated = 0;
        this.channels[0] = makeChannel(0);
        this.channels[1] = makeChannel(1);
        this.channels[2] = makeChannel(2);
    }
    // ============================================================
    // PortHandler — IOBus routes reads/writes here.
    // ============================================================
    readByte(port) {
        const offset = port - this.basePort;
        if (offset === 3) {
            // Real 8254 returns "high impedance" (open-bus) on control-port reads.
            // We mirror BasicIOBus's open-bus convention.
            return 0xFF;
        }
        if (offset < 0 || offset > 2)
            return 0xFF;
        return this.readChannel(this.channels[offset]);
    }
    writeByte(port, value) {
        const v = value & 0xFF;
        const offset = port - this.basePort;
        if (offset === 3) {
            this.writeControl(v);
            return;
        }
        if (offset < 0 || offset > 2)
            return;
        this.writeChannel(this.channels[offset], v);
    }
    // ============================================================
    // ClockSubscriber — clock notifies here on advance.
    // ============================================================
    onAdvance(cycles) {
        const total = this.cyclesAccumulated + cycles;
        const pitTicks = Math.floor(total / this.cyclesPerPitTick);
        this.cyclesAccumulated = total - pitTicks * this.cyclesPerPitTick;
        if (pitTicks <= 0)
            return;
        for (const ch of this.channels) {
            this.tickChannel(ch, pitTicks);
        }
    }
    // ============================================================
    // Inspection helpers (test-only conveniences).
    // ============================================================
    getChannelMode(n) { return this.channels[n].mode; }
    getChannelAccessMode(n) { return this.channels[n].accessMode; }
    getChannelDivisor(n) { return this.channels[n].divisor; }
    getChannelCounter(n) { return this.channels[n].counter; }
    getChannelOutput(n) { return this.channels[n].output; }
    getChannelProgrammed(n) { return this.channels[n].programmed; }
    getChannelBCD(n) { return this.channels[n].bcd; }
    hasLatchedCount(n) { return this.channels[n].latchedCount !== null; }
    hasLatchedStatus(n) { return this.channels[n].latchedStatus !== null; }
    // ============================================================
    // Control-port write — control word and read-back command.
    // ============================================================
    writeControl(v) {
        const select = (v >> 6) & 0x03;
        if (select === 3) {
            this.handleReadBack(v);
            return;
        }
        const channel = this.channels[select];
        const accessBits = (v >> 4) & 0x03;
        if (accessBits === 0) {
            // Counter-latch command (separate from access-mode change). Latch
            // the live count for the selected channel; access mode and other
            // settings are unchanged.
            this.latchCount(channel);
            return;
        }
        // Standard control word: program the channel.
        const modeBits = (v >> 1) & 0x07;
        const mode = decodeMode(modeBits);
        const accessMode = accessBits === 1 ? 'lobyte' :
            accessBits === 2 ? 'hibyte' : 'lohi';
        const bcd = (v & 0x01) !== 0;
        if (bcd) {
            this.warn(`PIT: channel ${select} programmed with BCD bit set — counting in binary instead`);
        }
        if (mode === 1 || mode === 5) {
            this.warn(`PIT: channel ${select} mode ${mode} (gate-triggered) — gate edges are not simulated; channel will not fire`);
        }
        channel.mode = mode;
        channel.accessMode = accessMode;
        channel.bcd = bcd;
        channel.programmed = false;
        channel.writeFlipflop = accessMode === 'lohi' ? 'awaitingLow' : 'awaitingLow';
        channel.readFlipflop = 'awaitingLow';
        channel.pendingDivisor = null;
        channel.mode0Fired = false;
        // The control word write also resets output to the mode-appropriate
        // initial state, even before the divisor arrives. Per Intel datasheet:
        //   Mode 0: OUT goes low immediately on control-word write.
        //   Modes 1, 2, 3, 4, 5: OUT goes high (or stays high).
        channel.output = (mode !== 0);
        // Don't clear latches — a latched count from before the new control
        // word survives until consumed (datasheet: latch is independent of
        // programming).
    }
    latchCount(channel) {
        // Already latched? Datasheet: the latch is held until the next read
        // or until ICW1 / re-init. Subsequent latch commands are ignored
        // until the existing latch is consumed. We mirror that.
        if (channel.latchedCount !== null)
            return;
        channel.latchedCount = channel.counter & MASK16;
    }
    handleReadBack(v) {
        // 8254 read-back format:
        //   bit 7..6 = 11 (selector — already verified by caller)
        //   bit 5 (/CNT, active low): 0 → latch count
        //   bit 4 (/STA, active low): 0 → latch status
        //   bit 3 = include channel 2
        //   bit 2 = include channel 1
        //   bit 1 = include channel 0
        //   bit 0 reserved (must be 0)
        const latchCount = (v & 0x20) === 0;
        const latchStatus = (v & 0x10) === 0;
        if (!latchCount && !latchStatus) {
            // Both bits high = no-op encoding. Datasheet says ignore.
            return;
        }
        for (let i = 0; i <= 2; i = (i + 1)) {
            const include = (v & (1 << (i + 1))) !== 0;
            if (!include)
                continue;
            const ch = this.channels[i];
            if (latchStatus && ch.latchedStatus === null) {
                ch.latchedStatus = this.snapshotStatus(ch);
            }
            if (latchCount) {
                this.latchCount(ch);
            }
            if (i === 2)
                break;
        }
    }
    snapshotStatus(channel) {
        // Status byte format (per 8254 datasheet):
        //   bit 7    : current OUT pin state
        //   bit 6    : null-count (1 if count register loaded but counter not
        //              yet refreshed). We don't model the "null count" window
        //              precisely; report 0 once `programmed`, 1 otherwise.
        //   bits 5..4: read/write access mode (1=lobyte, 2=hibyte, 3=lohi)
        //   bits 3..1: operating mode (mode bits as written, with mode 2/3
        //              re-encoded to canonical 010/011)
        //   bit 0    : BCD bit
        let b = 0;
        if (channel.output)
            b |= 0x80;
        if (!channel.programmed)
            b |= 0x40;
        const accessBits = channel.accessMode === 'lobyte' ? 1 :
            channel.accessMode === 'hibyte' ? 2 : 3;
        b |= (accessBits & 0x03) << 4;
        b |= (channel.mode & 0x07) << 1;
        if (channel.bcd)
            b |= 0x01;
        return b & 0xFF;
    }
    // ============================================================
    // Channel data port — divisor writes and counter reads.
    // ============================================================
    writeChannel(channel, v) {
        switch (channel.accessMode) {
            case 'lobyte':
                this.loadDivisor(channel, v);
                return;
            case 'hibyte':
                this.loadDivisor(channel, v << 8);
                return;
            case 'lohi':
                if (channel.writeFlipflop === 'awaitingLow') {
                    channel.pendingDivisorLow = v & 0xFF;
                    channel.writeFlipflop = 'awaitingHigh';
                    // For mode 0 specifically, real silicon halts counting on the
                    // first byte of a new lohi write; output stays low until both
                    // bytes are loaded. For modes 2/3, a partial write doesn't
                    // disturb the running counter. We approximate the spec's "halt
                    // on first byte for mode 0" behaviour by leaving the channel
                    // running until the second byte arrives — software targeting
                    // the 8254 typically writes both bytes immediately, so the
                    // window where this matters is sub-microsecond. Documented in
                    // the report as a v0 simplification.
                    return;
                }
                // awaitingHigh: compose the full divisor and load.
                {
                    const full = ((v & 0xFF) << 8) | channel.pendingDivisorLow;
                    channel.writeFlipflop = 'awaitingLow';
                    this.loadDivisor(channel, full);
                }
                return;
        }
    }
    loadDivisor(channel, raw) {
        const value = raw & 0xFFFF;
        // 0 means 0x10000 in the 8254 — it's the "max count" encoding. The
        // counter happily handles 16-bit values and the divisor is stored as
        // 0x10000 internally so the modular math works.
        const divisor = value === 0 ? MAX16P1 : value;
        if (channel.programmed && (channel.mode === 2 || channel.mode === 3)) {
            // Modes 2/3 latch the new divisor and apply it at the next zero
            // crossing — software relies on this for glitch-free reprogramming
            // (e.g. changing tick rate without dropping a tick).
            channel.pendingDivisor = divisor;
            return;
        }
        // Modes 0/4 (and the very first programming of any channel): apply
        // immediately and reset the counter.
        channel.divisor = divisor;
        channel.counter = divisor & MASK16; // 0x10000 stored as 0 (live counter is 16-bit)
        channel.programmed = true;
        if (channel.mode === 3) {
            this.computeMode3Phases(channel);
            channel.mode3PhaseTick = 0;
            channel.output = true; // mode 3 starts in high phase
        }
        else if (channel.mode === 0) {
            channel.output = false; // mode 0 stays low until terminal count
            channel.mode0Fired = false;
        }
        else if (channel.mode === 2) {
            channel.output = true;
        }
        else if (channel.mode === 4) {
            channel.output = true;
        }
    }
    computeMode3Phases(channel) {
        const D = channel.divisor;
        if (D % 2 === 0) {
            channel.mode3HighTicks = D / 2;
            channel.mode3LowTicks = D / 2;
        }
        else {
            // Real 8254: high for (D+1)/2, low for (D-1)/2. Asymmetric.
            channel.mode3HighTicks = (D + 1) / 2;
            channel.mode3LowTicks = (D - 1) / 2;
        }
    }
    readChannel(channel) {
        // Status latch beats count latch beats live read.
        if (channel.latchedStatus !== null) {
            const s = channel.latchedStatus;
            channel.latchedStatus = null;
            return s & 0xFF;
        }
        if (channel.latchedCount !== null) {
            const value = channel.latchedCount;
            switch (channel.accessMode) {
                case 'lobyte':
                    channel.latchedCount = null;
                    return value & 0xFF;
                case 'hibyte':
                    channel.latchedCount = null;
                    return (value >> 8) & 0xFF;
                case 'lohi':
                    if (channel.readFlipflop === 'awaitingLow') {
                        channel.readFlipflop = 'awaitingHigh';
                        return value & 0xFF;
                    }
                    channel.readFlipflop = 'awaitingLow';
                    channel.latchedCount = null;
                    return (value >> 8) & 0xFF;
            }
        }
        // Live read — counter at this exact moment.
        const live = channel.counter & 0xFFFF;
        switch (channel.accessMode) {
            case 'lobyte':
                return live & 0xFF;
            case 'hibyte':
                return (live >> 8) & 0xFF;
            case 'lohi':
                if (channel.readFlipflop === 'awaitingLow') {
                    channel.readFlipflop = 'awaitingHigh';
                    return live & 0xFF;
                }
                channel.readFlipflop = 'awaitingLow';
                return (live >> 8) & 0xFF;
        }
    }
    // ============================================================
    // Per-channel tick logic (the heart of the PIT).
    // ============================================================
    tickChannel(channel, pitTicks) {
        if (!channel.programmed)
            return;
        if (!channel.gate)
            return;
        if (pitTicks <= 0)
            return;
        switch (channel.mode) {
            case 0:
                this.tickMode0(channel, pitTicks);
                return;
            case 4:
                this.tickMode4(channel, pitTicks);
                return;
            case 2:
                this.tickMode2(channel, pitTicks);
                return;
            case 3:
                this.tickMode3(channel, pitTicks);
                return;
            case 1:
            case 5:
                // Gate-triggered modes — we don't simulate gate edges, so
                // counting effectively never starts. Documented.
                return;
        }
    }
    tickMode0(channel, N) {
        // Mode 0 (interrupt on terminal count, software-triggered):
        //   - Output is low until counter reaches 0 for the first time.
        //   - When counter reaches 0, output goes high (rising edge), and
        //     stays high. Counter wraps to 0xFFFF and continues decrementing
        //     forever (or until reprogrammed).
        const C = channel.counter;
        if (!channel.mode0Fired) {
            if (N >= C) {
                // Crossed zero this batch.
                channel.mode0Fired = true;
                channel.output = true;
                // Counter continues to decrement after the zero crossing.
                // After exactly N ticks: newCounter = (C - N) mod 0x10000.
                channel.counter = ((C - N) % MAX16P1 + MAX16P1) % MAX16P1;
                this.fireRisingEdge(channel);
                return;
            }
            channel.counter = (C - N) & MASK16;
            return;
        }
        // Already fired: just continue decrementing modulo 0x10000.
        channel.counter = ((C - N) % MAX16P1 + MAX16P1) % MAX16P1;
    }
    tickMode4(channel, N) {
        // Mode 4 (software-triggered strobe):
        //   - Output high while counting.
        //   - When counter reaches 0, output pulses low for one tick then
        //     back high. The "rising edge" is the pulse-end transition.
        //   - Like mode 0, fires once per programming. Counter wraps and
        //     continues, but output stays high after the pulse.
        const C = channel.counter;
        if (!channel.mode0Fired) {
            if (N >= C) {
                channel.mode0Fired = true;
                // The output went low at the zero-crossing tick, then back high
                // on the next tick. If our batch is large enough that we're past
                // both events, we report final state = high. If our batch lands
                // exactly on the zero-crossing tick (N === C), we'd in principle
                // see output low; but at the v0 batch granularity the output
                // observed externally is "the value at end of advance" and the
                // pulse is one tick wide — software cannot reliably observe the
                // single-tick low pulse.
                channel.output = true;
                channel.counter = ((C - N) % MAX16P1 + MAX16P1) % MAX16P1;
                this.fireRisingEdge(channel);
                return;
            }
            channel.counter = (C - N) & MASK16;
            return;
        }
        channel.counter = ((C - N) % MAX16P1 + MAX16P1) % MAX16P1;
    }
    tickMode2(channel, N) {
        // Mode 2 (rate generator):
        //   - Counter loads to D, counts down to 1 (output high), then to 0
        //     (output goes high after the brief low-at-1 tick) and reloads.
        //   - The rising edge fires once per period D.
        //   - Pending divisor (queued via reprogramming) applies at the
        //     next zero crossing.
        const D = channel.divisor;
        let remaining = N;
        let edges = 0;
        // First, walk down to (and through) the next zero crossing if N
        // covers it. Counter is in [1..D] (post-reload counter is D).
        if (remaining >= channel.counter) {
            remaining -= channel.counter;
            edges += 1;
            // Apply pending divisor at the zero crossing, if any.
            if (channel.pendingDivisor !== null) {
                channel.divisor = channel.pendingDivisor;
                channel.pendingDivisor = null;
            }
            const Dnow = channel.divisor;
            // Whole periods left.
            const wholePeriods = Math.floor(remaining / Dnow);
            edges += wholePeriods;
            remaining -= wholePeriods * Dnow;
            // remaining is now in [0..Dnow-1]
            channel.counter = Dnow - remaining;
            if (channel.counter === 0)
                channel.counter = Dnow; // shouldn't happen given remaining < Dnow
        }
        else {
            channel.counter -= remaining;
        }
        // Output state after the advance: high unless counter == 1 (the
        // single-tick low pulse). For batch granularity we report the
        // post-advance state.
        channel.output = channel.counter !== 1;
        if (edges > 0)
            this.fireRisingEdge(channel);
    }
    tickMode3(channel, N) {
        // Mode 3 (square wave): asymmetric high/low phases for odd divisor.
        //   - Track phase tick within the period; period = highTicks + lowTicks.
        //   - Output: high while phaseTick < highTicks, else low.
        //   - Rising edge: at every period boundary (phaseTick wraps to 0
        //     having previously been in the low phase).
        let remaining = N;
        let edges = 0;
        while (remaining > 0) {
            const period = channel.mode3HighTicks + channel.mode3LowTicks;
            if (period === 0) {
                // Pathological: divisor too small to form a period. Bail.
                break;
            }
            const ticksLeftInPeriod = period - channel.mode3PhaseTick;
            if (remaining < ticksLeftInPeriod) {
                channel.mode3PhaseTick += remaining;
                remaining = 0;
            }
            else {
                // Cross the end of this period.
                remaining -= ticksLeftInPeriod;
                edges += 1;
                channel.mode3PhaseTick = 0;
                if (channel.pendingDivisor !== null) {
                    channel.divisor = channel.pendingDivisor;
                    channel.pendingDivisor = null;
                    this.computeMode3Phases(channel);
                }
                if (remaining === 0)
                    break;
                // Skip whole periods analytically.
                const newPeriod = channel.mode3HighTicks + channel.mode3LowTicks;
                if (newPeriod > 0) {
                    const whole = Math.floor(remaining / newPeriod);
                    if (whole > 0) {
                        edges += whole;
                        remaining -= whole * newPeriod;
                    }
                }
            }
        }
        channel.output = channel.mode3PhaseTick < channel.mode3HighTicks;
        // Synthesize a "live counter" view. Real 8254 mode-3 counter is
        // weird (decrements by 2 each tick, sometimes by an extra at phase
        // start). We present a simple linear approximation: counter
        // decreases linearly from divisor to 0 across a full period, then
        // wraps. Software that depends on the exact stepping pattern is
        // rare; documented as a known simplification.
        const period = channel.mode3HighTicks + channel.mode3LowTicks;
        if (period > 0) {
            const D = channel.divisor;
            // Map phaseTick [0..period) → counter [D..1] roughly.
            channel.counter = Math.max(1, D - Math.floor(channel.mode3PhaseTick * D / period));
        }
        if (edges > 0)
            this.fireRisingEdge(channel);
    }
    fireRisingEdge(channel) {
        // Per the brief: the per-batch dedup means at most one callback per
        // advance, even if multiple edges occurred. Software that depends on
        // exact edge counts at high rates may lose ticks; documented.
        this.risingEdgeCallbacks[channel.index]();
    }
}
// ============================================================
// Helpers.
// ============================================================
/**
 * Decode the 3-bit mode field from a control word into one of the six
 * canonical modes. Modes 2 and 3 have alias encodings (110 → 2, 111 → 3).
 */
function decodeMode(bits) {
    switch (bits & 0x07) {
        case 0: return 0;
        case 1: return 1;
        case 2:
        case 6: return 2;
        case 3:
        case 7: return 3;
        case 4: return 4;
        case 5: return 5;
    }
    // Unreachable: 3-bit field is exhaustively covered above. The default
    // is here only to satisfy the compiler.
    return 0;
}
function makeChannel(index) {
    return {
        index,
        mode: 0,
        accessMode: 'lobyte',
        bcd: false,
        divisor: MAX16P1,
        counter: 0,
        output: false,
        gate: true,
        programmed: false,
        latchedCount: null,
        latchedStatus: null,
        writeFlipflop: 'awaitingLow',
        readFlipflop: 'awaitingLow',
        pendingDivisorLow: 0,
        mode0Fired: false,
        mode3HighTicks: 0,
        mode3LowTicks: 0,
        mode3PhaseTick: 0,
        pendingDivisor: null,
    };
}
