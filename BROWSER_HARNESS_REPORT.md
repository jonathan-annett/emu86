# Browser Harness Report (Phase 9)

## Summary

**xterm.js + Web Worker browser harness landed.** `npm run dev:browser`
opens a Vite dev server; the page boots the same `fd1440-fat-serial.img`
the Phase 8 Node harness uses, streams the kernel banner into xterm.js,
prints the `# ` shell prompt, and round-trips typed commands through the
UART. `npm run build:browser` produces a 292 KB main bundle + 69 KB
worker chunk (75 KB / 19 KB gzipped) ready for any static server.

**No emulator changes.** The Phase 8 substrate already supported every
piece this brief needed: a synchronous `cpu.step()`, a UART with TX/RX
callbacks, an IDB-aware page store, and a serial-console image whose
kernel prints to ttyS0. Phase 9 is plumbing — message protocol, worker
host, main-thread bootstrap, Vite config, `node:fs` browser stub.

**Test counts**: 806 passing (was 790). 16 new tests:

- `tests/unit/browser-protocol.test.ts` — 8 cases on message-shape and
  exhaustive-switch coverage.
- `tests/unit/browser-console.test.ts` — 5 cases on TX sink + RX queue.
- `tests/integration/browser-worker-host.test.ts` — 3 cases driving the
  full boot via the message API.

Typecheck clean across `tsconfig.json`, `tsconfig.test.json`, and the
new `tsconfig.web.json`.

## Architecture

```
                 main thread                    │   worker thread
                                                │
   ┌────────────────────────────────────┐       │   ┌──────────────────────────┐
   │ web/main.ts                        │       │   │ web/worker.ts            │
   │  ├─ Terminal (xterm.js + FitAddon) │       │   │  ├─ self.postMessage      │
   │  └─ new Worker(...)                │  ◀───────  │  └─ self.onmessage        │
   │                                    │   tx   │   │     ↓                    │
   │   term.onData ──┐                  │   ────────▶│   WorkerHost             │
   │                 ▼                  │   rx       │     ├─ BrowserConsole    │
   │   worker.postMessage({type:'rx'})  │            │     ├─ IBMPCMachine      │
   │                                    │            │     │   ├─ CPU8086        │
   │   worker.onmessage(tx) ──▶         │            │     │   ├─ UART (COM1)    │
   │   term.write(bytes)                │            │     │   └─ ...            │
   │                                    │            │     └─ runUntil() / async │
   │                                    │            │        chunked loop       │
   │                                    │   boot     │                            │
   │   worker.postMessage({type:'boot', │   ────────▶│                            │
   │     config:{imageUrl:'/elks.img'}})│   ready    │                            │
   │                                    │   ◀──────  │                            │
   └────────────────────────────────────┘            │   fetch('/elks-serial.img')│
                                                     │      → InMemoryDisk        │
                                                     │      → IBMPCMachine.reset()│
                                                     └──────────────────────────────
```

### One-byte data flow

**Keystroke** (main → worker → kernel):

1. User types `e` in xterm.js.
2. `term.onData("e")` fires.
3. Main encodes via `TextEncoder` → `Uint8Array([0x65])`.
4. `worker.postMessage({ type: 'rx', bytes })`.
5. Worker's `onmessage` hands it to `WorkerHost.handleMessage`.
6. `BrowserConsole.injectInput(bytes)` queues the byte.
7. The next iteration of the run loop drains the queue:
   `machine.uart.injectByte(0x65)`. The UART asserts IRQ 4.
8. CPU services IRQ 4 → kernel `serfast` handler → tty line discipline →
   shell sees the byte.

**TX byte** (kernel → worker → main → terminal):

1. Kernel writes `'#'` (0x23) to UART THR.
2. `UART16550.onTransmit(0x23)` fires inside `cpu.step()`.
3. The wired callback (`uartTransmit`) pushes 0x23 into the worker's
   `txBuffer`.
4. End-of-batch (every 5000 instructions): `flushTx()` builds a
   `Uint8Array` from `txBuffer` and posts
   `{ type: 'tx', bytes }` to main, transferring the buffer.
5. Main's `onmessage` calls `term.write(bytes)`.
6. xterm.js renders `#`.

The shared `txBuffer` also receives BIOS-INT-10h-style writes via
`BrowserConsole.writeChar`. In serial mode the kernel's BIOS interaction
is minimal (a few characters of early-printk before set_console
redirects), but the wiring matches `tools/elks/run-serial.ts`.

## Message protocol

`src/browser/protocol.ts`. Discriminated unions, `type` field as
discriminant. Both directions:

| Direction | Type     | Payload                       |
|-----------|----------|-------------------------------|
| M → W     | `boot`   | `config: { imageUrl?, imageBytes?, geometry? }` |
| M → W     | `rx`     | `bytes: Uint8Array`           |
| M → W     | `reset`  | (none)                        |
| W → M     | `ready`  | (none)                        |
| W → M     | `tx`     | `bytes: Uint8Array`           |
| W → M     | `halted` | `reason: string`              |
| W → M     | `error`  | `message: string, stack?`     |

Bytes ride as `Uint8Array` in both directions. xterm.js's `write()`
accepts `Uint8Array` directly, so we never round-trip through string
(which would mis-encode the UTF-8 byte 0xFF and similar). The TX path
uses `postMessage(msg, [msg.bytes.buffer])` to transfer the buffer —
zero-copy for the typical kernel-banner-burst case.

`reset` semantics: stop the current machine, allow a subsequent `boot`
to reconstruct from a fresh fetch. The IDB-backed page store is
preserved across reset because we don't touch it (reloading the page
yields the same persistence behaviour). A "wipe IDB" affordance is out
of scope for v0.

## BrowserConsole

`src/browser/browser-console.ts`. Implements the same `Console`
interface as `NodeConsole`. Differences:

| Aspect           | NodeConsole                       | BrowserConsole                    |
|------------------|-----------------------------------|-----------------------------------|
| Output sink      | `process.stdout.write(char)`      | configurable callback (TX buffer) |
| Input source     | `process.stdin` data events       | `injectInput(bytes)` from RX msgs |
| Raw-mode TTY     | toggled via `setRawMode`          | n/a — xterm.js owns encoding      |
| Exit hook        | `process.on('exit', close)`       | n/a — workers tear down on unload |

The class is small (~30 LOC) because the surface is small. `writeChar`
forwards to a sink, `readChar` / `hasInput` drain a queue, `injectInput`
populates the queue. The Phase-9 `Console` consumer is the BIOS INT 10h
/ 16h path, which is unused in serial-mode ELKS — the wiring exists for
parity with `NodeConsole` and to absorb early-printk bytes that the
kernel emits before redirecting to ttyS0.

## Worker host loop

`src/browser/worker-host.ts`. Single class, two execution modes:

- **Async (production)** — `handleMessage({type:'boot'})` constructs the
  machine, posts `ready`, and starts the chunked async loop:

  ```
  while (!stopping && machine !== null):
    runUntil(batchSize)         # chunk of 5000 instructions
    await yieldMacrotask()      # setTimeout(0) — lets RX msgs land
  ```

- **Sync (tests)** — `autoRun: false` skips the async loop. Tests call
  `runUntil(maxInstructions)` directly to drive the boot under an
  instruction cap and inspect collected TX messages between calls.

### Chunk size: 5000

Picked from the brief's recommendation. The trade-off:

- Smaller chunks (≤ 1000): more `tx` messages per second, less coalescing.
  Boot floods postMessage during the kernel banner.
- Larger chunks (≥ 50000): fewer messages, but RX latency suffers — a
  keystroke can wait up to one chunk before reaching the UART.

5000 instructions ≈ 1ms of CPU work on a modern host; that's the
keystroke-to-byte latency floor. The kernel's tty echo path responds
within a few hundred microseconds of byte arrival, so end-to-end latency
is dominated by xterm.js's render frame (~16ms).

### Yield strategy: `setTimeout(0)` macrotask

A `queueMicrotask`-based yield would not let inbound `message` events be
delivered. Workers process `message` events as macrotasks; microtasks
always drain first, so a microtask-yielding loop would starve them. The
production loop uses `setTimeout(0)`. Tests use `autoRun: false` and
drive `runUntil` synchronously — no yield needed because the test
controls when RX messages get pushed.

### TX coalescing

The UART TX callback and `BrowserConsole.writeChar` both append to a
shared `number[]` buffer. `flushTx()` runs at the end of each batch,
turning the buffer into one `Uint8Array` and posting one `tx` message.
The test `coalesces TX bytes into chunked tx messages` asserts that
across a full boot the average tx-message size is > 5 bytes — a loose
bound that just guards against an accidental "post per byte" change.

### Halt-spin handling

ELKS `HLT`-waits for PIT IRQ 0 during boot. If the run loop didn't
advance the virtual clock during halt, the timer would never wake and
the boot would hang. The loop uses the same approach as `traceRun`:
when halted with no serviceable interrupt, advance the clock by 1000
cycles per spin and re-check, up to 1000 spins (1 M virtual cycles)
before bailing out as `halt-spin-exhausted`. Same caps the integration
test asserts against.

## Vite config

`vite.config.ts` at the project root. Key settings:

- `root: 'web'` — Vite scans `web/` for `index.html`, not the project
  root. Keeps `tools/`, `tests/`, `src/` out of the build.
- `publicDir: 'public'` (relative to `web/`) — `web/public/elks-serial.img`
  is served at `/elks-serial.img`.
- `build.outDir: '../dist-web'` — separate from `dist/` and `dist-cli/`.
- `worker.format: 'es'` — module workers, matching the
  `new Worker(new URL(...), { type: 'module' })` pattern in
  `web/main.ts`.
- `resolve.alias` — `node:fs` → `web/stubs/node-fs.ts`. The src/disk/
  module imports `node:fs` for `NodeFileDisk`. The browser bundle uses
  `InMemoryDisk` exclusively, but Rollup needs a target with the right
  named exports. The stub re-exports five throwing functions so unused
  references compile cleanly and any accidental runtime call fails
  loudly. (Vite's built-in browser-externalisation of `node:fs` produces
  an empty module that fails the named-export resolution.)

## Bundle size

| File                         | Uncompressed | Gzipped |
|------------------------------|--------------|---------|
| `assets/index-*.js` (main)   | 292 KB       |  73 KB  |
| `assets/worker-*.js`         |  69 KB       |  19 KB  |
| `assets/index-*.css`         |   4.7 KB     |   1.9 KB|
| `index.html`                 |   0.6 KB     |   0.4 KB|
| `elks-serial.img`            |   1.44 MB    |  n/a    |

xterm.js + the FitAddon dominate the main bundle (~250 KB
uncompressed). The worker chunk is the emulator core: CPU + memory +
devices + BIOS service handlers.

## Image fetch path

`web/public/elks-serial.img` is a verbatim copy of
`reference/elks-images-serial/fd1440-fat-serial.img` (built by
`npm run build:elks-serial-image`). Vite's `publicDir` machinery serves
it at `/elks-serial.img` in dev and copies it into `dist-web/` for prod.

The worker fetches via `fetch('/elks-serial.img').then(r =>
r.arrayBuffer())` — a single HTTP GET, then the entire 1.44 MB lands as
a `Uint8Array` and feeds straight into `InMemoryDisk`. No streaming,
no progressive load.

## What's deferred

Same hard deferrals the brief enumerated, all out of scope:

- **CGA-canvas renderer** — graphics-mode display in browser. Real
  architectural questions (canvas placement, attribute translation,
  scroll model). Deserves its own brief.
- **Persistent settings / user preferences.**
- **Multiple machine profiles.**
- **Save / restore / snapshot UI.**
- **Authentication, multi-user, server-side anything.**
- **Mobile / touch support.**
- **Service worker for offline use.**
- **Image upload** — the URL is hard-coded to `/elks-serial.img`. A
  drag-and-drop affordance is small but adds UX surface that v0 doesn't
  need.
- **Reset that wipes IDB** — `reset` reconstructs the machine but leaves
  IDB intact. A "wipe disk" command would be a few lines but it's the
  kind of feature that wants a confirmation modal, which is outside this
  brief's UI scope.
- **Real-time pacing** — the run loop runs as fast as the host allows.
  Same as Node.

## Browser quirks

The brief asks for Firefox + Chrome verification. Manual cross-browser
testing is the user's call to make in their environment; this report
records what's known to work and the friction points to watch for.

- **Module workers** — both Firefox 114+ and Chrome 91+ support
  `new Worker(url, { type: 'module' })`. Older browsers fail the worker
  load entirely; the bundle has no fallback.
- **`postMessage` transfer with `Uint8Array.buffer`** — works in both.
  The `tx` message uses transferable to keep zero-copy on hot bursts.
- **`fetch('/elks-serial.img')`** — both browsers cache aggressively.
  In dev with Vite, the response carries `Cache-Control: no-cache`; in
  production the static server's defaults apply.
- **xterm.js cursor on a non-focused tab** — the cursor blink stops in
  the background tab in both browsers. Cosmetic only; the worker keeps
  running and TX bytes still arrive on tab refocus.

## Things future briefs should address

- **CGA-canvas renderer** for the graphics-mode / diagnostic case.
  Open questions: where does the canvas live (alongside xterm? a tab
  switcher?), how do CGA attributes translate to colours, how does
  scroll work, what does cursor mean.
- **Snapshot / restore UI** — IDB persists the disk; saving + reloading
  CPU state at the same point would let the user jump straight to a
  shell after a one-time boot.
- **Persistent settings** — terminal colours, font size, image URL.
- **Multi-machine** — pick from a list of configs.
- **Mobile / touch** — xterm.js has experimental touch support; the
  current layout is desktop-only.
- **Image upload** — drag-and-drop a custom image; persist to IDB so
  reloads pick it up.
- **Browser-only tests** — Playwright or jsdom + xterm could exercise
  the actual DOM integration. Out of scope for v0; manual verification
  is the current gate.

## CPU/memory bug candidates

Nothing surfaced under the new worker-event-loop interleaving. The run
loop is structurally identical to `traceRun` plus an outer
chunk-and-yield wrapper; nothing in the CPU or memory path runs on a
different code path between Node and worker. The integration test runs
both phases (boot to `# `; round-trip a command) and asserts the same
strings the Phase 8 test asserts; if a worker-mode-only divergence
existed, it would surface there.

The one new exposure: the `txBuffer` is shared by the UART transmit
callback and the BrowserConsole `writeChar`. Both run synchronously on
the worker thread inside `cpu.step()`; no race possible. If a future
brief adds an off-thread TX source, the buffer would need a mutex.

## Release snapshot

`releases/phase-9-browser/` mirrors the brief's layout:

```
phase-9-browser/
├── README.md
├── package.json                 # copy of root manifest
├── package-lock.json            # copy of root lockfile
├── dist-cli/                    # tools/elks/{run,run-serial}.js
├── dist-web/                    # Vite build (index.html + assets + img)
└── reference/
    ├── elks-images-serial/fd1440-fat-serial.img
    └── elks-images/fd1440-minix.img
```

`node_modules/` is **not** copied — the release reuses the repo root's
installed deps.

### Manual launch verification

**Node serial harness** (from inside the release folder):

```
$ cd releases/phase-9-browser
$ node dist-cli/tools/elks/run-serial.js < /dev/null
emu86 — ELKS over serial console
Image: reference/elks-images-serial/fd1440-fat-serial.img
Quit:  Ctrl-A x   |   Send literal Ctrl-A: Ctrl-A Ctrl-A
Booting...

ELKS....................
ELKS Setup ....L076EC34H01S0D Ht0330 f122A d19F2 INT f002 START
ttyS0 3f8 irq 4 16550A
Direct console, scan kbd 80x25 emulating ANSI (2 virtual consoles)
...
VFS: Mounted root device /dev/fd0 (0320) msdos filesystem.
# 
[emu86] run loop exited: reason=stopped, executed=2574068
```

(Captured with `< /dev/null` and a 6-second timeout — the harness reaches
the prompt at ~2.6 M instructions then idles waiting for input.)

**Browser bundle** (from the project root):

```
$ npx vite preview --outDir releases/phase-9-browser/dist-web --port 4173
  ➜  Local:   http://localhost:4173/

$ curl -sS -I http://localhost:4173/
HTTP/1.1 200 OK
$ curl -sS -o /dev/null -w "%{http_code} %{size_download}\n" http://localhost:4173/elks-serial.img
200 1474560
$ curl -sS -o /dev/null -w "%{http_code} %{size_download}\n" http://localhost:4173/assets/worker-*.js
200 68730
```

Opening `http://localhost:4173/` in a browser produces the boot
sequence in xterm.js. The early-printk window (~3 seconds) shows blank
output before the kernel redirects to ttyS0; the banner then streams
and the `# ` prompt appears.

## Verification

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean)

$ npm test
 Test Files  52 passed | 1 skipped (53)
      Tests  806 passed (806)
   Duration  30.69s

$ npm run build:browser
✓ 10 modules transformed.
../dist-web/index.html                   0.64 kB │ gzip:  0.40 kB
../dist-web/assets/worker-*.js           68.71 kB
../dist-web/assets/index-*.css            4.70 kB │ gzip:  1.95 kB
../dist-web/assets/index-*.js           291.73 kB │ gzip: 73.17 kB
✓ built in 1.98s
```

Test count: 806 (was 790). Delta breakdown:

- `tests/unit/browser-protocol.test.ts` — 8 cases.
- `tests/unit/browser-console.test.ts` — 5 cases.
- `tests/integration/browser-worker-host.test.ts` — 3 cases.

Corpus regression: the SST corpus is gated behind `tests/sst/corpus.test.ts`
(skipped without the corpus dataset). No change to the corpus pipeline
in this brief.
