# emu86 — Agent Brief: Cursor-aware CGA Mirror (Phase 7.1)

## TL;DR

Phase 7's CGA mirror emits character bytes in write order with no
positioning. Symptom: rows run together on the host terminal because
the kernel never writes `\n` to the framebuffer — it writes characters
at cells and advances the cursor. There is no newline byte to emit; we
have to put each character where it belongs.

Single deliverable: replace the stream-style emit with a position-aware
emit. For each character write at framebuffer offset N (even), compute
(row, col) from the offset and emit `ESC[row+1;col+1H<char>`. The host
terminal lays the screen out correctly. Scrolls flicker but are
visually correct; backspace at the prompt erases properly.

CRTC cursor tracking is *not* required for this fix — positioning comes
from the write address. Defer CRTC work to a future brief that wants to
render the guest's cursor on the host terminal.

Document in `CGA_CURSOR_REPORT.md`.

You are working in `emu86/`. Read `KEYBOARD_HARNESS_REPORT.md` (the v0
mirror's own description of what doesn't work, plus the boundary
between `early_printk` via NodeConsole and `console-direct` via the
mirror) and `src/diagnostics/cga-mirror.ts`.

## Hard rules

1. **Don't break existing tests.** 747 passing without corpus / 1070
   with corpus as of Phase 7. All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **You may modify** `src/diagnostics/cga-mirror.ts` — that's the
   deliverable. You may add new files in `src/diagnostics/` if a helper
   genuinely earns its keep.
6. **You may modify** `tools/elks/run.ts` if the harness wiring needs
   adjustment at the early-output / framebuffer-output boundary.
7. **You may NOT modify** `src/cpu8086/`, `src/memory/`, `src/runtime/`,
   `src/interrupts/`, `src/io/`, `src/timing/`, `src/devices/`,
   `src/machine/`, `src/console/`, `src/disk/`, `src/bios/`, or
   `src/host-clock/`. Same locks as Phase 7.
8. **No CRTC port subscription** in this brief. Tempting, not needed
   for the symptom. Out of scope; defer to a follow-up brief if cursor
   rendering becomes desirable.

## Background

Phase 7's mirror subscribes to `writeByte` in the 0xB8000-0xBFFFF range
and emits character bytes at even offsets to a sink. It works for
sequential writes that happen to fill the screen left-to-right
top-to-bottom — the boot banner mostly behaves this way. It fails
visibly the moment the kernel:

- finishes a row mid-screen and starts the next row (no row break),
- backspaces (writes a space at the previous cell, which appears as a
  literal stray space on the host),
- scrolls (rewrites the entire visible region — emit produces 1920
  characters with no positioning).

The user's reported "newline / carriage return dynamic is not quite
right" is the row-break case. The kernel doesn't write CR or LF into
the framebuffer; it writes characters at cell positions. The mirror
must position before emitting.

## Scope

### Position-aware emit

For each character byte write at offset N within the framebuffer
(currently 0xB8000 base, configurable via `start`):

- Compute `cellOffset = (N - start) / 2`.
- Compute `row = floor(cellOffset / 80)`, `col = cellOffset % 80`.
- Emit `ESC [ (row+1) ; (col+1) H` (1-indexed, ANSI convention)
  followed by the character byte to the sink.

Skip writes at odd offsets (attribute bytes) — same as v0.

The mirror should keep track of the last emitted (row, col) and skip
the positioning prefix when the next write is at (row, col+1) — i.e.,
the host terminal cursor is already there from natural advance after
the previous emit. This keeps the output volume reasonable for
sequential text. **Optional optimisation**; if it complicates the code
or the tests, ship without it.

### Boundary with early output

The harness prints `early_printk` traffic via `NodeConsole.writeChar`
(raw bytes to stdout) until ELKS's `console_init` swaps to
`console-direct` and the framebuffer mirror takes over. At that
transition, the host terminal cursor is at end-of-last-early-line.

Two options:

- **A. Clear at boundary**: when the mirror is about to emit its first
  byte, prefix with `ESC [ 2J ESC [ H` (clear screen + home cursor).
  The framebuffer-driven phase starts on a clean canvas.
  Early-printk output scrolls out of view (still in scroll-back).
  Recommended.
- **B. Just start positioning**: the host cursor jumps to (1,1) and
  the mirror starts overwriting whatever's in the visible region.
  Briefly confusing during the transition; correct shortly after.

Pick A unless you find a reason not to. Document the choice.

The capturing test sink doesn't need the clear prefix and shouldn't
get it (it would pollute test assertions). Make the boundary clear a
property of the harness wiring, not the mirror itself — e.g., the
NodeConsole-backed sink emits the clear once on first call; the
test-capturing sink doesn't.

### What stays the same

- Memory-write subscription via the same instrumentation overlay
  pattern as v0 (method replacement at construction time).
- `writeByte`-only wrap (Phase 7's note: `writeWord` decomposes into
  two `writeByte` calls; wrapping both would double-emit).
- Tear-down callback that restores the original `writeByte`.
- `CGAMirrorSink` interface; `CapturingCGASink` for tests.
- Range filtering (writes outside `start`-`end` are ignored).

The signature of `installCGAMirror` shouldn't need to change. If you
need a new option (e.g., `clearOnFirstEmit: boolean`), add it.

### What you are NOT building

- CRTC port tracking (deferred).
- Cursor rendering on the host terminal (deferred).
- Detection and translation of guest scrolls to terminal scroll
  commands (deferred; brief was clear that flicker is acceptable).
- Colour / attribute rendering via ANSI SGR (deferred).
- Mode changes (graphics mode, 40-column mode, different resolutions).
- Arrow keys (separate next brief).
- Keyboard LED ACK (separate brief).

## Tests

### Unit tests

Extend `tests/unit/cga-mirror.test.ts`:

- A character write at cell (0, 0) emits the bytes for
  `ESC [ 1 ; 1 H` followed by the character.
- A character write at cell (5, 10) emits the bytes for
  `ESC [ 6 ; 11 H` followed by the character.
- A character write at cell (24, 79) emits the bytes for
  `ESC [ 25 ; 80 H` followed by the character.
- Two consecutive writes at (5, 10) and (5, 11) emit positioning only
  for the first (or for both, if you skipped the optimisation —
  document either way and assert accordingly).
- Two writes at (5, 10) and (7, 3) emit positioning for both.
- Attribute writes at odd offsets still produce no emission.
- Writes outside `start`-`end` still produce no emission.
- Tear-down still restores `writeByte` cleanly; a write after tear-down
  produces no emission.
- If you implement option A: a sink that wants the clear prefix
  receives it exactly once on first emit, not on subsequent emits.

5-8 new cases. Existing v0 cases that asserted on raw character
streams will need updating to expect the positioning prefix; update
them rather than removing — the cases still document behaviour.

### Integration test

Extend `tests/integration/elks-interactive.test.ts` to assert that
the captured CGA-mirror output for the post-`login: root` shell
session contains the expected positioning prefix immediately before
the `# ` shell prompt's first character. Specifically:

- After the boot phase, find the `ESC [ R ; C H #` sequence in the
  captured output, where R matches the row the prompt should appear at
  (24 if the screen has scrolled, else wherever the post-login
  banner's last row is).
- Don't pin the exact row aggressively — the kernel's exact row
  depends on the boot transcript length. Asserting that *some*
  positioning sequence precedes the `#` is enough.

Don't add a screenshot-diff test — too fragile for this brief.

### Smoke test

The Phase 7 wiring smoke test (the second case in
`tests/integration/elks-interactive.test.ts` that runs without input
and asserts the boot reaches the post-mount banner) should keep
passing. Verify after your changes.

## Watch out for

- **The framebuffer-write order is not row-major.** The kernel writes
  characters one at a time as it generates output, but it can also do
  scrolls (block memmoves) and prompt-echo overwrites. Your code must
  treat each `writeByte` independently — never assume the previous
  write was at (row, col-1).
- **Word writes via `OUT DX, AX` aren't your concern here.** The CPU
  emits port writes through the IO bus, not memory writes. The
  framebuffer is memory; word writes there decompose into two
  `writeByte` calls (Phase 7 verified). Don't touch the IO bus in this
  brief.
- **Off-by-one on ANSI 1-indexing.** ANSI cursor positioning is
  1-based. `ESC [ 1 ; 1 H` is top-left, not `ESC [ 0 ; 0 H`. Cell
  (0, 0) → `ESC [ 1 ; 1 H`.
- **The ESC byte is 0x1B**, not the ASCII letter `E`. Easy to typo;
  test the raw byte sequence.
- **The capturing sink for tests should receive the same positioning
  bytes** as the stdout sink. Tests assert on the byte stream the sink
  receives. The "boundary clear" should be a sink decision (or a
  harness wiring decision), not a property baked into the mirror —
  otherwise tests get polluted.
- **Don't add CRTC tracking by accident.** It's the obvious-looking
  next step and would feel productive, but it's not what this brief
  buys. The user's symptom is fixed by write-address positioning.
  CRTC subscription introduces IO-bus instrumentation, which is a
  meaningful new surface area. Defer.
- **The optimisation (skip positioning when at row, col+1) interacts
  with the boundary clear.** If you implement both, the first write
  after the clear must always include positioning regardless of
  "previous (row, col)" state. Reset the tracker when the clear fires.
- **The harness output volume.** With positioning per-character on
  every framebuffer write, scrolls dump ~30k bytes to stdout in a
  burst. Modern terminals handle this fine; just don't be surprised
  when traces grow.

## Definition of done

**Implementation success**:
- `npm run start:elks` boots ELKS, the prompt and shell output appear
  with correct row breaks, typed input echoes correctly, backspace
  visibly erases the previous character at the prompt.
- The kernel banner is rendered as 80-column rows on the host
  terminal, not as one wrap-running stream.

**Test counts**:
- All existing tests pass (updated for the new positioning prefix
  where applicable).
- New / updated tests cover the cases above.
- Total ≥ 750 (non-corpus).

**Verification**:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).
- Manual: `npm run start:elks`, boot to `login:`, log in as root,
  type `ls`, observe correctly-laid-out output. Compare to v0
  side-by-side; the difference should be obvious.

The report at `CGA_CURSOR_REPORT.md` has these sections:

- **Summary**: outcome, key technical choices made.
- **Position emit strategy**: positioning per write-address; whether
  the optimisation was implemented; what the emit byte stream looks
  like for a typical row of text.
- **Boundary handling**: option A or B, where the clear lives in the
  wiring, how tests avoid pollution from it.
- **What v0 tests changed**: which existing assertions were updated,
  why, and what they assert now.
- **What still doesn't work**: CRTC-driven cursor rendering on the
  host, colour, scroll-as-scroll (still flickers), graphics modes.
  Documented v0+1 limitations.
- **Things future briefs should address**: CRTC tracking, colour
  rendering, arrow / function keys, keyboard LED ACK.
- **CPU/memory bug candidates**: anything noticed during the heavier
  scroll-flicker workload that wasn't visible before.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`src/diagnostics/cga-mirror.ts`** — the v0 you're evolving.
2. **`tools/elks/run.ts`** — harness wiring; the boundary between
   NodeConsole.writeChar and the mirror lives here.
3. **`tests/unit/cga-mirror.test.ts`** — existing 7 cases; extend.
4. **`tests/integration/elks-interactive.test.ts`** — extend the
   integration assertions; keep the smoke test green.
5. **ANSI X3.64 / ECMA-48** for the cursor positioning sequence
   (`CSI Pn ; Pn H`). Any contemporary terminal-control reference is
   fine; the sequence is `ESC [ row ; col H` 1-indexed.

## Final notes

This is a small, focused brief — one concern, one file mostly. The
discipline this brief asks for is *not* expanding into CRTC tracking
or colour rendering just because they're nearby. The user's symptom
has a precise cause and a precise fix; ship the fix.

After this lands, the next polish brief is arrow / function keys
(stdin-side state machine; orthogonal to the mirror). The brief after
that is keyboard LED ACK (smaller still). Then the substrate is in a
position to start the browser deployment with a Node-side experience
that genuinely works.
