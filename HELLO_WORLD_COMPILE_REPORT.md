# Hello-World Compile Report — Phase 14, step 1

**Date:** 2026-07-13
**Base commit:** `f17435d` (audit report), code changes on top
**Outcome:** ✅ **Outcome A — full success on the first build attempt.** A C source file was shipped into the emulated machine, compiled by the on-disk native C86 toolchain (`cpp` → `c86` → `as` → `ld`, all inside the VM), and the resulting binary was executed in-guest and printed the expected string. This is the first program ever compiled *and run* inside emu86.

**Process note:** this phase ran without a written brief — Jonathan moved planning into the working session (2026-07-13) and directly instructed "start on #1" against `EMU86_AUDIT_REPORT.md` §11's first recommendation, which itself implements the next step defined by `PROBE_HARNESS_EXTENSION_REPORT.md`. This report is written to the same standard a briefed phase would produce.

---

## 1. What was verified, verbatim

`EMU86_HELLO_WORLD_VERBOSE=1 npx vitest run tests/integration/hd32-hello-world.test.ts`:

```
=== HD32 hello-world probe findings ===
image: /home/jonathan/Projects/emu86/reference/elks-images-hd/hd32-minix.img
instructions used: 50,000,000
boot reached prompt: true
kernel panicked: false
truncated: false
extracted complete: true
hello ran: true

--- pipeline stages ---
  copy: rc=0
  cpp: rc=0
  c86: rc=0
  as: rc=0
  ld: rc=0
  run: rc=0

--- section @@run@@ ---
hello from emu86 phase 14
rc=0

--- section @@artifacts@@ ---
-rwxrwxrwx  1 root  root  3156  hello
-rw-rw-rw-  1 root  root   386  hello.as
-rwxr-xr-x  1 root  root    96  hello.c
-rw-rw-rw-  1 root  root  3739  hello.i
-rw-rw-rw-  1 root  root   116  hello.o

 Test Files  1 passed (1)   Tests  1 passed (1)   Duration 41.05s
```

The source is a plain `#include <stdio.h>` / `printf` hello-world (see `HELLO_C_SOURCE` in the probe module). All intermediate artifacts have plausible sizes (3.7 KB preprocessed, 386 B assembly, 116 B object, 3.2 KB linked binary against `libc86.a`).

## 2. What was built

Two new files, following the Phase 13.1 pattern:

- **`tests/probe/surveys/hd32-hello-world.ts`** — `runHd32HelloWorld()`: boots `hd32-minix.img` via the `/bootopts` init path with a 33-byte bootopts payload (`mount /dev/fd0 /mnt;sh /mnt/go.sh`); all real work lives in `go.sh` on the FAT12 probe floppy (no size limit), alongside `hello.c`. Exports the build script, a discovery-only recon script, a generic `@@name@@` section splitter, and a per-stage `rc=` classifier.
- **`tests/integration/hd32-hello-world.test.ts`** — end-to-end test asserting every pipeline stage exits 0 and the compiled binary's output appears. Skips-with-reason if the image is absent. `EMU86_HELLO_WORLD_VERBOSE=1` / `_DUMP=1` for report-grade output. 15-minute timeout (actual: ~40 s).

No changes to `src/`, no harness changes, no new dependencies. The known `runUntilSentinel` echo bug was worked around (again), not fixed — same as Phases 13/13.1.

## 3. The native compile recipe (now on the record)

Obtained by a reconnaissance boot that ran `cat /usr/src/Makefile` **inside the guest** — the image ships ghaerr's `Makefile.elks` (installed by `reference/elks/copyc86.sh`, which is also the manifest of everything under the image's `/usr`):

```
cpp -0 -I/usr/include -I/usr/include/c86 hello.c -o hello.i
c86 -g -O -bas86 -separate=yes -warn=4 -lang=c99 -align=yes \
    -stackopt=minimum -peep=all -stackcheck=no hello.i hello.as
as  -0 -j hello.as -o hello.o
ld  -0 -i -L/usr/lib -o hello hello.o -lc86
```

Also on the image, per `copyc86.sh`: `/usr/bin/{make,cpp,c86,as,ld,ar,objdump,disasm86}` (disasm86 is an eighth binary the Phase 13 survey never listed), `/usr/lib/libc86.a`, a real `/usr/include` tree (+ `include/c86`), and the C86 example sources in `/usr/src` — including `chess.c`. `make` is present and the Makefile is native-ready, so Makefile-driven builds (which the NE2000 work will want) are available without further infrastructure.

## 4. Findings that will matter for the rest of Phase 14

1. **The probe floppy is `/dev/fd0` on an HD primary, not `/dev/fd1`.** Drive numbering is per-class in slot order (`bios-services.ts:99` `routeDrive`; the docblock's example spells this exact case out). The Phase 12 harness documentation says `/dev/fd1` because every earlier probe used a floppy primary. Anyone scripting against HD images must use `/dev/fd0` — this would have been a silent mount failure otherwise.
2. **The harness boot phase always burns its entire `bootInstructionBudget`** — `traceRun` has no early exit when the prompt appears (`probe-harness.ts:259`). Budget choice is therefore *the* wall-clock knob: the pipeline needed 48M instructions of boot budget and took ~40 s. Don't set 200M "for safety"; you'll wait for all of it, every run.
3. **The audit's "~10× slower box" observation was a measurement artifact — this machine is roughly as fast as the original phase machines.** Today's solo runs: 50M instructions ≈ 40 s (~1.25M instr/s), vs the Phase 12 report's ~1M instr/s. The audit's 74 s trivial-probe measurement ran concurrently with six other auditor agents and the full test suite. `EMU86_AUDIT_REPORT.md` §2's environment note is hereby corrected.
4. **Marker hygiene is free on this path.** Because `__B__`/`__E__` and the `@@stage@@` markers are echoed by a script *file* on the floppy (not embedded in `/bootopts`, not typed at a prompt), nothing in the transcript can collide with them — cleaner than both prior surveys.
5. **`/tmp` on the MINIX root is writable and roomy enough** for the whole pipeline's intermediates; the FAT12 probe floppy was used read-only.

## 5. What was deliberately NOT done

- **No guest→host artifact extraction** — the compiled `hello` binary lives and dies inside the boot's in-memory disk image. Proving it ran (stdout capture) was this step's definition of done. Extraction (reading FAT12 back, or MINIX-fs read of the primary) is the next infrastructure gap and a prerequisite for harvesting a compiled NE2000 driver.
- **No sentinel-echo bug fix** — third phase in a row to work around it. If any future probe outgrows the bootopts+floppy-script pattern, fix it then.
- **No `make`-driven build** — the manual four-stage pipeline was chosen so each stage's exit code is individually attributable. `make` exists on-image and `/usr/src/Makefile` works as a template when multi-file builds arrive.
- **No browser-side work** — Jonathan asked (2026-07-13) for interactive browser access to the machine; the Phase 9 xterm.js harness already provides the terminal and image-library plumbing, but HD-image serial routing (bootopts patch at load) and a real-browser re-verification are needed. Deferred to the Phase 14 brief as its own item.

## 6. Test/typecheck state after this phase

- New baseline: **999 tests** (was 998), 81 test files passed + 1 skipped (SST corpus, unchanged), zero failures — full-suite run recorded below in §7.
- `npm run typecheck` clean (all three configs; `tsconfig.cli.json` also verified clean separately during the audit).

## 7. Reproduction

```
npx vitest run tests/integration/hd32-hello-world.test.ts   # ~40 s
EMU86_HELLO_WORLD_VERBOSE=1 npx vitest run tests/integration/hd32-hello-world.test.ts
npx vitest run                                              # full suite
```

Prerequisites: none beyond the checkout (the image is committed; no network).

## 8. Recommended next steps (Phase 14 proper)

1. **Write the Phase 14 brief in-session** (planning has moved here): NE2000 device model in `src/devices/` (master-PIC IRQ only — IRQ 8–15 unreachable, see audit §6.5), in-VM driver build via the now-proven pipeline, guest→host artifact extraction, and the browser interaction item.
2. **Guest→host extraction first** — it's the only missing infrastructure between "hello world runs" and "a compiled driver binary lands on the host for inspection".
3. Recover `emu86-networking-plan.md` from the planning chats before fixing the device's register-level shape (Jonathan is on this).
