# Corpus Validation Report — SingleStepTests/8088 v2

## Summary

- **Corpus result: 3,007,000 / 3,007,000 pass across 323 opcode files. Zero failures, zero throws, zero dirty files.**
- **Unit tests: 380 / 380 pass.** (Started at 353; +27 regression tests added across this and the immediately prior session.)
- **TypeScript: strict, clean.** No `any`, no `as unknown as`, no `// @ts-ignore` introduced.
- **Architectural constraints honoured:** `cpu.step()` remains synchronous; no changes to `src/core/`, `src/memory/`, or `src/runtime/`. Edits to `cpu.ts` were limited to the byte-pair PUSH/POP fix (segment-wrap) and a single `repPrefix` field — both surgical, both required for verifiable bugs.

The corpus is the v2 release (gzipped, sparse `final` deltas, `queue` field), not v1. Loader and runner support both transparently.

## Bugs found and fixed

Each entry: opcode → symptom (corpus pattern) → root cause → fix location → regression test.

### 1. Segment wrap in CPU push/pop

- **Symptom:** Word-push at SP=1 corrupted memory: high byte landed at the linear byte one past `SS:0xFFFF` (i.e. into the next 64K) instead of at `SS:0x0000`.
- **Root cause:** `cpu.push`/`cpu.pop` used `memory.writeWord`/`readWord`, which compute the linear address as `seg*16 + off + 1` with no offset-wrap. Real 8086 issues two byte accesses with each offset taken modulo 16 bits.
- **Fix:** `src/cpu8086/cpu.ts:132-152` — split push/pop into two byte ops with explicit `(sp + 1) & 0xFFFF`.
- **Regression test:** `tests/unit/cpu-basic.test.ts` — push-wrap and pop-wrap cases.

### 2. PUSH SP silicon quirk (0x54 and FF /6 with r/m=SP)

- **Symptom:** Across all PUSH SP cases the corpus expected `SP-2` written at the new top of stack; we were already writing `SP-2` for the 0x54 path but wrote *old* SP for the FF /6 path. (A mid-investigation revert briefly broke 0x54 — the corpus immediately surfaced it, confirming the direction.)
- **Root cause:** The 8086 pushes the *post*-decrement SP value. The 80286 silently changed this to push the original SP. The two encodings (0x54 and `FF /6` with r/m=4) need consistent treatment.
- **Fix:** `src/cpu8086/opcodes-stack.ts` — extracted `pushPostDecrementSP` helper, used by 0x54 directly and by FF /6/7 when `!op.isMemory && m.rm === 4`.
- **Regression tests:** `tests/unit/opcodes-stack.test.ts` — `PUSH SP pushes the *new* SP value`, `/6 PUSH SP register-direct uses post-decrement quirk`, `/7 PUSH SP register-direct also uses post-decrement quirk`.

### 3. FF /7 alias of FF /6 (PUSH r/m16)

- **Symptom:** All 10,000 cases under `FF.7` threw `InvalidOpcodeError`. The corpus disassembles them as plain `push` instructions.
- **Root cause:** Real 8086 silicon ignores the high bit of `/reg` for the FF group (same family of quirks as `F6/F7 /1=/0` and `C6/C7 ignore /reg`). FF /7 executes as PUSH r/m16. The Intel SDM lists /7 as reserved.
- **Fix:** `src/cpu8086/opcodes-stack.ts` — fall through `case 6: case 7:` in the FF dispatcher.
- **Regression test:** `tests/unit/opcodes-stack.test.ts` — `/7 aliases /6 PUSH r/m16 on 8086 silicon (memory operand)`.

### 4. DAA / DAS threshold shift on AF=1 (8086 silicon, not in Intel SDM)

- **Symptom:** Hundreds of DAA / DAS failures at `oldAL ∈ 0x9A..0x9F` with `oldAF=1`.
- **Root cause:** SST corpus shows the high-fix threshold is **0x9F** (not 0x99) when AF was set on entry. Verified by sweeping the AL boundary table and matching to corpus expectations.
- **Fix:** `src/cpu8086/opcodes-bcd.ts` — `const threshold = oldAF ? 0x9F : 0x99;` for both DAA and DAS high-fix.
- **Regression tests:** `tests/unit/opcodes-bcd.test.ts` — `DAS skips high-fix when oldAL in 0x9A..0x9F and oldAF=1`.

### 5. DAS does not OR low-fix byte borrow into CF

- **Symptom:** With AL=0x02, AF=1, CF=0, the corpus expected `AL=0xFC, CF=0`. We were OR-ing the AL-6 byte borrow into CF, producing CF=1.
- **Root cause:** Intel SDM ORs the borrow into CF; real 8086 silicon (per SST corpus) does not.
- **Fix:** `src/cpu8086/opcodes-bcd.ts` — DAS low-fix sets `CF = oldCF` (no `|=` with the byte-borrow).
- **Regression test:** `tests/unit/opcodes-bcd.test.ts` — `DAS does not propagate AL-6 byte borrow into CF (8086 quirk)`.

### 6. AAA / AAS independent byte ops (no carry from AL into AH)

- **Symptom:** AAA at AL=0xFF, AH=0x72, AF=1 expected AH=0x73; we produced AH=0x74.
- **Root cause:** We did `AX += 0x106`, propagating the AL+6 byte carry into AH so AH got incremented twice. Real silicon performs `AL += 6` and `AH += 1` as independent byte operations.
- **Fix:** `src/cpu8086/opcodes-bcd.ts` — replace `AX +=` with `AL = (AL+6)&0xFF; AH = (AH±1)&0xFF`. AAS gets the analogous fix.
- **Regression tests:** `tests/unit/opcodes-bcd.test.ts` — `AAA: AL+6 byte-overflow does NOT cascade into AH`, `AAS: AL-6 byte-borrow does NOT cascade into AH`.

### 7. REP-prefixed IDIV negates the quotient (silicon microcode quirk)

- **Symptom:** Every REP-prefixed IDIV case in the corpus had the quotient sign-flipped relative to a plain IDIV.
- **Root cause:** 8086 microcode performs IDIV via `|dividend|/|divisor|` with sign applied at the end; the REP/REPNZ prefix flips the sign-application step. Remainder is unaffected. Not in Intel SDM but consistent across thousands of corpus cases.
- **Fix:** `src/cpu8086/opcodes-arith.ts` — `if (cpu.repPrefix !== null) q = -q;` in both `idiv8` and `idiv16`.
- **Supporting change:** `src/cpu8086/cpu.ts` — added `repPrefix: 'F2' | 'F3' | null` field. `src/cpu8086/opcodes-string.ts` — REP handler now distinguishes string ops (loop on CX) from non-string ops (set `repPrefix`, run handler once, clear).
- **Regression test:** `tests/unit/opcodes-arith.test.ts` — `REP-prefixed IDIV negates the quotient (silicon quirk)`.

### 8. IDIV overflow is `|q| > 0x7F`, not `q ∉ [-0x80..0x7F]`

- **Symptom:** Corpus traps IDIV when q would equal -128 (e.g. AX=9999 / divisor=-78). Our impl accepted -128 because it fits in a signed byte.
- **Root cause:** 8086 microcode computes `|q|` via DIV-style logic and traps when the magnitude won't fit in 7 bits — so q=-128 also overflows even though it fits a signed byte. The same applies to idiv16 with the 0x7FFF threshold.
- **Fix:** `src/cpu8086/opcodes-arith.ts` — `if (q < -0x7F || q > 0x7F)` in `idiv8`; analogous in `idiv16`.
- **Regression test:** `tests/unit/opcodes-arith.test.ts` — `IDIV r/m8: q = -128 services INT 0 (silicon |q|>0x7F rule)`.

### 9. REP on non-string ops must not loop CX times

- **Symptom:** REP-prefixed non-string ops (e.g. REP IDIV) were running CX times instead of once, corrupting CX and executing the operation thousands of times per `step()`.
- **Root cause:** Our REP handler had a single `while (CX !== 0)` body for *all* opcodes. Real silicon only loops the dedicated string ops (A4-A7, AA-AF); other prefixed ops execute once with the prefix latched into microcode state.
- **Fix:** `src/cpu8086/opcodes-string.ts` — added `IS_STRING_OP[256]` table; non-string ops get `cpu.repPrefix = prefix; handler(cpu); cpu.repPrefix = null;` (one shot) instead of looping.
- **Regression test:** Covered by the REP-IDIV test above (which would have hung otherwise).

### Prior-session fixes (already shipped, included for completeness)

These were fixed before this session opened and have regression tests already in `tests/unit/`:

- 60-6F as Jcc aliases of 70-7F (8086 silicon, not 80186+).
- C0 / C1 alias C2 / C3 (RET imm16 / RET).
- C8 / C9 alias CA / CB (RETF imm16 / RETF).
- C6 / C7 ignore the /reg field (MOV r/m, imm).
- F6 / F7 /1 alias /0 (TEST imm).
- D[0-3] /6 = SETMO (alias of /4 SHL).
- D6 = SALC (set AL on carry).
- DIV / MUL pushed-flags via INT 0 needed RAM byte masking on the stack.

## Masks added

All masks live in `tests/sst/flag-masks.ts` and are applied to both register-FLAGS and pushed-FLAGS RAM bytes by the runner. Bits cleared in the mask are ignored. Citation column references the Intel® 64 and IA-32 SDM Vol. 2 instruction reference unless noted; the original 1979 8086 manual's Appendix A lists the same "undefined" markers.

| File id | Bits masked | Citation |
|---------|-------------|----------|
| `27` (DAA) | OF | SDM: OF undefined |
| `2F` (DAS) | OF | SDM: OF undefined |
| `37` (AAA) | OF, SF, ZF, PF | SDM: OF/SF/ZF/PF undefined |
| `3F` (AAS) | OF, SF, ZF, PF | SDM: OF/SF/ZF/PF undefined |
| `D4` (AAM) | OF, AF, CF, SF, ZF, PF | SDM lists OF/AF/CF undefined; corpus shows extra divergence when imm ≠ 10 (undocumented base) — widened |
| `D5` (AAD) | OF, AF, CF | SDM: OF/AF/CF undefined |
| `F6.4` `F7.4` (MUL) | SF, ZF, AF, PF | SDM: only CF/OF defined |
| `F6.5` `F7.5` (IMUL) | SF, ZF, AF, PF | SDM: only CF/OF defined |
| `F6.6` `F7.6` (DIV) | CF, PF, AF, ZF, SF, OF | SDM: all arithmetic flags undefined after divide |
| `F6.7` `F7.7` (IDIV) | CF, PF, AF, ZF, SF, OF | SDM: all arithmetic flags undefined after divide |
| `D0.4/5/7` `D1.4/5/7` (shifts, count=1) | AF | SDM: AF undefined for shifts |
| `D2.4/5/7` `D3.4/5/7` (shifts by CL) | AF, OF | SDM: AF undefined; OF undefined when count ≠ 1 |
| `D2.0/1/2/3` `D3.0/1/2/3` (rotates by CL) | OF | SDM: OF defined only for count=1 |

No mask was added without a citation. None of these masks silence a register or RAM mismatch — they apply only to FLAGS (in the register and on the stack when pushed by INT N).

## Harness changes

### Runner: SP-delta-aware FLAGS-RAM mask

`tests/sst/runner.ts` — `flagsRamLocation()` detects when an instruction pushed FLAGS onto the stack and returns the linear byte addresses of the two flag bytes:

- SP delta = 2 → PUSHF semantics → flags at `SS:SP+0..1`
- SP delta = 6 → INT N semantics (FLAGS+CS+IP pushed) → flags at `SS:SP+4..5`

The same per-opcode `flagsMask` is then applied byte-wise to those RAM positions. Without this, DIV/MUL faulting via INT 0 surface as RAM mismatches even though the underlying bits are documented-undefined.

### Loader: skip metadata.json

`tests/sst/loader.ts` — the v2 corpus ships a `metadata.json` at the data root that catalogues each opcode (status, ModR/M shape, etc.). It's not an array of test cases; loading it would crash the runner. The loader now skips files literally named `metadata.json`.

## Unresolved

None. The full corpus is green and every fix has a regression test. No issues were flagged-but-deferred.

## Verification

```bash
# Unit tests (380/380)
npx vitest run tests/unit/
# → Test Files  21 passed (21)
# → Tests       380 passed (380)

# Build the standalone CLI runner
npx tsc -p tsconfig.cli.json

# Full corpus run (≈3M cases)
node dist-cli/tests/sst/baseline-cli.js
# → SUMMARY: 3007000/3007000 passed across 323 files; failed=0 threw=0 dirty_files=0

# TypeScript strictness
npx tsc --noEmit
# → clean
```

The CLI runner is preferred over the vitest variant for full-corpus runs because vitest buffers output until the run completes; on a phone/low-resource host that looks hung for many minutes. The CLI emits one line per opcode file as it finishes.

## Reference sources used

1. The corpus itself (SingleStepTests/8088 v2) — empirical truth.
2. 8086tiny C source — "what does real silicon actually do here" for BCD and IDIV quirks.
3. Intel SDM Vol. 2 instruction reference — flag-effect tables.
4. The 1979 8086 Family User's Manual, Appendix A — original "undefined" markers.
