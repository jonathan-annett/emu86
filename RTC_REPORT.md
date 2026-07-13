# RTC Report — MC146818 CMOS clock at 0x70/0x71

**Date:** 2026-07-15
**Brief:** `emu86-phase14-brief.md` — RTC addendum (networking plan's "NTP / RTC" note, resolved the substrate-honest way)
**Outcome:** ✅ The guest knows what time it is. Field impetus (Jonathan): `date` reading `Mon Oct 21 09:51:02 1991` — the kernel's no-RTC default. The stock image already runs **`clock -s -u` from `/etc/rc.sys` at every boot**, so an MC146818-shaped chip at ports 0x70/0x71 serving host wall time makes the date correct in the browser with **zero guest changes and zero typing**. The NTP-pseudo-host alternative from the networking plan was already dead: ELKS has no UDP (M3c finding).

## What was built

| Piece | File | Shape |
|---|---|---|
| RTC device | `src/devices/rtc.ts` | `RTC146818`: index/data ports (index honours the bit-7 NMI mask), BCD time registers served live from the machine's `HostClock`, status A/B/C/D with the probe-satisfying values (0x26 / 0x02 / 0x00 / 0x80), 128-byte scratch CMOS for everything else |
| Wiring | `src/machine/ibm-pc.ts` | Registered at 0x70–0x71 whenever a hostClock exists (BIOS on); exposed as `machine.rtc`; reset preserves scratch (battery-backed RAM — power-on reset is not a battery pull) |
| Tests | `tests/unit/rtc.test.ts` (6), `tests/integration/elks-rtc.test.ts` (1) | The clock.c read contract byte-for-byte; live time flow; probe registers; write-ignore; scratch round-trip. Integration: stock image boots, runs its own `clock -s -u; date` → `Thu Jan  1 00:00:0x 2026` (the deterministic InMemoryHostClock), and no `1991` anywhere |

## Design notes — counterparty-first, as usual

The contract is `elkscmd/sys_utils/clock.c`, not the MC146818 datasheet, and they differ in one documented place: **the weekday register holds `tm_wday + 3`** (clock.c: "DOS uses 3 - 9 for week days"), not the datasheet's 1–7. Other contract facts honoured: month is 1-based, year is two BCD digits (guest maps <70 to 20xx), reads are `outb(reg|0x80, 0x70); inb(0x71)`, and clock.c's seconds-stability loop covers a minute rolling over between register reads (each read snapshots the host clock, so no UIP emulation is needed — status A's UIP bit stays clear).

`AST_SUPPORT=0` means the stock binary compiles its CMOS probe out and reads unconditionally — but the probe registers are implemented anyway (status A = 0x26, status D = 0x80) so a differently-built clock, or future software, finds a live chip.

**Time source and timezone:** the chip serves the host clock verbatim — in the browser that's `NodeHostClock`, i.e. the browser's **local** wall time. rc.sys passes `-u` ("CMOS holds UTC"), so the guest adopts it without offset, and `date` (guest has no TZ configured) prints exactly what the user's own clock says. Deliberately convenient rather than pedantic; recorded here so nobody later "fixes" it into showing UTC-shifted time.

**Writes are not applied** — `clock -w` performs its status-register save/restore dance harmlessly, but time registers always serve host time (a guest cannot set the host's clock; an offset-tracking write path is possible if ever wanted). Scratch CMOS bytes do round-trip, so software that parks data in CMOS RAM works.

## Interaction with pacing

The two milestones compose: pacing keeps guest time *flowing* at wall rate; the RTC sets the *absolute* date/time at boot. In tests, `InMemoryHostClock` keeps both deterministic. (INT 1Ah already served host time to the BIOS path — ELKS simply never used it for its date; `clock` reads the CMOS ports directly.)

## Field acceptance

✅ **Field-verified** (Jonathan, dev tier, build 599c4ff): boot transcript shows `Running /etc/rc.sys script` followed immediately by `Tue Jul 14 02:32:48 2026` — the host's local wall clock to the second, printed by the stock image's own startup, zero typing. The 1991 era is over.

## Test state

1,112 → **1,119** (6 unit + 1 integration). Typecheck clean; dist-web/dist-cli regenerated.
