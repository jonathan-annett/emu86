# emu86 — Agent Brief: Complete the 8086 Instruction Set

## TL;DR

Extend the existing `emu86` codebase from its current 6-opcode v0 slice to a complete 8086 implementation. Pass the [SingleStepTests/8088](https://github.com/SingleStepTests/8088) corpus for every opcode you implement. Don't change the v0 architecture — extend it. When you're not sure, default to matching the patterns already in the codebase.

You are working in `emu86/` (a TypeScript project, no WASM, vitest for testing). Read `README.md` first, then `src/cpu8086/opcodes.ts` to see the established opcode-handler pattern. All decisions in `src/` were made deliberately; consult before changing them.

## Hard rules

1. **Don't break what works.** All 103 existing tests must stay green throughout. Run `npm test` after every meaningful change.
2. **`cpu.step()` stays pure synchronous.** No awaits, no promises. Memory access is sync; treat it as infallible (the paged memory layer never faults — see `src/memory/paged-memory.ts`).
3. **No new dependencies.** TypeScript + vitest only. If you reach for something else, stop and ask.
4. **No architectural changes.** If the existing structure makes something hard, that's a finding to surface in your PR description, not a license to refactor. The one *expected* addition is a ModR/M decoder module (described below) — that's planned, not a refactor.
5. **Strict TypeScript stays strict.** No `any`. No `as unknown as` casts to silence the compiler. The `noUncheckedIndexedAccess` setting is intentional — work with it, not around it.
6. **Test every opcode.** Inline tests with deep flag-edge coverage for representatives of each family, then SST-corpus validation for the rest. Don't ship an opcode without a corresponding test (either inline or a confirmed SST pass).

## Scope

Implement the remaining 8086 opcodes:

- ModR/M-based: MOV r/m forms, ALU r/m forms (8 families: ADD/OR/ADC/SBB/AND/SUB/XOR/CMP), shifts/rotates, MUL/DIV/IMUL/IDIV, INC/DEC r/m, the 0xFE/0xFF group, the 0xF6/0xF7 group, LEA, LDS, LES, XCHG r/m
- Stack and control: PUSH/POP (reg, segment, memory, immediate), all CALL/RET variants (near, far, with stack adjust), all JMP variants (short/near/far/indirect)
- Conditional: all Jcc (0x70-0x7F), JCXZ (0xE3), LOOP/LOOPE/LOOPNE (0xE0-0xE2)
- String ops with REP/REPE/REPNE prefixes: MOVSB/W, CMPSB/W, SCASB/W, LODSB/W, STOSB/W
- Flag and prefix ops: CLC/STC/CMC/CLI/STI/CLD/STD, segment overrides (0x26/0x2E/0x36/0x3E)
- Single-byte misc: INC/DEC reg (0x40-0x4F), PUSH/POP reg (0x50-0x5F), XCHG with AX (0x91-0x97), CBW/CWD, PUSHF/POPF/LAHF/SAHF, XLAT
- BCD/ASCII adjusts: AAA/AAS/AAM/AAD/DAA/DAS
- Software interrupts: INT/INT3/INTO/IRET (build the interrupt vector path; no async sources yet — pure software interrupts read vectors from `0:0`)
- I/O: IN/OUT (port-immediate and port-DX forms; the existing `NullIOBus` stays as default — opcodes still implementable)
- Misc: NOP is already done; HLT is already done; LOCK (0xF0) and WAIT (0x9B) treat as no-ops; ESC (0xD8-0xDF) treat as a no-op that consumes a ModR/M byte

Out of scope:
- Cycle-accurate timing (track instruction count only)
- Async-sourced interrupt delivery (queue + run-loop integration is a follow-up)
- 80286 anything
- A `Machine` config or any device emulation
- UI

## Recommended sequencing

The order matters because later units lean on earlier ones.

1. **ModR/M decoder** — `src/cpu8086/modrm.ts`. Land this with its own test file before any opcode uses it. The interface should be an "operand" abstraction with read/write methods so call sites don't branch on register-vs-memory. Required behaviors:
    - Decompose `mod`, `reg`, `rm` from the ModR/M byte
    - For `mod=11`, return a register operand (caller chooses 8 vs 16 width based on opcode)
    - For memory modes, compute the 16-bit effective address from the standard 8 EA formulas, applying any 8/16-bit displacement
    - Honor segment override prefixes (`cpu.segOverride`); when none is set, default to SS for BP-based EAs and DS for everything else
    - Handle the `mod=00, rm=110` special case correctly (it's `[disp16]`, not `[BP]`)
    - For 16-bit displacements, sign-extension follows the standard rules (use the helpers in `src/core/types.ts`)
    - The returned operand exposes the segment + offset it resolved to, for opcodes (LEA) that want the address itself rather than the value at it

2. **Segment override prefixes** (0x26 ES, 0x2E CS, 0x36 SS, 0x3E DS). Each handler sets `cpu.segOverride` and re-enters the dispatch loop for the next byte. The `segOverride` already gets reset at the start of `step()` — that's fine; the prefix runs *within* a step. Pattern: prefix handler sets `segOverride`, fetches next opcode, dispatches recursively. Don't reset `segOverride` after each instruction inside the prefix handler.

3. **ALU family** (ADD/OR/ADC/SBB/AND/SUB/XOR/CMP). Pattern: each family has the same six encodings plus the immediate group (0x80/0x81/0x82/0x83) which dispatches by the ModR/M reg field. Add corresponding `flagsXxx8`/`flagsXxx16` helpers to `flag-helpers.ts`. CMP is SUB without the writeback. Logical ops (AND/OR/XOR) clear CF and OF, set PF/ZF/SF, leave AF undefined (set it to 0; SST corpus will tell you if real hardware does something else).

4. **Stack and basic control flow**: PUSH/POP, CALL/RET (near and far), JMP variants. The `cpu.push()`/`cpu.pop()` helpers exist already. Be careful: PUSH SP on 8086 pushes the *new* SP value (after the decrement); the 286 changed this. Match 8086 semantics.

5. **Conditional jumps + LOOP family.** All flag-driven. Cross-validates the flag computations.

6. **Flag manipulation** (CLC/STC/CMC/CLI/STI/CLD/STD), simple register ops (INC/DEC reg, XCHG with AX, single-byte stack ops). Pure mechanical work.

7. **String ops with REP**. The REP prefix interaction is the subtle bit: REP/REPE/REPNE are technically separate prefixes (0xF2, 0xF3) that loop the next instruction up to CX times, with REPE/REPNE additionally checking ZF for CMPS/SCAS. The DF flag controls direction (0 = increment, 1 = decrement). Segment override interactions: source for MOVS/CMPS defaults to DS (overridable), destination always uses ES (NOT overridable).

8. **MOV r/m, r/m-to-segment, segment-to-r/m, accumulator-to/from-memory**. Mostly mechanical once ModR/M is solid.

9. **LEA, LDS, LES**. LEA writes the effective address (not the value); LDS/LES load a far pointer (offset + segment) from memory.

10. **Shifts and rotates** (0xD0-0xD3 group). Eight operations selected by ModR/M reg field: ROL, ROR, RCL, RCR, SHL/SAL, SHR, (reserved/SAL), SAR. CL-based shifts on real 8086 use the full CL value (no mask) — but the 286 introduced a 5-bit mask. Match 8086 behavior. Flag effects vary by op; consult the SST corpus.

11. **MUL/DIV/IMUL/IDIV** (in the 0xF6/0xF7 group). DIV/IDIV can trigger divide-error (INT 0). Implement that interrupt path here if not already there.

12. **INC/DEC r/m, NEG, NOT, TEST** (in 0xF6/0xF7/0xFE/0xFF). INC/DEC do NOT affect CF — easy mistake.

13. **BCD/ASCII**: AAA/AAS/AAM/AAD/DAA/DAS. The rules are baroque. Lean heavily on the SST corpus; the 8086tiny C source (https://github.com/adriancable/8086tiny) is a good reference for what the actual hardware does for ambiguous cases.

14. **Software interrupts**: INT/INT3/INTO/IRET. INT pushes flags, clears IF and TF, far-jumps via the vector table at linear `vec*4`. IRET pops in reverse. This is also where divide-error and overflow-trap (INTO) plug in.

15. **IN/OUT**. Use the existing IOBus interface; NullIOBus returns 0xFF / 0xFFFF. No new infrastructure needed.

16. **Misc**: CBW/CWD, PUSHF/POPF/LAHF/SAHF, XLAT, LOCK/WAIT/ESC as no-ops.

After all opcodes land, wire up the SingleStepTests corpus — see `tests/sst/README.md` for the procedure. Add a loader (`tests/sst/load-corpus.ts` or similar) that reads each JSON file in `tests/sst/data/` and feeds it through `runSSTCase`. Use `flagsMask` to handle "undefined flag" cases the corpus reports — start with all bits checked, then mask out only the bits the corpus documents as undefined for that opcode.

## Test depth requirement

Per opcode:

1. **Always** an inline vitest case in `tests/unit/opcodes.test.ts` (or split into `opcodes-alu.test.ts`, `opcodes-string.test.ts`, etc. once the file gets unwieldy — say >500 lines).
2. **Required coverage** per opcode: normal case, every flag the opcode is documented to affect (set and clear conditions for each), boundary conditions (zero result, sign flip, max-value carry, nibble-boundary AF, parity edges).
3. **Once SST corpus is wired**: that opcode's full SST file should pass.

Don't merge an opcode whose inline tests pass but whose SST tests fail. Investigate every divergence — it usually means a real bug, occasionally an "undefined" flag bit you need to mask.

## Things to watch out for (these are the actual bug magnets)

- **Sign extension on 8-bit displacements** (used everywhere — Jcc, ModR/M disp8, MOV-mem-disp8). Always go through `signedByte()` from `src/core/types.ts`. Forgetting this gives you off-by-128-or-more errors.
- **The `mod=00, rm=110` special case** mentioned above. If you treat it as `[BP]` you'll silently corrupt addresses.
- **BP-based EAs default to SS, not DS.** Bake into the decoder.
- **Unmasked vs masked arithmetic for flag computation.** Look at the existing `flagsAdd8`/`flagsAdd16` for the convention: pass the unmasked sum to the flag helper, mask before writing back. Same pattern applies to SUB (where you also need to know it's a borrow, not a carry — but the same `result & 0x100` test works because `a + ~b + 1` produces a borrow-out as bit 8).
- **CMP is SUB without the writeback.** Don't write the result; just compute flags.
- **Logical ops** (AND/OR/XOR/TEST) clear CF and OF unconditionally, leave AF "undefined" (set to 0 in our impl, mask in SST), and set PF/ZF/SF normally.
- **INC/DEC don't touch CF.** This is the famous trap — looks like ADD/SUB but isn't.
- **Word reads/writes that straddle a page boundary** are already handled correctly by `PagedMemory` because `readWord`/`writeWord` decompose into byte ops. Don't bypass that.
- **Stack operations always go through SS.** They never honor segment override prefixes.
- **String op destination is always ES.** Never overridable.
- **REP with CMPS/SCAS** also checks ZF; REP with MOVS/STOS/LODS doesn't. REPE and REPNE differ only in which ZF state continues the loop.
- **Interrupts pushed flags include the result of the IF/TF clear or not?** Real 8086: IF and TF are cleared *after* the FLAGS push. So the saved FLAGS reflects the pre-INT state. Easy to get backwards.
- **8086 PUSH SP** pushes the new SP (post-decrement). The 286 changed this. Don't accidentally implement 286 semantics.
- **Integer division** can throw divide-by-zero AND quotient-too-large. Both raise INT 0.
- **`flags.value` setter masks reserved bits** — POPF and IRET should still work because the setter does the right thing, but be aware: you can't push arbitrary garbage and expect it back.

## Reference sources (in priority order)

1. **The 8088 corpus itself** — empirical truth. If your impl disagrees, you're wrong.
2. **Adrian Cable's 8086tiny** (https://github.com/adriancable/8086tiny) — dense C, but the per-opcode semantics (especially BCD adjusts and the more obscure flag effects) are gold. Use as a "what does the real hardware do here" reference.
3. **Felix Cloutier's x86 reference** (https://www.felixcloutier.com/x86/) — readable Intel manual extract.
4. **Intel 8086 Family User's Manual** (PDF, easy to find) — original source of truth, but the corpus reflects what real silicon actually does, including documented and undocumented quirks. Trust the corpus when they disagree.

## Workflow

1. Read `README.md` and `src/cpu8086/opcodes.ts` end-to-end before writing anything.
2. Branch off the current state of the repo. Commit logically (one commit per opcode family is reasonable; one commit for ModR/M; one for the corpus wiring).
3. Run `npm run typecheck && npm test` after every meaningful change. Both must pass before moving on.
4. When you wire up the SST corpus, run that as a separate suite (`npm run test:sst`). Allow that suite to take minutes; it's running tens of thousands of cases.
5. PR description: list every opcode added, every test file added, any deviations from this brief (and why), and the SST corpus pass/fail summary per opcode.

## Stop and ask

Surface back to a human (commit message, comment in the PR, whatever channel you have):

- If `npm test` won't go green and you can't see why within reasonable effort
- If an SST opcode disagrees with your implementation in a way you can't reconcile via masking documented-undefined flags
- If you find yourself wanting to change something in `src/core/`, `src/memory/`, or `src/runtime/` to make an opcode work — that's almost certainly a sign you're going down the wrong path
- If `cpu.step()` starts wanting to be async — definitely stop
- If you find a real bug in v0 code that's been there since the foundation. Fix it, but flag it explicitly in the PR

Otherwise, push through. The task is large but mechanical once ModR/M is solid and the ALU family pattern is established. Most opcodes after that are 5-15 lines of handler plus tests.
