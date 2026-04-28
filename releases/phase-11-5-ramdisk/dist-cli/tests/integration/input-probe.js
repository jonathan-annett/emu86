import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun } from '../../src/diagnostics/index.js';
import { installCGAMirror, CapturingCGASink } from '../../src/diagnostics/cga-mirror.js';
import { ScancodeTranslator } from '../../src/console/scancode-translator.js';
const path = resolve('reference/elks-images', 'fd1440-minix.img');
const bytes = readFileSync(path);
const disk = new InMemoryDisk({ geometry: { cylinders: 80, heads: 2, sectorsPerTrack: 18 }, contents: bytes });
const console_ = new InMemoryConsole();
const m = new IBMPCMachine({ disk, console: console_, hostClock: new InMemoryHostClock(), cyclesPerPitTick: 4 });
const sink = new CapturingCGASink();
installCGAMirror(m, { sink });
m.reset();
// Phase 1: boot to login: (8M instructions)
const t1 = new Tracer({ capacity: 5000, kinds: ['intService'] });
console.log('# Phase 1: boot to login (8M instr)');
const r1 = traceRun(m, { tracer: t1, maxInstructions: 8_000_000 });
console.log(`# r1: ${JSON.stringify(r1)}`);
console.log('# Framebuffer after boot:');
for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
        const ch = m.memory.readByte(0xB8000 + (row * 80 + col) * 2);
        line += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : ' ';
    }
    if (line.trim())
        console.log('  ' + line);
}
// Phase 2: inject "root\n" and run more
console.log('# injecting "root\\n"');
const t = new ScancodeTranslator();
const scans = t.feed([0x72, 0x6F, 0x6F, 0x74, 0x0A]);
console.log(`# scancodes: ${scans.map((b) => b.toString(16)).join(' ')}`);
m.keyboardController.injectScancodes(scans);
const t2 = new Tracer({ capacity: 5000, kinds: ['intService'] });
console.log('# Phase 2: run for input to reach shell (5M instr)');
const r2 = traceRun(m, { tracer: t2, maxInstructions: 5_000_000 });
console.log(`# r2: ${JSON.stringify(r2)}`);
console.log(`# remaining queued scancodes: ${m.keyboardController.pendingScancodeCount}`);
console.log(`# OBF: ${m.keyboardController.outputBufferFull}`);
console.log('# Framebuffer after input:');
for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
        const ch = m.memory.readByte(0xB8000 + (row * 80 + col) * 2);
        line += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : ' ';
    }
    if (line.trim())
        console.log('  ' + line);
}
const intSvcs = t2.drain().filter((e) => e.type === 'intService').length;
console.log(`# Phase 2 intService events: ${intSvcs}`);
