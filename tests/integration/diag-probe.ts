/**
 * Phase 5 diagnostic probe. Builds on probe.ts; adds:
 *
 *   - Final IDT dump (vector → CS:IP) from memory after boot.
 *   - Capture of the instructions executed during the one IRQ 0 service
 *     (the events following the single intService event).
 *   - Memory dump around 0330:7e2f so we can hand-disassemble the HLT
 *     context.
 *   - Memory writes to 0x000-0x3FF (IDT range only — captures every IVT
 *     overwrite, not just the final state).
 *
 * Output is plain text, one section per phase. Designed to be redirected
 * to a file and quoted in ELKS_DIAGNOSIS_REPORT.md.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IBMPCMachine } from '../../src/machine/ibm-pc.js';
import { InMemoryDisk } from '../../src/disk/disk.js';
import { InMemoryConsole } from '../../src/console/console.js';
import { InMemoryHostClock } from '../../src/host-clock/host-clock.js';
import {
  Tracer,
  traceRun,
  formatEvent,
  type TraceEvent,
} from '../../src/diagnostics/index.js';

const IMG = process.argv[2] ?? 'fd1440-minix.img';
const MAX = Number(process.argv[3] ?? '300000');

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
const tracer = new Tracer({
  capacity: MAX,
  // Capture IVT writes (0x000-0x3FF) plus a wider range for context.
  memWriteRanges: [
    { start: 0x00000, end: 0x003FF },
  ],
});

m.reset();
const result = traceRun(m, { tracer, maxInstructions: MAX });

console.log('# RunResult:', JSON.stringify(result));
console.log('# Counts:', JSON.stringify(tracer.countByType()));

const events = tracer.drain();

// ============================================================
// Section 1: Final IDT state (vectors 0x00..0x40)
// ============================================================
console.log('');
console.log('## Section 1: Final IDT state (read from memory after boot)');
console.log('Vector | Offset | Segment | Linear');
console.log('-------|--------|---------|--------');
for (let vec = 0; vec < 0x100; vec++) {
  const off = m.memory.readWord(vec * 4);
  const seg = m.memory.readWord(vec * 4 + 2);
  const lin = ((seg << 4) + off) & 0xFFFFF;
  // Highlight rows where seg != 0xF000 (kernel-installed handlers).
  const tag = (seg !== 0xF000) ? '  *' : '   ';
  console.log(
    `${tag}${hex2(vec)}   |  ${hex4(off)}  |  ${hex4(seg)}   | ${hex5(lin)}`,
  );
}

// ============================================================
// Section 2: IVT-write events for vectors of interest
// (full chronological history, vectors 0, 2, 8, 9, 0x80 — kernel-installed
// vectors plus IRQ 0 / IRQ 1 even after BIOS init).
// Also note the index of each event so we can correlate with intService.
// ============================================================
console.log('');
console.log('## Section 2: IVT-write events for kernel-installed vectors');
const interesting = new Set([0x00, 0x02, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x80]);
const allMemWrites = events.filter((e) => e.type === 'memWrite' && e.addr < 0x400);
console.log(`Total IVT writes: ${allMemWrites.length}`);

// Find intService event index globally
const svcEventIdx = events.findIndex((e) => e.type === 'intService');
console.log(`intService event at global index: ${svcEventIdx}`);

for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (!e || e.type !== 'memWrite') continue;
  if (e.addr >= 0x400) continue;
  const vec = (e.addr >> 2) & 0xFF;
  if (!interesting.has(vec)) continue;
  const which = (e.addr & 2) === 0 ? 'OFF' : 'SEG';
  const sz = e.size === 'w' ? 'W' : 'B';
  const tag = (svcEventIdx >= 0 && i > svcEventIdx) ? 'POST-SVC' : 'pre-svc ';
  console.log(
    `  [${tag} idx=${i}] vec=${hex2(vec)} ${which} ${sz} addr=${hex5(e.addr)} val=${e.size === 'b' ? hex2(e.value) : hex4(e.value)}`,
  );
}

// ============================================================
// Section 3: All INT events
// ============================================================
console.log('');
console.log('## Section 3: All INT events');
const ints = events.filter((e) => e.type === 'int');
console.log(`Total: ${ints.length}`);
for (const e of ints) console.log('  ' + formatEvent(e));

// ============================================================
// Section 4: All BIOS trap fires
// ============================================================
console.log('');
console.log('## Section 4: All trap fires');
const traps = events.filter((e) => e.type === 'trap');
console.log(`Total: ${traps.length}`);
for (const e of traps) console.log('  ' + formatEvent(e));

// ============================================================
// Section 5: All intService events + events around each (50 before, 200 after)
// ============================================================
console.log('');
console.log('## Section 5: intService events + handler trace');
for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (!e || e.type !== 'intService') continue;
  console.log(`---- intService at index ${i} (50 before / 200 after) ----`);
  const head = events.slice(Math.max(0, i - 50), i);
  for (let j = 0; j < head.length; j++) {
    console.log(`  [pre i=${i - head.length + j}] ` + formatEvent(head[j]!));
  }
  console.log('  >>> ' + formatEvent(e));
  const tail = events.slice(i + 1, i + 1 + 200);
  for (let j = 0; j < tail.length; j++) {
    console.log(`  [post i=${i + 1 + j}] ` + formatEvent(tail[j]!));
  }
}

// ============================================================
// Section 5a: Reconstruct IVT contents at the moment of intService
// ============================================================
console.log('');
console.log('## Section 5a: IDT state reconstructed AT intService idx');
{
  const idtAtSvc = new Uint8Array(0x400);
  // Replay all memWrite events with addr<0x400 up to (but not including) svcEventIdx.
  for (let i = 0; i < svcEventIdx; i++) {
    const e = events[i];
    if (!e || e.type !== 'memWrite') continue;
    if (e.addr >= 0x400) continue;
    if (e.size === 'b') {
      idtAtSvc[e.addr] = e.value & 0xFF;
    } else {
      idtAtSvc[e.addr] = e.value & 0xFF;
      if (e.addr + 1 < 0x400) idtAtSvc[e.addr + 1] = (e.value >> 8) & 0xFF;
    }
  }
  console.log('Vector | Offset | Segment | Linear  (only kernel-altered or matches 0330:7d2f)');
  for (let vec = 0; vec < 0x100; vec++) {
    const off = idtAtSvc[vec * 4]! | (idtAtSvc[vec * 4 + 1]! << 8);
    const seg = idtAtSvc[vec * 4 + 2]! | (idtAtSvc[vec * 4 + 3]! << 8);
    const lin = ((seg << 4) + off) & 0xFFFFF;
    const isMatch = (off === 0x7d2f && seg === 0x0330);
    if (seg !== 0xF000 || isMatch) {
      const tag = isMatch ? ' <<< MATCHES 0330:7d2f' : '';
      console.log(`  ${hex2(vec)}  |  ${hex4(off)}  |  ${hex4(seg)}   | ${hex5(lin)}${tag}`);
    }
  }
}

// ============================================================
// Section 5b: Every IO event tallied by port (whole run)
// ============================================================
console.log('');
console.log('## Section 5b: All IO events by port');
const ioByPort = new Map<number, { in: number; out: number }>();
for (const e of events) {
  if (e.type !== 'io') continue;
  const slot = ioByPort.get(e.port) ?? { in: 0, out: 0 };
  if (e.dir === 'in') slot.in++; else slot.out++;
  ioByPort.set(e.port, slot);
}
const portsSorted = [...ioByPort.entries()].sort((a, b) => a[0] - b[0]);
for (const [port, c] of portsSorted) {
  console.log(`  port=${hex4(port)}  in=${c.in}  out=${c.out}`);
}

// ============================================================
// Section 5c: Every OUT to PIC ports 0x20/0xA0 with surrounding context
// ============================================================
console.log('');
console.log('## Section 5c: OUTs to PIC EOI ports (0x20, 0xA0)');
let eoiCount = 0;
for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (!e || e.type !== 'io') continue;
  if (e.dir !== 'out') continue;
  if (e.port !== 0x20 && e.port !== 0xA0) continue;
  eoiCount++;
  console.log(`  [idx=${i}] ` + formatEvent(e));
}
console.log(`  Total: ${eoiCount}`);

// ============================================================
// Section 5d: Memory bytes at IDT-installed handlers and at 0330:7d2f
// ============================================================
console.log('');
console.log('## Section 5d: bytes at IDT-installed handlers');
function dumpRange(label: string, baseLin: number, len = 32): void {
  console.log(`  ${label}:`);
  for (let row = 0; row < Math.ceil(len / 16); row++) {
    const cells: string[] = [];
    for (let col = 0; col < 16; col++) {
      cells.push(hex2(m.memory.readByte(baseLin + row * 16 + col)));
    }
    console.log(`    ${hex5(baseLin + row * 16)}: ${cells.join(' ')}`);
  }
}
dumpRange('IDT[0x00]=19f2:3e1a (lin=1dd3a)', 0x1dd3a);
dumpRange('IDT[0x02]=19f2:3e20 (lin=1dd40)', 0x1dd40);
dumpRange('IDT[0x08]=19f2:3db4 (lin=1dcd4)', 0x1dcd4, 64);
dumpRange('IDT[0x09]=19f2:3dba (lin=1dcda)', 0x1dcda);
dumpRange('IDT[0x80]=19f2:3e14 (lin=1dd34)', 0x1dd34);
dumpRange('post-svc handler 0330:7d2f (lin=0b02f)', 0x0b02f, 64);

// ============================================================
// Section 6: Memory dump around HLT (0330:7e00 .. 0330:7e80)
// ============================================================
console.log('');
console.log('## Section 6: Memory bytes around HLT site');
const cs = m.cpu.regs.CS;
const baseLin = ((cs << 4) + 0x7e00) & 0xFFFFF;
console.log(`CS=${hex4(cs)}  base offset=7e00  base linear=${hex5(baseLin)}`);
for (let row = 0; row < 12; row++) {
  const off = 0x7e00 + row * 16;
  const lin = ((cs << 4) + off) & 0xFFFFF;
  const cells: string[] = [];
  for (let col = 0; col < 16; col++) cells.push(hex2(m.memory.readByte(lin + col)));
  console.log(`  ${hex4(off)}: ${cells.join(' ')}`);
}

// ============================================================
// Section 7: Memory dump of the panic-print code site
// ============================================================
// We need to find where the print came from. We can scan instruction events
// for the last few INT 10h calls (vec 0x10) so we know the code that issued
// the print. The TRAP records show the BIOS handler firing — work back to
// the calling INSTR to identify the source of the print.
console.log('');
console.log('## Section 7: Last 60 INT 10h calls (so we can locate the print code)');
const int10 = ints.filter((e) => e.type === 'int' && e.vector === 0x10);
console.log(`Total INT 10h: ${int10.length}`);
for (const e of int10.slice(-60)) console.log('  ' + formatEvent(e));

// ============================================================
// Section 8: Instructions executed near HLT (last 80 instruction events)
// ============================================================
console.log('');
console.log('## Section 8: Last 80 instruction events');
const insts = events.filter((e) => e.type === 'instruction');
for (const e of insts.slice(-80)) console.log('  ' + formatEvent(e));

// ============================================================
// Section 9: Last 30 IO events
// ============================================================
console.log('');
console.log('## Section 9: Last 30 IO events');
const io = events.filter((e) => e.type === 'io');
for (const e of io.slice(-30)) console.log('  ' + formatEvent(e));

// ============================================================
// Section 10: Console output bytes
// ============================================================
console.log('');
console.log('## Section 10: Console output');
const co = console_.outputBytes;
console.log(`bytes=${co.length}`);
console.log(
  '  text=' +
    JSON.stringify(co.map((c) => String.fromCharCode(c)).join('').slice(0, 400)),
);

// ============================================================
// Section 11: Final CPU state
// ============================================================
console.log('');
console.log('## Section 11: Final CPU state');
console.log(`  CS:IP = ${hex4(m.cpu.regs.CS)}:${hex4(m.cpu.regs.IP)}`);
console.log(`  AX=${hex4(m.cpu.regs.AX)} BX=${hex4(m.cpu.regs.BX)} CX=${hex4(m.cpu.regs.CX)} DX=${hex4(m.cpu.regs.DX)}`);
console.log(`  SI=${hex4(m.cpu.regs.SI)} DI=${hex4(m.cpu.regs.DI)} BP=${hex4(m.cpu.regs.BP)} SP=${hex4(m.cpu.regs.SP)}`);
console.log(`  DS=${hex4(m.cpu.regs.DS)} ES=${hex4(m.cpu.regs.ES)} SS=${hex4(m.cpu.regs.SS)}`);
console.log(`  FLAGS=${hex4(m.cpu.flags.value)}  halted=${m.cpu.halted}  IF=${m.cpu.flags.IF}`);

function _unused(_e: TraceEvent) { /* keep import live */ }
function hex2(n: number): string { return n.toString(16).padStart(2, '0'); }
function hex4(n: number): string { return n.toString(16).padStart(4, '0'); }
function hex5(n: number): string { return n.toString(16).padStart(5, '0'); }
