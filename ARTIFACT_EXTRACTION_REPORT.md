# Artifact Extraction Report — Phase 14 M1

**Date:** 2026-07-13
**Brief:** `emu86-phase14-brief.md` M1 (drafted and executed in-session — planning moved into the working session as of today)
**Outcome:** ✅ **Byte-exact guest→host extraction works** — the in-VM-compiled `hello` binary was exported from the guest onto the probe floppy, snapshotted by the harness, and read back on the host with an md5 identical to the one the guest printed. **En route, M1 exposed and fixed a real emulator bug**: INT 13h accepted out-of-range CHS addresses, which made ELKS misprobe floppy geometry and silently corrupt every write beyond track 0. The fix is the first `src/` change of Phase 14, Jonathan-approved in-session (brief §Hard-rules amendment).

---

## 1. What works now, verbatim

`EMU86_HELLO_WORLD_VERBOSE=1 npx vitest run tests/integration/hd32-hello-world.test.ts`:

```
--- extracted artifacts ---
  hello.bin: 3156 bytes, md5 00b2a861044e22b79d93a76791e50aec
    header: 01 03 20 04 20 00 01 00 d0 08 00 00 64 01 00 00
  hello.o: 116 bytes, md5 e7d751b3faa979770d712ceeb10a9635
    header: a3 86 01 00 2a 3b 00 00 00 2e 00 00 00 14 00 00

--- section @@md5@@ ---           (guest, /tmp/hello)
00b2a861044e22b79d93a76791e50aec  /tmp/hello

 Test Files  1 passed (1)   Tests  1 passed (1)   Duration 63.98s
```

- Guest md5 of `/tmp/hello` == guest md5 of `/mnt/hello.bin` (read back through ELKS's FAT driver) == **host md5 of the bytes extracted from the probe-disk snapshot**. Three-way receipt, asserted by the test.
- `hello.bin`'s header is a genuine ELKS a.out: `01 03` (Minix a.out magic, little-endian), flags `0x20` (separate I&D), CPU `0x04` (i8086). The first executable ever exported from the VM.
- `EMU86_HELLO_WORLD_SAVE=<dir>` writes the extracted artifacts (and the raw probe-disk snapshot) to host disk — this is how a compiled NE2000 object will be harvested in M3.

## 2. The extraction mechanism

1. `ProbeResult.probeDiskFinal` (new): after the run, the harness snapshots the probe floppy via its public `readSector` API (2,880 × 512 B; `InMemoryDisk`'s backing store is deliberately private).
2. The guest build script exports artifacts with `cp` onto the mounted floppy (8.3 names), prints `md5sum /tmp/hello` as the fidelity receipt, then — critically — **execs a tail script from `/tmp` that unmounts `/mnt`** (see §4).
3. Host side, `readProbeDiskFile()` (Phase 12's FAT12 reader, unchanged — it already walks FAT cluster chains) pulls the files out of the snapshot.

## 3. The bug M1 flushed out: INT 13h missing CHS validation

**Symptom:** first extraction attempt returned `hello.bin` as 3,156 bytes of pure zeros (md5 of the extracted bytes equalled md5 of 3,156 zero bytes — verified) while the guest's own md5 of `/mnt/hello.bin` was correct. Directory entry and FAT chain had reached the emulated disk; the data clusters had not — yet the payload string was findable in the raw snapshot at *wrong* offsets (byte 12,020 ≈ sector 23, inside the root-directory region).

**Root cause chain (each link verified):**

1. ELKS probes floppy geometry by reading increasing sector numbers on track 0 and keeping the largest that succeeds — `sector_probe[] = {8, 9, 15, 18, 36}` in `reference/elks/elks/arch/i86/drivers/block/bioshd.c:149`.
2. Our `chsToLba()` (`src/bios/bios-services.ts:326`) converted CHS→LBA arithmetically with **no range check**: C0/H0/S36 on an 18-spt floppy computes LBA 35 — valid — so the probe read *succeeded*. Boot log: `fd0: probed, probably has 80 cylinders, 2 heads, and 36 sectors`.
3. Under ELKS's wrong 36-spt geometry, linear sectors 0–35 map to identical LBAs by algebraic accident, so **reads of small probe files always worked** — which is why 14 phases of read-only probe traffic never noticed. Any access beyond linear sector 35 lands 18 sectors off; the first-ever guest *write* (our exported data clusters, allocated from cluster 5 upward) sprayed into the FAT2/root-dir region.

**Fix (`src/bios/bios-services.ts`, Jonathan-approved amendment to the M1 substrate lock):** new `chsInRange()` guard in the INT 13h read/write/verify path — sector ∉ [1, sectorsPerTrack] or head ≥ heads or cylinder ≥ cylinders → CF=1, AH=04 (sector not found), AL=0, exactly like real hardware. No `warn()` on this path: probe misses are normal guest traffic. With the fix, ELKS probes and settles at 18 spt and all writes land correctly (§1). `dist-cli` regenerated to match.

**Why this matters beyond M1:** this was a live landmine under every future guest write to any probed drive, and a fidelity divergence from real BIOS behavior that ELKS actively depends on. It also retroactively explains the doubled `fd0: probed` line visible in probe-era transcripts.

## 4. Second finding: `sync` does not flush FAT data clusters

An intermediate iteration (before the misprobe was understood) established independently: after `cp` + `sync` + `sync`, the directory entry and FAT chain arrive on the emulated disk but file **data** stays in the ELKS buffer cache. `umount` is the reliable full flush. Since the driver script executes *from* the mounted floppy, the export tail is a separate script (`unmnt.sh`, shipped on the floppy) that the guest copies to `/tmp` and `exec`s: it can then `umount /mnt` safely (the `exec` replaced the shell whose script fd pointed into `/mnt`; cwd moved off the mount first). Rule for all future extractions: **export, exec off the mount, umount, then finish.**

(Caveat: the zeros-symptom that *prompted* the sync investigation was later fully explained by the CHS bug, so "sync alone is insufficient" rests on the intermediate run's evidence — dir/FAT present, data absent, correct guest-side md5 — not on a post-fix A/B test. The umount pattern is kept because it is cheap and strictly safer; a post-fix sync-only variant was deliberately not re-tested. If someone wants to know, it's a 5-line script edit and one 60-second run.)

## 5. Changes

| File | Change |
|---|---|
| `src/bios/bios-services.ts` | `chsInRange()` + guard in INT 13h AH=02/03/04 (the approved substrate fix) |
| `dist-cli/src/bios/bios-services.js` | regenerated snapshot |
| `tests/probe/probe-harness.ts` | `ProbeResult.probeDiskFinal` snapshot (taken on both success and boot-timeout paths); re-export `readProbeDiskFile` |
| `tests/probe/surveys/hd32-hello-world.ts` | export stages in `go.sh` (`md5` receipt, `cp`, floppy-side `md5fd`, `unmnt.sh` tail), artifact extraction + `guestMd5` parsing, stage classifier grew to 10 stages |
| `tests/probe/surveys/survey-runner.ts` | `nullProbeResult()` gained the new field (compat only) |
| `tests/integration/hd32-hello-world.test.ts` | extraction + three-way-md5 assertions; `EMU86_HELLO_WORLD_SAVE` artifact dump |
| `emu86-phase14-brief.md` | new (the Phase 14 arc brief), incl. the hard-rules amendment |

## 6. Verification

- Integration test green with all 10 stage rc=0, `helloRan`, both artifacts extracted, md5s equal (§1).
- `npm run build` (src typecheck) and `tsc --noEmit -p tsconfig.test.json` clean.
- Full suite after the BIOS change: recorded in the commit message of this phase (run was in flight at report-writing time; the commit only lands if it's green — 999 expected).

## 7. Deliberately not done

- No format/AH=05 or AH=15 CHS validation — only the read/write/verify path that takes CHS addresses was guarded. AH=15's known DL-routing inconsistency (audit §3.2.3) remains untouched.
- No sync-only A/B retest post-BIOS-fix (§4 caveat).
- No subdirectory or long-filename support in extraction — root-directory 8.3 files only, per the brief's depth ceiling.
- The `runUntilSentinel` echo bug remains worked-around, not fixed (three-phase precedent; brief keeps it out of scope).

## 8. Next

M2 (browser interactive HD session) is unblocked and independent. M3 (NE2000) now has its full toolchain path: compile in-VM (step 1) → export to floppy → harvest on host (M1), pending `emu86-networking-plan.md` for the device shape.
