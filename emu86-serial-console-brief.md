# emu86 — Agent Brief: Serial Console (Phase 8)

## TL;DR

Add a 16550-class UART device (with 8250 backward-compatibility — pick
whichever generation ELKS's driver actually expects, after reading the
source), wire it into `IBMPCMachine` at COM1 (base 0x3F8, IRQ 4), and
get ELKS to use it as its primary console. Host stdin / stdout flow
through the UART. The CGA framebuffer + mirror stay in place as a
diagnostic view; they're no longer on the critical path for
interactivity.

This brief is exploratory in the Phase 5 / 6 sense: there's real
uncertainty about how ELKS selects its console (build-time? boot
param? source patch?). Diagnose first, decide scope from evidence,
implement what's possible. Multiple acceptable success outcomes
defined below.

Document everything in `SERIAL_CONSOLE_REPORT.md`.

You are working in `emu86/`. Read `KEYBOARD_HARNESS_REPORT.md` and
`CGA_CURSOR_REPORT.md` for the current state of the harness, and
`PIC_REPORT.md` + `PIT_REPORT.md` as the reference patterns for
building a new device. ELKS source at `reference/elks/`.

## Why this work

The framebuffer + scancode + CGA-mirror path closes the "watch the
kernel boot and poke at it" loop, but it's fundamentally diagnostic:
the user is observing a guest video card and feeding it scancodes
because that's what a real-PC user would do. The natural I/O surface
for a server-class system — and the natural surface for our
browser-deployment target driven by xterm.js — is a byte stream.
Serial is the smallest concrete realisation. Network (NE2000-class)
is the next step beyond.

After this brief lands, Phase 9 is a thin browser harness: xterm.js
consumes the UART's TX byte stream and feeds keystrokes back into RX.
No canvas-CGA renderer required for v0 browser.

## Hard rules

1. **Don't break existing tests.** 756 passing without corpus / 1079
   with corpus as of Phase 7.1. All must stay green. The CGA-driven
   harness test must keep passing.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **Diagnose before you implement.** Don't pre-implement a 16550 with
   FIFOs because "real PCs have it." Read ELKS's serial driver, see
   what registers and behaviours it actually exercises, build the
   minimum that satisfies the kernel. Phase 5's diagnose-then-fix
   discipline applies.
6. **You may add** `src/devices/uart-16550.ts` (or `uart-8250.ts` —
   name reflects what you actually built), unit tests for it,
   integration tests for the serial harness path, a new harness entry
   in `tools/elks/` (e.g., `tools/elks/run-serial.ts`) or a flag on the
   existing one, and possibly new files in `tools/elks-build/` if a
   rebuild path is needed.
7. **You may modify** `src/machine/ibm-pc.ts` (for UART wiring),
   `tools/elks/run.ts` (if extending the existing harness), and
   `package.json` (npm script for the serial harness if useful).
8. **You may NOT modify** `src/cpu8086/`, `src/memory/`, `src/runtime/`,
   `src/interrupts/`, `src/io/`, `src/timing/`, `src/console/`,
   `src/disk/`, `src/bios/`, `src/host-clock/`, or any other existing
   device. The BIOS does not need INT 14h handlers — ELKS's serial
   driver talks to the UART directly via port I/O.
9. **No fix-and-pray on ELKS configuration.** If you discover you'd
   need to rebuild ELKS and the toolchain isn't available, *don't*
   try to patch the binary or invent a custom protocol. Document the
   blocker and stop. Phase 5's discipline.

## Background

The substrate already has everything we need to host a new IRQ-driven
device:

- `BasicIOBus` accepts port-handler registration; same pattern PIC,
  PIT, and `KeyboardController8042` use.
- `PIC8259` raises IRQs into the InterruptController; IRQ 4 is wired
  to the master PIC in standard PC ordering (IRQ 0 = timer, IRQ 1 =
  keyboard, IRQ 2 = cascade, IRQ 3 = COM2, IRQ 4 = COM1).
- The `Console` interface in `src/console/` provides
  `writeChar` / `readChar` / `hasInput` over stdin / stdout in
  Node. NodeConsole already does raw-mode TTY handling and EOF
  detection.

What's missing is the device itself, the harness wiring that connects
NodeConsole to it, and an ELKS image that uses it as console.

## Scope

### Section 1 — diagnosis (mandatory first step)

Read `reference/elks/elks/arch/i86/drivers/char/` and the kernel
config / build system. Answer concretely in the report:

1. **Which serial driver does ELKS have?** File path, what UART
   generation it targets (8250 / 16450 / 16550 / 16550A), what
   register layout it assumes.
2. **Which port base and IRQ does it expect by default?** Likely 0x3F8
   / IRQ 4 for COM1; verify.
3. **Does it use FIFOs?** I.e., does it write to the FCR (offset 2)
   to enable 16550 FIFO mode, and does it depend on FIFO behaviour
   for correctness, or is FIFO support optional?
4. **What does it do at init?** Does it probe for the UART (e.g., by
   writing to scratch / loopback registers and reading back)? What
   sequence of register writes does it execute? This determines what
   we have to make believable.
5. **How is the active console chosen?** Walk the kernel boot. Is
   there a `console=` boot parameter parser, a build-time
   `CONFIG_CONSOLE_*` define, a console-list with priority, or a
   hardware probe? Cite line numbers.
6. **Can we get ELKS to use serial as primary console without
   rebuilding?** Options to evaluate, in order of preference:
   - Edit a config file inside the floppy image (mount loop-back, edit
     a text file, unmount). No code rebuild.
   - Pass a kernel command-line parameter at boot. Requires the boot
     loader to forward it; check whether ELKS's boot loader supports
     this and whether the existing image's boot sector reads it from a
     known location.
   - Rebuild the ELKS kernel with serial console enabled. Requires a
     working ia16-gcc / dev86 toolchain on the agent's machine —
     **check before assuming**.
   - Patch the kernel source and rebuild. Last resort.
7. **What does ELKS expect to happen on RX?** Specifically, is the
   incoming byte translated by tty line discipline (echo, line
   buffering, signal generation on Ctrl-C) inside the kernel? It
   should be — same as scancode → tty conversion for the keyboard
   path. Confirm.

This section is not optional. The implementation choices in section 2
depend on what you find here.

### Section 2 — implement the UART

Build `src/devices/uart-XXXX.ts` (name reflects the generation you
chose). The minimum register set is:

| Offset | DLAB=0 | DLAB=1 | Notes                                          |
|--------|--------|--------|------------------------------------------------|
| 0x3F8  | RBR/THR | DLL  | Read drains receive buffer; write transmits   |
| 0x3F9  | IER    | DLM   | Interrupt enable / divisor latch high          |
| 0x3FA  | IIR (R) / FCR (W) | — | Interrupt ID / FIFO control               |
| 0x3FB  | LCR    | LCR   | Bit 7 = DLAB; data bits / stop bits / parity  |
| 0x3FC  | MCR    | MCR   | DTR / RTS / loopback                           |
| 0x3FD  | LSR    | LSR   | DR / OE / PE / FE / BI / THRE / TEMT          |
| 0x3FE  | MSR    | MSR   | CTS / DSR / DCD / RI                           |
| 0x3FF  | SCR    | SCR   | Scratch — ELKS may use it for UART probing    |

Implementation notes:

- **DLAB switching is the single trickiest part.** When LCR bit 7 is
  set, reads/writes at 0x3F8 and 0x3F9 hit the divisor latch instead
  of RBR/THR/IER. Easy to get wrong, easy to test. Don't model real
  baud rate — store the divisor, ignore it for timing purposes. Real
  baud is irrelevant to us; we forward bytes instantly.
- **LSR is mostly read-as-constant in our model**: THRE = 1 always
  (we never block on transmit), TEMT = 1 always, DR = 1 when the host
  RX queue is non-empty. OE / PE / FE / BI are 0 always.
- **IRQ 4 firing**: when the controller wants to assert IRQ 4 — driven
  by the IER bits and current state — it calls an `onIRQ4` callback
  set by `IBMPCMachine` to `pic.assertIRQ(4)`. Same pattern as
  keyboard IRQ 1.
- **TX path**: the device exposes a callback / sink for outgoing
  bytes (`onTransmit(byte)`). The harness wires it to stdout (or to
  a capturing buffer in tests).
- **RX path**: the device exposes `injectByte(byte: number)` and
  `injectBytes(bytes: number[])`. Same shape as
  `KeyboardController8042.injectScancode`.
- **FIFO support**: only if the diagnosis shows ELKS uses it. If
  optional, model the FIFO as 16-byte queues with the FCR enable bit;
  keep the simpler 1-byte-deep mode as the default if FCR FIFO bit
  is 0.
- **Scratch register**: stores and returns a byte. ELKS may use this
  as a UART-presence test (write 0x55, read back 0x55, must match).
  Implement faithfully.
- **Loopback mode** (MCR bit 4): when set, TX bytes loop back to RX
  internally and don't reach the host. ELKS may use this in probe.
  Implement only if the probe demands it.

The file should not depend on Node-specifics. The harness wires
`onTransmit` and `injectByte`; the device is environment-agnostic.

### Section 3 — wire ELKS to use serial as console

Driven by section 1's findings. Three success outcomes, ordered by
preference:

**Outcome A: ELKS uses serial without rebuild.**
- Boot config edited / boot param passed / similar.
- New floppy image at `reference/elks-images/fd1440-serial.img` (or
  a runtime config fork) configured for serial console.
- `tools/elks/run.ts` (or a sibling) loads this image and the harness
  uses serial.

**Outcome B: ELKS rebuilt with serial console enabled.**
- Toolchain confirmed present.
- Kernel rebuilt with the relevant config flag.
- New image at `reference/elks-images/fd1440-serial.img`.
- `tools/elks-build/` contains the rebuild script and any patch.
- Document the build steps reproducibly.

**Outcome C: Diagnosis-only.**
- Both A and B blocked (toolchain missing, ELKS lacks serial console
  support, or other).
- UART device implementation lands and is unit-tested in isolation
  (loopback mode + capture / inject).
- Wired into `IBMPCMachine` but unused by the existing CGA-driven
  harness — the wiring is dormant.
- Report explains exactly what's needed to unblock A or B.
- Phase 9 (browser) is unaffected for the framebuffer harness; serial
  Phase 9 unblocks when serial does.

Each outcome is a valid completion. Pick the highest-numbered one
reachable on this machine.

### Section 4 — harness wiring

A serial-mode harness — either as a flag on `tools/elks/run.ts` or as
a sibling file `tools/elks/run-serial.ts`. It:

- Constructs `IBMPCMachine` with the UART wired and (if outcome A or
  B reached) the serial-console image as the boot disk.
- Wires `NodeConsole.hasInput / readChar` into UART RX
  (`uart.injectByte`).
- Wires UART `onTransmit` into stdout (direct byte write — the kernel
  produces the line discipline output already; we just forward).
- The CGA mirror stays available but disabled by default in
  serial mode (or piped to a log file via a flag).
- Same Ctrl-A x quit prefix as the framebuffer harness; same EOF
  semantics; same banner.

Add an npm script — `start:elks-serial` — analogous to the existing
`start:elks`.

### Section 5 — what you are NOT building

- Network card (NE2000 or otherwise). Separate future brief.
- Multiple concurrent UARTs. COM1 only.
- Real baud-rate timing. We forward bytes instantly; the divisor
  latch is stored and ignored.
- Modem control beyond what ELKS's probe / driver actually toggles.
- Hardware flow control behaviours (RTS / CTS arbitration).
- INT 14h BIOS serial services. ELKS doesn't use them; not needed.
- xterm.js / browser frontend. That's Phase 9.
- Removing or polishing the CGA mirror. Stays as-is.

## Tests

### Unit tests — UART

`tests/unit/uart-XXXX.test.ts`. Cover at least:

- Port reads / writes hit the correct register based on offset and
  DLAB state.
- DLAB switching: LCR bit 7 toggles which register lives at 0x3F8 /
  0x3F9. Writing to DLL / DLM doesn't disturb RBR / THR state.
- TX path: writing to THR triggers `onTransmit(byte)` exactly once
  with the byte.
- RX path: `injectByte(0x41)` makes LSR.DR = 1; reading RBR returns
  0x41 and clears DR; subsequent read returns... whatever the chosen
  generation specifies (typically the last byte for 8250-style, or
  next FIFO entry for 16550).
- IRQ 4 firing on RX when IER.0 is set: `injectByte` after enabling
  RX interrupts calls `onIRQ4`. Disabling clears the path.
- IRQ 4 firing on TX-ready when IER.1 is set: writing THR (or
  immediately, if THRE is permanently asserted) raises IRQ 4 if
  enabled. Sequence depends on chosen generation.
- Scratch register round-trips a byte.
- Loopback mode (if you implemented it): TX bytes appear in RX, no
  `onTransmit` call.
- FIFO behaviour (if you implemented it): bytes queued up to the FIFO
  size; FIFO clear via FCR; threshold-driven IRQ.

Aim for ~15-25 cases. Don't pad.

### Integration test — serial path

If outcome A or B reached:
`tests/integration/elks-serial.test.ts`:
- Boot ELKS from the serial-configured image.
- Capture UART TX bytes into a buffer.
- Assert: the kernel banner appears in TX bytes within N million
  instructions.
- Inject "root\n" via UART RX.
- Assert: a `# ` shell prompt (or the post-login prompt the kernel
  produces) appears in TX bytes.

If outcome C: skip this test; the unit tests cover the device.

### Smoke test — framebuffer harness still works

The existing `tests/integration/elks-interactive.test.ts` cases must
keep passing. Adding the UART to `IBMPCMachine` must not perturb the
CGA / keyboard path. Verify.

## Watch out for

- **DLAB state interactions.** Easy to get the conditional
  routing of 0x3F8 / 0x3F9 wrong. Test both states explicitly.
- **The probe sequence.** ELKS's serial driver init may write a known
  byte to scratch and read it back to confirm a UART is present. If
  scratch is missing or wrong, the driver will skip serial and fall
  back to whatever's next. Read the probe code; satisfy it exactly.
- **IRQ 4 vector vs IRQ 4 line.** IRQ 4 from the master PIC maps to
  CPU interrupt vector 0x0C (8 + 4) in standard PC PIC programming.
  We don't set the vector — the BIOS / kernel already programmed the
  PICs in earlier phases, and we honour whatever offset they
  configured. Your job is to assert IRQ line 4 via `pic.assertIRQ(4)`.
  The PIC handles the rest.
- **Half-duplex assumptions.** Don't assume bytes alternate strictly
  TX / RX. The kernel may interleave: write THR, read RBR, write THR,
  read RBR, all fine.
- **Toolchain hazard.** If you decide outcome B is needed and the
  toolchain isn't present, *stop and report*. Don't try to install a
  cross-compiler in the agent's environment without explicit
  authorisation. Document what's needed.
- **"Both consoles enabled" ambiguity.** ELKS may support serial
  *and* CGA simultaneously, mirroring kernel printk to both. If so,
  the framebuffer mirror still receives output even in serial mode.
  Decide whether this is desirable (debug visibility) or not (double
  output) and document the choice.
- **The kernel's tty line discipline runs on RX bytes.** Same as the
  scancode path — backspace, line buffering, Ctrl-C signal generation
  all happen kernel-side. We just forward raw bytes. Don't try to
  pre-translate stdin in the harness; the translator from Phase 7
  applies only to scancodes, not to the serial path.
- **Loopback test trap.** ELKS's probe may use loopback mode to
  verify the device. If you implement loopback wrong, the probe
  fails and serial console silently disables. Test the loopback bit
  carefully; if you skipped loopback because the diagnosis showed
  ELKS doesn't use it, document that decision.
- **The CPU bug surface stays exercised.** This is a new IRQ source
  with non-trivial timing. Phase 4's missing-EOI lesson applies — if
  the kernel's IRQ 4 handler doesn't EOI the master PIC, we deadlock.
  Verify in trace.

## Definition of done

**Outcome A or B (full success)**:
- UART device exists with passing unit tests.
- ELKS image / config produced that uses serial as primary console.
- Serial-mode harness boots ELKS to a `login:` prompt over UART TX,
  accepts injected `"root\n"`, returns a shell prompt, accepts a
  command, prints output. Manual verification works.
- Framebuffer harness still works unchanged.
- Integration test: scripted serial session reaches shell prompt.
- All prior tests green.
- Total tests ≥ 770.

**Outcome C (diagnosis-only)**:
- Diagnosis section in report fully populated with citations.
- UART device exists with passing unit tests (loopback / inject /
  capture).
- Wired into `IBMPCMachine` but dormant (no driver exercising it).
- Report's "what's needed to unblock" section is concrete enough that
  a follow-up brief is straightforward.
- All prior tests green.
- Total tests ≥ 770.

In either case:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).

The report at `SERIAL_CONSOLE_REPORT.md` has these sections:

- **Summary**: outcome (A / B / C), key technical choices.
- **Diagnosis**: answers to all section-1 questions with file
  citations and line numbers.
- **UART implementation**: register layout chosen, generation
  (8250 / 16550), what features were implemented vs skipped and why.
- **ELKS configuration**: which path was taken, what changed in the
  image, reproducible build / config steps.
- **Harness wiring**: serial mode entry point, NodeConsole ↔ UART
  bridge, CGA mirror behaviour in serial mode, banner / quit / EOF.
- **Integration test scenario**: scripted input, expected output,
  why this scenario.
- **What's deferred**: network, real baud, INT 14h, multi-port,
  flow control.
- **Things future briefs should address**: NE2000 / network device,
  xterm.js browser harness, reconciling CGA mirror with serial mode.
- **CPU/memory bug candidates**: anything that surfaces under the new
  IRQ workload.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`reference/elks/elks/arch/i86/drivers/char/`** — serial driver
   source. The diagnosis section depends on this being read carefully.
2. **`reference/elks/`** — kernel build system; check for
   `Configure` / `Kconfig` / Makefile-driven console selection.
3. **`reference/8086tiny/`** — reference C emulator. May or may not
   model the UART; consult only if helpful.
4. **OSDev wiki "Serial Ports"** — register layout reference for
   8250 / 16550 generations.
5. **`src/devices/keyboard-controller.ts`** — closest existing pattern
   for an IRQ-driven device with `inject*` API and `onIRQ` callback.
6. **`src/devices/pic-8259.ts`** + **`src/machine/ibm-pc.ts`** — wiring
   patterns; how IRQ callbacks attach.
7. **`src/console/NodeConsole.ts`** — the host-side I/O surface; reuse
   without modification.

## Final notes

Two things worth holding in mind while writing this:

The diagnosis is the brief. If section 1 turns up that ELKS already
supports serial console and the boot loader honours `console=ttyS0`,
the implementation is small and the work is mostly testing. If
section 1 turns up a rebuild requirement and the toolchain is
missing, outcome C is the right answer and is *not a failure* —
documenting what's needed is the deliverable.

The harness UX matters again. After Phase 9, the serial path becomes
the default user-facing surface (xterm.js consumes the same byte
stream this brief produces). Any rough edges here propagate. Keep the
harness banner, quit prefix, and EOF behaviour consistent with
`tools/elks/run.ts` so the user experience doesn't fork between
modes.
