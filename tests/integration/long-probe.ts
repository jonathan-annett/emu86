/**
 * Phase 6 long-run probe. Untraced fast path for high instruction counts;
 * the goal is to see how far ELKS gets when the budget is no longer the
 * bottleneck. Captures:
 *
 *   - Console output (full text)
 *   - IRQ count (intService events)
 *   - Per-port IO totals (cheap; helps spot new device touches)
 *   - INT events (cheap; software ints only — kernel banner traffic is
 *     INT 10h via printk)
 *   - Final CPU state
 *   - Wall-clock time and instructions per second
 *
 * No instruction-event tracing: that's the expensive bit. With ~50M-cap
 * runs the goal is to fly through and see where ELKS lands.
 *
 * Usage:
 *   node dist-cli/tests/integration/long-probe.js [image] [maxInstr]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import { Tracer, traceRun, formatEvent } from '../../src/diagnostics/index.js';

const IMG = process.argv[2] ?? 'fd1440-minix.img';
const MAX = Number(process.argv[3] ?? '10000000');

const path = resolve('reference/elks-images', IMG);
const bytes = readFileSync(path);
console.log(`# Image: ${IMG} (${bytes.length} bytes)`);

const geom =
  bytes.length === 1474560 ? { cylinders: 80, heads: 2, sectorsPerTrack: 18 } :
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

// Tracer with NO instruction events: capacity small (just keep the tail of
// non-instruction events for inspection). Memory writes only over IVT.
const tracer = new Tracer({
  capacity: 50_000,
  kinds: ['intService', 'int', 'trap', 'io', 'memWrite'],
  memWriteRanges: [{ start: 0x00000, end: 0x003FF }],
});

m.reset();
const t0 = Date.now();
const result = traceRun(m, { tracer, maxInstructions: MAX });
const elapsed = Date.now() - t0;

console.log('# RunResult:', JSON.stringify(result));
console.log(`# Wall clock: ${elapsed} ms (${(result.executed / (elapsed / 1000)).toFixed(0)} ips)`);
console.log('# Counts:', JSON.stringify(tracer.countByType()));

const events = tracer.drain();

// Console output
const co = console_.outputBytes;
console.log('');
console.log(`## Console output (${co.length} bytes)`);
console.log('---begin---');
process.stdout.write(co.map((c) => String.fromCharCode(c)).join(''));
console.log('\n---end---');

// IRQ count
const svcs = events.filter((e) => e.type === 'intService');
console.log('');
console.log(`## intService events: ${svcs.length} (recent up to ring capacity)`);
for (const e of svcs.slice(-20)) console.log('  ' + formatEvent(e));

// IO summary
console.log('');
console.log('## IO events by port (tail of ring; for full counts re-run capped lower)');
const byPort = new Map<number, { in: number; out: number }>();
for (const e of events) {
  if (e.type !== 'io') continue;
  const slot = byPort.get(e.port) ?? { in: 0, out: 0 };
  if (e.dir === 'in') slot.in++; else slot.out++;
  byPort.set(e.port, slot);
}
for (const [p, c] of [...byPort.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  port=${p.toString(16).padStart(4, '0')}  in=${c.in}  out=${c.out}`);
}

// Software INTs
const ints = events.filter((e) => e.type === 'int');
console.log('');
console.log(`## INT events (recent ${Math.min(ints.length, 30)})`);
for (const e of ints.slice(-30)) console.log('  ' + formatEvent(e));

// Trap fires (BIOS service tally by vector)
const traps = events.filter((e) => e.type === 'trap');
console.log('');
console.log(`## Trap events (recent ${Math.min(traps.length, 30)})`);
for (const e of traps.slice(-30)) console.log('  ' + formatEvent(e));

const trapByVec = new Map<string, number>();
for (const e of events) {
  if (e.type !== 'trap') continue;
  const key = e.vector !== null ? e.vector.toString(16).padStart(2, '0') : 'null';
  trapByVec.set(key, (trapByVec.get(key) ?? 0) + 1);
}
console.log('## Trap counts by vector (tail of ring):');
for (const [v, n] of [...trapByVec.entries()].sort()) {
  console.log(`  vec=${v}  count=${n}`);
}

// Dump CGA video memory at 0xB8000 (80x25, 2 bytes per cell — char + attr).
// If the kernel switched to direct console writes after console_init, this is
// where its output ended up.
console.log('');
console.log('## Video memory (0xB8000) text content');
{
  const lines: string[] = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
      const lin = 0xB8000 + (row * 80 + col) * 2;
      const ch = m.memory.readByte(lin);
      line += (ch >= 0x20 && ch < 0x7f) ? String.fromCharCode(ch) : (ch === 0 ? ' ' : '.');
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  // Drop trailing empty rows for readability.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const l of lines) console.log('  | ' + l);
  if (lines.length === 0) console.log('  (empty / never written)');
}

console.log('');
console.log('## Final CPU state');
console.log(`  CS:IP = ${hex4(m.cpu.regs.CS)}:${hex4(m.cpu.regs.IP)}`);
console.log(`  AX=${hex4(m.cpu.regs.AX)} BX=${hex4(m.cpu.regs.BX)} CX=${hex4(m.cpu.regs.CX)} DX=${hex4(m.cpu.regs.DX)}`);
console.log(`  SI=${hex4(m.cpu.regs.SI)} DI=${hex4(m.cpu.regs.DI)} BP=${hex4(m.cpu.regs.BP)} SP=${hex4(m.cpu.regs.SP)}`);
console.log(`  DS=${hex4(m.cpu.regs.DS)} ES=${hex4(m.cpu.regs.ES)} SS=${hex4(m.cpu.regs.SS)}`);
console.log(`  FLAGS=${hex4(m.cpu.flags.value)}  halted=${m.cpu.halted}  IF=${m.cpu.flags.IF}`);

function hex4(n: number): string { return n.toString(16).padStart(4, '0'); }
