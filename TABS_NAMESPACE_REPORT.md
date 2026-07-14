# .tabs Namespace Report — Phase 15 M4

2026-07-14. Brief: `emu86-phase15-brief.md` §M4 (Jonathan's design,
drafted and approved in-session). Commit `978f105`.

## 0. TL;DR

Every tab on the Tab Area Network has a deterministic short animal name.
The first tab is **`mouse`**, the second **`cat`**, the third **`dog`**.
The gateway — invisible until now — is **`elk.tabs`** (ELK-S), and the
DNS pseudo-host is **`owl`**, because it looks things up. The browser tab
title *is* the name, so a row of open tabs reads like a neighbourhood
instead of a subnet dump.

Works: `nslookup cat.tabs`, `ping cat`, `ping cat.tabs`, `ping elk`.
Anything outside the namespace still falls through to DoH, so the real
web is untouched.

## 1. The crux: how `ping` resolves a name with no DNS

Jonathan flagged this as needing "clever coaxing". It needs none — and
the reason *is* the design:

**ping cannot use DNS.** The ELKS resolver speaks DNS-over-TCP through
ktcp (there is no UDP in the stack at all), and ktcp is precisely the
process that must not be running while ping owns the NIC. The one tool
that could resolve a name is the one thing ping requires you to shut
down.

**But the name is a pure function of the octet.** So ping doesn't ask
anyone — it carries the table compiled into it. `ping cat` is an array
lookup, not a network round trip.

That single property is what makes the whole feature cheap: one list
drives three consumers (the DNS host, the browser tab title, and the
guest tool), and each derives its answer without coordination.

## 2. What landed

- **`src/net/tan-names.ts`** — 184 names for octets 16..199 (the lease
  range), plus the fixed residents: `elk`/`gateway` → 10.0.2.2,
  `owl`/`dns` → 10.0.2.3. Accepts bare, qualified (`cat.tabs`), and
  mixed-case; rejects anything with further structure (`cat.example.com`
  is the internet's, not ours).
- **`src/net/tan.ts`** — a **`here` census**. Tabs used to pick a
  *random* free octet, which would have made the first tab `narwhal`.
  Now a settled tab answers any *other* tab's claim with `here <octet>`,
  so a newcomer learns the whole membership in one claim-wait and takes
  the **lowest free** octet. Bounded at two attempts regardless of how
  many tabs are open.
  - `here` is a distinct message type **on purpose**: it draws no reply.
    Answering a claim with another *claim* would have every tab
    re-announcing at every other tab's announcement, forever.
  - Sticky IPs unchanged: `cat` stays `cat` across reloads, and a
    *duplicated* tab correctly becomes the next animal.
- **`src/net/dns.ts`** — the `.tabs` zone answered locally and
  authoritatively (AA=1) before falling through to DoH. Synchronous, so
  it cannot lose to the guest's 2-second resolver alarm. Adds
  `parseQuestion` (the host's first question-side parsing) and
  `buildLocalAnswer`.
- **`web/guest/ping.c`** — the compiled-in table (rev 4).
- **`web/main.ts`** — `document.title = "cat.tabs — emu86"`.

## 3. Bugs found while building it

- **The AA bit that set and then unset itself.** `buildLocalAnswer`
  first reused `servfailFor`'s bit mask — which *clears* AA. It set the
  authoritative bit and then masked it straight back off. Caught by a
  test asserting AA=1.
- **A test that lied about a reload.** The sticky-name test left the old
  tab *live* on the hub, so it rightly defended its octet and the
  "reloaded" tab became `cat`. A reload means the old tab is **gone**;
  the test now closes its channel first. The failure was correct
  behaviour catching a badly-written test.

## 4. Drift guard (the load-bearing test)

`tests/unit/tan-names.test.ts` parses the `tab_names[]` initialiser out
of `web/guest/ping.c` and asserts it equals the TypeScript list exactly,
in order — plus the `TAB_OCTET_MIN` / `TAB_COUNT` defines.

If the two lists ever disagree, `ping cat` reaches a different machine
than `nslookup cat.tabs` says it should, and **nothing else would catch
it**. The C table also compiles in-VM with c86 (184 names and all,
verified by `elks-ping-invm`).

## 5. Not done

- **Tab-pings-tab in the browser is unverified.** The Node tests cover
  ping→gateway; two real tabs pinging each other by name (`ping cat` from
  `mouse`) is the demo this was built for and it has not been run.
- Names are per-lease, so a tab that closes frees its name for the next
  one. No attempt is made to keep a name "reserved" beyond the sticky-IP
  session store.
