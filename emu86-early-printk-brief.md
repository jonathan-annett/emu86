# emu86 — Agent Brief: Early-printk to Serial (Phase 9.1)

## TL;DR

Close the deferred Phase 8 item and the UX rough edge Phase 9
surfaced: ELKS prints kernel messages via `early_printk` for the
first ~3 seconds of boot, before `set_console` redirects to ttyS0.
In the Node serial harness those bytes still reach stdout via the
BIOS / NodeConsole path so the user sees them. In the browser
harness they reach `BrowserConsole.writeChar` but go nowhere visible
because xterm.js was wired to UART TX only — leading to a 3-second
blank xterm window before the kernel banner appears.

The deferral comment in the Phase 8 report describes this as
"early-printk reaching serial." That phrasing reflects the most
robust possible fix (route early-printk to the UART so all output
flows through one path), but the *user-visible symptom* — blank
window — has a smaller fix too: surface the early-printk bytes that
already reach `BrowserConsole.writeChar` to xterm.js. Diagnosis
determines which fix to ship.

Exploratory in the Phase 5 / 6 / 8 sense. Diagnose first. Multiple
acceptable outcomes defined below.

Document everything in `EARLY_PRINTK_REPORT.md`.

You are working in `emu86/`. Read `SERIAL_CONSOLE_REPORT.md`
(deferral list, the `set_console` redirect mechanism) and
`BROWSER_HARNESS_REPORT.md` (BrowserConsole wiring, the worker host's
TX coalescing, the data flow diagram). The Node serial harness
`tools/elks/run-serial.ts` and the worker host `src/browser/worker-
host.ts` are the two integration points. ELKS source at
`reference/elks/`.

## Why this work

Phase 9 produced a runnable browser harness, but the first
impression has a 3-second dead window where nothing shows. A user
opening the page sees a blank xterm before any output appears. Real
hardware doesn't do this; the Node harness doesn't do this. It's
the rough edge most likely to make the browser feel unfinished.

The Phase 8 deferral list has this as a known item. Closing it now,
while serial wiring is fresh, is cheap. The work also benefits the
Node serial harness in any path where `BrowserConsole`'s sibling
path matters — though Node's NodeConsole already writes early-printk
to stdout, so the Node side may need no change beyond verification.

## Hard rules

1. **Don't break existing tests.** 806 passing without corpus / 1129
   with corpus as of Phase 9. All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **Diagnose before you implement.** Read the ELKS early_printk
   path in source. Decide between Outcomes A / B / C below based on
   evidence. Phase 5's discipline.
6. **You may add** unit tests for any new wiring, integration tests
   for the boot transcript, and (only if Outcome A is taken) a small
   helper module under `src/browser/` or `tools/elks/`.
7. **You may modify** `src/browser/worker-host.ts`,
   `src/browser/browser-console.ts`, `tools/elks/run-serial.ts`,
   and the existing harness wiring if Outcome A or B requires it.
8. **You may NOT modify** `src/cpu8086/`, `src/memory/`,
   `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
   `src/devices/` (including the UART), `src/console/`, `src/disk/`,
   `src/bios/`, `src/host-clock/`, `src/diagnostics/`, or
   `src/machine/ibm-pc.ts` internals. Same locks as Phase 8 / 9.
9. **No fix-and-pray on ELKS configuration.** If Outcome C looks
   like it needs a kernel rebuild and the toolchain is missing,
   *don't* patch the binary. Document the blocker. Outcome A or B
   is acceptable as a complete deliverable.
10. **No CGA-canvas, no image upload, no settings UI.** All
    explicitly out of scope per the user's brief direction.

## Background

The substrate has two concurrent output paths during early boot:

- **BIOS INT 10h teletype output** — driven by ELKS's `early_printk`
  before `set_console` reroutes to a real device. Bytes go through
  the BIOS service handlers, which in our implementation forward to
  `Console.writeChar`. In Node this is `process.stdout.write`; in
  browser this is `BrowserConsole.writeChar`, which is wired to the
  shared `txBuffer` in the worker host.
- **CGA framebuffer writes** — same `early_printk` path also writes
  to 0xB8000 directly so a real PC can see boot output. The Phase 7
  CGA mirror picks these up; the browser harness doesn't render the
  framebuffer (no canvas).

After `console_init` the kernel calls `set_console` which selects
ttyS0 (per the `console=ttyS0` boot config). All subsequent output
goes through the UART driver to port 0x3F8.

**The Phase 9 worker host wires:**

- UART `onTransmit(byte)` → `txBuffer.push(byte)` → flushed to main
  thread via `tx` message → xterm.js.
- `BrowserConsole.writeChar(byte)` → also pushes to `txBuffer`
  (per Phase 9 report's section 3 wiring).

If the second wiring is real and working, the early-printk bytes
should already be reaching xterm.js. So the diagnosis question is:
*why isn't the user seeing them?*

Possible explanations (the diagnosis section will determine which):

1. **The wiring is correct but `early_printk` doesn't go through
   BIOS INT 10h.** ELKS writes directly to the CGA framebuffer for
   `early_printk`, bypassing INT 10h. `BrowserConsole.writeChar`
   never sees the bytes.
2. **The wiring goes to `txBuffer` but `flushTx` only fires after
   the boot batch completes.** If the `txBuffer` accumulates 5000
   instructions of bytes before flushing, the user perceives a delay
   that matches the 3-second window.
3. **The wiring works but the bytes are emitted as raw CGA text
   layout** (with attribute interleaving from how the framebuffer is
   structured) rather than as a clean stream. xterm.js renders them
   but they look like garbage.
4. **Some combination** — e.g., the first dozen bytes go via INT 10h
   and reach xterm.js, but the bulk of `early_printk` is direct
   framebuffer writes that don't.

Each leads to a different fix.

## Scope

### Section 1 — diagnosis (mandatory first step)

Answer concretely in the report:

1. **What does ELKS's `early_printk` actually do?** Cite source files
   and line numbers. Specifically: does it write to the CGA
   framebuffer directly (memory writes to 0xB8000), use BIOS INT
   10h, or some combination?
2. **What is the `set_console` flow?** When does it run, what does
   it do to redirect output, and what state is `early_printk` output
   in immediately before and after the redirect?
3. **What does `BrowserConsole.writeChar` actually receive during
   early boot?** Instrument or trace: log every byte that hits
   `writeChar` during the first 5 M instructions of a boot. Compare
   that byte stream to what the user expects to see (kernel banner
   etc.). What's missing?
4. **What is the CGA mirror seeing during early boot?** It's
   instrumented for Phase 7 — its sink in the worker host is
   wired to nothing (NullSink or similar). Run a probe: capture the
   framebuffer writes during early boot and compare. If the kernel
   banner is visible there but absent from `BrowserConsole`, that
   confirms direct-framebuffer is the path.
5. **Is there a build-time or runtime config that routes
   `early_printk` to serial?** Search the kernel config / source for
   any `early_printk` redirection. ELKS may already support
   `earlyprintk=ttyS0` or equivalent.
6. **Does the Node serial harness see early-printk via stdout?**
   Verify: run `npm run start:elks-serial`, capture stdout from the
   first second, confirm whether the `Booting...` and kernel banner
   bytes appear. The Node harness's NodeConsole writes to stdout
   directly; if they appear there, the BIOS INT 10h path is live in
   Node and the question is just why those bytes aren't reaching
   the browser xterm.

This section determines outcome. Do not skip.

### Section 2 — outcomes

Three success outcomes, ordered by preference:

**Outcome A: surface what's already reaching `BrowserConsole`.**

If the diagnosis shows that `BrowserConsole.writeChar` *is* receiving
early-printk bytes but they aren't reaching xterm.js due to a wiring
gap (txBuffer not flushed, flushed too late, mis-routed), the fix is
plumbing in the worker host or main thread.

Implementation:
- Identify the gap (most likely candidates: `txBuffer` flush timing,
  or BrowserConsole sink wired but not actually emitting, or a path
  that's silently dropping bytes).
- Close the gap. Likely a one-or-two-line fix in the worker host or
  BrowserConsole.
- Add a unit test that asserts `BrowserConsole.writeChar` bytes
  reach the TX message stream within the same chunk they arrive in.
- Add an integration test that captures the first 50 ms of boot
  output and asserts it contains expected `early_printk`-shaped
  content (e.g., the `Booting...` string, if that's what the
  diagnosis showed).

**Outcome B: bridge from CGA framebuffer to BrowserConsole TX
during early boot.**

If the diagnosis shows that `early_printk` writes directly to the
framebuffer and BIOS INT 10h is *not* exercised (so
`BrowserConsole.writeChar` legitimately receives nothing), the fix
is to give the browser worker host a CGA-mirror sink that emits to
xterm.js until `set_console` fires.

Implementation:
- Wire the existing CGA mirror's sink (in the worker host) to a sink
  that emits to the same TX buffer xterm.js consumes.
- The sink decodes the CGA framebuffer writes — character bytes at
  even offsets — and pushes them to txBuffer. (The Phase 7.1
  cursor-aware mirror already produces ANSI-positioned output;
  emitting the raw character bytes plus the position prefix to
  xterm.js renders correctly.)
- Detect the moment `set_console` redirects to ttyS0. After this
  point, both the UART and the CGA mirror are emitting the same
  bytes — would double-print. Either:
  - Disable the CGA-mirror-to-xterm sink at this point (easier);
    requires detecting `set_console` (perhaps by watching for the
    first UART TX byte and assuming the redirect has happened).
  - Keep both active and let the user see double output (clearly
    wrong; reject).
  - Track which output path is "active" and switch (more
    complicated).
- Add a unit test for the bridging sink.
- Add an integration test that asserts the first 500 ms of browser
  TX output contains expected early-printk content.

This is the "early-printk reaching serial" interpretation that the
Phase 8 deferral list described. It's more invasive than Outcome A
but uses the substrate that already exists (the CGA mirror is
already running in the worker host with a NullSink; we just give it
a real sink).

**Outcome C: kernel-level reroute via config or rebuild.**

If both outcomes above are blocked (e.g., the CGA framebuffer writes
are bypassed when `console=ttyS0`, *and* the BIOS INT 10h path
isn't exercised either, so neither wiring delivers anything), the
fix is at the kernel level: rebuild ELKS to route `early_printk`
to ttyS0 directly.

Implementation:
- Cite the relevant ELKS config option.
- Confirm the toolchain (ia16-gcc, dev86) is available; if not,
  *stop and document*.
- Rebuild the serial-console image with the relevant flag.
- Replace `reference/elks-images-serial/fd1440-fat-serial.img` (or
  produce a sibling image, with a script update to use it).
- Verify the boot transcript now reaches the UART from instruction
  zero.

If the toolchain is missing, ship Outcome A or B if possible. If
all three are blocked, ship a diagnosis-only report with concrete
next steps — same shape as Phase 8 Outcome C. **This is acceptable
completion**, not failure.

### Section 3 — what you are NOT building

- CGA-canvas renderer for graphics-mode display. Out of scope.
- Image upload UI. Out of scope per user direction.
- Settings UI (font size, theme, image URL). Out of scope per user
  direction.
- Snapshot / restore. Different brief.
- Network device. Different brief.
- A "full" framebuffer-to-terminal renderer. Outcome B's CGA
  bridge is just for the early-printk window; it stops once serial
  takes over.
- Removing or polishing the CGA mirror beyond what Outcome B needs.

## Tests

### Unit tests

Depending on outcome:

- **Outcome A**: 2-4 cases asserting that `BrowserConsole.writeChar`
  bytes reach the TX flush within the same chunk. Cases for:
  byte arrives mid-chunk and is flushed at end-of-chunk; multiple
  bytes coalesce; the path is independent from the UART TX path
  (closing the UART doesn't drop BrowserConsole bytes, vice versa).
- **Outcome B**: 4-6 cases on the CGA-to-TX bridging sink. Cases:
  character byte at even offset reaches TX; attribute byte at odd
  offset doesn't; positioning prefix is included; the bridge is
  disabled correctly at `set_console` (or whatever signal is used);
  enabling/disabling is idempotent.
- **Outcome C**: only the existing serial integration test needs
  re-verification with the new image; possibly extend it to assert
  earlier banner content.

### Integration tests

Add a case to `tests/integration/browser-worker-host.test.ts`:
- Boot for the first N instructions (where N is small enough to
  capture early-printk but not late enough to reach the
  `set_console` redirect).
- Assert the captured TX bytes include expected early-printk-shaped
  content.

If Outcome B, also extend with:
- Boot past `set_console`. Assert no double-output (the CGA bridge
  has been disabled, only UART TX bytes are arriving).

If Outcome C, the existing serial integration test should now
contain banner content from instruction zero. Extend assertions.

### Smoke tests

The existing browser-worker-host integration test (the boot-to-`# `
case) and the Node serial integration test must both continue
passing. Verify after your changes.

## Watch out for

- **Don't conflate "user sees it" with "bytes arrive."** The
  diagnosis section asks specifically about bytes reaching
  `BrowserConsole.writeChar`, not about what the user perceives. The
  former is testable; the latter is downstream of it. Get the
  measurements right first.
- **The 5000-instruction chunk size is not the bug.** Chunked TX
  flush is desirable for performance. If diagnosis suggests
  shrinking the chunk, that's symptom-treating. The real fix is
  upstream — bytes arriving in the right place.
- **`set_console` detection is fragile.** Outcome B needs to know
  when to disable the CGA bridge. Watching the first UART TX byte
  is a reasonable proxy but not perfect (the kernel might emit a
  CGA write *and* a UART write for the same character during the
  transition). Document the chosen heuristic clearly; accept some
  imprecision as long as it's bounded.
- **The CGA mirror's positioning prefix.** The Phase 7.1 mirror
  emits ANSI cursor-positioning sequences before each character so
  the host terminal lays the screen out correctly. xterm.js
  consumes these directly — that's fine. But the positioning
  prefixes will move xterm's cursor around in ways that look
  *different* from how the same content reaches xterm via UART
  (which is a clean byte stream). Decide whether this is acceptable
  visual artifact or whether the bridging sink should strip the
  positioning. Default to acceptable; the alternative is more
  surface area for v0.
- **Double output on the boundary.** If both UART and CGA-bridge are
  emitting concurrently for even one character, the user sees it
  twice. Worse than a 3-second blank window. Aggressively avoid.
- **Node-side regression.** The Node serial harness already shows
  early-printk via stdout (verify in diagnosis). Make sure your
  changes don't somehow disable that path.
- **Test instruction-count budgets.** Capturing "the first N
  instructions" of boot needs N tuned to land before `set_console`.
  Make this configurable in the test, not hard-coded.

## Definition of done

**Outcome A or B (full success):**
- The browser harness shows kernel boot output from the first
  second of the boot, not from the 3-second mark.
- Manual: open the dev server in a browser; the early-printk window
  is gone or substantially reduced.
- Integration tests pass with the early-printk content asserted.
- Node serial harness still shows early-printk (no regression).
- All prior tests green.
- Total tests ≥ 810.

**Outcome C (rebuild or diagnosis-only):**
- Diagnosis section in report fully populated with citations.
- If rebuild: new image produced, harness updated, integration test
  asserts earlier banner.
- If diagnosis-only: report's "what's needed to unblock" section is
  concrete enough that a follow-up brief is straightforward.
- All prior tests green.

In any case:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).
- Release snapshot at `releases/phase-9-1-early-printk/` populated
  and manually launch-verified (see Release snapshot section).

## Release snapshot

After all verification commands pass and before writing the report,
copy the working artefacts to a self-contained release folder.

Layout:

```
releases/phase-9-1-early-printk/
├── README.md                # launch commands + what's new
├── package.json             # copy of root manifest
├── package-lock.json        # copy of root lockfile
├── dist-cli/                # compiled Node CLI tools
├── dist-web/                # Vite production bundle
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied. Releases share the repo root's
installed dependencies.

Verify the snapshot is launchable manually:
- Launch the Node serial harness from within the release folder;
  confirm it boots to `# `.
- Launch a static server against `dist-web/`; open in a browser;
  confirm the early-printk window is closed (boot output appears
  immediately, not after 3 seconds).

Document both commands and their successful outputs in the report
under a "Release snapshot" section.

## Watch the report contains

The report at `EARLY_PRINTK_REPORT.md` has these sections:

- **Summary**: outcome (A / B / C), key technical choices.
- **Diagnosis**: answers to all section-1 questions with file
  citations.
- **Implementation**: the chosen path; for Outcome A, the wiring
  gap and its fix; for Outcome B, the bridging sink and the
  `set_console` detection heuristic; for Outcome C, the rebuild
  steps or the unblocking checklist.
- **Outcome verification**: before / after capture of the first 500
  ms of boot output, side by side. Concrete bytes.
- **Node-side regression check**: serial harness still showing
  early-printk through stdout, with capture.
- **What's deferred**: anything still rough; CGA-canvas renderer
  for graphics-mode; image upload + settings (next brief).
- **Things future briefs should address**: image upload + settings
  (the user has scoped this for the next brief — capture the
  scope decisions: in-memory vs IDB-persisted, font size + theme +
  image URL config); CGA-canvas renderer for graphics-mode guests;
  network device; snapshot / restore.
- **CPU/memory bug candidates**: anything noticed under the
  diagnosis instrumentation.
- **Release snapshot**: layout, launch commands, verification
  outputs.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`reference/elks/elks/init/main.c`**, `printk.c`, and
   `arch/i86/kernel/early_printk.S` (or wherever it lives) — the
   `early_printk` definition.
2. **`reference/elks/elks/kernel/devices.c`** (or equivalent) — the
   `set_console` redirect.
3. **`src/browser/worker-host.ts`** — the wiring you're likely
   modifying.
4. **`src/browser/browser-console.ts`** — sibling of NodeConsole;
   the candidate path for early-printk in browser mode.
5. **`src/diagnostics/cga-mirror.ts`** — the Phase 7.1 mirror; if
   Outcome B, you wire its sink to a TX bridge.
6. **`tools/elks/run-serial.ts`** — Node serial harness; should not
   regress.
7. **`SERIAL_CONSOLE_REPORT.md`** and **`BROWSER_HARNESS_REPORT.md`**
   for context on the existing wiring.

## Final notes

The Phase 8 deferral comment phrased this as "early-printk reaching
serial," which is one possible fix (Outcome C). But the user-visible
symptom — blank xterm window — has a smaller fix (Outcome A or B).
Diagnosis decides; don't pre-commit to a path.

The discipline this brief asks for: **don't expand**. Image upload,
settings UI, CGA-canvas renderer all feel adjacent. They're real
future work. They each get their own brief. This one closes one
specific UX rough edge.

After this lands, the next brief is browser polish — image upload
and settings UI — with the user's scope already captured: font size +
theme + image URL config, image upload semantics TBD between session
and IDB-persisted.
