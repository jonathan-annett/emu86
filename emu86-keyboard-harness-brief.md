# emu86 — Agent Brief: Keyboard Input + CGA Output + Runnable ELKS Harness (Phase 7)

## TL;DR

Take ELKS from "boots to a `login:` prompt no one can type at" to "fully interactive headless ELKS in a terminal." Three deliverables:

1. **Keyboard input plumbing**: stdin bytes → scancode translator → 8042 controller output buffer → IRQ 1 → kernel.
2. **CGA framebuffer output mirroring**: writes to 0xB8000 emit character bytes to host stdout in real time.
3. **A runnable Node harness** (`tools/elks/run.ts` or similar): single executable that boots ELKS with stdin/stdout wired, presents a usable terminal session.

The harness is the headline deliverable — at the end of this brief, a developer can clone the repo, run one command, and interact with ELKS at a shell prompt. Document everything in `KEYBOARD_HARNESS_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `ELKS_ROOT_MOUNT_REPORT.md` (the immediately preceding session — this brief picks up exactly from where it left off), and the prior reports as needed. ELKS source at `reference/elks/`.

## Hard rules

1. **Don't break existing tests.** 1029 passing tests as of Phase 6. All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no `// @ts-ignore`.
5. **You may extend** `KeyboardController8042` to support real keyboard input plumbing. This is a deliberate evolution of the headless implementation; document each change.
6. **You may add new files** in `src/diagnostics/` (CGA mirror), `src/console/` (if scancode translation lives there), `tools/` (the runnable harness — new directory).
7. **You may NOT modify** `src/cpu8086/`, `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`, or any existing device other than the keyboard controller. Same locks as before.
8. **Evidence-driven scancode work.** Look at what ELKS's keyboard driver actually parses. Implement that. No guessing or "pretty thorough" pre-implementation.

## Background

Phase 6 reached a `login:` prompt by running 25M instructions of real ELKS kernel + userland. The kernel cycles between work and idle_halt waiting for keyboard input that never arrives. The pieces in place:

- `KeyboardController8042` exists with stub status register, A20 plumbing, command handling — but no path for real keys to enter the output buffer.
- `Console` interface exists with `NodeConsole` that reads stdin in raw mode.
- The kernel reaches and reads from port 0x60 in its IRQ 1 handler (observable via trace, but not exercised because IRQ 1 never fires).
- CGA output at 0xB8000 contains the full boot transcript and shell prompt — but no host-side path emits it to stdout.

This brief connects all of those.

## Scope

### 1. Keyboard input plumbing

Make stdin bytes flow through the system as scancodes that ELKS's keyboard driver can parse.

**The full path**:

```
host terminal keypress
  → stdin (raw mode, NodeConsole)
  → translation layer (ASCII-and-special → scancode events)
  → KeyboardController8042 input queue
  → 8042 raises IRQ 1 via PIC
  → kernel's IRQ 1 handler reads port 0x60
  → kernel translates scancode → char in its keyboard ringbuffer
  → userspace read() returns char
```

#### Scancode set

ELKS expects PC/AT keyboard scancodes (Set 1). **Verify by reading ELKS source first** — `reference/elks/elks/arch/i86/drivers/char/keyboard.c` (or wherever the keyboard driver lives). Confirm the scancode set, find the keymap table, identify which special keys have non-trivial mappings.

#### Translation table

Implement enough scancode coverage for an interactive shell:

- **ASCII printables** (letters, digits, common punctuation) — each produces a press scancode, then a release scancode (release = press | 0x80).
- **Enter** — stdin sends LF (0x0A) or CR (0x0D); both should produce scancode 0x1C (Enter).
- **Backspace** — stdin sends 0x7F (terminal default) or 0x08; both should produce scancode 0x0E.
- **Tab** — stdin 0x09 → scancode 0x0F.
- **Escape** — stdin 0x1B → scancode 0x01.
- **Ctrl-letter combos** — stdin sends 0x01-0x1A (Ctrl-A through Ctrl-Z); produce a sequence: Ctrl-down (0x1D), letter-press, letter-release, Ctrl-up (0x9D). Letter-press is the scancode that would produce that letter.
- **Shift handling for symbols** — characters like `!`, `@`, `#` that require Shift on a real keyboard need: Shift-down (0x2A), key-press, key-release, Shift-up (0xAA). ELKS may or may not need this depending on whether it does its own shift state tracking; verify in driver source.
- **Arrow keys (optional)** — terminals send `ESC [ A` (up), `ESC [ B` (down), `ESC [ C` (right), `ESC [ D` (left). These are extended scancodes (0xE0 prefix) on Set 1: 0xE0 0x48 (up), 0xE0 0x50 (down), 0xE0 0x4D (right), 0xE0 0x4B (left). **Implement only if ELKS shell uses them** — check the driver. If not used, defer to follow-up.

A small state machine in the translator handles the multi-byte cases (Ctrl combos generating 4 scancodes, escape sequences from arrow keys).

#### `KeyboardController8042` changes

Today the controller has an empty output buffer and stub OBF=0. Extensions needed:

- A queue of pending scancodes.
- Method `injectScancode(byte: number): void` — host calls this to queue a scancode. If the output buffer is empty, transition to OBF=1 with this byte ready to read; if not empty, queue host-side.
- Method `injectScancodes(bytes: number[]): void` — convenience for multi-byte sequences.
- IRQ 1 firing: when transitioning OBF empty → full, the controller calls a `onIRQ1` callback (set by Machine wiring to `pic.assertIRQ(1)`).
- Buffer drain: when CPU reads port 0x60 and OBF is set, output buffer clears, OBF goes to 0; if there are queued scancodes host-side, dequeue one, OBF goes to 1 again, IRQ 1 fires again.

This stays headless-friendly — controller works fine with no input plumbed. Tests can call `injectScancode` directly.

#### Machine wiring

`IBMPCMachine` already constructs the keyboard controller. Add the IRQ 1 callback wiring (`onIRQ1: () => pic.assertIRQ(1)`) — same pattern as PIT channel 0 to IRQ 0.

The machine doesn't know about Console. The harness wires Console.hasInput → translator → controller.injectScancodes.

### 2. CGA output mirroring

Watch writes to the CGA text-mode framebuffer at linear 0xB8000-0xBFFFF and emit visible characters to a sink (host stdout in the harness, an in-memory buffer in tests).

#### Implementation approach

A diagnostic-style hook on memory writes. `src/diagnostics/cga-mirror.ts`:

```ts
interface CGAMirror {
  /** Receives character bytes as they're written to the CGA buffer. */
  onWrite(char: number): void;
  /** Receives cursor moves via CRTC writes. Optional, can be a no-op. */
  onCursor(row: number, col: number): void;
  /** Emit a literal string (e.g., terminal escape sequences from CRTC cursor moves). */
  emit(s: string): void;
}
```

The mirror gets installed as a memory-write subscriber filtered to 0xB8000-0xBFFFF. Each write at an even offset is a character byte; odd offset is attribute (skip). Each write at offset N puts a character at row=(N>>1)/80, col=(N>>1)%80.

For v0, implement a simplified mirror that just emits character bytes in write order. This produces correct-looking output for sequential text writes (which is the common case for boot messages and shell output). It produces wrong-looking output for code that overwrites existing screen positions (full-screen redraws, line edits) — accept this as v0 limitation.

If line wrap or backspace handling proves necessary in practice, add a more sophisticated mirror that tracks cursor position via CRTC writes to ports 0x3D4/0x3D5. CRTC register 0x0E = cursor high byte, 0x0F = cursor low byte; the linear cursor position determines where each character lands.

#### Where the hook lives

Memory writes don't currently have a subscription mechanism — `PagedMemory.writeByte` is a hot-path method. We don't want to add a "for every write check if there's a subscriber" branch.

Two approaches:

**A. Wrap `bus.outByte` for CRTC.** CRTC programming goes through I/O ports 0x3D4/0x3D5, which already have a `BasicIOBus` interception point. Easy.

**B. Hook the framebuffer writes via a method-replace shim, like Phase 3's `instrumentMachine`.** Replace `memory.writeByte` and `memory.writeWord` with wrappers that check the address range. This is `src/diagnostics/`-style instrumentation, not architecture change.

Approach B is needed for the framebuffer writes; A handles the cursor side. Use both.

The instrumentation approach Phase 3 used (`instrumentMachine`) is the right pattern: pure overlay, doesn't modify locked layers, can be installed/removed.

### 3. Runnable Node harness

Create `tools/elks/run.ts`. A standalone Node executable that:

1. Parses command-line args: disk image path (default `reference/elks-images/fd1440-minix.img`), optional max-instruction cap.
2. Constructs `IBMPCMachine` with the disk attached.
3. Constructs `NodeConsole` and wires it through:
   - Stdin → scancode translator → keyboard controller injection
   - CGA mirror → host stdout
4. Sets up signal handling: Ctrl-C in stdin should send Ctrl-C scancode to ELKS (not kill our process). A magic prefix (e.g., Ctrl-A then x) should quit cleanly. Document at startup.
5. Runs the loop, prints a startup banner, and exits cleanly when the user invokes the quit prefix.

#### Startup banner

```
emu86 — ELKS in a terminal
Image: reference/elks-images/fd1440-minix.img
Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A
Booting...
```

The Ctrl-A prefix is conventional (screen, tmux); pick what feels right and document.

#### Build

The harness compiles via the existing `tsconfig.cli.json`. Add it to the include list. User runs:

```
$ npx tsc -p tsconfig.cli.json
$ node dist-cli/tools/elks/run.js
```

Or add an npm script: `"start:elks": "tsc -p tsconfig.cli.json && node dist-cli/tools/elks/run.js"`.

### What you are NOT building

- A full terminal emulator. The CGA mirror is a simplification.
- Mouse support.
- Keyboard scancode set 2 or 3.
- LED state for caps lock / num lock.
- A graphical viewport. Headless terminal only.
- Browser deployment (separate future brief).
- Pause/resume of the running ELKS session.

## Tests

### Unit tests

- Scancode translator (`tests/unit/scancode-translator.test.ts`):
  - ASCII printables produce press+release pairs.
  - Enter/backspace/tab/escape produce correct scancodes.
  - Ctrl-letter combos produce the four-event sequence.
  - Shifted characters produce the four-event sequence with shift.
  - Multi-byte stdin (Ctrl-A then 'x') produces correctly ordered scancode events.

- KeyboardController8042 with input queue (`tests/unit/keyboard-controller.test.ts` extension):
  - `injectScancode` with empty buffer transitions OBF to 1, fires IRQ 1.
  - Reading port 0x60 clears OBF to 0.
  - Second `injectScancode` while buffer is full queues; on read, dequeues.
  - `injectScancodes` with a multi-byte sequence drains correctly across reads.

- CGA mirror (`tests/unit/cga-mirror.test.ts`):
  - Character writes at the text region produce character emissions.
  - Attribute writes don't produce emissions.
  - Writes outside the framebuffer range are ignored.

### Integration test

`tests/integration/elks-interactive.test.ts`: a scripted-input test that runs ELKS to login, sends a scripted byte sequence (e.g., "root\nsomething\n"), and asserts on what appears in the captured output.

The exact scripted interaction depends on ELKS's login behavior:
- If `/etc/passwd` has an empty password for root, "root\n" + Enter at password prompt should reach a shell.
- If a password is needed, you may need to look at `reference/elks/etc/passwd` (or wherever ELKS keeps it on the disk) to know what to type. Or you may need to log in as a non-root user.

Document the chosen scripted login sequence and what's observed.

This test must be deterministic. Use scripted bytes, not real stdin.

### Harness smoke test

A test that constructs the harness's wiring (keyboard plumbing, CGA mirror, machine) and runs for ~10M instructions with no scripted input, asserting the kernel reaches login: just like Phase 6's test but with the real input/output paths wired (just unused). Confirms the plumbing doesn't break Phase 6's success.

## Watch out for

- **The kernel IRQ 1 handler must EOI to the master PIC.** Phase 5's missing-EOI lesson — verify in trace that IRQ 1's service path includes an `OUT 0x20, 0x20`. If not, we'll deadlock on IRQ 1 the same way Phase 4 deadlocked on IRQ 0.
- **Scancode timing.** Real keyboards send scancodes at human typing speed; our injection can be much faster. The kernel's IRQ 1 handler must complete before the next scancode arrives. Modeling: the controller's input queue absorbs bursts; OBF empties as the kernel reads. If we inject too fast, queue grows but kernel still processes them in order. Should be fine for typical input.
- **Raw mode and Ctrl-C.** NodeConsole sets raw mode, which disables Ctrl-C generating SIGINT. This is necessary (we want Ctrl-C to be a scancode, not a process killer), but means our process has no default kill mechanism. The harness must handle the magic-prefix quit explicitly.
- **The CGA mirror starts emitting before ELKS's `console_init`.** Until ELKS switches drivers, the kernel writes nothing to 0xB8000. The InMemoryConsole still captures the early `INT 10h AH=0Eh` output. The harness should print both: early output via Console.writeChar, later output via the CGA mirror, in the order they happen. This means the Console used by the harness either (a) gets bridged to stdout directly, or (b) emits its bytes when written. Pick one and ensure no double-printing.
- **Terminal escape sequences in output**: ELKS may emit escape sequences (color codes, cursor positioning) via the CGA framebuffer. The CGA mirror just emits character bytes; if the kernel writes 0x1B, 0x5B (start of ANSI escape) into the framebuffer, those bytes pass through. Most modern terminals interpret them, which is fine. Document that the output is raw character data, the host terminal interprets escape sequences naturally.
- **Stdin-EOF handling.** If stdin closes (e.g., user pipes a script in), keyboard injection has no more input. The harness should detect EOF and either continue running (kernel can still do non-input work) or quit gracefully. Pick a behavior and document.
- **`/dev/tty` translation in the kernel.** ELKS's tty handling does line discipline (line buffering, line editing) at the kernel level — but the kernel only sees scancodes, the line discipline runs in kernel space. Backspace handling at the prompt is the kernel's job, not ours. We send raw scancodes; the kernel does the rest.
- **The CGA mirror seeing scrolled-out content.** When the screen scrolls, the kernel rewrites the entire framebuffer. Our v0 mirror that just emits character bytes will produce garbled output during scrolls. Acceptable for v0; document.

## Definition of done

**Implementation success**:
- Keyboard input plumbing working end-to-end. Test: scripted "root\n" reaches a shell prompt.
- CGA output mirror in place. Test: kernel banner appears in mirrored output.
- Harness runs and is interactive. Manual verification: human can boot, type, see output, quit cleanly.

**Test counts**:
- All existing 1029 tests pass.
- New tests added (estimate: 20-40 unit tests for scancode translation + keyboard controller extensions + CGA mirror; 1-2 integration tests).
- Total ≥ 1050.

**Verification**:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean.
- Manual: harness boots ELKS to login, accepts typed input, shows output, Ctrl-A x exits cleanly.

The report at `KEYBOARD_HARNESS_REPORT.md` has these sections:

- **Summary**: outcome, key technical choices made.
- **Scancode translation**: the table you implemented, what's in scope and what's deferred (arrow keys, etc.), what evidence drove the choices.
- **Keyboard controller extensions**: what was added, the input queue mechanics, IRQ 1 firing.
- **CGA mirror**: simplification chosen, what works, what doesn't (full-screen redraws, scrolls, etc.).
- **Harness UX**: startup banner, quit mechanism, signal handling, what the user sees.
- **Integration test scenario**: exact scripted input, exact expected output, why this scenario.
- **Things future briefs should address**: arrow keys, full terminal emulation, browser deployment, etc.
- **CPU/memory bug candidates**: the heaviest-load run yet (real input-output cycles); anything suspect.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`reference/elks/elks/arch/i86/drivers/char/`** — keyboard driver source. Confirm scancode set, find keymap table.
2. **`reference/elks/elks/`** — anywhere `/etc/passwd` lives if needed for the login test.
3. **OSDev wiki "PS/2 Keyboard"** — scancode set 1 reference table.
4. **Existing `KeyboardController8042`** — extension target.
5. **`src/diagnostics/instrumentMachine`** (from Phase 3 / 6) — your pattern for non-invasive memory-write hooking.
6. **`src/console/NodeConsole`** — already does raw-mode stdin and TTY detection; reuse.

## Final notes

This is the brief that closes the loop. After it, ELKS isn't just an emulator artifact — it's a usable system. Eight prior briefs built the substrate; this one makes it talkable.

Document the harness UX carefully. The next person to use this codebase will use the harness before reading any other code. First-impression matters.
