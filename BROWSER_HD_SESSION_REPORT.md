# Browser HD Session Report — Phase 14 M2

**Date:** 2026-07-13
**Brief:** `emu86-phase14-brief.md` M2
**Outcome:** ✅ The stock `hd32-minix.img` now boots to a **real serial login prompt** through the browser worker path — no manual image editing. Two auto-patched `/bootopts` lines do it: `console=ttyS0,9600` (kernel console → UART) and runlevel `3` (getty actually spawns on ttyS0). Both halves of the M2 sanity gate are done: Jonathan verified the browser harness live in a real browser (first time since the Termux era), and the WorkerHost path is covered by a new integration test that logs in as root over the emulated serial line.

---

## 1. What was verified

**Real browser (Jonathan, 2026-07-13, `npm run dev:browser`):** the bundled serial floppy boots in the browser; the xterm terminal is interactive (`ls`, `df`, `ls /dev` transcripts captured). This closes the audit's open question — the browser harness works outside Node, today. Notable from his transcript: `/dev/ne0` already exists in the guest's device table (M3 omen).

**Harness side (automated, `tests/integration/browser-hd-serial.test.ts`):** boots the STOCK image bytes through `WorkerHost` — the exact code path the web page uses — and reaches, verbatim:

```
ttyS0 3f8 irq 4 16550A
...
VFS: Mounted root device /dev/hda (0300) minix filesystem.
Running /etc/rc.sys script
...
ELKS 0.9.0

[0.54 secs] login:
```

then injects `root\n` (stock image: passwordless) and asserts a `# ` shell prompt. ~15–30 s wall-clock. This is the first time the image's **real init** (rc.sys → inittab → getty → login) has ever run in emu86 — every prior boot in project history forced `init=/bin/sh`.

## 2. How it works

`src/browser/bootopts-patch.ts` (new, browser-safe — no Buffer/node imports):

- `findBootopts()` — locates the `## /bootopts` marker; treats a truncated block as absent.
- `hasSerialConsole()` — detects an ACTIVE `console=ttyS0` line (commented ones don't count).
- `patchBootoptsForSerial()` — returns a patched copy: preserves all existing lines (including the `#ne0=12,0x300,,0x80` example M3 will want), drops competing active `console=`/bare-runlevel lines, appends `console=ttyS0,9600` and `3`. Null when no marker (image boots unpatched). Throws only if the block is too full — impossible on stock images.

`WorkerHost.#resolveSlot()` applies it when — and only when — the slot is **primary**, the class is **hard-disk**, and the image lacks an active serial console. Floppies, already-serial images, and secondary (data) disks pass through byte-identical. The patch touches the boot-time in-memory copy only; the stored library image is never modified. No `web/` changes were needed: viability tags already mark `hd*-minix.img` as `likely-works` and "inform, don't gatekeep".

## 3. Findings

1. **`console=` is only half the job.** It redirects the kernel console, but getty targets come from `/etc/inittab`, whose stock `initdefault` is runlevel **1 — "single user tty1 only"**. First attempt booted perfectly and then sat silent forever: the login prompt was on the invisible CGA console. Evidence chain: `rootfs_template/etc/inittab` (initdefault 1; `s0:2346:` — ttyS0 needs runlevel 2/3/4/6); bare `/bootopts` words become init argv (`elks/init/main.c:677`); a digit argv overrides initdefault (`elkscmd/sys_utils/init.c:589`). Hence the appended `3`.
2. **`clock -s -u` fails harmlessly against our missing CMOS RTC.** rc.sys runs it; with no RTC device (ports 0x70/71 are open bus) the system date stays at the ELKS epoch — boot logs show `Fri Oct 11 1991`. It does NOT hang (initial fear); it just leaves the clock wrong. A future `src/devices/rtc.ts` fixed this would give guests real wall-clock time (the `host-clock` abstraction already exists to back it). Noted for a later phase — not M2/M3 blocking.
3. **The stock boot also probes for NE2000 at `ne0 at 300, irq 12`** (boot log) — when M3's device lands at 0x300, the stock kernel will find it with zero guest-side configuration. Note `irq 12` in the probe line vs the audit's single-PIC constraint (IRQ 8–15 unreachable) — the `/bootopts` `#ne0=12,0x300,,0x80` line will need uncommenting *and editing* to a master-PIC IRQ, or the device must present at the kernel's default probe parameters with an IRQ ≤ 7. This is a design input for M3.
4. Runlevel 3 also spawns a getty on the unseen CGA tty1 — harmless, and means the same patched image behaves sensibly under the CGA CLI harness too.

## 4. Changes

| File | Change |
|---|---|
| `src/browser/bootopts-patch.ts` | new — marker find / serial detect / preserve-and-append patcher |
| `src/browser/worker-host.ts` | auto-patch hook in `#resolveSlot` (primary + hard-disk + not-already-serial) |
| `tests/unit/bootopts-patch.test.ts` | new — 8 tests: patcher semantics + WorkerHost hook (patched HD, untouched floppy) |
| `tests/integration/browser-hd-serial.test.ts` | new — stock-image boot to login via WorkerHost, root login round-trip |
| `dist-cli/`, `dist-web/` | regenerated (`tsc -p tsconfig.cli.json`, `vite build` — new hashed bundles) |
| `emu86-phase14-brief.md` | added M2.5 (agent bridge — Jonathan's idea, see below) |

## 5. Deliberately not done

- **No RTC device** (finding 2 stays a documented gap).
- **No CGA renderer** in the browser — serial-only remains the browser's interface, which is why the auto-patch is unconditional for HD primaries rather than a UI toggle (a CGA-console HD image is unusable in the browser anyway).
- **No `init=` override** — the whole point was the real login flow.
- **M2.5 (agent bridge)** designed but not built: a dev-mode-only Vite plugin bridging `emu86:rx/tx` over the existing HMR WebSocket to plain HTTP endpoints, so an agent can drive the browser-hosted machine with `curl`. Zero new dependencies. Spec'd in the brief; next up.

## 6. Reproduction / interactive use

```
npx vitest run tests/unit/bootopts-patch.test.ts tests/integration/browser-hd-serial.test.ts
EMU86_BROWSER_HD_VERBOSE=1 npx vitest run tests/integration/browser-hd-serial.test.ts
```

Interactive (the M2 user-facing acceptance): with `npm run dev:browser` running, open the settings modal → image library → **upload `reference/elks-images-hd/hd32-minix.img`** → select as boot source → reload/boot. Expect the ELKS banner and `login:` in the xterm; log in as `root` (no password); `c86 -v` at the prompt proves the toolchain interactively. (If the dev server was already open, refresh the page first so the updated worker loads.)

## 7. Test state

999 → **1,008 tests** expected (8 unit + 1 integration added); full-suite run recorded in the phase commit. Typecheck clean across base/test configs; cli/web configs exercised by the dist rebuilds.
