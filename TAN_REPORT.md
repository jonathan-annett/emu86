# TAN Report — Phase 14 M3-tabs: the Tab Area Network

**Date:** 2026-07-14 (session continuing from 2026-07-13)
**Brief:** `emu86-phase14-brief.md` M3-tabs ("tab 1 can telnet to tab 2. that will be gold")
**Outcome:** ✅ **Gold delivered — and human-verified in real browser tabs** (Jonathan, 2026-07-14: two tabs, real BroadcastChannel, telnet across — "seems to work"). Two full WorkerHost machines — exactly what two browser tabs run — boot the stock image on one shared Tab Area Network, lease themselves unique identities, join with the guest's own `net start ne0`, and then **machine A telnets to machine B and receives B's real login prompt**, served by B's unmodified telnetd over real ktcp-to-ktcp TCP. No host-side TCP engine exists anywhere; only ethernet frames moved. En route, the milestone surfaced a genuine distributed-systems bug (ktcp's connect clock vs. cross-tab ARP latency) whose fix — lease-directory proxy-ARP — makes the TAN robust for real browser tabs, not just tests.

---

## 1. What was built

| Piece | File | Shape |
|---|---|---|
| TAN core | `src/net/tan.ts` | `TabAreaNetwork`: trunk port bridging the tab's switch onto a broadcast channel; identity lease (claim/defend/repick); lease-directory gossip; proxy-ARP for known members |
| Channel typing | same | `FrameChannel` — structural subset satisfied by browser BroadcastChannel, Node's, and sync test stubs; no DOM types in the substrate |
| Worker wiring | `src/browser/worker-host.ts` | `tan` option; identity acquired before boot (LOCALIP line + NIC MAC derive from it); trunk attached per boot; **TAN survives reboots** (tab keeps its address; defence stays live) |
| Bootopts | `src/browser/bootopts-patch.ts` | `extraLines` parameter — the TAN stamps `LOCALIP=10.0.2.<octet>`, which the stock `/etc/net.cfg` reads (`$LOCALIP` hook) — "DHCP at the bootopts layer" |
| Browser entry | `web/worker.ts` | Joins channel `emu86-tan-v1` (BroadcastChannel adapted to `FrameChannel` via a setter literal — the DOM `onmessage` property type is contravariant-hostile) |
| Tests | `tests/unit/tan.test.ts` (7), bootopts extraLines case (+1), `tests/integration/elks-tan-telnet.test.ts` (1) | |

Identity scheme: host octet ∈ [16..199] (gateway .2 and the plan's DNS .3 and single-tab .15 stay reserved); IP `10.0.2.<octet>`; MAC `02:65:6d:75:38:<octet>` — deterministic MAC=f(IP), which the proxy-ARP design depends on.

## 2. The acceptance, verbatim shape

`tests/integration/elks-tan-telnet.test.ts` (~15 s): two WorkerHosts on a synchronous hub (BroadcastChannel semantics: no echo to sender), octets 21/22 → distinct MACs asserted down to `machine.nic.mac[5]`; both boot the **stock** hd32 image through the auto-patcher, log in as root at their real login prompts, run `net start ne0` (transcripts show `ktcp: ip 10.0.2.21` / `.22` — the leased LOCALIPs flowing through net.cfg); then `telnet 10.0.2.22` typed into A's console and A's transcript gains a **fresh `login:` prompt served by B**. Wall-clock ~15 s for two boots + logins + the handshake.

## 3. The bug worth the milestone: ktcp's connect clock vs. TAN latency

First runs failed goldenly. Wire-tap + NIC counters + guest-side `netstat` triangulated it:

1. A's `telnet` made ktcp send one SYN — which **deveth queued awaiting ARP** for 10.0.2.22 (ELKS keeps a one-deep ARP-pending queue and drops further packets: `eth: DROPPING packet ... awaiting ARP reply`).
2. Cross-tab ARP resolution costs a full A→B→A round trip. Under interleaved execution (and equally under real-tab throttling), that's guest-*seconds* — during which **ktcp's SYN_SENT retransmit/give-up clock kept running against packets that never reached the wire**.
3. The connection object died of retransmit exhaustion; ARP then resolved; deveth flushed the orphaned SYN; B SYN-ACK'd into a void; A's ktcp `tcp_reject`ed each (`TCP Dropped` = every received segment; RST storm). On real hardware ARP takes ~1 ms and nobody ever sees this.

**Fix (architectural, not test-side): proxy-ARP from the lease directory.** Claims already broadcast every member's octet; a first-sighting gossip rule makes settled members re-announce once so newcomers learn the full membership; and since MAC = f(octet), each tab's TAN can answer `who-has 10.0.2.<member>` **locally and instantly**, injecting the reply as trunk traffic (so the CAM learns the member's MAC on the trunk port — exactly where its real frames flow). The owner's own later reply is a harmless duplicate cache update. `arp.c`'s cache handles duplicates by design.

Second finding, also fixed in the test harness: with 2 M-instruction interleave slices, peer response latency exceeded ktcp's ~3-RTO SYN patience even *after* ARP was instant (all three SYN retransmits predated B's first SYN-ACK on the wire). Slices of 500 K instructions (~0.1 guest-seconds) put round trips well inside the retransmit budget — and made the whole test *faster* (rounds exit on match). Real browser tabs run genuinely concurrently, so their latency is channel delivery (~ms); the test's interleaving was the worst case.

## 4. Confessed detour

The first instrumentation attempt (a scripted `str.replace` adding drop counters to `injectFrame`) converted brace-less single-line guards into `if (...) count++;` + a **dangling unconditional `return false`** — bricking every NIC receive and producing two runs of phantom evidence before the counters themselves exposed it. The guards now have braces, the counters (`rxAccepted`/`rxDropped`/`irqEdges` + `inspectRx()`) are permanent device diagnostics, and the lesson — don't regex-patch code you can edit properly — is hereby on the record.

## 5. Known limits and quirks (documented, deliberate)

- **Per-tab gateways remain duplicated** (same 10.0.2.2/MAC in every tab): they act as one anycast-ish gateway; a remote gateway's welcome ping can get its reply eaten by the local one. Harmless; single-elected-gateway is a later nicety, and the lease protocol is the natural election mechanism when needed.
- **Text of the lease protocol is trusting** — no auth, last-defender-wins; fine for same-origin tabs, which is the entire threat model.
- Node's real BroadcastChannel is not exercised by tests (sync stubs + the structural type are the contract; the browser is the production transport).
- Tab-throttling: two *visible* tabs telnet snappily; a heavily background-throttled tab will feel like a very slow peer (TCP tolerates it — now that connect() is ARP-latency-proof).

## 6. Reproduction / browser demo

```
npx vitest run tests/unit/tan.test.ts                          # ~1 s
npx vitest run tests/integration/elks-tan-telnet.test.ts       # ~15 s
```

Browser (the actual gold): open the dev server in **two tabs**, boot `hd32-minix.img` in each (each gets its own IP — watch the `ktcp: ip 10.0.2.x` line after `net start ne0`), then from tab 1: `telnet 10.0.2.<tab 2's octet>` → log into tab 2's ELKS from tab 1's xterm. Keep both tabs visible.

## 7. Test state

1,046 → **1,055 expected** (7 TAN unit + 1 bootopts + 1 integration); recorded in the phase commit. Typecheck clean across all configs; dist-cli/dist-web regenerated.

## 8. Next

The plan's ladder resumes at M3c (DNS pseudo-host at 10.0.2.3, DoH-backed) — now with a second consumer waiting: TAN guests can share one DNS answer fabric. And the TCP-termination milestone (M3d) has an in-repo precedent to test against: real ktcp TCP flows on the TAN make excellent reference traffic.
