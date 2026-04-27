# emu86 — Agent Brief: Native TypeScript BIOS Services (Phase 2 of 3)

## TL;DR

Build a TypeScript-native BIOS that satisfies the ELKS boot path. Implement INT 10h (video/console), INT 13h (disk), INT 16h (keyboard), INT 19h (boot), INT 1Ah (RTC), and the trivial INT 11h/12h/15h/17h/1Ch handlers as TypeScript functions dispatched via the trap registry from Phase 1. Generate a small ROM image at construction time containing IVT setup code and IRET stubs at known trap addresses. Add a `HostClock` interface for RTC. Wire the Machine to inject `INT 9` (key press) and `INT 8` (timer tick) from Console input and the existing PIT respectively. **No custom CPU opcodes** — our CPU stays corpus-pure. Verify entirely in Node via deterministic tests. Ship a green test run plus a report at `BIOS_SERVICES_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `BIOS_INFRA_REPORT.md` (Phase 1), and `MACHINE_REPORT.md` first. The 8086tiny BIOS source at `reference/8086tiny/bios_source/bios.asm` is **reference material only** — read it to understand the *contracts* of each INT service (what registers in/out, what the BIOS data area looks like). Do not run it. We are writing our own BIOS in TypeScript.

## Architectural framing (read this carefully)

8086tiny's BIOS uses four custom 8086 opcodes (`0F 00`–`0F 03`) to call host functions for putchar, RTC, and disk I/O. **We are not doing this.** Those custom opcodes were 8086tiny's mechanism for a C-language emulator to be called from 8086 assembly; they don't fit our architecture, where TypeScript is the host language and we have a clean trap-registry mechanism from Phase 1.

Instead: our BIOS handlers are **TypeScript functions** registered against trap addresses inside the BIOS ROM region. The CPU executes a guest `INT N` instruction normally (push flags/CS/IP, far-jump through IVT), lands at a trap address inside our ROM, the trap fires our TypeScript handler, the handler does the work via Console / Disk / HostClock interfaces, control returns, and the CPU executes the `IRET` that's at the trap address.

The CPU never sees a non-standard opcode. The "ROM" is a tiny hand-built byte array — IVT entries pointing at trap addresses, plus an `IRET` (or `IRET` with a pre-amble) at each trap address. ELKS sees a perfectly standard PC-compatible BIOS interface; the implementation is invisible.

## Hard rules

1. **Don't break existing tests.** Current state: 602 unit tests + 329 corpus files passing. Both must stay green. Run `npx vitest run tests/unit/` after every meaningful change. Run the corpus once at the end as a regression check.
2. **No custom CPU opcodes.** Do not add anything to `src/cpu8086/opcodes-*.ts`. The CPU's instruction set stays exactly what real 8086 silicon implements, no more.
3. **No interface changes** to existing types — `Memory`, `PageStore`, `InterruptController`, `IOBus`, `IBMPCMachine`, `Console`, `Disk`, `TrapRegistry`. Additive only. New interfaces (`HostClock`) are fine.
4. **`cpu.step()` stays pure synchronous.** Trap handlers are sync; they read/write registers and memory and return.
5. **Strict TypeScript stays strict.** No `any`, no `as unknown as`, no `// @ts-ignore`.
6. **Determinism.** Same program, same input, same output, every time. Including the RTC — the in-memory `HostClock` for tests is deterministic; only the Node implementation reads real wall-clock time.
7. **Read 8086tiny's BIOS source for contracts, not implementation.** We're satisfying the same ELKS-facing interface, with a different implementation.

## Scope

### What you're building

1. **`HostClock` interface** with `now()` returning a `struct tm`-like time object. Node implementation reads real time. In-memory implementation has settable time for tests.
2. **BIOS ROM image generator** — produces a `Uint8Array` containing the IVT setup code, the trap-stub table, and the BIOS data area initialisation. Loaded into `IBMPCMachine` at construction.
3. **TypeScript BIOS service handlers** for the ELKS-relevant interrupts.
4. **`INT 9` and `INT 8` injection** — Machine wires Console input to INT 9 (keyboard interrupt) and the PIT's IRQ 0 to INT 8 (timer tick) — both via the existing PIC, not directly.
5. **Machine extensions** to construct and wire all of the above.

### What you are NOT building

- The full 8086tiny BIOS feature set. Many INT 10h subfunctions, the entire Hercules graphics path, video page management, the printer port, COM ports — out of scope. Focus on what ELKS uses (you'll discover this in Phase 3 if you guess wrong, but the brief gives a safe minimum).
- Custom 8086 opcodes. None. Zero.
- Real CGA/MDA video memory emulation. We write to BDA cursor position fields and skip real video memory. INT 10h handlers call `Console.writeChar` directly for output.
- A keyboard scancode-to-ASCII translator. Console gives us ASCII; we feed ASCII into the keyboard buffer. ELKS treats our keyboard as if it were already pre-translated. Document this; it's a simplification real PCs don't make.
- ELKS itself. Phase 3 loads ELKS.
- Any browser-side anything.

## Design

### File layout

New files:
- `src/host-clock/host-clock.ts` — `HostClock` interface, `NodeHostClock`, `InMemoryHostClock`.
- `src/host-clock/index.ts` — barrel.
- `src/bios/bios-rom.ts` — ROM image generator (`buildBiosRom()`).
- `src/bios/bios-services.ts` — TypeScript handlers for each INT service (or split into `int10.ts`, `int13.ts`, etc. if it gets large — your call, document).
- `src/bios/bios-data-area.ts` — helpers for reading/writing BDA fields at segment 0x40.
- `src/bios/index.ts` — barrel.
- `tests/unit/host-clock.test.ts`
- `tests/unit/bios-rom.test.ts`
- `tests/unit/bios-services.test.ts` — one test per handler (or one test file per INT, your call).
- `tests/unit/cpu-bios-integration.test.ts` — full integration: CPU executes `INT N`, lands in our handler, returns correctly.

Modified:
- `src/machine/ibm-pc.ts` — accept BIOS ROM + service handlers as a config option (or make them automatic — see "Machine integration" below).
- `src/index.ts` — re-export.

### `HostClock` interface

```ts
export interface HostTime {
  /** Seconds 0..59 */
  seconds: number;
  /** Minutes 0..59 */
  minutes: number;
  /** Hours 0..23 */
  hours: number;
  /** Day of month 1..31 */
  dayOfMonth: number;
  /** Month 0..11 (matches POSIX struct tm) */
  month: number;
  /** Years since 1900 */
  year: number;
  /** Day of week 0..6 (0 = Sunday) */
  dayOfWeek: number;
  /** Day of year 0..365 */
  dayOfYear: number;
  /** Daylight saving flag: 0 = no, 1 = yes, -1 = unknown */
  dst: number;
  /** Milliseconds 0..999 */
  milliseconds: number;
}

export interface HostClock {
  now(): HostTime;
}
```

Two implementations:
- `NodeHostClock`: reads `new Date()` and translates fields. `now()` is therefore non-deterministic.
- `InMemoryHostClock`: holds a fixed `HostTime`, with a setter (`setTime(t: HostTime): void`) and an advance helper (`advance(ms: number): void`). For tests.

The Machine will accept a `HostClock` parameter; default is `NodeHostClock`.

### BIOS ROM image

The ROM is loaded at segment `0xF000`, occupying linear address 0xF0000–0xFFFFF (the standard PC system BIOS region). Use Phase 1's `loadROM` to install it.

#### What's in the ROM

A small structured byte image:

1. **The reset vector at 0xFFFF0**: a far jump to the BIOS init entry point, which is `0xF000:something` (call it `BIOS_INIT_OFFSET`).

2. **The BIOS init code** at `BIOS_INIT_OFFSET`: a tiny block that:
   - Sets up the IVT in low memory (writes 256 × 4 bytes at linear 0–0x3FF). Each entry points to a trap stub address inside the BIOS ROM.
   - Initialises the BDA at segment 0x40 with sensible defaults (equipment word, memory size, keyboard buffer head/tail pointers, etc.)
   - Calls `INT 19h` (boot loader) to start the boot process.

3. **A table of trap stubs**: at fixed offsets like `0xF000:0x0010` for INT 0x10, `0xF000:0x0013` for INT 0x13, etc. Each stub is exactly **one byte: `CF` (IRET)**. The trap registry has a handler at the linear address of the stub. When the CPU executes guest `INT 13h`:
   - CPU pushes flags/CS/IP, far-jumps to F000:0013 (per the IVT)
   - The trap registry's handler fires *before* the IRET at F000:0013 executes
   - The handler does the BIOS work (reads CPU registers for inputs, calls Disk/Console/HostClock, writes CPU registers for outputs, possibly modifies pushed flags on the stack for CF results)
   - The handler returns; CPU executes the IRET; we're back in guest code

4. **For the `INT 11h` / `INT 12h` / `INT 15h` / `INT 17h` / `INT 1Ch` trivial handlers**: same trap mechanism, but the handlers are very short or trivially return constants.

5. **For `INT 19h` (boot)**: handler reads the boot device, uses `INT 13h` semantics (or just calls the disk handler directly) to read sector 1 of the boot drive into 0x0000:0x7C00, then sets CS:IP to 0x0000:0x7C00 by modifying the saved CS:IP on the stack (so the IRET at F000:0019 jumps to the boot sector). This is how real BIOSes do it.

#### Generating the ROM

Don't hand-assemble in test files. Build a generator function:

```ts
export interface BiosRomLayout {
  /** Linear addresses of each trap stub, keyed by INT vector. */
  trapAddresses: Record<number, number>;
  /** Linear address of the reset vector far jump. Should be 0xFFFF0. */
  resetVector: number;
  /** Linear address of BIOS init entry. */
  initEntry: number;
}

export function buildBiosRom(): {
  bytes: Uint8Array;        // length = 64 KiB (one 64 KiB segment)
  baseLinear: number;       // 0xF0000
  layout: BiosRomLayout;
}
```

The generator emits a 64 KiB `Uint8Array`. Most of it is 0xFF (open-bus pattern, conventional for ROM). The structured pieces are placed at known offsets:
- Init code at offset 0x0100 (so `F000:0100` is `initEntry`).
- Trap stubs at offsets 0x0100 + N for each INT N (or use a simple table — your call, but document the layout).
- Reset vector far jump at offset 0xFFF0 (so `F000:FFF0` = linear 0xFFFF0 = the standard reset vector).

The init code itself is a few dozen bytes of 8086 assembly that you hand-encode. Keep it minimal:
- Set up IVT (uses `MOV` and `MOV [...]` instructions; ~30 bytes)
- Set up BDA initial values (~20 bytes)
- `INT 19h` (2 bytes)

Hand-encoding ~50 bytes of 8086 is tedious but tractable. Comment each byte with the assembly source. Tests verify the generated ROM has the right shape.

Alternatively: write a small assembler-helper that takes assembly mnemonics as JS strings and emits bytes. This is potentially worth doing once and reusing — but it's effort that's tangential to the brief. **Do the hand-encoding for now**, revisit if it becomes painful in Phase 3.

### The trap-handler contract

Each BIOS service handler is a TypeScript function:

```ts
type BiosHandler = (cpu: CPU8086, ctx: BiosContext) => void;

interface BiosContext {
  console: Console;
  disk: Disk | null;       // null = no disk attached
  hostClock: HostClock;
  // possibly more — bdaSegment, etc.
}
```

The handler reads CPU registers (`cpu.regs.AX`, `cpu.regs.BX`, etc.), reads/writes guest memory via `cpu.memory.readByte`/`writeByte`, and writes results back to CPU registers.

**Setting CF on return**: real BIOS handlers return error status via CF (carry flag). The handler IRET pops flags from the stack and restores them — so to make CF visible to the caller, the handler must modify the *pushed FLAGS* on the stack, not `cpu.flags.value`. The pushed flags are at `[SS:SP+4]` (the layout is: pushed flags at SP+4, pushed CS at SP+2, pushed IP at SP+0, since the caller's INT N instruction pushed flags then CS then IP).

A small helper:

```ts
function setReturnCF(cpu: CPU8086, value: boolean): void {
  const sp = cpu.regs.SP;
  const ss = cpu.regs.SS;
  const flagsAddr = (ss << 4) + sp + 4;
  let flags = cpu.memory.readWord(flagsAddr);
  if (value) flags |= 0x0001; else flags &= ~0x0001;
  cpu.memory.writeWord(flagsAddr, flags);
}
```

Same trick for SF, ZF, etc. if any handler needs them.

**Modifying pushed CS:IP for INT 19h boot**: same mechanism. Pushed IP at SP+0, pushed CS at SP+2.

### BIOS service handlers — what to implement

The 8086tiny BIOS source is the contract reference. For each INT below, read the corresponding handler in `bios.asm` to see the AH subfunctions, the input registers, and the output registers. Then implement the handler in TypeScript.

#### INT 10h (Video / Console output)

ELKS uses these subfunctions in the boot path:
- **AH=0Eh "Write Character TTY"**: AL = char to write. Call `console.writeChar(cpu.regs.AL)`. Update BDA cursor position (advance column; on column 80, advance to next row; on row 25, scroll). The cursor update is needed because ELKS or DOS may call AH=03h to query cursor position.
- **AH=02h "Set Cursor Position"**: BH = page (ignore), DH = row, DL = column. Update BDA fields curpos_x, curpos_y at offsets in segment 0x40. (See `bios.asm` lines 3640–3650 area for BDA cursor field offsets.)
- **AH=03h "Get Cursor Position"**: BH = page (ignore). Return DH = row, DL = column from BDA.
- **AH=09h "Write Character with Attribute"**: AL = char, BH = page, BL = attribute, CX = count. For our headless implementation, ignore attribute and call `console.writeChar` `count` times. Don't advance cursor (this opcode doesn't, on real hardware).
- **AH=0Fh "Get Video Mode"**: return AH = 80 (columns), AL = current mode (return 3 — color text 80×25), BH = active page (return 0).
- **AH=00h "Set Video Mode"**: ignore the mode change (we have one mode). Update BDA vidmode field.
- **AH=06h "Scroll Up Window"**: parameters describe a rectangle. For headless, you can either (a) emit a newline if the entire screen scrolls (AL=0), or (b) ignore. **(a)** is more useful for ELKS console output. Document the choice.
- **AH=07h "Scroll Down Window"**: similar; ignore for headless or no-op.
- **AH=08h "Get character at cursor"**: return AH = attribute (07), AL = 0x20 (space). We don't track the screen contents.

For all other AH values, log via the `warn` sink and return without action (set CF=0).

#### INT 11h (Equipment List)

Single function: return AX = equipment word from BDA at offset 0x10 (use the value 0x0021 from `bios.asm` line 3617 — equipment present for floppy and 80×25 color text).

#### INT 12h (Memory Size)

Return AX = memory size in KiB. Read from BDA at offset 0x13 (value 0x280 = 640 KiB per `bios.asm` line 3620).

#### INT 13h (Disk Services)

The performance-critical one. ELKS uses:
- **AH=00h "Reset Disk System"**: clear last status, set CF=0, AH=0.
- **AH=01h "Get Last Status"**: return AH = last status, CF = (last status != 0).
- **AH=02h "Read Sectors"**:
  - Inputs: AL = sector count, CH = cylinder (low 8 bits), CL = sector (1-based, bits 0-5) | cylinder high (bits 6-7), DH = head, DL = drive number (0 = first floppy, 0x80 = first HD), ES:BX = buffer.
  - Convert CHS to LBA using the disk's geometry: `lba = (cylinder * heads + head) * sectorsPerTrack + (sector - 1)`.
  - Loop AL times: read one sector via `disk.readSector(lba + i)`, write to buffer at `ES:BX + i*512`.
  - Return: AL = sectors actually read, AH = status (0 = success, 4 = sector not found, etc.), CF = (AH != 0).
  - Update BDA `disk_laststatus` field with AH.
- **AH=03h "Write Sectors"**: same as read but writes to disk.
- **AH=04h "Verify Sectors"**: read but don't store the data, return success if reads succeed.
- **AH=05h "Format Track"**: no-op for our virtual disks; return success.
- **AH=08h "Get Drive Parameters"** (for HD): return CH = max cylinder low 8 bits, CL = (max sector | (max cylinder >> 2) & 0xC0), DH = max head, DL = number of drives. Use disk geometry.
- **AH=15h "Get Disk Type"**: return AH = 1 (floppy with no change-line) or 3 (HD).
- **AH=16h "Detect Disk Change"**: return AH = 0 (no change).

For drive numbers other than configured drives, return AH=1 (invalid function) with CF=1.

8086tiny's `bios.asm` lines 2039–2400 are the reference contract. Read them carefully — the CHS encoding in CL is the most subtle bit (cylinder high bits are in CL bits 6-7).

#### INT 16h (Keyboard)

The BIOS data area has a circular keyboard buffer (32 bytes from offset 0x1E to 0x3D in the BDA). `kbbuf_head` (offset 0x1A in BDA) and `kbbuf_tail` (offset 0x1C in BDA) are pointers into it. Each key entry is 2 bytes: low byte = ASCII, high byte = scancode (we'll use 0 since we skip scancode translation).

ELKS uses:
- **AH=00h "Read Key (blocking)"**: if `head == tail` (buffer empty), this should "block." Since we can't block in `step()`, the convention is to return without changing IP — but that means the `INT 16h` is repeatedly called. The right behavior: poll. Read head, tail. If empty, set CF=0, don't change AX, and DON'T advance IP — meaning the IRET will return to the *same* INT 16h instruction, which will be re-executed when control returns. (This requires the handler to *not* IRET normally; it manipulates the saved IP.) **Alternative simpler approach**: if buffer is empty, set ZF=1 (in pushed flags); ELKS code may check ZF before AH=00h via AH=01h (status check). Read 8086tiny's INT 16h carefully — it loops `kb_gkblock` waiting for keys, which works because INT 16h is called from a HLT-driven loop. **Easiest correct behavior for us**: when buffer is empty, halt the CPU briefly until a key arrives. Since we have async key injection (INT 9), the halt + interrupt cycle naturally spins until input. Implementation: the handler decrements IP back to point at the INT 16h byte (so a re-execute happens), then triggers HLT semantics. Or simpler: the handler synchronously polls and waits for input, which only works if we accept that INT 16h with no input blocks the entire emulator. **For our v0, do the simpler thing**: if buffer is empty, AH=00h returns AX=0 with CF=0. ELKS may need to be checked to confirm what it expects. Document whichever you choose; if ELKS hangs in Phase 3, we revisit.
- **AH=01h "Check for Key"**: if `head == tail` (empty), set ZF=1 in pushed flags. Otherwise, ZF=0, AX = next key (don't remove from buffer). Read pushed flags from stack, modify ZF bit, write back.
- **AH=02h "Get Shift Flags"**: return AL = BDA `keyflags1` (offset 0x17). For our purposes this is always 0.

#### INT 19h (Bootstrap Loader)

Single function:
- Determine boot drive (use 0x00 = first floppy, or 0x80 = first HD if no floppy).
- Read sector 1 (CHS 0,0,1; LBA 0) from boot drive into 0x0000:0x7C00. Use the same internals as INT 13h AH=02h.
- If read fails, halt or jump to a "no boot" message (for now, just set CF=1 and IRET; ELKS won't get here in normal cases).
- If read succeeds: modify pushed CS:IP on the stack so the IRET jumps to 0x0000:0x7C00. Set DL = boot drive number (the boot sector expects this).

#### INT 1Ah (Real-Time Clock)

ELKS uses:
- **AH=00h "Get System Time"**: return CX:DX = ticks since midnight, AL = midnight rollover flag. A "tick" is 1/18.2 seconds (the standard PC timer rate). Compute from `hostClock.now()`: `ticks = (h * 3600 + m * 60 + s) * 65536 / 3600 + ms * 65536 / 3600000` — or simpler, count timer interrupts since boot in BDA (`clk_dtimer` at offset 0x6C is a 32-bit field for this; INT 8 increments it). Easier: just compute from current time via HostClock. AL = 0 (no rollover); we don't bother modeling rollover for now.
- **AH=02h "Get RTC Time"**: return CH = hours BCD, CL = minutes BCD, DH = seconds BCD, DL = DST flag. Compute from `hostClock.now()`. Helper: `decimalToBCD(n) = ((n / 10) << 4) | (n % 10)`.
- **AH=04h "Get RTC Date"**: return CX = year BCD (full 4-digit, e.g., 2026 = 0x2026), DH = month BCD, DL = day BCD. Compute from `hostClock.now()`.

#### Trivial INT handlers (just IRET)

INT 0 (divide error) — already triggered by CPU; leave handler as a default IRET (or a debug hook that warns). ELKS shouldn't hit this in the boot path.

INT 1 (single-step), INT 2 (NMI), INT 3 (breakpoint), INT 4 (overflow), INT 5 (print screen), INT 6 (invalid opcode) — IRET stubs.

INT 7 — 8086tiny uses this for emulator key injection, but in our architecture we use INT 9 (the standard PC keyboard hardware interrupt) instead. Make INT 7 an IRET stub.

INT 0Bh–0Fh — IRET stubs (these would be hardware IRQs 3–7, but we don't have devices for them).

INT 14h (serial), INT 15h (system services), INT 17h (printer), INT 18h (BASIC entry), INT 1Bh (Ctrl-Break), INT 1Dh (video parameter table) — IRET stubs.

INT 1Ch (user timer) — IRET stub. (8086tiny's INT 8 calls INT 1Ch; we'll do the same.)

INT 1Eh (diskette parameter table) — pointer to a parameter table in ROM. Make the IVT entry point at a 16-byte block of the ROM containing reasonable defaults (read from `bios.asm` lines 2748–2756 area).

### Hardware interrupts (INT 8 timer, INT 9 keyboard)

These come from real hardware (PIC IRQ 0 and IRQ 1 respectively), not from the BIOS service interface.

#### INT 8 (Timer Tick — IRQ 0)

The handler must:
- Increment BDA `clk_dtimer` (32-bit field at offset 0x6C).
- Call INT 1Ch (user timer) — the BIOS protocol is that user code can hook INT 1Ch for timer-driven tasks. We do this by having the INT 8 trap handler push a return chain that lands at INT 1Ch's handler. Simpler approach: the trap handler calls the INT 1Ch trap handler directly in JS. (Both work; document.)
- Send EOI to PIC (write 0x20 to port 0x20).

The PIT is already wired to the PIC in `IBMPCMachine`. PIT channel 0 → IRQ 0 → INT 8. The trap handler at the INT 8 stub does the work above when fired.

#### INT 9 (Keyboard — IRQ 1)

The handler must:
- Read the keyboard scancode from port 0x60 — but in our headless setup, we don't have a real keyboard controller. Instead: the Machine's "key injector" pushes a byte directly into the BIOS data area's keyboard buffer (advancing tail) and then raises IRQ 1 via the PIC.
- The trap handler at INT 9 doesn't need to do anything except send EOI — the buffer is already populated by the injector. Actually wait, this means the INT 9 path is mostly bookkeeping. **Even simpler**: skip the INT 9 path entirely for headless — the Machine pushes keys directly into the keyboard buffer in BDA, and INT 16h handlers read from there. ELKS won't notice as long as INT 16h returns the right keys.

I'd recommend the **even simpler** path: the Machine's Console-input → keyboard-buffer feed bypasses INT 9. INT 9 has an IRET stub. Document this.

If you find ELKS specifically requires INT 9 firing (e.g., for keyboard interrupt-driven user code), revisit in Phase 3.

### Machine integration

`IBMPCMachine` constructor gains:
- Optional `disk?: Disk` — the boot disk. If present, INT 13h is wired to use it; if absent, INT 13h returns "no disk."
- Optional `console?: Console` — defaults to a fresh `InMemoryConsole`.
- Optional `hostClock?: HostClock` — defaults to a fresh `NodeHostClock`.
- A new boolean `loadBios?: boolean` — when true (default), generate the BIOS ROM and install it. When false, the Machine works as it does today (no BIOS, useful for tests of the lower layers).

The Machine constructor, when `loadBios` is true:
1. Builds the ROM via `buildBiosRom()`.
2. Calls `memory.loadROM(0xF0000, bytes)`.
3. Constructs the `TrapRegistry` and registers all BIOS handler functions at their trap addresses.
4. Wires Console input → keyboard buffer in BDA + raises IRQ 1 (or skips the IRQ if we go the simpler path).
5. Sets the CPU's `traps` field to the registry.
6. CPU reset (CS:IP = FFFF:0000) lands at the reset-vector far jump in ROM, which jumps to BIOS init, which sets up the IVT and BDA, which calls INT 19h, which loads the boot sector.

A new method on the Machine: `bootFromDisk(disk: Disk): void` or similar, that attaches the disk and resets. Tests use this; Phase 3 uses this.

### What goes into Phase 3

After Phase 2 lands, Phase 3 is:
- Create a `NodeFileDisk` against an ELKS disk image.
- Construct the Machine with that disk.
- Run.
- Triage what ELKS does — what BIOS calls it makes that we haven't implemented correctly, what console output appears, where it gets stuck.

If our Phase 2 BIOS handlers cover the ELKS boot path, Phase 3 is mostly verification + small fixes. If we missed something critical, Phase 3 surfaces it and we add more handlers.

## Test plan

### `HostClock` tests

Small file, ~6 tests:
- `InMemoryHostClock.now()` returns the set value.
- `setTime` updates.
- `advance(ms)` rolls over correctly across seconds, minutes, etc.
- `NodeHostClock.now()` returns reasonable values (within an epsilon of `Date.now()`).
- HostTime fields are in the documented ranges.

### BIOS ROM tests

~10 tests:
- ROM is exactly 64 KiB.
- Reset vector at offset 0xFFF0 is a valid far-jump encoding to `initEntry`.
- Each trap stub exists at its expected address with `0xCF` (IRET).
- `BiosRomLayout.trapAddresses` contains entries for all the INTs we implement.
- Init code at `BIOS_INIT_OFFSET` is present (smoke-test by running the CPU through it and checking final state).

### BIOS service unit tests

One per service. Set up a CPU (no need for a Machine), set registers, call the handler directly, assert result registers and any memory effects. This is the bulk of the testing — easily 30+ tests.

Examples:
- INT 10h AH=0Eh writes to Console.
- INT 13h AH=02h reads a sector from a fake disk into memory.
- INT 13h AH=02h with bad CHS returns CF=1, AH=correct error.
- INT 16h AH=01h returns ZF=1 when buffer empty, ZF=0 when not.
- INT 19h reads boot sector and modifies pushed CS:IP.
- INT 1Ah AH=02h returns BCD time from a fixed `InMemoryHostClock`.

### CPU + BIOS integration tests

~5 tests where the CPU executes a real `INT N` instruction and the handler runs:
- Guest program does `INT 10h` AH=0Eh AL='A'. Run one step. Verify Console got 'A', CPU is back at the next instruction after `INT 10h`.
- Guest program does `INT 13h` AH=02h to read a sector. Run. Verify memory was written.
- Reset → BIOS init → reaches a HLT (or the boot sector if you wire up a fake disk). Mostly a smoke test that the whole boot path holds together.

### What you don't need to test

- The BIOS init code in detail. As long as the IVT is set up correctly and the Machine can boot, the init code is correct.
- Every INT 10h subfunction that ELKS doesn't use. Implement, smoke-test once, move on.
- Real CGA video memory. We don't model it.

## Watch out for

- **The pushed-flags-on-stack mechanism for setting CF.** This is the most error-prone bit. Test carefully: after a handler sets CF, the CPU's `IRET` should pop CF=1 into the FLAGS register. Easy to get the stack offset wrong (push order is FLAGS, CS, IP — so SP+0 is IP, SP+2 is CS, SP+4 is FLAGS).
- **The `INT 19h` boot trick** modifies pushed CS:IP. After IRET, the CPU jumps to 0x0000:0x7C00 with the pushed FLAGS popped (they came from the original `INT 19h` call). Make sure DL is set to the boot drive number — boot sectors expect this.
- **CHS encoding in INT 13h's CL register**: CL bits 0-5 = sector number (1-based!), bits 6-7 = cylinder high. Cylinder is 10-bit total. Sector is 1-based, not 0-based. Off-by-one here corrupts every disk read.
- **The keyboard buffer in BDA is circular.** `head == tail` means empty. After a write, advance tail; if tail equals start_ptr_to_end_of_buffer (offset 0x82 in BDA, value 0x3E), wrap to start (0x1E). The 8086tiny BIOS source has the wrap logic — copy the algorithm.
- **BCD encoding in INT 1Ah**: hours 0–23 packed as BCD (e.g., 23 = 0x23). `decimalToBCD` is straightforward but easy to invert.
- **Don't initialize the IVT in TypeScript** — do it in the BIOS init code, just as a real BIOS would. Why: this is a real test that the CPU + memory + INT mechanism work together end-to-end. If we shortcut by writing the IVT in JS at Machine construction, we miss that.
- **The trap registry is keyed on linear address.** Compute the linear address of each trap stub (`F0000 + offset`) and register the handler there. Don't get confused between segmented and linear addresses.
- **Console.writeChar receives a code point, not a JS string.** Don't accidentally call `console.writeChar(String.fromCharCode(c))` — it's a number, not a string.
- **Halted CPUs don't fire traps** (per Phase 1). If the boot sequence reaches a HLT, the CPU stops; only an interrupt unhalts it. INT 8 from PIT timer ticks is what keeps things going if HLT-driven code is running.

## Stop and ask

- If a handler needs to do something genuinely async (e.g., wait for input). Phase 2 handlers should all be synchronous; if you find a case where this doesn't work, surface it before kludging.
- If you find yourself wanting to add a custom CPU opcode. Don't — design choice already made. If something seems impossible without one, ask.
- If `cpu.step()` wants to be async. Same as always: stop.
- If the corpus regresses (it shouldn't — we're not touching CPU code).
- If the BIOS init code grows past ~200 bytes of hand-encoded assembly. That's a sign it's doing too much; some of it should be in JS handlers.
- If ELKS-specific behavior shows up in the contract. We're targeting standard PC BIOS contracts; ELKS quirks are Phase 3 territory.

## Definition of done

- New files implementing the four pieces (HostClock, BIOS ROM, BIOS services, BDA helpers).
- Machine extended to compose them.
- All existing 602 unit tests still pass.
- New tests as specified, all green.
- Total unit test count ≥ 660 (602 baseline + ~60 new is plausible).
- `npm run typecheck` clean.
- Full corpus run still green.
- Report at project root: `BIOS_SERVICES_REPORT.md` with these sections:
  - **Summary**: test counts, pass status, any deviations.
  - **Architecture**: confirm no custom opcodes were added; show how trap-based dispatch flows from `INT N` instruction → IVT → trap stub → JS handler → IRET.
  - **HostClock**: interface and implementations.
  - **BIOS ROM layout**: a small map of what's at what offset, and the size of the init code.
  - **Service-by-service**: for each INT, which subfunctions you implemented, what was stubbed, what was skipped.
  - **Pushed-flags-on-stack mechanism**: walk through how CF (and other flags) are returned to the caller.
  - **Keyboard input path**: did you go via INT 9 + IRQ 1, or directly inject into the BDA buffer? Why?
  - **INT 16h AH=00h "blocking" choice**: what did you do for the empty-buffer case?
  - **Things Phase 3 will need**: anything you noticed that the ELKS-boot brief should know about.
  - **Verification**: exact commands, output summaries.

## Reference sources

1. **8086tiny's `bios.asm`** — for INT service contracts, BDA layout, scratch areas. Read INT 10h, 13h, 16h, 1Ah handlers carefully. Don't run the BIOS — read it.
2. **Ralf Brown's Interrupt List (RBIL)** if accessible — the canonical reference for IBM PC BIOS calls. Many subfunctions are documented only there.
3. **PC BIOS Data Area layout** — Wikipedia or any PC reference. Key fields: keyboard buffer, cursor position, equipment word, memory size, timer tick counter.
4. The existing `TrapRegistry` (Phase 1) — your dispatch mechanism. Re-read `BIOS_INFRA_REPORT.md` to remind yourself of the `Map.get()` per instruction cost and the "handler runs *before* the instruction at the trap address" semantics.
5. The existing `IBMPCMachine` — your composition target.

## Appendix: why this brief sets up Phase 3 cleanly

Phase 3 will:
1. Acquire an ELKS disk image.
2. Wrap it in a `NodeFileDisk`.
3. Construct an `IBMPCMachine` with the disk attached and `loadBios: true`.
4. Run the loop.
5. Watch what ELKS does — console output via `Console`, observe what BIOS calls it makes, triage anything that breaks.

If Phase 2 covers the standard BIOS surface ELKS needs, Phase 3 should mostly be "watch it boot." If something is missing (likely some INT 13h subfunction or an INT 10h subfunction), it'll surface as a specific call we can add quickly.

The architectural advantage of the JS-handler approach: when something breaks, debugging is straightforward — add a `console.log` to the handler, see what registers ELKS passed, check the documented contract. No reverse-engineering of compiled BIOS code, no custom opcode interactions.
