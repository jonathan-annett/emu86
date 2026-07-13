# DNS Pseudo-Host Report — Phase 14 M3c

**Date:** 2026-07-14
**Brief:** `emu86-phase14-brief.md` M3c addendum (networking plan "Phase 16: DNS via DoH"; Jonathan's "M4")
**Outcome:** ✅ **The LAN has a nameserver.** A DNS pseudo-host lives at 10.0.2.3 (slirp convention, beside the M3b gateway at .2). The stock guest's own `nslookup` resolves through it — both with an explicit server argument and with **zero arguments** via the `DNSIP` env var the bootopts patcher now stamps — and every name-resolving ELKS tool (`telnet`, `urlget`, `ftp` via `in_gethostbyname`) rides the same path. In the browser the answers are real: an RFC 8484 DoH pass-through to Cloudflare, verified live from Node. In tests the resolver is an injected fixture — deterministic and offline.

**Plan deviation, with reason:** the networking plan's DNS host "listens on UDP/53." **ELKS has no UDP.** ktcp implements arp/ip/icmp/tcp only, and libc's resolver (`in_resolv.c`) opens a `SOCK_STREAM` to port 53 speaking RFC 1035 §4.2.2 length-prefixed DNS-over-TCP. M3c therefore pulled a minimal TCP listener engine forward from M3d — recorded in the brief addendum *before* implementation, and much smaller than M3d's full engine because the browser-side LAN is lossless, ordered, and synchronous (no retransmission, no reassembly, no timers).

---

## 1. Acceptance evidence

`npx vitest run tests/integration/elks-dns.test.ts` (~23 s, one boot):

1. Stock `hd32-minix.img` boots with `ne0=5,0x300,,0x80` and `DNSIP=10.0.2.3`; guest joins the LAN with its own `net start ne0`.
2. `nslookup example.com 10.0.2.3` → guest ARPs for .3, three-way handshake to :53, 31-byte length-prefixed query, fixture answer back, guest prints **`example.com is 93.184.216.34`**, closes; connection tears down to zero.
3. `nslookup example.com` (no server argument) → resolves via the `DNSIP` env var from bootopts, prints the second fixture's distinct address **`34.216.184.93`** — proving the zero-config path browser users get.
4. Host-side counters: 2 queries resolved, 0 SERVFAILs, 0 dropped answers, 0 live connections at exit.

Live DoH format verification (Node, this box, 2026-07-14): `dohResolve()` sent an `in_resolv`-shaped query for example.com to `cloudflare-dns.com/dns-query` → 61-byte answer, ID `0xabcd` preserved, RCODE 0, ancount 2, and the trailing-RR rdata (the exact bytes `in_resolv` reads as its result) held a valid A record.

## 2. What was built

| Piece | File | Shape |
|---|---|---|
| TCP wire formats | `src/net/wire.ts` | `buildTcpSegment` / `parseTcpSegment` / `tcpChecksum` — real pseudo-header checksums (ktcp validates and drops), option-skipping parse (ktcp's SYNs carry MSS), bare 20-byte headers out (ktcp never parses received options) |
| TCP listener engine | `src/net/tcp.ts` | `TcpStack` — listener registration, per-connection `(ip, port)`-keyed state, SYN→SYN\|ACK→ESTABLISHED, immediate ACK of inbound data, MSS-536 segmentation out, combined FIN\|ACK passive close, RST for refused ports (ktcp `tcp_reject` symmetry), deterministic ISS |
| DNS pseudo-host | `src/net/dns.ts` | `DnsHost` at 10.0.2.3 / 52:55:0a:00:02:03 — ARP responder + learner, TCP/53 listener, RFC 1035 §4.2.2 framing (prefix strip/restore, split-segment reassembly), injected `resolve(query) → Promise<answer>`, SERVFAIL synthesis on resolver failure, `dohResolve()` = RFC 8484 base64url GET |
| Browser wiring | `src/browser/worker-host.ts` | DnsHost with `dohResolve()` attached to the per-boot LAN, exposed as `WorkerHost.dns`, torn down with the switch |
| Bootopts stamp | `src/browser/bootopts-patch.ts` | `DNSIP_BOOTOPTS_LINE` (`DNSIP=10.0.2.3`) joins console/ne0/runlevel in the HD auto-patch; competing active `DNSIP=` lines dropped |
| Tests | `tests/unit/net-wire.test.ts` (+4), `tests/unit/tcp-stack.test.ts` (10), `tests/unit/dns-host.test.ts` (7), `tests/integration/elks-dns.test.ts` (1); bootopts tests updated (+1 assertion set) | |

## 3. Design notes

1. **Transport/host layering.** `TcpStack` is transport only — input is IPv4 payloads, output is segments through an injected `transmit`. Ethernet, ARP, and IP wrapping live in the pseudo-host. M3d's HTTP gateway grows from the same stack; DNS is its first consumer.
2. **The lossless-LAN dividend.** No retransmit queue, no reordering, no congestion control, no timers, and TIME_WAIT is meaningless without a clock — connections drop at the final ACK. What remains is exactly what ktcp checks: valid checksums, strictly in-order sequence numbers (`tcp.c:556` drops anything else), and the FIN dance. The combined FIN|ACK passive close matches `tcp_fin_wait_1`'s CLOSING→TIME_WAIT path and was pinned in unit tests.
3. **First async pseudo-host.** The query is ACKed synchronously inside the frame callback (ktcp would retransmit otherwise); the answer transmits when the resolve promise settles — the queue-and-complete pattern `ARP_ICMP_REPORT.md` §3.3 reserved. The switch stays pure. If the guest gives up first (its 2 s alarm), the late answer is dropped and counted (`answersDropped`), not an error.
4. **DoH is a pass-through, not a resolver.** The guest's raw query is base64url'd into a GET (`accept: application/dns-message`, no preflight); the response bytes go back verbatim with the length prefix restored. No DNS message parsing browser-side except the two header bytes SERVFAIL synthesis flips. The guest's stack does all the real DNS work — authentic to the project's posture.
5. **Deterministic everywhere it counts.** ISS is a counter, not a clock; the integration test's resolver is a fixture; the two lookups return distinct addresses so each config path is proven independently.

## 4. Findings

1. **ELKS speaks DNS over TCP only** (the reshaping finding — details in the brief addendum). ktcp has no `udp.c`; `in_resolv()` → `SOCK_STREAM` port 53; `nslookup` and `in_gethostbyname` (telnet/urlget/ftp) all route through it. The plan's UDP/53 assumption and its "DNS could come before TCP" ordering note were both written against a stack ELKS doesn't have.
2. **Virtual time races wall time while the guest is blocked — async completions must land between run batches.** The first integration-test runs failed with the guest timing out *before the resolve promise could ever settle*: a blocked guest HLTs, halt-spins advance the virtual clock 1,000 cycles at a step, and one 200,000-instruction `traceRun` swallowed the entire 2-second `alarm()` window (9.5 M cycles — measured on the wire as exactly 200 jiffies between query and FIN) with zero JS yield points. Fix: drive the machine in small batches (20 k instructions) with a microtask flush between them — which is precisely the browser worker's natural shape (5 k-instruction batches, yield each). **Rule for all future fetch-backed pseudo-hosts: promise completions only reach the guest at batch boundaries; harness code must yield often enough that guest-side timeouts (measured in fast-running virtual time) don't expire first.**
3. **`in_resolv` masks read errors as "Name not found"** — a guest libc bug worth knowing when reading transcripts: `if (rc < sizeof(...DNS_HEADER) + sizeof(...RR))` compares the *signed* read return against an *unsigned* sizeof, so `rc = -EINTR` converts to 65532 and sails past the guard; the function then parses its own transmit buffer (the query it just built, still in `buf`), finds ancount 0, and reports ENONAME. Every timeout therefore prints `Name not found` rather than a timeout error. Diagnosed with byte-timestamped wire logging; documented, deliberately not worked around.
4. **Bootopts env reaches login shells — second data point.** `DNSIP=10.0.2.3` stamped in `/bootopts` was visible to `nslookup`'s `getenv` under `init=/bin/sh` (the TAN's `LOCALIP` proved the `/bin/net` path). The zero-config browser story holds: boot, `net start ne0`, `nslookup example.com`.
5. **`in_resolv` quirks that bound future answers:** it reads at most 200 response bytes and takes the *last* RR in the buffer as the result. Cloudflare's live answer for example.com (61 bytes, 2 RRs, A record last) fits both constraints today. Large or CNAME-tailed responses may confuse it — that's guest libc behavior to document per-case, not to patch around.

## 5. Deliberately not done

- **No UDP** — nothing in the guest speaks it.
- **No interception of `208.67.222.222:53`** (libc's hardcoded OpenDNS default, used when `DNSIP` is unset). Off-subnet traffic routes to the gateway MAC; teaching the gateway to terminate arbitrary-destination TCP is M3d's subject. Until then the DNSIP stamp makes the default path moot.
- **No resolver cache, no DoH provider configuration surface** — plan open-question 3 stays parked until pseudo-hosts warrant a settings UI.
- **No real-browser DoH verification** — `dohResolve`'s fetch was verified from Node against live Cloudflare (§1); the CORS-in-browser leg needs a human at the dev server, same as every browser milestone.
- **No fix for the guest's `in_resolv` bugs** (signed/unsigned guard, 200-byte cap, last-RR assumption) — unmodified-ELKS-as-reference-target rule; they're recorded as findings instead. The signed/unsigned one is a tidy upstream patch candidate and a plausible future in-VM-compile demo.

## 6. Reproduction

```
npx vitest run tests/unit/net-wire.test.ts tests/unit/tcp-stack.test.ts tests/unit/dns-host.test.ts   # ~2 s
npx vitest run tests/integration/elks-dns.test.ts                                                     # ~23 s
```

Browser demo: `npm run dev:browser` → boot `hd32-minix.img` from the library → log in as `root` → `net start ne0` → `nslookup example.com` — real answers via Cloudflare DoH, no configuration. Works through the agent bridge too.

## 7. Test state

1,055 → **1,078 expected** (+4 TCP wire, +10 TcpStack, +7 DnsHost, +1 integration, +1 bootopts delta); full suite green on this box (94 files passed, 1 skipped — the usual SST corpus), `npm run typecheck` clean across all three configs, `dist-cli`/`dist-web` regenerated.

## 8. Next

M3d — TCP termination for arbitrary destinations + the HTTP gateway. The engine seed exists (`src/net/tcp.ts`), the DNS host demonstrates the async completion pattern it will reuse at scale, and real ktcp flows (this milestone's, and the TAN's) are reference traffic. The gateway will also need outbound-connection support (we only listen today) and a DNS-answer↔destination-IP cache to reverse-map fetch targets (plan §"HTTP gateway", step 5).
