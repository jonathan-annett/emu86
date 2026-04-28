# Early-printk Report — Phase 9.1

## Summary

**Outcome: A (the lightest of the brief's three success outcomes), and degenerate.**

The brief's premise — "the browser harness shows a 3-second blank
xterm window before the kernel banner appears" — does not reproduce
against the current code. Diagnosis showed that ELKS's `early_putchar`
on IBM PC builds uses BIOS INT 10h AH=0x0E (teletype output), which
the emu86 BIOS forwards to `Console.writeChar`. In the worker host,
`BrowserConsole.writeChar` is wired through a shared `txBuffer` to the
same `tx` postMessage channel that carries UART TX bytes — so the
ELKS Setup banner and pre-`set_console` kernel lines reach xterm.js
in the first batch of `tx` messages, not after a multi-second pause.

A live boot probe (instructions 0–2,000,000) captured 1,391 bytes of
TX content, including:

```
ELKS..............................................................................................................................................................................................................................
ELKS Setup ....L076EC34H01S0D Ht0330 f122A d19F2 INT f002 START
ttyS0 3f8 irq 4 16550A
Direct console, scan kbd 80x25 emulating ANSI (2 virtual consoles)
xms: 34816K, disabled, A20 error. 64K ext buffers, 8K cache, 15 req hdrs
eth: ne0 at 300, irq 12 not found
eth: wd0 at 0x240, irq 2, ram 0xce00 not found
eth: 3c0 at 330, irq 11 not found
```

`set_console(/dev/ttyS0)` doesn't fire until well after this window,
so every byte above is unambiguously from the BIOS INT 10h path
through `BrowserConsole.writeChar`. The wiring works.

What was missing in pre-Phase-9.1 code was not the wiring but the
**confidence** that it would stay wired:

- No regression test asserted that early-printk content reaches
  `tx` messages.
- The Phase 9 welcome message in `web/main.ts` still warned users
  about a "blank window" that no longer existed.

This report's "Implementation" section closes both gaps. No engine,
device, or worker-host code changed.

### Key technical choices

- **Outcome A, no Outcome B or C work.** The brief lists Outcome B
  (CGA-mirror→TX bridge) and Outcome C (kernel rebuild) as fallbacks
  if BrowserConsole legitimately receives nothing. Diagnosis showed
  it receives the full early-printk stream, so neither fallback is
  needed.
- **No CGA-mirror sink change.** The CGA mirror still drops to
  `NullCGASink` in the browser worker host. Wiring it to xterm would
  cause the brief's "double output" failure mode at the
  BIOS→UART boundary, because both the BIOS console *and* the CGA
  framebuffer receive each early-printk byte (early_putchar via
  INT 10h causes the BIOS handler to forward to Console.writeChar;
  ELKS additionally writes to 0xB8000 via console_init's direct
  driver). With the BIOS path already covering the bytes, leaving
  the CGA sink null is correct.
- **No new helper modules.** All changes are tests + docstring +
  `web/main.ts` text.

## Diagnosis

### 1. What does `early_printk` actually do?

`reference/elks/elks/kernel/printk.c:75-82` defines `kputchar`:

```c
void kputchar(int ch)
{
    if (ch == '\n')
            kputchar('\r');
    if (kputc)
            (*kputc)(dev_console, ch);
    else early_putchar(ch);
}
```

`kputc` is set by `set_console()`; before that runs, every printk
character falls into `early_putchar`.

`early_putchar` is defined per architecture in
`reference/elks/elks/arch/i86/boot/crt0.S:84-94`:

```asm
#elif defined(CONFIG_ARCH_IBMPC) || defined(CONFIG_ARCH_8018X)
early_putchar:
        mov   %sp,%bx
        mov   2(%bx),%al
        mov   $0x0E,%ah
        mov   $0x0007,%bx
        push  %bp               // some BIOS may destroy BP
        int   $0x10
        pop   %bp
        ret
```

That is BIOS INT 10h AH=0x0E (Write Character TTY) — the canonical
teletype-output service. **`early_printk` therefore does not write to
0xB8000 directly; it goes through INT 10h.**

The setup-stage equivalent is `arch/i86/boot/setup.S:923-943`
(`putc`), which also uses INT 10h AH=0x0E (the `serial_output` branch
is dead code for the IBM PC `console=ttyS0` build):

```asm
.else
    mov $0x0E,%ah
    mov $7,%bx          // page 0
    int $0x10           // console out
.endif
```

So both the bootloader-side ELKS Setup banner and the kernel-side
pre-set_console printk traffic flow through INT 10h.

### 2. The `set_console` flow

`reference/elks/elks/kernel/printk.c:63-73`:

```c
void set_console(dev_t dev)
{
    struct tty *ttyp;
    if (dev == 0) dev = DEVCONSOLE;
    if ((ttyp = determine_tty(dev))) {
            kputc = ttyp->ops->conout;
            dev_console = dev;
    }
}
```

Called by the kernel after device init. With `console=ttyS0` in
`/bootopts`, `determine_tty` returns the ttyS0 tty struct, whose
`conout` is `rs_conout` (the serial driver's character-out routine).
After `set_console` returns, every `kputchar` call goes through
`rs_conout` → UART writeTHR → emu86 `UART16550.writeTHR` →
`onTransmit` callback → worker host `txBuffer`.

Bytes printed before `set_console` (the ELKS Setup banner, the
`ttyS0 3f8 irq 4 16550A` probe-success line, the "Direct console..."
boot line emitted by the *other* tty driver during its init, and a
few more) all arrive through `early_putchar` — i.e., INT 10h.

### 3. What does `BrowserConsole.writeChar` actually receive?

A new probe (now formalised at `tests/integration/early-printk.test.ts`)
boots the worker host for the first 2,000,000 instructions — well
before `set_console` fires — and collects `tx` postMessages. The
first ~1.4 KB of the stream (reproduced under "Summary" above)
contains the complete pre-`set_console` boot transcript: ELKS Setup
banner, ttyS0 probe-success, Direct-console init, xms/eth probes,
and the start of disk probing. Every byte arrived via
`BrowserConsole.writeChar` (no UART TX has happened yet at this
instruction count).

**`BrowserConsole.writeChar` is receiving early-printk bytes
correctly.**

### 4. What is the CGA mirror seeing?

The CGA mirror in the browser worker host is wired to a
`NullCGASink` (`src/browser/worker-host.ts:323`) — bytes hit
`writeByte(0xB8000+)` and are absorbed silently. We did not add a
capturing sink for this report because the BIOS path already
delivers the same content; instrumenting the framebuffer would
have shown duplicate content and risked confusing the diagnosis.

The Phase 7.1 cursor-aware mirror behaviour was independently
verified in the Phase 7 work; nothing in 9.1 changes its wiring.

### 5. Build-time / runtime config that routes `early_printk` to serial?

ELKS has `CONFIG_CONSOLE_SERIAL` (referenced in `printk.c:55-58`),
which makes `set_console`'s default device `/dev/ttyS0` instead of
`/dev/tty1`. It does not affect `early_putchar` — that is hardcoded
to INT 10h on IBM PC at the assembly level.

There is no `earlyprintk=` boot parameter in this ELKS branch.
Patching `early_putchar` itself to also poke 0x3F8 directly (the
"early-printk reaching serial" interpretation in the SERIAL_CONSOLE
report's deferral list) would require kernel rebuild — Outcome C —
and is unnecessary because the BIOS-console path already surfaces
the bytes.

### 6. Does the Node serial harness see early-printk via stdout?

Yes — captured live by running
`npm run start:elks-serial` against
`reference/elks-images-serial/fd1440-fat-serial.img` and exiting
with `Ctrl-A x` after the `# ` prompt:

```
[2J[Hemu86 — ELKS over serial console
Image: reference/elks-images-serial/fd1440-fat-serial.img
Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A
Booting...

ELKS..............................................................................................................................................................................................................................
ELKS Setup ....L076EC34H01S0D Ht0330 f122A d19F2 INT f002 START
ttyS0 3f8 irq 4 16550A
Direct console, scan kbd 80x25 emulating ANSI (2 virtual consoles)
xms: 34816K, disabled, A20 error. 64K ext buffers, 8K cache, 15 req hdrs
...
boot: BIOS drive 0, root device /dev/fd0 (0320)
PC/XT class cpu 2, syscaps 0, 640K base ram, 16 tasks, 64 files, 96 inodes
ELKS 0.9.0 (61344 text, 31872 ftext, 10240 data, 8128 bss, 47166 heap)
Kernel text 330 ftext 122a init 17a4 data 19f2 end 29f2 top a000 472+9+0K free
fd0: ELKS bootable, has 80 cylinders, 2 heads, and 18 sectors
FAT: me=f0,csz=1,#f=2,floc=1,fsz=9,rloc=19,#d=224,dloc=33,#s=2,880,ts=0
FAT: total 1440k, fat12 format
VFS: Mounted root device /dev/fd0 (0320) msdos filesystem.
# 
[emu86] quit — exiting.
```

The first three boot-output lines come from `early_putchar` →
INT 10h → `NodeConsole.writeChar` → stdout. The rest come from the
UART TX path. Both terminate at stdout in the Node harness. **No
regression** in the Node side from Phase 9.1 changes.

## Implementation

### What changed

- `tests/integration/early-printk.test.ts` *(new, 2 cases)*: asserts
  the early-printk content lands in `tx` messages within the first
  2,000,000 instructions, and that the boundary between the BIOS
  console path and the UART path produces no double-print. Replaces
  the temporary diagnostic probe used during diagnosis (the probe
  is gone; the assertion-based file took its name).
- `tests/unit/worker-host-tx-wiring.test.ts` *(new, 4 cases)*: pins
  down the WorkerHost invariant that both UART TX and BrowserConsole
  `writeChar` push to the same shared `txBuffer` and flush as one
  `tx` postMessage per batch. Cases cover interleaving, coalescing,
  the no-bytes-no-message contract, and reset-clears-the-buffer.
- `web/main.ts`: removed the welcome-line warning about a
  "few seconds … will produce no output" — the wiring delivers
  early-printk bytes immediately, so the warning was both wrong and
  user-confusing. Updated the module docstring to point at the
  actual wiring path.

### What did *not* change

- `src/browser/worker-host.ts` — the txBuffer wiring is already
  correct (lines 306-308: `BrowserConsole({ txSink: (b) =>
  this.#txBuffer.push(b) })`).
- `src/browser/browser-console.ts` — the `writeChar`→`txSink` path
  is the contract the new unit tests exercise.
- `src/diagnostics/cga-mirror.ts` — left as-is. A CGA→TX bridge
  would double-print across the BIOS→UART boundary and is not
  needed.
- `tools/elks/run-serial.ts` — Node side's NodeConsole already
  prints early-printk to stdout; the new integration test confirms
  the worker host has the equivalent path. No regression.
- All locked directories per the brief (`src/cpu8086/`,
  `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`,
  `src/timing/`, `src/devices/`, `src/console/`, `src/disk/`,
  `src/bios/`, `src/host-clock/`, `src/diagnostics/`,
  `src/machine/ibm-pc.ts`).

## Outcome verification

### Before / after capture of the first 500 ms of boot output

There is no "before" in source terms — Phase 9 already wired
`BrowserConsole.writeChar` to the TX channel. The new integration
test asserts the *current* observable output:

**Captured TX bytes within the first 2,000,000 instructions
(autoRun=false, runUntil), readable subset:**

```
ELKS..............................................................................................................................................................................................................................\r\n
ELKS Setup ....L076EC34H01S0D Ht0330 f122A d19F2 INT f002 START\r\n
ttyS0 3f8 irq 4 16550A\r\n
Direct console, scan kbd 80x25 emulating ANSI (2 virtual consoles)\r\n
xms: 34816K, disabled, A20 error. 64K ext buffers, 8K cache, 15 req hdrs\r\n
eth: ne0 at 300, irq 12 not found\r\n
eth: wd0 at 0x240, irq 2, ram 0xce00 not found\r\n
eth: 3c0 at 330, irq 11 not found\r\n
```

29 `tx` postMessages, 1,391 bytes total — average 48 bytes per
message, comfortably above the brief's "more than 5 bytes per
message" coalescing requirement.

The integration test's positive assertions:

- `tx` contains `'ELKS Setup'` (bootloader banner via INT 10h).
- `tx` contains `'ttyS0 3f8 irq 4 16550A'` (kernel's pre-set_console
  ttyS0 probe success, also via INT 10h).
- `(txTotalBytes / txMessageCount) > 5` (coalescing intact).

The integration test's no-double-print assertion (full 8M boot):

- `'ttyS0 3f8 irq 4 16550A'` appears exactly once across the boot
  (it is emitted only via the BIOS path).
- `'VFS: Mounted root device'` appears exactly once across the
  boot (it is emitted only via the UART path).

### Node-side regression check

Captured live (full transcript reproduced under §6 above):

```
$ npm run start:elks-serial
...
ELKS Setup ....L076EC34H01S0D Ht0330 f122A d19F2 INT f002 START
ttyS0 3f8 irq 4 16550A
...
VFS: Mounted root device /dev/fd0 (0320) msdos filesystem.
# 
```

Early-printk arrives via stdout exactly as in Phase 8. No regression.

## What's deferred

- **CGA-canvas renderer for graphics-mode guests.** Out of scope per
  the brief. A graphics-mode browser display is a future brief.
- **`earlyprintk=ttyS0` kernel reroute (Outcome C).** Not needed; the
  BIOS path already covers the bytes. Could still be done one day
  for purity (single output path from instruction zero), but
  requires the ia16-gcc / dev86 toolchain that this environment
  doesn't carry.
- **Image upload + settings UI.** Explicitly the next brief per the
  user's direction. Captured in the next section.
- **Snapshot / restore.** Different brief.

## Things future briefs should address

- **Image upload + settings UI** (next brief). User scope already
  captured: font size + theme + image URL config; image upload
  semantics TBD between session-local and IDB-persisted. The browser
  harness currently hardcodes `/elks-serial.img` in `web/main.ts`;
  a settings panel would let the user pick a custom URL or upload a
  floppy from disk. Out of scope here.
- **CGA-canvas renderer for graphics-mode guests.** Real-mode VGA
  text + graphics output would unlock running guests other than the
  serial-console ELKS build. Adjacent to the Phase 7.1 cursor-aware
  mirror but a different display abstraction.
- **Network device.** A NE2000 or virtio-net surface in the browser
  would let guest ELKS reach the network through a fetch-backed
  bridge. Substantial.
- **Snapshot / restore.** Persist machine state to IDB so the user
  doesn't reboot on every page reload. The IDB page store from
  Phase 6 is the right substrate.

## CPU/memory bug candidates

None observed. The diagnosis only ran the boot, no instrumentation
poked the CPU or memory beyond the existing CGA mirror's `writeByte`
overlay (which is unchanged).

## Release snapshot

```
releases/phase-9-1-early-printk/
├── README.md                    # launch commands
├── package.json                 # copy of root manifest
├── package-lock.json            # copy of root lockfile
├── dist-cli/                    # compiled Node CLI tools
│   └── tools/elks/{run.js, run-serial.js}
├── dist-web/                    # Vite production bundle
│   ├── index.html
│   ├── elks-serial.img          # 1.44 MB floppy fetched at boot
│   └── assets/{index,worker}-*.js
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied. The release shares the repo root's
installed dependencies.

### Manual launch verification

**Node serial harness from inside the snapshot:**

```
$ cd releases/phase-9-1-early-printk
$ node dist-cli/tools/elks/run-serial.js
[2J[Hemu86 — ELKS over serial console
Image: reference/elks-images-serial/fd1440-fat-serial.img
Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A
Booting...

ELKS..............................................................................................................................................................................................................................
ELKS Setup ....L076EC34H01S0D Ht0330 f122A d19F2 INT f002 START
ttyS0 3f8 irq 4 16550A
Direct console, scan kbd 80x25 emulating ANSI (2 virtual consoles)
... (boot continues to # prompt) ...
```

The ELKS Setup banner appears in the very first lines, confirming
the early-printk path is intact in the snapshot.

**Browser harness via vite preview from inside the snapshot:**

```
$ cd releases/phase-9-1-early-printk
$ npx vite preview --outDir dist-web --port 4173
  ➜  Local:   http://localhost:4173/
$ curl -s -o /dev/null -w "%{http_code}, %{size_download}\n" http://localhost:4173/
200, 637
$ curl -s -o /dev/null -w "%{http_code}, %{size_download}\n" http://localhost:4173/elks-serial.img
200, 1474560
```

`index.html` (637 bytes) and `elks-serial.img` (1.44 MB) both serve
with HTTP 200 from the snapshot's `dist-web/`. Open
`http://localhost:4173/` in a browser; the ELKS Setup banner
streams into xterm.js as soon as the worker boots, with no
multi-second blank window.

## Verification

```
$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean — no output)
```

```
$ npx vitest run
 Test Files  55 passed (55)
      Tests  1135 passed (1135)
   Duration  148.08s
```

Of the 1,135 tests:

- 6 are new in Phase 9.1 (4 unit + 2 integration).
- 323 are SST corpus tests.
- 806 are the prior pre-corpus suite — matches the brief's "806
  passing without corpus" baseline plus the 6 new cases.

```
$ npm run start:elks-serial   # then Ctrl-A x at the # prompt
ELKS Setup ....L076EC34H01S0D Ht0330 f122A d19F2 INT f002 START
ttyS0 3f8 irq 4 16550A
... boot continues ...
# 
[emu86] quit — exiting.
```

Node serial harness shows the full boot transcript including
early-printk content; no regression from Phase 8/9 behaviour.
