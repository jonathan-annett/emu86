# BIOS_INFRA_REPORT — Phase 1 (BIOS infrastructure)

## Summary

The four foundation pieces called out in the brief are in. None of the
existing 533 unit tests changed, no existing interface changed, and the
SST corpus is still green.

- Unit tests: **602 / 602 pass** (533 baseline + 69 new — 15 ROM, 13
  trap, 15 console, 26 disk; the brief's "≥ 580" target is met).
- TypeScript strict (`npm run typecheck`): clean — no `any`, no
  `as unknown`, no `// @ts-ignore`.
- SST corpus: **3,007,000 / 3,007,000** pass across 323 files;
  `failed=0 threw=0 dirty_files=0`.

No deviations from the brief. The `register-twice` policy was the one
explicit pick-one-and-document call: `TrapRegistry.register` throws on
overlap (matches the rest of the codebase's "fail loud on configuration
bugs" stance, including `loadROM`'s overlap policy).

## ROM region implementation

`PagedMemory` now tracks a per-page `readonly: boolean` flag on its
`PageSlab` records. RAM pages get `readonly: false` (everywhere a slab
is created — the materialise path, the hydrate path, and the existing
write path); ROM pages get `readonly: true` exclusively via the new
`loadROM` entry point.

Hot-path cost on writes: one extra `if` per `writeByte`. `writeWord`
inherits the check by composing two `writeByte` calls.

```ts
writeByte(addr, v) {
  ...
  const slab = this.pages.get(pageId) ?? this.#materialisePage(pageId);
  if (slab.readonly) return;          // ROM: silent drop
  slab.data[off] = v & 0xFF;
  this.dirty.add(pageId);              // RAM: mark dirty
}
```

The crucial detail is that **the dirty set is never touched on a ROM
write** — neither during `loadROM` (which populates and marks slabs
without entering the dirty set) nor during a subsequent dropped write.
That means `flushDirty()` after a ROM load is a no-op against the
backing `PageStore`, which is what we want: ROM is not persisted, ROM is
not write-back. The `flush after loadROM` test asserts this directly.

`loadROM(linearAddress, bytes)` validates *every* affected page before
mutating *any* of them, so a thrown call leaves memory in its prior
state. Validation:

- Linear address must be page-aligned. (Tested at the page boundary and
  inside a page.)
- `bytes.length` must be a positive multiple of `pageSize`. (Tested for
  empty, off-by-one, and full-page-multiple cases.)
- No page in the affected range may already be a ROM page. (Tested for
  full overlap and partial overlap.)
- No page in the affected range may be in the dirty set. (Tested by
  dirtying a page first, then attempting ROM load over it.)

Two introspection helpers were added next to the existing `hasPage`:

- `isReadOnly(pageId)` — for tests and future tooling. Returns false for
  unmaterialised pages.

The PageSlab definition kept its existing comment about "kept as a
single structure so we can add write-protection flags later" — this
brief is the cash-in on that note.

## Trap registry

`TrapRegistry` is a thin wrapper around `Map<number, TrapHandler>`:
register / unregister / get / size. The whole class is ~60 lines
including doc.

CPU integration (`src/cpu8086/cpu.ts`):

- `CPU8086` constructor now takes an optional 4th argument `traps?:
  TrapRegistry`. When omitted (the existing call shape), the field is
  `undefined` and the trap path is dead code in `step()`.
- The trap lookup happens at the top of `step()` *after* the
  halt-spin/interrupt-boundary block (so halted CPUs don't fire traps
  on every spin-cycle, matching the brief's rationale) and *before* the
  instruction fetch.

```ts
if (this.traps !== undefined) {
  const linearIP = (this.regs.CS << 4) + this.regs.IP;
  const handler = this.traps.get(linearIP);
  if (handler !== undefined) handler(this);
}
```

Hot-path cost when a registry is present and empty: one truthiness
check, one `(CS << 4) + IP` arithmetic, one `Map.get` returning
`undefined`, one truthiness check. When *no* registry is present
(everywhere except Phase 2 BIOS code): the very first truthiness check
short-circuits and the rest is dead code. V8 optimises this fine; the
SST corpus run reported no measurable slowdown vs. baseline.

Subtleties:

- Trap address is *linear* `(CS << 4) + IP`, so different `CS:IP`
  encodings of the same physical byte route to the same handler. The
  test `handler is keyed on the linear CS:IP address` exercises this
  with `0x1000:0x0010` and `0x1001:0x0000`.
- Handler runs *before* the instruction at the trap address. The
  instruction still executes after the handler returns. The "MOV BX,
  AX" test demonstrates this: trap sets `AX=0x1234`, the `MOV BX, AX`
  at the trap address copies it to BX, BX=0x1234.
- A handler that mutates `CS:IP` redirects the upcoming fetch — the
  test `handler may modify CS:IP` confirms the new IP takes effect for
  the same `step()` call.
- Halted CPU does not fire traps. The early-return in the halt-spin
  branch is hit before the trap check; verified by halting the CPU and
  spinning `step()` against a registered handler that increments a
  counter.
- `register` on an already-registered address throws. Same fail-loud
  policy as `loadROM` overlap.

## Console

`Console` interface (`src/console/console.ts`) has exactly three methods:
`writeChar(charCode)`, `readChar() → number | -1`, `hasInput() → bool`.
Higher-level concerns (cursor, ANSI, screen modes) belong to Phase 2's
INT 10h handler, which will compose them out of `writeChar` calls.

`InMemoryConsole` is the test-friendly impl. Output captured as a
`number[]` of code points and exposed as both `output` (a string built
from `String.fromCharCode`) and `outputBytes` (raw codes — useful for
non-printable assertions). Input is a programmable queue (`pushInput`
takes a string or `number[]`). `clearOutput` / `clearInput` reset.

`NodeConsole` is the host-side impl, parameterised so tests can inject
fake stdin/stdout (a small `EventEmitter`) without touching the global
`process` streams. Construction takes `{ stdout?, stdin?,
installExitHook? }`; defaults pull from `process`.

- **Raw mode**: enabled at construction iff `stdin.isTTY === true`. Set
  back to `false` in `close()`. If stdin is piped (`isTTY === false`),
  raw mode is skipped — `setRawMode` would be a no-op or unavailable.
  Either way, the data-event listener is attached, so reads work for
  TTY *and* piped input.
- **Cleanup**: `installExitHook` defaults to true and registers
  `process.on('exit', () => this.close())` so a missed manual `close()`
  doesn't strand the user in raw mode. `close()` is idempotent (second
  call is a no-op — verified by a test).
- **Ctrl-C policy**: byte 0x03 is delivered as an ordinary character.
  Phase 2 / 3 can decide whether to translate it to a host-level signal
  or let the BIOS see it as Ctrl-Break. The tests verify the byte is
  queued.
- **Tests** use a fake stdin EventEmitter that exposes `isTTY`,
  `setRawMode`, `resume`, `on('data')`, `removeAllListeners`, plus an
  `emitData(...)` helper that fires the listener. This keeps the tests
  CI-safe (real stdin in CI is not a TTY) and parallel-safe (no shared
  global state).

## Disk

`Disk` interface (`src/disk/disk.ts`) is sector-based at the LBA level:
`readSector(lba)` and `writeSector(lba, data)`, both 512-byte
exchanges, plus `geometry`, `readonly`, `sectorCount`. CHS↔LBA
translation is the BIOS service handler's job (Phase 2 INT 13h) — the
disk doesn't need to care, and pushing the geometry math up keeps the
disk simple and BIOS-format-agnostic.

Sync, not async, because reads happen inside `cpu.step()` and that's
synchronous. The brief authorises this; it's flagged as "revisit if
perf becomes a problem" in `Watch out for`.

`InMemoryDisk` is a single `Uint8Array` sized to the full disk. Reads
return defensive copies (mutating the returned `Uint8Array` doesn't
poison the storage; verified by a test). Writes copy in. Out-of-range
LBAs throw, including non-integer LBAs. Initial `contents` shorter
than the disk are zero-padded; longer-than-disk throws.

`NodeFileDisk` strategy: load the whole file into a `Uint8Array` cache
at construction, serve reads from the cache, write through the cache to
the file synchronously.

- Geometry is inferred from file size against a small table of standard
  floppy formats (160 KB, 180 KB, 320 KB, 360 KB, 720 KB, 1.2 MB,
  1.44 MB, 2.88 MB). For non-standard sizes (HDs, custom images) the
  caller must supply geometry, and the supplied geometry must match the
  file size or construction throws.
- File opened with `'r'` for `readonly: true`, `'r+'` otherwise. We
  never truncate on open — the image's existing content matters.
- Write-through: `writeSector` updates the cache then `writeSync`s to
  the file. A test reads the file directly (without going through the
  disk class) immediately after a `writeSector` to confirm the bytes
  hit the on-disk image, not just the cache.
- `close()` is idempotent, and operations after `close()` throw with a
  "closed" message.
- Tmp files use `mkdtempSync(join(tmpdir(), …))` and are removed in
  `afterEach` so tests are cross-platform and don't litter `/tmp`.

The "load it all into memory" trade-off is documented in code: floppies
are tiny (1.44 MB), the cache lets us avoid `fs.readSync` blocking
inside `cpu.step()` per sector, and tests are simpler. If a future
brief lands an ELKS HD image where this is a problem, that brief will
revisit.

## Things Phase 2 will need

- **The trap address arithmetic uses linear `CS:IP`, not segmented.**
  When Phase 2 builds the BIOS ROM image, IVT entries point at
  segmented addresses (`F000:0010`); the registry needs the *linear*
  address (`0xF0010`). Phase 2 should expose a small helper or always
  compute via the existing `linearAddress(seg, off)` helper from
  `core/types.ts`.
- **`InMemoryConsole.outputBytes`** as well as `output`. ANSI escape
  testing is easier on raw bytes — Phase 2's INT 10h will probably
  emit ESC sequences and tests will want to inspect them directly.
- **`InMemoryDisk.contents` as a constructor option** is the easiest
  path to load an ELKS image into a Disk for unit tests without
  touching the filesystem. Phase 3 can pass `Uint8Array.from(...)` of
  a pre-loaded image and the test stays hermetic.
- **`Disk` is sync.** The Phase 2 BIOS handler can do disk I/O inside
  `cpu.step()` — no need to mark service handlers async.
- **`SECTOR_SIZE` is exported as `512`.** If Phase 2 wants to support
  CD-ROM-style 2048-byte blocks or 4 KB sectors, the interface needs
  widening — the `Disk` abstraction currently bakes in 512-byte
  sectors. Not relevant for ELKS-on-floppy.
- **ROM-write silent-drop policy.** A guest writing to ROM shows up
  nowhere — no exception, no diagnostic. If the BIOS code does anything
  surprising with that, we may want a debug hook (`onRomWriteAttempt`)
  later. Not needed for Phase 2 itself.
- **`TrapRegistry.register` throws on duplicate registration.** Phase 2
  must register each BIOS service exactly once at construction. If the
  Machine is reset/rebuilt, build a fresh `TrapRegistry`; don't try to
  re-register on the existing one.
- **`NodeConsole` sets raw mode globally.** A long-running BIOS test
  that constructs `NodeConsole` against a real TTY will affect the
  user's terminal. The `installExitHook: false` opt-out is there for
  test environments where you want explicit lifecycle control.

## Verification

Commands run, in order:

```bash
# 1. Baseline confirmed before any changes:
npx vitest run tests/unit/
#   → Test Files  31 passed (31)
#   → Tests       533 passed (533)

# 2. Strict typecheck after all changes:
npm run typecheck
#   → tsc --noEmit && tsc --noEmit -p tsconfig.test.json (clean exit)

# 3. Full unit suite after all changes:
npx vitest run tests/unit/
#   → Test Files  35 passed (35)
#   → Tests       602 passed (602)   [533 + 69 new]

# 4. SST corpus regression:
npx tsc -p tsconfig.cli.json
node dist-cli/tests/sst/baseline-cli.js
#   → SUMMARY: 3007000/3007000 passed across 323 files; failed=0 threw=0 dirty_files=0
```

## Files added / modified

**Added:**
- `src/cpu8086/trap-registry.ts` — `TrapRegistry` class + `TrapHandler`
  type.
- `src/console/console.ts` — `Console`, `InMemoryConsole`,
  `NodeConsole`, plus `NodeConsoleOptions` / `NodeStdinLike`.
- `src/console/index.ts` — barrel.
- `src/disk/disk.ts` — `Disk`, `DiskGeometry`, `InMemoryDisk`,
  `NodeFileDisk`, `SECTOR_SIZE` constant.
- `src/disk/index.ts` — barrel.
- `tests/unit/rom-region.test.ts` — 15 tests.
- `tests/unit/trap-registry.test.ts` — 13 tests.
- `tests/unit/console.test.ts` — 15 tests.
- `tests/unit/disk.test.ts` — 26 tests.

**Modified (additive only — no interface changes to existing types):**
- `src/memory/paged-memory.ts` — `PageSlab.readonly: boolean`,
  ROM-aware `writeByte`, `loadROM`, `isReadOnly`. The materialise and
  hydrate paths both now stamp the new `readonly: false` field on
  RAM/hydrated slabs.
- `src/cpu8086/cpu.ts` — optional `TrapRegistry` constructor argument
  and `traps` field; trap-lookup block in `step()` between the
  inhibit-window clear and the opcode fetch.
- `src/cpu8086/index.ts` — export `TrapRegistry` and `TrapHandler`.
- `src/index.ts` — re-export `./console/index.js` and `./disk/index.js`.
