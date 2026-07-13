# NE2000 + Switch Report — Phase 14 M3a

**Date:** 2026-07-13
**Brief:** `emu86-phase14-brief.md` M3 addendum (per `emu86-networking-plan.md`'s Phase-14 shape: "NE2000 device + Switch substrate. Card exists, frames flow, no pseudo-hosts attached.")
**Outcome:** ✅ **emu86 is on a network.** The unmodified stock ELKS kernel detects the emulated NE2000 at boot, transmits real ethernet frames out of the guest through its own unmodified driver, and receives host-injected frames byte-exactly — woken through PIC IRQ 5, verified by an in-guest md5. The browser worker now instantiates a per-boot ethernet switch with the NIC as its first port, ready for the plan's pseudo-hosts. The integration test passed on its first run.

---

## 1. Acceptance evidence

`npx vitest run tests/integration/elks-ne2k.test.ts` — one boot of the stock `hd32-minix.img` (bootopts: `console=ttyS0,9600`, `ne0=5,0x300,,0x80`, `init=/bin/sh`), three proofs:

1. **Detection.** Boot log contains `eth: ne0 at 300, irq 5` and `MAC 02:65:6d:75:38:36` — the ELKS probe (write 0x21 to the command register, read it back; then a 32-byte PROM read over remote DMA) passes, and the driver's 8-vs-16-bit heuristic classifies us as a 16-bit card.
2. **Transmit.** `echo NE2K-TX-FRAME > /dev/ne0` exercises the driver's full open path (`request_irq(5)` → reset-port pulse → HLT-spin on ISR.RST → init → start) and then the transmit path (remote-DMA write into NIC RAM, TBCR, CR=0x06). The frame arrives at the host `nicTransmit` sink: 64 bytes (the driver's minimum-pad), starting `NE2K-TX-FRAME\n`.
3. **Receive.** With the guest blocked in `dd if=/dev/ne0 bs=64 count=1 | md5sum`, the host injects a 100-byte unicast frame addressed to the device MAC. ISR.PRX → IMR gate → PIC IRQ 5 wakes the read; the md5 the guest prints equals the host's md5 of the frame's first 64 bytes. Byte-exact, interrupt-driven, through the receive ring.

Suite total after M3a: **1,028 expected** (17 device/switch unit tests + 1 integration test on top of 1,010); the full-suite run is recorded in the phase commit.

## 2. What was built

| Piece | File | Shape |
|---|---|---|
| NE2000 device | `src/devices/ne2000.ts` | 8390-class NIC, same pattern as PIC/PIT/UART: port I/O at 0x300–0x31F, `onTransmit(frame)` out, `injectFrame(frame)` in, edge `onIRQ` |
| Ethernet switch | `src/net/switch.ts` | Learning frame router: CAM by source MAC, unicast to learned port, broadcast/multicast/unknown flood, no echo-to-sender, runt guard |
| Machine wiring | `src/machine/ibm-pc.ts` | `nic` always present (like the other board devices), IRQ 5 → master PIC; config `nicTransmit` / `nicMac` |
| Browser LAN | `src/browser/worker-host.ts` | Per-boot `EthernetSwitch`, NIC attached as port `ne2000`, exposed as `WorkerHost.network` for future pseudo-hosts |
| Tests | `tests/unit/ne2000.test.ts` (12), `tests/unit/net-switch.test.ts` (5), `tests/integration/elks-ne2k.test.ts` (1) | |

## 3. Design decisions and their evidence

1. **Evidence-based register model.** Every emulated behaviour maps to something `ne2k.c`/`ne2k-asm.S` actually does: the 0x21-readback probe (`ne2k.c:394-401`), TXP-reads-0 (the `tx_rdy_wait` poll), RDC spin-waits after both DMA directions, ISR.RST latching on both the reset-port pulse and STOP (`ne2k_reset`, `ne2k_clr_oflow` both spin on it), write-1-to-clear ISR, page-1 CURR/PAR access, and the BOUNDARY-trails-by-one ring convention documented in the asm header.
2. **QEMU-compatible receive header** (`[status, next, total_lo, total_hi]`, total = padded-length + 4): the ELKS driver is developed against QEMU (`NETIF_IS_QEMU` handling), so QEMU's conventions are the de-facto contract.
3. **16-bit card presentation**: PROM words carry the content byte in the low half and 0x00 high, which routes the driver's heuristic (`ne2k.c:475-489`) down the 16-bit path — word-mode DMA, 16 KB buffer, `(ne2k)` model name.
4. **IRQ 5, not 9 or 12.** The plan suggested "IRQ 9 typically"; the kernel default is 12; both live on the slave PIC emu86 doesn't have. IRQ 5 is the classic NE2000 alternate, master-PIC-reachable, and selected guest-side purely via bootopts — no kernel or driver modification.
5. **MAC 02:65:6d:75:38:36** — locally-administered bit set, "emu86" in the tail.
6. **NIC always present** (like PIT/UART/8042) rather than config-gated: a kernel that doesn't probe never notices, and every ELKS HD boot transcript now shows an honest detection line instead of `not found`. No existing test asserted the absence (checked before wiring).
7. **Switch is synchronous and dumb on purpose** — MAC learning, flood, no aging, no async. Pseudo-hosts that need `fetch()` queue internally and transmit later; the router stays a pure function of frames.

## 4. Findings

1. **Ring-full edge case caught by unit test:** first implementation let CURR land exactly on BNRY after a write — a state the driver reads as *empty ring* (silent data loss). The real 8390 refuses the packet that would cause it. Fixed: such a packet raises ISR.OVW and is dropped; with the stock ring layout exactly 56 one-page packets fit before overflow, pinned by test.
2. **The stock kernel opens/closes the device per file operation** — `echo > /dev/ne0` runs the whole reset/init/start sequence and then stops the chip on close. Each `dd` reopens with a fresh ring. Harmless, but scripts doing TX-then-RX must expect re-initialization between commands (the integration test does).
3. **The driver reads kernel memory beyond the written bytes when padding**: `echo`'s 14 bytes become a 64-byte frame whose tail is whatever followed in the guest buffer. Real hardware does the same. Assert on prefixes, not whole frames.
4. `netstat`-visible RX flow control worked as documented: the OVW path (`ne2k_clr_oflow`) was not exercised by the integration test — deliberately left to a future stress pass; the device side of it is unit-tested.

## 5. Deliberately not done (per the brief's M3a depth ceiling)

- **No pseudo-hosts** — M3b starts with ARP/ICMP (`ping 10.0.0.1` from the guest is the next acceptance).
- **No bootopts `ne0=` line in the browser auto-patch** — browser guests still see the kernel-default `irq 12` probe fail to *open* (detection succeeds). Wiring `ne0=5,0x300,,0x80` into `patchBootoptsForSerial` belongs with M3b, when there's something on the LAN to talk to.
- **No `net start` / ktcp exercise** — raw-frame layer only; IP configuration enters with the pseudo-hosts.
- **No multicast hash filtering** (MAR registers stored, not evaluated) and no promiscuous-mode nuances — the ELKS driver uses RCR=0x04 (broadcast + unicast) only.
- **No RTC** (still October 1991 in there; separate substrate item, audit §3.3).

## 6. Reproduction

```
npx vitest run tests/unit/ne2000.test.ts tests/unit/net-switch.test.ts   # ~2 s
npx vitest run tests/integration/elks-ne2k.test.ts                       # ~40 s
```

No prerequisites beyond the checkout (image committed, no network).

## 7. Next (M3b)

ARP + ICMP pseudo-hosts on the switch (plan Phase 15): give the LAN a gateway identity (e.g. 10.0.2.2), answer ARP-who-has and ICMP echo, add the `ne0=5` line to the browser bootopts patch, and the acceptance becomes typing `ping 10.0.2.2` into the browser xterm — or through the agent bridge — and watching replies come back. After that, DNS-over-DoH (plan Phase 16).
