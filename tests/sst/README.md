# SingleStepTests harness

This directory contains the harness that runs [SingleStepTests/8088](https://github.com/SingleStepTests/8088)-format test cases against the emulator. Each JSON file in that corpus corresponds to one opcode (or opcode+ModR/M group) and contains thousands of per-instruction cases: initial state → one instruction → expected final state.

## Wiring up the real corpus (when ready)

1. Clone the corpus somewhere outside this repo (it's ~1 GB).
   ```
   git clone --depth 1 https://github.com/SingleStepTests/8088.git
   ```
2. Symlink the `v1/` directory to `tests/sst/data/`:
   ```
   ln -s /path/to/8088/v1 tests/sst/data
   ```
   (`.gitignore` already excludes `tests/sst/data/`.)
3. Add a loader test that iterates `data/<opcode>.json` files through `runSSTCase`. The loader doesn't exist yet — add it when we have enough opcodes implemented to run a meaningful subset.

## Format

Each file is a JSON array of objects shaped like `SSTCase` in `types.ts`:
```json
[
  {
    "name": "mov ax, 0x1234",
    "initial": {
      "regs": { "ax": 0, "cs": 0, "ip": 0, "flags": 61442 },
      "ram": [[0, 184], [1, 52], [2, 18]]
    },
    "final": {
      "regs": { "ax": 4660, "cs": 0, "ip": 3, "flags": 61442 },
      "ram": []
    },
    "cycles": [...]
  }
]
```

The `ram` field contains `[address, byte]` pairs. Instruction bytes live in `initial.ram` at CS*16+IP; there is no separate "bytes" field.

## Known corpus quirks

- **Undefined flags**: some instructions (MUL/DIV flag aftermath, shifts of CL>1) leave certain flag bits in "undefined" states. The corpus reports whatever the real 8088 produced, which may not be what a mathematically clean implementation computes. Use `runSSTCase(tc, { flagsMask })` to ignore those bits when your implementation intentionally differs.
- **Reserved bits**: the 8086 forces bits 12–15 and bit 1 of FLAGS to fixed values; the corpus's flag values should match, but if they don't, mask them out.
- **Opcode 0x8F with reg field ≠ 0**: reserved encoding, undefined behavior. Skip.
