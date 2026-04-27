# emu86 — Agent Brief: Run ELKS to Root Mount (Phase 6)

## TL;DR

Phase 5 fixed the missing PIC vector-base programming. ELKS now boots cleanly, services 19 IRQs in 1M instructions, and is working through bootopts parsing without being stuck. **Bump the run further, see how far ELKS gets, ideally to "Mounted root device" or equivalent.** This brief is exploratory: simple cap bump first, conditional infrastructure investment if the run is healthy but the milestone is far. Document findings in `ELKS_ROOT_MOUNT_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `ELKS_DIAGNOSIS_REPORT.md` (Phase 5, immediately preceding), and `PS2_A20_REPORT.md` first. The diagnostic infrastructure (`src/diagnostics/`) and ELKS source at `reference/elks/` remain available.

## Hard rules

1. **Don't break existing tests.** 1028 tests passing (700 unit + 5 integration + 323 corpus). All must stay green.
2. **`cpu.step()` stays pure synchronous.**
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no `// @ts-ignore`.
5. **You may modify** `src/diagnostics/` (your tooling) and `tests/integration/`. You may add new diagnostics infrastructure as described below.
6. **You may NOT modify** `src/cpu8086/`, `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`, or any existing device. Same locks as before.
7. **You may add device stubs or extend BIOS handlers** if a new stuck point clearly indicates the need. Phase 5's discipline applies: each addition must be motivated by specific evidence from a trace or diagnosis.
8. **No fix-and-pray.** Phase 5 explicitly didn't take pre-authorized stubs because diagnosis showed they weren't needed. Maintain that discipline.

## Background

Phase 5's post-fix run (1M instructions):
- 19 IRQs serviced cleanly
- Kernel cycling between work and `idle_halt()` as designed
- Console output reached past `printk("START\n")` into bootopts parsing
- Final state: `instruction-limit` reached, not stuck, `halted=false` at `122a:4002`

The kernel was making forward progress when the cap was hit. The natural next question is: how far does it go with more budget?

To reach root mount, the kernel needs to:
1. Finish bootopts processing
2. Initialize disk drivers
3. Read the root filesystem superblock
4. Mount root and print a recognizable banner ("Mounted root device" or similar string from ELKS source)

Rough budget estimate: ELKS programs the PIT at 100Hz (10ms per tick). At ~47k instructions per IRQ from Phase 5, that's ~4.7M instructions per virtual second. Real ELKS boots to a shell in roughly 5-10 seconds on real hardware. Translating: ~25-50M instructions to reach a shell, perhaps half that to reach root mount. Order-of-magnitude only — your actual run will tell us the real number.

## Scope

### What you're building

Path-dependent. Start small and expand as the run reveals what's needed.

**Always**: an integration test (or extended probe) that runs ELKS to a higher instruction count than 1M. Document what happens.

**If healthy long-run but milestone far** (path 2 below): minimal diagnostic infrastructure to make long runs more useful — periodic console dumps, stuck-loop detector. Specified below.

**If stuck point hits** (path 3 below): Phase 5-style diagnosis, decide on small fix or surface for next brief.

### What you are NOT building

- Full snapshot/restore of machine state. Useful but bigger than this brief.
- Real-time pacing / wall-clock throttling. Out of scope.
- New devices unless evidence demands them.
- Browser-side anything.

## Three paths this brief might take

### Path 1: cap bump succeeds, root mount reached

You bump the instruction cap (start with 10M, escalate to 50M if needed), the kernel reaches root mount, you capture the banner. Done. Document and ship.

In this case:
- Add a single integration test that runs the kernel to root mount.
- Capture and assert on the recognized banner string.
- Document approximate instruction count needed.
- Report ends here.

### Path 2: kernel running cleanly but milestone is far

The run reveals that the kernel is making forward progress but root mount needs a *lot* of cycles, and watching a long run with no output is opaque. Invest in:

**Periodic console dump** (`src/diagnostics/`): every N instructions during a run, emit the current Console output to stderr (with a separator). Lets you see kernel progress live. Trivial — maybe 10 lines plus a wiring point in the run loop or test harness.

**Stuck-loop detector** (`src/diagnostics/`): track recent CS:IP values in a small ring buffer. If the CPU has been confined to a small CS:IP range (say, fewer than 20 unique addresses) for more than say 100k consecutive instructions, log a warning with the loop's address range and continue running. Logs once per detection then arms a cooldown.

These are tools, not architecture changes — appropriate for `src/diagnostics/`.

After installing them, run again with a higher cap. The console dumps tell you where ELKS is getting; the loop detector flags any new stuck points without having to re-engineer the trace setup.

### Path 3: new stuck point

The run hits a stuck point — same kind of pattern as Phase 4's PS/2 drain or Phase 5's missing-EOI. In that case, follow the Phase 5 playbook:

1. Identify the stuck loop (instruction trace, disassembly).
2. Understand what the kernel is waiting for (port read, memory check, etc.).
3. Cross-reference with ELKS source if useful.
4. Decide: small fix in this brief (one or two devices/handlers, well-bounded), or surface for next brief (BIOS chain mechanism, real keyboard plumbing, full DMA, etc.).
5. If small: implement, re-run, document new state.
6. If big: document the diagnosis, surface for next brief.

## Performance handling

If your final run takes more than 2 minutes wall-clock, capture and report:
- Total instruction count
- Total wall-clock time
- Instructions per second
- Wall-clock breakdown if you can (trace overhead, I/O, etc.)

Below 2 minutes, skip. The data is for future planning.

If a run takes more than 10 minutes, abort and surface — that's the regime where snapshot/resume or other big infrastructure becomes necessary, and we should plan it explicitly.

## Authorized additions

Without further questions:
- Cap bumps in tests/probes
- Periodic console dump diagnostic
- Stuck-loop detector diagnostic
- New BIOS subfunctions if ELKS demonstrably uses them
- Small device stubs if a stuck point clearly indicates need (Phase 5 pattern: motivated by evidence, minimal, accept-and-ignore semantics where possible)

Stop and ask:
- Real keyboard input plumbing (the next major piece for interactive shell)
- Snapshot/resume infrastructure
- BIOS chain mechanism for INT 8 / INT 1Ch
- Full DMA semantics
- Modifications to locked layers
- Any change that would touch `cpu.step()`'s sync property

## Definition of done

**One of three outcomes, all valid:**

**Path 1 success**: ELKS reaches root mount; banner captured; integration test asserts on it.

**Path 2 success**: ELKS makes substantial progress past Phase 5's checkpoint, diagnostic infrastructure was added and is genuinely useful; clear assessment of where the kernel is and what it would take to reach root mount.

**Path 3 success**: a new stuck point was hit, diagnosed precisely, and either fixed (with a Phase 5-style small fix) or surfaced as a clear next-brief target. The diagnosis quality matters more than the implementation outcome.

In all cases:
- All existing 1028 tests still pass.
- New integration test added (whatever scope ended up making sense).
- Typecheck clean.
- Corpus regression clean.

The report at `ELKS_ROOT_MOUNT_REPORT.md` has these sections:

- **Summary**: which path the brief took, headline outcome.
- **Run results**: instruction count, wall-clock if relevant, IRQ count, console output captured.
- **Diagnostic infrastructure added** (if any): what, why, how to use.
- **New stuck point** (if any): Phase 5-style diagnosis with disassembly, ELKS-source references, root cause analysis.
- **Implementation** (if any): what was added, motivated by what evidence.
- **Things future briefs should address**: anything surfaced. Be specific about ordering and dependencies.
- **CPU/memory bug candidates**: anything suspect. The real-code load is heavier than anything we've run before, so this is the most likely brief to surface a corpus-missed CPU bug.
- **Verification**: exact commands and outputs.

## Watch out for

- **Tracer ring eviction.** Phase 4 ran into this; Phase 5 used scoped traces. With multi-million-instruction runs, even scoped traces can fill quickly. Use kind filters aggressively (drop `instruction` events for runs that don't need them) and consider a streaming logger for long runs rather than a ring buffer.
- **Trace overhead.** Every traced event adds CPU cost. A 50M-instruction run with full instruction tracing might be 10x slower than untraced. Run untraced first to get baseline; trace only when you need to investigate.
- **Sustained kernel execution exercises sequences the corpus doesn't.** If you see a CPU bug — instructions producing visibly wrong values where the corpus would say they shouldn't — write a minimal repro in the corpus harness and surface as a finding. Do not silently fix the CPU.
- **Memory dirty set growth.** A long run with heavy disk reads will dirty many pages. The write-behind loop runs but we don't have a configured `PageStore` in tests. Verify the dirty set isn't pathological (millions of pages — would indicate a leak).
- **The "INT" / "START" line is harmless** (Phase 5 confirmed). Don't be alarmed by it appearing in console output.
- **The "/bootopts not found or bad format/size" string** is in the data segment but Phase 5 hadn't observed the kernel actually print it. If you see it printed: the kernel is searching the floppy for a config file that isn't there. Probably non-fatal — ELKS should fall through to defaults — but worth noting.
- **Kernel might hit a real panic** (different from Phase 4's misread). If you see something that looks structurally like a panic *and* the kernel goes terminal-halt afterward (HLT followed by infinite loop, no IRET, no IF=1 idle), that's real. Phase 5's analysis showed how to distinguish.

## Stop and ask

- If you find a CPU bug from real-code execution. Surface, don't fix.
- If a stuck point requires real keyboard input plumbing.
- If a stuck point requires BIOS INT 8/1Ch chaining design.
- If `cpu.step()` wants to be async.
- If wall-clock time per run exceeds 10 minutes.
- If memory or trace state grows pathologically (millions of dirty pages, gigabytes of trace).
- If the corpus regresses.

## Reference sources

1. **`reference/elks/`** — kernel source. Particularly:
   - `elks/init/main.c` — `kernel_init()` and the printk sequence
   - `elks/kernel/init/main.c` — root mount path
   - `elks/arch/i86/drivers/block/floppy.c` — floppy driver, will be exercised heavily
   - `elks/fs/minix/` — Minix filesystem support
2. **`ELKS_DIAGNOSIS_REPORT.md`** — Phase 5 patterns and the IDT/CALLF thunk explanation.
3. **`src/diagnostics/`** — your existing tooling. Build on it.
4. **OSDev wiki** — for any device-stub specifications.

## Final notes

Eight sessions in, the architecture has held under increasing load. Phase 5 was the cleanest report we've gotten — discipline pays. This brief continues the pattern: run, observe, diagnose if needed, implement small if needed, document precisely.

The likely next brief after this — depending on what you find — is one of:
- Real keyboard input plumbing (if root mount succeeds and we want shell interactivity)
- BIOS chain mechanism (if Phase 6 reveals the kernel needs it)
- Specific device support (if Phase 6 reveals a missing device that's small to add)
- Snapshot/resume infrastructure (if Phase 6 reveals we're hitting wall-clock or trace-state walls)

Document what you find sharply enough that the next brief writes itself.
