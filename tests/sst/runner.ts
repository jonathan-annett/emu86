import { CPU8086 } from '../../src/cpu8086/index.js';
import { PagedMemory } from '../../src/memory/index.js';
import { linearAddress } from '../../src/core/types.js';
import type { SSTCase, SSTRegs, SSTState } from './types.js';

export interface RunSSTOptions {
  /**
   * Bit mask used when comparing the FLAGS register. Bits cleared in the
   * mask are ignored — useful for flags the 8086 leaves "undefined" after
   * certain operations (MUL, DIV, shifts by CL > 1, etc.). Default: all bits.
   */
  flagsMask?: number;
}

export interface SSTMismatch {
  kind: 'reg' | 'ram' | 'flags';
  name: string;                 // 'ax', 'flags', or a hex address like '0x1234'
  expected: number;
  actual: number;
}

export interface SSTResult {
  pass: boolean;
  mismatches: SSTMismatch[];
  case: SSTCase;
}

/**
 * Execute one SST case and return a structured pass/fail with a mismatch list.
 * Callers (vitest tests, CLI) decide how to format / assert on the result.
 */
export function runSSTCase(tc: SSTCase, opts: RunSSTOptions = {}): SSTResult {
  const flagsMask = opts.flagsMask ?? 0xFFFF;
  const mem = new PagedMemory();
  const cpu = new CPU8086(mem);
  cpu.reset();

  loadState(cpu, tc.initial);
  const initialSP = cpu.regs.SP;
  cpu.step();

  const mismatches: SSTMismatch[] = [];
  // v2 corpus convention: anything missing from `final` is unchanged from
  // `initial`. We synthesize a "merged expected" view so the comparison
  // catches an instruction that wrongly mutates a register or RAM byte
  // the corpus says shouldn't have changed. v1 corpus files happen to
  // include the full final state, so this fold is a no-op for them.
  const expectedRegs = mergeRegs(tc.initial.regs, tc.final.regs);
  const expectedRam = mergeRam(tc.initial.ram, tc.final.ram);
  collectRegMismatches(cpu, expectedRegs, flagsMask, mismatches);
  // When an opcode triggers a fault that pushes FLAGS onto the stack
  // (INT 0 from DIV, INT 4 from INTO, etc.), the pushed bytes also
  // contain documented-undefined bits — same mask applies. Locate the
  // pushed-FLAGS bytes from the SP delta and tolerate them.
  const spDelta = (initialSP - cpu.regs.SP) & 0xFFFF;
  const flagsRamAddr = flagsRamLocation(cpu, spDelta);
  collectRamMismatches(cpu, expectedRam, flagsMask, flagsRamAddr, mismatches);

  return { pass: mismatches.length === 0, mismatches, case: tc };
}

/** Final regs override initial regs; missing keys carry through unchanged. */
function mergeRegs(initial: SSTRegs, final: SSTRegs): SSTRegs {
  return { ...initial, ...final };
}

/**
 * Build the full expected RAM map: any address listed in `initial` that
 * isn't redeclared in `final` should still hold its initial value after
 * one step. Final values win where both lists contain the same address.
 */
function mergeRam(
  initial: Array<readonly [number, number]>,
  final: Array<readonly [number, number]>,
): Array<readonly [number, number]> {
  const map = new Map<number, number>();
  for (const [addr, val] of initial) map.set(addr, val & 0xFF);
  for (const [addr, val] of final) map.set(addr, val & 0xFF);
  return [...map];
}

function loadState(cpu: CPU8086, s: SSTState): void {
  // Registers first — CS/IP must be set before we'd ever call step(), and
  // memory writes use absolute linear addresses so their ordering w.r.t.
  // register loads doesn't matter.
  setRegs(cpu, s.regs);
  for (const [addr, v] of s.ram) {
    cpu.memory.writeByte(addr, v);
  }
  // Clear the dirty set that those setup writes produced, so any
  // dirty-tracking assertions in the harness aren't polluted.
  // (We don't actually assert on dirty here, but this is cheap hygiene.)
}

function setRegs(cpu: CPU8086, r: SSTRegs): void {
  if (r.ax !== undefined) cpu.regs.AX = r.ax;
  if (r.bx !== undefined) cpu.regs.BX = r.bx;
  if (r.cx !== undefined) cpu.regs.CX = r.cx;
  if (r.dx !== undefined) cpu.regs.DX = r.dx;
  if (r.sp !== undefined) cpu.regs.SP = r.sp;
  if (r.bp !== undefined) cpu.regs.BP = r.bp;
  if (r.si !== undefined) cpu.regs.SI = r.si;
  if (r.di !== undefined) cpu.regs.DI = r.di;
  if (r.es !== undefined) cpu.regs.ES = r.es;
  if (r.cs !== undefined) cpu.regs.CS = r.cs;
  if (r.ss !== undefined) cpu.regs.SS = r.ss;
  if (r.ds !== undefined) cpu.regs.DS = r.ds;
  if (r.ip !== undefined) cpu.regs.IP = r.ip;
  if (r.flags !== undefined) cpu.flags.value = r.flags;
}

function collectRegMismatches(
  cpu: CPU8086, expected: SSTRegs, flagsMask: number, out: SSTMismatch[],
): void {
  const check = (name: string, exp: number | undefined, act: number): void => {
    if (exp === undefined) return;
    if ((exp & 0xFFFF) !== (act & 0xFFFF)) {
      out.push({ kind: 'reg', name, expected: exp & 0xFFFF, actual: act & 0xFFFF });
    }
  };
  check('ax', expected.ax, cpu.regs.AX);
  check('bx', expected.bx, cpu.regs.BX);
  check('cx', expected.cx, cpu.regs.CX);
  check('dx', expected.dx, cpu.regs.DX);
  check('sp', expected.sp, cpu.regs.SP);
  check('bp', expected.bp, cpu.regs.BP);
  check('si', expected.si, cpu.regs.SI);
  check('di', expected.di, cpu.regs.DI);
  check('es', expected.es, cpu.regs.ES);
  check('cs', expected.cs, cpu.regs.CS);
  check('ss', expected.ss, cpu.regs.SS);
  check('ds', expected.ds, cpu.regs.DS);
  check('ip', expected.ip, cpu.regs.IP);

  if (expected.flags !== undefined) {
    const expMasked = expected.flags & flagsMask;
    const actMasked = cpu.flags.value & flagsMask;
    if (expMasked !== actMasked) {
      out.push({ kind: 'flags', name: 'flags', expected: expMasked, actual: actMasked });
    }
  }
}

/**
 * If the instruction's SP delta indicates a flag-push (raw PUSHF: -2 with
 * flags at SS:SP+0..1; INT N service: -6 with flags at SS:SP+4..5), return
 * the linear addresses of the two flag bytes. Otherwise null.
 *
 * Why this matters: DIV/MUL and similar leave certain flag bits "undefined"
 * — masked out of the FLAGS-register comparison via flagsMask. When the
 * same instruction triggers INT 0 (divide error), those undefined bits get
 * pushed to the stack as bytes, and a naive byte-level ram comparison flags
 * them. Masking the same byte positions with the per-opcode flag mask keeps
 * us consistent: documented-undefined stays undefined wherever it lives.
 */
function flagsRamLocation(cpu: CPU8086, spDelta: number): { lo: number; hi: number } | null {
  let off: number;
  if (spDelta === 2) off = 0;
  else if (spDelta === 6) off = 4;
  else return null;
  return {
    lo: linearAddress(cpu.regs.SS, (cpu.regs.SP + off) & 0xFFFF),
    hi: linearAddress(cpu.regs.SS, (cpu.regs.SP + off + 1) & 0xFFFF),
  };
}

function collectRamMismatches(
  cpu: CPU8086,
  expected: Array<readonly [number, number]>,
  flagsMask: number,
  flagsRamAddr: { lo: number; hi: number } | null,
  out: SSTMismatch[],
): void {
  const flagLoMask = flagsMask & 0xFF;
  const flagHiMask = (flagsMask >> 8) & 0xFF;
  for (const [addr, expVal] of expected) {
    const actVal = cpu.memory.readByte(addr);
    let mask = 0xFF;
    if (flagsRamAddr) {
      if (addr === flagsRamAddr.lo) mask = flagLoMask;
      else if (addr === flagsRamAddr.hi) mask = flagHiMask;
    }
    if (((expVal & 0xFF) & mask) !== (actVal & mask)) {
      out.push({
        kind: 'ram',
        name: `0x${addr.toString(16)}`,
        expected: expVal & 0xFF,
        actual: actVal,
      });
    }
  }
}

/** Pretty-printer for a failed result. */
export function formatMismatches(result: SSTResult): string {
  if (result.pass) return `PASS: ${result.case.name}`;
  const lines = [`FAIL: ${result.case.name}`];
  for (const m of result.mismatches) {
    const exp = m.expected.toString(16).padStart(m.kind === 'flags' ? 4 : 2, '0');
    const act = m.actual.toString(16).padStart(m.kind === 'flags' ? 4 : 2, '0');
    lines.push(`  ${m.kind} ${m.name}: expected 0x${exp}, actual 0x${act}`);
  }
  return lines.join('\n');
}

/** Convenience for building a linear address from a hand-crafted case. */
export { linearAddress };
