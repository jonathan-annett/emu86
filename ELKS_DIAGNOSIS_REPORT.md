# ELKS Diagnosis Report (Phase 5)

## Summary

Phase 4 ended with ELKS booting through PS/2/A20 setup, programming its IDT,
servicing exactly **one** IRQ 0, printing `"INT f002 START\n"`, and HLTing
forever at `0330:7e2f`. The brief asked: *what is actually happening*.

Diagnosis answer (one sentence): **our BIOS never programmed the 8259's
vector base, so the first hardware IRQ landed on `INT 0` — which ELKS's IDT
treats as the divide-error trap — and the kernel's `_irqit` dispatcher
correctly skipped EOI for a "trap", but no EOI meant no further IRQs, and
without timer ticks the kernel sat in its idle `HLT` loop forever.**

The fix was a 20-byte ICW1/ICW2/ICW3/ICW4/IMR sequence added to the BIOS
ROM init code. After the fix:

| metric                       | before fix          | after fix           |
| ---------------------------- | ------------------- | ------------------- |
| run reason                   | `halt-spin-exhausted` at idx 107917 | `instruction-limit` at 1,000,000 |
| `intService` events (IRQ 0)  | 1                   | 19                  |
| OUTs to PIC EOI port (0x20)  | 0                   | 19                  |
| INT 10h calls observed       | 39                  | 60                  |
| final state                  | `halted=true` at 0330:7e2f | `halted=false`, kernel running at 122a:4002 |

No CPU/memory/PIC/PIT changes were required. All 1028 tests still pass
(700 unit + 5 integration + 323 SST corpus, plus the bios-rom and
elks-boot-phase4 suites).

---

## Phase A: diagnosis

### Q1 — what does `"INT f002 START\n"` mean?

It is **not** a panic. It is two intentional `printk` calls from
`elks/init/main.c` that print FLAGS at boot:

```c
/* simplified — see init/main.c kernel_init() */
printk("INT %x ", flags);   /* flags is the saved FLAGS register */
printk("START\n");
```

Evidence — the format strings live verbatim in the kernel data segment.
With CS=0330 (text), DS=19F2 (data), the segment 122A is the kernel
fartext segment (where compiled-in initializer code goes). The diagnostic
probe dumped the kernel data segment (Section 6) and the strings
`"INT %x "` and `"START\n"` appear at offsets 0x7eab and 0x7eb5
respectively, alongside the rest of the boot-options string table:

```
122a:7ea0  ... 'f' 'o' 'r' 'm' 'a' 't' '/' 's' 'i' 'z' 'e' \n 0  'I' 'N' 'T'
122a:7eb0  ' ' '%' 'x' ' ' 0    'S' 'T' 'A' 'R' 'T' \n 0   'N' 'o' ' ' 't'
```

The earlier `"H"` / `"t0330 f122A d19F2"` portion of the console output
comes from `elks/arch/i86/boot/setup.S`'s debug print that dumps the
kernel's CS / fartext / data segments after relocation. So the full line

```
ELKS Setup .........FHt0330 f122A d19F2 INT f002 START
```

decodes as: setup-stage debug (`FH`, then `t<text> f<fartext> d<data>`),
followed by the kernel's first two `printk`s. FLAGS = 0xF002 is the normal
post-boot value (reserved bits set, all others clear) — not a panic flag.

**Conclusion: the kernel is healthy here. The print is a deliberate
"hello world" from `kernel_init()`.**

### Q2 — what did ELKS install in the IDT?

Section 1 (final IDT) plus Section 2 (per-write trace) show the kernel
touches **only five vectors**: 0x00, 0x02, 0x08, 0x09, and 0x80. Every
other vector keeps the BIOS-installed IRET stub at `F000:10NN`.

| Vec | Final CS:IP | Linear | Kernel role |
|-----|-------------|--------|-------------|
| 0x00 | `19f2:3e1a` | `0x1dd3a` | divide-error |
| 0x02 | `19f2:3e20` | `0x1dd40` | NMI |
| 0x08 | `19f2:3db4` | `0x1dcd4` | timer (IRQ 0 entry once PIC is remapped to base 0x08) |
| 0x09 | `19f2:3dba` | `0x1dcda` | keyboard (IRQ 1 entry once PIC is remapped) |
| 0x80 | `19f2:3e14` | `0x1dd34` | syscall trap |

Each of those five "kernel handlers" is **not** the real `_irqit`
function. Each is a tiny **CALLF thunk table** that lives in the kernel's
data segment (`19F2`), and Section 5d shows the pattern:

```
1dcd4 (IDT[0x08]):  9a 2f 7d 30 03 00   9a 2f 7d 30 03 01 ...
                    ^^ CALLF 0330:7d2f  ^^ trailing-byte = IRQ idx (0)
1dcda (IDT[0x09]):  9a 2f 7d 30 03 01   ...
                                     ^^ trailing-byte = IRQ idx (1)
1dd3a (IDT[0x00]):  9a 2f 7d 30 03 11   ...
                                     ^^ trailing-byte = IDX_DIV (17)
1dd34 (IDT[0x80]):  9a 2f 7d 30 03 10   ...
                                     ^^ trailing-byte = IDX_SYSCALL (16)
```

So every CALLF lands at `0330:7d2f` — the real `_irqit` dispatcher in
`elks/arch/i86/kernel/irqtab.S` — and `_irqit` reads the byte after the
CALLF (via `MOV AL,[DI]` at 0330:7d7a) to recover the index.

The convention from `irqtab.S`:

```asm
do_IRQ_call:                  ; _irqit dispatcher epilogue
    cmp $16, %ax              ; ax = idx loaded from byte after CALLF
    jge was_trap              ; idx >= 16 → trap, skip EOI
    ; ... do_IRQ then do_eoi (OUT 0x20, AL=0x20)
```

That last detail is the one that matters for Q4.

### Q3 — is the HLT terminal or expectant?

**Expectant.** It is the kernel's `idle_halt()` loop.

The HLT before the fix was at `0330:7e2f`. Disassembling the bytes around
that site (Section 6 of the pre-fix run):

```
0330:7e2c  89 e0     MOV  AX, SP
0330:7e2e  c3        RET
0330:7e2f  f4        HLT
0330:7e30  c3        RET
```

The `HLT` is preceded by a tiny `idle_halt()`-style helper (`MOV AX,SP;
RET`) and followed by an immediate `RET`. The function is called from
the scheduler; on return the scheduler re-checks runqueue + IF and either
schedules a task or loops back to halt again. This is the generic ELKS
idle loop. With IF=1 and the PIC's ISR stuck (no EOI ever issued), the
HLT could never wake — so the loop was idle but **starved**, not
panicked.

After the fix, the IDLE/HLT path still gets entered between timer ticks,
but each tick now fires an IRQ that wakes the HLT, the scheduler runs,
and execution continues.

### Q4 — what did the one IRQ 0 actually do? (root cause)

The one IRQ in the pre-fix run:

1. **Delivered through `INT 0`** — not `INT 8`. Our `Pic.vectorBase`
   defaults to 0 (see `src/devices/pic.ts:reset()`), and nothing had
   programmed it before the IRQ fired. Real PC BIOS programs `vectorBase
   = 0x08` via ICW2 during POST; we never did.
2. **Hit IDT[0x00]** — the kernel's divide-error thunk:
   `CALLF 0330:7d2f ; trailing-byte 0x11 (IDX_DIV)`.
3. **`_irqit` correctly classified it as a trap** — the byte after the
   CALLF was `0x11` (`IDX_DIV` = 17), and `cmp $16, %ax / jge was_trap`
   sent the dispatcher down the trap path that **skips `do_eoi`**.
4. **No EOI was ever issued to port 0x20** — confirmed in pre-fix
   Section 5b: `port=0020 in=0 out=0`.
5. **PIC ISR stuck on IRQ 0 forever** — every subsequent timer tick was
   suppressed by the in-service bit, and the kernel's idle HLT had no
   way to wake.

The trace evidence at idx 83179 of the pre-fix run was the smoking gun:
inside `_irqit`, the `MOV AL,[DI]` that loads the trailing index byte
returned `AL = 0x11`, not `0x00`. Confirmed via memory dump (`19f2:3e1f`
contains 0x11 because IDT[0x00] is the divide-error thunk slot).

**Root cause: missing PIC vector-base programming in our BIOS.** The PIC,
the IDT, the kernel dispatcher, and the EOI logic all behaved correctly;
they simply disagreed about which IDT slot a hardware IRQ should land on.

---

## Phase B: implementation

### Fix: BIOS ICW1..ICW4 + IMR programming

Added 20 bytes to `src/bios/bios-rom.ts` between BDA setup and the
stack/INT 19h section:

```asm
MOV AL, 0x11    ; ICW1 — ICW4 needed, cascade, edge-triggered
OUT 0x20, AL    ; PIC1 cmd
MOV AL, 0x08    ; ICW2 — vector base = 0x08 (so IRQ 0..7 → INT 8..15)
OUT 0x21, AL    ; PIC1 data
MOV AL, 0x04    ; ICW3 — slave on IRQ 2 (informational; no slave wired)
OUT 0x21, AL
MOV AL, 0x01    ; ICW4 — 8086 mode, normal EOI
OUT 0x21, AL
MOV AL, 0xFF    ; mask all IRQs at boot; OS will unmask what it wants
OUT 0x21, AL
```

This emulates real PC BIOS POST behavior. It is the minimum change that
makes the existing PIC device's `vectorBase` field non-zero before the
guest OS unmasks any IRQs.

### Fixes considered but NOT taken

- **Slave PIC stub at 0xA0/0xA1.** Brief pre-authorized this if Q4
  showed EOI to 0xA0. It does not — Section 5c shows all 19 EOIs go to
  port 0x20 (master). No slave stub needed yet.
- **DMA stubs at 0x00–0x1F / 0xC0–0xDF.** Section 5b shows
  882 OUTs to port 0x00 and 882 to port 0x01, but those are all the
  CRTC DMA-controller-style programming pattern emitted by setup.S,
  and our open-bus accept-and-ignore handles them correctly (kernel
  proceeds without ever reading back). No DMA stubs needed yet.
- **Patching IDT[0x00]/IDT[0x10..0x17].** The brief explicitly forbids
  modifying the kernel image, and the diagnosis showed there is nothing
  to patch — the kernel installed exactly what it intended; the BIOS was
  the only piece behaving wrong.

### Phase C: re-run results

Same probe (`tests/integration/diag-probe.ts fd1440-minix.img 1000000`)
with the fix in place. Key deltas (full output: `diag-out.txt`):

```
RunResult: {"executed":1000000,"reason":"instruction-limit"}
Counts:    {"instruction":985772,"int":70,"trap":70,"io":14025,
            "memWrite":44,"intService":19}
Final CPU: CS:IP = 122a:4002, halted=false, IF=true
```

What changed:

- **Run reaches the 1M-instruction cap** — no more spin-halt exhaustion.
- **19 IRQs serviced** (~1 per 47k–48k instructions, matching the kernel's
  programmed PIT cadence). Section 5c shows all 19 EOIs.
- **IRQ 0 now lands on IDT[0x08]** (Section 5a confirmed at intService
  time; trace at idx 83180 shows `MOV AL,[DI]` returning `AL=0x00`
  instead of 0x11 — IDX 0 = IRQ 0).
- **Console grew** to include the kernel's directly-issued INT 10h
  prints from `0330:004c` ("INT" "START\n" sequence — the kernel is
  printing past `printk("START\n")` into bootopts parsing, where it
  errors with "/bootopts not found or bad format/size").
- **Final CPU at `122a:4002`** is in fartext, executing
  `PUSHF / CLI / MOV AX,[37a6] / ...` — looks like the
  `idle_halt()` re-entry code, which means the kernel is now
  cycling between work and halt as expected. Not stuck.

### What we still don't see

The kernel is making progress but has not yet mounted root or printed the
distinctive `"Mounted root device"` banner. Reasons (none of which were in
this brief's scope):

- **Floppy I/O** is INT 13h (BIOS) — and the kernel's last INT 13h calls
  in Section 3 (`from=0330:d857 AX=0800`) are *Get Disk Parameters*
  calls, not READ_SECTORS. So the kernel hasn't yet tried to read root
  data; it's still in init-time discovery. With more cycles it likely
  will.
- **Keyboard input** (IRQ 1 / port 0x60) — the kernel only services IRQ
  0 in the trace; IRQ 1 may be unmasked but no key events arrive in our
  emulator. ELKS init shouldn't need keys to mount root.
- **Slave PIC cascade IRQs** — never triggered in this run; brief was
  right to make the slave stub conditional.

---

## Things future briefs should address

1. **Run further than 1M instructions** to see whether the kernel
   actually reaches the root-mount banner. The brief's diagnostic loop
   stopped at 1M, but the kernel is no longer stuck. A simple bump in the
   instruction cap (or a longer integration test) is the next step.
2. **Floppy READ_SECTORS path through INT 13h.** Once the kernel tries to
   load the root filesystem, it will exercise our BIOS disk read handler
   in earnest. Phase 4 stubbed it; needs validation under real load.
3. **`/bootopts not found or bad format/size` message** appears in the
   data segment. The kernel may print this before mounting root, which
   would indicate the kernel is searching the floppy for a `bootopts`
   file. That is a content-of-floppy issue, not an emulator bug, but
   worth noting.
4. **Slave PIC stub** is *still* pre-authorized in spirit; if a future
   brief enables a device that asserts an IRQ on the slave, add the stub
   then.
5. **DMA stubs**: same — not needed yet, add when something actually
   programs DMA for a real transfer (likely floppy DMA when
   READ_SECTORS happens, depending on whether ELKS uses BIOS or its own
   floppy driver in this build).

## CPU / memory bug candidates

None observed. The 1M-instruction post-fix run shows no anomalies — every
IRQ services cleanly, FLAGS evolve sensibly, the corpus is unaffected.
The original PIC device's behavior (vectorBase, ISR, EOI handling) was
all correct; the bug was strictly in BIOS init code (a missing piece, not
a wrong piece).

## Verification

```
$ npx tsc -p tsconfig.cli.json
# clean (no diagnostics)

$ node dist-cli/tests/integration/diag-probe.js fd1440-minix.img 1000000 > diag-out.txt 2>&1
# exit=0; diag-out.txt has 5781 lines

$ npm test
# Test Files  44 passed (44)
#      Tests  1028 passed (1028)
#   Duration  250.93s
```

All 1028 tests green. Phase 4's `tests/integration/elks-boot-phase4.test.ts`
still passes (the BIOS PIC init is invisible to anything that doesn't
inspect the PIC's vectorBase — and the existing
`tests/unit/cpu-pic-integration.test.ts` and
`tests/unit/cpu-pit-pic-integration.test.ts` unit tests already program
the PIC explicitly, so they didn't depend on the default vectorBase=0).

## Files changed

- `src/bios/bios-rom.ts` — added 20-byte 8259 init block to the BIOS init
  code (`+24 lines incl. comment block`). Init code length grew from ~111
  to ~131 bytes; well within the brief's ~200-byte budget.
- `tests/integration/diag-probe.ts` — added Sections 5a/5b/5c/5d during
  Phase A (IDT-at-svc-time, all-IO-by-port, EOI-port outs, IDT-handler
  bytes). These are pure diagnostics; not wired into any test suite.

No changes under `src/cpu8086/`, `src/memory/`, `src/runtime/`,
`src/interrupts/`, `src/io/`, `src/timing/`, or any existing device.
