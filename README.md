# emu86

A browser-oriented TypeScript x86 emulator framework. Roadmap: 8086 → 80286 real mode.

No WASM, no bundler magic, no dependencies beyond TypeScript and vitest. Designed to be understandable first, fast second.

## Status

**v0 — correctness-first, headless.** The CPU core, paged memory subsystem, and async run loop are in place. A deliberately thin slice of the 8086 instruction set (NOP, HLT, MOV r8/r16 imm, JMP short, ADD AL/AX imm) is implemented end-to-end to validate the architecture before expanding opcode coverage. 103 unit tests pass.

Not yet: the rest of the instruction set, interrupts, devices, machine configurations, UI, IndexedDB page store.

## Layers

```
Machine (not yet — v0 is headless)
  ├─ CPU8086                         sync per-instruction, pure
  │    ├─ Registers                  AX/AH/AL alias via typed-array views
  │    ├─ Flags                      bit-level accessors, reserved bits enforced
  │    ├─ Decoder (opcode table)     (opcodes.ts)
  │    └─ Executor (handlers)        (opcodes.ts)
  ├─ Memory = PagedMemory            sync, Map-backed, never faults
  │    ├─ Page slabs (Uint8Array)    allocated on first access
  │    ├─ Dirty Set                  O(1) track, drained by write-behind
  │    └─ PageStore                  InMemoryPageStore | IndexedDBPageStore (later)
  ├─ IOBus (stub)                    NullIOBus in v0
  └─ RunLoop                         async, batched, yields to event loop
```

## Quick start

```bash
npm install
npm run test          # run all tests
npm run test:watch    # vitest watch mode
npm run typecheck     # type-check src + tests
```

## Design principles

1. **Synchronous CPU core.** `cpu.step()` never awaits, never throws across the async boundary. Every opcode handler is a plain function. This keeps the CPU deterministic, testable, and trivial to reason about.

2. **All memory is always resident.** No page-fault path. The Map is the working set; pages never evict. Given our address spaces (1 MiB for 8086, 16 MiB for 286-real) this fits comfortably in any browser tab. The async machinery is reserved for *persistence*, not memory pressure.

3. **Persistence is write-behind.** Dirty pages accumulate in a Set. A background async task drains them to the `PageStore` on an interval. The "clear-before-snapshot" pattern makes this race-free even with interleaving CPU writes.

4. **The framework, not the machine.** `CPU8086` knows nothing about PC hardware — no BIOS, no video, no disk. A future `Machine` composes CPU + memory + devices for specific systems (IBM PC, embedded 286 board, headless test harness). Multiple machine configs can share one CPU core.

## Memory model in one diagram

```
CPU                Memory (PagedMemory)              PageStore
 │                    │                                  │
 │ readByte(0x1234)   │                                  │
 │ ─────────────────> │  pageId = 0x1234 >> 12           │
 │                    │  slab = pages.get(pageId)        │
 │                    │        or materialise zero       │
 │                    │  return slab.data[off]           │
 │ <───────────────── │                                  │
 │                                                       │
 │ writeByte(0x1234, v)                                  │
 │ ─────────────────> │  slab.data[off] = v              │
 │                    │  dirty.add(pageId)               │
 │                                                       │
                 ... some time later, background loop ...
                      │                                  │
                      │  batch = [...dirty]              │
                      │  dirty.clear()                   │
                      │  for each pageId in batch:       │
                      │    snapshot = slab.data.slice()  │
                      │    await store.save(──────────>  │  persists
                      │                                  │
```

## Adding a new opcode

The one-file pattern. Open `src/cpu8086/opcodes.ts`:

```ts
// Example: ADD AL, imm8 (0x04)
OPCODE_TABLE[0x04] = (cpu) => {
  const a = cpu.regs.AL;
  const b = cpu.fetchByte();             // reads next byte, advances IP
  const result = a + b;                  // KEEP UNMASKED for carry detection
  flagsAdd8(cpu.flags, a, b, result);
  cpu.regs.AL = result & 0xFF;
};
```

Steps:

1. Look the opcode up in the Intel 8086 Family User's Manual (or [Felix Cloutier's reference](https://www.felixcloutier.com/x86/)).
2. Write the handler with the `(cpu) => {}` signature. Use `cpu.fetchByte()` / `cpu.fetchWord()` to consume any following bytes (ModR/M, displacement, immediate); they advance IP.
3. For ALU ops, use the `flagsXxx8` / `flagsXxx16` helpers (or add one if your op is new). The convention: pass the unmasked full-precision result so carry-out is visible; the helper handles masking before computing ZF/SF.
4. Write opcode tests in `tests/unit/opcodes.test.ts` covering:
   - The obvious case (normal inputs, expected output).
   - Every flag this opcode should affect (ZF, CF, OF, SF, AF, PF each have subtle cases — look at the ADD tests for the pattern).
   - Any edge (max value, boundary carry, zero result, sign flip).
5. Cross-check against the real corpus once we wire up SingleStepTests — that's where subtle errors surface.

## Adding a new flag-computation helper

`src/cpu8086/flag-helpers.ts` has one helper per `(operation, width)` pair. The split avoids an inner branch on the hot path.

The idiom (from 8086 documentation, battle-tested in every 8086 emulator):
- **CF**: bit above the width in the unmasked result (`result & 0x100` for byte, `& 0x10000` for word).
- **PF**: parity of low byte via `PARITY_TABLE`.
- **AF**: `(a ^ b ^ result) & 0x10`.
- **ZF**: `(result & mask) === 0`.
- **SF**: top bit of masked result.
- **OF (ADD)**: `(a ^ result) & (b ^ result) & sign_bit` — operands same sign, result differs.
- **OF (SUB)**: `(a ^ b) & (a ^ result) & sign_bit` — operands different sign, result sign differs from `a`.

## Async run loop

```ts
import { CPU8086, PagedMemory, RunLoop, InMemoryPageStore } from 'emu86';

const memory = new PagedMemory({ store: new InMemoryPageStore() });
await memory.hydrate();                    // load persisted pages, if any
memory.startWriteBack({ intervalMs: 500 }); // start async write-behind

const cpu = new CPU8086(memory);
cpu.reset();

const loop = new RunLoop(cpu);
const result = await loop.run({ batchSize: 10_000 });

await memory.stopWriteBack();               // graceful drain before exit
console.log(`ran ${result.executed} instructions (${result.reason})`);
```

## Testing strategy

**Unit tests** (`tests/unit/`) cover each component in isolation — Registers, Flags, PagedMemory, CPU basics, each opcode, the run loop.

**SST harness** (`tests/sst/`) is the accuracy backbone. Every implemented opcode will eventually be validated against thousands of JSON test cases from [SingleStepTests/8088](https://github.com/SingleStepTests/8088). The harness is in place; wiring up the real corpus is a one-time symlink + loader write (see `tests/sst/README.md`).

## File map

```
src/
├── core/
│   ├── types.ts           numeric types, address helpers, sign-extension
│   ├── flags.ts           FLAGS register + reserved-bit enforcement
│   ├── registers.ts       GP/segment regs with AX/AH/AL aliasing
│   └── io.ts              IOBus interface + NullIOBus stub
├── memory/
│   ├── memory.ts          CPU-facing Memory contract
│   ├── page-store.ts      pluggable persistence (InMemoryPageStore for now)
│   └── paged-memory.ts    Map-backed sync cache + async write-behind
├── cpu8086/
│   ├── parity.ts          precomputed PF table
│   ├── flag-helpers.ts    per-op flag calculators (ADD8/ADD16 so far)
│   ├── errors.ts          InvalidOpcodeError
│   ├── cpu.ts             CPU8086 class, fetch path, step dispatch
│   └── opcodes.ts         opcode table + handlers
├── runtime/
│   └── run-loop.ts        async batched loop around cpu.step()
└── index.ts               public exports

tests/
├── unit/                  per-component tests
└── sst/                   SingleStepTests harness + hand-crafted cases
```

## Roadmap from here

Next likely commits, in rough order:

1. Broaden opcode coverage. MOV with ModR/M (0x88–0x8E), the rest of the ALU family (SUB, CMP, AND, OR, XOR, INC, DEC, NEG, NOT), shift/rotate, PUSH/POP, more jumps, CALL/RET, string ops with REP prefix.
2. ModR/M decode helper (shared across most ALU / MOV variants). This is the one significant shared-decode helper we haven't needed yet.
3. Interrupt queue + `INT` / `IRET` opcodes + pending-interrupt check in the run loop. This is where `cpu.snapshot()/restore()` finally starts earning its keep.
4. IndexedDBPageStore. Simple once the `PageStore` interface is proven.
5. Wire up the SingleStepTests corpus. Will surface flag-calculation bugs aggressively.
6. 80286 real mode CPU extending CPU8086 (new opcodes, corrected flag behaviors for 286).
7. First `Machine` config — probably minimal "BIOS + bootsector loader" targeting 8086tiny's bundled ROM.
8. Browser UI (Vite-served, separate package).
