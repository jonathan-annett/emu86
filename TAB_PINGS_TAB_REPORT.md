# Tab-pings-tab Report — ping learns who it is, and answers for itself

2026-07-15. Fixes the field bug recorded in `TABS_NAMESPACE_REPORT.md` §5
(Jonathan, 2026-07-14): `ping cat` from another tab timed out; only
ping→gateway worked. Ships as **ping rev 5** in the public tools repo
(github.com/jonathan-annett/8086-tab-tools) — no emu86 release needed for
the fix itself, exactly as the Phase 15 design intended.

## 0. TL;DR

Three bugs, not two:

1. **`ping.c` hardcoded its source address** (`my_ip = 10.0.2.15`), an
   address no TAN tab owns. Fixed: `getenv("LOCALIP")` — the bootopts
   stamp every tab boots with — with .15 kept as the solo fallback.
2. **`ping.c` never answered ARP.** With ktcp stopped, nothing else
   speaks for the machine, so a peer that couldn't resolve us couldn't
   reply. Fixed: ping answers who-has for `my_ip` in every wait loop —
   including the gap between pings, which used to be a deaf `select()`.
3. **NEW, found while shipping the fix: the `pingrev` marker mechanism
   documented in `web/ping-installer.ts` since rev 4 was never
   implemented.** `install-ping.sh` had no marker check at all:
   `/bin/ping` present → exit; drive binary present → restore it.
   **Bumping `PING_REV` alone would have shipped the fix to nobody with
   a saved drive.** The mechanism now actually exists (§3).

## 1. The diagnosis held — with one refinement worth recording

The §5 diagnosis was written from the source, unconfirmed by a run. It
was right about both bugs, but reading `src/net/tan.ts` while designing
the fix showed the two do NOT weigh equally on the TAN:

**Proxy-ARP would have covered bug 2 on the TAN once bug 1 was fixed.**
Every tab's `TabAreaNetwork` proxy-answers who-has for any *known member
octet* except its own (`tan.ts:250–272` — member MACs derive from
octets, so no round trip is needed). The far tab's ktcp asking "who-has
10.0.2.16?" gets answered *by its own tab's proxy*, instantly. The
reason nobody answered in the field is that ping claimed **.15**, which
is not a member octet and is in nobody's directory — bug 1 poisoned the
proxy too.

So bug 1 is the load-bearing fix for the TAN case. Bug 2 still matters:
solo there is no TAN and no proxy; a race where the peer ARPs before our
claim reached its directory has no proxy either; and a host that claims
an address but won't answer for it is a wrong network citizen. Both are
fixed; the point is recorded so nobody later "simplifies" the proxy away
believing ping's responder makes it redundant, or vice versa.

## 2. What changed in ping.c (rev 5)

Canonical copy `web/guest/ping.c`, mirrored byte-for-byte to the tools
repo (a test now pins the mirror — §4).

- `main()` reads `$LOCALIP` via `getenv()` — present in the on-image
  libc86 (`reference/elks/libc/c86.mk` includes `misc/`, which carries
  `getenv.c`). Parsed into a scratch buffer first: `parse_ip()` writes
  as it goes, and a malformed value must not half-overwrite the default.
  **Deliberately NOT the MAC's last byte**: on the TAN it matches the
  octet, but solo the MAC is the fixed default (…38:36) while the IP is
  .15 — §5's warning, preserved as a comment in the code.
- New `arp_answer()`: if the received frame is an ARP who-has for
  `my_ip`, reply (from a dedicated 60-byte buffer; `txf` may hold an
  echo). Called in `arp_resolve()`'s wait loop, `wait_answer()`'s wait
  loop, and `gap_ms()` — which replaces `idle_ms()`, the between-pings
  sleep that used to hear nothing.

## 3. The pingrev markers (install-ping.sh, tools repo)

ELKS sh has no `$(...)` to compare a version string, so the revision is
in the marker file's *name* and currency is one `test -f`:

- `/etc/pingrev$REV` — this machine's `/bin/ping` is rev `$REV`. Written
  on every install path. `/bin/ping` present *without* it → reinstall
  (covers persisted HD sessions holding an old binary).
- `$work/pingrev$REV` — the workshop's `ping` + `ping.c` are rev `$REV`.
  Missing → `rm -f` the artifacts before the existing cheapest-path
  logic runs, because **a stale workshop is worse than an empty one**: an
  old binary would be restored forever, and an old *source* would
  faithfully rebuild the old bug with no download in sight.

Old markers are `rm -f`'d before the new one is written (globs with no
match pass through as literals; `-f` eats the error). A failed download
now also removes the empty `ping.c` it leaves behind.

`REV=5` in the script; `PING_REV = 5` in `web/ping-installer.ts`, whose
doc comment now describes the mechanism that exists rather than the one
that was imagined (the confession is in the comment, and in §0).

## 4. Drift guards added

- `browser-ping-installer.test.ts` now pins, against the local tools
  checkout: `install-ping.sh` contains `REV=${PING_REV}`, and the tools
  repo's `ping.c` is byte-equal to `web/guest/ping.c`. (Skips with a
  warning when the checkout is absent, like the e2e test beside it.)
- `tests/unit/ping-installer.test.ts` floor raised to rev 5.
- The existing tan-names table pin passes untouched — the fix doesn't
  move the name table.

## 5. How it was verified (and what wasn't)

The probe survey (`tests/probe/surveys/elks-ping.ts`) grew two duties on
top of compile-and-ping-the-gateway:

- The boot stamps `LOCALIP=10.0.2.42` — the very bootopts line the TAN
  patcher writes — and the test asserts the banner says `from
  10.0.2.42`. This proves the whole env chain (bootopts → init → sh →
  exec) delivers `$LOCALIP` to a C program's `getenv`, not just to
  `/etc/net.cfg`.
- An **ARP prober** on the LAN plays the far tab's ktcp: it asks
  who-has 10.0.2.42 twice while ping runs (first cued by ping's own ARP
  broadcast, the second by the first answer, so the asks land in
  different wait loops). Only ping can answer — the gateway ARP-answers
  its own IP only, and ktcp is never started in the probe. Asserted:
  two answers, claiming 10.0.2.42.

Results:
- `npm run typecheck` — clean.
- **Full suite: 1,206 passed, 109 files, 1 skipped** (the SST corpus,
  absent on this machine as always — see CLAUDE.md §2). The new
  baseline, up from 1,169 at the Phase 15 close.
- `elks-ping-invm.test.ts` (real c86 build of the fixed source in-VM,
  LOCALIP + prober assertions): **passed in 146 s** — banner
  `from 10.0.2.42`, prober asked twice / answered twice / guest claims
  `10.0.2.42`, gateway 3/3 + honest unreachable, md5 receipt intact.
  A bonus confirmation hiding in the verbose line: the guest's ARP
  reply carried MAC `02:65:6d:75:38:36` — the *solo default* — against
  IP .42. Had we derived the address from the MAC's last byte (the
  tempting shortcut §5 warned against), ping would have claimed .54.
- `browser-ping-installer.test.ts` (the browser flow end-to-end with the
  NEW install-ping.sh; rev/mirror pins): **passed, 2/2 in 88 s** — the
  guest fetched the new installer, c86 built the new source (so
  `getenv` really is in libc86), installed, and pinged `elk` 3-for-3.

**Not verified, deliberately:**
- **No red run.** The new assertions were not first run against the
  unfixed binary (a second 15-minute in-VM compile). The assertions are
  tightly coupled to the fix — the banner string comes out of the binary
  and nothing else on the probe LAN can send those ARP replies — so a
  false pass would require the fix itself. Judged not worth the wall
  clock; noted for honesty.
- **No two-machine TAN ping test.** The true field scenario (raw ping in
  tab A, ktcp answering in tab B, frames over the trunk) is not run
  end-to-end anywhere. The pieces are covered separately — cross-tab
  ktcp↔ktcp by `elks-tan-telnet.test.ts`, ktcp's echo-reply by
  `elks-ping.test.ts` (gateway pings guest), ping's tx/rx identity by
  the probe above — and a combined test would double the slowest suite
  (a second in-VM compile, or a committed prebuilt binary that would rot
  against ping.c). **Field acceptance is the missing piece and it is
  Jonathan's**: two tabs on the dev tier, `net stop` in one, `ping cat`.
- **Workshop-on-drive with a real /dev/hdb** remains untested from
  before (GUEST_TOOLING_REPORT §5) — now slightly *more* interesting: a
  drive saved with rev-4 artifacts should visibly purge and re-fetch.

## 6. Shipping state

- emu86: committed on `main` (source, tests, PING_REV, this report).
- tools repo: committed locally — **`git push` is Jonathan's**, and the
  fix reaches machines only when pushed (the guest fetches from
  raw.githubusercontent.com). Until then the field still installs rev 4.
- `seedRev` deliberately NOT bumped: the seeded boot script's text is
  unchanged (it fetches the installer; the installer carries the rev).
  Stored profiles need no refresh for this fix — that indirection is the
  Phase 15 design paying off.

## 7. Design note — "shouldn't ping work with the network up?" (Jonathan)

Raised mid-session, worth its permanent answer. Ping's only reachable
targets are indeed LAN residents (tabs, elk, owl), and the *target's*
network being up is desirable — ktcp is what answers over there. But the
*source* cannot share the NIC with ktcp:

1. ktcp exposes no ICMP surface — TCP sockets only (no UDP, no raw
   sockets; its icmp.c is reply-only). "On top of the stack" has nothing
   to stand on; echo must be raw frames.
2. `/dev/ne0` is a single-consumer stream — `read()` pops each frame
   once, no duplication (no BPF in ELKS). A running ktcp drains every
   inbound frame (field-proven: `open()` still succeeds, then every ARP
   times out — the trap documented in ping.c). Winning the race would be
   worse: frames stolen from live TCP sessions.

The honest path to network-up pinging is a **TCP reachability probe**
("tcping"): connect via ktcp; SYN-ACK *or* RST proves the host up,
timeout proves it down. Real RTTs, no `net stop`, exercises the same
path telnet uses. Recorded as a candidate tool for the tools repo — not
scoped, not started.

---

## 8. FIELD CONFIRMED, and the follow-up wave (2026-07-15, same session)

Jonathan, dev tier, two tabs: **`ping cat` between tabs works.** Rev 5
accepted. Three follow-ups came straight out of the same field run —
scoped in the Phase 15 brief's post-close addendum, landed as follows.

### 8a. Correction to §7: ping with ktcp up is RACY, not impossible

Field: with the network up, `nslookup google.com` then `ping cat`
works. §7's "ktcp drains every inbound frame" overstated the
constraint — each inbound frame goes to exactly ONE reader, and ping's
select can win that race per frame. So network-up pinging *can* work
and evidently often does; it can also silently lose any individual
reply to ktcp (which discards echo replies — its icmp is answer-only).
`net stop` remains the reliable mode; tcping (§7) remains the honest
network-up design. Worth remembering how we got here: the very first
field failure was blamed on ktcp draining frames when it was actually
the .15 identity bug (commit 76f9821, "stop blaming the wrong thing")
— the drain lore was born half-wrong and is now recorded half-right.

### 8b. The resurfaced resolver flake was OURS, not the guest's

Field: with two tabs open, the first resolve after `net start` fails
and Jonathan had to prime with `sleep 1; nslookup <name>` before
`urlget` was reliable — the EXACT pre-stall symptom of 5c0aa63.
Root cause (proven red in `tests/unit/tan-residents.test.ts` before
the fix): every tab hosts its own DNS host and gateway at identical
fixed MACs; on a TAN the remote resident's ARP reply crosses the trunk
AFTER the local one and wins the CAM, so the guest's DNS/gateway
unicast is served by the OTHER tab — where the DNS/fetch stall pauses
the WRONG machine (the asker's 2-second `in_resolv` alarm keeps
running against a cold DoH fetch in a throttled background tab), and
where the DoH answer cache feeding the HTTP gateway's reverse map
belongs to the other tab.

Fix: `tan.ts` filters resident-sourced frames off the trunk, both
directions (egress: never posted; ingress: dropped, in case an older
build shares the channel). Each tab talks only to its own residents —
identical services, so nothing is lost; the old "anycast quirk,
harmless" header note is rewritten to say what it turned out to be.
The `sleep 1; nslookup` priming line should now be unnecessary — field
check pending.

### 8c. ping rev 6: self-ping is loopback

Field: `ping mouse` FROM mouse fails. Necessarily: the switch never
echoes a frame to the port that sent it, the TAN proxy deliberately
never answers who-has for the asking tab's own octet, and ktcp sits
behind the same NIC — nothing may answer a self-ARP. Rev 6
short-circuits a self-target to loopback before the NIC is even
opened: no ARP, no wire, honest ~0 ms elapsed times — and it works
with ktcp running, the one ping that always can. The in-VM probe now
runs `./ping 10.0.2.42 2` against its stamped LOCALIP as its own
stage.

### 8d. The default network script restores ping from the drive (Jonathan's design)

`SEED_BOOT_SCRIPT` (seedRev 2): mount `/dev/hdb` OVER `/tmp` — the
drive becomes a persistent /tmp, so the installer's workshop survives
in place — and a `ping` binary found there is copied to `/bin` on
every boot. No network, no compile. Recorded limitation: the fast copy
cannot rev-check (a static seed can't know the current rev); a stale
drive keeps its old ping until the installer script is re-run, which
purges by marker. With no drive attached both probe lines fail quietly.

### 8e. Decided: no rev 7 (deterministic-MAC fallback) — ping stays as is

Field, 2026-07-15, after `ping elk` lost the frame race to a running
ktcp (one ARP reply per ask vs ping-cat's two — the proxy doubles
tab-to-tab's odds): a derived-MAC fallback was sketched and REJECTED.
Jonathan: "ping is really a vanity 'we are unix' toy in this context."
`net stop` remains the documented reliable mode; the tool's own error
text teaches it. Consolidation principle applied — polish budget goes
to the editor handover, not the toy.
