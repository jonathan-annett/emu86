# CGA Cursor-Aware Mirror Report (Phase 7.1)

## Summary

The Phase 7 CGA mirror emitted character bytes in write order with no
positioning. The host terminal printed everything as one running stream,
so the kernel banner ran together, the post-login prompt appeared on
the same line as the previous output, scrolls left a smear, and
backspace at the prompt produced a stray space instead of an erase.

This brief replaced the stream-style emit with a position-aware emit.
For each character byte the CPU writes to the framebuffer, the mirror
now computes `(row, col)` from the write address and prefixes the
character with an ANSI cursor-position sequence
`ESC [ row+1 ; col+1 H`. The host terminal lays the screen out
correctly: rows break at row boundaries, scrolls flicker but are
visually correct, and backspace at the prompt erases properly because
the kernel's "write space at previous cell" lands at the right column
instead of trailing the cursor.

Key technical choices:

- **Position from write address, not from CRTC.** The brief was
  explicit: CRTC subscription is tempting but not needed for the
  reported symptom. Defer it to a future brief that wants to render
  the guest's cursor on the host terminal.
- **Run-length optimisation.** Track the last emitted `(row, col)`;
  when the next write is at `(row, col+1)`, skip the positioning
  prefix because the host terminal cursor is already there from the
  previous emit's natural advance. Sequential text (the dominant case)
  emits one positioning prefix per row instead of one per character.
- **Boundary clear lives in a sink wrapper, not the mirror.** A new
  `OneShotPrefixSink` wraps the stdout sink in `tools/elks/run.ts` and
  emits `ESC [ 2J ESC [ H` exactly once before the first
  framebuffer-driven character. The capturing test sink doesn't get
  this wrapper, so unit-test assertions on the per-emit byte stream
  stay clean.
- **No new options on `installCGAMirror`.** Signature unchanged from
  Phase 7. Optimisation always on; boundary clear is a wiring choice.

Test counts: 756 passing (was 747 in Phase 7). Nine new unit cases
covering positioning, the optimisation, the wrapper sink, plus one new
integration assertion. Typecheck clean. Manual harness verification
confirms the symptom is gone.

## Position emit strategy

Every framebuffer `writeByte` at an even offset within the watched
range (default 0xB8000–0xBFFFF) goes through the mirror:

```
cellOffset = (addr - start) >> 1
row        = floor(cellOffset / 80)
col        = cellOffset % 80
```

The mirror then decides whether to emit a positioning prefix:

- **First emit ever, or the first emit after install / tear-down /
  re-install:** the tracker holds sentinels `lastRow = -1`,
  `lastCol = -1`, so the equality check
  `(row === lastRow && col === lastCol + 1)` is false and the prefix
  is emitted.
- **Consecutive same-row write at `col+1`:** the equality check
  succeeds and the prefix is skipped. The host terminal's natural
  cursor advance after the previous emit puts us where we need to be.
- **Anything else** (row change, gap in columns, going backwards):
  prefix is emitted.

After the per-byte decision, the mirror emits the character byte and
updates `(lastRow, lastCol) = (row, col)`. Attribute writes (odd
offsets) and out-of-range writes return early without touching the
tracker, so they don't disturb the optimisation.

The positioning prefix is built one byte at a time directly from
constants (`0x1B 0x5B`, decimal digits via `String(n).charCodeAt(...)`,
`0x3B`, decimal digits, `0x48`). The brief warned about typing the ESC
byte as the letter `E`; using the literal `0x1B` makes that
impossible.

### What a typical row of text looks like on the wire

For the banner line `xms: 34816K, ...` written at framebuffer row 4
column 0, the mirror emits:

```
ESC [ 5 ; 1 H  x  m  s  :     3  4  8  1  6  K  ,  ...
```

Twelve bytes of cursor positioning followed by the full row of
characters. The next row's first character resets the prefix; everything
in between rides the column-advance optimisation. For a 70-character
row that's ~12 bytes of overhead instead of ~840 (the unoptimised
prefix-every-byte case).

For a screen scroll (the kernel rewrites all 25 rows), there's one
positioning prefix per row, giving ~300 bytes of overhead on top of
the 2000-character payload — a small fraction of the burst.

## Boundary handling (option A)

The harness has two output paths:

1. `NodeConsole.writeChar` for `early_printk` traffic (raw bytes via
   BIOS INT 10h AH=0Eh — about 187 bytes through the kernel's early
   window). These print to stdout without positioning.
2. The position-aware CGA mirror, active from `console_init` onwards.

At the transition the host terminal cursor is sitting wherever the
last early-printk byte left it. If the mirror's first emit positions
to e.g. (5,1) and starts overwriting, the early-printk lines remain
visible above the framebuffer-rendered region, which is briefly
confusing.

We picked option A from the brief: emit `ESC [ 2J ESC [ H` (clear
screen + home cursor) once at the boundary. Early-printk output stays
in the terminal scroll-back; the framebuffer phase starts on a clean
visible region.

The clear lives in `tools/elks/run.ts`, wrapping the `StdoutCGASink`
in a `OneShotPrefixSink(stdoutSink, CLEAR_AND_HOME)`:

- `OneShotPrefixSink` (in `src/diagnostics/cga-mirror.ts`) takes an
  inner sink and a fixed byte sequence. The sequence is emitted to
  the inner sink exactly once, immediately before the first forwarded
  `writeChar`.
- `CLEAR_AND_HOME` is exported from the same module and equals
  `[0x1B, 0x5B, 0x32, 0x4A, 0x1B, 0x5B, 0x48]`.

Tests use raw `CapturingCGASink`, never the wrapper, so they don't see
the clear and assertions on the byte stream stay precise.

The integration test does not assert on the boundary clear, only on
the presence of a positioning sequence before the `#` prompt. That
assertion is robust to whether the harness wraps or not.

## What v0 tests changed

`tests/unit/cga-mirror.test.ts` had seven cases asserting on raw
character streams (e.g., `expect(sink.text).toBe('Hi')`). Five of them
needed the new positioning prefix in the expected value:

| Case (was)                                                | Now asserts                                                                |
|-----------------------------------------------------------|-----------------------------------------------------------------------------|
| `writeByte at the framebuffer base emits the character byte` | `ESC [ 1 ; 1 H` + the character. Renamed to clarify the prefix.             |
| `writeByte at odd (attribute) offsets is filtered out`     | `ESC [ 1 ; 1 H X` (the position prefix appears once, before the X)         |
| `writeWord delivers low byte (char) ...`                   | `ESC [ 1 ; 1 H A B` — note `B` has no prefix because (0,0)→(0,1) is consecutive (the optimisation under test). |
| `writes outside ... never reach the sink`                  | `ESC [ 1 ; 1 H D` — the in-range write still produces its prefix.          |
| `tear-down restores ...`                                    | `ESC [ 1 ; 1 H X` for the in-mirror write; empty for the post-teardown write. |
| `a sequential row of writes produces the expected text`    | `ESC [ 1 ; 1 H` followed by the full message — one prefix at the start.    |

The `tear-down callback is idempotent` case asserted nothing about
emit content, so it stayed unchanged. Two cases (basic emit and
sequential row) were renamed and split out into new descriptions to
match the new behaviour they document.

Nine new cases were added on top:

- Three corner positions: cell `(0,0)` → `ESC [ 1 ; 1 H`, cell
  `(5,10)` → `ESC [ 6 ; 11 H`, cell `(24,79)` → `ESC [ 25 ; 80 H`.
- Two consecutive writes at `(5,10)` and `(5,11)`: prefix only on the
  first.
- Two writes at `(5,10)` and `(7,3)`: prefix on both (rows differ).
- Two same-row writes with a gap (`(3,10)` then `(3,12)`): prefix on
  both.
- A sequential 12-character row: prefix once at the start.
- Four `OneShotPrefixSink` cases: prefix fires exactly once, doesn't
  fire if no write ever lands, forwards every byte verbatim, and
  end-to-end with the mirror produces clear-then-position-then-text.

Total in `cga-mirror.test.ts`: 16 (was 7).

`tests/integration/elks-interactive.test.ts` got one new assertion in
the existing `scripted "root\n" reaches the # shell prompt` case:

```ts
expect(sink.text).toMatch(/\x1B\[\d+;\d+H#/);
```

The brief asked for *some* positioning sequence preceding the `#`
character somewhere in the captured stream. Pinning the row would be
fragile — the kernel's exact row depends on whether the screen has
scrolled by the time the prompt is written.

The smoke-test second case (`harness-style wiring ... does not regress
the boot path`) needed no changes; it asserts on the framebuffer
contents (read directly via `dumpVideoText`), not on the captured
sink stream.

## What still doesn't work

Documented v0+1 limitations, all explicitly out of scope per the brief:

- **CRTC-driven cursor rendering on the host terminal.** The mirror
  positions before each character it emits, but it does not track the
  guest's CRTC cursor (ports 0x3D4 / 0x3D5 with registers 0x0E /
  0x0F). When the kernel moves the cursor without writing a character
  (e.g., to park the cursor at the prompt position after echoing
  characters), the host terminal cursor stays where the last
  framebuffer write put it. Visible at the prompt: the cursor sometimes
  sits one column past where the kernel intends.
- **Colour / attribute rendering.** Attribute bytes are still dropped.
  Inverted text, coloured prompts, and bright vs. dim text all render
  in the host terminal's default attribute. ANSI SGR translation is
  out of scope.
- **Scrolls render as flicker.** When the kernel rewrites all 25 rows
  to scroll content up, the mirror dutifully positions to each cell
  and emits the character. The host terminal sees ~2300 bytes of
  positioning + payload in a burst. Modern terminals handle it, but
  there's a brief visible re-paint. A future brief could detect
  scrolls (large block memmoves with the same pattern) and emit a
  single ANSI scroll command, but the brief was clear that flicker is
  acceptable.
- **Graphics mode, 40-column mode, alternate text-mode resolutions.**
  The mirror assumes 80-column text mode. Switches to graphics mode
  (e.g., for a logo splash) would render as garbage; ELKS doesn't do
  this, so it hasn't bitten.
- **Arrow keys and function keys.** Stdin still doesn't grow a
  multi-byte ESC-prefix state machine; arrow keys forward as separate
  ESC, `[`, `A` bytes. Separate next brief.
- **Keyboard LED ACK.** Still warn-and-discard. Separate brief.

## Things future briefs should address

Roughly in priority order:

1. **CRTC port subscription.** Wire the IO bus to observe writes to
   ports 0x3D4 / 0x3D5 (index then data). When register 0x0E (high)
   or 0x0F (low) changes, compute `(row, col)` from the resulting
   16-bit cursor position and emit `ESC [ row+1 ; col+1 H` to the
   sink. Combined with this brief's per-character positioning, the
   host cursor would track the guest's intent precisely. This is
   meaningful new surface area (IO-bus instrumentation, not just
   memory-bus), so it deserves its own brief.
2. **Arrow / function key support.** Multi-byte stdin state machine
   for ESC-prefixed CSI sequences → 0xE0-prefixed extended scancodes.
   Without this, history navigation in the shell line-editor is
   limited to Ctrl-P / Ctrl-N if the shell binds them.
3. **Keyboard LED ACK.** Reply 0xFA when the kernel writes 0xED to
   port 0x60; satisfy the kernel's LED state machine and silence the
   warning. Cosmetic but cheap.
4. **Colour / SGR rendering.** Hook attribute writes (the odd-offset
   writes the mirror currently drops) and emit ANSI SGR sequences
   when the foreground / background changes. Trickier than positioning
   because the attribute applies to the *next* character and may not
   match what's already been emitted; would need a small pending-attr
   tracker.
5. **Scroll detection and translation.** Detect when the kernel does
   a block memmove that shifts the visible region by one row and emit
   `ESC [ S` instead of redrawing. Removes the flicker.
6. **Browser harness.** With the mirror's sink interface unchanged,
   plugging a canvas-backed sink into a `BrowserConsole` is the next
   substantive milestone after the input briefs land.

## CPU/memory bug candidates

None observed during the heavier scroll-flicker workload. With
positioning per character, scrolls now emit ~30k bytes per scroll
event to stdout — a meaningful step up in mirror traffic from Phase 7
— and the run path through the substrate is unchanged. Boot reaches
the `#` prompt; typing `ls` invokes the binary, prints its output,
returns to the prompt; quit-prefix exits cleanly. No subtle CPU-flag
or memory-aliasing bug surfaces.

The Phase 6 long-probe baseline still reproduces (per Phase 7's
note); this brief's changes are entirely above the substrate (mirror +
sink wiring + tests), so the substrate behaviour is by construction
unchanged.

## Verification

```
$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json
# clean

$ npm test
 Test Files  47 passed | 1 skipped (48)
      Tests  756 passed (756)
   Duration  ~32s
# 747 prior tests + 9 new (cga-mirror.test.ts grew from 7 to 16 cases).
# tests/sst/corpus.test.ts is skipped: the SingleStepTests data corpus
# is not installed in this environment (gated on corpusAvailable()).

$ npx tsc -p tsconfig.cli.json
# clean

$ ( sleep 3 ; printf 'root\n' ; sleep 6 ; printf 'ls\n' ; sleep 3 ; printf '\x01x' ) \
    | timeout 30 node dist-cli/tools/elks/run.js
# Boot transcript renders with each banner line at its row, the
# screen scrolls correctly, "[1.29 secs] login: root" appears at row
# 23, "# ls" lands at row 24, the second "# " prompt sits at row 25,
# quit prefix exits cleanly. Captured stream contains positioning
# sequences like [4;1H, [16;14H, [24;1H# ls, etc.
```

## Files changed

- `src/diagnostics/cga-mirror.ts` — replaced stream-style emit with
  position-aware emit (compute `(row, col)` per write, emit ANSI
  cursor-position prefix). Added run-length optimisation tracking
  `(lastRow, lastCol)`. Added `CGA_TEXT_COLS` constant,
  `OneShotPrefixSink` wrapper class, and `CLEAR_AND_HOME` constant.
- `src/diagnostics/index.ts` — re-export the new symbols.
- `tools/elks/run.ts` — wrap the `StdoutCGASink` in
  `OneShotPrefixSink(..., CLEAR_AND_HOME)` so the boundary clear
  fires once at the early-printk → framebuffer transition.
- `tests/unit/cga-mirror.test.ts` — updated five existing cases for
  the new positioning prefix; added nine new cases covering corner
  cells, the optimisation, and the wrapper sink. Total: 16.
- `tests/integration/elks-interactive.test.ts` — added the
  `expect(sink.text).toMatch(/\x1B\[\d+;\d+H#/)` assertion in the
  scripted-input case.

No changes under `src/cpu8086/`, `src/memory/`, `src/runtime/`,
`src/interrupts/`, `src/io/`, `src/timing/`, `src/devices/`,
`src/machine/`, `src/console/`, `src/disk/`, `src/bios/`, or
`src/host-clock/`. Same locks as Phase 7. The only memory-bus contact
remains the existing `writeByte` overlay installed at construction
time — exactly the pattern the brief authorises.
