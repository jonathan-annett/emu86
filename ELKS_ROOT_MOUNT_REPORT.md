# ELKS Root Mount Report (Phase 6)

## Summary

**Path 1 success.** A simple instruction-cap bump was sufficient — no new
device stubs, no BIOS extensions, no kernel-state plumbing required.
With Phase 5's PIC-vector-base fix in place, ELKS now:

- Finishes `early_kernel_init` and `kernel_init`.
- Switches its console driver to `console-direct` (CGA framebuffer at
  `0xB8000`).
- Probes ethernet / floppy / ATA-XTIDE devices (none found, as expected).
- Mounts `/dev/fd0` as the Minix root filesystem.
- Runs `/etc/rc.sys`.
- Lands at the `login:` prompt.

The kernel banner string `"VFS: Mounted root device /dev/fd0 (0320) minix
filesystem."` first appears in video memory between **1.5M and 2M**
instructions; the `login:` prompt by ~7M. After that, the kernel idles
in `idle_halt()` waiting for keyboard input that never arrives, so all
subsequent instructions are pure idle (HLT/IRET/HLT…).

The integration test asserts at 4M instructions — comfortably inside the
mount window with slack for performance drift.

The "first surprise" of the run was that the InMemoryConsole stayed
quiet after `"INT f002 START"` even though the kernel was clearly making
progress (140+ INT 13h sector reads, 100+ IRQs, syscalls into
user-space). Reading the CGA framebuffer at `0xB8000` revealed the full
banner: ELKS's `console_init()` swaps `kputc` from the early-boot
`INT 10h AH=0Eh` path to the direct-video-memory path. The
InMemoryConsole only sees `early_putchar` output, so the apparent
silence was an instrumentation gap, not a kernel hang.

## Run results

```
$ time node dist-cli/tests/integration/long-probe.js fd1440-minix.img 25000000
# RunResult: {"executed":25000000,"reason":"instruction-limit"}
# Wall clock: 10812 ms (2,312,246 ips)
# Counts: {"instruction":0,"int":0,"trap":4545,"io":22727,"memWrite":0,"intService":22728}

real    0m11.111s
user    0m12.325s
sys     0m0.175s
```

- **22,728 IRQs serviced** in 25M instructions — ~1100 instructions/IRQ
  in the steady-state idle loop (the kernel is HLT-waking-HLT cycle now;
  early instructions per IRQ were ~47k, matching Phase 5's number).
- **4,545 trap fires** total (BIOS service entries) — INT 13h disk reads
  dominate the early window; INT 10h cursor/setcursor calls round out
  the rest.
- **`halted=false` IF=1**, sitting in the kernel's `idle_halt()` waker
  loop. Final CS:IP `0330:8119` is in fartext — same idle pattern Phase
  5 ended on.

### Final CGA video memory

```
| Direct console, scan kbd 80x25 emulating ANSI (2 virtual consoles)
| xms: 34816K, disabled, A20 error. 64K ext buffers, 8K cache, 15 req hdrs
| eth: ne0 at 300, irq 12 not found
| eth: wd0 at 0x240, irq 2, ram 0xce00 not found
| eth: 3c0 at 330, irq 11 not found
| df: CMOS df0 is unknown (15)df0 is 360k/PC (1), df1 is unknown (15)
| ssd: no XMS
| hda: 1440K CHS  80, 2,18
| fd0: 1440K CHS  80, 2,18
| cf:  ATA at 300/31c xtide=3,1 probe fail (ff)
| cfa: ATA at 300/31c xtide=3,0 not found (-6)
| cfb: ATA at 300/31c xtide=3,0 not found (-6)
| hda:(0,2880) no mbr, no partitions
| boot: BIOS drive 0, root device /dev/fd0 (0320)
| PC/XT class cpu 2, syscaps 0, 640K base ram, 16 tasks, 64 files, 96 inodes
| ELKS 0.9.0 (61344 text, 31872 ftext, 10240 data, 8128 bss, 47166 heap)
| Kernel text 330 ftext 122a init 17a4 data 19f2 end 29f2 top a000 472+9+0K free
| fd0: ELKS bootable, has 80 cylinders, 2 heads, and 18 sectors
| VFS: Mounted root device /dev/fd0 (0320) minix filesystem.
| Running /etc/rc.sys script
| Fri Oct 11 09:47:13 1991
|
| ELKS 0.9.0
|
| [1.29 secs] login:
```

The "ELKS 0.9.0", date, and `login:` come from `/etc/rc.sys` and
`/sbin/init` running in user-space — observable in the trace as INT 80h
syscalls from CS=`3d56` (user) into the kernel.

### InMemoryConsole capture

187 bytes from `early_putchar` (BIOS INT 10h AH=0Eh):

```
ELKS....../linux..........................[boot menu fill]....
ELKS Setup .........FHt0330 f122A d19F2 INT f002 START
```

After this point the kernel never calls `INT 10h AH=0Eh` again — all
output goes to the framebuffer.

## Diagnostic infrastructure added

### `tests/integration/long-probe.ts` (new probe, ~115 lines)

A high-cap, low-overhead probe for whole-boot inspection. Differences
from `diag-probe.ts`:

- **No instruction tracing.** The expensive snapshot path is disabled
  via `kinds: ['intService','int','trap','io','memWrite']`. Halves the
  per-step cost; ~2.3M instructions/second sustained on this device.
- **Small ring (50k events)** — enough for tail context, no pressure
  to fit a multi-million-event trace in RAM.
- **CGA framebuffer dump.** 25 lines × 80 columns of `0xB8000` text are
  printed at end-of-run; this is what surfaced the post-`console_init`
  output that the InMemoryConsole alone would never have shown.
- **Per-port IO totals + INT/trap tail.** Fast triage for "which
  device is being polled most".

How to run:

```
$ npx tsc -p tsconfig.cli.json
$ node dist-cli/tests/integration/long-probe.js fd1440-minix.img 25000000
```

The probe is wired into `tsconfig.cli.json`'s include list so `npx tsc
-p tsconfig.cli.json` builds it alongside the existing probes.

The brief's path-2 diagnostics (periodic console dumps, stuck-loop
detector) were **not** built — path 1 hit on the very first cap bump,
so investing in those would have been speculative.

### `tests/integration/elks-root-mount.test.ts` (new test)

Asserts on three things in a single 4M-instruction run:

1. The InMemoryConsole captured `"INT f002 START"` (Phase 5's
   regression-baseline string).
2. `intService` events fire (Phase 5's PIC-vector-base fix is still
   working; if a regression masked IRQs, this would drop to 0–1).
3. The CGA framebuffer contains both `"Mounted root device"` and
   `"/dev/fd0"`.

Asserting on the framebuffer keeps the test stable across kernel build
variations: the exact early-printk byte-stream changes if anyone tweaks
`crt0.S`, but the post-init banner format from `fs/super.c` is
ELKS-version-stable.

Test runs in ~3.5s on the device.

## New stuck point

None. The run was healthy throughout: IRQs served at the expected
cadence, BIOS INT 13h sector reads serviced cleanly, no error returns
from the disk, no halt-spin-exhaustion, no panics, no infinite loops
that aren't `idle_halt()`.

## Implementation

No production code changed. The only files touched are diagnostic /
test:

- `tests/integration/long-probe.ts` — new fast-path probe (above).
- `tests/integration/elks-root-mount.test.ts` — new integration test
  (above).
- `tsconfig.cli.json` — added `long-probe.ts` to the CLI include list
  so the build picks it up.

`src/cpu8086/`, `src/memory/`, `src/runtime/`, `src/interrupts/`,
`src/io/`, `src/timing/`, all device files, and the BIOS ROM/services
are untouched.

## Things future briefs should address

Ordered by how independent each is — earlier items don't depend on
later ones.

1. **Real keyboard input plumbing.** `login:` is sitting at the kernel
   waiting on a keypress that no one will type. To get an interactive
   shell, IRQ 1 needs to deliver real bytes through the 8042 controller
   to the kernel's keyboard driver. The `KeyboardController8042` device
   is in place; what's missing is a Console-side input path that lands
   bytes on port 0x60 with the IRQ wired. This is the natural next
   brief and was already pre-flagged by Phase 4 / Phase 5.
2. **Console-direct → InMemoryConsole bridge (optional).** Reading the
   framebuffer in tests works, but for live-streaming probes, mirroring
   `0xB8000` writes to the InMemoryConsole would let `node
   long-probe.js` show the kernel's banner unfolding line-by-line.
   Implementation: a memory-write hook in the diagnostics layer that
   filters on the framebuffer range and forwards printable bytes to
   stdout. Doesn't touch any locked layer. ~30 lines of code.
3. **ATA-XTIDE / NIC device probes.** ELKS prints "not found" for all
   of NE2K (port 0x300), WD80x3 (0x240), 3C503 (0x330), and the
   XTIDE/CF probes. Our open-bus `0xFF` returns are the right answer
   for "no device" — the kernel handles each probe failure gracefully.
   No action needed, but if someone adds NIC support later, port 0x110
   showed up as a probed-but-unrecognised port (likely the WD8003
   I/O alias) — worth checking the OSDev WD8003 port map first.
4. **`xms: A20 error` line.** ELKS detected our A20-enabled state but
   reported an error during XMS init. With XMS disabled the kernel
   continues fine; no functional impact. Almost certainly a quirk of
   ELKS's XMS init expecting different timing or an extra device
   responder; not worth chasing unless a future workload depends on
   XMS.
5. **`hda:(0,2880) no mbr, no partitions`.** The kernel is treating
   the floppy as an `hda` device too, and finding no partition table.
   Expected behaviour for a raw floppy image; `/dev/fd0` is the actual
   root. If we add a HDD image later the kernel will probe `hda`
   meaningfully.
6. **`Fri Oct 11 09:47:13 1991`** is the RTC value — the kernel is
   reading the CMOS RTC (port 0x70/0x71). Our RTC reads return zero
   bytes, and the kernel's hand-off to userspace makes 1991 out of
   them. Cosmetic; only matters if a workload needs real time.

## CPU/memory bug candidates

None observed. The corpus regression remains at 323/323 green. A 25M-
instruction run that includes:

- Many minutes of guest CPU time
- Multi-MB of trace events processed
- Heavy mixed-mode arithmetic (the kernel + libc + rc.sh + init are all
  doing real work)
- Self-modifying installation of CALLF thunks in the IDT
- Deep stack manipulation (intr-stack swap, idle-task stack swap)

…still produces a kernel that prints a recognisable banner and reaches
`login:`. Any subtle CPU bug at the level the corpus would miss would
manifest as garbled banner text or a kernel oops; we see neither.

(One tiny note worth flagging-but-not-fixing: the per-IRQ instruction
count drops from ~47k early to ~1100 in the long idle. This is the
kernel correctly stalling in `HLT` with our `haltSpinCycles` advancing
the clock fast — not a bug. It does mean if a future brief uses
`intService` count as a "is the kernel doing work?" proxy, the metric
needs a CS:IP-distribution check too.)

## Verification

```
$ npm run typecheck
> emu86@0.0.1 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.test.json
# clean

$ npm test
 Test Files  45 passed (45)
      Tests  1029 passed (1029)
   Duration  220.36s
# 1028 prior tests + 1 new (elks-root-mount) — all green.
# Corpus: 323/323 SST cases pass.

$ npx tsc -p tsconfig.cli.json
# clean

$ node dist-cli/tests/integration/long-probe.js fd1440-minix.img 25000000 \
    > long-out-25m.txt 2>&1
# 25M-instruction run completes in ~11s; framebuffer shows full banner +
# rc.sys + login: prompt.
```

`tests/integration/elks-boot-phase4.test.ts` (Phase 4's regression test)
still passes unchanged; the new probe and test only add behaviour, they
don't modify any existing assertion.

## Files changed

- `tests/integration/long-probe.ts` *(new)* — fast-path probe with
  framebuffer dump (~115 lines).
- `tests/integration/elks-root-mount.test.ts` *(new)* — Phase 6
  integration test asserting on the VFS mount banner (~95 lines).
- `tsconfig.cli.json` — added `long-probe.ts` to CLI build includes
  (one-line edit).

No changes under `src/cpu8086/`, `src/memory/`, `src/runtime/`,
`src/interrupts/`, `src/io/`, `src/timing/`, `src/devices/`,
`src/bios/`, `src/console/`, `src/disk/`, or `src/diagnostics/`.
