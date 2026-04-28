# emu86 — Agent Brief: MINIX Serial Floppy Image (Phase 11.6)

## TL;DR

Build a serial-console-configured MINIX-FS floppy image that
unifies two strands of the harness: the **MINIX filesystem's
support for device nodes** (which Phase 11.5 confirmed is
required for `/dev/rd0` and similar) plus the **serial console
configuration** (which Phase 8 established as the cleaner harness
path). Today these are separate images:

- `fd1440-fat-serial.img` — serial console, no device nodes (FAT12
  can't store them).
- `fd1440-minix.img` — device nodes, but CGA-only (no
  `console=ttyS0` in `/bootopts`).

After this brief: `fd1440-minix-serial.img` exists, has both, and
can serve as a probe-harness / ramdisk-test target via the cleaner
serial path. The FAT serial image stays as the default for tests
that already use it; the MINIX serial image becomes a sibling
opt-in.

The build script generalises: `tools/elks-build/build-serial-image.ts`
gains a `--filesystem fat|minix` flag (defaulting to `fat` for
back-compat), one script handles both.

This is image-build work, not substrate work. No new BIOS
handlers, no new devices, no kernel rebuilds. Just an extra
image variant with the same `/bootopts` edit pattern Phase 8
established.

Document in `SERIAL_MINIX_REPORT.md`.

You are working in `emu86/`. Read `SERIAL_CONSOLE_REPORT.md`
(Phase 8's image-build mechanism and the `/bootopts` edit) and
`RAMDISK_REPORT.md` (Phase 11.5's MINIX-image verification — the
device-node finding motivates this brief). The build script you'll
extend is `tools/elks-build/build-serial-image.ts`.

## Hard rules

1. **Don't break existing tests.** 1,254 passing as of Phase 11.5.
   All must stay green, including the existing serial integration
   tests that depend on `fd1440-fat-serial.img`.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **No substrate changes.** This is image-build and test-fixture
   work. The lock list is restrictive on purpose.
6. **You may modify** `tools/elks-build/build-serial-image.ts`
   (add the `--filesystem` flag), `package.json` (npm scripts),
   and any test files that benefit from the new image. You may
   add a new integration test or two demonstrating the new
   image's value (serial harness + ramdisk, for instance).
7. **You may NOT modify** anything in `src/cpu8086/`,
   `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`,
   `src/timing/`, `src/devices/`, `src/console/`, `src/disk/`,
   `src/bios/`, `src/host-clock/`, `src/diagnostics/`,
   `src/machine/`, `src/browser/`, or `web/`. Image-build code
   only, plus tests.
8. **Don't change the default serial image.** `fd1440-fat-serial.img`
   stays the default for `npm run start:elks-serial` and for the
   existing serial integration tests. The MINIX variant is a
   sibling opt-in. Renaming or replacing the default would churn
   tests and is explicitly out of scope.
9. **No kernel rebuild.** Phase 8 established that we don't need
   the ELKS toolchain on the user's machine — the serial-console
   change is purely a `/bootopts` edit to a published image. Same
   discipline applies here. If something demands a kernel rebuild,
   stop and report.

## Background

Phase 8 built `fd1440-fat-serial.img` by mounting the upstream
`fd1440-fat.img`, editing `/bootopts` to include `console=ttyS0`,
and re-packing. The image worked because FAT12 supports text-file
edits via `mtools`/loop-mount.

Phase 11.5's diagnosis surfaced a real limit: **FAT12 cannot store
device nodes**. The serial FAT image's `/dev` directory is empty
because the filesystem doesn't support character/block special
files. This rules out using the serial harness for any feature
that requires device nodes — including ramdisk verification,
which is why Phase 11.5 fell back to the CGA-on-MINIX harness.

The MINIX V1 filesystem on `fd1440-minix.img` does support device
nodes — `/dev/rd0`, `/dev/rd1`, `/dev/hda`, `/dev/console`, etc.
all exist. But that image's `/bootopts` lacks `console=ttyS0`, so
boot output goes to CGA only.

The fix is to apply Phase 8's `/bootopts` edit pattern to the
MINIX image. Mechanically the steps are the same; the filesystem
manipulation differs (MINIX V1 has different on-disk structure
from FAT12).

## Scope

### Section 1 — diagnosis (mandatory first step)

Before writing the build script extension:

1. **What tools are available for editing MINIX V1 filesystems?**
   Phase 8 used `mtools` for FAT. For MINIX, options include:
   - Loop-mount the image (Linux-only, requires root or
     `unshare`-like privileges; possibly fragile in the agent's
     environment).
   - `mfs-utils` package (Debian: `sudo apt install mfs-utils`;
     not always available; check first).
   - A pure-TypeScript MINIX V1 read/write library — possibly
     overkill for one-file-edit, but worth checking npm.
   - In-place hex editing if the `/bootopts` file's location is
     deterministic — possibly the simplest approach for a single
     known file in a known fixture image.
   Confirm what's actually available on the agent's machine. If
   the toolchain is missing, document and stop. **No
   fix-and-pray.**
2. **Where does `/bootopts` live in `fd1440-minix.img`?** Walk
   the MINIX V1 directory structure. The file is in the root
   directory; find its inode, the inode's data blocks, and the
   on-disk byte offset. This is information either way: in-place
   editing needs it directly; tool-based editing benefits from
   it as a verification step.
3. **What's the existing `/bootopts` content in the MINIX
   image?** If it lacks the `console=ttyS0` line, we add it. If
   it has *different* lines we'd be overwriting, document that
   and confirm the change is safe. The Phase 8 brief noted that
   the FAT image's `/bootopts` was a specific format with
   `##`-prefixed lines and a NUL terminator — same conventions
   probably apply.
4. **Does the MINIX image's kernel honour `console=ttyS0`?**
   Sanity check: the kernel binary is the same (or near-identical)
   to the one in `fd1440-fat.img`, so the `console=ttyS0` boot-
   parameter parsing should already exist. Phase 8 confirmed this
   for the FAT case; the MINIX case should inherit. Verify by
   reading the kernel's boot-parameter handling.
5. **What's the MINIX image's userland init mechanism?** The FAT
   serial image uses `init=/bin/sh` per its `/bootopts` (Phase 8
   noted this — getty was rebuilt out, the kernel runs `/bin/sh`
   directly because `/etc/inittab` lacked a serial getty entry).
   The MINIX image has a different userland; check whether
   `/etc/inittab` already supports serial getty, or whether we
   need the same `init=/bin/sh` workaround.

If Section 1 surfaces an environmental blocker (no MINIX tools,
no privilege for loop-mount, complex kernel-rebuild requirement),
stop and document.

### Section 2 — implementation: build script extension

`tools/elks-build/build-serial-image.ts`:

- Add a `--filesystem fat|minix` flag, defaulting to `fat`
  for back-compat.
- For `--filesystem fat`: existing behavior unchanged. The
  default `npm run build:elks-serial-image` continues to produce
  `fd1440-fat-serial.img` exactly as before.
- For `--filesystem minix`: source the upstream
  `fd1440-minix.img` (or fetch it via the existing GitHub
  release workflow if not present locally), apply the
  `/bootopts` edit using whatever mechanism Section 1 deemed
  workable, output `fd1440-minix-serial.img`.
- Output paths: keep them parallel —
  `reference/elks-images-serial/fd1440-fat-serial.img` (existing)
  and `reference/elks-images-serial/fd1440-minix-serial.img`
  (new).

`package.json`:

- Existing `build:elks-serial-image` script — unchanged.
- New `build:elks-serial-image-minix` script that invokes the
  extended build with `--filesystem minix`. Or pass-through args
  on the existing script (`build:elks-serial-image -- --filesystem
  minix`); pick whichever is more idiomatic with the existing
  script-runner conventions.

If the build script's existing logic is FAT-specific in places
that aren't easy to generalise, structure with a small dispatch:
a `buildFat()` and `buildMinix()` function, both calling shared
helpers for path management and the `/bootopts` text. Don't
over-engineer; the goal is one script handling both, not a
framework.

### Section 3 — integration test demonstrating value

Add one integration test that uses the new image and exercises a
device-node-dependent feature over serial. The most natural
candidate: ramdisk round-trip on the serial harness (the same
shape Phase 11.5 verified, but via UART instead of keystrokes).

**`tests/integration/elks-ramdisk-serial.test.ts`** *(new, 1 case).*

- Boot the serial harness with `fd1440-minix-serial.img`.
- Inject `root\n` (or whatever login the MINIX userland needs;
  may differ from FAT's `init=/bin/sh`).
- Inject the Phase 11.5 ramdisk sequence:
  - `ramdisk /dev/rd0 make 64\n`
  - `mkfs /dev/rd0 64\n`
  - `mount /dev/rd0 /mnt\n`
  - `echo hello-serial-ramdisk > /mnt/test\n`
  - `cat /mnt/test\n`
  - `umount /mnt\n`
- Capture the UART transcript (this is what Phase 8 made easy).
- Assert on `Kb ramdisk created on /dev/rd0` and
  `hello-serial-ramdisk` round-tripping back via the kernel's
  tty echo.

This test is the proof-point for the new image's value — it
exercises a feature the existing FAT-serial image cannot run.

If the build can't produce the image (Section 1 blocker), this
test gets skipped with a clear message; the fixture-fetch
pattern Phase 10/10.2 used applies.

### Section 4 — what you are NOT building

- A new harness target ("MINIX serial" as a third harness mode
  alongside "CGA" and "serial"). The existing serial harness
  loads whatever image you point it at; this brief just gives it
  a new option.
- A different default. `fd1440-fat-serial.img` stays the default
  for `npm run start:elks-serial` and for existing tests.
- ELKS kernel rebuilds. Just `/bootopts` edits.
- Building images for any other filesystem (ext2, etc.).
- A general "image-edit" framework. The `--filesystem` flag is
  a small dispatch, not a plugin system.
- Probe-harness scaffolding. Phase 12.
- Toolchain survey work. Phase 13.
- Multi-disk integration via the new image (the existing
  multi-disk tests cover routing; the new image just gives those
  tests another candidate primary).
- Browser-side default-image change. The web harness fetches
  whatever its config points to; this brief doesn't touch that.

## Tests

### Unit tests

Probably none. If a small helper module emerges from the build
script (e.g., a `bootopts-edit.ts`), unit-test it. Otherwise
skip.

### Integration tests

- **`tests/integration/elks-ramdisk-serial.test.ts`** — the
  Section 3 test. Skip-with-pointer if the fixture isn't built.

### Smoke tests

All Phase 1-11.5 tests must keep passing. The existing serial
tests (`elks-serial-boot.test.ts` and friends) use
`fd1440-fat-serial.img`; they must continue working unchanged.
The MINIX-CGA tests (Phase 7's `elks-interactive`) use
`fd1440-minix.img`; they must continue working unchanged.

## Watch out for

- **MINIX V1 tooling availability.** The single biggest unknown.
  Section 1's diagnosis must confirm what works on this machine
  before committing to an approach. If `mfs-utils` is absent and
  loop-mount needs root and pure-TypeScript MINIX libraries
  don't exist, in-place hex editing of `/bootopts` is the
  fallback — but it requires knowing the exact byte offset.
- **In-place editing as a fallback.** If the `/bootopts` file's
  inode → data block → byte offset is stable across the
  upstream MINIX image, in-place hex editing is robust enough
  for one-file changes. Document the offset; pin it in a test.
  Future ELKS releases that change the layout would break this,
  but breakage would be loud (the kernel wouldn't boot).
- **The MINIX userland's init.** Phase 8 used `init=/bin/sh`
  because the FAT image's `/etc/inittab` lacked a serial getty.
  The MINIX image has more userland; check whether the standard
  MINIX `inittab` includes a `ttyS0` entry. If it does, the
  serial harness reaches `login:` cleanly. If not, the same
  `init=/bin/sh` workaround applies. Don't assume; verify.
- **The `bootopts` parsing convention.** Phase 8 noted that
  ELKS's `/bootopts` parser requires lines to start with `##`
  and the file to end with NUL. Same convention applies to the
  MINIX image; preserve it.
- **`/bootopts` may not exist on the upstream MINIX image.** It
  exists on the FAT image because it was added there. The MINIX
  image might lack it entirely; in that case the brief becomes
  "create `/bootopts` from scratch" rather than "edit existing".
  Both are workable; Section 1 surfaces which.
- **Test wall-time.** The Phase 11.5 ramdisk test takes ~28s on
  the CGA harness. The serial version should be similar or
  faster (no keystroke-injection delay). If meaningfully slower,
  document why.
- **Don't let test changes ripple.** The new test is opt-in. Don't
  edit existing serial tests to use the new image just because
  you can; they're stable, and changing them is churn for no
  gain.

## Definition of done

**Outcome A (full success, the expected case):**
- `--filesystem` flag added to the build script.
- `fd1440-minix-serial.img` builds and is reproducible.
- Serial-ramdisk integration test passes.
- All prior tests still pass.
- Total tests ≥ 1,255.

**Outcome B (build works but kernel doesn't honour serial config):**
- Build pipeline works at the file-edit level.
- Kernel still emits to CGA after the edit.
- Diagnosis section explains why.
- No integration test (or one skipped with reason).
- All prior tests still pass.

**Outcome C (build pipeline blocked by tooling):**
- Diagnosis section documents what tools were tried.
- Concrete unblocking checklist.
- All prior tests still pass.

In all cases:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean.
- Release snapshot at `releases/phase-11-6-minix-serial/`
  populated and manually launch-verified.

## Release snapshot

Layout:

```
releases/phase-11-6-minix-serial/
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/
├── dist-web/
└── reference/
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img
    │   └── fd1440-minix-serial.img    # if Outcome A
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/
        ├── hd32-fat.img
        └── hd32-minix.img
```

`node_modules/` not copied.

Verify the snapshot is launchable manually:
- Node serial harness boots `fd1440-fat-serial.img` (no regression).
- Node serial harness boots `fd1440-minix-serial.img` to a
  prompt where `ls /dev` shows `rd0` and `rd1` (Outcome A).
- Browser harness boots default (no regression).

The report at `SERIAL_MINIX_REPORT.md` has these sections:

- **Summary**: outcome, what works.
- **Diagnosis (Section 1)**: tooling availability, `/bootopts`
  location and content, kernel boot-param handling, userland
  init mechanism. With citations.
- **Build script extension**: how the `--filesystem` flag is
  implemented; FAT path unchanged; MINIX path described.
- **Integration test**: serial-ramdisk round-trip; what asserts
  succeed; transcript excerpt.
- **`/bootopts` edit details**: what changed; if in-place editing
  was used, the byte offset; if a tool was used, which one.
- **What's deferred**: per Section 4 of this brief.
- **Things future briefs should address**:
  - Phase 12 (probe harness) now has both serial and CGA
    harness options for device-node-using tests.
  - Phase 13 toolchain survey may benefit from the serial
    harness path against MINIX images that ship `/bin/cc` or
    similar.
  - Other deferrals carry forward.
- **CPU/memory bug candidates**: should be none; image-build
  doesn't exercise the CPU.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`SERIAL_CONSOLE_REPORT.md`** — Phase 8's `/bootopts` edit
   pattern; the playbook this brief follows.
2. **`RAMDISK_REPORT.md`** — Phase 11.5; the MINIX-vs-FAT
   device-node finding that motivated this brief, and the
   ramdisk usage flow the new test exercises.
3. **`tools/elks-build/build-serial-image.ts`** — the script you
   extend.
4. **`reference/elks/elks/init/main.c`** if the kernel boot-param
   parsing needs review.
5. **`reference/elks/image/`** — image build configs and Make
   files; useful for understanding how upstream produces the
   MINIX image.
6. **MINIX V1 filesystem layout reference**: any description of
   the on-disk format. The MINIX original docs or any modern
   filesystem-archaeology page works.

## Final notes

This is small and well-shaped. The work is image-build, with the
agent's main creative decision being how to edit a MINIX
filesystem in the agent's environment. That's a Section 1
diagnosis question with three plausible answers (loop-mount,
mfs-utils, in-place hex edit), each cleanly testable.

After this lands, Phase 12's probe harness has a cleaner
substrate to build on: serial harness + device nodes available
in one image. Probe scripts can write to ramdisk, the harness
captures via UART, no keystroke-injection brittleness for the
output capture path.

The discipline this brief asks for: **don't generalise the
image-build infrastructure beyond what's needed**. Two
filesystem variants is enough; a plugin system for arbitrary
filesystems is over-engineering. Phase 8's spirit was "edit one
file in one image"; this brief's is "now do the same edit in a
different image."
