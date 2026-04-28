# emu86 Phase 11.6 — MINIX serial floppy image

## Summary

**Outcome A.** `fd1440-minix-serial.img` builds cleanly and boots to a
`# ` shell prompt over UART. The brief's hypothesis held: the same
in-place hex-edit approach Phase 8 used for FAT12 works unchanged on
MINIX V1, because the upstream `fd1440-minix.img` already allocates
`/bootopts` as a fixed 1024-byte block whose data extent contains a
unique `## /bootopts` marker. Replacing the block in place leaves the
MINIX inode's size and zone pointers untouched, the directory entry
unmodified, and the resulting image bit-identical to its source apart
from the 1024 bytes we deliberately rewrote.

The build script gained a `--filesystem fat|minix` flag (default
`fat`, back-compat). One new integration test
(`elks-ramdisk-serial.test.ts`) demonstrates the new image's value:
the same ramdisk round-trip Phase 11.5 verified on the keyboard-
injection harness, but driven over the UART RX path with all output
captured directly from UART TX.

| Metric                        | Before (11.5) | After (11.6) |
|-------------------------------|---------------|--------------|
| Total tests passing           | 1,254         | **1,255**    |
| New images                    | —             | `fd1440-minix-serial.img` |
| Build script `--filesystem`   | not supported | `fat` (default), `minix` |
| `npm run build:elks-serial-image` | unchanged | unchanged    |
| `npm run build:elks-serial-image-minix` | — | new         |
| Lock-list violations          | none          | none         |
| Substrate changes             | n/a           | none         |

`npm run typecheck` clean. SST corpus 323/323 passing within the full
suite.

## Diagnosis (Section 1)

### 1. What MINIX V1 editing tools are available?

**None needed.** The brief listed three plausible mechanisms (loop-
mount, `mfs-utils`, in-place hex edit) and named in-place hex edit
as the simplest fallback. It turns out to be the *first*-best choice
too: both upstream images already lay `/bootopts` out as a 1024-byte
contiguous block, and both contain exactly one occurrence of the
`## /bootopts` ASCII marker (it's the file's first bytes, by
construction — the ELKS image-build pipeline puts that header at the
start of the file). A 13-line `Buffer.indexOf` + `Buffer.copy`
sequence is the entire edit; no MINIX V1 library, no loop-mount, no
`mfs-utils`, no Linux privileges.

This matches the spirit of the brief's "don't generalise the image-
build infrastructure beyond what's needed". Two filesystems use the
same edit mechanism because both upstream image builders deliberately
allocate a fixed 1K block for `/bootopts` so later edits stay
contiguous (Phase 8's report cites `setup.S:961-962` for this).

### 2. Where does `/bootopts` live in the MINIX image?

In `reference/elks-images/fd1440-minix.img`:
- `## /bootopts` header at byte offset **0x15400 (87040)**.
- 1024-byte block runs through 0x157FF (88063).
- Trailing slack within the 1024 bytes is NUL-padded.

For comparison, the FAT image places it at byte offset 0xEDC00
(973824). The two offsets differ because the filesystems lay out
their data extents differently — FAT12's data area starts after the
root directory and FATs, MINIX V1's after the inode table — but the
header lookup is robust to the difference.

### 3. What's the existing `/bootopts` content?

Same `##`-prefixed-comment-style format Phase 8 documented for the FAT
image, with a few differences in the commented-out lines (the MINIX
image's sample includes more network/peripheral options). The lines
that matter for our edit:

- `hma=kernel` — already active (uncommented). Same as FAT.
- `#console=ttyS0,19200 3` — commented out. Same line that the FAT
  image had, just at a different offset within the 1024-byte block.

We replace the entire 1024 bytes with our freshly-built block, so the
distinction between "uncomment a line" and "rewrite the file" doesn't
arise — same as Phase 8's approach.

### 4. Does the MINIX kernel honour `console=ttyS0`?

Yes, by inheritance. The kernel binary embedded in `fd1440-minix.img`
is built from the same upstream `init/main.c` with the same
`parse_options` call sequence. Phase 8's
`SERIAL_CONSOLE_REPORT.md:46-152` documented the kernel's
`console=ttyS0` parsing in detail; nothing in the boot path varies
with the root filesystem.

The integration test confirms empirically: `Direct console, scan
kbd...` (the post-`set_console` marker) appears in TX bytes after
boot, and `VFS: Mounted root device` follows — both reach the UART
exactly as they do on the FAT serial image.

### 5. What's the userland init mechanism?

`init=/bin/sh`, same as the FAT serial image. The brief asked us not
to assume; we verified by running the harness with the new image and
observing the `# ` prompt arrive in TX bytes after the kernel banner.

The MINIX image ships with more userland (including an `/etc/inittab`
that, among other things, may have a `ttyS0` entry — the upstream's
inittab template does include serial getty lines). But pursuing
serial-getty-on-MINIX would diverge from the FAT serial path's
shape. Using `init=/bin/sh` for both variants gives identical
observable behaviour (one shell prompt over /dev/console), keeps the
report symmetric, and avoids any dependency on userland configuration
we can't observe at build time. The MINIX image's `/dev` nodes
(`rd0`, `rd1`, ...) are visible to the shell regardless of init choice
because they live on the mounted root.

## Build script extension

`tools/elks-build/build-serial-image.ts` grew a `parseArgs` helper
that recognises `--filesystem fat|minix` (or the `=` form) and an
`IMAGE_SPECS` table mapping each filesystem to source/destination
paths. The single hot loop is unchanged: read source image, locate
`## /bootopts`, replace 1024 bytes, write destination. The
`buildBootopts()` function is shared — both variants get identical
`/bootopts` content because the kernel binary (and thus its boot-
parameter parsing) is shared too.

Implementation choices:

- **One `IMAGE_SPECS` table** rather than two functions. The dispatch
  is essentially a path lookup; a `buildFat()` / `buildMinix()` split
  would be ceremony without payoff.
- **Optional positional overrides preserved.** Phase 8's
  `[src] [dst]` positional args still work; the flag is parsed first
  and the remaining positionals override the table's defaults.
- **Default `fat` for back-compat.** `npm run build:elks-serial-image`
  produces `fd1440-fat-serial.img` exactly as before; existing tests
  and harness invocations are untouched.

`package.json` adds one script:

```json
"build:elks-serial-image-minix":
    "tsc -p tsconfig.cli.json && node dist-cli/tools/elks-build/build-serial-image.js --filesystem minix"
```

The pre-existing `build:elks-serial-image` is unchanged.

## /bootopts edit details

Built content (identical for both variants):

```
## /bootopts emu86 serial console build
hma=kernel
console=ttyS0,9600
init=/bin/sh
\0\0...   (NUL pad to 1024 bytes)
```

In-place edit byte offset:

| Image                       | `## /bootopts` offset | Block end |
|-----------------------------|----------------------:|----------:|
| `fd1440-fat.img`            | 0xEDC00 (973824)      | 0xEE000   |
| `fd1440-minix.img`          | 0x15400 (87040)       | 0x15800   |

Both images stay exactly 1,474,560 bytes (1.44 MB) because the file
size doesn't change and the rest of the image is byte-for-byte
identical to its source.

## Integration test

`tests/integration/elks-ramdisk-serial.test.ts` (1 test case, ~190
lines).

Three-phase shape mirroring `elks-ramdisk.test.ts` and
`elks-serial.test.ts`:

1. **Boot to `# ` prompt over UART** (8M instructions, empirically
   ~3.6M consumed). Asserts `Direct console, scan kbd` and
   `VFS: Mounted root device` and a trailing `# ` in TX bytes.
2. **Inject the six-command ramdisk sequence**, command by command,
   in ≤12-byte chunks. The UART RX FIFO holds 16 bytes; chunked
   feeding with a 200K-instruction drain between chunks keeps the
   FIFO from overflowing. Each command then runs to completion
   under a per-command instruction budget (6M-12M).
3. **Assert on the captured TX transcript.** The `ramdisk` tool's
   success message `Kb ramdisk created on /dev/rd0` appears, the
   round-trip payload `hello-serial-ramdisk` echoes back from `cat`,
   and no allocator/error strings surface.

Test wall-clock: ~33-35 s (vs. ~28 s for the keyboard-injected sibling
on the CGA harness; the difference is the chunked-feed overhead and
the slightly higher total instruction budget — UART byte-by-byte
echo through line discipline takes a few extra cycles per character
versus the kernel's keyboard-scancode batched path).

Transcript excerpt (from `# ` prompt onward):

```
# ramdisk /dev/rd0 make 64
ramdisk: 64Kb ramdisk created on /dev/rd0
# mkfs /dev/rd0 64
[mkfs banner + block counts]
# mount /dev/rd0 /mnt
# echo hello-serial-ramdisk > /mnt/test
# cat /mnt/test
hello-serial-ramdisk
# umount /mnt
#
```

Because the UART captures every byte the kernel emits to /dev/console,
the test can assert directly on TX without scraping a CGA framebuffer
mirror — that's the cleaner-harness payoff the brief named.

## Existing-test guardrails

The brief's hard rule about not breaking 1,254 tests held. Specific
existing tests to call out:

- `tests/integration/elks-serial.test.ts` (Phase 8). Uses the FAT
  serial path with the in-place /bootopts edit at test setup time.
  Unchanged. Still passes.
- `tests/integration/elks-interactive.test.ts` (Phase 7). Boots
  `fd1440-minix.img` via the keyboard-injection harness. Unchanged.
  Still passes.
- `tests/integration/elks-ramdisk.test.ts` (Phase 11.5). The
  CGA-harness ramdisk test the new test mirrors over UART. Unchanged.
  Still passes.

The new test is opt-in and additive. Nothing in `src/` was modified.

## What's deferred

Per Section 4 of the brief:

- New harness modes. The serial harness loads whatever image you
  point it at; this brief just gave it another option.
- Default-image change for `npm run start:elks-serial`. Stays on
  `fd1440-fat-serial.img`.
- ELKS kernel rebuilds. Just `/bootopts` edits.
- Other filesystem variants (ext2 etc.). Out of scope.
- A general image-edit framework. The `--filesystem` flag is a small
  dispatch, not a plugin system.
- Probe-harness scaffolding (Phase 12).
- Toolchain survey work (Phase 13).
- Multi-disk integration via the new image (the existing
  `elks-multi-disk-boot.test.ts` covers routing; the new image
  becomes another candidate primary if a future test wants device
  nodes + serial UART together).
- Browser-side default-image change. The web harness fetches
  whatever its config points to; untouched here.

## Things future briefs should address

1. **Phase 12 (probe harness).** The MINIX serial image is now the
   cleanest substrate for probe scripts that need scratch space:
   ramdisk allocates and formats fine; the probe captures via UART
   TX without keyboard-injection brittleness. The secondary-disk
   path (Phase 11) is still simpler for "scripts in, output out",
   but ramdisk wins when the probe wants throwaway scratch that
   doesn't inflate an image fixture.
2. **Phase 13 (toolchain survey).** If a MINIX image variant ships
   `/bin/cc` or similar, the serial harness path against that image
   would be the obvious target — UART transcript captures compiler
   diagnostics cleanly.
3. **Serial getty on MINIX.** Today both serial images use
   `init=/bin/sh`, which works but bypasses inittab. A future brief
   could explore whether the upstream MINIX image's inittab already
   has a `ttyS0` getty entry (or could be edited to add one) so the
   image reaches a `login: ` prompt cleanly. Not load-bearing for
   any current use case; would need the same in-place-edit
   discipline (or an actual MINIX V1 writer) for `/etc/inittab`.
4. **Image-build deduplication.** `tests/integration/elks-serial.
   test.ts` and `tests/integration/elks-ramdisk-serial.test.ts` both
   inline a `buildBootopts()` that mirrors the build-tool's. The
   shape is small enough that drift is unlikely, but a shared
   `tools/elks-build/bootopts.ts` helper would centralise the bytes.
   Out of scope here.

## CPU/memory bug candidates

None observed. Image-build is purely byte-level edits to a fixture
file; the integration test exercises the same syscall surface
(open/ioctl/read/write/mount/umount) that Phase 11.5 already verified.
Boot path and ramdisk allocation behaved identically to the CGA
harness sibling.

## Release snapshot

Layout: `releases/phase-11-6-minix-serial/`

```
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/                       # compiled Node CLI
├── dist-web/                       # Vite production bundle
└── reference/                      # fixtures
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img
    │   └── fd1440-minix-serial.img
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/
        ├── hd32-fat.img
        └── hd32-minix.img
```

`node_modules/` not copied (per Phase 11.5 convention).

Verified by:

- `node releases/phase-11-6-minix-serial/dist-cli/tools/elks/run-serial.js
  releases/phase-11-6-minix-serial/reference/elks-images-serial/fd1440-fat-serial.img`
  reaches the post-boot `# ` prompt — no regression.
- `node releases/phase-11-6-minix-serial/dist-cli/tools/elks/run-serial.js
  releases/phase-11-6-minix-serial/reference/elks-images-serial/fd1440-minix-serial.img`
  reaches the `# ` prompt and `ls /dev` shows `rd0`, `rd1`, `console`,
  `tty1`-`tty4`, `ttyS0`-`ttyS3`, etc.
- `node releases/phase-11-6-minix-serial/dist-cli/tools/elks/run.js`
  reaches the MINIX `login:` prompt — no regression.

## Verification

From the repo root:

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.web.json
(clean)

$ npm test
…
 Test Files  73 passed (73)
      Tests  1255 passed (1255)
   Duration  234.83s

$ npx vitest run tests/integration/elks-ramdisk-serial.test.ts
 ✓ tests/integration/elks-ramdisk-serial.test.ts  (1 test) 33420ms
   Tests  1 passed (1)

$ npm run build:elks-serial-image
Wrote serial-console image (fat): …/reference/elks-images-serial/fd1440-fat-serial.img
/bootopts replaced at offset 0xedc00 (1024 bytes)

$ npm run build:elks-serial-image-minix
Wrote serial-console image (minix): …/reference/elks-images-serial/fd1440-minix-serial.img
/bootopts replaced at offset 0x15400 (1024 bytes)
```

SST corpus: 323/323 passing within the full-suite run.

## Reference sources

1. `SERIAL_CONSOLE_REPORT.md` — Phase 8's `/bootopts` edit pattern.
2. `RAMDISK_REPORT.md` — Phase 11.5's MINIX-vs-FAT device-node finding
   and the ramdisk usage flow exercised here.
3. `tools/elks-build/build-serial-image.ts` — the script extended.
4. `tests/integration/elks-serial.test.ts` — Phase 8 test, template
   for the UART TX assertion shape.
5. `tests/integration/elks-ramdisk.test.ts` — Phase 11.5 test, source
   of the six-command ramdisk sequence and the assertion strings.
6. `src/devices/uart-16550.ts:62-63` — the 16-byte FIFO depth that
   motivated the chunked-feed pattern in the new test.
7. `reference/elks/elks/init/main.c` — kernel boot-parameter parsing
   (referenced indirectly via Phase 8).
