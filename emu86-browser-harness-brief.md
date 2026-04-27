# emu86 — Agent Brief: Browser Harness with xterm.js (Phase 9)

## TL;DR

First runnable browser deployment. Vite-based dev shell. Emulator
runs in a Web Worker (CPU loop is pure synchronous and stays that
way, but it stays off the main thread). Main thread hosts xterm.js,
which consumes UART TX bytes from the worker and forwards keystrokes
back as UART RX. Floppy image fetched via HTTP. IDB-backed page
store exercised in its native environment for the first time.

End state: open `npm run dev:browser`, navigate to the dev URL, see
ELKS boot banner stream into xterm.js, type `echo browser-ok`, see
`browser-ok` printed.

Locked to serial only — no CGA-canvas renderer in this brief. The
CGA mirror's diagnostic role doesn't translate to the browser yet;
that's a future brief.

Document in `BROWSER_HARNESS_REPORT.md`.

You are working in `emu86/`. Read `SERIAL_CONSOLE_REPORT.md`
(especially the harness wiring section) and skim
`emu86-handover-brief-v2.md` for architectural rules. The Node serial
harness `tools/elks/run-serial.ts` is your reference shape.

## Hard rules

1. **Don't break existing tests.** 790 passing without corpus / 1113
   with corpus as of Phase 8. All must stay green.
2. **`cpu.step()` stays pure synchronous.** The Web Worker hosts the
   loop on its own thread; the loop itself does not become async.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **No new device design and no new kernel investigation.** The
   serial path is the I/O surface. If you find yourself reading ELKS
   source in this brief, stop — you're out of scope.
6. **You may add** `src/browser/` (BrowserConsole, worker host,
   message protocol), `tools/browser/` or `web/` (Vite project root,
   index.html, main-thread bootstrap), unit tests for the worker
   logic and message protocol, and any vite-related configs at the
   project root.
7. **You may modify** `package.json` (new scripts and deps),
   `tsconfig.*.json` (new project ref for browser code if needed),
   and the existing `IBMPCMachine` config-shape only if a genuinely
   new wiring need emerges (and only at the config interface, not at
   internals).
8. **You may NOT modify** `src/cpu8086/`, `src/memory/`,
   `src/runtime/`, `src/interrupts/`, `src/io/`, `src/timing/`,
   `src/devices/`, `src/console/`, `src/disk/`, `src/bios/`,
   `src/host-clock/`, `src/diagnostics/`, or
   `src/machine/ibm-pc.ts` internals. Same locks as Phase 8.
9. **No CGA-canvas renderer.** Tempting and within reach. Out of
   scope. The CGA mirror should run in the worker only as a sink-
   to-nowhere or be omitted; it must not block the build.
10. **No `eval`, no `new Function(...)`, no dynamic-import of
    untrusted strings.** Plain Vite-bundled code only.

## Background

The substrate already supports browser deployment: the IDB page store
in `src/disk/idb-page-store.ts` was designed for the browser
environment and has unit tests using fake-indexeddb. The serial path
established in Phase 8 produces and consumes byte streams that map
cleanly to xterm.js's `onData` event and `write()` method. The clean
synchronous CPU loop runs identically whether on Node's main thread
or a worker thread.

What's missing:

- A `BrowserConsole` analogue of `NodeConsole` that talks to a
  worker-side "input queue" rather than to stdin.
- A worker host that constructs the machine, runs the loop, and
  bridges the UART to a postMessage-based byte channel.
- A main-thread bootstrap that creates the worker, an xterm.js
  terminal, and stitches them together.
- A way to fetch the floppy image (HTTP `fetch()` to a static URL).
- A Vite dev/build configuration.

This brief delivers all of the above.

## Scope

### Section 1 — message protocol

A small typed protocol between main and worker. Both directions are
simple; no streaming, no flow control beyond what the channel
provides naturally.

**Worker → Main:**

- `{ type: 'ready' }` — sent once after construction is complete and
  the worker is about to start the boot loop.
- `{ type: 'tx', bytes: Uint8Array }` — UART TX bytes from the guest.
  Coalesced per N instructions or per host event-loop tick (your
  choice; document); main thread writes them to xterm.js.
- `{ type: 'halted', reason: string }` — emulator stopped (HLT with
  IF=0, fatal trace, or main-side request).
- `{ type: 'error', message: string, stack?: string }` — uncaught
  exception in the worker. Main thread shows it in xterm.js.

**Main → Worker:**

- `{ type: 'rx', bytes: Uint8Array }` — keystrokes from xterm.js.
  Worker pushes them into the UART RX FIFO via `injectBytes`.
- `{ type: 'reset' }` — tear down the current machine, construct a
  fresh one, restart. Document whether IDB page store is also wiped
  or preserved across reset; recommend "preserved by default, wiped
  via a separate command" but pick what's simplest for v0.
- `{ type: 'pause' } / { type: 'resume' }` — optional but useful for
  debugging. Implement only if it's small.

The protocol lives in `src/browser/protocol.ts` as exported types so
both sides import from one source of truth. No transport-coupling in
the types — the worker doesn't know it's in postMessage; it consumes
and produces messages through an abstraction.

### Section 2 — BrowserConsole

`src/browser/browser-console.ts`. Implements the same `Console`
interface that `NodeConsole` does, so `IBMPCMachine` doesn't know it's
in a browser.

The shape:

- `writeChar(byte)` — for the early-printk path that goes through
  BIOS / NodeConsole equivalent. Forwards bytes to a sink (which the
  worker host wires to a `tx` message). For Phase 9, this matches the
  serial harness behaviour: the early-printk bytes go to xterm.js
  before serial takes over.
- `hasInput() / readChar()` — drains a queue of bytes pushed by `rx`
  messages.
- No raw-mode TTY handling. xterm.js manages keystrokes; the worker
  just sees bytes.

This file should be a near-mirror of `NodeConsole` minus the
process-stdin / process-stdout coupling.

### Section 3 — Worker host

`src/browser/worker-host.ts`. Runs in the worker context. Imports
`IBMPCMachine`, the UART, the BrowserConsole. Boot sequence:

1. Receive a configuration message from main (image URL or image
   bytes; treat both as supported, fetch URL if given).
2. Fetch the floppy image (`await fetch(url)` → `arrayBuffer()` →
   `Uint8Array`). Or use bytes if supplied directly.
3. Construct the IDB page store (the existing one — it self-detects
   `indexedDB`).
4. Construct the IBMPCMachine wired identically to
   `tools/elks/run-serial.ts`: UART at COM1, image as boot disk,
   BrowserConsole, CGA mirror with NullSink (or omit if the
   IBMPCMachine config supports it).
5. Send `{ type: 'ready' }`.
6. Enter a loop: `cpu.step()` × N (chunk size — pick one that gives
   smooth UART output without starving the postMessage channel; 5000
   is a reasonable starting point), drain UART TX, post a `tx` message
   if any bytes, drain pending RX from the inbound queue,
   `setTimeout(0)` (or `queueMicrotask`) to yield. Repeat until
   halted or reset.

Two important properties:

- **The CPU loop runs in the worker's event-loop yield gaps**, not
  inside a `while (true)`. A `setTimeout(0)` or `queueMicrotask` after
  each chunk lets the worker process its inbound message queue.
  Without this, RX messages pile up and never get delivered. Test
  this by sending an RX message during boot and asserting it ends up
  in the UART within reasonable time.
- **TX coalescing matters but isn't critical.** A single
  `postMessage` per byte would saturate the channel and tank
  performance. Coalesce per chunk (after each step batch, drain TX
  buffer to one message). Document the chunk size choice.

### Section 4 — Main-thread bootstrap

`web/main.ts` (or `src/browser/main.ts` — pick a layout that Vite is
happy with). Boot sequence:

1. Construct an xterm.js Terminal, attach to a `<div>` in
   `index.html`. Apply a sensible default theme; disable cursor blink
   if it bothers you.
2. Construct the worker (`new Worker(new URL('./worker.ts',
   import.meta.url), { type: 'module' })` — Vite's worker import
   syntax).
3. Wire `worker.onmessage`:
   - `tx` → `term.write(bytes)`.
   - `ready` → `term.writeln('emu86 — ELKS in the browser');
     term.writeln('Image loaded; booting...')` (or similar; the Node
     harness's banner is reasonable inspiration).
   - `halted` / `error` → `term.writeln('[emulator: ...]')`.
4. Wire `term.onData(data => worker.postMessage({ type: 'rx',
   bytes: new TextEncoder().encode(data) }))`.
5. Trigger the boot by posting the configuration message (image URL).

`web/index.html` is minimal: a title, a `<div id="terminal">`, a
script tag for the bundle. No frameworks. Vite handles the rest.

### Section 5 — Floppy image delivery

The serial-console image (`fd1440-fat-serial.img`) needs to be
reachable via HTTP `fetch()`.

Option A: copy it to `web/public/elks-serial.img` so Vite serves it
at `/elks-serial.img`. Simple, no special config. Recommend.

Option B: import it directly with Vite's `?url` syntax for a
hashed bundle URL. Slightly fancier; works if the image isn't huge
(it's 1.44 MB — fine).

Pick A unless B is just as easy. Document the choice and the
copy-or-build step (extend `build:elks-serial-image` to also copy
into `web/public/`, or add a separate copy step).

### Section 6 — Build / dev scripts

New npm scripts:

- `dev:browser` — runs Vite dev server. User opens the printed URL
  and sees the boot.
- `build:browser` — runs Vite production build. Output to `dist-web/`
  or similar (don't reuse `dist/` or `dist-cli/` — keep build
  artefacts separate).
- `preview:browser` — Vite preview of the production build. Useful
  for verifying the bundled version works.

Vite config: TypeScript-aware, supports the worker import, copies
`public/`. Use the latest stable Vite that's compatible with the
existing tsconfig setup.

### Section 7 — Tests

Three test categories, in priority order:

**A. Worker host logic (vitest, Node):**

- Construct the worker host with a stub `postMessage` (just collects
  outbound messages) and a stub `addEventListener` (lets the test
  push inbound messages).
- Boot to the `# ` prompt within an instruction cap; assert the
  collected TX messages contain the expected banner / prompt.
- Inject `"echo browser-ok\n"` via the inbound `rx` message,
  continue running, assert `"browser-ok"` appears in TX messages.
- Same shape as the Phase 8 serial integration test, but driving the
  worker host through its message API rather than calling its
  internals directly.
- 2-3 cases.

**B. Message protocol unit tests:**

- Encode / decode each message variant; trivial type-roundtrip
  assertions.
- Maybe 3-5 cases. Keep light.

**C. Browser-only tests: skip for v0.**

Setting up Playwright or jsdom-based testing for the actual xterm
integration is significant scope. For Phase 9, manual verification
is sufficient. Future brief if browser regressions become a problem.

Total new tests: ~5-10. Ship with all 790 prior plus these.

### Section 8 — What you are NOT building

- CGA-canvas renderer (graphics-mode display in browser).
- Persistent settings / user preferences.
- Multiple machine profiles.
- Save / restore / snapshot UI.
- Authentication, multi-user, server-side anything.
- A polished visual design beyond "xterm.js looks fine by default."
- Mobile / touch support.
- Service worker for offline use.
- Reset that wipes IDB. (The simple `reset` command rebuilds the
  machine; whether IDB is preserved is your call. Document.)
- Uploading a custom image. Image URL is hard-coded for v0.
- Real-time pacing (tick clock to wall clock). Same as Node — runs
  as fast as the host allows.

## Watch out for

- **The main thread cannot block.** xterm.js runs there. Any
  synchronous emulator work on main = frozen UI. Hence the worker.
  This is non-negotiable.
- **Module workers and Vite.** Vite's worker syntax is
  `new Worker(new URL('./path', import.meta.url), { type: 'module' })`.
  The `?worker` import suffix is also valid. Pick one and stay
  consistent. The non-module worker form will not get TypeScript /
  ESM imports working naturally.
- **TextEncoder / TextDecoder are global in workers.** For ASCII-only
  byte traffic (the UART produces 7-bit clean bytes from ELKS), you
  can use `new TextDecoder('utf-8')` for TX → string conversion if
  xterm.js wants a string. xterm.js's `write()` accepts both
  `Uint8Array` and string; either is fine, but prefer `Uint8Array` to
  avoid encoding surprises with control characters.
- **xterm.js's default keystroke encoding.** Pressing arrow keys
  produces `ESC [ A` etc., which is exactly what a serial-connected
  Linux/ELKS expects. No translation needed in main → worker. Same
  for backspace (DEL = 0x7F by default in xterm.js, which is what
  cooked-mode tty handlers expect).
- **The `# ` prompt only appears on the serial side.** If the boot
  fails silently, the screen will be blank because there's no CGA
  mirror feeding it. Build in a "boot started" log line on the
  worker → main `ready` message so the user sees something
  immediately. The first ~few seconds of boot before set_console
  redirect produces no UART output (same as the Node serial harness);
  the user will see a blank xterm for that window. This is expected;
  document it.
- **Cross-origin and SharedArrayBuffer.** You don't need
  SharedArrayBuffer for this brief (postMessage is fine for the byte
  rates we have). Don't enable COOP/COEP headers unless something
  demands it; they complicate deployment.
- **The IDB store across page reloads.** It persists by default
  (that's the point). For v0, that's the right behaviour: the page
  store represents a pretend disk; reloading the page shouldn't
  reset the disk. Document. If a "wipe IDB" affordance is small to
  add (a button or a dev-console command), include it; otherwise
  defer.
- **Worker termination on page unload.** Browsers handle this
  automatically; nothing to do. Don't add cleanup logic that races
  with unload.
- **Bundle size.** A naive build with xterm.js + the emulator will
  likely be ~1-2 MB minified. Acceptable for a v0; don't go down a
  tree-shaking rabbit hole. Document the rough size.
- **Image fetch on file:// origin.** If someone opens `dist-web/
  index.html` directly without a server, `fetch('/elks-serial.img')`
  fails. Document that `npm run preview:browser` (or any HTTP
  server) is required.

## Definition of done

**Implementation success:**

- `npm run dev:browser` runs Vite, prints a URL.
- Opening the URL boots ELKS in the browser. Boot banner streams
  into xterm.js. `# ` prompt appears.
- Typing `echo browser-ok` (with Enter) prints `browser-ok` followed
  by another `# ` prompt.
- Typing arrow keys / backspace at the prompt does the kernel's
  cooked-mode thing (no special handling).
- Reloading the page restarts the emulator. The IDB-backed disk
  state persists (since we're using a fresh fetch of the image as the
  base, "persistence" is mainly visible if you write to the disk
  during the session and then reload — but a v0 acceptance criterion
  is just "doesn't error").

**Test counts:**

- All 790 existing tests pass.
- Worker-host tests: 2-3 added.
- Protocol tests: 3-5 added.
- Total ≥ 798.

**Verification:**

- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean (run if installed).
- `npm run build:browser` produces a working bundle. `npm run
  preview:browser` serves it; the boot works there too.
- Manual: open dev server in Firefox and Chrome; both work. Document
  any browser-specific differences.
- Release snapshot at `releases/phase-9-browser/` populated and
  manually launch-verified (see Release snapshot section).

The report at `BROWSER_HARNESS_REPORT.md` has these sections:

- **Summary**: outcome, what works, what was deferred.
- **Architecture**: worker / main split, message protocol, the
  concrete data flow for one keystroke and one TX byte.
- **BrowserConsole**: how it implements the Console interface,
  differences from NodeConsole.
- **Worker host loop**: chunk size, yield strategy, TX coalescing.
- **Vite config**: what's in `vite.config.ts`, how the image is
  served, build outputs.
- **Bundle size**: rough numbers (uncompressed and gzipped).
- **What's deferred**: CGA-canvas, snapshot UI, image upload,
  per-key timing, multi-machine, mobile, etc.
- **Browser quirks**: anything that surfaced in Firefox vs Chrome
  testing.
- **Things future briefs should address**: CGA-canvas renderer for
  graphics-mode guests, snapshot/restore UI, persistent settings,
  multi-user support, mobile / touch, image upload.
- **CPU/memory bug candidates**: anything noticed under the new
  worker-event-loop interleaving.
- **Release snapshot**: layout of `releases/phase-9-browser/`,
  exact launch commands for both harnesses, and the manual
  verification outputs that confirmed each boots to `# `.
- **Verification**: exact commands and outputs.

## Release snapshot

After all verification commands pass and before writing the report,
copy the working artefacts to a self-contained release folder. Each
release is "this phase's deliverables, both harnesses included." How
they launch is the user's choice — two terminals, one command,
scripts of their own. This brief does not specify orchestration;
flexibility is the goal.

Layout:

```
releases/phase-9-browser/
├── README.md                # launch commands + what's new
├── package.json             # copy of root manifest
├── package-lock.json        # copy of root lockfile
├── dist-cli/                # compiled Node CLI tools
├── dist-web/                # Vite production bundle
└── reference/
    └── elks-images-serial/
        └── fd1440-fat-serial.img
```

Notes:

- `dist-cli/` already contains the Node serial harness from Phase 8
  plus anything new this brief added; both Node entry points are
  reachable from within the release.
- `dist-web/` is Vite's production build, served by any static
  server; the README should document one or two known-working launch
  commands (e.g., `npx vite preview --outDir releases/phase-9-browser/
  dist-web` from the project root, or `npx http-server` from inside
  `dist-web/`).
- `node_modules/` is **not** copied. Releases share the repo root's
  installed dependencies. If a release needs different versions,
  document the mismatch and stop — that's a separate problem.
- Other floppy images that earlier-phase harnesses depend on
  (`fd1440-minix.img` for the Phase 7 CGA harness) should be copied
  too if those harnesses are reachable from the release; copy what
  you reference, no more.

Verify the snapshot is launchable manually:

- Launch the Node serial harness from within the release folder;
  confirm it boots to `# ` and accepts a command.
- Launch the browser static server against `dist-web/`; open the URL
  in a browser; confirm it boots to `# ` in xterm.js.

Document both commands and their successful outputs in the report
under a "Release snapshot" section.

## Reference sources

1. **`tools/elks/run-serial.ts`** — Node analogue of the harness
   you're building. Same wiring, different I/O endpoints.
2. **`src/console/NodeConsole.ts`** — the source you're cloning
   for `BrowserConsole`.
3. **`src/disk/idb-page-store.ts`** — already exists, already
   browser-aware, already unit-tested with fake-indexeddb. No
   changes needed.
4. **`SERIAL_CONSOLE_REPORT.md`** — Phase 8 report for context on
   the UART path the browser harness consumes.
5. **xterm.js docs** at https://xtermjs.org — `Terminal.write`,
   `Terminal.onData`, basic configuration.
6. **Vite docs** at https://vite.dev — worker imports, `public/`
   directory, `import.meta.url`.

## Final notes

This is a milestone brief. The substrate has been ready for browser
since Phase 6's IDB page store; Phase 8 closed the I/O shape. Phase 9
is plumbing — non-trivial plumbing, but no architecture invention.

The discipline this brief asks for: **don't expand into CGA-canvas
rendering**. Graphics-mode rendering is real future work and it has
real architectural questions (where does the canvas live, how does
it interact with the worker, how do colours and attributes
translate, what about scroll). All of that deserves its own brief.
This one ships when xterm.js shows the boot banner and the user can
type a command.

After this lands, the natural next briefs are: (a) CGA-canvas
renderer for the diagnostic / graphics-mode case; (b) the deferred
polish items from Phase 8 (early-printk reaching serial; serial
getty rebuild via toolchain); (c) the network device pursuit toward
SSH-style remote access.
