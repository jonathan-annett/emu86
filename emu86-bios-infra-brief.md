# emu86 — Agent Brief: BIOS Infrastructure (Phase 1 of 3)

## TL;DR

Build the infrastructure needed for a JS-handled BIOS in a future brief: ROM region support in memory, a trap-address registry the CPU consults at instruction boundaries, a `Console` interface with Node-stdout/stdin and in-memory implementations, and a `Disk` interface with Node-file and in-memory implementations. No BIOS code yet — that's Phase 2. Verify entirely in Node via deterministic tests. Ship a green test run plus a report at `BIOS_INFRA_REPORT.md`.

You are working in `emu86/`. Read `README.md`, the prior reports (especially `MACHINE_REPORT.md` for current architecture), and `src/memory/paged-memory.ts` and `src/cpu8086/cpu.ts` to understand the integration points. This brief is foundation work — three small additive surfaces, each independent of the others. Phase 2 will use all four; Phase 3 will use Phases 1 and 2 to actually boot ELKS.

## Hard rules

1. **Don't break existing tests.** Current state: 533 unit tests + 329 corpus files passing. Both must stay green. Run `npx vitest run tests/unit/` after every meaningful change. Run the corpus once at the end as a regression check.
2. **No interface changes** to existing types. `Memory`, `PageStore`, `InterruptController`, `Clock`, `IOBus`, `IBMPCMachine`, etc. all stay as they are. Additive only — extend `PagedMemory` with new methods, add new files for the new abstractions.
3. **`cpu.step()` stays pure synchronous.** The trap registry lookup happens at the top of `step()`; the lookup itself is sync, the handler is sync.
4. **Strict TypeScript stays strict.** No `any`, no `as unknown as`, no `// @ts-ignore`.
5. **Determinism.** Same program, same input, same output, every time. The Node-side console and disk implementations are still deterministic — `process.stdin` reads queue, `fs.readSync` is byte-exact.
6. **No actual BIOS code in this brief.** No INT handlers, no IVT setup, no ROM image. Just the infrastructure to support those in Phase 2.

## Scope

### What you're building

Four independent pieces:

1. **ROM region support in `PagedMemory`** — pages can be marked read-only. Writes to read-only pages are silently dropped (matching real hardware bus behavior). A new `loadROM(linearAddress, bytes)` method populates and marks pages read-only.

2. **`TrapRegistry`** — a registry mapping linear instruction addresses to JS handler functions. The CPU consults this at the top of `step()`, before fetching the instruction. If a handler is registered for the current `CS:IP`, the handler runs first; the CPU then proceeds to fetch and execute whatever instruction is at that address normally.

3. **`Console` interface and implementations** — `Console` interface with three methods (`writeChar`, `readChar`, `hasInput`). `InMemoryConsole` for tests. `NodeConsole` backed by `process.stdout` and `process.stdin`.

4. **`Disk` interface and implementations** — `Disk` interface with sector-level reads and writes plus geometry. `InMemoryDisk` for tests. `NodeFileDisk` backed by a file via `fs` sync APIs.

### What you are NOT building

- Any BIOS service handlers (Phase 2).
- An IVT initializer (Phase 2).
- The BIOS ROM bytes themselves (Phase 2 / Phase 3 — depends on how it gets assembled or generated).
- Loading any disk image (Phase 3).
- Browser-side `Console` or `Disk` implementations. The interfaces support them; the implementations come when the browser UI brief lands.
- An async `Disk` interface. Disk reads happen synchronously inside `cpu.step()`; we accept the cost for now. If it becomes a perf issue we revisit.
- CHS↔LBA translation. The `Disk` interface speaks LBA; the BIOS handler in Phase 2 does the CHS translation for INT 13h.

## Design

### File layout

New files:
- `src/cpu8086/trap-registry.ts` — `TrapRegistry` class, plus `TrapHandler` type.
- `src/console/console.ts` — `Console` interface, `InMemoryConsole`, `NodeConsole`.
- `src/console/index.ts` — barrel.
- `src/disk/disk.ts` — `Disk` interface, `InMemoryDisk`, `NodeFileDisk`, `DiskGeometry` type.
- `src/disk/index.ts` — barrel.
- `tests/unit/rom-region.test.ts` — ROM region tests.
- `tests/unit/trap-registry.test.ts` — trap registry tests including CPU integration.
- `tests/unit/console.test.ts` — `InMemoryConsole` tests; `NodeConsole` tested with mocked `process.stdout`/`process.stdin` or in a separate file with care.
- `tests/unit/disk.test.ts` — `InMemoryDisk` tests; `NodeFileDisk` tests using a tmp file.

Modified:
- `src/memory/paged-memory.ts` — add ROM page support and `loadROM` method.
- `src/cpu8086/cpu.ts` — accept optional `TrapRegistry`, consult it at the top of `step()`.
- `src/cpu8086/index.ts` — export the new trap registry.
- `src/index.ts` — re-export new barrels.

### ROM region support

#### Approach

Each `PageSlab` in `PagedMemory` already exists as a structure. Add a `readonly: boolean` field. Default is `false` (mutable RAM). A new `loadROM(linearAddress, bytes)` method:

1. Computes which pages `bytes` covers.
2. For each page: writes the bytes (using existing internal write path or direct slab access — your call), then sets the slab's `readonly` flag to `true`.
3. Returns nothing or returns the affected page IDs (your call; document).

The `writeByte`/`writeWord` hot path checks the slab's `readonly` field. If `true`, the write is silently dropped — no error, no side effect, return normally. Real-hardware bus behavior.

The dirty set must NOT include ROM pages. Loading a ROM should not produce dirty pages that the write-back loop would persist. Specifically: `loadROM` populates pages directly, marks them read-only, and does NOT add them to the dirty set. If a later write attempt hits a ROM page, the silent drop also doesn't add to the dirty set.

#### Loading semantics

- `loadROM(linearAddress, bytes)` where `bytes` is a `Uint8Array` or `number[]`.
- Linear address must be page-aligned (a power-of-two multiple of `pageSize`). If not, throw — ROM regions in real systems always align to natural boundaries, and partial-page ROM is a configuration error.
- Length of `bytes` must be a multiple of `pageSize`. If not, throw — same reason.
- If any page in the affected range is already marked `readonly`, throw — overlapping ROM loads are a configuration bug.
- If any page in the affected range is dirty (has been written by the guest before ROM loading), throw — loading ROM over guest-modified RAM is suspicious; force the user to clear or reset first.

#### Tests for ROM regions

Roughly 12 tests:

- Load ROM, read back the bytes — match.
- Load ROM, attempt to write to it — write silently dropped, original bytes intact.
- Load ROM, dirty set is unchanged.
- Load ROM at non-page-aligned address — throws.
- Load ROM with non-page-multiple length — throws.
- Load ROM that overlaps existing ROM — throws.
- Load ROM that overlaps a dirty RAM page — throws.
- Load ROM at multiple non-overlapping addresses — both regions readable independently.
- Load ROM, then `flushDirty()` — no-op, no save calls to PageStore.
- Load ROM, write to neighbouring RAM page — RAM write succeeds.
- After `loadROM`, `hasPage()` returns true for the ROM pages.
- ROM pages persist across `flushDirty` and `stopWriteBack` (they're effectively eternal in the cache).

### TrapRegistry

#### Interface

```ts
export type TrapHandler = (cpu: CPU8086) => void;

export class TrapRegistry {
  /** Register a handler for the given linear instruction address. */
  register(linearAddress: number, handler: TrapHandler): void;
  
  /** Remove a handler. Throws if no handler was registered at that address. */
  unregister(linearAddress: number): void;
  
  /** Look up a handler. Returns undefined if no handler is registered. */
  get(linearAddress: number): TrapHandler | undefined;
  
  /** Number of registered handlers. */
  readonly size: number;
}
```

Implementation: a `Map<number, TrapHandler>`. That's it. The hot path in `cpu.step()` does one `Map.get()` per instruction; modern V8 optimizes this very well, and the empty-map case is essentially free.

#### CPU integration

The CPU constructor accepts an optional `TrapRegistry`. Default to an empty registry (or `undefined`, with a check in `step()` — equivalent).

At the top of `step()`, after the existing interrupt boundary check but before the instruction fetch:

```ts
if (!this.halted) {
  const linearIP = (this.regs.CS << 4) + this.regs.IP;
  const handler = this.traps?.get(linearIP);
  if (handler) {
    handler(this);
  }
}
// ... continue with existing fetch and dispatch
```

Important design points:

- The handler runs *before* the instruction at the trap address executes. This is the "before" model from the design notes — the CPU still fetches and executes the instruction normally after the handler returns.
- The handler may modify registers, flags, or memory. It may also modify CS:IP — though this is unusual; if it does, the next iteration of step() will see the new IP and (correctly) not re-trigger the same trap.
- The handler runs only once per instruction; if the handler doesn't change CS:IP, the instruction at the trap address still runs normally afterward (this is what we want — the BIOS pattern is "JS does work, then real IRET runs").
- Halted CPUs do NOT trigger traps. The halted check happens before the trap lookup. (Rationale: if the CPU is halted waiting for an interrupt, we shouldn't be re-firing the trap on every halt-spin iteration.)
- Trap handlers should NOT throw. A throwing handler propagates the exception out of `step()`, which is observable behavior; document this. Phase 2 BIOS handlers will not throw.

#### Tests for TrapRegistry

Roughly 10 tests:

- Register, get returns handler.
- Unregister, get returns undefined.
- Unregister of unregistered address — throws.
- Register twice at same address — throws (or replaces — pick one and document; "throws" matches the rest of the codebase's strict overlap policy).
- `size` reflects registrations.
- CPU with no trap registry runs unchanged (reproduce existing test behavior).
- CPU with empty registry runs unchanged.
- Register a trap that sets `AX = 0x1234`. Place `MOV BX, AX; HLT` at the trap address. Run. Assert BX = 0x1234 — proves handler runs *before* the instruction.
- Register a trap that increments a JS-side counter. Place a `JMP` loop that visits the trap address 10 times. Assert counter == 10.
- Register a trap, halt the CPU, advance — handler does NOT fire (halted check is before trap check).

### Console interface

#### Interface

```ts
export interface Console {
  /** Write a single character (code point 0-255). */
  writeChar(charCode: number): void;
  
  /** Read a character if available. Returns -1 if no input is queued (non-blocking). */
  readChar(): number;
  
  /** True if at least one character is available to read. */
  hasInput(): boolean;
}
```

Three methods, no more. Higher-level concerns (cursor positioning, screen modes, ANSI escape sequences) belong in the BIOS service handlers in Phase 2 — they map down to writeChar calls.

#### `InMemoryConsole`

Holds an output `string` (or `number[]`, your call — `string` is friendlier for assertions) and a programmable input queue. Test affordances:

```ts
class InMemoryConsole implements Console {
  /** All characters written so far. */
  readonly output: string;  // or number[]
  
  /** Push characters into the input queue. */
  pushInput(chars: string | number[]): void;
  
  /** Clear output buffer. */
  clearOutput(): void;
  
  /** Clear input queue. */
  clearInput(): void;
  
  // Console methods:
  writeChar, readChar, hasInput
}
```

Tests can write input before running, read output after, assert on contents.

#### `NodeConsole`

Backed by `process.stdout` and `process.stdin`. The complications:

**Output**: easy. `process.stdout.write(String.fromCharCode(c))`. No buffering needed (Node handles that).

**Input**: harder. By default, `process.stdin` is in line-buffered cooked mode — character input arrives only after Enter is pressed. For BIOS-style "read a key" behavior we need raw mode.

```ts
class NodeConsole implements Console {
  private inputQueue: number[] = [];
  private rawModeEnabled = false;
  
  constructor() {
    if (process.stdin.isTTY) {
      // Set raw mode and listen for data
      process.stdin.setRawMode(true);
      this.rawModeEnabled = true;
      process.stdin.on('data', (chunk: Buffer) => {
        for (const byte of chunk) {
          this.inputQueue.push(byte);
        }
      });
      process.stdin.resume();
    }
    // If stdin is not a TTY (e.g. piped input), reads still work via the
    // 'data' event but raw mode is unavailable — handle gracefully.
  }
  
  /** Restore terminal state. Call before process exit. */
  close(): void {
    if (this.rawModeEnabled) {
      process.stdin.setRawMode(false);
      process.stdin.removeAllListeners('data');
      this.rawModeEnabled = false;
    }
  }
  
  // ... interface methods
}
```

Critical: raw mode must be cleaned up. If the program exits without `close()`, the user's terminal is left in raw mode and they can't see what they're typing. Recommend: have the constructor register a `process.on('exit', ...)` handler that calls `close()`. Document the affordance.

**One gotcha**: raw mode delivers `Ctrl-C` (0x03) as a regular byte instead of sending SIGINT. The Console can either preserve this (let the BIOS see Ctrl-C as a character) or handle it specially (catch 0x03 and exit). For Phase 1, deliver as a character — let Phase 2 / 3 decide policy. Document.

**Another gotcha**: TTY detection. If stdin is piped (`emu86 < input.txt`), `isTTY` is false, raw mode isn't applicable, but we still want to read characters. The fallback is to listen for `'data'` events without raw mode and queue bytes. Test both paths.

#### Tests for Console

`InMemoryConsole`:
- Write character, output buffer reflects it.
- Write multiple characters, output is in order.
- `hasInput()` initially false.
- `pushInput(['a', 'b'])`, `hasInput()` true, `readChar()` returns 0x61, then 0x62, then -1 with `hasInput()` false.
- `clearOutput()`, output is empty.
- `clearInput()`, input queue is empty.

`NodeConsole`: testing this requires either mocking `process.stdout`/`process.stdin` or running a subprocess. Mocks are simpler. Use vitest's `vi.spyOn(process.stdout, 'write')` to capture output. For input, you can manually call the data event handler the constructor registers, or extract the queueing logic into a public-ish hook. Don't test the raw-mode setup directly (it'll fail in CI environments without a TTY); test the data-handling path with mocked events.

### Disk interface

#### Interface

```ts
export interface DiskGeometry {
  cylinders: number;
  heads: number;
  sectorsPerTrack: number;
}

export interface Disk {
  readonly geometry: DiskGeometry;
  readonly readonly: boolean;
  readonly sectorCount: number;  // total sectors = cylinders * heads * sectorsPerTrack
  
  /** Read a 512-byte sector. Throws on out-of-range LBA. */
  readSector(lba: number): Uint8Array;
  
  /** Write a 512-byte sector. Throws on read-only or out-of-range LBA. */
  writeSector(lba: number, data: Uint8Array): void;
}
```

Sector size is fixed at 512 bytes (the standard for floppies and traditional HDs). If we ever care about 4K sectors or CD-ROM-style 2048-byte blocks, that's a future brief.

#### `InMemoryDisk`

```ts
class InMemoryDisk implements Disk {
  constructor(options: {
    geometry: DiskGeometry;
    readonly?: boolean;
    /** Initial contents. If shorter than disk size, padded with zeros. */
    contents?: Uint8Array;
  });
  
  // Plus interface methods.
}
```

Backing: a single `Uint8Array` of size `cylinders * heads * sectorsPerTrack * 512`. Reads slice into a fresh `Uint8Array` (no shared buffer with internal storage). Writes copy the input bytes into internal storage.

#### `NodeFileDisk`

Backed by an open file descriptor.

```ts
class NodeFileDisk implements Disk {
  constructor(options: {
    path: string;
    geometry?: DiskGeometry;  // If absent, infer from file size
    readonly?: boolean;        // Default: false (file opened r+)
  });
  
  /** Close the underlying file descriptor. */
  close(): void;
  
  // Plus interface methods.
}
```

If geometry is absent, infer from file size against standard floppy geometries (1.44 MB → 80×2×18, etc.). For HD images with non-standard sizes, geometry must be passed in. If neither matches, throw.

Use `fs.openSync`, `fs.readSync`, `fs.writeSync`, `fs.closeSync`. Sync APIs because reads happen inside `cpu.step()`. Yes, this blocks the event loop during disk access — for a 1.44MB floppy fully loaded into memory it's fine; for larger images we'll revisit if it becomes a problem.

Optimization: load the entire file into a `Uint8Array` at construction (call this the "in-memory cache"), serve reads from it, write through to the file on writes. For floppies and small HDs this is reasonable. Document and make it explicit so the agent doesn't try to be clever. (For a brief that's just exposing the abstraction, "load it all" is the right v0.)

#### Tests for Disk

`InMemoryDisk`:
- Construction with explicit geometry, sectorCount matches.
- Read sector 0 of a freshly constructed disk — all zeros.
- Write sector 0, read sector 0 — bytes match.
- Read sector beyond sectorCount — throws.
- Write sector beyond sectorCount — throws.
- Write to readonly disk — throws.
- Construct with initial contents — reads return that data.
- Initial contents shorter than disk size — padded with zeros.

`NodeFileDisk`:
- Create a tmp file, construct, read, close, verify.
- Roundtrip: write sector, close, reopen, read same sector — matches.
- Geometry inference for 1.44 MB file (80×2×18×512 = 1474560 bytes) — geometry matches.
- File size doesn't match any standard floppy and no geometry passed — throws.
- Readonly disk: writeSector throws.
- close() releases the fd (verify by attempting a read after close — should throw or have well-defined behavior).

Use `fs.mkdtempSync` + `path.join` for tmp dirs in tests. Clean up after each test.

## Watch out for

- **The trap registry hot-path lookup is per-instruction.** Make sure the `cpu.step()` integration adds at most one branch + one Map.get per instruction. Don't add multiple field accesses or property reads inside the step path.
- **ROM pages and the dirty set**: a write to a ROM page must NOT add the page ID to the dirty set, even though the write is dropped. Easy mistake: dropping the write but adding to dirty unconditionally would cause the write-back loop to attempt to persist ROM pages.
- **`loadROM` throwing on dirty-RAM-page overlap is a "fail loud" choice.** If a future use case needs to load ROM after running for a while (unusual, but maybe for hot-swapping), revisit. For now, throw and force the caller to reset memory or use a fresh `PagedMemory`.
- **`NodeConsole`'s raw-mode cleanup**: if not cleaned up, the user's terminal is left in a broken state. Use `process.on('exit', ...)` to register cleanup. Test that the exit hook doesn't throw if `close()` was already called manually.
- **Stdin TTY vs pipe**: `process.stdin.isTTY` is false when input is piped or when running in CI. The `NodeConsole` must handle both. Tests must not rely on `isTTY === true`.
- **Sync `fs` operations block the event loop.** For tests this is fine. For real usage with large disks, this could become a performance issue. Document the limitation; defer optimization to a future brief.
- **`InMemoryDisk` pad-with-zeros vs throw on short contents**: pad-with-zeros is the friendlier default (matches "freshly formatted disk that has some data in it"). Throw on contents *longer* than disk size — that's a real bug.
- **Cross-platform path handling**: tests that use tmp files must use `path.join` and `os.tmpdir()`, not hardcoded `/tmp/...` paths.

## Stop and ask

- If you find yourself wanting to make `cpu.step()` async or change its public signature in any way other than accepting an optional `TrapRegistry` constructor argument.
- If `loadROM` semantics turn out to need something fundamentally different than "page-aligned, multiple-of-page-size, fail on overlap" — the design call here is worth surfacing.
- If `Disk` needs an async variant for browser implementations (it might, eventually — but Phase 1 is Node-only and sync, defer the discussion).
- If the trap registry's hot-path lookup turns out to be measurably slow (it shouldn't be, for the small key sets we expect, but if a benchmark suggests otherwise we should know).
- If the corpus regresses (it shouldn't — the trap-registry integration in `step()` is gated on registry presence and the existing tests use no registry).

## Definition of done

- New files implementing the four pieces as specified.
- ROM region support added to `PagedMemory` with `loadROM` method.
- `CPU8086` accepts optional `TrapRegistry` and consults it in `step()`.
- All existing 533 unit tests still pass.
- New tests as specified, all green.
- Total unit test count ≥ 580 (533 baseline + ~50 new is plausible).
- `npm run typecheck` clean.
- Full corpus run still green.
- Report at project root: `BIOS_INFRA_REPORT.md` with these sections:
  - **Summary**: test counts, pass status, any deviations.
  - **ROM region implementation**: how page-readonly is tracked, how `loadROM` interacts with the dirty set, what happens on a write to a ROM page.
  - **Trap registry**: lookup data structure, hot-path cost (one Map.get per instruction), CPU integration point and any subtleties.
  - **Console**: interface design rationale, NodeConsole raw-mode handling, Ctrl-C policy, TTY-vs-pipe handling.
  - **Disk**: interface design rationale, sync-vs-async choice, how NodeFileDisk handles geometry inference and the in-memory cache.
  - **Things Phase 2 will need**: anything you noticed while building this that the BIOS-services brief should know about.
  - **Verification**: exact commands, output summaries.

## Reference sources

1. The existing `PagedMemory` in `src/memory/paged-memory.ts` — your model for how pages and dirty tracking work today.
2. The existing `CPU8086.step()` in `src/cpu8086/cpu.ts` — your integration point for the trap registry. Read `INTERRUPT_DELIVERY_REPORT.md` for the existing structure of step() so you know where the trap check fits.
3. Node.js `process.stdin` / `process.stdout` docs — for raw mode, isTTY detection, the data event.
4. Node.js `fs` sync API docs — for file-based disk.
5. The 8086tiny BIOS source at `reference/8086tiny/bios_source/bios.asm` — for context on what Phase 2 will need to support. Glance at it for shape; do not plan implementation from it.

## Appendix: how Phase 2 will use this

After Phase 1 lands, Phase 2 builds the BIOS services on top:

- A small ROM image is generated/assembled containing IVT entries pointing at trap addresses inside the BIOS region (e.g., `INT 10h` → `F000:0010`, `INT 13h` → `F000:0013`, etc.). Each trap address contains `IRET` (or `NOP; IRET` if we want to verify trap-fired-then-instruction-ran).
- The Machine constructs a `TrapRegistry` and registers each BIOS service handler at its corresponding trap address.
- BIOS service handlers are JS functions that read the requested operation from CPU registers, do the work via the `Console` / `Disk` interfaces, and write results back into CPU registers.
- The CPU executes a guest `INT N` instruction normally — pushes flags/CS/IP, far-jumps to the IVT-pointed address. The trap fires *before* executing the IRET there. The handler runs (does the BIOS work). Control returns to the CPU. The CPU executes the IRET. We're back in guest code.

Phase 3 then loads the ELKS disk image into a `NodeFileDisk`, constructs the Machine with the BIOS ROM and trap registry, and runs.

If Phase 1 lands clean, Phase 2 is mostly "implement N JS functions, each ~20-50 lines." Phase 3 is "wire it together, run, triage what doesn't work."
