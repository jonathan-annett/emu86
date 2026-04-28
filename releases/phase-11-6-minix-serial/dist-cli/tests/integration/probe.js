/**
 * Standalone probe: load fd1440-minix.img, run the BIOS boot, dump trace
 * digest + tail to stdout. Used for ELKS-boot triage when the integration
 * test fails — gives us a machine-readable picture of what's happening.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun, formatEvent, } from '../../src/diagnostics/index.js';
const IMG = process.argv[2] ?? 'fd1440-minix.img';
const MAX = Number(process.argv[3] ?? '300000');
const TAIL = Number(process.argv[4] ?? '100');
const path = resolve('reference/elks-images', IMG);
const bytes = readFileSync(path);
console.log(`# Image: ${IMG} (${bytes.length} bytes)`);
const geom = bytes.length === 1474560 ? { cylinders: 80, heads: 2, sectorsPerTrack: 18 } :
    bytes.length === 1228800 ? { cylinders: 80, heads: 2, sectorsPerTrack: 15 } :
        null;
if (!geom) {
    console.error(`Unknown image size ${bytes.length}`);
    process.exit(2);
}
const disk = new InMemoryDisk({ geometry: geom, contents: bytes });
const console_ = new InMemoryConsole();
const m = new IBMPCMachine({
    disk,
    console: console_,
    hostClock: new InMemoryHostClock(),
});
const tracer = new Tracer({
    capacity: MAX,
    memWriteRanges: [
        { start: 0x00000, end: 0x004FF },
        { start: 0x07C00, end: 0x07DFF },
        { start: 0xB0000, end: 0xBFFFF },
    ],
});
m.reset();
const result = traceRun(m, { tracer, maxInstructions: MAX });
console.log('# RunResult:', JSON.stringify(result));
console.log('# Counts:', JSON.stringify(tracer.countByType()));
const events = tracer.drain();
// Show all INT events
const ints = events.filter((e) => e.type === 'int');
console.log(`# INT events (${ints.length}):`);
for (const e of ints.slice(-50))
    console.log('  ' + formatEvent(e));
// Show trap fires
const traps = events.filter((e) => e.type === 'trap');
console.log(`# TRAP events (${traps.length}):`);
for (const e of traps.slice(-50))
    console.log('  ' + formatEvent(e));
// Show service events
const svc = events.filter((e) => e.type === 'intService');
console.log(`# Service events (${svc.length}):`);
for (const e of svc.slice(-30))
    console.log('  ' + formatEvent(e));
// Show last N instructions
console.log(`# Last ${TAIL} events:`);
const tail = events.slice(-TAIL);
for (const e of tail)
    console.log('  ' + formatEvent(e));
// Console output
const co = console_.outputBytes;
console.log(`# Console output (${co.length} bytes):`);
console.log('  ' + JSON.stringify(co.map((c) => c).slice(0, 200)));
console.log('  text=' + JSON.stringify(co.map((c) => String.fromCharCode(c)).join('').slice(0, 200)));
// Final CPU state
console.log('# Final CPU:');
console.log(`  CS:IP = ${m.cpu.regs.CS.toString(16).padStart(4, '0')}:${m.cpu.regs.IP.toString(16).padStart(4, '0')}`);
console.log(`  AX=${m.cpu.regs.AX.toString(16).padStart(4, '0')} BX=${m.cpu.regs.BX.toString(16).padStart(4, '0')} CX=${m.cpu.regs.CX.toString(16).padStart(4, '0')} DX=${m.cpu.regs.DX.toString(16).padStart(4, '0')}`);
console.log(`  SS:SP = ${m.cpu.regs.SS.toString(16).padStart(4, '0')}:${m.cpu.regs.SP.toString(16).padStart(4, '0')}  halted=${m.cpu.halted}`);
function _unused(_e) { }
