# emu86 — Agent Brief: Headless 8042 + A20, Push ELKS Forward (Phase 4)

## TL;DR

Implement a headless 8042 keyboard controller (ports 0x60 / 0x64) with A20-gate command acceptance, then re-run ELKS and document how much further it gets. Success criterion is reaching an interactive shell prompt on stdout — but this is the upper bound, not the floor. Document whatever progress happens and what the next stuck point is. Findings go in `PS2_A20_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `ELKS_BOOT_REPORT.md` (the immediately preceding session — it identifies the stuck point this brief unblocks), `BIOS_SERVICES_REPORT.md`, and `MACHINE_REPORT.md`. The diagnostic infrastructure built during Phase 3 (`src/diagnostics/`) is your friend — reuse it, don't rebuild.

## Hard rules

1. **Don't break existing tests.** Whatever the count is after Phase 3 (~672 unit + 4 integration + 329 corpus). All must stay green.
2. **`cpu.step()` stays pure synchronous.**
3. **No custom CPU opcodes.** Locked architecture.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no `// @ts-ignore`.
5. **You may add a new device** in `src/devices/keyboard-controller.ts` and wire it in `src/machine/ibm-pc.ts`. This is additive infrastructure, allowed by precedent (PIC, PIT).
6. **You may NOT modify** `src/cpu8086/`, `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`, or any existing device. The corpus is our spec for the locked layers; if you suspect a bug, surface it as a finding rather than fix it.
7. **You may extend BIOS handlers and add small BDA fields** if discovered necessary — same as Phase 3.

## Background

Phase 3 successfully booted ELKS to its first kernel message ("ELKS....../linux..." then "ELKS Setup .........FHt"), then got stuck in this loop at CS:IP = 9000:0499:

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

This is the canonical "drain the keyboard buffer before raising A20" sequence. ELKS issues it as part of A20-line setup. Our `BasicIOBus` returns 0xFF on un-registered ports, so bit 0 of port 0x64 is always set, so the JNZ always jumps, and the loop never exits.

After draining, ELKS will issue the A20-enable command sequence (write 0xD1 to port 0x64, then 0xDF to port 0x60). With these accepted, Setup should proceed past A20 setup into the kernel proper, eventually reaching userland and a shell prompt.

## Scope

### What you're building

1. **`KeyboardController8042`** (`src/devices/keyboard-controller.ts`) — implements `PortHandler`. Registered on the IOBus at ports 0x60 (data) and 0x64 (command/status). Headless: no real keyboard input plumbed in.

2. **A20 gate state** — an internal flag in the controller, set by writes to the output port (P2) via the standard PS/2 command sequence. **Does not affect memory addressing in this brief.** Our `PagedMemory` is 1 MiB; A20 has no observable effect. We implement command *acceptance*, not address-line behavior. Document this as a deliberate simplification.

3. **Machine wiring** — `IBMPCMachine` constructs the keyboard controller and registers it on the bus alongside PIC/PIT.

4. **Tests** — unit tests for the controller (state machine, A20 sequence, command/status handling), one integration test that verifies the Phase 3 stuck-point loop now exits cleanly.

5. **An exploratory follow-up run** — after the implementation lands, run ELKS again with the diagnostic tracer, document how much further it gets, surface the next stuck point.

### What you are NOT building

- Real keyboard input plumbing. Console input → keyboard buffer → IRQ 1 → BIOS keyboard buffer is the **next** brief. This brief is headless: the controller exists but reports "no keys" forever.
- Real A20 emulation that affects memory addressing. The address mask in `PagedMemory` stays at 0xFFFFF. A20 work for >1 MiB systems comes when we tackle 80286 real mode.
- IRQ 1 wiring. The 8042 normally raises IRQ 1 when a key arrives; without keyboard input, this path stays inert.
- Scancode translation. No keys, no scancodes.
- Mouse / aux device support. The 8042 supports a PS/2 mouse on a second channel; we ignore it entirely.
- Self-test command results that ELKS doesn't request. Implement only what ELKS demonstrably issues; the diagnostic trace from Phase 3 plus the run during this brief tells you what's actually called.

## Design

### File layout

New:
- `src/devices/keyboard-controller.ts` — `KeyboardController8042` class.
- `tests/unit/keyboard-controller.test.ts` — controller unit tests.
- `tests/integration/elks-boot-phase4.test.ts` — re-run ELKS, assert we get past the Phase 3 stuck point.

Modified:
- `src/machine/ibm-pc.ts` — construct + register the controller.
- `src/devices/index.ts` — barrel.
- `src/index.ts` — re-export if needed.

### `KeyboardController8042` shape

The 8042 is fiddly but headless mode keeps it small.

#### State

```ts
interface KeyboardController8042State {
  // Output buffer (the byte port-0x60 reads return)
  outputBuffer: number;
  outputBufferFull: boolean;        // OBF bit (status bit 0)
  
  // Input buffer (writes from CPU). Used by command-byte sequencing.
  inputBufferFull: boolean;         // IBF bit (status bit 1)
  
  // What the next write to port 0x60 means (depends on the most recent
  // command written to 0x64). Default: keyboard data (we ignore it).
  nextDataWriteIs: 'keyboard' | 'commandByte' | 'outputPort' | 'aux';
  
  // The internal "command byte" register. Set by command 0x60 followed by
  // a data write. Bits control IRQ enable, keyboard enable, etc.
  commandByte: number;
  
  // The internal "output port" P2. Bit 0 = system reset (active low),
  // bit 1 = A20 enable. We track it but A20 doesn't actually affect memory.
  outputPort: number;
  
  // True if A20 is "enabled" per the most recent output-port write.
  a20Enabled: boolean;
}
```

#### Constructor

```ts
class KeyboardController8042 implements PortHandler {
  constructor(options?: {
    /** Optional warning sink for unsupported commands. */
    warn?: (msg: string) => void;
  });
  
  registerOn(bus: IOBus): void;  // ports 0x60 and 0x64
  
  reset(): void;
  
  // Read-only state inspection for tests
  get a20Enabled(): boolean;
  get outputPort(): number;
  get commandByte(): number;
}
```

#### Port read semantics

**Port 0x60 (data) read**:
- If `outputBufferFull`: clear OBF, return `outputBuffer`.
- If not: return 0x00 (or 0xFF — pick one; real hardware varies). Documented choice in report.

**Port 0x64 (status) read**:
- Returns a status byte:
  - Bit 0 = OBF (1 if output buffer has a byte waiting)
  - Bit 1 = IBF (1 if input buffer is full — we'll mostly leave this 0)
  - Bit 2 = system flag (set after self-test pass; we set to 1)
  - Bit 3 = "command/data" — 0 if last write was data (port 0x60), 1 if command (0x64)
  - Bit 4 = keyboard enabled (1 = enabled — we set to 1)
  - Bits 5-7 = various, leave 0

The Phase 3 stuck loop only checks bit 0. As long as OBF is 0 when no key is queued, the loop exits. With headless mode and no keys, OBF stays 0.

#### Port write semantics

**Port 0x60 (data) write**: behavior depends on `nextDataWriteIs`:
- `'keyboard'` (default): the CPU is sending a byte to the keyboard. Real hardware would forward to the keyboard device. We log via `warn` and discard. Reset `nextDataWriteIs` to `'keyboard'`.
- `'commandByte'`: this byte is the new command-byte register value. Set `commandByte = value`. Reset to `'keyboard'`.
- `'outputPort'`: this byte is the new P2 value. Set `outputPort = value`. **Update `a20Enabled = (value & 0x02) !== 0`.** Reset to `'keyboard'`.
- `'aux'`: ignored (no PS/2 aux device modeled).

**Port 0x64 (command) write**: dispatch on the command byte:
- `0x20` "Read command byte": load `commandByte` into output buffer, set OBF.
- `0x60` "Write command byte": set `nextDataWriteIs = 'commandByte'`. Next write to 0x60 sets the command byte.
- `0xA7` "Disable aux": no-op (we don't have aux). 
- `0xA8` "Enable aux": no-op.
- `0xA9` "Test aux": load 0x00 (no error) into output buffer, set OBF.
- `0xAA` "Self-test": load 0x55 (pass) into output buffer, set OBF. Set system flag bit.
- `0xAB` "Test keyboard line": load 0x00 (no error) into output buffer, set OBF.
- `0xAD` "Disable keyboard": clear bit 4 of commandByte (logically); no-op for headless.
- `0xAE` "Enable keyboard": set bit 4 of commandByte; no-op for headless.
- `0xC0` "Read input port (P1)": load 0x00 (or some plausible default — see comment in code) into output buffer, set OBF.
- `0xD0` "Read output port (P2)": load `outputPort` into output buffer, set OBF.
- `0xD1` "Write output port (P2)": set `nextDataWriteIs = 'outputPort'`. **This is the A20 enable path.** Next write to 0x60 sets P2.
- `0xD2` "Write keyboard output buffer": set `nextDataWriteIs = 'keyboard'`. Next write to 0x60 simulates a key event. We log and discard.
- `0xD3` "Write aux output buffer": ignore.
- `0xD4` "Write to aux device": ignore (set `nextDataWriteIs = 'aux'`).
- `0xE0` "Read test inputs": load 0x00 into output buffer, set OBF.
- `0xF0`-`0xFF` "Pulse output port": real hardware pulses output lines. The relevant bits: bit 0 (pulse low) = system reset. **Reset request: `0xFE` "pulse bit 0" is the canonical CPU reset. ELKS may issue this to reboot. For now, log and ignore (no-op).** Real reboot handling is out of scope.
- Any other command: log via `warn` and ignore.

The list above covers commands ELKS might plausibly issue. The "warn and ignore" fallback handles anything unexpected without crashing.

#### Reset

`reset()` returns the controller to its post-construction state. OBF=0, IBF=0, default command byte (0x65 — keyboard interrupt enabled, system flag set, keyboard enabled), output port = 0x02 (A20 enabled by default — many BIOSes set this on POST and ELKS may assume it).

Wait, that last point is interesting. **Should A20 default to enabled or disabled?**

Real BIOSes vary. Original IBM PC: A20 is irrelevant (1 MiB system). AT-class: A20 typically off after POST; OS enables it. Some BIOSes leave it on after POST as a convenience. ELKS Setup explicitly enables A20 — implying it doesn't trust the default.

For our purposes: default A20 to **enabled**. ELKS still goes through its enable sequence (which sets it to enabled, no change), but if ELKS ever relies on A20 being already enabled (some early code paths might), we don't break. Document the choice.

### Machine wiring

`IBMPCMachine` constructor adds:

```ts
const keyboardController = new KeyboardController8042({ warn: this.warn });
keyboardController.registerOn(this.bus);
this.keyboardController = keyboardController;  // exposed as readonly property
```

Place after PIC and PIT construction. Reset cascade includes the keyboard controller.

### Tests

#### Controller unit tests (`tests/unit/keyboard-controller.test.ts`)

Roughly 25-30 tests:

**Status register**:
- Fresh controller: status read returns OBF=0, system-flag=1, keyboard-enabled=1.
- After a command that loads output buffer (e.g., 0xAA self-test): OBF=1.
- After data port read drains the buffer: OBF=0.

**Phase 3 drain loop unblocks**:
- Read port 0x64 with no input → bit 0 (OBF) is 0. (The single most important test in this file.)

**A20 sequence**:
- Initial state: a20Enabled=true (default).
- Write 0xD1 to 0x64, then 0xDF to 0x60 → a20Enabled=true (the canonical enable command sets bit 1).
- Write 0xD1 to 0x64, then 0xDD to 0x60 → a20Enabled=false (bit 1 clear).
- Write 0xD0 to 0x64 → next read of 0x60 returns the current outputPort.
- Write 0xD1 to 0x64, then 0xDF to 0x60, then 0xD0 to 0x64, then read 0x60 → returns 0xDF.

**Self-test**:
- Write 0xAA to 0x64, then read 0x60 → returns 0x55, OBF clears after read.

**Command byte read/write**:
- Default command byte readable via 0x20 → returns 0x65 (or whatever default we set; document).
- Write 0x60 to 0x64, then write a value to 0x60 → command byte updated.

**Reset**:
- Mutate state (run A20 sequence with disable), call reset(), verify defaults restored.

**Unknown commands**:
- Write 0x99 to 0x64 → no crash, warn called once.

#### Integration test (`tests/integration/elks-boot-phase4.test.ts`)

Re-run the ELKS boot scenario from Phase 3, assert progress past the stuck point.

Steps:
1. Load `fd1440-minix.img`.
2. Construct `IBMPCMachine` with disk attached.
3. Install Phase 3's tracer.
4. Run with maxInstructions ≥ 2,000,000 (Setup may take many cycles to traverse).
5. Assert: trace shows port 0x64 was read AND port 0x64 was *written* with command 0xD1 (the A20 enable command). This proves we got past the drain loop.
6. Capture and assert on Console output — should be more than the 154 bytes of Phase 3.
7. Document the new stuck point (if any) in the test's expected-output and in the report.

### The exploratory follow-up (mandatory)

After the implementation passes its tests, run the integration test and **observe what happens next**. This is exploratory work, like Phase 3.

Possible outcomes:
1. **Reach a shell prompt on stdout.** This is the brief's full success criterion. Capture and document the prompt characters exactly.
2. **Get further than Phase 3 but stuck somewhere new.** Document the new stuck point with the same care Phase 3 did — disassemble the loop, identify the cause, propose a fix path.
3. **Get only slightly further (e.g., past A20 setup but stuck on the next missing thing).** Same documentation.
4. **Make almost no further progress.** Surprising — surface back, the diagnosis is the deliverable.

**Your job in the exploratory phase**: 
- Run, observe, document. 
- Add small fixes that fall within the brief's "may add" list (more BIOS subfunctions, BDA fields, video memory hook if it appears).
- Surface bigger issues without fixing them.
- Stop after ≤ 4 hours of exploratory work, regardless of outcome. The brief's deliverable is implementation + report, not "shell prompt at any cost."

## Diagnostic playbook (reuse Phase 3's tools)

The Phase 3 report describes `src/diagnostics/` infrastructure. Use it.

When ELKS gets stuck somewhere new:
1. Look at the last few hundred instructions in the trace.
2. Identify the stuck loop (instructions repeating; addresses cycling).
3. Disassemble the loop manually.
4. Identify the I/O port, memory address, or register being polled.
5. Determine what value would unblock it.
6. Decide: small fix in this brief, or surface for next?

## What you may add without further questions

- New BIOS subfunctions to existing INT handlers, when ELKS demonstrably calls them.
- New BDA field initializations in the BIOS init code, when ELKS demonstrably reads them.
- Memory-write hook for video memory range (0xB8000-0xBFFFF) emitting to Console, if needed (Phase 3 flagged this; if it triggers, implement).
- INT 1Ch chaining from INT 8 if ELKS uses it.
- Additional headless 8042 commands beyond the list above, if ELKS issues them.
- Additional `KeyboardController8042` state if needed.

## What you must stop and ask before adding

- Real keyboard input (Console → buffer → IRQ 1). That's the next brief.
- Real A20 emulation (memory mask change). Defer to >1 MiB / 286 work.
- Serial UART. Out of scope.
- Anything in the locked layers (`src/cpu8086/`, `src/memory/`, etc.).
- Modifications to `IBMPCMachine`'s public shape beyond adding the keyboard controller as a readonly field.

## Watch out for

- **OBF clearing on read.** Real hardware: reading port 0x60 clears OBF. Tests must verify this — write a test where you load OBF (via self-test), read 0x60 once, then verify OBF is 0.
- **The "next data write" state machine** is the most error-prone part. After 0xD1 to 0x64, the next write to 0x60 is the new P2 value, NOT keyboard data. After that single write, the state goes back to 'keyboard'. Test the transition.
- **A20 default = enabled.** If we accidentally default to disabled, ELKS may break in subtle ways before it gets to its enable sequence.
- **Don't pulse-reset on 0xFE.** Real hardware: command 0xFE pulses bit 0 of P2 low, which on real PCs causes the CPU to reboot. We log and ignore. ELKS may issue this on shutdown; we don't want to actually reset the emulator mid-test.
- **The drain loop must exit on the first iteration.** Test this specifically: read port 0x64 once with a fresh controller, verify OBF=0. If we have any startup sequence that loads OBF (e.g., self-test on init), that sequence must complete before the controller is wired in, OR OBF must be cleared before any test runs.
- **Trace size in the integration test.** ELKS post-A20 may run millions of instructions. Phase 3's tracer is ring-buffered; tests should configure it to keep only relevant event kinds (e.g., int + trap + io, drop instruction events) to avoid the ring eviction problem Phase 3 discovered.
- **The integration test's assertion granularity.** Don't assert on exact Console bytes (they may shift between ELKS versions). Assert on byte-count threshold ("> 200 bytes," meaning we got past Phase 3's 154) and on specific port-0x64 commands appearing in the trace.

## Stop and ask

- If you find yourself wanting to modify the locked layers.
- If `cpu.step()` wants to be async.
- If A20 modeling appears to need real memory-mask changes (it shouldn't for a 1 MiB system, but if you find a real reason, surface).
- If the next stuck point looks like it'll need a major new device (UART, FDC, etc.).
- If ELKS appears to demand IRQ 1 firing for keyboard (would require this brief to grow into "full 8042"). Document and surface.
- If a CPU bug surfaces (e.g., specific instruction sequence producing wrong values that the corpus didn't catch).
- If the corpus regresses (it shouldn't — we're not touching the locked layers).

## Definition of done

**Two flavors, like Phase 3:**

**Implementation success path** (always required):
- `KeyboardController8042` implemented and tested.
- Machine constructs and wires it.
- All existing tests + new tests pass.
- Phase 3's integration test still passes (no regression).
- New Phase 4 integration test passes (verifies past-A20 progress).
- Typecheck clean.
- Corpus regression clean.

**Exploration outcome** (one of these, all valid):
- ELKS reaches an interactive shell prompt → Phase 4 fully successful.
- ELKS gets meaningfully further but stuck somewhere new → Phase 4 successful with documented next-step.
- Almost no further progress → surprising; report explains why.

The report at `PS2_A20_REPORT.md` has these sections:
- **Summary**: implementation status, exploration outcome, console bytes captured.
- **8042 implementation**: state machine layout, command list supported, A20 modeling choice, defaults chosen.
- **A20 simplification**: explicit note that we accept commands but don't change memory addressing; rationale; what would change for >1 MiB.
- **Phase 3 stuck point unblocked**: trace excerpt showing the drain loop now exits.
- **Exploration progress**: how far ELKS got, console output captured, new stuck point if any (with disassembly).
- **Things future briefs should address**: anything new surfaced, plus any of the Phase 3 items that are now more or less urgent.
- **CPU/memory bug candidates**: anything suspect from extended runtime.
- **Verification**: exact commands and outputs.

## Reference sources

1. **Phase 3 report (`ELKS_BOOT_REPORT.md`)** — the stuck point analysis is your starting evidence. The disassembled drain loop is reproduced verbatim there.
2. **OSDev wiki "8042 PS/2 Controller" article** — the canonical programmer's-eye reference. Treat as authoritative for command codes and bit meanings.
3. **`reference/8086tiny/bios_source/bios.asm`** — for any BIOS-side interactions we might need to extend.
4. **The existing `PIC8259` and `PIT8254`** in `src/devices/` — your model for a `PortHandler`-implementing device. The 8042 follows the same pattern.

## Final notes

Phase 3 unblocked the boot pipeline up to "kernel says hello." This brief unblocks the next 50 yards of that race. We don't yet know what's at the end of the road — the exploratory follow-up is where we find out.

The next brief after this is shaped by what you find. Document well; the next plan is built from your report.
