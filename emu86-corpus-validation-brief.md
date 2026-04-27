# emu86 — Agent Brief: SingleStepTests Corpus Validation

## TL;DR

Run the SingleStepTests/8088 corpus against the 8086 implementation, triage every failure, and either fix the bug or mask documented-undefined flag bits — never both at once for the same opcode without justification. Ship a green corpus run plus a per-opcode summary of what was masked and why.

You are working in `emu86/` — a TypeScript 8086 emulator with 353 hand-written tests already passing. Read `SESSION_REPORT.md` first (top-level), then `tests/sst/README.md`, then `tests/sst/corpus.test.ts` and `tests/sst/runner.ts`. The harness is wired; the data isn't symlinked. That's your first move.

## Hard rules

1. **Don't break the existing 353 tests.** They must stay green throughout. Re-run `npm test` after every change.
2. **Don't paper over real bugs with masks.** A mask is appropriate for flag bits the Intel manual or the 8086tiny reference document as undefined for that operation. A mask is *not* appropriate to silence a register or RAM mismatch, or to silence flag bits that are documented to have defined behavior.
3. **No architectural changes.** If a bug requires changing `src/core/`, `src/memory/`, or `src/runtime/`, stop and ask. If it requires changing `src/cpu8086/cpu.ts` (the dispatch/fetch path), also stop and ask. Bug fixes should land in the relevant `opcodes-*.ts` file or `flag-helpers.ts`.
4. **`cpu.step()` stays pure synchronous.** Same constraint as before. Nothing in this work should make it async.
5. **Strict TypeScript stays strict.** No `any`, no `as unknown as`, no `// @ts-ignore`. Work with the type system.
6. **Each fix gets a regression test** in the relevant `tests/unit/opcodes-*.test.ts` file. Don't rely on the corpus alone to catch regressions — the corpus is large and slow; unit tests are fast and self-documenting.

## Setup

The corpus is at https://github.com/SingleStepTests/8088 (~1 GB, gitignored in our repo). Two reasonable approaches:

```bash
# Option A: shallow clone outside the repo, symlink the v1 dir
git clone --depth 1 https://github.com/SingleStepTests/8088.git ~/sst-corpus
ln -s ~/sst-corpus/v1 tests/sst/data

# Option B: clone directly into tests/sst/data (gitignored already)
git clone --depth 1 https://github.com/SingleStepTests/8088.git tests/sst/data-tmp
ln -s data-tmp/v1 tests/sst/data
```

Verify by running `npx vitest run tests/sst/corpus.test.ts` — the `describe.skipIf` should now find data and start running. Expect the first run to take minutes and to surface a lot of failures. That's the starting point, not the problem.

## What you're triaging

Every corpus mismatch falls into one of these buckets. Learn to recognize them on sight:

### Bucket 1: Real implementation bug (fix it)

Symptoms:
- Register mismatch (any GP reg, segment reg, IP, SP)
- RAM mismatch
- Flag bits that the Intel manual documents as defined for this op are wrong
- Mismatch is consistent across many cases for the same opcode

Action: Find the bug, fix it in the appropriate `opcodes-*.ts` or `flag-helpers.ts`, add a regression unit test that captures the exact failing case. Re-run corpus for that opcode to confirm.

### Bucket 2: Documented-undefined flag bits (mask them)

Symptoms:
- Only flag bits differ
- The bits that differ are AF after a logical op (AND/OR/XOR/TEST), or AF/PF/SF/ZF after MUL/DIV/IMUL/IDIV, or specific flag bits after shift/rotate by CL where CL > 1
- Mismatch pattern is consistent — same bits "wrong" across many cases

Action: Mask those specific bits in the corpus runner for that opcode only, with a comment citing why. Use the existing `flagsMask` option in `runSSTCase`.

### Bucket 3: Spec ambiguity / hardware quirk (investigate, then fix or mask)

Symptoms:
- Edge cases like INTO with overflow flag set, divide-by-zero behavior, prefix interaction quirks (REP+segment override, multiple prefixes)
- Behavior differs from intuition but the corpus is consistent across many cases

Action: Cross-reference with 8086tiny's C source (`https://github.com/adriancable/8086tiny`). The corpus reflects real silicon. If 8086tiny matches the corpus, fix our impl to match. If 8086tiny disagrees with the corpus, the corpus still wins — it's empirical truth — but document the divergence in a comment.

### Bucket 4: Test setup or harness bug (fix in tests/sst/)

Symptoms:
- Mismatch appears identical across totally unrelated opcodes
- The harness output doesn't match what you'd manually compute from the test JSON

Action: Bug in `tests/sst/runner.ts` or related. Fix the harness, not the CPU.

## Mask discipline

The `runSSTCase(tc, { flagsMask })` option takes a 16-bit mask where 1 = check this bit, 0 = ignore. Default is `0xFFFF` (all bits checked). To mask AF only, pass `0xFFFF & ~0x10`.

You'll likely need per-opcode masks. Structure them as a lookup keyed on the opcode (or opcode + ModR/M reg subfield for groups), defined in the corpus test file with a comment explaining each entry. Example sketch:

```ts
// Per-opcode flag mask. Bits cleared = corpus says this bit is undefined for this op.
// Reference: Intel 8086 Family User's Manual, Appendix B "Flag Effects".
const FLAG_MASKS: Record<string, number> = {
  // AND/OR/XOR/TEST leave AF undefined per Intel
  'and_8': 0xFFFF & ~0x10,
  'and_16': 0xFFFF & ~0x10,
  // MUL/IMUL leave AF, PF, SF, ZF undefined (only CF/OF defined)
  'mul_8': 0xFFFF & ~(0x10 | 0x04 | 0x80 | 0x40),
  // ... etc
};
```

Don't blanket-mask. Each entry needs a citation (Intel manual section, or 8086tiny line reference). If you can't cite it, it's probably a real bug.

## What the corpus file structure looks like

The 8088 corpus's `v1/` directory has one JSON file per opcode (or per opcode+subop for groups). Filenames are typically `<opcode>.<reg>.json` for ModR/M groups and `<opcode>.json` for non-group opcodes. The existing `loader.ts` already handles discovery via `findCorpusFiles`.

Each file is a JSON array of test cases in the shape defined by `tests/sst/types.ts`. The harness (`runSSTCase` in `runner.ts`) consumes one case at a time.

## Sequencing

1. **Set up data dir, run corpus once, capture baseline.** Expect many failures. Save the output (e.g., `npm run test:sst > corpus-baseline.txt 2>&1` or similar). Skim it before reacting — patterns matter more than individual failures.

2. **Triage by opcode, not by individual case.** Group failures by which opcode file they came from. Pick the file with the fewest failures first (likely a real bug, not a mask issue) and the file with the most failures second (likely a mask issue affecting many cases). Both teach you the patterns fastest.

3. **Within each opcode, look at the first 3-5 failures**. The harness already samples first 5 mismatches into the assertion message — use those, don't try to read individual JSON cases by hand. Patterns become obvious fast: "always AF wrong" → mask. "register also wrong" → real bug.

4. **Fix or mask, then re-run that opcode's tests in isolation** before moving on:
   ```
   npx vitest run tests/sst/corpus.test.ts -t '<opcode-filename>'
   ```
   Cheaper feedback loop than re-running everything.

5. **After every meaningful fix**, run the full unit test suite (`npm test -- --exclude tests/sst`) to confirm no regressions in hand-written tests.

6. **Once an opcode is green, move on.** Don't backtrack to add more masks "just in case." The corpus is empirical; what passes is correct enough.

7. **When everything is green**, do one final full run and capture the result. PR description should include the per-opcode mask table with citations.

## Bug magnets (where I'd expect real failures, not just masks)

These are the spots where corpus failures most often indicate real bugs rather than undefined-flag noise:

- **Shifts and rotates by CL** (the 0xD2/0xD3 group). Per-iteration flag updates are subtle. The 8086 doesn't mask CL (the 286 introduced the 0x1F mask). RCL/RCR feed CF through the rotation. ROR/ROL of zero positions should be a true no-op — flags unchanged. Last-iteration OF for shifts has specific rules.
- **BCD adjusts** (DAA/DAS/AAA/AAS). The flag-update rules in the Intel manual are notoriously imprecise; 8086tiny's source is the practical reference. AAA/AAS update CF and AF; the result on AL when the adjust path doesn't fire is also specific.
- **DIV/IDIV edge cases**. Quotient overflow (not just div-by-zero) raises INT 0. The exact condition for "quotient too large" differs between DIV and IDIV. The state pushed to the stack on the resulting INT must match real hardware (which already used `serviceInterrupt` per the report — good).
- **String ops with REP and segment overrides**. The override applies to the source operand of MOVS/CMPS but NOT to the destination (which is always ES). LODS uses DS:SI source (overridable). REP with CMPS/SCAS checks ZF; REP with MOVS/STOS/LODS doesn't.
- **PUSH/POP edge cases**. PUSH SP on 8086 pushes the *new* SP (post-decrement). POP into SS should disable interrupts for one instruction (the SS-load/SP-load gate); whether the corpus tests this depends on whether they include INT-timing tests.
- **Segment override interaction with REP-string**. Some emulators reset the override per inner iteration; the override should persist for the entire string operation.

These are also the places where, if you find a bug, the fix is likely small (a few lines) but the test should be precise.

## Bug magnets that are usually masks, not bugs

- **AF after AND/OR/XOR/TEST** — undefined per Intel
- **PF/SF/ZF/AF after MUL/IMUL/DIV/IDIV** — undefined; only CF and OF are defined for MUL/IMUL
- **AF after shift/rotate** — undefined
- **OF after shift by CL where CL > 1** — undefined for many shift variants
- **AF after DAA/DAS/AAA/AAS** in some edge cases — see 8086tiny

## Watch out for

- **The undefined-flag values the corpus reports are not random.** They reflect what the actual silicon left in the flag register, which is often related to internal microarchitecture state. Don't try to match them precisely — mask and move on.
- **Some opcodes have multiple JSON files** (ModR/M groups). Each subop is independent — `f6.0.json` (TEST) vs `f6.2.json` (NOT) have totally different flag semantics. Mask per file, not per top-level opcode.
- **The harness might have its own bugs.** If a fix doesn't make sense or a mask doesn't help, look at `runner.ts`. The bucket-4 case is rare but real.
- **Cycle data in the corpus is ignored.** Don't try to validate it. We're not cycle-accurate.
- **The corpus tests instructions in isolation** — one INT, one IRET, one MOV. We're not testing program-level correctness yet.

## Stop and ask

- If a fix needs to touch `src/core/`, `src/memory/`, `src/runtime/`, or `src/cpu8086/cpu.ts`
- If you find yourself wanting to make `cpu.step()` async
- If the same opcode keeps producing different failure patterns across runs (suggests nondeterminism, which would be very bad)
- If you find a corpus file with internally inconsistent cases (rare, but it happens at the edges)
- If you find that >25% of opcodes need masks of more than 2 flag bits — that pattern suggests the flag-helpers themselves have a systematic bug worth investigating before mass-masking

## Definition of done

- `npm run test:sst` runs cleanly on the full corpus with no failures
- `npm test` (excluding sst) shows 353+ passing tests (your regression tests for any bugs found push it higher)
- `npm run typecheck` is clean
- The corpus test file has a documented `FLAG_MASKS` table (or equivalent) with citations
- A report file `CORPUS_VALIDATION_REPORT.md` exists at the project root with these sections:
  - **Summary**: final test counts, corpus opcode/case totals, pass status
  - **Bugs found and fixed**: one entry per bug, each with the opcode, the symptom (what the corpus showed), the root cause, the fix location, and the regression test added
  - **Masks added**: one entry per `(opcode, flag-bit)` pair, with the citation (Intel manual section, or 8086tiny line/function reference)
  - **Unresolved**: anything you flagged rather than fixed, with enough detail that the next session can pick it up
  - **Verification**: the exact commands run and their output (or a summary thereof)

## Reference sources (in priority order)

1. **The corpus itself** — empirical truth.
2. **8086tiny C source** (https://github.com/adriancable/8086tiny) — for "what does real hardware actually do here."
3. **Intel 8086 Family User's Manual** — Appendix B is the flag-effects reference.
4. **Felix Cloutier's x86 reference** (https://www.felixcloutier.com/x86/) — readable Intel manual.

Don't trust online opcode references that aren't one of the above. Many emulator wiki pages have propagated subtle errors for years.
