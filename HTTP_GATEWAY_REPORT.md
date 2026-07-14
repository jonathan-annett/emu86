# HTTP Gateway Report — Phase 15 M1 (the milestone the networking plan called M3d)

2026-07-14. Brief: `emu86-phase15-brief.md` §M1 (approved in-session).
Commits: `6cb3304` (engine), `00665bc` (gateway host + wiring), plus the
mixed-content follow-up in the same session. Everything below was run,
not assumed; file:line references are to this tree.

## 0. TL;DR

`urlget http://example.com/` works from inside ELKS. The guest's own
resolver asks the DNS host, ktcp routes the off-subnet TCP :80 to the
gateway MAC, the new `HttpGatewayHost` terminates it speaking as
93.184.216.34, reconstructs the URL Host-header-first, `fetch()`es,
and streams an HTTP/1.0 response back — verified end-to-end by a
booted-ELKS integration test (`tests/integration/elks-http.test.ts`)
whose fixture body reaches the guest's stdout byte-exact. The free
acceptance test from the brief also passes: `nslookup example.com
208.67.222.222` — OpenDNS, the resolver's no-DNSIP default, parked in
`DNS_DOH_REPORT.md` §5 "until M3d" — resolves through the gateway's
:53 terminator.

## 1. What landed

**Engine (`src/net/tcp.ts`, commit `6cb3304`)** — three additions the
plan's terminator needs, and deliberately nothing else:

- **Promiscuous accept** (`listenAny`): terminate a SYN to any
  (IP, port); connections carry the dialed identity (`conn.localIp` /
  `localPort`), replies are built and checksummed from it, and the
  transmit callback gained a `srcIp` third argument (single-identity
  hosts ignore it — `DnsHost` needed zero changes). An optional accept
  predicate lets refused ports fall through to the existing RST path.
- **Active close** (`conn.close()`): FIN-after-drain, plus
  handler-owned half-close — `onRemoteClose` now parks the connection
  in `close-wait` where `send()` still works.
- **Window pacing**: outbound data goes through a per-connection queue
  drained against the peer's advertised window (`seg.window` was
  parsed-but-unused before). Still timerless: the pump runs on
  `send()`, `close()`, and every arriving ACK.

There is still **no active open** — the guest is always the initiator
on this LAN, so client-side TCP was never needed. That surprised us
pleasantly when scoping: "TCP termination for arbitrary destinations"
is promiscuous *passive* open, a much smaller thing.

**Gateway hook (`src/net/gateway.ts`)**: `gateway.ts:201`'s silent
drop of routed IPv4 grew a branch — off-subnet TCP goes to a
registered terminator (`registerTcpTerminator`); `sendIpv4To` carries
replies back out from arbitrary source identities behind the gateway
MAC, exactly how a router looks on the wire. Non-TCP routed traffic
still drops (guest-originated off-LAN ICMP is M3's business).

**`HttpGatewayHost` (`src/net/http.ts`, new, ~430 lines)**: not a LAN
citizen — no MAC, no switch port; it plugs into the LanGateway because
routing already delivers every off-subnet packet there. Two payload
modes by dialed port: **:53** is a DNS-over-TCP pass-through identical
in shape to `DnsHost` (that's the OpenDNS path), **everything else**
parses one HTTP request, fetches, answers HTTP/1.0-framed with
`Connection: close`, and FINs. **:443 RSTs immediately** — fetch owns
TLS, so raw HTTPS termination is structurally impossible, and an
instant connection-refused is honest where a hang is not.

**Reverse map (`DnsAnswerCache` in `src/net/dns.ts`)**: the recorded
posture change from the brief. When a cache is supplied, `DnsHost`
*reads* successful answers (first question name + A records) — the
pass-through to the guest is still byte-exact. A-record IPs map to the
**question** name, not the RR owner: after a CNAME chain the guest
dials the name it *asked for*, and that is the Host header to
reconstruct. In practice the cache is belt-and-braces: ELKS `urlget`
sends a `Host:` header (verified in source — see §3), so the fallback
chain Host → cache → dotted-IP usually stops at the first link.

**Browser wiring (`src/browser/worker-host.ts`)**: HTTP gateway
attached at boot alongside the M3b/M3c hosts; the run-loop stall
condition now covers `pendingFetches` too (§4).

## 2. The one deviation from the brief's wording

The brief said "the gateway must know all response bytes are ACKed
before FIN" (close-after-drain via a sent-unACKed watermark). What
landed is **FIN-after-transmit**: the FIN goes out in the pump that
transmits the last queued byte, without waiting for that byte's ACK.
On this wire the distinction is unobservable — the switch is lossless
and synchronous, ktcp processes strictly in order, so a FIN sequenced
after the data cannot arrive "early" — and waiting for the ACK would
have added a round-trip per response and a second bookkeeping state
for zero behavioral difference. The sent-unACKed watermark exists
anyway (`sndUna`, it drives window pacing), so if a future transport
(the CF relay option) ever makes the wire lossy, the conservative FIN
condition is a one-line change in `#pump`. The M3c passive-close wire
trace (single combined FIN|ACK) is preserved exactly; the pinned tests
pass unchanged.

## 3. What urlget actually sends (brief question #2)

From `reference/elks/elkscmd/inet/urlget.c` (read this session):

- Request: `GET {path} HTTP/1.0`, then `User-Agent: urlget`,
  `Connection: Close`, optional `Authorization`, optional
  `Content-Length` (POST via `-p`), then `Host: {host}` — **one
  `write()` per header line** (`urlget.c:279-297`), so the request
  arrives split across several TCP segments and any parser must
  accumulate. Ours does; the integration test exercises exactly this.
- `Host:` is always present → Host-header-first reconstruction is the
  common path, the DNS cache a fallback for other clients.
- Close behavior: `net_connect` sets `SO_LINGER {onoff=1, linger=0}`
  ("will send RST on close", `urlget.c:80-82`), but the post-response
  `net_close(fd, 0)` comment says FIN. Either retires cleanly in our
  stack (RST → drop; FIN → last-ack → drop); the integration test
  asserts zero leaked connections after the exchange. Which flavor
  ktcp actually emits was not dissected — nothing downstream depends
  on it.

## 4. The DNS stall question (brief question #1)

The brief asked whether `dns.ts`'s in-flight stall is still needed now
that host pacing exists. Answer: **the pacing session already
re-litigated this and kept it**, reframed as bounded belt-and-braces —
the comment at the stall site (`worker-host.ts` paced loop) records
that a slow fetch can still outlast the guest's 2-second resolver
alarm even under honest pacing, and stalled wall time must not become
guest time. I followed that standing decision rather than reopening
it: the HTTP gateway's `pendingFetches` (fetches + :53 resolves in
flight) joined the same stall condition. Field trials on the dev tier
can revisit both together; they are one `if` clause.

## 5. Verified

- **Full suite: 1,154 passed, 102 files + 1 skipped** (the SST corpus,
  as always) — the delta over the session-start baseline of 1,128 is
  exactly this milestone: 25 new unit tests + 1 new boot-level
  integration test. Typecheck clean on all three configs.
- **Booted-ELKS end-to-end** (`tests/integration/elks-http.test.ts`):
  guest `urlget http://example.com/` → fixture fetch saw exactly
  `http://example.com/`, method GET, `user-agent` forwarded, `host`
  and `connection` stripped as hop-by-hop; fixture body on guest
  stdout byte-exact; `nslookup example.com 208.67.222.222` resolved
  via the gateway :53 path; zero leaked connections after both.
- **Engine unit coverage** (`tests/unit/tcp-stack.test.ts`, 20 tests):
  M3c behaviors pinned unchanged (combined FIN|ACK, RST forms,
  strict-seq re-ACK, 536-byte segmentation); new: idle active close,
  FIN held behind a stalled window until drain, half-close
  send-then-close, window pacing across ACK rounds (3,000 bytes
  through a 1,000-byte window in 536+464 pairs), zero-window park and
  resume, per-destination identity independence, RST-from-dialed-IP,
  port-listener-beats-listenAny, :443 predicate refusal.
- **Gateway host unit coverage** (`tests/unit/http-gateway.test.ts`,
  11 tests): full wire-level round trips through a real switch +
  gateway (ARP learn → routed SYN → response bytes), 502 on fetch
  rejection, 400 on non-HTTP preamble without calling fetch,
  half-close delivery, POST body forwarding, header stripping in both
  directions, reason-phrase refill for HTTP/2 origins, :53
  pass-through, mixed-content URL upgrade rules.
- **DnsAnswerCache** (`tests/unit/dns-host.test.ts`): compressed-name
  parsing, CNAME-chain → question-name mapping, garbage immunity
  (including a pointer-loop bomb), end-to-end population through a
  live `DnsHost` resolve.

## 6. Limits and negative results (recorded, not hidden)

- **CORS still bounds the browser.** Node integration tests inject
  fetch, so the CORS boundary is *untested* until the dev-tier field
  run. Expectation to verify in the field: CORS-permissive origins
  work, others 502 with the browser's opaque TypeError.
- **Mixed content forced a scheme upgrade.** The deployed page is
  HTTPS; browsers block plain-http fetches from secure pages. The
  browser-boundary fetch (`realGatewayFetch`) therefore upgrades
  port-80 URLs to `https://` (explicit non-80 ports left alone — TLS
  on a random port is a different service). The guest still speaks
  HTTP/1.0 on the LAN wire; only the host-side hop travels TLS. This
  quietly widens reach: any CORS-permissive HTTPS site is now
  fetchable by a 1989-vintage HTTP client. Recorded as a deliberate
  transparency trade, overridable via `{upgradeToHttps: false}`.
- **Non-HTTP traffic to a non-443 port hangs the guest** until its own
  timeout: we accept the connection, then wait forever for a request
  that never completes (a >16 KiB header run does 400). A telnet to
  port 25 gets a connect, then silence. Acceptable for v1; the honest
  fix (idle RST) needs a timer the stack deliberately doesn't have.
- **One request per connection.** `Connection: close` semantics; a
  keep-alive client's second request on the same connection is
  ignored. urlget/httpget-era clients don't pipeline.
- **HEAD returns headers only** (body suppressed even though fetch
  buffers it). GET/POST verified; other methods pass through untested.
- **Multi-KB pacing against real ktcp is unit-tested, not
  field-proven**: the integration fixture body is small (fits the
  4380-byte window in one flight). First real stress of window pacing
  against actual ktcp ACK behavior comes with a big page on the dev
  tier — watch `windowStalls` and ktcp retransmit counters in
  `netstat` if pages stall.

## 7. Deliberately not done (per the brief's scope decisions)

- **The CF Worker WS↔TCP relay (D1)**: untouched, per the brief —
  decide after M3d lands, which is now. The mixed-content finding
  above is relevant input: the pure-fetch gateway already reaches
  HTTPS sites (via the upgrade), so the relay's marginal value is
  CORS-free access and non-HTTP protocols (FTP/telnet/IRC), against
  the recorded costs (server dependency, abuse surface).
- **webget/ttyS1 escape hatch (D2)**: not started, stays the
  sanctioned raw-HTTPS answer.
- **Config surface (D3)**: hardcoded v1 policy (443 refused,
  everything else terminated as HTTP; :53 pass-through). Plan
  open-question 3 stays parked.
- **Guest-originated off-LAN ICMP**: still drops silently at the
  gateway; M3 (ktcp-ping) owns the dest-unreachable answer.

## 8a. Field verification — FIRST CONTACT CONFIRMED (2026-07-14)

Jonathan, dev tier, real browser (#olfr): `urlget
http://captive.apple.com` printed Apple's captive-portal success page
inside ELKS. Root-caused host-side same session: captive.apple.com
serves `Access-Control-Allow-Origin: *`, so the whole designed chain
executed — Host-header URL reconstruction, the mixed-content upgrade
to https, a CORS-approved fetch, HTTP/1.0 framing back — and the body
the guest printed is byte-identical to what curl gets from Apple. The
guest fetched the real internet. Remaining §8 items still open.

## 8. Field verification needed (dev tier only, per the standing constraint)

Deploy `npm run deploy:dev`, then from a tab on the dev URL:
`urlget http://example.com/` (CORS-permissive, should print the page),
`urlget http://neverssl.com/` (mixed-content upgrade check — note it
may still 502 on CORS), `nslookup example.com 208.67.222.222`, and a
deliberately big fetch to stress pacing. 8086-tab.net stays untouched
until explicitly promoted.
