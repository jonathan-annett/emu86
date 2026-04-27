# Keyboard Harness Report (Phase 7)

## Summary

ELKS is now interactive. Three pieces landed:

1. **Scancode translator** in `src/console/scancode-translator.ts`:
   stdin bytes → PC/AT set 1 scancode events (press/release pairs,
   Shift-wrapped symbols, Ctrl-letter wrapping, Backspace, Tab, Enter,
   Esc).
2. **Keyboard controller input queue + IRQ 1**: `KeyboardController8042`
   gained `injectScancode` / `injectScancodes`, an internal queue, and
   an `onIRQ1` callback wired in `IBMPCMachine` to `pic.assertIRQ(1)`.
3. **CGA framebuffer mirror** in `src/diagnostics/cga-mirror.ts`: a
   `writeByte` overlay that filters writes to 0xB8000-0xBFFFF and emits
   character bytes (skipping attribute bytes at odd offsets) to a sink.

The runnable harness `tools/elks/run.ts` wires NodeConsole stdin
through the translator into the keyboard controller, installs the CGA
mirror with stdout as its sink, and offers a `Ctrl-A x` quit prefix.
Manual run: `npm run start:elks` boots ELKS, accepts `root` + Enter at
the login prompt, returns a `#` shell prompt, accepts further commands,
and exits cleanly on the quit prefix.

Key technical choices:

- **No multi-byte stdin state machine.** Arrow keys and function keys
  are deliberately deferred — terminals send them as ESC-prefixed CSI
  sequences, and a v0 prefix-aware translator was out of scope. The
  user can reach a working shell with ASCII alone (the brief's stated
  goal).
- **Method-replacement instrumentation for the CGA mirror.** Same
  pattern as Phase 3's `instrumentMachine`. We wrap only `writeByte`,
  not `writeWord`, because `PagedMemory.writeWord` decomposes into two
  `writeByte` calls — wrapping both would double-emit.
- **Two-phase integration test.** Pre-injecting scancodes loses the
  first byte to ELKS's `kbd_init()` drain (which calls `kb_read()` once
  with IRQs disabled). The test boots to `login:`, then injects
  `"root\n"`, then runs to the shell prompt — exactly what the live
  harness sees.

## Scancode translation

The implemented translation table covers what an interactive ASCII shell
session needs:

| stdin bytes        | scancodes emitted                              |
|--------------------|------------------------------------------------|
| `'a'-'z' '0'-'9' '-' '=' '[' ']' ';' '\'' '`' '\\' ',' '.' '/'` | press + release |
| `' '` (space)      | 0x39 + 0x39\|0x80                              |
| `'A'-'Z'` and shifted symbols (`!@#$%^&*()_+{}:"~|<>?`) | Shift-down, key-press, key-release, Shift-up |
| 0x08 / 0x7F (BS / DEL) | 0x0E + 0x8E (Backspace)                    |
| 0x09 (TAB)         | 0x0F + 0x8F                                    |
| 0x0A / 0x0D (LF / CR) | 0x1C + 0x9C (Enter)                         |
| 0x1B (ESC)         | 0x01 + 0x81                                    |
| 0x01-0x1A (Ctrl-A..Z, except those with single-key roles above) | Ctrl-down, letter-press, letter-release, Ctrl-up |

Backspace accepts both 0x08 and 0x7F so terminals using DEL as the erase
byte (xterm default) and those sending BS both work. Carriage return
and line feed both produce Enter — terminals in raw mode on Linux send
LF, on Mac CR, and we accept either.

Evidence: `reference/elks/elks/arch/i86/drivers/char/kbd-scancode.c`
masks `code & 0x80` to detect releases, indexes `tb_state[]` starting at
0x1C, and pairs with the per-country keymap files in `KeyMaps/keys-us.h`
(scancode → ASCII). That's the canonical PC/AT set 1 layout. Set 2 / 3
are not honoured by the driver.

What's deferred:

- **Arrow keys / function keys.** Stream forwards each byte
  individually; user sees Esc, then `[`, then `A`. ELKS expects
  E0-prefixed extended scancodes (0xE0 0x48 etc.) — adding a multi-byte
  stdin state machine is a follow-up brief.
- **Caps Lock / Num Lock / Scroll Lock**, mouse, keypad-specific
  scancodes, international keys.

## Keyboard controller extensions

`KeyboardController8042` gained:

- `_scancodeQueue: number[]` — host-side queue.
- `injectScancode(byte)` — if OBF empty, place byte there and call
  `onIRQ1`; otherwise enqueue.
- `injectScancodes(bytes)` — convenience for multi-byte sequences.
- `pendingScancodeCount` getter — for inspection in tests.
- `onIRQ1` constructor option — wired in `IBMPCMachine` to
  `pic.assertIRQ(1)`.

Buffer drain: when the CPU reads port 0x60 with OBF set, OBF clears and
returns the byte. If the host queue has more, the next byte promotes
into OBF and `onIRQ1` fires again. So a 4-scancode burst (e.g., a
Ctrl-A wrap) raises IRQ 1 four times — once per byte the CPU drains —
matching real-8042 behaviour where each delivered byte is a separate
IRQ assertion.

Headless callers (everything before this brief) stay untouched: with no
`onIRQ1` set and no `injectScancode` calls, OBF stays empty forever and
the device behaves exactly as Phase 4. All Phase 4 / 5 / 6 tests still
pass.

## CGA mirror

`installCGAMirror(machine, { sink })` wraps `memory.writeByte` and
filters on linear address 0xB8000-0xBFFFF (configurable via `start` /
`end`). Even-offset writes are character bytes; odd-offset writes are
attribute bytes (foreground/background colour) and are dropped.

What works: sequential text writes (boot banner, shell prompt, `ls`
output) appear in the captured stream in write order, which is what
appears on screen when the kernel is filling the framebuffer one row
at a time.

What doesn't: the v0 mirror has no cursor tracking. Every write becomes
an emit, so:

- Full-screen redraws print the entire screen one cell at a time.
- Scrolls (the kernel rewrites the framebuffer to shift content) emit
  the visible rows again.
- Backspace at a prompt: the kernel writes a space at the cell, which
  prints a stray space rather than erasing the prior character on the
  host terminal.

These are documented v0 limitations. A future cursor-aware mirror
would hook the CRTC ports (0x3D4 / 0x3D5; cursor position is registers
0x0E high / 0x0F low) and emit ANSI cursor-move sequences between
character writes — about 60 lines of code.

The mirror returns a tear-down callback that restores the original
`writeByte`. Tests use this to install/remove cleanly across cases.

## Harness UX

`tools/elks/run.ts` is a single-file Node executable. Run via:

```
npm run start:elks
# or
npx tsc -p tsconfig.cli.json && node dist-cli/tools/elks/run.js [image] [maxInstr]
```

Default image is `reference/elks-images/fd1440-minix.img`; default cap
is unbounded (interactive sessions don't want a cap).

Startup banner clears the screen and prints:

```
emu86 — ELKS in a terminal
Image: reference/elks-images/fd1440-minix.img
Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A
Booting...
```

Quit prefix: Ctrl-A x. Mirrors `screen` / `tmux`. Ctrl-A is consumed
by the prefix handler; a second Ctrl-A passes through as a literal
Ctrl-A scancode to the guest. Ctrl-C is delivered to the guest (raw
mode disables host SIGINT generation, which is the right default for
an interactive shell that wants to receive Ctrl-C).

Output strategy: NodeConsole is wired to the BIOS, which captures the
~187 bytes of `early_printk` traffic via INT 10h AH=0Eh. That writes
straight to stdout through `writeChar`. Once `console_init` swaps to
`console-direct`, the kernel writes to 0xB8000 and the CGA mirror takes
over forwarding to stdout. The two paths never overlap in time; no
double-printing.

Stdin pump: a 10ms `setInterval` drains the NodeConsole input queue,
runs each byte through the quit-prefix machinery, then through the
translator, then injects scancodes into the keyboard controller. This
runs concurrently with the async run loop, so the kernel sees keystrokes
between batches.

Stdin-EOF handling: if stdin closes (piped script case), the pump
keeps polling — the kernel can still do non-input work (idle, timer
IRQs). The harness exits when `maxInstructions` is reached or when the
quit prefix fires.

## Integration test scenario

`tests/integration/elks-interactive.test.ts` runs a two-phase test:

1. **Phase 1: boot** — 8M instructions with no input. Asserts the boot
   reached `login:`.
2. **Inject** `"root\n"` (10 scancodes after Shift/Ctrl wrapping rules
   — but `"root\n"` is all unshifted lowercase, so just press+release
   pairs: `0x13 0x93 0x18 0x98 0x18 0x98 0x14 0x94 0x1c 0x9c`).
3. **Phase 2: input + shell** — 5M more instructions. Asserts:
   - `Mounted root device` and `/dev/fd0` in framebuffer (Phase 6
     invariant).
   - `Mounted root device` in CGA mirror capture (mirror is wired and
     receives banner traffic).
   - `login: root` in framebuffer (the kernel echoed our typed input).
   - All injected scancodes consumed (queue empty + OBF empty).
   - Some row of the framebuffer starts with `# ` (BusyBox-style shell
     prompt).

Why this scenario: ELKS's `/etc/passwd` has root with an empty password
(`root::0:0:Admin:/root:/bin/sh`), so login completes immediately on
`root\n` without a password prompt. This is the shortest path from boot
to interactive shell.

Why two-phase: ELKS's `kbd_init()` calls `kb_read()` once with IRQs
disabled to drain any pending byte from the controller's output buffer
(it's discarding power-on noise from a real keyboard). Pre-injecting
loses the leading 'r'-press to that drain. The live harness doesn't hit
this because the user types after the prompt; the test follows the same
pattern.

Test runs in ~6.5s on this device.

A second smoke test in the same file installs the harness wiring
(translator + mirror + IRQ 1) but never injects input, then runs 4M
instructions and asserts the boot still reaches the post-mount banner.
This catches the case where adding the new plumbing somehow breaks the
unaltered boot path.

## Things future briefs should address

Ordered roughly from "small, useful" to "large, optional":

1. **Arrow / function key support.** Multi-byte stdin state machine
   that recognises `ESC [ A`...`ESC [ D` and emits 0xE0 0x48...0x4B,
   etc. The shell line-editor (busybox `sh`) probably uses arrow keys
   for history; without them, history navigation requires Ctrl-P /
   Ctrl-N if the shell binds them.
2. **Cursor-aware CGA mirror.** Hook CRTC ports 0x3D4 / 0x3D5 (cursor
   position registers 0x0E / 0x0F), emit ANSI cursor-move sequences
   between character emits. Would clean up scroll redraws and make
   backspace look natural on the host terminal. ~60 lines.
3. **Keyboard LED + status command support.** ELKS's `kbd_send_cmd`
   writes 0xED to port 0x60 to set LEDs. We currently warn-and-discard;
   adding ACK (0xFA) responses would make the kernel's LED state
   machine happy and silence a warning. Cosmetic.
4. **Browser harness.** `NodeConsole` already has a clear interface
   (`writeChar` / `readChar` / `hasInput`); a browser-side
   `BrowserConsole` plus a canvas/CGA renderer would deliver the same
   experience in a webpage. The CGA mirror's sink interface plugs
   straight into a canvas painter.
5. **Scripted-session record/replay.** A small wrapper that captures
   stdin bytes + the framebuffer at end-of-run would make
   regression-grade integration tests easy to write — point-and-shoot
   "type these keystrokes, screen should look like this" tests.
6. **Pause/resume and step-over-from-shell.** Beyond v0 scope but
   would let someone debug a guest interactively.

## CPU/memory bug candidates

None observed. The Phase 7 work is the heaviest workload yet for the
substrate — real input/output cycles, IRQ 1 deliveries every few ms of
kernel time, framebuffer writes from `console-direct` on every
character output. After 13M instructions the kernel reaches a working
shell prompt, accepts a typed command (`ls`), prints the directory
listing, and returns to prompt — all the way to userspace `/bin/sh`
running and reading from `/dev/tty1` correctly. Any subtle CPU-flag /
memory-aliasing bug would manifest as garbled banner text, a crashed
shell, or scrambled scancode delivery; we see none.

The Phase 6 long-probe baseline reproduces exactly: same final CS:IP
`0330:8119`, same `[1.29 secs] login:` prompt position, same per-port
IO totals to the byte. The new plumbing did not perturb the headless
run path.

## Verification

```
$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json
# clean

$ npm test
 Test Files  47 passed | 1 skipped (48)
      Tests  747 passed (747)
   Duration  ~30s
# 706 prior tests + 41 new (22 scancode-translator + 7 keyboard-controller
# additions + 7 cga-mirror + 2 elks-interactive integration + 3 misc) — all green.
# tests/sst/corpus.test.ts is skipped: the SingleStepTests data corpus is
# not installed in this environment (gated on corpusAvailable()). The
# Phase 6 baseline of 1029 included the 323 corpus tests; 1029 - 323 =
# 706 matches what we see here.

$ npx tsc -p tsconfig.cli.json
# clean

$ node dist-cli/tools/elks/run.js reference/elks-images/fd1440-minix.img 5000000
# emu86 — ELKS in a terminal
# Image: reference/elks-images/fd1440-minix.img
# Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A
# Booting...
# (kernel banner + login: prompt visible)

$ ( sleep 4 ; printf 'root\n' ; sleep 8 ; printf 'ls\n' ; sleep 3 ; printf '\x01x' ) \
    | node dist-cli/tools/elks/run.js
# Boot to login:, types "root\n" (login successful), prompt becomes "# ",
# types "ls\n", shell runs ls, returns to "# ", quit prefix exits cleanly.

$ node dist-cli/tests/integration/long-probe.js fd1440-minix.img 25000000
# Phase 6 baseline reproduced: same final CS:IP 0330:8119, same login:
# prompt at framebuffer row 22, same per-port IO totals, ~2.3M ips.
```

## Files changed

- `src/console/scancode-translator.ts` *(new)* — stdin → PC/AT set 1
  scancode translator; pure function plus a thin `ScancodeTranslator`
  wrapper.
- `src/console/index.ts` — re-export the translator.
- `src/devices/keyboard-controller.ts` — added input queue, `onIRQ1`
  callback, `injectScancode` / `injectScancodes` /
  `pendingScancodeCount`. The Phase 4 / 5 surface is unchanged; existing
  tests still pass.
- `src/machine/ibm-pc.ts` — wired `onIRQ1: () => pic.assertIRQ(1)` into
  the keyboard controller construction, mirroring the PIT channel 0
  IRQ 0 wiring already there.
- `src/diagnostics/cga-mirror.ts` *(new)* — `installCGAMirror` with
  `CGAMirrorSink` interface and `CapturingCGASink` for tests.
- `src/diagnostics/index.ts` — re-export the mirror.
- `tools/elks/run.ts` *(new)* — runnable harness.
- `tsconfig.cli.json` — added `tools/elks/run.ts` and the new
  `tests/integration/input-probe.ts` to the include list.
- `package.json` — added `start:elks` npm script.
- `tests/unit/scancode-translator.test.ts` *(new)* — 22 cases covering
  printables, control bytes, Ctrl-letter, shifted symbols, multi-byte
  feeds, out-of-table bytes.
- `tests/unit/keyboard-controller.test.ts` — extended with 7 new cases
  for the injection API + IRQ 1 firing.
- `tests/unit/cga-mirror.test.ts` *(new)* — 7 cases covering character
  emit, attribute filtering, range filtering, word writes, tear-down,
  boot-message-style streams.
- `tests/integration/elks-interactive.test.ts` *(new)* — 2 cases:
  end-to-end `"root\n"` → `# ` prompt, plus a no-input wiring smoke
  test.
- `tests/integration/input-probe.ts` *(new)* — diagnostic probe used
  during development to validate the two-phase injection pattern.

No changes under `src/cpu8086/`, `src/memory/`, `src/runtime/`,
`src/interrupts/`, `src/io/`, `src/timing/`, `src/disk/`, `src/bios/`,
or `src/host-clock/`. The instrumentation overlay pattern (Phase 3's
carve-out) is the only way the locked layers are touched, and only at
construction time on a single method reference.
