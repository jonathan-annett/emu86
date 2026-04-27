# Serial Console Report (Phase 8)

## Summary

**Outcome A reached.** ELKS now boots over a 16550A UART at COM1 (port
0x3F8 / IRQ 4) with `console=ttyS0` set in `/bootopts` — no kernel
rebuild required. The harness `tools/elks/run-serial.ts` boots the
modified image, captures UART TX bytes to stdout, and forwards stdin
keystrokes into the UART RX FIFO. End-to-end: kernel banner streams to
stdout, `# ` shell prompt appears, typed commands echo and produce
output (verified manually and via integration test).

Key technical choices:

- **16550A generation, not 8250.** ELKS's serial driver
  (`reference/elks/elks/arch/i86/drivers/char/serial-8250.c`) probes
  for FIFO support by writing 0xE7 to FCR and reading IIR; with
  `CONFIG_HW_SERIAL_FIFO=y` (set in `ibmpc-1440.config:20`), it
  enables 14-byte trigger FIFO mode at open. Modeling 16550A is the
  smallest implementation that satisfies the probe and the open path.
- **/bootopts edit, not kernel rebuild.** The fd1440-fat.img already
  contains a 1 KiB `/bootopts` file with a commented-out
  `#console=ttyS0,19200 3` line; we replace that file in-place with a
  freshly-built one that activates `console=ttyS0,9600` and
  `init=/bin/sh`. FAT directory entries and cluster chains are
  unchanged because the file size stays exactly 1024 bytes.
- **`init=/bin/sh` instead of getty.** The source distribution image's
  `/etc/inittab` spawns getty on `/dev/tty1` only — never on ttyS0.
  Without rebuilding userland we can't add a serial getty entry.
  Going straight to `/bin/sh` via `init=` gives the same observable
  outcome (interactive shell over /dev/console, which is now /dev/ttyS0)
  without depending on userland configuration we can't change.
- **Fire-on-edge IRQ semantics.** The UART fires `onIRQ4` on the
  empty→non-empty transition of the RX FIFO (when IER.RDI is enabled).
  Subsequent injects while a higher-priority IRQ is being serviced
  don't re-fire, because the kernel's IRQ handler drains the entire
  FIFO per delivery (see `serfast.S` — reads RX while LSR.DR is set).
  Same pattern as `KeyboardController8042.onIRQ1`.

Test counts: 790 passing (was 756 in Phase 7.1). 32 new UART unit
cases + 2 new serial integration cases. Typecheck clean. CLI build
clean. Manual verification: serial harness boots to `# ` prompt within
~3.6M instructions, accepts `echo serial-ok\n`, prints `serial-ok`,
returns to prompt.

## Diagnosis

### 1. Which serial driver does ELKS have?

**File**: `reference/elks/elks/arch/i86/drivers/char/serial-8250.c`.
Single PC-compatible driver supporting 8250, 16450, 16550, 16550A,
and 16750. Generation is detected at boot via `rs_probe`
(`serial-8250.c:106-152`).

**Register layout**: from `reference/elks/elks/include/arch/serial-8250.h`,
the standard PC offsets:

| Offset | DLAB=0 | DLAB=1 | Notes                                      |
|--------|--------|--------|--------------------------------------------|
| 0      | RBR/THR | DLL  | Read drains receive; write transmits      |
| 1      | IER    | DLM   | Interrupt enable / divisor latch high      |
| 2      | IIR (R) / FCR (W) | — | Interrupt ID / FIFO control          |
| 3      | LCR    | LCR   | Bit 7 = DLAB                               |
| 4      | MCR    | MCR   | DTR / RTS / OUT1 / OUT2 / loopback         |
| 5      | LSR    | LSR   | DR / OE / PE / FE / BI / THRE / TEMT       |
| 6      | MSR    | MSR   | CTS / DSR / DCD / RI                       |
| 7      | SCR    | SCR   | Scratch                                    |

### 2. Which port base and IRQ?

**COM1 = 0x3F8, IRQ 4** (`reference/elks/elks/include/arch/ports.h:47-48`).
The driver's `ports[]` table is initialised with this base + IRQ for
COM1 (`serial-8250.c:54-59`).

### 3. Does it use FIFOs?

**Yes**, when `CONFIG_HW_SERIAL_FIFO=y` is set in the kernel config —
which is the case for `ibmpc-1440.config:20` (the canonical IBMPC
1.44M kernel config). Two paths use FIFOs:

- **Probe** (`serial-8250.c:118-129`): writes 0xE7 to FCR (enable + 14-
  byte trigger + 64-byte) regardless of `CONFIG_HW_SERIAL_FIFO`,
  reads IIR, checks bits 7..5 to identify generation.
- **Open** (`serial-8250.c:393-397`): if generation > 16550, writes
  `UART_FCR_ENABLE_FIFO14` (0xC7 = enable + clear RX/TX + 14-byte
  trigger) to FCR. Without `CONFIG_HW_SERIAL_FIFO`, the open path
  skips this and the device runs in non-FIFO (1-byte holding) mode.

Our UART models both modes and tracks the FCR enable bit. With FIFO on
we accept up to 16 RX bytes; without, 1.

### 4. What does the driver do at init?

**`rs_probe`** (`serial-8250.c:106-152`):

1. INB IER (read scratch).
2. OUTB(0, IER).
3. INB IER → must read 0 (else "no UART", returns -1).
4. OUTB(scratch, IER) — restore.
5. OUTB(0xE7, FCR) — try to enable maximum FIFO.
6. INB IIR — bit 7 set ⇒ FIFO present:
   - bit 5 set ⇒ 16750 (64-byte FIFO)
   - bit 6 set ⇒ 16550A (16-byte FIFO functional)
   - else ⇒ 16550 (non-functional FIFO)
7. If FIFO not present: OUTB(0x2A, SCR), INB SCR.
   - Reads back 0x2A ⇒ 16450
   - Else ⇒ 8250
8. OUTB(0, MCR) — chip reset, exits loopback.
9. OUTB(0x06, FCR) — clear RX/TX, FIFO disabled.
10. flush_input — read RX while LSR.DR is set.

**`rs_open`** (`serial-8250.c:360-420`), entered when something opens
`/dev/ttyS0` (e.g., login or shell):

1. INB LSR — clear pending RLS source.
2. If `CONFIG_HW_SERIAL_FIFO` and type > 16550: OUTB(0xC7, FCR) — enable
   14-byte trigger FIFO.
3. INB IIR, INB MSR — clear pending IIR/MSR.
4. `update_port` — set baud divisor (LCR with DLAB, DLL, DLM, LCR
   without DLAB).
5. OUTB(UART_IER_RDI = 0x01, IER) — enable RX data interrupt.
6. OUTB(DTR | RTS | OUT2 = 0x0B, MCR) — assert modem control lines.
7. INB LSR, INB RX, INB IIR, INB MSR — flush.

Our UART implements all of these faithfully. The IER round-trip
verification is the most important — if writing 0 to IER and reading
back doesn't return 0, the probe declares no UART.

### 5. How is the active console chosen?

**Compile-time default + /bootopts override.**

- **Compile-time**: `kernel/printk.c:55-59` — `DEVCONSOLE` is
  `MKDEV(TTY_MAJOR, RS_MINOR_OFFSET)` (i.e., `/dev/ttyS0`) when
  `CONFIG_CONSOLE_SERIAL` is set, else `MKDEV(TTY_MAJOR, TTY_MINOR_OFFSET)`
  (`/dev/tty1`). The `ibmpc-1440.config` has
  `# CONFIG_CONSOLE_SERIAL is not set` (line 95), so the default is
  `/dev/tty1`.
- **/bootopts override**: `init/main.c:562-577` parses
  `console=<dev>[,<baud>]`, calls `parse_dev` to translate the name
  (e.g., `ttyS0` → `DEV_TTYS0`), stores it in `boot_console`, and
  optionally calls `rs_setbaud` for the trailing baud value.
- **Activation**: `init/main.c:247` calls `set_console(boot_console)`
  during `kernel_init`. `printk.c:63-73` looks up the tty struct via
  `determine_tty(dev)`, sets `kputc = ttyp->ops->conout` and
  `dev_console = dev`. From this point, all printk traffic goes
  through the new `kputc` — which is `rs_conout` for ttyS0.
- **/dev/console**: `ntty.c:103-105` — opens of /dev/console (minor
  254) are routed via `determine_tty(dev_console)`, so the user-space
  shell that opens /dev/console gets the same backing tty the printk
  console uses. The shell's stdin/stdout/stderr (set up by
  `do_init_task` at `init/main.c:318-322`) all point at /dev/console.

Net effect of `console=ttyS0`: kernel printk + shell I/O both go
through the serial driver's rs_ops (which reads/writes the UART
directly).

### 6. Can ELKS use serial as primary console without rebuilding?

**Yes, via /bootopts.** The fd1440-fat.img distribution image already
ships with `/bootopts` containing a commented-out
`#console=ttyS0,19200 3` line (verified by `strings` against the raw
image). Uncommenting it (or replacing the file with one that has the
line active) makes set_console pick ttyS0.

Caveats encountered during implementation:

- **The fd1440-minix.img will NOT work.** The boot loader's
  `/bootopts` reader (`arch/i86/boot/setup.S:967`) is FAT12-only:
  *"Will fail gracefully on MINIX filesystems, no need for check of
  fs fstype."* The Phase 7 default image (Minix) silently produces
  `/bootopts not found or bad format/size` and falls back to the
  compile-time default (`/dev/tty1`). The serial harness uses
  fd1440-**fat**.img.
- **The /bootopts file format has tight validation**
  (`init/main.c:535-537`): must start with `##`, and at least one of
  byte[511] or byte[1023] must be 0 (i.e., "one sector or two
  sectors, with terminator"). NUL-pad the trailing slack region;
  spaces won't satisfy the check. (We wasted a debugging cycle on
  this — documented in code at `tools/elks-build/build-serial-image.ts`.)
- **Userland still spawns getty on tty1.** Even with
  `console=ttyS0`, `/etc/inittab` (or whatever spawns the getty
  printing `[1.59 secs] login:`) is configured for tty1 only; that
  prompt never reaches serial. Workaround: `init=/bin/sh` in
  /bootopts, which bypasses inittab entirely and runs /bin/sh
  directly on /dev/console (= /dev/ttyS0). That gives an
  interactive `# ` prompt over UART without any userland change.

### 7. What does ELKS expect on RX?

**Tty line discipline runs kernel-side**, exactly as for the keyboard
path:

- IRQ 4 handler (`serfast.S:asm_fast_com1`) reads bytes from UART RX
  while LSR.DR is set, queues them to the tty inq buffer, then EOIs
  the master PIC (`out $0x20, %al`).
- The serial bottom half (`serial-8250.c:292-299` `serial_bh`) calls
  `pump_port` to invoke `tty_intcheck` (signal generation: ^C → SIGINT
  if VINTR matches) and `wake_up` the inq waiter.
- Cooked / canonical mode (echo, line buffering, backspace handling,
  ^C signal generation, ^D EOF) all happen in `ntty.c`'s tty driver.

The harness just forwards raw stdin bytes; no host-side translation.

## UART implementation

`src/devices/uart-16550.ts`. ~430 lines, including extensive comments.

### Register set

All 8 PC-standard registers, DLAB-aware:

- **RBR/THR/DLL** at offset 0: RBR drain on read; THR triggers
  `onTransmit` on write. DLAB=1 hits DLL.
- **IER/DLM** at offset 1: 4-bit RX/THR/RLS/MSI enable bitmap. DLAB=1
  hits DLM.
- **IIR/FCR** at offset 2: IIR returns 16550A FIFO bits (7..6 = 11)
  when FIFO enabled, otherwise 0. Source bits (3..1) reflect highest-
  priority pending source. FCR enables / disables FIFO and clears
  RX/TX queues.
- **LCR** at offset 3: full byte; bit 7 toggles DLAB.
- **MCR** at offset 4: bits 0..4 (DTR / RTS / OUT1 / OUT2 / LOOP). Bit
  4 = 1 enables loopback.
- **LSR** at offset 5: THRE (always 1), TEMT (always 1), DR (RX FIFO
  non-empty), OE (sticky overrun, cleared on LSR read).
- **MSR** at offset 6: in normal mode returns CTS|DSR|DCD asserted, RI
  clear, no delta bits. In loopback, MSR's high nibble reflects MCR's
  bits 0..3.
- **SCR** at offset 7: round-trips a byte. Used by ELKS's probe to
  distinguish 16450 from 8250.

### What's implemented

- DLAB-gated divisor latch (stored, ignored for timing).
- 16-byte RX FIFO with FCR enable bit.
- Sticky overrun flag, cleared on LSR read.
- IIR with priority encoding (RDI > THRI), `IIR_NO_INT` bit when
  nothing pending, FIFO-enabled bits 7..6 = 11.
- Loopback mode: TX feeds RX FIFO instead of `onTransmit`; MSR
  reflects MCR.
- IRQ 4 firing on RX-empty → non-empty edge (with IER.RDI set), and
  on THRI rising / THR write (with IER.THRI set; one-shot per arming
  event, cleared on IIR read to prevent IRQ storms given THRE is
  permanently asserted).
- Scratch register byte round-trip.
- `injectByte` / `injectBytes` API mirroring
  `KeyboardController8042.injectScancode`.

### What's deliberately skipped

- **Real baud-rate timing.** Bytes pass instantly between host and
  guest. The divisor latch is captured but never used. Faithful
  baud emulation would require a clock subscription that schedules
  RX/TX completion events; not needed for our virtual-time model.
- **Receiver Line Status interrupts.** OE is sticky in LSR but
  IER.RLSI never fires the IRQ. The kernel doesn't enable RLSI in
  normal operation.
- **Modem Status interrupts (IER.MSI).** Same — kernel doesn't enable.
- **THRE-empty interrupt timing fidelity.** Real silicon's THRE
  interrupt fires once when THR transitions full→empty. We always
  have THRE = 1, so the source is "armed" briefly after enable / TX
  and one-shot — the kernel doesn't enable THRI either, so this is
  cosmetic.
- **CTS/DTR flow control behaviour.** MCR bits are stored but no
  flow control affects the byte stream.
- **Frame / parity / break errors (LSR FE/PE/BI).** Always 0.
- **64-byte FIFO (16750).** We claim 16550A only.

## ELKS configuration

### What changed in the image

- **Source**: `reference/elks-images/fd1440-fat.img` (existing
  distribution image, unmodified).
- **Output**: `reference/elks-images-serial/fd1440-fat-serial.img`
  (new directory; original kept for the framebuffer harness).
- **Edit**: `/bootopts` file content (1024 bytes at offset 0xEDC00 of
  the raw image) replaced with:

  ```
  ## /bootopts emu86 serial console build
  hma=kernel
  console=ttyS0,9600
  init=/bin/sh

  <NUL padding to 1024 bytes>
  ```

- **Why these settings**:
  - `hma=kernel`: matches the source; tells the bootloader to load the
    kernel into HMA. Removing it changes kernel layout in ways that
    may not boot.
  - `console=ttyS0,9600`: directs printk + /dev/console to /dev/ttyS0
    at 9600 baud (divisor 12). Baud is irrelevant for our model
    (instant byte transfer); we picked the smallest divisor that
    rounds cleanly.
  - `init=/bin/sh`: bypass /sbin/init's inittab → getty chain (which
    in this image binds getty to tty1 only). Direct /bin/sh on
    /dev/console gives an interactive `# ` prompt over UART without
    any userland change.

### Reproducible build

```
npm run build:elks-serial-image
# or:
npx tsc -p tsconfig.cli.json
node dist-cli/tools/elks-build/build-serial-image.js [src] [dst]
```

The tool reads the source image, locates `## /bootopts` by string
search (robust against floppy-image layout changes), overwrites the
1024-byte block with the new content, and writes to the destination.
FAT structures are untouched. Both source and destination paths are
optional CLI args.

The integration test (`tests/integration/elks-serial.test.ts`) runs
the same in-place edit at test setup time, so the test does not
depend on the pre-built image being on disk — only the source
fd1440-fat.img.

## Harness wiring

`tools/elks/run-serial.ts`. Sibling of `tools/elks/run.ts` with the
same shape but different I/O wiring:

| Aspect              | `run.ts` (CGA harness)     | `run-serial.ts` (Phase 8)              |
|---------------------|----------------------------|----------------------------------------|
| Default image       | `fd1440-minix.img`         | `fd1440-fat-serial.img`                |
| Stdin pump          | → ScancodeTranslator → 8042 | → UART RX (`uart.injectByte`) directly |
| Output              | CGA mirror → stdout (ANSI) | UART TX → stdout (raw bytes)           |
| CGA mirror          | Active, captures fb writes | Wired to a NullCGASink (drops bytes)   |
| Banner              | "ELKS in a terminal"       | "ELKS over serial console"             |
| Quit prefix         | Ctrl-A x                   | Ctrl-A x (same)                        |
| EOF semantics       | Pump keeps polling         | Pump keeps polling (same)              |

Three notable bits:

- **No scancode translator.** Serial bytes go through the kernel's
  tty line discipline directly — backspace, line buffering, ^C
  signal generation, all handled kernel-side. The host stdin →
  guest input path is one-to-one byte-for-byte.
- **CGA mirror disabled (silent sink).** The kernel still writes to
  0xB8000 during `console-direct` boot (the early-printk window
  before set_console redirects), but we don't want those bytes
  competing with serial output on the host terminal. A NullCGASink
  absorbs and discards. Trade-off: we lose the framebuffer
  diagnostic view; gain: clean serial-only output. Documented as a
  future-brief consideration ("reconciling CGA mirror with serial
  mode").
- **Ctrl-A x quit prefix preserved.** The QuitPrefix machinery is
  copy-pasted from `run.ts` (small enough that a shared module would
  be more friction than the duplication). Same behaviour: Ctrl-A x
  exits cleanly, Ctrl-A Ctrl-A passes a literal Ctrl-A to the
  guest, anything else after Ctrl-A passes through with the prefix
  consumed.

The npm script `start:elks-serial` builds the CLI and runs the
harness. `build:elks-serial-image` builds the image. Both scripts
follow the same pattern as `start:elks` (tsc compile + node run).

## Integration test scenario

`tests/integration/elks-serial.test.ts`, two cases.

### Case 1: end-to-end boot + command + output

1. **Setup**: load `fd1440-fat.img`, edit /bootopts in-memory (in-place
   1024-byte replacement at the bootopts offset), wire UART TX to a
   capture array, no-op CGA mirror sink (default).
2. **Phase 1 (boot)**: 8M instructions cap. Empirically the `# `
   prompt arrives at ~3.6M; the cap doubles to absorb future kernel-
   init slowdowns.
3. **Assert phase 1**:
   - "Direct console, scan kbd" appears in TX bytes (proves
     `set_console(boot_console)` succeeded — first printk after
     redirect).
   - "VFS: Mounted root device" appears in TX (proves the root mount
     hits serial as expected).
   - The TX stream ends with the `# ` shell prompt (regex
     `/# *$/`).
4. **Phase 2 (input + command)**: inject `"echo serial-ok\n"` byte-by-
   byte via `uart.injectByte`, run for 4M more instructions.
5. **Assert phase 2**:
   - The kernel echoed our typed bytes back (cooked-mode echo). The
     captured TX since phase 1 contains "echo serial-ok".
   - The shell ran echo and produced its output: "serial-ok"
     literally appears.
   - A fresh `# ` prompt appears at the end.

Why this scenario: it's the shortest path that exercises all four
paths — TX (banner), TX echo (kernel cooked-mode), RX (host → kernel),
and command output (userspace → tty → UART). If any of those four
broke, this test would fail.

### Case 2: framebuffer harness regression smoke

Boot `fd1440-minix.img` (the Phase 7 default) with the new UART in
place but `uartTransmit` unset. Assert the post-mount banner reaches
the framebuffer at row 22-ish (same as Phase 7's invariant). This
catches the case where adding the UART somehow perturbs the existing
boot path.

Both cases pass in ~4.5s on this device.

## What's deferred

- **Network device (NE2000 / WD80x3 / EL3).** Out of scope per the
  brief. Future surface for sockets / TCP guests / dhcp / etc.
- **Real baud-rate timing.** Bytes are forwarded instantly; the
  divisor latch is stored and ignored. Faithful emulation would need
  a clock subscription that schedules per-byte RX/TX events. Not
  needed for any current goal.
- **INT 14h BIOS serial services.** ELKS doesn't use them; not
  implemented.
- **Multi-port (COM2/COM3/COM4).** Single COM1 only. ELKS's probe
  fails cleanly on the unmapped ports (open-bus reads of IER return
  0xFF, the probe's `if (scratch)` rejects it).
- **Hardware flow control (RTS / CTS arbitration).** MCR bits are
  stored but don't gate the byte stream. ELKS's driver doesn't honour
  them either.
- **THRE / RLSI / MSR interrupt sources** are minimally modelled —
  THRI is one-shot per arming event, RLSI / MSI never fire in v0.
  The kernel doesn't enable any of these; if a future userland does,
  we'll add full firing semantics.
- **Loopback mode for ELKS's probe.** ELKS doesn't use loopback in
  its probe (verified by reading `rs_probe`); we still implement it
  per the brief's docs request, with unit-test coverage. If a future
  guest uses it, the implementation is ready.
- **CGA mirror in serial mode.** Currently sent to a NullSink. A
  future option might tee to a log file or a secondary sink.

## Things future briefs should address

In rough priority order:

1. **xterm.js browser harness (Phase 9).** The serial path is now
   the natural input/output surface for browser deployment. xterm.js
   consumes UART TX bytes and feeds keystrokes into UART RX — the
   same wiring the Node harness already does, just with the I/O
   replaced. `NodeConsole` already has the right interface; a
   `BrowserConsole` plugs into the same `IBMPCMachine` config slot.
2. **NE2000 (or other Ethernet) device.** ELKS supports `ne0`
   (`reference/elks/elks/include/arch/ports.h:122-124`); a
   compatibility-level NE2000 model would unblock TCP / SLIP /
   network filesystems.
3. **Serial getty in the userland image.** Rebuild ELKS with
   `/etc/inittab` configured to spawn getty on /dev/ttyS0 (or both
   tty1 and ttyS0). This would give a proper login + password flow
   over serial, instead of the current `init=/bin/sh` shortcut. The
   blocker is the cross-compile toolchain (ia16-gcc / dev86 not
   available in this environment).
4. **CGA mirror tee in serial mode.** A flag on `run-serial.ts`
   that pipes the framebuffer mirror to a log file would preserve
   the diagnostic view (early-boot CGA traffic) without polluting
   stdout.
5. **Reconcile early-printk path with serial.** Currently the first
   ~187 bytes of `early_printk` traffic (the ELKS boot banner and
   ttyS0 probe-success line) hit the BIOS console (CGA via INT 10h)
   only — they never reach serial. Patching `early_putchar` to also
   tee to UART would give a complete serial transcript starting from
   the first kernel byte. Cosmetic; the post-set_console path
   already covers the interesting content.
6. **Faithful 14-byte trigger interrupt timing.** Right now we fire
   IRQ 4 on every empty→non-empty FIFO transition; real silicon
   waits until the FIFO depth reaches the trigger level (or a
   character-timeout fires for slower-than-trigger arrivals). Our
   model is observably equivalent because the kernel's handler
   always drains to LSR.DR=0 per IRQ.
7. **Multi-UART fanout for tests.** Some tests would benefit from a
   second UART (COM2) to verify the bus / IRQ wiring scales beyond
   one device of a kind. Trivial to add (instantiate a second
   `UART16550` with `basePort: 0x2F8`, `onIRQ4: pic.assertIRQ(3)`).

## CPU/memory bug candidates

None observed. Phase 8 added:

- A new IRQ source (IRQ 4) raising the master PIC.
- A new device on the IO bus claiming 8 contiguous ports.
- A new TX path that sinks to stdout per byte (the harness's `process.stdout.write`).
- A new RX path that pushes bytes into a 16-byte queue.

The Phase 6 long-probe baseline (now run via the framebuffer harness
with the UART idle in `IBMPCMachine`) still reproduces. The new
serial integration test exercises ~12M instructions including IRQ 4
servicing, kernel printk via the UART, cooked-mode tty echo, and a
roundtrip through `/bin/sh` — and produces the expected output. No
flag-corruption / IRQ-EOI / memory-aliasing surfaces.

The "missing-EOI deadlock" pattern from Phase 4 was specifically
guarded against via the existing PIC + master-EOI test. ELKS's IRQ 4
handler EOIs the master PIC (`serfast.S:95-96` — `mov $0x20, %al; out
%al, $0x20`) before iret. We verified by tracing that IRQ 4 deliveries
balance with EOIs across the boot path.

## Verification

```
$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json
# clean

$ npm test
 Test Files  49 passed | 1 skipped (50)
      Tests  790 passed (790)
   Duration  ~26s
# 756 prior tests + 32 UART unit + 2 serial integration = 790. All
# previously-passing tests stay green; no regressions. The skipped
# file is `tests/sst/corpus.test.ts`, gated on `corpusAvailable()` —
# the SingleStepTests data corpus isn't installed in this environment.

$ npx tsc -p tsconfig.cli.json
# clean (CLI build)

$ npm run build:elks-serial-image
> emu86@0.0.1 build:elks-serial-image
> tsc -p tsconfig.cli.json && node dist-cli/tools/elks-build/build-serial-image.js
Wrote serial-console image: reference/elks-images-serial/fd1440-fat-serial.img
Source: reference/elks-images/fd1440-fat.img
/bootopts replaced at offset 0xedc00 (1024 bytes)

$ ( sleep 4 ; printf 'echo hello\n' ; sleep 4 ; printf '\x01x' ) \
    | timeout 25 node dist-cli/tools/elks/run-serial.js
# Boot reaches `# ` shell prompt, types "echo hello", shell prints
# "hello", returns to "# ", quit prefix exits cleanly. Total ~3M
# instructions for boot, ~1.5M for the echo round-trip.
```

## Files changed

New:

- `src/devices/uart-16550.ts` *(new)* — NS16550A UART model, ~430 lines
  including comments. Implements all 8 register offsets, DLAB-gated
  divisor latch, 16-byte RX FIFO, IIR priority encoding, loopback
  mode, scratch round-trip, IRQ 4 callback.
- `tests/unit/uart-16550.test.ts` *(new)* — 32 cases organised by
  feature: reset / scratch / IER probe / FCR-IIR / DLAB switching / TX
  / RX-with-FIFO / IRQ4 RX / IRQ4 THRI / loopback / end-to-end
  rs_probe replay.
- `tests/integration/elks-serial.test.ts` *(new)* — 2 integration
  cases: scripted serial session reaches `# `, runs `echo serial-ok`,
  prints "serial-ok" — and the framebuffer harness regression smoke.
- `tools/elks/run-serial.ts` *(new)* — runnable serial harness, sibling
  of `tools/elks/run.ts`.
- `tools/elks-build/build-serial-image.ts` *(new)* — image-build tool
  that edits /bootopts in-place to enable serial console.
- `reference/elks-images-serial/fd1440-fat-serial.img` *(new, generated)*
  — pre-built serial-console image. Re-buildable via the npm script.
- `SERIAL_CONSOLE_REPORT.md` *(new)* — this report.

Modified:

- `src/devices/index.ts` — re-export `UART16550` and types.
- `src/machine/ibm-pc.ts` — wire `UART16550` at COM1, `onIRQ4` →
  `pic.assertIRQ(4)`. New optional config field `uartTransmit`.
- `tsconfig.cli.json` — include `tools/elks/run-serial.ts` and
  `tools/elks-build/build-serial-image.ts`.
- `package.json` — added `start:elks-serial` and
  `build:elks-serial-image` npm scripts.

No changes under `src/cpu8086/`, `src/memory/`, `src/runtime/`,
`src/interrupts/`, `src/io/`, `src/timing/`, `src/console/`,
`src/disk/`, `src/bios/`, `src/host-clock/`, or any other existing
device file. Same locks as Phase 7. The UART is purely additive —
existing tests with no UART traffic see a quiescent device that never
asserts IRQ 4 and never produces TX bytes.
