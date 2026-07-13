# ARP + ICMP Gateway Report — Phase 14 M3b

**Date:** 2026-07-13
**Brief:** `emu86-phase14-brief.md` M3b (networking plan "Phase 15: ARP + ICMP pseudo-host")
**Outcome:** ✅ **The LAN is alive.** A gateway pseudo-host now lives at 10.0.2.2 — the exact address the guest's own `/etc/net.cfg` has always pointed at — answering ARP and speaking ICMP echo in both directions. The stock ELKS `net start ne0` joins the LAN via its own unmodified tooling; the gateway pings the VM and ktcp echo-replies byte-exactly; the guest's own `netstat` shows the matching ICMP counters. Every new test passed on its first run, including the integration acceptance.

**Plan deviation, with reason:** the networking plan's demo was "`ping 10.0.0.1` from inside the VM." **ELKS ships no ping client** — `elkscmd/inet/` holds arp/ftp/httpd/netcat/netstat/nslookup/telnet/urlget, and ktcp's `icmp.c` implements echo *reply* only (verified in source; Jonathan independently confirmed no ping binary on the booted image). The demo therefore inverts: **the LAN pings the VM**, which exercises the identical ARP + ICMP + IRQ + ring-buffer path, and the guest-visible proof is `netstat`'s ICMP/ARP counters. A guest-originated ping needs ktcp changes upstream — recorded as a future in-VM-compile candidate, not scope-creep for today.

---

## 1. Acceptance evidence

`npx vitest run tests/integration/elks-ping.test.ts` (~35 s, one boot):

1. Stock `hd32-minix.img` boots with `ne0=5,0x300,,0x80`; detection line present.
2. Guest runs its own **`net start ne0`** → ktcp launches against `/dev/ne0` with `/etc/net.cfg` defaults (10.0.2.15 / gw 10.0.2.2 / /24) and sends its startup **gratuitous ARP** (`deveth.c:57`) — the gateway learns `10.0.2.15 → 02:65:6d:75:38:36` without ever asking.
3. Gateway pings 10.0.2.15 three times (id 0xe86, seq 1–3, 32-byte payload). ktcp's `icmp.c` echo-replies to each; all three replies arrive with id, seq, and payload intact.
4. In-guest `netstat` prints `ICMP Packets 3  ICMP Packets 3` (received/sent) — asserted by regex against the serial transcript.

Suite: **1,046 expected** (9 wire + 8 gateway + 1 integration on top of 1,028; full-suite result recorded in the phase commit).

## 2. What was built

| Piece | File | Shape |
|---|---|---|
| Wire formats | `src/net/wire.ts` | Pure builders/parsers: ethernet II, ARP, IPv4 (real RFC 1071 checksums — ktcp validates and counts "IP Bad Checksum"), ICMP echo |
| Gateway pseudo-host | `src/net/gateway.ts` | `LanGateway` at 10.0.2.2 / 52:55:0a:00:02:02 (QEMU-slirp conventions): ARP responder + learner, ICMP echo both directions, `ping()` with ARP-resolve queueing, optional welcome-ping |
| Browser wiring | `src/browser/worker-host.ts` | Gateway attached to the per-boot LAN, `welcomePing: true`, exposed as `WorkerHost.gateway` |
| Bootopts patch | `src/browser/bootopts-patch.ts` | `NE0_BOOTOPTS_LINE` (`ne0=5,0x300,,0x80`) added to the HD auto-patch — `net start ne0` in the browser just works |
| Tests | `tests/unit/net-wire.test.ts` (9), `tests/unit/lan-gateway.test.ts` (8), `tests/integration/elks-ping.test.ts` (1); bootopts tests updated for the new line | |

## 3. Design notes

1. **QEMU-slirp addressing throughout** (guest .15, gateway .2, gateway MAC 52:55:0a:00:02:02): `/etc/net.cfg` defaults to this layout, so the guest needs zero configuration — `net start ne0` with stock files joins our LAN.
2. **The gratuitous ARP does the introductions.** ktcp broadcasts an unsolicited ARP reply at startup; the gateway learns from *any* ARP sender fields (requests, replies, gratuitous alike), so pings usually go out with no who-has round trip. The resolve-then-queue path exists and is unit-tested for the cold-cache case.
3. **Everything is synchronous.** `ping()` either transmits immediately or queues behind one ARP request; "later" only means "when the next frame arrives at the gateway port". No timers, no promises — future fetch-backed pseudo-hosts (DNS/HTTP) will queue internally and transmit on their own completion, leaving the switch pure.
4. **Welcome ping** (browser only, off by default): one echo request per newly-learned host, so a browser user who types `net start ne0` then `netstat` sees ICMP 1/1 and live ARP counters instead of zeros. Unit-tested to fire exactly once per host.
5. **Real checksums, deliberately.** ktcp drops bad-checksum IP packets and counts them; zeroed checksums would have "worked" against a permissive stack and bitten later. The RFC 1071 worked example pins the implementation.

## 4. Findings

1. **ELKS has no ping client** (see deviation note above) — the plan's phase-15 demo line was written on an assumption the source doesn't support. The netstat-counter acceptance is the honest equivalent and arguably better evidence: it proves the *guest's* stack counted the traffic, not just that frames moved.
2. **`net start ne0` also launches `telnetd` and `ftpd`** (net.cfg's `netstart` list) — both open ktcp sockets and listen. Harmless today; they become genuinely reachable the moment M3d's TCP termination lands, which will make `telnet 10.0.2.15` from a pseudo-host a fun future acceptance.
3. **ktcp names the guest 10.0.2.15 even though the stock bootopts `#LOCALIP=10.0.2.16` comment suggests .16** — the commented line is dead; net.cfg's fallback (`localip=10.0.2.15`) is what runs. Worth remembering when the DNS/gateway phases pick pseudo-host addresses.

## 5. Deliberately not done

- **No DNS pseudo-host** — M3c per the plan (DoH via Cloudflare; needs fetch plumbing and the async-completion pattern).
- **No TCP anything** — M3d/M3e (termination engine, then HTTP proxy).
- **No periodic/keepalive pings** — one welcome ping per host, then silence; a chatty LAN would pollute every future test transcript.
- **No guest-side ping tool** — would require ktcp changes or a raw-frame userland tool in-VM; flagged as a dogfooding candidate (compile it with the on-disk c86 one day), not built.

## 6. Reproduction

```
npx vitest run tests/unit/net-wire.test.ts tests/unit/lan-gateway.test.ts   # ~2 s
npx vitest run tests/integration/elks-ping.test.ts                          # ~35 s
```

Browser demo: `npm run dev:browser` → boot `hd32-minix.img` from the library → log in as `root` → `net start ne0` → `netstat` (ICMP counters show the welcome ping). Works through the agent bridge too.

## 7. Next (M3c)

DNS pseudo-host at 10.0.2.3: parse UDP/53 queries off the LAN, resolve via DNS-over-HTTPS (`fetch` to a CORS-permissive resolver), answer authentically. Guest acceptance: `nslookup example.com 10.0.2.3` returning real records in the browser xterm. First async pseudo-host — establishes the queue-and-transmit-on-completion pattern the HTTP gateway will reuse.
