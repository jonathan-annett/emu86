# emu86 — Session Report

## Summary

Completed all 17 tasks from the v0→v1 brief, taking the 8086 emulator from a 6-opcode slice to a complete instruction-set implementation. Test count grew from 245 → **353 tests passing**, all under strict TypeScript with no new dependencies and no `cpu.step()` async leakage.

## Modules added (all new files)

| File | Opcodes |
|---|---|
| `src/cpu8086/opcodes-mov.ts` | `88`-`8E` (incl. sreg with `m.reg & 3` mask), `A0`-`A3` (moffs), `C6`/`C7` (with /reg=0 enforcement) |
| `src/cpu8086/opcodes-lea.ts` | `8D` LEA (mod=11 throws), `C4` LES, `C5` LDS |
| `src/cpu8086/opcodes-shift.ts` | `D0`-`D3` group: ROL/ROR/RCL/RCR/SHL/SHR/SAR (per-iteration loops, no count mask) |
| `src/cpu8086/opcodes-arith.ts` | `F6`/`F7` group: TEST/NOT/NEG/MUL/IMUL/DIV/IDIV; `FE` INC/DEC r/m8 |
| `src/cpu8086/opcodes-bcd.ts` | `27`/`2F`/`37`/`3F` DAA/DAS/AAA/AAS; `D4`/`D5` AAM/AAD |
| `src/cpu8086/opcodes-int.ts` | `CC`/`CD`/`CE`/`CF`; exports `serviceInterrupt(cpu, vec)` |
| `src/cpu8086/opcodes-io.ts` | `E4`-`E7` (port-immediate), `EC`-`EF` (port-DX) |
| `src/cpu8086/opcodes-misc2.ts` | XCHG `86`/`87`, CBW/CWD, WAIT, PUSHF/POPF, SAHF/LAHF, XLAT, LOCK prefix, ESC `D8`-`DF` |
| `tests/sst/loader.ts` | Corpus discovery: `corpusAvailable`, `findCorpusFiles`, `loadCases`, `fileId` |
| `tests/sst/corpus.test.ts` | `describe.skipIf` gate; one `it()` per corpus file with aggregated pass/fail |

Plus matching `tests/unit/opcodes-*.test.ts` for each new module.

## Key bugs caught during implementation

- **SHL OF flag**: Initially used MSB of the *operand*; Intel spec is MSB of the *result* XOR CF. Fixed by removing the n===1 branch in shl8/shl16.
- **IMUL r/m16 sign extension**: `Math.trunc(product / 0x10000)` returns 0 for negative products in (-65536, 0). Switched to `Math.floor` plus a positive-modulo for the low half.
- **DIV/AAM tests overwriting program bytes**: IVT entry 0 lives at linear 0x0–0x3, which collided with programs loaded at offset 0. Tests now load at offset 0x100.
- **DivideError refactored away**: Initial implementation threw a JS error; replaced with `serviceInterrupt(cpu, 0)` to match real hardware. Three existing tests updated to assert post-INT state instead of catching.

## Architecture notes

- All new opcode modules self-register into `OPCODE_TABLE` via side-effect imports listed in `cpu.ts`. No central dispatch table to keep in sync.
- `serviceInterrupt` lives in `opcodes-int.ts` and is the single source of truth for the push-flags/clear-IF/clear-TF/push-CS/push-IP/load-vector dance — used by INT*, INTO, and DIV/IDIV/AAM error paths.
- LOCK is treated as a transparent prefix (no bus modeling). ESC decodes ModR/M to advance IP correctly, then drops the operation (no FPU).

## SST corpus harness

`tests/sst/corpus.test.ts` is wired but skips silently when `tests/sst/data/` is absent (current state — corpus is gitignored). Once a developer symlinks `8088/v1/` per the existing README, every JSON file in the corpus becomes one test that runs all cases and reports `passed/total (N failed, M threw)`, with the first 5 mismatches sampled into the assertion message for debugging.

## Verification

- `npm test` — 353 passed, 1 skipped (corpus, expected)
- `npm run typecheck` — clean (both `tsconfig.json` and `tsconfig.test.json`)
