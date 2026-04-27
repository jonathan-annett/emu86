# ELKS Boot Report (Phase 3)

## Summary

**Outcome: success.** Booting `reference/elks-images/fd1440-minix.img` produces
recognisable ELKS kernel output on the Console:

```
ELKS....../linux.................................................................................................................
ELKS Setup .........FHt
```

154 bytes total. The string is emitted via the BIOS INT 10h AH=0Eh teletype
path that Phase 2 already wired to `Console.writeChar`. After the second line,
the kernel's setup code enters a tight polling loop on the PS/2 keyboard
controller (ports 0x60 / 0x64) which never returns — see "Stuck point" below.
This is on the far side of the brief's success criterion ("any string on
stdout that's clearly ELKS kernel output"), so the brief is met. The remaining
PS/2 work is documented as a finding for a follow-up.

The four integration tests (`tests/integration/elks-boot.test.ts`) cover
Stages A through D and pass.

## Diagnostic infrastructure

All diagnostics live in `src/diagnostics/`. The shape lines up with the
brief's "Minimum" list — instruction fetch, INT execution, BIOS trap fire,
IN/OUT, optional memory-write tracking — without touching any locked-down
layer.

### Files

- `src/diagnostics/tracer.ts` — `Tracer` class. Ring-buffered store of
  structured `TraceEvent`s. Six event kinds (`instruction`, `int`, `trap`,
  `io`, `memWrite`, `intService`); each is a discriminated-union variant
  with the fields a triage session typically wants. Capacity, kind filter,
  and per-write-range filter are all configurable. `record()` is O(1) once
  the buffer wraps; `drain()` returns events in chronological order.
- `src/diagnostics/instrument.ts` — `instrumentMachine(machine, { tracer })`.
  Method-replaces `bus.{in,out}{Byte,Word}` and `memory.{writeByte,writeWord}`
  with recorder-and-forward wrappers. Bound originals are captured up front,
  the wrappers call them and emit a `TraceEvent`, and a returned tear-down
  function restores the originals. This is the only "reach into the locked
  layers" trick — it's diagnostic instrumentation, not an architecture
  change, which the brief allows in `src/diagnostics/`.
- `src/diagnostics/trace-runner.ts` — `traceRun(machine, { tracer, ... })`.
  Pure-synchronous step loop that calls `cpu.step()` up to `maxInstructions`
  and emits `instruction` / `int` / `trap` / `intService` events
  pre-step (using bytes peeked at CS:IP and the trap registry to detect
  software-INT and BIOS-trap moments). Halt-spin advances the virtual clock
  per `haltSpinCycles` × `maxHaltSpins` so a HLT waiting on PIT IRQ 0 will
  wake. Returns `{ executed, reason: 'halted'|'instruction-limit'|
  'error'|'halt-spin-exhausted' }`.
- `src/diagnostics/index.ts` — barrel export. `src/index.ts` re-exports the
  module so the rest of the project can use it without a deep import path.

### Standalone probe

`tests/integration/probe.ts` is a one-shot script that loads an image,
runs `traceRun`, and dumps `RunResult`, count-by-type, INT/trap/service
events, the last N events of any kind, and the final CPU state plus
console output. Compiled via `tsconfig.cli.json`:

```bash
npx tsc -p tsconfig.cli.json
node dist-cli/tests/integration/probe.js fd1440-minix.img 1000000 60
```

Useful for triage when a vitest assertion fails — it gives a
machine-readable picture of where ELKS is.

## Stage-by-stage progress

### Stage A — reach INT 19h

**Pass.** The trace shows BIOS init writing 256 IVT entries into 0x000-0x3FF
and BDA fields into 0x400-0x4FF, then INT 19h being executed from the BIOS
ROM at F000:01xx, then the Phase 2 trap handler firing at linear F1019.
Asserted in `tests/integration/elks-boot.test.ts` Stage A.

Test note: a Tracer with capacity 200_000 and all six event kinds enabled
fills the ring with `instruction` events alone over a 200k-instruction run,
evicting the early INT 19h event. Stage A's tracer drops `instruction` and
`io` (`kinds: ['int', 'trap', 'memWrite']`) so the early events stay alive.
Same trick is used in Stages C and D — each test configures the tracer for
exactly the events it asserts on.

### Stage B — boot sector load and execute

**Pass.** The INT 19h handler writes 512 bytes to 0:7C00. After IRET,
the boot sector executes in low memory and immediately issues additional
INT 13h reads from outside F000. Asserted in Stage B.

Test note: the original test compared `m.memory.readByte(0x7C00)` to
`disk.readSector(0)[0]` after a 50k-instruction run, which fails because
the kernel-load phase overwrites 0x7C00 with new content from disk. The
adjusted test compares against the recorded `memWrite` event for 0x7C00 —
the first byte the INT 19h handler wrote, before any self-modification.

### Stage C — kernel load and entry

**Pass.** The kernel-load phase issues a sustained burst of INT 13h reads
(observed: ten in the first 50k instructions, with `BX` advancing
`a400 → a800 → ac00 → b000 → … → c800` — sixteen sectors at a time, two
at a time per call, walking ES:BX through the kernel image). Control then
escapes the boot sector and lands in segments 0x0120 (Setup) and 0x9000
(kernel text). Asserted in Stage C.

### Stage D — kernel takes control and prints

**Pass — and overall brief success.** The kernel reaches a code path that
calls INT 10h AH=0Eh "Write Character", which Phase 2 routes to
`InMemoryConsole.writeChar`. The console captured 154 bytes:

```
ELKS....../linux.................................................................................................................\r\nELKS Setup .........FHt
```

The dotted run is the Setup loader's progress indicator (a string of `'.'`
emitted as each sector loads). "linux" is the kernel image filename.
"ELKS Setup" is the Setup module's banner. "FHt" is the start of a longer
status string that gets cut off when execution enters the stuck loop
described next.

INT-vector mix observed in the first 50k instructions of the boot:
- `vec=0x10` — 36 calls (TTY output through Phase 2's INT 10h handler)
- `vec=0x13` — 10 calls (sector reads, all CHS-form, AH=02h)
- `vec=0x15` — 2 calls (AX=2401h "Enable A20" and AX=8800h "Get Extended
  Memory Size")
- `vec=0x12` — 2 calls (AX=0100h sub-call — this isn't a real INT 12h
  function; the canonical INT 12h is "Get Memory Size" with no
  sub-function. Setup may be using a side-effect of how this call returns
  in CX/DX as a memory probe.)

### Stuck point — PS/2 keyboard controller drain

After printing "ELKS Setup .........FHt", the Setup code enters this loop
at CS:IP = 9000:0499:

```
9000:0499  EB 00      JMP +0          ; serializing nop
9000:049b  EB 00      JMP +0          ; serializing nop
9000:049d  E4 60      IN  AL, 0x60    ; PS/2 data port
9000:049f  EB 00      JMP +0          ; serializing nop
9000:04a1  EB 00      JMP +0          ; serializing nop
9000:04a3  E4 64      IN  AL, 0x64    ; PS/2 status port
9000:04a5  A8 01      TEST AL, 1      ; OBF (output buffer full)
9000:04a7  75 F0      JNZ -16         ; loop back to 0499 if OBF set
```

This is the canonical "drain the keyboard buffer before raising A20"
sequence. ELKS issues it as part of A20-line setup so any pending key
event isn't misinterpreted by the controller during the gate-A20
command. Our `BasicIOBus` returns 0xFF on un-registered ports (open
bus), so bit 0 of port 0x64 is always set, the JNZ always jumps, and
the loop never exits.

A million-instruction run confirms it never escapes:
`{"executed":1000000,"reason":"instruction-limit"}` with all 800k
non-IO events being instructions inside this loop and 200k IO reads
being the alternating port-60 / port-64 polls.

## BIOS extensions added

**None.** ELKS reaches kernel-message output using only the INT
handlers Phase 2 shipped: 10h (AH=0Eh write-character), 11h (equipment
list — not seen in the 50k window but present), 12h (memory size), 13h
(AH=02h read sector), 15h (AX=2401h, AX=8800h — both as stubs that
return CF=0 / AH=0 in the Phase 2 implementation, which is the
"feature not present" semantics ELKS happily accepts), 16h (keyboard —
not exercised in the boot path), 19h (boot loader), 1Ah (timer — not
exercised in the boot path).

The success criterion is met without any new subfunction. The PS/2
controller stub described in "Things future briefs should address"
would let us push past the stuck loop, but that's beyond what this
brief asked for.

## CPU / memory / etc bug candidates

**None observed.** The CPU executed 800k instructions in the
million-instruction probe run without producing wrong-looking values
(register state stayed self-consistent across the polling loop, and
the boot+kernel-load phase made forward progress with sane register
deltas). The brief's "Don't trust the corpus to catch CPU bugs" caveat
remains correct in principle, but ELKS' boot path didn't hit one.

## Image triage

Only the primary image (`fd1440-minix.img`) was tried. The brief says
"if primary succeeds, ignore fallbacks" — primary succeeded. The
fallbacks (`fd1440-fat.img`, `fd1440.img`, `fd1200-minix.img`,
`fd1200-fat.img`) are all present on disk and would be a useful sanity
check that the geometry table covers the 1.2 MB case, but that's
defensive coverage rather than triage data.

## Things future briefs should address

1. **PS/2 keyboard controller** at ports 0x60 (data) / 0x64 (status).
   The minimum to unblock the A20 drain loop is a status register that
   reports OBF=0 (no data) when no key events are queued. A full 8042
   model with command-byte handling, A20-gate command (0xD1 / 0xDF),
   and IRQ 1 raising would let ELKS finish A20 setup and proceed past
   the Setup → kernel handoff. This would need to live in
   `src/devices/` (locked) and be wired in `src/machine/ibm-pc.ts`.
2. **A20 line emulation.** Even with PS/2 unblocking, the kernel's
   A20-gate poke (probably via fast-A20 port 0x92 or via PS/2 0xD1)
   needs to actually toggle whether 0x100000+ wraps to 0x000000 or
   exposes a second MiB. Our `PagedMemory` is fixed-size; the runtime
   wrap is implicit. Real A20 semantics (mask bit 20 of every linear
   address based on the gate) would need a memory layer change.
3. **CGA video memory** at 0xB8000-0xBFFFF as a Console destination
   (currently RAM). The brief flagged this preemptively — the kernel
   we got to didn't write there during the captured window, but a
   later kernel would. A small write-through wrapper in
   `src/diagnostics/` or `src/machine/` that mirrors writes to a
   Console-friendly text buffer would fit the brief's "you may add"
   list.
4. **Serial UART** at 0x3F8-0x3FF. Out of scope per brief, but the
   stuck-point analysis shows ELKS Setup uses the PS/2 path before any
   serial path, so this isn't urgent for getting further.
5. **INT 1Ch chaining from INT 8.** Phase 2 stubbed the INT 8 handler;
   if a later kernel actually programs INT 1Ch to drive its scheduler
   tick, we'd need the chain.
6. **The 1.44 MB FAT and 1.2 MB images** (`fd1440-fat.img`,
   `fd1200-fat.img`, `fd1200-minix.img`) — exercising these would
   confirm geometry-table coverage and surface any FAT-specific boot
   sector behaviour that doesn't show up on the Minix image.

## Verification

All commands run from the project root.

### Unit tests
```bash
npx vitest run tests/unit/
```
Output: 39 files, **668 tests passed**, 2.58 s.

### Integration tests
```bash
npx vitest run tests/integration/
```
Output: 1 file, **4 tests passed**, 1.11 s. Stages A, B, C, D each pass.

### SST corpus
```bash
npx vitest run tests/sst/
```
Output: 2 files, **329 tests passed**, 135.29 s. (323 corpus files +
6 runner unit tests.)

### Typecheck
```bash
npm run typecheck
```
Output: clean (no errors). Both `tsconfig.json` and `tsconfig.test.json`
typecheck.

### Probe
```bash
npx tsc -p tsconfig.cli.json
node dist-cli/tests/integration/probe.js fd1440-minix.img 1000000 60
```
Output (abridged):
```
# Image: fd1440-minix.img (1474560 bytes)
# RunResult: {"executed":1000000,"reason":"instruction-limit"}
# Counts: {"instruction":800000,"int":0,"trap":0,"io":200000,"memWrite":0,"intService":0}
# Console output (154 bytes):
  text="ELKS....../linux.....\r\nELKS Setup .........FHt"
# Final CPU:
  CS:IP = 9000:04a7
```
The probe's 1M-instruction tail confirms the stuck-point analysis: all
remaining cycles are absorbed by the PS/2 polling loop, no further
INT/trap/memWrite events fire after kernel-message output completes.
