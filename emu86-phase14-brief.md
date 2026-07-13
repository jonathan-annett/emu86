# emu86 — Agent Brief: Phase 14 — In-VM Dogfooding Arc (extraction → browser → NE2000)

## TL;DR

Phase 14 is the arc the whole project has been pointing at: build real
software *inside* the emulated machine, using the machine itself. The
hello-world compile (step 1, `HELLO_WORLD_COMPILE_REPORT.md`, commit
`7c7d438`) proved the on-disk C86 toolchain works end-to-end on
`hd32-minix.img`. Three milestones remain:

1. **M1 — guest→host artifact extraction** (this session). Get compiled
   binaries *out* of the guest and onto the host, byte-exact. Without
   this, anything the VM builds is trapped inside a discarded in-memory
   disk image.
2. **M2 — interactive browser session against the HD image.** Jonathan's
   request (2026-07-13): drive the machine from the browser. The Phase 9
   xterm.js harness already exists; the HD image needs the serial
   `/bootopts` patch applied at load, and the whole web harness needs
   its first real-browser verification since the Termux era.
3. **M3 — NE2000 device model + in-VM driver build.** The original
   Phase 14 goal. Register-level device shape is **blocked on
   `emu86-networking-plan.md`**, which exists only in the planning
   chats — Jonathan is recovering it. Do not guess the device shape;
   M3 does not start until the plan (or Jonathan's restatement of it)
   lands in the repo.

Process note: as of 2026-07-13 planning happens in the working session,
not a separate claude.ai chat. This brief was drafted in-session and
reviewed by Jonathan. The brief→report discipline is unchanged: each
milestone produces a `*_REPORT.md` at the existing standard.

You are working in `emu86/`. Read first: `EMU86_AUDIT_REPORT.md`
(2026-07-13 ground truth for the whole repo),
`HELLO_WORLD_COMPILE_REPORT.md` (step 1 findings — especially §4:
`/dev/fd0` not `/dev/fd1` on HD primaries, and boot-budget = wall-clock),
`PROBE_HARNESS_REPORT.md` (harness API).

## Hard rules

1. **Don't break existing tests.** 999 passing / 81 files + 1 skipped
   as of step 1. All stay green.
2. **`cpu.step()` stays pure synchronous.** Locked.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`. `noUncheckedIndexedAccess` stays on.
5. **No new dependencies.** Node builtins (`node:crypto` for md5
   verification in tests) are fine; packages are not.
6. **M1 touches test infrastructure only** — `tests/probe/**`,
   `tests/integration/**`. The substrate (`src/`, `web/`) stays locked
   for M1. Harness extension is explicitly allowed (Phase 12.1
   precedent); `probe-disk.ts` may gain read-side helpers but its
   *writer* output must stay byte-identical (existing unit tests pin it).
   **Amendment (2026-07-13, Jonathan-approved in-session):** one
   `src/bios/bios-services.ts` change is authorized — INT 13h CHS
   range validation (CF=1/AH=04 on out-of-geometry requests). M1
   exposed that the missing check makes ELKS misprobe floppy geometry
   (36 spt instead of 18) and corrupt every write beyond track 0; see
   `ARTIFACT_EXTRACTION_REPORT.md` for the full root-cause chain.
7. **M2 may touch `web/` and `src/browser/`** (that's its subject), but
   nothing under `src/cpu8086|machine|bios|devices|memory`.
8. **M3 rules get written when M3 unblocks.** It will add
   `src/devices/ne2000.ts` + tests; device shape comes from the
   recovered networking plan, not from improvisation.
9. **No fix-and-pray.** Negative results are findings. If ELKS can't
   write FAT12, that's a documented outcome that changes M1's approach,
   not something to hack around silently.

## Background

Step 1 established (all verified, see `HELLO_WORLD_COMPILE_REPORT.md`):

- The native pipeline is `cpp → c86 → as → ld` with exact flags read
  from the image's own `/usr/src/Makefile`; a 3,156-byte `hello`
  binary compiled and ran in-guest in ~40 s wall-clock.
- The probe floppy appears as **`/dev/fd0`** on an HD primary
  (per-class drive numbering, `bios-services.ts:99`).
- The `/bootopts` init path (`mount /dev/fd0 /mnt;sh /mnt/go.sh`,
  33 bytes, well under the ~115-byte `MAX_INIT_SLEN` ceiling) is the
  proven launch shape; all real work lives in `go.sh` on the floppy.
- The harness boot phase always burns its full `bootInstructionBudget`
  — budget choice IS the wall-clock knob.

Evidence gathered for M1's approach ranking (this session):

- `tests/probe/probe-disk.ts:readProbeDiskFile()` is a real FAT12
  reader: root-directory scan + FAT12 cluster-chain walk with a
  runaway guard. It can read files *ELKS* writes, not just the
  writer's own contiguous layout.
- ELKS's msdos driver has a write path (`reference/elks/elks/fs/
  msdos/file.c` implements file write).
- The image's userland includes `md5sum` and `sync`
  (`elkscmd/file_utils`) — no `od`/`uuencode`.
- `InMemoryDisk` copies its `contents` at construction and exposes no
  bulk accessor (`src/disk/disk.ts:105-160`); the harness must
  snapshot the probe disk post-run via a `readSector` loop. No `src/`
  change required.

## Scope

### M1 — guest→host artifact extraction

**Hypothesis A (primary):** the guest copies build artifacts onto the
mounted probe floppy; the harness returns the floppy's final bytes;
the host reads the files back with `readProbeDiskFile()`.

1. **Harness:** add `probeDiskFinal: Uint8Array` to `ProbeResult` —
   a post-run snapshot of the secondary disk taken by looping
   `readSector` over all 2,880 sectors. Document that it reflects
   whatever the guest flushed before the run ended.
2. **Guest script:** extend the hello-world `go.sh`:
   `md5sum /tmp/hello` (printed to transcript, in its own `@@md5@@`
   section), `cp /tmp/hello /mnt/hello.bin`, `cp /tmp/hello.o
   /mnt/hello.o`, `sync`, `ls -l /mnt`. 8.3 names only.
3. **Host side:** `runHd32HelloWorld()` returns extracted artifact
   bytes; the integration test asserts (a) `hello.bin` extracted
   non-null, (b) its length matches the size the guest's `ls -l /tmp`
   reported, (c) **its host-computed md5 equals the md5 the guest
   printed** — byte-exact fidelity, not just presence.
4. **Fidelity note for the report:** record the extracted binary's
   header bytes (expected: ELKS a.out-family magic) — first artifact
   ever exported from the VM.

**Fallback B (only if A fails):** ELKS FAT write turns out broken /
unflushed → extract via transcript encoding (`md5sum` + a hex dump via
`dd | ...` if any encoder exists on-image), or grow a host-side MINIX
fs reader for the primary image. Whichever path runs, the report
documents why.

**Depth ceiling:** extraction of root-directory files from the probe
floppy. No subdirectory support, no long filenames, no MINIX fs reader
unless Fallback B forces it.

### M2 — interactive browser session (needs Jonathan at a browser)

1. Five-minute sanity check first: `npm run dev:browser`, boot the
   default serial floppy, type at the shell. This is the first
   real-browser verification since the Termux consolidation — if it
   fails, THAT is the milestone.
2. Add HD-image support to the browser flow: apply the serial
   `/bootopts` patch (the `buildBootoptsWithScript`-style in-memory
   edit, minus the init script — just `console=ttyS0,9600`) when an
   HD image without serial console is selected. Smallest reasonable
   surface: a toggle or auto-detect in the image library / worker
   host.
3. Acceptance: boot `hd32-minix.img` in the browser, log in, run
   `c86` interactively at the xterm prompt.
4. Report includes what was and wasn't verified in which browser.

### M2.5 — agent bridge (Jonathan's idea, 2026-07-13 in-session)

Let an agent drive the browser-hosted machine programmatically. Vite's
dev server already has a WebSocket channel (HMR) that plugins can carry
custom events over — no new dependency:

1. Inline vite plugin (`vite.config.ts`): bridges `emu86:rx` /
   `emu86:tx` custom events to plain HTTP endpoints on the dev server
   (`POST /agent/rx` with bytes, `GET /agent/transcript` returning the
   cumulative TX text).
2. `web/main.ts`: when `import.meta.hot` exists (dev mode only),
   forward worker `tx` to `hot.send('emu86:tx', ...)` and subscribe to
   `hot.on('emu86:rx', ...)` → worker. Production builds compile the
   whole block away.
3. Acceptance: with `npm run dev:browser` running and an image booted,
   `curl -d 'ls' localhost:5173/agent/rx` (plus newline) makes the
   command appear in the visible xterm and the output shows up in
   `GET /agent/transcript`.

Dev-mode only by design — the production `dist-web` build carries none
of it.

### M3 — NE2000 device + virtual switch (UNBLOCKED 2026-07-13; addendum below)

**Addendum (2026-07-13, after `emu86-networking-plan.md` landed in the
tree).** The plan reshapes M3 per Jonathan's recorded instinct: *"we
model outside of the VM first — before writing a line of C on the
driver."* Two reality-deltas discovered since the plan was written:

1. **The stock kernel already ships an NE2000 driver** — every HD boot
   probes `eth: ne0 at 300, irq 12 not found` (M2 boot logs). Layer 1
   networking therefore needs NO in-VM compilation: build the device
   and the browser-side switch, and the existing driver finds it. The
   dogfooding compile (rebuild the driver with the on-disk c86, extract
   via M1) is a SEPARATE demonstration, valuable but not load-bearing.
2. **IRQ:** the plan's "IRQ 9 typically" and the kernel's default probe
   (IRQ 12) are both unreachable on our single master PIC. The device
   goes at **0x300, IRQ 5** (classic NE2000 alternate), selected
   guest-side by uncommenting/editing the image's own `#ne0=` bootopts
   line to `ne0=5,0x300,,0x80` — the M2 bootopts patcher is the natural
   place to add it.

**M3a scope (next up):** `src/devices/ne2000.ts` — 8390-class NIC in
the established device pattern (port I/O, `onTransmit(frame)`,
`injectFrame(frame)`), wired into `IBMPCMachine` as an optional device;
`src/net/switch.ts` — MAC-dispatch frame router with pseudo-host
registration, no pseudo-hosts yet beyond a loopback/test peer.
Acceptance: stock kernel detects ne0 at boot; frames flow both ways
under an integration test (kernel transmits ARP/broadcast on `net
start`-style activity or via the driver's own probe traffic); browser
harness attaches the switch in the worker.
**M3b+ (per the plan's phase ladder, each its own scope entry):**
ARP/ICMP pseudo-hosts → DNS-over-DoH → TCP termination + HTTP gateway
→ `webget`/second-UART escape hatch → NTP/RTC. Config surface (plan
open-question 3): start as `BootConfig` fields in the worker protocol;
promote to the settings UI when pseudo-hosts exist to configure.

**M3-tabs — inter-tab LAN (Jonathan, 2026-07-13 close: "tab 1 can
telnet to tab 2. that will be gold").** Same-origin browser tabs share
one LAN via a BroadcastChannel **trunk port** on each tab's switch
(real-switch trunking; the M3a learning CAM already handles
who-lives-where — no switch changes). Guest↔guest TCP needs NO
termination engine: ktcp speaks real TCP at both ends and telnetd
already listens — only frames must move. Two constraints discovered
in-session: ELKS has no DHCP client (ktcp is static-config), but stock
`/etc/net.cfg` reads `$LOCALIP` from the bootopts env — so tabs lease
unique `LOCALIP=10.0.2.x` values over the same channel and the
bootopts patcher stamps them ("DHCP at the bootopts layer"); and each
tab needs a unique NIC MAC (today every machine is
02:65:6d:75:38:36, intolerable on a shared segment). Acceptance:
`telnet 10.0.2.<other-tab>` from one xterm logs into the other tab's
ELKS. Node-testable with two WorkerHosts on a stubbed channel.

Substrate note: M3a touches `src/devices/`, `src/machine/ibm-pc.ts`
(optional-device wiring), and `src/net/` (new) — this is the phase's
subject, approved by the arc; hard rules 1–5 unchanged.

## Verification

- `npm run typecheck` clean (note: add `tsconfig.cli.json` if the
  audit's §11.4 doc-repair lands first; otherwise verify it manually).
- `npx vitest run` fully green at each milestone.
- M1's integration test must be deterministic (committed image +
  `InMemoryHostClock`) — same standard as the step-1 test.

## Deliverables

- M1: harness snapshot support, extended hello-world probe + test,
  `ARTIFACT_EXTRACTION_REPORT.md`, committed.
- M2: browser HD support + `BROWSER_HD_SESSION_REPORT.md`, committed.
- M3: its own scope addendum to this brief, then implementation +
  report, committed.

**Observed nicety for a future milestone (2026-07-14, Jonathan playing
TAN-pirated games — CORRECTED same evening):** games are SLOW in the
browser, not fast. The machine models 1 instruction = 1 clock cycle
(`clock.advance(executed)`, `cyclesPerPitTick: 4`), so real-time guest
clocks need ~4.77M instr/s; Node manages ~2M and the browser worker —
yielding via setTimeout(0) every 5,000-instruction batch, which
browsers clamp — considerably less. PIT-paced games therefore run at a
fraction of real speed. Two-part fix when scheduled: (1) drive the
virtual clock from HOST elapsed time so the PIT ticks a true 100 Hz
regardless of emulation speed (timer-paced programs become
right-speed instantly); (2) browser throughput — larger batches and a
MessageChannel yield instead of clamped setTimeout(0). Display load
from full-screen ANSI is secondary and mostly follows from (1).

**Deployment shape (Jonathan, 2026-07-14): static PWA on Cloudflare.**
dist-web is already fully static and the TAN needs no server
(BroadcastChannel is in-browser IPC) — so "open URL, see ELKS, telnet
between your own tabs" works from any static host today. Remaining
work when this becomes a milestone: PWA manifest + service worker
(offline boot); HD images via an R2 bucket with CORS headers or a tiny
CF Worker CORS proxy for the GitHub asset CDN (the API is CORS-open,
only assets block; note Cloudflare Pages caps static files at 25 MB —
the HD images are 31 MB, so plain static hosting is out). Policy flag:
the same proxy could later widen the M3d HTTP gateway beyond
CORS-permissive sites — that edges toward the host-side-daemon shape
the networking plan rejected; decide deliberately when M3d lands.

## Out of scope for all of Phase 14

- Fixing the `runUntilSentinel` echo bug (three phases of precedent
  say work around it; fix only if a probe outgrows the bootopts+floppy
  pattern).
- SST corpus re-enablement (separate decision, audit §6.1).
- Doc-repair commit (audit §11.4 — separate, Jonathan-approved batch).
- Performance work, 286/protected mode, huxley merge questions.
