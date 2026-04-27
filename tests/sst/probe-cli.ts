/**
 * Diagnostic: run a single corpus file case-by-case with a wallclock
 * watchdog. If one case hangs, we'll see its name and dump its initial
 * state. Used to track down infinite loops in opcode handlers.
 *
 * Run: node dist-cli/tests/sst/probe-cli.js <fileId>
 *   e.g. probe-cli.js F7.7
 */
import { findCorpusFiles, fileId, loadCases } from './loader.js';
import { runSSTCase } from './runner.js';

function main(): number {
  const target = process.argv[2];
  if (!target) { console.error('usage: probe-cli <fileId>'); return 2; }
  const files = findCorpusFiles();
  const path = files.find((p) => fileId(p) === target);
  if (!path) { console.error(`no such file: ${target}`); return 2; }

  const cases = loadCases(path);
  console.log(`probing ${target} (${cases.length} cases)`);

  const PROGRESS = 100;
  const SLOW_MS = 500;
  let pass = 0, fail = 0, threw = 0;

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    if (process.env.PROBE_TRACE) {
      console.log(`[${i}] start: ${tc.name}`);
      console.log(`  initial.regs: ${JSON.stringify(tc.initial.regs)}`);
    }
    const t0 = Date.now();
    try {
      const r = runSSTCase(tc);
      if (r.pass) pass++; else fail++;
    } catch {
      threw++;
    }
    const dt = Date.now() - t0;
    if (dt > SLOW_MS) {
      console.log(`SLOW [${i}] ${dt}ms: ${tc.name}`);
      console.log(`  initial.regs: ${JSON.stringify(tc.initial.regs)}`);
    }
    if ((i + 1) % PROGRESS === 0) {
      console.log(`  ${i + 1}/${cases.length} pass=${pass} fail=${fail} threw=${threw}`);
    }
  }
  console.log(`done: ${pass} pass, ${fail} fail, ${threw} threw`);
  return 0;
}

process.exit(main());
