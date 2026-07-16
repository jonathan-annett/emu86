# XMS for the browser PC — brief (draft for Jonathan's review)

Drafted 2026-07-16, Phase 18 M4 field loop, from Jonathan's meminfo
report ("i'm curious why we are running out of memory anyhow") and his
direction: "we should try to support XMS."

## 1. The diagnosis (from his boot log + meminfo, verified in source)

- `xms: 34816K, disabled, A20 error` — **34816 = 0x8800**. ELKS sizes
  extended memory via INT 15h AH=88h; our BIOS leaves the function
  unimplemented (the trap table's default is a bare IRET), so AX
  returns UNCHANGED — 0x8800 — and the kernel believes in 34 MB of
  phantom extended memory.
- The A20 test then fails (a 1 MiB-masked PagedMemory wraps at 1 MB —
  correct for a real 8086), XMS is disabled, and the already-sized
  **64 K of ext buffers falls back into MAIN RAM** — the `BUF 65536`
  heap entry in his meminfo. A phantom XMS costs 64 K of real memory
  every boot.
- `hma=kernel` (already in the image's bootopts) also loses to the
  A20 error — the kernel could be holding ~64 K of itself in the HMA
  and is not.
- The rest of the 640K story is honest tenants: ktcp ≈ 77 K,
  ftpd ≈ 29 K, telnetd ≈ 13 K, sh ≈ 65 K, and fragmentation (216 K
  free but the largest hole only ≈ 130 K).

## 2. Why real XMS is cheap HERE

ELKS ships an XMS mode built for exactly this substrate: `XMS_INT15`
(xms.c) — buffers live above 1 MB and every access goes through the
BIOS block-move (`bios_block_movew`, the INT 15h copy service). No
unreal mode, no 386. And xms.c:76: **INT15 is the default path for
`arch_cpu < CPU_80286`** — our machine already tries it every boot;
it fails only on the two lies above. We own the BIOS as JS traps and
`PagedMemory` takes `addressSpaceSize` as a constructor option (its
own docstring cites 16 MiB for the 286 roadmap). Hard rule 1
untouched: the CPU's segment arithmetic reaches at most 0x10FFEF
(the HMA); everything beyond is touched ONLY by the BIOS trap in JS.

## 3. Milestones

### M1 — honest sizing + the block move
- INT 15h AH=88h: return real extended KB — (memorySize − 1 MiB)/1024,
  0 when the machine is 1 MiB (which also kills the phantom-64K bug
  for anyone who keeps a 1 MiB machine).
- The block-move service `bios_block_movew` calls (read its .inc at
  implementation time for the exact AH and descriptor layout — the
  classic is AH=87h with a GDT-shaped table at ES:SI, 24-bit
  addresses): implement as a JS loop over memory.readByte/writeByte,
  plus the CLEAR variant xms.c uses for fmemset.
- A20: with a >1 MiB address mask there is no 1 MB wrap and ELKS's
  test passes. A20 becomes always-on; the 8042 flag stays decorative
  (documented — PS2_A20_REPORT's "the mask consumes it later" is
  superseded by always-on until real gating is ever needed).

### M2 — the bigger machine
- Browser machines get memorySize 4 MiB (BootConfig.memorySize,
  default preserved at 1 MiB for tests/CLI). Lazy page
  materialisation means unused ext memory costs nothing; M1 state
  capture already scales by resident pages.
- Expected wins, in his meminfo's terms: BUF 65536 leaves main RAM
  (+64 K), hma=kernel finally works (+~64 K of kernel out of
  conventional), ext buffer count can GROW (xmsbuf=) for fs speed,
  and `ssd` (the XMS ramdisk) becomes possible.

### M3 — acceptance
- Boot log reads `xms: 3072K enabled` (INT15), no A20 error, HMA in
  use; meminfo shows no BUF in main heap.
- **hello.sh compiles WITH ktcp + telnetd + ftpd running** — the 640K
  constraint that shaped Phase 17 M3's net-suppression, retested.
  If it holds, the show/net suppression can relax (separate call).
- Equivalence harness green on a 4 MiB machine (the M1 pairs are
  size-agnostic; prove it).

## 4. Open questions for Jonathan
- Q1: ext memory size — 3 MiB (4 MiB machine) feels right for ELKS's
  16-bit sizing fields; bigger wants checking against kernel limits.
- Q2: ship the AH=88h honest-zero fix immediately as a field fix
  (kills the phantom 64K on the CURRENT 1 MiB machine), or land it
  with the full brief?
- Q3: sequencing vs the un-scripted brief and the Phase 18 close.
