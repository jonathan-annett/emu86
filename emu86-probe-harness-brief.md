# emu86 — Agent Brief: Probe Harness (Phase 12)

## TL;DR

Build a reusable test-side harness that boots ELKS in our emulator,
runs a probe script inside the VM, and captures the script's
output. The probe is staged on a secondary disk image we build at
launch time; the kernel mounts it; userland runs the script via
the serial harness's UART RX path; output is captured from UART
TX.

The deliverable is **infrastructure**, not a feature: the harness
is what Phase 13 (toolchain survey) and many future investigations
will use. One trivial probe demonstrates the harness works
end-to-end. No real survey or analysis happens here.

API surface, roughly:

```ts
const result = await runProbe({
  primaryImage: 'fd1440-minix-serial.img',
  probe: { script: '#!/bin/sh\necho hello', filename: 'probe.sh' },
  timeoutInstructions: 50_000_000,
});
// → result.stdout, result.fullTranscript, result.timedOut, ...
```

Document in `PROBE_HARNESS_REPORT.md`.

You are working in `emu86/`. Read `MULTI_DISK_REPORT.md` (Phase 11
secondary-disk plumbing), `RAMDISK_REPORT.md` (Phase 11.5 ramdisk
verification), and `SERIAL_MINIX_REPORT.md` (Phase 11.6's UART-on-
MINIX-image work and the ramdisk-serial integration test pattern).
The new test from 11.6 (`tests/integration/elks-ramdisk-serial.test.ts`)
is the closest existing template.

## Hard rules

1. **Don't break existing tests.** 1,255 passing as of Phase 11.6.
   All must stay green.
2. **`cpu.step()` stays pure synchronous.** No exceptions.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`, no
   `// @ts-ignore`.
5. **No substrate changes.** This is test-side infrastructure.
   `src/` is locked from edits except where Phase 11 already
   exposed configuration entry points.
6. **You may add** files under `tests/probe/` (the harness
   module + helpers + the trivial probe), `tools/probe-build/`
   if filesystem-image construction needs it, unit tests for
   the harness module, and one integration test exercising it.
7. **You may NOT modify** anything in `src/cpu8086/`,
   `src/memory/`, `src/runtime/`, `src/interrupts/`, `src/io/`,
   `src/timing/`, `src/devices/`, `src/console/`, `src/disk/`,
   `src/bios/`, `src/host-clock/`, `src/diagnostics/`,
   `src/machine/`, `src/browser/`, or `web/`. The harness uses
   what Phase 11 already built; it doesn't extend the substrate.
8. **No real toolchain investigation.** Phase 13's territory.
   This brief produces the tool, not its first non-trivial
   application.

## Background

Phase 11 added the substrate for two simultaneously-mounted disks.
Phase 11.5 confirmed `/dev/rd0` works for in-RAM scratch. Phase
11.6 made `fd1440-minix-serial.img` available — UART console
*and* device nodes in one image. The accumulated substrate makes
"boot the VM, run a script, capture its output" cleanly possible
without touching `src/`.

The probe-harness pattern looks like this end-to-end:

1. Build a small filesystem image containing the probe script.
2. Boot ELKS with the primary image as `/dev/hda` (or `/dev/fd0`)
   and the probe image as `/dev/hdb` (or `/dev/fd1`).
3. Wait for the `# ` prompt.
4. Inject `mount /dev/hdb /mnt && sh /mnt/probe.sh` over UART.
5. Read UART TX bytes until a sentinel marker appears.
6. Return the captured transcript, parsed for the probe's stdout.

The reusable bit is steps 1-6 wrapped as one function. Each future
probe is just a different script string; everything else is shared.

## Scope

### Section 1 — diagnosis (mandatory first step)

Before writing the harness:

1. **What's the smallest feasible probe-disk filesystem?** FAT12
   on a small floppy-class image is the obvious candidate (no
   device-node need; broad userland support; existing build
   tooling in Phase 11.6's mtools-or-equivalent). MINIX V1 is
   also possible but more complex to construct programmatically.
   Pick FAT12 unless there's a reason not to. Document the
   choice and the build mechanism.
2. **What does ELKS's mount look like for an arbitrary FS?** It
   should auto-detect from the superblock; confirm. Specifically:
   `mount /dev/hdb /mnt` without `-t` flag — does it work for a
   FAT volume on a 360K floppy or a 1.44M floppy? Cite the
   kernel-side detection.
3. **What's the smallest disk image size that's still bootable
   metadata-wise?** A 360K floppy fits more probe scripts than a
   1.44M one needs, but takes up image bytes. The harness's
   probe disk doesn't need to be bootable, just mountable, so
   smaller is fine. Pick a sensible default; document.
4. **What sentinel pattern works for "probe done"?** A script
   that ends with `echo __PROBE_DONE__` is robust (the marker
   appears in TX bytes when the kernel's tty discipline echoes
   the line). The harness watches for that exact string. Confirm
   nothing else in normal kernel output produces a false match
   (banner, login, etc.).
5. **Filesystem-image construction in the agent's environment.**
   Phase 11.6 found in-place hex edit was the simplest way to
   modify an existing image. For *building from scratch*, options
   include:
   - `mtools` (`mkfs.fat`, `mcopy`) — Linux/macOS package.
   - Pure-TypeScript FAT12 writer — possibly small enough to
     write inline if mtools is absent.
   - A pre-built empty FAT image template + `mcopy`-equivalent
     via the same in-place hex edit pattern.
   Confirm what's available; pick the simplest workable
   approach.

### Section 2 — harness API and module layout

`tests/probe/probe-harness.ts` (or wherever fits) exports:

```ts
export interface ProbeRequest {
  primaryImage: string | Uint8Array;       // path or bytes
  probe: ProbeScript;
  timeoutInstructions?: number;             // default e.g. 100M
  maxOutputBytes?: number;                  // default e.g. 256KB
}

export interface ProbeScript {
  filename: string;                          // e.g. 'probe.sh'
  script: string;                            // shell content, no shebang needed
  // additional files staged onto the probe disk:
  extraFiles?: { name: string; content: string | Uint8Array }[];
}

export interface ProbeResult {
  stdout: string;                            // bytes between probe start and sentinel
  fullTranscript: string;                    // entire UART TX since boot
  timedOut: boolean;
  instructionsUsed: number;
  bootStdout: string;                        // pre-probe boot output (kernel banner, login, etc.)
}

export async function runProbe(req: ProbeRequest): Promise<ProbeResult>;
```

A pure function: input config in, output result out, no global
state, no side effects beyond the in-memory machine. Unit tests
can exercise it directly; integration tests can run it against
real images.

The implementation roughly:

1. Build the probe disk image with the probe script (and any
   extra files) at known paths in the FAT12 root directory.
2. Construct an `IBMPCMachine` with the primary as boot disk and
   the probe disk as secondary.
3. Run the boot loop until the `# ` prompt appears in TX (reuse
   Phase 11.6's pattern).
4. Inject `mount /dev/hdb /mnt && sh /mnt/probe.sh; echo __PROBE_DONE__\n`
   in chunks over UART RX. (The chained command + sentinel-echo
   means the sentinel always fires, even if the probe script
   itself fails.)
5. Run until the sentinel appears in TX *or* timeout.
6. Parse the transcript: bootStdout = up to `# `; stdout = from
   probe-start to sentinel.
7. Return the result.

### Section 3 — filesystem image construction

A helper module (`tools/probe-build/probe-disk.ts` or similar)
constructs the probe-disk bytes from a `ProbeScript`. Given the
diagnosis from Section 1, the implementation is whichever
mechanism Section 1 deemed workable.

Recommended shape: an empty FAT12 360K (or 1.44M) image template
checked into `tests/probe/templates/` (a few hundred bytes of
metadata, mostly NULs), and the helper writes the script bytes
into the data area at known offsets. This avoids depending on
`mtools` being installed.

If a template-and-edit shape doesn't work cleanly, pure-TypeScript
FAT12 writing is fine — the spec is small and stable, and a 200-
line FAT12 writer is reasonable scope.

The helper is unit-testable: given a script, produce bytes;
read those bytes back through a FAT12 reader (or by inspection)
and confirm the script is at the expected place with the expected
content.

### Section 4 — trivial validating probe

One end-to-end test that exercises the harness with a no-op
probe:

```ts
const result = await runProbe({
  primaryImage: 'reference/elks-images-serial/fd1440-minix-serial.img',
  probe: {
    filename: 'hello.sh',
    script: 'echo hello-from-probe',
  },
});
expect(result.stdout).toContain('hello-from-probe');
expect(result.timedOut).toBe(false);
```

This is the validation. If it passes, the harness works. Phase
13 starts using it for real.

### Section 5 — what you are NOT building

- A real toolchain survey, listing of `/usr/bin/`, or anything
  that uses the harness for non-trivial investigation. Phase 13.
- A browser-side probe runner. Test infrastructure only.
- A general "remote shell" abstraction beyond the probe pattern.
- A streaming output mode. Probes are batch: write script, run,
  capture, return.
- Multi-script probes (running several scripts in one boot).
  Future polish if needed.
- Probe scripts that need network. NE2000 doesn't exist yet.
- Probe scripts that need writable output back to the host. The
  probe writes to stdout (captured); writing files to `/mnt` and
  reading them back via the host is a separate concern and out
  of scope here. (Phase 11's secondary-disk supports this in
  principle; if a future probe needs it, a separate brief
  extends the harness.)
- Snapshot/restore so the probe can resume from post-boot. Phase
  11.5's `Things future briefs` flagged this; still future.
- A CGA-mirror fallback for primary images that aren't serial.
  The harness requires a serial-console-configured primary
  image. If a probe needs to run against a non-serial image,
  that's a separate harness or a separate brief.

## Tests

### Unit tests

- **`tests/probe/probe-disk.test.ts`** *(new, ~5-8 cases).*
  Exercise the filesystem-image construction directly: build a
  disk with a known script, verify the bytes at expected offsets;
  check round-tripping (the disk is mountable; the script is
  readable). If FAT12 reader code is added for verification,
  unit-test it too.
- **`tests/probe/probe-harness.test.ts`** *(new, ~3-5 cases for
  pure logic, no machine boot).*
  - Sentinel detection: given a transcript, find the probe's
    stdout window correctly.
  - Timeout enforcement: harness returns `timedOut: true` after
    `timeoutInstructions`.
  - Output cap: harness truncates at `maxOutputBytes` and notes
    truncation in the result.

### Integration tests

- **`tests/integration/probe-harness-trivial.test.ts`** *(new,
  1 case).* The Section 4 validation. Boot, run a no-op probe,
  assert on the captured stdout. Skip if the
  `fd1440-minix-serial.img` fixture isn't built.

### Smoke tests

All Phase 1-11.6 tests must keep passing. The probe-disk
construction must not interact with any prior fixture loading.

## Watch out for

- **The sentinel must be unambiguous.** `__PROBE_DONE__` is fine
  for v0; nothing else in ELKS's normal output produces it. If
  diagnosis surfaces a real-world false-match risk, pick a
  longer / weirder sentinel.
- **Chunked injection over UART.** Phase 11.6's note about the
  16-byte UART RX FIFO and 200K-instruction drain between chunks
  applies. Reuse the helper Phase 11.6 wrote (or generalise it
  if the existing one is integration-test-local).
- **Boot stdout must be separated from probe stdout.** The full
  transcript contains kernel banner, mount messages, prompt,
  injected commands echoed back, *and* probe output. The harness
  must split these correctly. The post-`# ` marker is the
  natural boundary; document the parsing rule.
- **Probes that hang.** Some scripts will hang waiting for input
  that never comes. The instruction-budget timeout catches this,
  but the result needs to clearly report that the probe didn't
  finish. Don't conflate "probe completed but produced no output"
  with "probe timed out."
- **Probes that crash the kernel.** Unlikely but possible. The
  harness should detect a kernel panic in the transcript and
  surface it explicitly (not as a generic timeout).
- **Output buffer overruns.** A pathological probe could produce
  megabytes of output. The cap (default 256KB) prevents this
  from blowing test memory. Document the truncation in the
  result.
- **Don't depend on probe-disk mountability under arbitrary
  conditions.** ELKS's FAT support on floppy-class secondary
  drives should work (Phase 11 confirmed disk routing; ELKS has
  a FAT driver), but the diagnosis section should verify by
  reading the kernel source for which FAT variants/sizes are
  supported.
- **Probe disk size is a tradeoff.** 360K is enough for any
  reasonable shell script and any text-file inputs. If a future
  probe wants to ship a binary or a big data file, it'll need
  a bigger disk; the harness API can default to small and let
  the caller override via an explicit field. v0 doesn't need
  the override.
- **The harness is test infrastructure.** It runs from
  `vitest`-driven test code, not from the user-facing harness.
  No CLI exposure for v0; if a future user-facing "run a probe
  in your browser" feature emerges, it's a separate brief.

## Definition of done

**Outcome A (full success):**
- `runProbe()` exists and works as specified.
- Trivial probe ("echo hello") runs end-to-end and captures
  output.
- All prior tests still pass.
- Total tests ≥ 1,261 (~6 unit + 1 integration).

**Outcome B (filesystem-image construction blocked):**
- Diagnosis section explains what tooling is missing.
- Harness skeleton landed without the construction step.
- A skipped-with-reason test placeholder.
- All prior tests still pass.

**Outcome C (something more substantial blocks the harness):**
- Stop and report. Don't speculate-implement.
- All prior tests still pass.

In all cases:
- `npm run typecheck` clean.
- `npm test` green.
- Corpus regression clean.
- Release snapshot at `releases/phase-12-probe-harness/`
  populated and manually launch-verified.

## Release snapshot

Layout:

```
releases/phase-12-probe-harness/
├── README.md
├── package.json
├── package-lock.json
├── dist-cli/
├── dist-web/
└── reference/
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img
    │   └── fd1440-minix-serial.img
    ├── elks-images/fd1440-minix.img
    └── elks-images-hd/
        ├── hd32-fat.img
        └── hd32-minix.img
```

`node_modules/` not copied. Same fixtures as Phase 11.6.

Verify the snapshot is launchable manually:
- Both serial harnesses still boot to `# ` (no regression).
- Browser harness still loads (no regression).
- The trivial probe's integration test passes against the
  release's fixtures.

The report at `PROBE_HARNESS_REPORT.md` has these sections:

- **Summary**: outcome, what works.
- **Diagnosis (Section 1)**: filesystem choice, mount semantics,
  image-construction mechanism, sentinel choice, with
  citations.
- **API**: the exact `runProbe` signature shipped, with brief
  example.
- **Implementation**: module layout; how the boot-and-inject
  pipeline is wired; how output is parsed.
- **Trivial probe**: the "echo hello" round-trip; transcript
  excerpt.
- **Filesystem-image construction**: the chosen mechanism,
  template-vs-from-scratch, anything reusable for future
  probes.
- **What's deferred**: per Section 5 of this brief.
- **Things future briefs should address**:
  - Phase 13 (toolchain survey) is the immediate next user.
  - Streaming output mode if probes get long-running.
  - Probe scripts that read host files (extraFiles inputs)
    and write host files (output paths).
  - Multi-script / scripted-conversation probes.
  - User-facing browser probe runner if useful for demos.
- **CPU/memory bug candidates**: anything noticed during the
  trivial probe's run.
- **Release snapshot**: layout, launch commands, verification.
- **Verification**: exact commands and outputs.

## Reference sources

1. **`MULTI_DISK_REPORT.md`** — Phase 11; secondary-disk plumbing.
2. **`RAMDISK_REPORT.md`** — Phase 11.5; usage flow inspiration.
3. **`SERIAL_MINIX_REPORT.md`** — Phase 11.6; UART injection
   pattern and chunked-feed helper.
4. **`tests/integration/elks-ramdisk-serial.test.ts`** — Phase
   11.6 test, the closest template for boot-and-inject-and-
   capture flow.
5. **FAT12 specification** (Microsoft hardware whitepaper, or any
   modern reference).
6. **`reference/elks/elks/fs/msdos/`** — the kernel-side FAT
   driver for understanding what mount expects.

## Final notes

This brief produces a tool, not a result. The tool's first real
use is Phase 13's toolchain survey, but it's reusable far beyond
that — kernel-feature investigations, bug repros, comparing
behaviour across image variants, "did this kernel build break
something" regression hunts. The substrate compounds.

The discipline this brief asks for is **don't put real
investigative content in here**. The trivial probe is intentionally
trivial — `echo hello` is enough to prove the harness works.
Every actual analysis is a future brief. The temptation will be
to "just include a quick `ls /usr/bin` since the harness can do
it now," but that's Phase 13's territory and bundling weakens
both briefs.

After this lands, Phase 13 takes the harness and surveys the
ELKS image variants for usable toolchains. The user's NE2000
arc — boot ELKS, mount source disk, build the driver — depends
on what Phase 13 finds.
