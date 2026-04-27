# emu86 — Agent Brief: Boot ELKS to First Kernel Message (Phase 3 of 3)

## TL;DR

Load an ELKS disk image into the emulator, run, and either reach a recognisable kernel boot message on stdout or document precisely where and why we got stuck. **Success = some text on stdout that's clearly the ELKS kernel printing.** This is exploratory work — diagnose, triage, fix small things, surface big things. Document everything in `ELKS_BOOT_REPORT.md`.

You are working in `emu86/`. Read `README.md` and the prior reports — `MACHINE_REPORT.md`, `BIOS_INFRA_REPORT.md`, `BIOS_SERVICES_REPORT.md` — before starting. The 8086tiny BIOS source at `reference/8086tiny/bios_source/bios.asm` is reference material for any service-contract questions.

## Hard rules

1. **Don't break existing tests.** Whatever count is in `BIOS_SERVICES_REPORT.md` (~668 unit tests + 323 corpus files). All must stay green. Run `npx vitest run tests/unit/` after every meaningful change. Final corpus run as regression check.
2. **`cpu.step()` stays pure synchronous.**
3. **No custom CPU opcodes.** This is locked architecture. The CPU's instruction set stays exactly what real 8086 silicon defines.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no `// @ts-ignore`.
5. **You may add diagnostic infrastructure** (tracers, log helpers, debug dumpers). These are tools, not architecture changes. Place in `src/diagnostics/` or similar.
6. **You may extend BIOS handlers** if ELKS demonstrably uses something Phase 2 stubbed. Each extension stays in the existing handler file with a comment naming the trigger.
7. **You may add small new BIOS subfunctions or BDA fields** if ELKS needs them and the addition is local.
8. **You may NOT modify** `src/cpu8086/` (CPU and opcodes), `src/memory/` (PagedMemory), `src/runtime/` (run loop), `src/interrupts/`, `src/io/`, `src/timing/`, or `src/devices/` without stopping to ask. The corpus is our spec for those layers; if you suspect a bug there, surface it as a finding rather than silently fix.

## Phase 3 is exploratory — read this carefully

Unlike Phases 1 and 2, this brief doesn't have a precise spec to satisfy. ELKS is real software making real BIOS calls; we'll discover what it actually needs by running it. Your job:

1. Build enough diagnostic infrastructure to see what's happening.
2. Run, observe, fix what's small, document what isn't.
3. Get as far as you reasonably can.
4. Report findings honestly. **A "failed at stage X with these specific symptoms" report is just as valuable as a successful boot.** Documentation quality matters more than reaching the success criterion.

Don't grind for hours on one stuck point. The stages below have explicit stop-points.

## Image selection

ELKS disk images go in `reference/elks-images/`. If the directory is empty or absent, **ask the human for images before proceeding** — don't try to fetch them yourself.

Use these in order:

**Primary**: `fd1440-minix.img` — 1.44 MB, ELKS native filesystem. Standard geometry (80×2×18).

**Fallbacks if primary fails**:
- `fd1440-fat.img` — same geometry, FAT filesystem
- `fd1440.img` — same geometry, format unspecified
- `fd1200-minix.img` — 1.2 MB (80×2×15), Minix
- `fd1200-fat.img` — 1.2 MB, FAT

Each fallback is a separate test invocation. If primary succeeds, ignore fallbacks. If primary fails, document the failure mode then try the next. Different failure modes across images give us signal:
- 1440-minix fails but 1440-fat works → ELKS-side filesystem issue
- 1440-fat fails but 1200-fat works → 1440-geometry handling
- 1440 works but 1200 fails → 1200-geometry table coverage
- All fail similarly → BIOS service or CPU issue

## Stage-by-stage approach

Work these in order. Each has an explicit pass/fail and a stop-point.

### Stage 0 — Diagnostic infrastructure

Before running anything, build the trace capability you'll need.

**Minimum**: a `Tracer` interface with subscribers for:
- Instruction fetch (CS:IP, opcode bytes — disassembly optional, hex is enough)
- INT N execution (vector, register snapshot before)
- BIOS trap fire (vector, handler, register snapshot before/after)
- IN/OUT (port, value)
- Optional: writes to specific memory ranges (BDA at 0x40:0, video memory, etc.)

Implementation suggestion: a `Tracer` interface installed on `CPU8086` (optional like `TrapRegistry`), checked at the same boundary points. A `BufferingTracer` keeps a ring buffer; a `LoggingTracer` emits to a writable stream. Tests can install whatever they need.

**Stop-point**: spend at most 2 hours on this. If the structured approach is taking longer, fall back to ad-hoc `console.log` calls and revisit later. The trace is a means, not the goal.

**What to skip**: a real disassembler. Hex bytes plus CS:IP is enough — assembly can be reconstructed by hand or external tool when needed.

### Stage A — Reach `INT 19h` from a fresh Machine

Goal: instantiate `IBMPCMachine` with the disk attached, run, and confirm via trace that the BIOS init code executes through to `INT 19h`.

This stage validates Phase 2's wiring. If it doesn't work, the bug is in the trap-registry/BIOS-handler integration we just shipped, not in ELKS or anything earlier.

Steps:
1. Create `tests/integration/elks-boot.test.ts` (or wherever your existing integration tests live).
2. Load the disk image as a `NodeFileDisk` (or load into an `InMemoryDisk` with `Uint8Array` from file).
3. Construct `IBMPCMachine` with `loadBios: true` and the disk attached.
4. Install a buffering tracer.
5. Run `machine.runLoop.run({ maxInstructions: 200_000 })`.
6. Inspect the trace for: reset → far jump to F000:0100 → IVT setup → BDA setup → `INT 19h`.

**Pass**: trace shows `INT 19h` was executed.

**Stop-point**: if Stage A fails, debug for ≤ 1 hour. If still stuck, dump the relevant trace section into the report and stop.

**Likely Stage A failure modes**:
- ROM not loaded at right address — verify `memory.loadROM(0xF0000, ...)` was called
- Reset vector encoding wrong — check the 5 bytes at 0xFFFF0
- Init code has a bug — single-step through it via trace, compare against the byte-by-byte disassembly the Phase 2 generator should produce

### Stage B — Boot sector load and execute

Goal: `INT 19h` reads sector 0 from the disk, modifies pushed CS:IP to land at 0x0000:0x7C00 with DL=boot-drive, and the boot sector code begins executing.

Steps:
1. Continue trace from Stage A.
2. Verify INT 13h AH=02h was called from INT 19h handler context.
3. Verify after IRET, CS:IP = 0:7C00 and DL = boot-drive (probably 0 for floppy).
4. Trace boot-sector instructions. They typically:
   - Save DL (boot drive) somewhere
   - Set up a stack
   - Loop reading more sectors via INT 13h
   - Eventually JMP to a kernel entry point

**Pass**: boot sector executes ≥ 100 instructions without crashing, makes ≥ 1 additional INT 13h call, eventually transfers control to a non-boot-sector address.

**Stop-point**: if the boot sector crashes (invalid opcode, alignment trap, loops infinitely on a bad instruction), debug for ≤ 2 hours. Surface specific findings.

**Likely Stage B failure modes**:
- INT 13h subfunction we didn't implement (e.g., AH=08h "Get Drive Parameters" with edge-case behaviour)
- Disk geometry mismatch — `NodeFileDisk` infers wrong geometry, sector reads land wrong
- CHS-to-LBA bug in INT 13h handler — first sector reads OK because LBA=0, subsequent reads fail
- Boot sector hits an instruction sequence that exposes a CPU bug (rare but possible — corpus doesn't test sequences)

For geometry specifically: use trace to confirm what geometry `NodeFileDisk` reports vs what the boot sector expects. The boot sector typically does its first read with CHS=0,0,1 (cylinder 0, head 0, sector 1) which is LBA=0 regardless of geometry. Failures there mean disk-image issue, not geometry. Failures at later reads but not the first usually mean geometry.

### Stage C — Kernel load and entry

Goal: boot sector successfully loads the kernel image (many sectors of INT 13h) and jumps to the kernel entry point.

Steps:
1. Continue trace.
2. Watch for sustained INT 13h activity (kernel image is much larger than the boot sector — typically dozens to hundreds of sector reads).
3. Eventually a JMP/CALL to a high address (kernel entry, often around 0x1000:0x0000 or similar — depends on ELKS build).

**Pass**: ≥ 10 INT 13h reads succeed; boot sector transfers control to kernel entry without crashing.

**Stop-point**: if INT 13h reads start failing partway through the kernel load, debug for ≤ 1 hour focusing on the specific sector that failed. Surface the failure with the trace context.

**Likely Stage C failure modes**:
- Multi-sector read (AL > 1) handling — does our handler correctly loop AL times?
- Reads that span track boundaries — sector 18 of track 0 followed by sector 1 of track 1
- BDA `disk_laststatus` (offset varies; check Phase 2's BDA helper) not being updated correctly between calls
- Memory wraparound at 64K segment boundaries during the read — buffer at ES:BX where BX overflows

### Stage D — Kernel takes control and prints

Goal: the ELKS kernel runs and prints something recognisable via the BIOS console.

Steps:
1. Continue trace.
2. Watch for INT 10h calls (especially AH=0Eh "Write Character").
3. Capture the bytes written to Console.

**Pass — and overall brief success**: any string on stdout that's clearly ELKS kernel output. Examples of what to look for:
- "ELKS"
- "Linux" (some ELKS builds print this for kernel-message compatibility)
- A version string like "0.5.0" or "0.7.0"
- "Memory:" or "RAM:" or "kB"
- A hardware-detection line

A few bytes of plausible kernel output is success. Even "el" before getting stuck is a meaningful partial-success.

**Stop-point**: regardless of outcome, document at this stage. If kernel reaches but doesn't print, that's a finding worth detailed reporting — it points to specific issues.

**Likely Stage D failure modes**:
- **Kernel switches console driver and goes silent.** Most likely culprit if kernel is clearly running but no output appears. ELKS may write directly to video memory (0xB8000-0xBFFFF) or to a serial port (0x3F8). To check: trace memory writes to 0xB8000-0xBFFFF. If you see writes there, the kernel is using direct video. **You may add a memory-write hook for that range that emits to Console** — describe in report.
- **Serial console output**. If the kernel writes to ports 0x3F8-0x3FF, it's using COM1. Adding basic UART emulation is bigger than this brief should bite off; **flag and stop**, surface to next brief.
- INT 10h subfunction we didn't implement, used by kernel
- Kernel hangs in a HLT-loop waiting for a timer or keyboard interrupt that doesn't arrive — check that PIC is delivering IRQ 0 (timer) correctly

## Diagnostic playbook

When something fails, in this order:

1. **Look at the last 30 instructions in the trace.** What did the CPU do? What did it expect to do?
2. **Look at the last 5 BIOS calls.** What did each return? Are the return values plausible?
3. **Compare actual register state at failure point against what the code is checking.** Often the bug is "we returned 0x42 in AH but caller is checking == 0x40."
4. **Check the BDA at 0x40:0** — is it initialized with the values the kernel expects? Compare against what `bios.asm` initializes.
5. **For disk failures**: print the actual sectors being read (LBA) versus what the BIOS thinks it's reading (CHS). Off-by-one errors in CHS↔LBA translation are common.
6. **For "kernel went silent"**: trace memory writes globally. If you see lots of writes to 0xB8000+, that's video memory. If you see writes to 0x3F8, that's serial.
7. **If a CPU bug is suspected** (e.g., a specific instruction produces visibly wrong results in trace): write a minimal repro test case in the corpus harness. If it passes corpus but fails real-code, surface as a finding. **Do not modify the CPU yourself** — flag and stop.

## What you may add without further questions

- Diagnostic tracer infrastructure (`src/diagnostics/`)
- New BIOS subfunctions to existing INT handlers, when ELKS demonstrably calls them
- New BDA field initializations in the BIOS init code, when ELKS demonstrably reads them
- A memory-write hook for video memory range (0xB8000-0xBFFFF) emitting to Console, if needed
- INT 1Ch chaining from the INT 8 timer handler, if ELKS uses it
- IRQ 1 / INT 9 path for keyboard, if ELKS uses interrupt-driven keyboard
- More subfunctions in INT 13h (e.g., AH=18h "Set Media Type", AH=10h "Test Drive Ready") if ELKS calls them

## What you must stop and ask before adding

- Anything in `src/cpu8086/`, `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`, `src/devices/`
- Serial UART emulation (out of scope, surface for next brief)
- DMA controller emulation (definitely out of scope)
- A real disassembler (deferred)
- Any change to `IBMPCMachine`'s public shape

## Watch out for

- **The trace will be huge.** Hundreds of thousands of instructions. Don't try to read it linearly. Use grep/filtering on INT calls and significant events. A buffering tracer that only dumps the last N events on failure is more useful than a full log.
- **CPU bugs surface as visible-wrong-result.** Look at exact register values vs expectations. A single wrong flag bit can derail an entire conditional jump chain.
- **Multi-sector reads.** INT 13h AH=02h with AL > 1 reads multiple consecutive sectors. Phase 2's report mentioned this is implemented; verify by trace if reads are failing partway.
- **Stack alignment.** Some kernel code might assume the stack is at a specific address. The boot sector's stack setup should be left alone after it sets it.
- **Don't trust the corpus to catch CPU bugs that affect real code.** Corpus tests one instruction in isolation. Bugs in instruction *sequences* (flag preservation across pairs, REP edge cases) might pass corpus and fail kernel boot. If you see the CPU producing wrong output for a sequence corpus tests pass on, that's a real finding worth reporting.
- **Halt-and-spin scenarios.** If the kernel HLTs waiting for a timer interrupt and the run loop just spins forever, check: (a) is the PIT actually firing? (b) is the PIC delivering IRQ 0? (c) is IF set in FLAGS?
- **The boot sector's expectations.** The boot sector expects DL = boot drive number on entry. Phase 2's INT 19h handler sets this; verify via trace.

## Definition of done

There are two flavors:

**Boot success path**:
- Some recognisable ELKS kernel text appears on stdout
- Capture the exact bytes received
- Report explains how far the boot got, what BIOS calls were made, any extensions you added
- All existing tests still pass
- Typecheck clean
- Corpus regression clean

**Boot incomplete path** (still a successful brief if documented well):
- Best progress documented (which stage reached, where stuck, what symptoms)
- Trace excerpts showing the specific failure
- Specific candidate root causes if known
- Recommendations for what the next brief should address
- All existing tests still pass
- Typecheck clean
- Corpus regression clean

In both cases, the report at `ELKS_BOOT_REPORT.md` has these sections:

- **Summary**: which image, which stage reached, what stdout output (if any).
- **Diagnostic infrastructure**: what you built, where it lives, how it's used.
- **Stage-by-stage progress**: what worked, what didn't, with trace excerpts for failures.
- **BIOS extensions added**: any subfunctions or features added during triage, with rationale.
- **CPU/memory/etc bug candidates**: any findings in the locked layers, with reproduction steps.
- **Image triage** (if multiple tried): which images were tested, how each behaved.
- **Things future briefs should address**: anything you noticed that's outside this brief's scope (UART, additional devices, perf issues).
- **Verification**: exact commands, output summaries, test counts.

## Reference sources

1. The existing `BIOS_SERVICES_REPORT.md` — what Phase 2 implemented and stubbed
2. `reference/8086tiny/bios_source/bios.asm` — for BIOS contract clarifications during triage
3. ELKS source code (online: github.com/jbruchon/elks or wherever its current repo lives) — when you need to know what a specific kernel routine expects
4. The PC BIOS Data Area layout — Wikipedia or any PC reference
5. Ralf Brown's Interrupt List (RBIL) if accessible — canonical BIOS call reference

## Final notes

This brief is exploratory. There's no shame in not reaching the success criterion as long as the report explains why with enough detail to make the next attempt smarter. A detailed "got to Stage C, failed because of X, here's the trace, here's the candidate fix" is a successful Phase 3.

Phases 1 and 2 built six layers of careful infrastructure. Phase 3 is the moment we find out which of those layers needed slightly more than we built. Whatever you find, document it well — the next brief is shaped by your report.
