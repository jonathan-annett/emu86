import { FLAG } from '../core/flags.js';
import { OPCODE_TABLE } from './opcodes.js';
import { serviceInterrupt } from './opcodes-int.js';
import { PARITY_TABLE } from './parity.js';

/**
 * BCD and ASCII adjust instructions.
 *
 *   0x27  DAA    Decimal Adjust AL after Addition
 *   0x2F  DAS    Decimal Adjust AL after Subtraction
 *   0x37  AAA    ASCII  Adjust AX after Addition
 *   0x3F  AAS    ASCII  Adjust AX after Subtraction
 *   0xD4  AAM    ASCII  Adjust AX after Multiply  (imm8 base, normally 10)
 *   0xD5  AAD    ASCII  Adjust AX before Division (imm8 base, normally 10)
 *
 * Pseudocode follows Intel SDM Volume 2 verbatim — these instructions
 * have surprising corner cases (e.g. DAA's "old_AL" snapshot determines the
 * second branch, not the post-low-nibble-fix value), so don't simplify
 * unless you've verified against the SST corpus.
 *
 * AAM/AAD with imm != 10 is an undocumented 8086 quirk that real silicon
 * implements faithfully — they're general "convert to base imm" ops. We
 * support it, and AAM with imm=0 raises DivideError to mirror real hardware
 * (it issues INT 0 internally on some chips).
 */

// ============================================================
// 0x27 DAA
// ============================================================

OPCODE_TABLE[0x27] = (cpu) => {
  const oldAL = cpu.regs.AL;
  const oldAF = cpu.flags.AF;
  const oldCF = cpu.flags.CF;
  let AL = oldAL;
  let CF = false;
  let AF: boolean;

  if ((AL & 0x0F) > 9 || oldAF) {
    const sum = AL + 6;
    AL = sum & 0xFF;
    CF = oldCF || (sum & 0x100) !== 0;
    AF = true;
  } else {
    AF = false;
  }
  // 8086 silicon quirk (verified against SST 8088 corpus): the high-side
  // threshold is 0x9F when AF was set on entry, 0x99 otherwise. Intel SDM
  // documents only the 0x99 threshold, but real 8086/8088 hardware (and
  // the SST corpus) shifts it up by 6 when AF was 1 — the low-nibble fix
  // already promoted oldAL into the 0xA0–0xA5 range without representing
  // an actual >99 BCD overflow. Same pattern in DAS below.
  const threshold = oldAF ? 0x9F : 0x99;
  if (oldAL > threshold || oldCF) {
    AL = (AL + 0x60) & 0xFF;
    CF = true;
  }
  cpu.regs.AL = AL;
  writeBCDFlags(cpu, AL, CF, AF);
};

// ============================================================
// 0x2F DAS
// ============================================================

OPCODE_TABLE[0x2F] = (cpu) => {
  const oldAL = cpu.regs.AL;
  const oldAF = cpu.flags.AF;
  const oldCF = cpu.flags.CF;
  let AL = oldAL;
  let CF = false;
  let AF: boolean;

  if ((AL & 0x0F) > 9 || oldAF) {
    AL = (AL - 6) & 0xFF;
    // Real 8086 DAS does NOT propagate the byte borrow from (AL-6) into
    // CF — only oldCF and the second-branch fixup contribute. Intel SDM
    // includes the borrow OR, but the SST corpus shows the chip doesn't
    // (e.g. AL=0x02, AF=1, CF=0 → AL=0xFC, CF=0). The borrow already
    // shows up as the BCD adjustment; CF is reserved for the high-side.
    CF = oldCF;
    AF = true;
  } else {
    AF = false;
  }
  // See DAA above for the threshold-shift quirk.
  const threshold = oldAF ? 0x9F : 0x99;
  if (oldAL > threshold || oldCF) {
    AL = (AL - 0x60) & 0xFF;
    CF = true;
  }
  cpu.regs.AL = AL;
  writeBCDFlags(cpu, AL, CF, AF);
};

// ============================================================
// 0x37 AAA
// ============================================================

OPCODE_TABLE[0x37] = (cpu) => {
  let CF: boolean, AF: boolean;
  if ((cpu.regs.AL & 0x0F) > 9 || cpu.flags.AF) {
    // Real 8086 increments AH and adds 6 to AL as INDEPENDENT byte ops —
    // no carry from (AL+6) is allowed to propagate into AH. Our previous
    // formulation (AX += 0x106) double-counted: when AL was 0xFA..0xFF
    // the AL+=6 overflow became a second +1 to AH. Verified against SST
    // corpus (e.g. AL=0xFF, AH=0x72 → AH must end at 0x73, not 0x74).
    cpu.regs.AL = (cpu.regs.AL + 6) & 0xFF;
    cpu.regs.AH = (cpu.regs.AH + 1) & 0xFF;
    AF = true; CF = true;
  } else {
    AF = false; CF = false;
  }
  cpu.regs.AL = cpu.regs.AL & 0x0F;
  // Intel: PF/SF/ZF/OF undefined for AAA. Only AF and CF are defined.
  let f = cpu.flags.value;
  f = CF ? (f | FLAG.CF) : (f & ~FLAG.CF);
  f = AF ? (f | FLAG.AF) : (f & ~FLAG.AF);
  cpu.flags.value = f;
};

// ============================================================
// 0x3F AAS
// ============================================================

OPCODE_TABLE[0x3F] = (cpu) => {
  let CF: boolean, AF: boolean;
  if ((cpu.regs.AL & 0x0F) > 9 || cpu.flags.AF) {
    // See AAA above — the AL fix and AH decrement are independent byte
    // ops. (AL-6) borrow must NOT propagate into AH; doing AX -= 6 and
    // then AH -= 1 over-decremented AH when AL was 0..5.
    cpu.regs.AL = (cpu.regs.AL - 6) & 0xFF;
    cpu.regs.AH = (cpu.regs.AH - 1) & 0xFF;
    AF = true; CF = true;
  } else {
    AF = false; CF = false;
  }
  cpu.regs.AL = cpu.regs.AL & 0x0F;
  let f = cpu.flags.value;
  f = CF ? (f | FLAG.CF) : (f & ~FLAG.CF);
  f = AF ? (f | FLAG.AF) : (f & ~FLAG.AF);
  cpu.flags.value = f;
};

// ============================================================
// 0xD4 AAM imm8
// ============================================================

OPCODE_TABLE[0xD4] = (cpu) => {
  const base = cpu.fetchByte();
  if (base === 0) { serviceInterrupt(cpu, 0); return; }
  const al = cpu.regs.AL;
  cpu.regs.AH = Math.trunc(al / base) & 0xFF;
  cpu.regs.AL = (al % base) & 0xFF;
  // PF/SF/ZF set from new AL; CF/OF/AF undefined (we leave them alone).
  setPSZfromAL(cpu);
};

// ============================================================
// 0xD5 AAD imm8
// ============================================================

OPCODE_TABLE[0xD5] = (cpu) => {
  const base = cpu.fetchByte();
  cpu.regs.AL = (cpu.regs.AH * base + cpu.regs.AL) & 0xFF;
  cpu.regs.AH = 0;
  setPSZfromAL(cpu);
};

// ============================================================
// Shared flag helpers
// ============================================================

function writeBCDFlags(cpu: { flags: { value: number } }, AL: number, CF: boolean, AF: boolean): void {
  let f = cpu.flags.value;
  f = CF ? (f | FLAG.CF) : (f & ~FLAG.CF);
  f = AF ? (f | FLAG.AF) : (f & ~FLAG.AF);
  f = PARITY_TABLE[AL]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = AL === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = (AL & 0x80) ? (f | FLAG.SF) : (f & ~FLAG.SF);
  cpu.flags.value = f;
}

function setPSZfromAL(cpu: { regs: { AL: number }; flags: { value: number } }): void {
  let f = cpu.flags.value;
  const al = cpu.regs.AL;
  f = PARITY_TABLE[al]! ? (f | FLAG.PF) : (f & ~FLAG.PF);
  f = al === 0 ? (f | FLAG.ZF) : (f & ~FLAG.ZF);
  f = (al & 0x80) ? (f | FLAG.SF) : (f & ~FLAG.SF);
  cpu.flags.value = f;
}
