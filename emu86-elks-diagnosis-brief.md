# emu86 — Agent Brief: Diagnose ELKS Stuck Point + Small Fixes (Phase 5)

## TL;DR

ELKS now boots through PS/2/A20 setup, programs the PIC + PIT + IDT, services exactly one IRQ 0, prints what looks like a panic-style diagnostic ("0330 f122A d19F2 INT f002 START"), and HLTs at 0330:7e2f. **Diagnose what's actually happening**, then implement small fixes that the diagnosis indicates (slave PIC stub at 0xA0/0xA1 and/or DMA stubs are pre-authorized; anything bigger gets flagged for next brief). Document everything in `ELKS_DIAGNOSIS_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `PS2_A20_REPORT.md` (most recent — sets up this brief precisely), and `ELKS_BOOT_REPORT.md` (the prior session) before starting. The diagnostic infrastructure built in Phase 3 (`src/diagnostics/`) is still there; reuse it.

ELKS source is available at `reference/elks/` (cloned by the human at brief start). Use it to decode kernel behavior, but **do not rebuild ELKS** — we're inspecting the binary we already have.

## Hard rules

1. **Don't break existing tests.** 700 unit + 5 integration + 329 corpus, all green. Run after every meaningful change.
2. **`cpu.step()` stays pure synchronous.**
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no `// @ts-ignore`.
5. **You may add device stubs** in `src/devices/` (slave PIC, DMA controllers) following the established pattern.
6. **You may extend BIOS handlers** if diagnosis indicates ELKS uses a subfunction we stubbed.
7. **You may NOT modify** `src/cpu8086/`, `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`, or any existing device. Same locks as before.
8. **Don't rebuild ELKS.** Read source to understand; don't modify.
9. **No "fix-and-pray."** Every implementation in this brief must be motivated by a specific finding from the diagnostic phase. If you want to add a stub, you must first say what evidence indicates it's needed.

## The current state, precisely

Phase 4 ended with this trace tail:

```
RunResult: {"executed":107917,"reason":"halt-spin-exhausted"}
Counts: {"instruction":107916,"int":314,"trap":311,"io":981,"memWrite":3747,"intService":1}
Console: "ELKS....../linux.....\r\nELKS Setup .........FHt0330 f122A d19F2 INT f002 START\r\n" (187 bytes)
Final CPU: CS:IP = 0330:7e30, halted=true, IF=1
```

Three open questions about this state. Your diagnostic phase answers them:

### Q1: What does the panic-style print actually mean?

The string `"0330 f122A d19F2 INT f002 START"` is suspicious. Possible readings:

- **Panic header**: an unhandled-interrupt diagnostic where 0330 = CS, 19F2 = a register/stack value, f002 = FLAGS, "INT" = literal text, "START" = some prefix word.
- **Boot info dump**: deliberate kernel-init diagnostic printing register state for debugging.
- **Hex dump of stack frame**: format-string output of an interrupt context structure.

The format strongly suggests it's a `printk`-style call with format specifiers like `%x`. Find the format string in ELKS source at `reference/elks/` — grep for `"INT"`, `"START"`, or the register-pair pattern. Once located, the surrounding code tells us what triggered the print.

### Q2: What did ELKS install in the IDT?

The kernel programmed the IDT during init (we see memWrite count = 3747, plus IDT writes specifically would be in the 0x000-0x3FF range). Use a memory-write tracer scoped to 0x000-0x3FF to capture every IVT modification. Output: a table of vector → (CS, IP) pairs as they were last set by the kernel.

This tells us: which interrupts ELKS installed handlers for; particularly, what's at IDT[0x20] (IRQ 0); and whether any handlers point at our BIOS ROM (suggesting chain) versus the kernel's own code segments.

### Q3: Is the HLT terminal or expectant?

Disassemble the code around 0330:7e2f using the trace plus direct memory inspection. Two possible structures:

**Terminal halt** (post-panic):
```
... print panic message ...
cli
hlt
jmp $-1
```

**Expectant halt** (idle loop):
```
... wait_for_interrupt:
sti
hlt
... do something with returned data ...
jmp wait_for_interrupt
```

These are visually distinct. Determine which, document, with the disassembly.

### Q4: What did the one IRQ 0 service actually do?

`intService=1` means one IRQ went through full save-state/handler-call/IRET. Trace the instructions executed during that service: the handler's entry point (from IDT[0x20]), what it did, where it went after, whether it issued EOI to a port we model.

If the handler issued `OUT 0x20, 0x20` (master PIC EOI), the PIC's ISR should clear and we should see further IRQs. Phase 4 says it doesn't. So either:
- The handler didn't issue EOI at all
- The handler issued EOI to 0xA0 (slave PIC) — silent open-bus drop
- The handler issued EOI somewhere else entirely
- Our PIC's EOI handling has a bug (would show in corpus regression — corpus is green, so unlikely)

Trace will tell us which.

## Phase A: Diagnostic investigation (mandatory; do this first)

Don't write any device stubs yet. First produce a diagnostic report that answers Q1-Q4 above.

### Step 1: Capture the IDT

Add a memory-write filter to the existing tracer that captures only writes to linear addresses 0x000-0x3FF. Run the boot. Collect the final state of every IVT entry the kernel modified.

Output: a table in the report:

```
Vector | Final CS:IP after kernel init
0x00   | 0330:1234   (kernel divide-by-zero handler)
0x20   | 0330:5678   (IRQ 0 / timer)
0x21   | 0330:9abc   (IRQ 1 / keyboard)
...
```

### Step 2: Trace the one serviced IRQ

Find the trace event for intService=1. The events immediately following are the handler's instructions. Capture them, disassemble, and identify the EOI call (or absence thereof).

### Step 3: Decode the panic print

Search `reference/elks/` for format strings matching the print. Likely candidates:

```bash
grep -r "INT.*START" reference/elks/
grep -r "%x %x.*%x.*INT" reference/elks/
grep -r "panic" reference/elks/elks/arch/i86/kernel/
```

Find the source-code location, read the surrounding function, identify the trigger condition.

### Step 4: Examine the HLT context

The CPU stopped at 0330:7e30 (one byte past the F4 HLT at 0330:7e2f). Use the tracer to dump the instructions from say 0330:7e10 through 0330:7e60. Disassemble. Determine: is this an idle loop (expectant) or post-error halt (terminal)?

### Diagnostic report contents

After Phase A, write up findings under these headers in the report:

- **IDT state after kernel init** (Q2): the table.
- **IRQ 0 handler analysis** (Q4): disassembly of the handler, EOI behavior.
- **Panic print decoding** (Q1): what ELKS source said the format string is, what triggers the print.
- **HLT context** (Q3): disassembly around 7e2f, terminal-vs-expectant determination.

This is the hard part of the brief. Take your time. Don't proceed to Phase B until these are documented.

## Phase B: Small fixes indicated by diagnosis

Based on what Phase A found, implement zero, one, or both of:

### Fix 1: Slave PIC stub (`src/devices/slave-pic.ts`)

Implement only if Phase A finds the IRQ 0 handler issues EOI to port 0xA0 (slave PIC command port).

Shape: a minimal `PortHandler` at ports 0xA0 and 0xA1. Accepts:
- Writes to 0xA0: log if not 0x20 (EOI); silently absorb 0x20.
- Writes to 0xA1: silently absorb (slave IMR — we have no slave-connected devices).
- Reads from 0xA0: return 0x00 (no in-service interrupts).
- Reads from 0xA1: return 0xFF (all masked).
- Anything else: warn-and-ignore.

Do NOT model real cascading. We're acknowledging EOIs lost to open-bus, not implementing a second PIC. Document this as a stub with the same explicit-simplification framing as the A20 work.

Wire in `IBMPCMachine` constructor alongside the master PIC.

### Fix 2: DMA controller stubs (`src/devices/dma.ts`)

Implement only if Phase A finds the kernel programs DMA channels and our open-bus reads back wrong values that confuse the kernel.

Shape: minimal `PortHandler` at ports 0x00-0x1F (DMA1) and 0xC0-0xDF (DMA2). Accept all writes silently. Reads return 0x00. Plus the page registers at 0x80-0x9F if used.

Do NOT model any real DMA semantics. We're satisfying the program-and-forget pattern without doing transfers.

### Other fixes Phase A might indicate

If diagnosis reveals something else small (e.g., a BDA field uninitialized that ELKS reads), implement if local. If it reveals something bigger (BIOS INT 8 chain mechanism, real DMA semantics, real keyboard input path), **flag and stop** — that's the next brief.

### Phase C: Re-run and observe

After implementing whatever small fixes Phase A indicated, re-run the integration test with the same diagnostic setup. Document:

- Did `intService` count grow beyond 1? (Indicates ISR clearing properly now.)
- Did Console get more bytes? (Indicates the kernel is making progress.)
- New stuck point if any, with the same disassembly + trace approach.

## Watch out for

- **The panic-print might be intentional kernel debug output**, not an actual panic. Don't assume "panic" because the format looks like one. Read the surrounding ELKS source code carefully before drawing conclusions.
- **F002 in the print is suspicious but might be coincidence.** It's our minimum-FLAGS value (reserved bits set, all real flags clear). Could be the kernel's saved FLAGS at a particular point. Could be a constant in the format string. Could be the value of CX or DX. The surrounding source code disambiguates.
- **The HLT-then-JMP-back pattern looks identical to a wait-for-interrupt loop**. The disambiguator is what comes *after* — does control reach code that uses interrupt-delivered state, or is it dead code?
- **ELKS source might not exactly match the binary in our disk image.** If it doesn't, you may see slight code differences. Note this; don't expect line-perfect matching.
- **The slave PIC stub must not raise IRQ 1 from cascade**. Real cascaded PICs raise to the master via IRQ 2 when their inputs assert. We're not modeling that — our stub is purely passive (accept commands, return safe defaults). If a guest tries to raise an IRQ via the slave, it'll be silently lost. That's acceptable for now since we have no slave-connected devices.
- **DMA stubs that return 0x00 on every read may not be enough**. Some DMA programming sequences read back recently-written values to verify. If the kernel does this and our stubs return 0, the kernel might decide DMA is broken and abort. Watch for this in re-run; if it fails, we may need to model more DMA state.
- **"Fix-and-pray" prevention**: if Phase A doesn't clearly indicate a fix is needed, don't implement one. A clean Phase A diagnosis report with no Phase B implementation is a successful brief — the diagnosis is the deliverable.

## Stop and ask

- If you find a CPU bug from the trace (corpus didn't catch it). Surface, don't fix.
- If diagnosis indicates BIOS INT 8 chaining is needed. That's a meaningful design decision (where does our BIOS INT 8 actually live, what are the chain semantics). Flag and stop.
- If diagnosis indicates real keyboard input is needed (kernel is reading from the buffer). Flag and stop.
- If diagnosis indicates real DMA semantics are needed (kernel waits for transfer completion). Flag and stop.
- If `cpu.step()` wants to be async.
- If the corpus regresses.

## Definition of done

**Diagnostic phase** (always required):
- Phase A questions Q1-Q4 answered with evidence in the report.
- IDT-state table captured.
- IRQ 0 handler disassembly + EOI analysis.
- Panic-print decoded against ELKS source.
- HLT context determined as terminal or expectant.

**Implementation phase** (if indicated by diagnosis):
- Slave PIC stub if Q4 shows EOI to 0xA0.
- DMA stubs if Q4 or other findings show kernel programming DMA.
- Other small fixes as indicated.
- Re-run shows measurable change (more IRQs serviced, more console bytes, or different stuck point).

**Verification**:
- All existing tests + new tests pass.
- Phase 4's integration test still passes (no regression).
- Typecheck clean.
- Corpus regression clean.

The report at `ELKS_DIAGNOSIS_REPORT.md` has these sections:
- **Summary**: what was found, what was implemented, what changed.
- **Phase A: diagnosis** (the meat of the report):
  - IDT state after kernel init
  - IRQ 0 handler analysis (with disassembly)
  - Panic print decoding (with ELKS source quote)
  - HLT context (with disassembly + terminal/expectant determination)
- **Phase B: implementation** (if any):
  - What was added and why (cite the diagnostic finding that motivated each)
  - Phase C re-run results (new state of the world)
- **Things future briefs should address**: anything not implementable in this brief's scope.
- **CPU/memory bug candidates**: anything suspect from extended runtime.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`reference/elks/`** — kernel source for decoding the panic message and understanding handler structure. Particularly `elks/arch/i86/kernel/` for IRQ and trap handling.
2. **`PS2_A20_REPORT.md` and `ELKS_BOOT_REPORT.md`** — prior session findings.
3. **`src/diagnostics/`** — your tracer infrastructure from Phase 3. Use it.
4. **OSDev wiki** — for slave PIC semantics, DMA controller layout, generic PC reference.
5. **`src/devices/keyboard-controller.ts`** — your shape model for new device stubs.

## Final notes

The pattern that's worked across eight sessions: understand the system before changing it. This brief is the most extreme form of that — most of the work is investigation, with implementation as a small follow-on. The diagnosis itself is the deliverable. A clean Phase A with "I found these specific things, here's what they mean, here's what should come next" is a successful brief, even if no code changes.

If diagnosis is short and small fixes work and ELKS jumps forward another big chunk, that's bonus. If diagnosis takes the full session and produces a sharp report on what we don't yet understand, that's also success.

The next brief will be shaped by what you find. Take the time to find it precisely.
