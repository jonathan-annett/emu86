# emu86 — Project History

**Status**: Mature. ELKS (Linux for 8086) boots in Node and browser
harnesses, floppy and hard-disk images, FAT and MINIX, partitionless
and MBR-partitioned, single and multi-disk. Browser harness ships
xterm.js + Web Worker + IndexedDB persistence + GitHub release
browser. ~1,294 unit + integration tests + 323 SST corpus files
(~3M cases) all green. Strict TypeScript, no escape hatches, no
custom CPU opcodes, no architectural debt accumulated across 20+
phases.

**Last updated**: post-Phase 13, with Phase 12.1 / 13.1 in flight
(probe-harness boot-budget extension; report not yet landed when
this was written).

This document is the project's narrative chronicle. It tells the
story of how things were built, why specific decisions were made,
and which patterns emerged through repetition. It complements but
doesn't replace:

- `emu86-handover-brief-v4.md` — the active orientation document
  for a new planning instance.
- `emu86-INDEX.md` — the flat catalogue of every brief and report.
- `emu86-networking-plan.md` — agreed shape for the networking
  arc (Phase 14+).
- The reports themselves — immutable per-phase findings.

Read this file when you want the *why*. Read the briefs and reports
when you want the *what*.

---

## Project identity

emu86 is a TypeScript x86 CPU emulator framework targeted at modern
browsers. **Pure TypeScript on the JS VM, not WebAssembly.** Designed
as a layered framework so the same CPU core can be embedded in
multiple machine configurations.

**Roadmap (long-term)**: 8086 → 80286 real mode. Beyond that (286
protected mode, 386+) deferred. The 80286 work has not been started;
all current work targets 8086 / IBM PC.

**Reference model**: Adrian Cable's [8086tiny](https://github.com/adriancable/8086tiny) —
used as a per-opcode semantics reference and a BIOS-contract reference,
not a structural template. Its dense macro-heavy C is the opposite of
what we want code-shape-wise; we consult it for "what does the silicon
actually do here," then write it our way.

**Testing backbone**: [SingleStepTests/8088](https://github.com/SingleStepTests/8088) —
JSON per-instruction state-in/state-out tests. We run **v2** of the
corpus (gzipped, sparse `final` deltas, with `v2_undefined/` for
documented-undefined flag bits). 8086 and 8088 are functionally
identical at the instruction-semantics level; they differ only in
bus width / prefetch queue.

**Top-level identity**: A *browser-oriented x86 emulator framework*.
The North Star — open a URL, see ELKS boot — was reached at Phase 9.
Every phase since has either polished that experience, expanded its
substrate, or built tooling for future investigation arcs.

---

## Architecture (current state)

```
Machine = IBMPCMachine
 ├─ CPU = CPU8086              sync per-instruction; pure state machine
 │   ├─ Registers              AX/AH/AL aliasing via Uint8/Uint16Array views
 │   ├─ Flags                  bit-level + raw access; reserved bits enforced
 │   ├─ Decoder/Exec           256-entry opcode dispatch table; opcodes split
 │   │                         across self-registering files; full 8086 ISA
 │   └─ TrapRegistry           CS:IP linear → JS handler; consulted at top
 │                             of step() for BIOS service traps
 ├─ Memory = PagedMemory
 │   ├─ Map<pageId,slab>       resident working set, always in RAM
 │   ├─ readonly slab flag     ROM regions for the BIOS image
 │   ├─ dirty Set              tracked for lazy persistence
 │   └─ PageStore              pluggable: InMemoryPageStore (Node tests) |
 │                             IndexedDBPageStore (browser persistence)
 ├─ InterruptController        async-source → CPU interrupt path; INTR + NMI
 │                             intake; CPU consults at instruction boundaries
 ├─ IOBus = BasicIOBus         port-handler registration; CPU IN/OUT routes
 │                             through; unregistered ports = open bus (0xFF)
 ├─ Devices                    PIC8259, PIT8254, KeyboardController8042,
 │                             UART16550 — all PortHandler implementers
 ├─ Console                    Console interface; Node/in-memory/browser impls
 ├─ Disk                       sector-level R/W + geometry; supports both
 │                             primary and (optional) secondary slot for
 │                             multi-disk machines; Node-file + in-memory
 ├─ HostClock                  for INT 1Ah RTC
 ├─ Clock = virtual            cycle-count clock; subscriptions; advanced by
 │                             RunLoop after each batch
 ├─ Diagnostics                Tracer, CGA mirror, instrumentation overlays,
 │                             stuck-loop detector, periodic console dump
 ├─ BIOS                       generated 64 KiB ROM image at F000:0000;
 │                             TS-native handlers via TrapRegistry
 └─ RunLoop                    async batched loop around sync cpu.step()
                               yields between batches; HLT-aware (advances
                               clock during halt-spin so timers fire)
```

**Threading model**: single-threaded, single-core from the CPU's
perspective. The async run loop yields between batches so timer
callbacks, write-back persistence, and async-sourced interrupts (PIT
ticks via Clock subscription, keyboard scancodes, UART RX) execute
between instruction batches.

**Browser deployment**: the entire emulator lives in a Web Worker.
The main thread hosts xterm.js (via UART TX/RX) and the settings UI.
The IDB page store, the worker host, the message protocol, and the
Vite build are all in `src/browser/` and `web/`. The CPU, memory, and
all devices are agnostic about whether they're running in Node or the
browser; the only browser-specific code is at the worker host /
console / disk-loading boundary.

---

## Key design decisions (load-bearing across the project)

These have held across 20+ phases. Future agents should not silently
relax them — ask if revisiting. Each was either user-confirmed at
inception or has been honoured through every brief since.

### 1. CPU step is pure synchronous

The CPU runs one instruction synchronously. No awaits inside `step()`,
no exceptions across async boundaries. Async concerns (persistence,
interrupt sources, timer drivers, browser worker hosting) live above
the CPU.

**Why it matters**: this single rule has paid off repeatedly. The
SST corpus (3M cases) depends on it. Determinism in tests depends
on it. The Web Worker can host the loop without the loop needing
worker-aware code. Snapshot/restore (eventually) will be tractable
because there's no in-flight async state to capture.

**Pressure tested**: every brief reasserts this rule. Several agents
have found themselves wanting to make it async (especially around
disk reads in `INT 13h`, where a real BIOS would block) and have
correctly stopped to ask. The answer has always been: keep it sync,
make the host side wait if necessary.

### 2. The CPU sees only `Memory` (an interface)

`PagedMemory`-specific concepts (pages, dirty bits, persistence,
ROM regions) don't leak into the CPU. The CPU works against any
`Memory` implementation. This made it possible to add ROM region
support in Phase 1 (BIOS infrastructure) without touching `cpu.ts`
at all — the slab gained a `readonly` flag and the write path's hot
loop checks it; the CPU is unaware.

### 3. Synchronous cache layer + async write-behind for memory

The user's instinct, in session 1: "synchronous cache layer via a
Map, with a lazy write-behind worker." This collapsed a complex
fault-and-retry memory model into a much simpler one. All currently-
in-use pages live in a Map; pages never evict; an async loop drains
dirty pages to the `PageStore` on an interval.

The "clear-then-snapshot" pattern keeps it race-free even when the
CPU writes during an in-flight flush. **This was Brief 3's IDB
load-bearing test**: write through PagedMemory + flush + construct a
fresh PagedMemory on the same store + hydrate + verify data survived.
Green from day one.

### 4. No custom CPU opcodes, ever

8086tiny uses four custom opcodes (`0F 00`–`0F 03`) for host calls
(putchar, RTC, disk I/O). **We do not.** The Phase 2 brief
(BIOS services) considered this and explicitly rejected it. Instead:
TypeScript handlers in a TrapRegistry, consulted at the top of
`step()`, dispatched by linear CS:IP address.

**Why it matters**: the SST corpus is the project's empirical truth.
A custom opcode would be one the corpus can't validate. The
discipline of "every opcode our CPU sees comes from real 8086 silicon"
keeps the corpus's certifications meaningful.

This was a near-miss. Phase 2's first instinct was the 8086tiny
shape; the agent and human together reasoned it out and chose the
trap mechanism. Documented in `BIOS_SERVICES_REPORT.md`.

### 5. Layers compose; they don't know about each other

PIC doesn't know about InterruptController's callers. PIT doesn't
know about PIC. UART, keyboard, and disk all follow this pattern.
The Machine is the only place wiring happens. This means a future
NE2000 device can be added without touching anything except the
Machine wiring; a future cascaded-PIC slave can be added without
touching the master PIC.

### 6. Determinism over realism in tests

No `Date.now()`, no `setInterval`, no real timers in unit tests.
Virtual `Clock` advances when the run loop tells it to. **A pattern
that emerged at Phase 10.1**: when a test needs the *host* clock to
appear to advance (for the MBR's auto-boot timeout), use a local
`AutoAdvanceHostClock` in the test. Substrate determinism is
sacred; test-side workarounds are fine.

### 7. Memory always resident, never faults

Persistence (writeback to IDB) is async, separate from access. The
CPU never sees a memory fault. ROM regions silently drop writes,
matching real-bus behavior. Given our address spaces (1 MiB for
8086, 16 MiB for 286-real) this fits comfortably in any browser
tab.

### 8. Authentic emulation over convenience

When the user has had to choose between authentic and convenient
emulation, they have consistently chosen authentic. Phase 10.1 made
this explicit: ELKS's bundled MBR boot manager runs as real PC code
("authentic chain-load"), even though "virtual-shift" translation
would skip the ~3-second boot timeout. A user toggle for the
convenience path is on the deferred list.

The networking plan reflects the same posture: real(ish) ethernet
networking via a virtual switch, with `webget` over a second UART
explicitly labelled as a non-authentic exception only for HTTPS
(which is structurally impossible to emulate from the browser).

### 9. Strict TypeScript stays strict

No `any`, no `as unknown as`, no `// @ts-ignore`. Every brief
reinforces this; every report confirms it stayed strict. The
`noUncheckedIndexedAccess` setting has been load-bearing — it's
caught real bugs more than once and forces explicit handling at
boundaries.

### 10. Tests are the primary documentation

Reports are the durable record; the per-phase report file at the
project root is the canonical statement of what changed and why.
Reading test names in vitest output is intended to teach the system.
This is a stated principle, not a slogan: every test gets a
descriptive name, and tests are organised by what they exercise
rather than by code structure.

### 11. Headless correctness before live demo

This was the v0 user-confirmed call: don't put a UI on the CPU
before the CPU passes SST. Reasoning: a hidden CPU bug under a
pretty canvas creates the worst debugging experience — two suspects
for every failure. The discipline held all the way through Phase 8
before any browser-visible work started; by Phase 9 the substrate
was so solid that the browser harness was almost pure plumbing.

### 12. Evidence over speculation

Phase 5 made this explicit: don't grab-bag stubs hoping one will
fix it. Diagnose first; implement only what the evidence demands.
Phase 5 itself, Phase 8, Phase 9.3, and Phase 10.1 are the canonical
examples. Phase 10.1 is particularly clean — the diagnosis was the
work; no implementation was needed because the substrate already
handled it.

---

## The arc

### Session 1 — v0 scaffolded

Where this document started. Foundation + paged memory + CPU
skeleton + 6 opcodes (NOP, HLT, MOV r8/r16 imm, JMP short, ADD
AL/AX imm) + run loop + SST harness skeleton. Tests for registers
and flags written but not yet run. **No tests had executed.**

This was the architectural session. Decisions made here:

- Pure-sync CPU, async run loop, SingleStepTests as validation gate
- Synchronous Map cache + async write-behind (the user's collapse)
- Hooks-only eviction (no automatic policy)
- Pre-warm hydrate from store on init
- Register aliasing via shared `ArrayBuffer` (host LE assumption)
- 4 KiB pages, pluggable `PageStore`
- Flat opcode dispatch table

The v0 scaffold landed packaged as `emu86-v0.zip`. First action
next session was `npm test`.

### Brief 1 — full 8086 instruction set

Took the project from 6 opcodes to a complete 8086 ISA. The brief
deliberately excluded SST corpus wiring (better to add it after
enough opcodes existed to test something meaningful). The agent
made one structural improvement we kept: opcode files split per
group, self-registering into `OPCODE_TABLE` via side-effect imports.
No central dispatch table to keep in sync; each `opcodes-*.ts` file
owns its own slice.

Test count: 245 → 353. Bugs caught during implementation: SHL OF
flag (MSB of result XOR CF, not MSB of operand); IMUL r/m16 sign
extension (`Math.trunc` returns 0 for negative products in
(-65536, 0); fixed with `Math.floor` plus positive-modulo); DIV
test programs collided with the IVT at linear 0; refactoring
`DivideError` into `serviceInterrupt(cpu, 0)` to match real
hardware.

`serviceInterrupt(cpu, vec)` emerged here as the single source of
truth for the push-flags / clear-IF / clear-TF / push-CS / push-IP /
load-vector dance. Used by INT*, INTO, and DIV/IDIV/AAM error paths.
This was an unprompted-but-correct factoring; it became the reference
for all future interrupt-related work.

### Brief 2 — SST corpus validation

The empirical truth check. The brief structured failures into four
buckets (real bug, mask-worthy undefined flag, hardware quirk,
harness bug) so the agent had a taxonomy to triage by.

The agent paused mid-clone to ask about v1 vs v2 of the corpus —
the corpus author's README recommends v2; v2 has better undefined-
flag handling via `v2_undefined/`. User picked v2 plus a gzip-aware
loader. Right call.

**Headline: 3,007,000 / 3,007,000 cases pass across 323 opcode
files.** Zero unresolved.

Bugs caught (these are the value of empirical validation):

- **Segment wrap in CPU push/pop** — push at SP=1 corrupted memory
  one byte past `SS:0xFFFF`. Real silicon does two byte ops with
  offsets mod 16-bit.
- **PUSH SP silicon quirk** — 8086 pushes the post-decrement SP;
  the 286 changed this. Both 0x54 and FF /6 paths needed
  consistent treatment.
- **FF /7 alias of FF /6** — silicon ignores the high bit of /reg
  for the FF group. Same family of quirks as F6/F7 /1=/0 and
  C6/C7 ignore /reg.
- **DAA / DAS threshold shift on AF=1** — high-fix threshold is
  0x9F (not 0x99) when AF was set on entry. Not in Intel SDM;
  empirically established from corpus.
- **DAS does not OR low-fix byte borrow into CF** — Intel SDM
  documents OR; real silicon doesn't.
- **AAA / AAS independent byte ops** — `AX += 0x106` cascades the
  AL+6 byte carry into AH; real silicon does AL and AH as
  independent byte operations.
- **REP-prefixed IDIV negates the quotient** — undocumented silicon
  microcode quirk consistent across thousands of corpus cases.
- **IDIV overflow is `|q| > 0x7F`, not `q ∉ [-0x80..0x7F]`** —
  silicon traps on q=-128 even though it fits a signed byte.
- **REP on non-string ops must not loop CX times** — silicon only
  loops dedicated string ops (A4-A7, AA-AF); other prefixed ops
  execute once with the prefix latched.

Mask discipline held: every flag mask has a citation (Intel SDM or
8086tiny line reference); no mask silences a register or RAM
mismatch. The mask table lives in `tests/sst/flag-masks.ts`.

The agent built a CLI runner separate from vitest because vitest
buffers output and looked hung on a phone. Pragmatic; doesn't affect
production code.

This brief is the project's empirical foundation. Everything that
followed sits on the certainty that the CPU is silicon-faithful.

### Briefs 3-7 — substrate completion

These five briefs filled out the framework so the first real machine
config could exist:

**Brief 3 — IndexedDBPageStore.** Polyfill verified
(`fake-indexeddb@6.2.5`, three million weekly downloads, zero deps,
active maintenance). Thin adapter from "Uint8Array keyed by
integer" to "IDB object store." Schema version 1, `pages` object
store, out-of-line keys. Load-bearing test: hydrate a `PagedMemory`
from a pre-populated IDB store, verify reads; write through
PagedMemory, flush, instantiate fresh `PagedMemory` against same
store, hydrate, verify writes survived. **The promise from v0 of
"lazy write-behind to IDB" became real here.** 380 → 395 tests.

**Brief 4 — async interrupt delivery.** This was the
architecturally important brief — the async run loop had been
speculative since v0 because nothing actually used the asynchrony.
This brief delivered: a queue with INTR (maskable) + NMI (non-
maskable) intake, a CPU instruction-boundary check that consults
the controller, IF gating, NMI bypass, HLT wake, and the documented
one-instruction inhibit windows after STI / POP SS / MOV SS,r/m.
After this, devices are pure composition — they call
`controller.raise(vec)` and the CPU does the rest. 395 → 422 tests.

**Brief 5 — 8259 PIC + IOBus.** Real `IOBus` (port handler
registration) plus the first device on top of it. The PIC is single
(no cascading; v0 omits the slave on IRQ 2). Single PIC because
that's all the IBM PC original needs and it kept the brief focused;
the AT slave PIC is a future extension that won't replace this code,
just extend it. 422 → 477 tests.

**Brief 6 — virtual Clock + 8254 PIT.** A subscription-based
virtual-time clock. Devices that need timing subscribe; the
`RunLoop` advances the clock after each batch. PIT8254 with three
independent channels, full programming protocol, modes 0/2/3/4,
modes 1/5 accepted-but-silent (gate-edge-triggered, never wired
in our system). Channel 0 → IRQ 0 wires PIT → PIC for the kernel's
timer interrupt. Real-time pacing layer is deferred. 477 → 519
tests.

**Brief 7 — first IBMPCMachine composition.** The wiring harness
that composes everything: CPU + memory + interrupt controller +
IOBus + PIC + PIT + clock + run loop, with sensible defaults. The
first machine config. By this point we had a generic PC substrate
that could run code; nothing PC-specific lived above the device
layer. 519 → 533 tests.

### Phase 1 — BIOS infrastructure

The prep work for booting real OSes. Three independent additions:

1. **ROM region support** in `PagedMemory`. Pages can be marked
   read-only; writes silently dropped. `loadROM(linearAddress, bytes)`
   populates and locks pages. The PageSlab structure had been
   commented "kept as a single structure so we can add write-
   protection flags later" since v0; this was the cash-in.

2. **TrapRegistry** — `Map<number, TrapHandler>` consulted at the
   top of `step()`. When a registered handler exists for the
   current linear `CS:IP`, the handler runs *before* the byte at
   that address is fetched. Hot-path cost when registry is unset
   (corpus, most existing tests): one optional truthiness check.
   No measurable slowdown.

3. **Console** and **Disk** interfaces with Node and in-memory
   implementations. Console: `writeChar` / `readChar` / `hasInput`.
   Disk: sector-level reads/writes plus geometry. NodeFileDisk
   uses `fs` sync APIs. InMemoryDisk for tests.

533 → ~580 tests (the brief's plausible range).

### Phase 2 — TypeScript-native BIOS services

This is where the no-custom-opcodes decision earned its keep. The
brief explicitly rejected 8086tiny's custom-opcode approach and
implemented INT 10h (video), INT 13h (disk), INT 16h (keyboard),
INT 19h (boot), INT 1Ah (RTC), and trivial 11h/12h/15h/17h/1Ch
handlers as TypeScript functions dispatched via the trap registry.

The flow per `INT N`:

```
guest CS:IP = 0xCD N → CPU.step() executes INT silicon-correctly:
  push FLAGS, push CS, push IP, IF←0, far-jump through IVT[N]
next step(): CS:IP = F000:1000+N
  TrapRegistry hits → JS handler runs
  handler reads inputs from cpu.regs, does work via Console/Disk/HostClock,
  writes outputs back to cpu.regs and pushed FLAGS on stack
  CPU then fetches the byte at F000:1000+N (= 0xCF, IRET)
  IRET pops IP, CS, FLAGS — back in guest code
```

Two `cpu.step()` calls per `INT N`; the CPU saw two real-silicon
instructions. The init code in the BIOS ROM is hand-encoded 8086
(~111 bytes) — real machine code that builds the IVT, populates
the BDA, sets SS:SP, and `INT 19h`s into the boot sector.

A new `HostClock` interface for `INT 1Ah` (RTC) was added.
Documented INT 16h AH=00h deviation: returns AX=0 on empty
keyboard buffer rather than blocking — matches the "easiest
correct behaviour for v0" recommendation.

~580 → 668 tests + 323 corpus = 997 total.

### Phase 3 — first ELKS attempt

The first attempt at booting ELKS (Linux for 8086). The user picked
`fd1440-minix.img`; the brief targeted "boot to first kernel
message + identify next stuck point."

Kernel reached the first message ("ELKS....../linux..." then "ELKS
Setup .........FHt"), then got stuck in this loop at CS:IP =
9000:0499:

```
9000:0499  EB 00      JMP +0          ; serializing nop
9000:049b  EB 00      JMP +0          ; serializing nop
9000:049d  E4 60      IN  AL, 0x60    ; PS/2 data port
9000:049f  EB 00      JMP +0          ; serializing nop
9000:04a1  EB 00      JMP +0          ; serializing nop
9000:04a3  E4 64      IN  AL, 0x64    ; PS/2 status port
9000:04a5  A8 01      TEST AL, 1      ; OBF
9000:04a7  75 F0      JNZ -16         ; loop back to 0499 if OBF set
```

The canonical "drain the keyboard buffer before raising A20"
sequence. `BasicIOBus` returns 0xFF on un-registered ports, so bit
0 of port 0x64 is always set, so the loop never exits.

This was the brief's expected outcome: progress + diagnosis. The
diagnosis pre-filled Phase 4's brief.

### Phase 4 — 8042 + A20

A headless `KeyboardController8042` at ports 0x60 / 0x64. A20-gate
command acceptance (but **no actual address-line behavior** — our
1 MiB PagedMemory has no observable A20 effect). Documented as a
deliberate simplification.

The PS/2 stuck loop exited on first iteration. Kernel reached its
debug-style banner ("0330 f122A d19F2 INT f002 START") and then
HLT'd at `0330:7e2f` waiting for a timer interrupt that didn't
arrive. New stuck point. 700 unit + 5 integration + 329 corpus.

### Phase 5 — diagnose-then-fix

**Canonical discipline example.** The Phase 5 brief authorised three
fix candidates (slave PIC stub, DMA stub, BIOS chain-load shim). The
agent's diagnosis showed the actual problem was something else
entirely: the kernel's IRQ handler was issuing EOI to the PIC at
the wrong vector base. The kernel programmed the PIC with vector
base 0x08 (matching the BIOS); our PIC initialised with base 0x00.

The agent **rejected all three pre-authorized fixes** because the
diagnosis didn't motivate them. The actual fix was a one-line
default change in our PIC's initial state plus a regression test.

This brief is the canonical demonstration of evidence-over-
speculation discipline. Every subsequent brief refers back to this
pattern. Documented in `ELKS_DIAGNOSIS_REPORT.md`.

### Phase 6 — reaching login

**A milestone.** With the Phase 5 PIC-vector-base fix, ELKS now
finishes early-kernel init, switches to `console-direct` (CGA
framebuffer), probes ethernet/floppy/ATA-XTIDE (none found),
mounts `/dev/fd0` as Minix root, runs `/etc/rc.sys`, and lands at
`login:`.

The brief had three accepted outcomes (Path 1: cap bump succeeds;
Path 2: long-run with diagnostics; Path 3: new stuck point).
**Path 1.** A simple instruction-cap bump from 1M → 25M was all
that was needed. No new device stubs, no BIOS extensions. 25M
instructions in 11 seconds wall-clock; 22,728 IRQs serviced;
4,545 BIOS trap fires.

The "first surprise" of the run was that the InMemoryConsole
stayed quiet after `INT f002 START` even though the kernel was
clearly making progress. Reading the CGA framebuffer at 0xB8000
revealed the full banner: ELKS's `console_init()` swaps `kputc`
from `INT 10h AH=0Eh` to direct video memory writes. The
InMemoryConsole only saw the early-printk path. Apparent silence,
not a hang. Diagnostic gap, not a substrate bug.

1,029 tests (1,028 baseline + 1 new) all green. Boot time: ~11s
wall-clock, ~25M instructions.

### Phase 7 — keyboard + CGA mirror + runnable harness

Keyboard input plumbing: stdin → PC/AT scancode translator →
keyboard controller queue → IRQ 1 firing on empty→non-empty edge.
A `tools/elks/run.ts` Node harness with a Ctrl-A quit prefix
(mirrors `screen`/`tmux`).

CGA mirror in `src/diagnostics/`: subscribes to writes in the
0xB8000-0xBFFFF range, emits character bytes to a sink. Initial
implementation was stream-style, no positioning — Phase 7.1
fixed that.

The integration test scenario: boot, inject `"root\n"`, run more
instructions, assert post-mount banner + login prompt + shell
prompt. ELKS's `kbd_init()` calls `kb_read()` once with IRQs
disabled to drain pending bytes; pre-injecting loses the leading
'r'-press. Test follows the same pattern (boot, then inject) — the
real harness doesn't hit this because the user types after the
prompt.

747 tests + 323 corpus = 1,070. After 13M instructions: shell
prompt accepts `ls`, prints directory listing.

### Phase 7.1 — cursor-aware CGA mirror

Phase 7's mirror emitted character bytes in write order with no
positioning. The kernel never writes `\n` to the framebuffer — it
writes characters at cells and advances the cursor. There's no
newline byte to emit; we have to put each character where it
belongs.

For each write at framebuffer offset N (even), compute (row, col)
from the offset and emit `ESC[row+1;col+1H<char>`. Host terminal
lays the screen out correctly. CRTC cursor tracking deferred to a
later brief — positioning comes from the write address.

747 → 756 tests.

### Phase 8 — serial console (16550 UART)

A `UART16550` device at COM1 (0x3F8, IRQ 4) with all 8 PC-standard
registers, DLAB-aware divisor latch, 16-byte RX FIFO, IIR priority
encoding, loopback, scratch round-trip.

ELKS configured to boot with `console=ttyS0` via a `/bootopts` edit
on a freshly-built FAT-formatted floppy. **No kernel rebuild
required** — `/bootopts` is a 1024-byte fixed-allocation file the
kernel reads at boot. The `tools/elks-build/build-serial-image.ts`
script does the in-place edit.

Documented: `init=/bin/sh` instead of getty (the source
distribution's `/etc/inittab` only spawns getty on `/dev/tty1`,
never on ttyS0). Going straight to `/bin/sh` via `init=` gives the
same observable outcome without depending on userland config we
can't change.

`tools/elks/run-serial.ts` is the canonical Node harness from this
point; the CGA harness still works. After Phase 8, the serial path
became the daily-driver.

756 → 790 tests + 323 corpus = 1,113.

### Phase 9 — browser harness (xterm.js + Web Worker)

**The North Star reached.** Open a URL, see ELKS boot. Vite-based
dev shell. Emulator runs in a Web Worker; main thread hosts xterm.js;
floppy image fetched via HTTP; IDB-backed page store exercised in
its native environment for the first time.

End state: `npm run dev:browser` opens a Vite dev server; ELKS
boot banner streams into xterm.js; user types `echo browser-ok`,
sees `browser-ok`. `npm run build:browser` produces 292 KB main +
69 KB worker (75 KB / 19 KB gzipped) ready for any static server.

**No emulator changes.** The substrate already supported every
piece this brief needed. Phase 9 was plumbing — message protocol,
worker host, main-thread bootstrap, Vite config, `node:fs` browser
stub.

Locked to serial only — no CGA-canvas renderer in this brief; the
CGA mirror's diagnostic role doesn't translate to the browser yet.
That's a future brief.

790 → 806 tests.

### Phase 9.1 — verify early-printk path

The browser harness showed a brief blank window before the boot
banner appeared. The brief's question: was early-printk wired
correctly? Diagnosis showed the wiring was correct; the apparent
silence was the kernel's pre-`set_console` silence (~187 bytes
from `early_printk` go to `INT 10h AH=0Eh`, which we capture, but
they go to the InMemoryConsole sink before xterm.js was
initialised). Adjusted the BrowserConsole sink to start
buffering immediately.

Misleading "Welcome to emu86" fallback text removed. The diagnosis
was the work; the implementation was minor.

### Phase 9.2 — settings + local upload

Settings panel (gear icon, modal): font size, theme (5 presets),
default image source. localStorage-backed (small, scalar, syncronous
reads needed before terminal mounts).

Local image library: drop a `.img` on the page, name it, pick it
as boot source. New IDB database (`emu86-images`), separate from
the page store (`emu86-pages`). Kept distinct deliberately —
mixing them invites surprises (a "wipe library" UI accidentally
taking out disk-backed RAM).

The bundled `/elks-serial.img` stays implicit and always
available. `source: 'upload' | 'github'` discriminator declared
today; only `'upload'` written. Forward-compat for Phase 9.3.

### Phase 9.3 — GitHub releases browser

In-browser ELKS release browser. Fetches `repos/ghaerr/elks/releases`,
filters to `.img` assets, displays cards (tag, date, prerelease
badge, asset list with sizes). Click an asset → streamed download
with progress callback (throttled at 64 KB or 100 ms) → writes
into IDB image library → user picks it as boot source.

**localStorage-backed cache** with 10-minute TTL, key includes
prerelease toggle so toggling invalidates. Manual refresh not
implemented.

Asset viability tagging: `Likely works` / `Untested` / `Unknown`
chips per asset, derived from filename heuristics. Conservative —
only flips to `Likely works` for filename patterns we've actually
booted.

This is also where the substrate hit its first hard-disk barrier:
HD images failed to boot. The diagnosis section in the report
established what was needed for Phase 10. Diagnosis-pre-fills-
the-next-brief pattern.

### Phase 10 — partitionless hard-disk boot

`hd32-fat.img` and `hd32-minix.img` (32 MB) — partitionless HD
images (the entire image is one filesystem; no MBR, no partition
table). The kernel reads sector 0 as a boot sector directly; the
boot sector loads the kernel.

Substrate work: `DiskClass` enum (`floppy` | `hd`), `inferGeometry()`
extended for HD-class image sizes, `INT 13h AH=08h` (read drive
parameters) per-class implementation, `INT 19h` boot drive number
selection (0x80 for HD, 0x00 for floppy), and `BootConfig` carrying
`diskClass`.

Forward-compat seam: future multi-disk machines documented as the
next step but not implemented.

### Phase 10.1 — MBR-partitioned hard-disk

`hd32mbr-fat.img` and `hd32mbr-minix.img` — same content as Phase
10's images, but with an MBR + partition table at sector 0. ELKS's
bundled MBR Boot Manager parses the partition table, picks the
active partition, loads the VBR from that partition's start LBA,
chain-loads it. Real PC bootstrap behaviour.

**Outcome A — no source-code changes needed.** The substrate
already implemented every BIOS call ELKS's MBR makes. The diagnosis
section confirmed authentic CHS reads only (no LBA extensions
required). The integration tests pinned the boot end-to-end.

This is the canonical "Outcome A: substrate already handles it"
report. Useful template for future briefs of this shape.

The user's authentic-vs-virtual-shift decision happened here: a
"virtual-shift" translation layer would translate `disk.readSector(0)`
to read the active partition's LBA 0 instead of the physical LBA 0,
sidestepping the MBR's bootstrap entirely and bypassing the ~3-second
timeout. The user picked authentic chain-load. A user-toggle for the
convenience path is on the deferred-future list.

### Phase 10.2 — partitionless MINIX HD

Closing the spectrum: `hd32-minix.img` partitionless was tagged
`untested` in the viability tagger because Phase 10 only verified
FAT and Phase 10.1 only verified MINIX-on-MBR. This brief verified
the partitionless MINIX path. Cheap; one new integration test.

### Phase 11 — multi-disk machines

The seam Phase 10 left open. Two simultaneously-mounted disks: a
primary boot disk (floppy or HD) plus an optional secondary data
disk (`/dev/hdb` for second HD, `/dev/fd1` for second floppy).
Kernel sees both at boot; userland mounts on demand
(`mount /dev/hdb /mnt`).

`BootConfig` extended with optional `disks.secondary`. INT 13h
dispatch routes by drive number per class. INT 13h AH=08h reports
per-drive geometry. Worker host extended; UI gained a secondary
picker. **Back-compat shim** is the load-bearing piece — every
test that constructs `IBMPCMachine` with the pre-Phase-11 config
must keep working unmodified. Verified by the entire existing test
suite staying green.

1,228 → 1,253 tests.

### Phase 11.5 — ramdisk verification (`/dev/rd0`)

Diagnosis-only brief (the `Outcome A` shape). Question: does ELKS's
`/dev/rd0` ramdisk work in our emulator?

**Outcome A — works out of the box.** No substrate changes. The
kernel driver allocates from conventional memory via `seg_alloc()`,
which we model correctly. The published `fd1440-minix.img` ships
with `/bin/ramdisk`, `/bin/mkfs`, `/bin/mount`, `/bin/umount`, plus
`/dev/rd0` and `/dev/rd1` device nodes.

**One image-selection finding worth keeping**: FAT12 cannot store
device nodes. The brief named `fd1440-fat-serial.img` as candidate
harness image, but its `/dev` is empty. The MINIX floppy image has
required device nodes. **This finding motivated Phase 11.6.**

1,253 → 1,254 tests.

### Phase 11.6 — MINIX serial floppy

Build a serial-console-configured MINIX-FS floppy that unifies two
strands: device nodes (which 11.5 confirmed are required for
`/dev/rd0`) plus serial console (Phase 8's cleaner harness path).

Phase 8's `/bootopts` edit pattern applied to MINIX V1 unchanged —
both upstream images allocate `/bootopts` as a fixed 1024-byte
contiguous block with a unique `## /bootopts` ASCII header marker.
A 13-line `Buffer.indexOf` + `Buffer.copy` sequence is the entire
edit. No MINIX V1 library, no loop-mount, no `mfs-utils`, no Linux
privileges.

In-place hex edit as first-best choice — a pattern worth keeping
in mind for future image-build work.

`tools/elks-build/build-serial-image.ts` gained a `--filesystem
fat|minix` flag (default `fat` for back-compat). New image:
`fd1440-minix-serial.img`. 1,254 → 1,255 tests.

### Phase 12 — probe harness

A reusable test-side harness: boot ELKS, run a probe script inside
the VM, capture the script's output. The probe is staged on a
secondary FAT12 disk image we build at launch time; the kernel
mounts it; userland runs the script via the serial UART RX path;
output is captured from UART TX.

Pure-TypeScript FAT12 writer. `runProbe()` API:

```ts
const result = await runProbe({
  primaryImage: 'fd1440-minix-serial.img',
  probe: { script: '#!/bin/sh\necho hello', filename: 'probe.sh' },
  timeoutInstructions: 50_000_000,
});
```

**The deliverable was infrastructure, not investigation.** The
brief explicitly disallowed bundling investigative content with the
tool's first ship. The trivial probe (`echo hello-from-probe`)
demonstrates the harness works. Phase 13 took the harness and used
it for real.

This was a "tools, not features" brief. The discipline preserved
the tool's clarity for many later applications.

1,255 → 1,274 tests.

### Phase 13 — toolchain survey

First real application of the probe harness. Survey published ELKS
images, identify which contain a self-hosted compiler, recommend
the right starting point for the user's stated dogfooding arc
(boot ELKS, mount source disk, build NE2000 driver from source).

**Outcome C — survey blocked by infrastructure.** The probe
harness's hard-coded 8M-instruction boot budget is sufficient for
a 1.44 MB MINIX floppy but not for HD images or the 1.44 MB FAT
floppy. Per the brief's hard rules, the harness is locked, so
survey coverage stopped where the budget did.

What we did learn:

- `fd1440-minix.img` fully surveyed: 138 binaries in `/bin`, none
  compiler-shaped.
- HD32 images (`hd32-minix.img` and `hd32-fat.img`) showed
  `c86 cpp as ld make ar objdump` in `/usr/bin/` — the canonical
  Dev86 / ELKS userland C toolchain. **Existence established;
  function not.** The harness ran out of budget mid-listing.
- MBR-padded HD32 and HD64 sizes were rejected by `inferGeometry()`.

Recommendation: defer in-VM dogfooding until a Phase 12.x harness
extension lands. Phase 14 should host-cross-compile NE2000 if the
user takes that path. Both options (in-VM dogfood or host-cross-
compile) are viable; the cross-compile path is unblocked today.

The user's choice was to do the harness extension *and* the
deferred version probe in one combined brief, queued as
`emu86-probe-harness-extension-brief.md` (Phase 12.1 / 13.1). Then
Phase 14 is written with full information.

### Phase 12.1 / 13.1 — IN FLIGHT

Probe-harness boot-budget extension + HD32 version probe combined.
Drafted; awaiting agent run. The verdict will settle whether Phase
14 takes the in-VM dogfooding shape or the host-cross-compile shape.

When `PROBE_HARNESS_EXTENSION_REPORT.md` lands, this section in
the next history update should be promoted from "in flight" to a
proper phase entry, and Phase 14's brief writes itself fairly
directly from the verdict + the networking plan.

---

## Patterns and disciplines that emerged

Most of these crystallised from repeated practice rather than being
designed up front. They're worth preserving across context boundaries.

### Brief-writing rhythm

A consistent shape settled in around Brief 2 and held through every
subsequent brief:

1. **TL;DR** — one paragraph stating what's being built, what the
   reader needs to read first, where the report lives.
2. **Hard rules** — numbered, terse. The architectural locks. Test
   counts that must stay green.
3. **Scope** — what you're building, what you are NOT building.
4. **Design** — file layout, design choices with rationale.
5. **Tests** — unit + integration scope, depth bar.
6. **Watch out for** — the actual bug magnets, ranked by likelihood.
7. **Stop and ask** — what would warrant pausing to surface back to
   the human.
8. **Definition of done** — concrete: test counts, typecheck, files
   produced, report sections.
9. **Reference sources** — in priority order.
10. **Final notes** — meta-context the agent might not catch from
    rules alone.

The "Watch out for" sections are where the brief budget pays off.
Anticipating bugs that have happened in similar work compresses the
cost of the implementation. Models implementing 130 opcodes WILL get
sign extension wrong somewhere; saying so up front saves debug
cycles.

### Outcomes A / B / C / D

A pattern that emerged at Phase 5 and refined through subsequent
briefs. Briefs that have substantial uncertainty about what
implementation is actually needed structure for multiple acceptable
outcomes:

- **Outcome A**: substrate already handles it (no source change).
  The diagnosis confirms; the implementation is "verify and pin."
- **Outcome B**: small fix needed (typically a few lines, motivated
  by specific evidence). Implement, regression test, document.
- **Outcome C**: scope wider than expected; document precisely
  and stop. **Not a failure.** The diagnosis is the deliverable.
- **Outcome D** (emerged in Phase 11+): the work surfaces something
  worth its own follow-up brief. Document and surface; the next
  brief writes itself.

Briefs that structure for multiple outcomes ship reliably. Briefs
that pretend success is the only outcome quietly accumulate
technical debt or get rewritten mid-flight.

### Test-the-workaround-at-the-right-layer

When a test needs the host clock to *appear* to advance (the MBR's
auto-boot timeout) or some other deterministic substitute for real-
time behaviour, use a local helper *in the test* rather than
modifying the substrate. `AutoAdvanceHostClock` in the MBR test
file. Test-side workarounds are fine; substrate determinism is
sacred.

### Diagnosis pre-fills the next brief

Phase 3's stuck-point analysis became Phase 4's brief almost
verbatim. Phase 8's diagnosis section became Phase 9's pre-flight.
Phase 13's boot-budget finding pre-filled the in-flight Phase
12.1/13.1 brief. **A diagnosis report's "things future briefs
should address" section should read like a list of brief
topics.** Briefs written from those lists are concrete and well-
motivated.

### Tools earn their keep across many uses

Phase 12's probe harness is the explicit example: ship the tool
alone, prove it works with a trivial probe, save real investigation
for later briefs. The discipline preserves the tool's clarity. The
CGA mirror, the `traceRun` harness, the `long-probe` CLI runner,
and the test-side `AutoAdvanceHostClock` are all in this category —
each was built to serve a specific need and went on to be reused.

### In-place hex edit as first-best

Phase 11.6 looked like it needed a MINIX V1 filesystem library;
turned out a 13-line in-place byte edit was the correct answer.
Same pattern emerged earlier in Phase 8's FAT12 `/bootopts` edit.
When the file's location is deterministic and the edit is a single
known file, in-place hex editing is often the right tool.

### Custom CPU opcodes are forever forbidden

The strongest version of the no-architectural-debt rule. The 8086
ISA is corpus-pure. The corpus is the truth. Any custom opcode is
one the corpus can't validate. Phase 2 was where this almost
slipped (8086tiny's BIOS uses custom opcodes); the trap-registry
mechanism solved the problem cleanly.

### Pure additive optionals

When a substrate change has back-compat surface (Phase 11's multi-
disk being the canonical example), the pattern is: existing config
shape works unchanged; new shape is opt-in. The shim accepts both.
This minimises churn across many tests and makes legacy paths
obviously legacy.

### Stop and ask is a feature, not a defect

Multiple agents have paused mid-work to surface a decision back to
the human. Brief 2 (corpus v1 vs v2). The agent implementing
Brief 1 noticed factoring opportunities in `serviceInterrupt` and
asked. Phase 11.6's agent noticed the in-place-hex-edit shortcut
and surfaced it. **These pauses make the work better.** Briefs
explicitly authorise certain stop-and-ask conditions; agents that
take them up improve the project; agents that don't, don't.

The user has consistently rewarded productive pushback. Brief
templates now include a "Stop and ask" section by default.

---

## Code inventory (current state)

All paths relative to project root.

### Scaffold

| File | Purpose |
|---|---|
| `package.json` | vitest + typescript + Vite + xterm.js + fake-indexeddb |
| `tsconfig.json` | strict ES2022, bundler resolution, `noUncheckedIndexedAccess` |
| `tsconfig.test.json` | extends main, includes tests |
| `tsconfig.cli.json` | for the standalone Node CLI runners |
| `tsconfig.web.json` | for browser-facing code (Worker, web/) |
| `vite.config.ts` | Vite browser build config |
| `vitest.config.ts` | runs `tests/**/*.test.ts` |
| `.gitignore` | standard + `tests/sst/data/` |

### `src/core/`

| File | Purpose |
|---|---|
| `types.ts` | numeric types, address helpers, sign-extension |
| `flags.ts` | FLAGS register, reserved-bit enforcement |
| `registers.ts` | GP/segment regs with AX/AH/AL aliasing |
| `io.ts` | `IOBus` interface (with `register` / `unregister`); `NullIOBus` |

### `src/memory/`

| File | Purpose |
|---|---|
| `memory.ts` | `Memory` interface |
| `page-store.ts` | `PageStore` interface; `InMemoryPageStore` |
| `paged-memory.ts` | sync Map-backed cache; dirty Set; ROM regions; write-behind |
| `idb-page-store.ts` | IndexedDB-backed `PageStore` for the browser |
| `index.ts` | barrel |

### `src/cpu8086/`

| File | Purpose |
|---|---|
| `parity.ts` | 256-entry parity lookup |
| `flag-helpers.ts` | per-op flag calculators (ADD/SUB/AND/OR/etc) |
| `errors.ts` | `InvalidOpcodeError` |
| `cpu.ts` | `CPU8086`; reset, step, fetch, push/pop, snapshot/restore |
| `trap-registry.ts` | `TrapRegistry` (linear CS:IP → handler) |
| `opcodes-mov.ts` | MOV variants |
| `opcodes-alu.ts` | ADD/OR/ADC/SBB/AND/SUB/XOR/CMP families |
| `opcodes-shift.ts` | shifts and rotates (ROL/ROR/RCL/RCR/SHL/SHR/SAR) |
| `opcodes-arith.ts` | F6/F7 group: TEST/NOT/NEG/MUL/IMUL/DIV/IDIV; FE INC/DEC |
| `opcodes-bcd.ts` | DAA/DAS/AAA/AAS/AAM/AAD |
| `opcodes-int.ts` | INT/INTO/IRET; exports `serviceInterrupt(cpu, vec)` |
| `opcodes-io.ts` | IN/OUT (port-immediate and port-DX) |
| `opcodes-string.ts` | string ops with REP prefix |
| `opcodes-stack.ts` | PUSH/POP variants |
| `opcodes-jcc.ts` | conditional jumps + LOOP family |
| `opcodes-control.ts` | direct jumps/calls, RET variants |
| `opcodes-flag.ts` | CLC/STC/CMC/CLI/STI/CLD/STD |
| `opcodes-prefix.ts` | segment overrides |
| `opcodes-lea.ts` | LEA, LDS, LES |
| `opcodes-misc2.ts` | XCHG, CBW/CWD, PUSHF/POPF, SAHF/LAHF, XLAT, LOCK, ESC |
| `index.ts` | barrel |

(Exact filenames for opcode groups may differ slightly; the
self-registering pattern means they're always wired in
`cpu.ts`'s side-effect imports.)

### `src/runtime/`

| File | Purpose |
|---|---|
| `run-loop.ts` | `RunLoop`; batched async loop; clock advance; HLT-spin |
| `index.ts` | barrel |

### `src/interrupts/`

| File | Purpose |
|---|---|
| `controller.ts` | `InterruptController` (INTR queue + NMI) |
| `index.ts` | barrel |

### `src/io/`

| File | Purpose |
|---|---|
| `io-bus.ts` | `BasicIOBus` (port-handler registration) |
| `index.ts` | barrel |

### `src/timing/`

| File | Purpose |
|---|---|
| `clock.ts` | virtual cycle-count `Clock`; subscriptions |
| `index.ts` | barrel |

### `src/devices/`

| File | Purpose |
|---|---|
| `pic.ts` | `PIC8259` |
| `pit.ts` | `PIT8254` (3 channels, modes 0/2/3/4, 8254 read-back) |
| `keyboard-controller.ts` | `KeyboardController8042` (PS/2, A20-accept, IRQ 1) |
| `uart-16550.ts` | `UART16550` (COM1; FIFO; IRQ 4) |
| `index.ts` | barrel |

### `src/console/`

| File | Purpose |
|---|---|
| `console.ts` | `Console` interface + `InMemoryConsole` + `NodeConsole` |
| `scancode-translator.ts` | stdin → PC/AT scancode pairs |
| `index.ts` | barrel |

### `src/disk/`

| File | Purpose |
|---|---|
| `disk.ts` | `Disk` interface; `InMemoryDisk`; `NodeFileDisk`; geometry |
| `index.ts` | barrel |

### `src/host-clock/`

| File | Purpose |
|---|---|
| `host-clock.ts` | `HostClock` interface; in-memory + Node implementations |
| `index.ts` | barrel |

### `src/bios/`

| File | Purpose |
|---|---|
| `bios-rom.ts` | `buildBiosRom()` — generates 64 KiB ROM image |
| `bios-services.ts` | TS-native handlers (10h/13h/16h/19h/1Ah/etc.) |
| `index.ts` | barrel |

### `src/diagnostics/`

| File | Purpose |
|---|---|
| `tracer.ts` | event tracer (instructions, IO, traps, INTs) |
| `cga-mirror.ts` | cursor-aware CGA framebuffer → terminal mirror |
| `stuck-loop-detector.ts` | identifies CS:IP loops |
| `console-dump.ts` | periodic console snapshot |
| `index.ts` | barrel |

### `src/machine/`

| File | Purpose |
|---|---|
| `ibm-pc.ts` | `IBMPCMachine` — composes everything |
| `index.ts` | barrel |

### `src/browser/`

| File | Purpose |
|---|---|
| `protocol.ts` | message protocol between main thread and worker |
| `worker-host.ts` | runs the emulator inside the Web Worker |
| `browser-console.ts` | `Console` impl over message protocol |
| `index.ts` | barrel |

### `web/`

| File | Purpose |
|---|---|
| `index.html` | the page |
| `main.ts` | main-thread bootstrap, xterm.js, settings UI |
| `worker.ts` | Web Worker entry |
| `settings.ts`, `settings-modal.ts` | settings panel and modal |
| `image-library.ts` | IDB-backed image library (Phase 9.2) |
| `github-releases.ts` | GitHub release browser (Phase 9.3) |
| `viability-tagging.ts` | image viability tags |

### `tools/`

| Path | Purpose |
|---|---|
| `tools/elks/run.ts` | Node ELKS harness (CGA + keyboard) |
| `tools/elks/run-serial.ts` | Node ELKS harness (UART) |
| `tools/elks/secondary-disk.ts` | secondary-disk CLI flag handling |
| `tools/elks-build/build-serial-image.ts` | `/bootopts` edit (FAT or MINIX) |
| `tools/elks-build/fetch-hd-image.ts` | image fixture fetcher |

### `tests/`

| Path | Purpose |
|---|---|
| `tests/unit/` | per-component vitest suite |
| `tests/integration/` | end-to-end (ELKS boot, browser-worker, multi-disk, ramdisk, probe) |
| `tests/sst/` | SingleStepTests harness + corpus runner + flag-masks table |
| `tests/probe/` | probe harness (Phase 12) + survey runners (Phase 13) |

### `releases/`

`releases/phase-N-<slug>/` per phase since 9.1. Each contains
`dist-cli/`, `dist-web/`, fixture images, and a README. Reload-safe
A/B testing.

### `reference/`

| Path | Purpose |
|---|---|
| `reference/8086tiny/` | reference C emulator + BIOS source |
| `reference/elks/` | ELKS kernel source (for diagnosis) |
| `reference/elks-images/fd1440-minix.img` | original Phase 7 fixture |
| `reference/elks-images-serial/fd1440-fat-serial.img` | Phase 8 default |
| `reference/elks-images-serial/fd1440-minix-serial.img` | Phase 11.6 |
| `reference/elks-images-hd/hd32-fat.img` | Phase 10 partitionless FAT |
| `reference/elks-images-hd/hd32-minix.img` | Phase 10.2 partitionless MINIX |
| `reference/elks-images-hd/hd32mbr-fat.img` | Phase 10.1 MBR FAT |
| `reference/elks-images-hd/hd32mbr-minix.img` | Phase 10.1 MBR MINIX |

---

## Architectural rules (the locked list)

These are the locks that have held across all phases. They're listed
in every brief; each agent honours them; the discipline is the
project.

1. **`cpu.step()` stays pure synchronous.**
2. **No custom CPU opcodes.**
3. **No interface changes to settled types** (`Memory`, `PageStore`,
   `InterruptController`, `IOBus`, `Clock`, `Console`, `Disk`,
   `HostClock`, `TrapRegistry`). Additive only.
4. **No architectural changes to `src/core/`, `src/memory/`,
   `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
   `src/devices/`** without explicit human sign-off.
5. **Strict TypeScript stays strict.** No `any`, no `as unknown as`,
   no `// @ts-ignore`.
6. **Determinism in tests.** No real timers, no `Date.now()`, no
   `setInterval` in unit tests.
7. **Don't break existing tests.** Each brief specifies the current
   count; every count must be preserved or grown.
8. **No new dependencies without justification.** Each new dep gets
   verified (publish date, downloads, maintenance status) per the
   IDB brief's polyfill-verification pattern.

---

## Open questions / parked decisions

These are the deferred items, freshest first.

### Imminent (Phase 14 input)

- **Probe harness boot-budget extension** (Phase 12.1 / 13.1, in
  flight). Verdict will determine whether Phase 14 takes the in-VM
  dogfooding shape (build NE2000 driver inside ELKS) or the host-
  cross-compile shape (build on host, deploy via probe disk).

- **Phase 14 — first networking phase.** Per
  `emu86-networking-plan.md`: NE2000 device + virtual switch
  substrate. Card exists, frames flow, no pseudo-hosts attached.
  Validates device substrate.

### Deferred features (carried forward in priority order)

- **CGA-canvas browser frontend.** Graphics-mode rendering. Open
  questions: where does the canvas live (alongside xterm? a tab
  switcher?), how do CGA attributes translate, what does cursor
  mean. Independent of the networking arc.
- **User toggle: authentic vs virtual-shift MBR boot.** Carried
  forward from Phase 10.1. Small; completes the spectrum.
- **Snapshot / restore** of full machine state. Skip the boot;
  large quality-of-life win; substrate-friendly because the
  multi-disk shape already covers state across slots.
- **Real-time pacing layer.** Wraps the run loop, throttles
  batches against `performance.now()`. The clock abstraction is
  the right insertion point.
- **NTP / RTC.** NTP via the network stack pseudo-host
  (demo-friendly), or an actual MC146818 RTC chip at I/O 0x70/71
  (substrate-honest). Both eventually.
- **Cascaded PICs (master + slave).** AT-class machines and IRQs
  > 7. The single-PIC code is structured to extend cleanly; this
  isn't a refactor.
- **Sub-batch event scheduling.** Currently the PIT loses ticks
  if `D < batchSize / cyclesPerPitTick`. The fix is "next event
  time" hinting from devices to the run loop. Not load-bearing
  at typical PIT divisor 65536.
- **Multi-disk machines beyond two.** The substrate seam exists.
  Nothing currently needs it.
- **DOS / FreeDOS / Minix as guests.** Once the substrate
  supports more guest OSes, expand the supported set.

### Architectural deferrals

- **80286 real mode.** Planned roadmap. Clean extension of CPU8086
  (new opcodes, corrected flag behaviours for 286). Hasn't been
  started.
- **Address spaces > 1 MiB.** A20-gate-dependent. When 286 lands,
  `linearAddress`'s 20-bit mask becomes A20-gate-dependent.
- **Web Worker for write-behind.** Currently main-thread async
  task. The interface is shaped to swap in a Worker later.
  Probably never bothered with — IDB writes are quick enough.

---

## Style notes for future planning instances

The user drives architectural decisions; the planning instance
proposes options with recommendations and asks via
`ask_user_input_v0` when there's a real fork. The pattern that
works:

1. Lay out the tension or design space.
2. Propose 2–4 distinct options (not just "different tones" of
   the same answer). Each option should lead to a different
   outcome.
3. Make a recommendation with rationale.
4. Wait for the human's pick before drafting the brief.

The user has redirected briefs productively many times — pulling
ramdisk forward to its own focused brief, recognising that the
FAT-vs-MINIX device-node finding deserved its own follow-up phase,
choosing comprehensive over targeted scope on the toolchain
survey. **Engage with these redirections rather than treating them
as derailments.** They're typically right.

The user is concise. No preamble, no recapping the question. The
user knows the architecture; explain decisions, not concepts they
already grasp. The user values the planning instance flagging its
own state honestly (memory pressure, uncertainty, where they'd
want a second opinion).

When using `ask_user_input_v0`, give the option you'd recommend by
stating it after the tool call. The user likes making decisions
with a recommendation in front of them rather than ranking blank
options.

The user pushes back pointedly when the planning instance is
about to go wrong. Take it seriously; reconsider; don't defend the
original direction reflexively. The synchronous-Map-cache moment
in session 1 was an example — the user collapsed a complex piece
of machinery into a simpler one with a single sentence. Listen
for those moments.

The user has stated philosophical positions worth preserving:

- **Discipline is the project.** The architecture has held because
  shortcuts have been refused. Don't relax under pressure.
- **Authenticity matters.** Phase 10.1's authentic chain-load over
  virtual-shift was deliberate. The networking plan's two-layer
  shape (real network for everything, `webget` as labelled
  exception only for HTTPS) reflects the same posture.
- **Multiple acceptable outcomes are normal.** The user has
  accepted Outcome B / C / D as completion many times. Briefs that
  structure for "what happens if this doesn't pan out cleanly"
  ship reliably.

---

## How this document fits with the other handover materials

There are four handover artifacts in the project knowledge base:

- **This file (`emu86-ts-history.md`)** — the narrative chronicle.
  Tells the *why*. Read this when orienting on the project's
  shape and the decisions that defined it.
- **`emu86-handover-brief-v4.md`** — the active orientation
  document. Says *what to do next*. Read this first as a fresh
  planning instance, then use this history file when you need
  background.
- **`emu86-INDEX.md`** — the flat catalogue. Says *what exists*.
  Use this when you need to find a specific brief or report.
- **The reports themselves** — the immutable per-phase findings.
  Use these when you need depth on what was actually built.

The chat archives are the fifth artifact: planning conversations
captured across sessions. Reports document what was done; chats
capture *why* decisions were made and the brief-writing rhythm
that emerged. Particularly valuable for: the custom-opcode near-
miss in Phase 2; the authentic-vs-virtual-shift call in Phase
10.1; the in-place-hex-edit-as-first-best-choice pattern from
Phase 11.6; the two-layer networking decision; the user's
synchronous-Map-cache collapse in session 1.

---

## Final note

The arc of this project: 33 source files in v0 → a fully composable
8086 + IBM PC framework that boots ELKS in a browser. Across that
arc, no architectural debt has accumulated. The CPU is corpus-
faithful; the memory model is clean; the device substrate composes
cleanly; the BIOS uses no custom opcodes; the browser harness
respects the same locks the Node harness does.

This wasn't accident. Every brief honoured the locks; every report
documented its choices; every diagnosis preceded its implementation;
every test stayed strict. The user pushed back productively; the
agents asked when uncertain; the planning instances refused
shortcuts that would have compromised the architecture.

The discipline is the project. **Don't relax it under pressure.**

The substrate is in genuinely good hands. Whatever phase comes
next — networking, dogfooding, 286 real mode, snapshot/restore,
something the user hasn't named yet — the foundation is solid
enough to support it.
