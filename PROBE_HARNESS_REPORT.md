# emu86 Phase 12 — Probe Harness

## Summary

**Outcome A — full success.** `runProbe()` exists, takes a primary
serial-console image and a shell script, builds a FAT12 floppy
containing the script on the fly, mounts it inside the VM as
`/dev/fd1`, runs the script, and returns the captured stdout. The
trivial probe (`echo hello-from-probe`) round-trips end-to-end in
~6.5 s of wall-clock test time.

**No substrate changes.** Everything lives under `tests/probe/` —
the harness uses Phase 11's secondary-disk plumbing, Phase 11.6's
serial-MINIX image, and Phase 11.6's UART RX-chunked-feed pattern
exactly as they shipped. No edits to `src/` or `web/`.

| Metric                  | Phase 11.6 | Phase 12     |
|-------------------------|-----------:|-------------:|
| Total tests passing     | 1,255      | **1,274**    |
| New unit tests          | —          | 18 (probe-disk × 9 + probe-harness × 9) |
| New integration tests   | —          | 1            |
| New `src/` files        | —          | 0            |
| Lock-list violations    | none       | none         |
| `npm run typecheck`     | clean      | clean        |
| SST corpus              | 323/323    | 323/323      |

## Diagnosis (Section 1)

### 1. Filesystem choice — FAT12

FAT12 wins on every axis: spec is small and stable, no device-node
requirement (we only need to read scripts from the disk, not run
init), and ELKS's auto-mount fallback (mount.c:128-135 in the
userland tool) tries MINIX first then FAT, so a `mount /dev/fd1
/mnt` with no `-t` flag works.

The Phase 11.5 finding that "FAT12 can't store device nodes"
doesn't apply to the **probe disk** — the probe disk is a data
volume, not a root filesystem; it doesn't need `/dev/*` nodes,
just file content. The MINIX device-node requirement applies to
the **primary** (which we boot from), and Phase 11.6's
`fd1440-minix-serial.img` already covers that.

### 2. ELKS mount semantics for arbitrary FS

**Auto-detect via `MS_AUTOMOUNT` flag.** When the userland
`mount /dev/fd1 /mnt` is invoked with no `-t` flag and no `-o`
flag, the userland tool sets `flags = MS_AUTOMOUNT` and tries
MINIX first; on -EINVAL it retries as FAT
(`reference/elks/elkscmd/sys_utils/mount.c:128-135`). For our
probe disks the MINIX try fails (no MINIX magic at offset 0x410)
and the FAT try succeeds.

The kernel-side validation (`reference/elks/elks/fs/msdos/inode.c:152-205`)
checks: `fats != 0` (✓ we set 2), `dir_entries % DPS == 0` (✓ we
set 224 — 224 % 16 = 0), `cluster_size != 0` (✓ we set 1). So
our images mount cleanly.

### 3. Image size — 1.44 MB floppy

Defaulting to 1.44 MB rather than 360 KB:
- The existing emu86 secondary-disk plumbing (Phase 11) and the
  kernel's BIOS-driver geometry handling all flow through stock
  floppy sizes. 1.44 MB is the most-tested geometry in the
  emulator.
- Test memory cost is 1.44 MB per probe — negligible.
- A future probe wanting smaller / larger can grow a `size`
  option; v0 doesn't need one.

### 4. Sentinel — `__PROBE_DONE__`

Leading double-underscore + uppercase + trailing
double-underscore. Searching boot transcripts for any partial
match found nothing — the kernel banner, mount messages, login
prompts, and userland output never produce this token under
normal operation. The unit test
`probe-harness.test.ts:'is unambiguous against typical kernel/userland output'`
pins the exact sentinel value so future refactors can't weaken
it.

The launch line is shaped as:

```
mount /dev/fd1 /mnt && sh /mnt/<probe.sh>; echo __PROBE_DONE__\n
```

The `;` (rather than `&&`) before the sentinel echo means it
fires regardless of whether mount or the script succeeds. So
even a probe that fails or hangs at parse time still produces a
sentinel — the harness reports `timedOut: false` plus an empty
stdout in those cases (they're distinguishable from
`timedOut: true`, which means the script ran past its budget).

### 5. Filesystem-image construction — pure-TypeScript FAT12 writer

Termux doesn't ship `mtools` or `mkfs.fat`, so shelling out
isn't available. The brief's three-way fallback (mtools /
template-edit / pure-TypeScript writer) reduces to a writer
because a "build from scratch" path is needed and an empty
template would hide the same complexity inside a checked-in
binary. The writer ended up at ~330 lines of TypeScript
(including the verification reader) — well within the brief's
"200-line FAT12 writer is reasonable scope" envelope, with the
extra lines spent on round-trip-readback for tests.

The writer is byte-deterministic for the same input, which
makes diffing builds and reasoning about the BPB easy.

## API

```ts
import { runProbe } from './tests/probe/probe-harness.js';

const result = await runProbe({
  primaryImage: 'reference/elks-images-serial/fd1440-minix-serial.img',
  probe: {
    filename: 'hello.sh',
    script: 'echo hello-from-probe\n',
  },
  timeoutInstructions: 60_000_000,
});

result.stdout            // 'hello-from-probe'
result.timedOut          // false
result.kernelPanicked    // false
result.truncated         // false
result.bootStdout        // pre-probe boot output
result.fullTranscript    // entire UART TX since boot
result.instructionsUsed  // ~5–7M for the trivial probe
```

Full type signature, see `tests/probe/probe-harness.ts:103-157`.

The function is pure: input config in, result out, no global
state, no filesystem writes (the probe disk lives in memory
only).

## Implementation

Module layout:

```
tests/probe/
├── probe-disk.ts             # FAT12 floppy builder (pure TS)
├── probe-disk.test.ts        # 9 unit tests on the FAT12 writer
├── probe-harness.ts          # runProbe + parsing helpers
└── probe-harness.test.ts     # 9 unit tests on the parsing logic

tests/integration/
└── probe-harness-trivial.test.ts  # 1 end-to-end test
```

`probe-harness.ts` is the public surface; `probe-disk.ts` is its
collaborator. Tests can import either directly.

The boot-and-inject pipeline (`runProbe` body):

1. Resolve primary bytes (sync from path, or pass-through bytes).
2. Build the probe disk via `buildProbeDisk()` — script + extras
   in the FAT12 root.
3. Construct an `IBMPCMachine` with primary as `disk`, probe disk
   as `secondaryDisk`, `secondaryDiskClass: 'floppy'`. The UART
   `transmit` callback pushes bytes into a captured array, with a
   `maxOutputBytes` cap that toggles `truncated: true` on overrun.
4. Reset and boot. Single `traceRun` call to a `BOOT_INSTRUCTION_BUDGET`
   (8M) cap; check for `# ` prompt match in the captured TX.
5. Inject the launch line in 12-byte chunks (the 16-byte UART
   FIFO leaves room for paranoia margin), draining 200K
   instructions between chunks (Phase 11.6's empirical drain
   slice).
6. Run in 1M-instruction slices, scanning new TX bytes for the
   sentinel after each slice. Stop on sentinel match or
   instruction-budget exhaustion.
7. Slice the captured transcript:
   - `bootStdout` = bytes captured before the launch-line
     injection (anchored by UART byte count, not text).
   - `stdout` = `extractProbeStdout(transcript, filename)` —
     finds the LAST occurrence of the launch prefix
     `mount /dev/fd1 /mnt && sh /mnt/<filename>`, advances to the
     end of that line, slices to the LAST occurrence of
     `__PROBE_DONE__`, and strips one trailing newline.

The slice algorithm is unit-tested against synthetic transcripts
(no boot needed) plus exercised end-to-end by the integration
test.

## Trivial probe — round-trip transcript

The integration test runs `echo hello-from-probe\n`. Captured
output (excerpts):

```
boot output (truncated):
...
Direct console, scan kbd...
VFS: Mounted root device
# 

probe launch + stdout + sentinel:
mount /dev/fd1 /mnt && sh /mnt/hello.sh; echo __PROBE_DONE__
hello-from-probe
__PROBE_DONE__
# 
```

`result.stdout` returns exactly `hello-from-probe`. `bootStdout`
ends with the first `# ` prompt; `stdout` is the line between
the launch echo and the sentinel; `fullTranscript` is the
verbatim UART TX byte stream.

Wall-clock: ~6.5 s. Instructions used: 5-7M (well under the
60M budget).

## Filesystem-image construction

`tests/probe/probe-disk.ts` exports:

- `buildProbeDisk(files)` → `{ bytes, geometry, fileOffsets }`.
  Builds a 1.44 MB FAT12 floppy image with the listed files in
  the root directory. Throws on filename / size constraint
  violations.
- `readProbeDiskFile(image, name)` → `Uint8Array | null`.
  Round-trip reader, used by unit tests to verify the writer's
  output without booting a VM. Walks the FAT chain.
- `getFat12(fat, index)` → 12-bit value. Helper for tests that
  want to peek at FAT entries directly.
- `FD1440_GEOMETRY`. Exposed for callers that want to reuse the
  same geometry constants without going through `inferFromSize`.

The BPB values match the canonical 1.44 MB MS-DOS layout (BPB
fields cited inline in the source). Each file occupies
`ceil(size / 512)` clusters, chained through FAT entries with
`0xFFF` end-of-clusterchain markers. FAT 1 and FAT 2 are
byte-identical mirrors. Filenames are 8.3-uppercased per the
spec — ELKS's FAT driver matches case-insensitively, so callers
can pass mixed-case names.

Reusable for future probes that need to ship more than just
a script — e.g. binary inputs, multiple shell helpers, data
files. The writer accepts both string and `Uint8Array` content.

## What's deferred (Section 5 of the brief)

- Real toolchain survey, `/usr/bin/` listing — Phase 13.
- Browser-side probe runner — test infra only.
- General "remote shell" abstraction beyond the probe pattern.
- Streaming output mode — probes are batch.
- Multi-script probes per boot.
- Probe scripts that need network — NE2000 doesn't exist yet.
- Probe scripts that write files back to the host — the probe
  disk is read-only-from-script's-perspective. (Phase 11's
  secondary-disk supports writes in principle; a future brief
  could extend the harness to read those bytes back after the
  sentinel.)
- Snapshot/restore so probes resume from post-boot.
- CGA-mirror fallback for non-serial primary images.
- A CLI exposure of `runProbe` — vitest-driven only for v0.

## Things future briefs should address

1. **Phase 13 — toolchain survey.** This is the immediate next
   user. Probes like `ls /usr/bin`, `cat /etc/issue`,
   `which cc`, etc. — each one a `runProbe()` call with a
   different script. The harness ships ready for that work.
2. **Streaming output mode.** Long-running probes (a 30-second
   compile, a 5-minute test run) currently buffer everything to
   `txBytes` and return at the end. A streaming variant —
   progressive callbacks per line, or per N seconds —would help
   when `stdout` is expected to be large or when the user wants
   live feedback.
3. **Probe extraFiles → host readback.** Some future probes will
   want to ship a binary input AND read structured output back.
   Today the script can emit text to stdout (captured), but
   writing back to the probe disk and slurping the bytes
   post-sentinel would let probes return arbitrary binary data.
   Phase 11's secondary-disk substrate supports the writes in
   principle; the harness needs a "read FAT12 back from the
   in-memory image" path symmetric to `readProbeDiskFile`.
4. **Multi-script / scripted-conversation probes.** The current
   API is one-shot: launch one script, collect output, halt.
   A future "session" mode could keep the VM running and accept
   subsequent inject-and-capture cycles — useful for probes that
   set up state and then make many small queries against it.
5. **User-facing browser probe runner.** A demo mode where a
   user types a script in the browser harness and sees its
   output. Different brief, far future, but the substrate is
   ready.
6. **CPU/memory bug surface.** The trivial probe's run did not
   stress any code path beyond what Phase 11.6's
   `elks-ramdisk-serial.test.ts` already exercised — same boot,
   same UART injection, smaller workload. No new bug candidates
   surfaced.

## CPU/memory bug candidates

None observed. The trivial probe is a strict subset of Phase
11.6's six-command UART injection sequence — fewer commands,
smaller transcript, lower instruction count. If any CPU or
memory bug existed in this code path it would have surfaced in
Phase 11.6 first.

## Release snapshot

Layout: `releases/phase-12-probe-harness/`

```
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/                     # compiled Node CLI
├── dist-web/                     # Vite production bundle
└── reference/                    # fixtures
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img
    │   └── fd1440-minix-serial.img
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/
        ├── hd32-fat.img
        └── hd32-minix.img
```

`node_modules/` not copied (per Phase 11.5 / 11.6 convention).

Verified by:

- `node releases/phase-12-probe-harness/dist-cli/tools/elks/run-serial.js
  releases/phase-12-probe-harness/reference/elks-images-serial/fd1440-fat-serial.img`
  reaches the post-boot `# ` prompt — no regression vs Phase 11.6.
- `node releases/phase-12-probe-harness/dist-cli/tools/elks/run-serial.js
  releases/phase-12-probe-harness/reference/elks-images-serial/fd1440-minix-serial.img`
  reaches the `# ` prompt — no regression.
- The trivial probe's integration test passes against the
  release's fixtures (`npx vitest run tests/integration/probe-harness-trivial.test.ts`
  in the release directory).

The harness itself isn't part of `dist-cli` (it's test-only), so
the snapshot's compiled CLI is byte-identical to Phase 11.6's
apart from cosmetic timestamps.

## Verification

From the repo root:

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean)

$ npm test
…
 Test Files  76 passed (76)
      Tests  1274 passed (1274)
   Duration  334.33s

$ npx vitest run tests/probe/
 ✓ tests/probe/probe-disk.test.ts        (9 tests) 21ms
 ✓ tests/probe/probe-harness.test.ts     (9 tests) 7ms
 Test Files  2 passed (2)
      Tests  18 passed (18)

$ npx vitest run tests/integration/probe-harness-trivial.test.ts
 ✓ tests/integration/probe-harness-trivial.test.ts (1 test) 6580ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

SST corpus 323/323 passing within the full-suite run.

Net delta from Phase 11.6's 1,255: exactly +19 (9 probe-disk
unit + 9 probe-harness unit + 1 integration). Matches the
brief's "≥ 1,261" threshold (exceeds by 13).

## Reference sources

1. **`MULTI_DISK_REPORT.md`** — Phase 11 secondary-disk plumbing
   (the `IBMPCMachine.secondaryDisk` config the harness uses).
2. **`RAMDISK_REPORT.md`** — Phase 11.5; the FAT12-vs-MINIX
   device-node finding that motivated keeping MINIX as the
   *primary* and using FAT12 only on the *probe disk*.
3. **`SERIAL_MINIX_REPORT.md`** — Phase 11.6; UART injection
   pattern and chunked-feed helper, copied into the harness as
   `injectLine()`.
4. **`tests/integration/elks-ramdisk-serial.test.ts`** — Phase
   11.6 test, the closest template for the boot-and-inject-and-
   capture flow.
5. **FAT12 spec** — Microsoft "Hardware White Paper / FAT
   General Overview of On-Disk Format" (the primary reference;
   the BPB layout and FAT12 entry packing in `probe-disk.ts`
   match this verbatim).
6. **`reference/elks/elks/fs/msdos/inode.c:152-205`** — kernel
   FAT validation that our writer's output passes.
7. **`reference/elks/elkscmd/sys_utils/mount.c:128-135`** —
   userland `mount` auto-detect path that reaches the FAT
   driver from a no-`-t` invocation.
8. **`tests/probe/probe-disk.ts`**, **`tests/probe/probe-harness.ts`**
   — implementation; module-level comments cite the design
   choices section by section.

## Final notes

The harness shipped with the trivial probe and stops there, per
the brief. The temptation to "just include a quick `ls /usr/bin`"
was real — the harness can do it now — but bundling it would
muddy this brief's "infrastructure, not feature" framing and
weaken Phase 13's separately-scoped survey work. Phase 13 takes
this harness and runs the actual probes.

The substrate compounds: every probe added to Phase 13 (and to
later kernel-feature investigations) is a few lines of shell
script plus a `runProbe()` call. The plumbing is paid for once.
