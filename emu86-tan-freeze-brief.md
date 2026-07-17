# emu86 TAN-freeze brief — connection tracking, the network freeze, tab-shark

Drafted 2026-07-17 in-session from Jonathan's overnight idea, approved
in-session (plan-mode review). New scope, its own brief; Jonathan may
renumber it into the phase line. Ground-truth file:line references
were verified in source the same morning.

## 0. What this is, and what it is NOT

Three deliverables, one architecture:

1. **Conntrack** — the TAN currently just forwards ethernet frames;
   nothing knows whether mouse.tab has a telnet session open to cat.
   A small timerless TCP state machine at the trunk gives every tab a
   live table of its own inter-tab connections.
2. **The network freeze** — when a tab dies (F5), every peer with an
   open connection to it freezes its CPU until the dying tab resumes,
   capped at 10 seconds. Under the existing law ("frozen wall time
   never becomes guest time") the peer's TCP timers and application
   timeouts literally do not run during the gap — the reload becomes
   invisible to both TCP stacks.
3. **tab-shark** — a passive god-mode analyzer page for the TAN: the
   BroadcastChannel is a broadcast bus, so every inter-tab frame is
   already visible to any same-origin listener. Decoded frame log,
   live connection table, census, freeze/thaw events. Read-only by
   construction (never posts, never claims an octet, boots nothing).

What it is NOT: no UDP/ICMP tracking (ktcp is TCP-only on this LAN),
no freeze semantics for the inspect popup's indefinite holds (recorded
below as a follow-on ruling), no changes to cpu.step() purity, deps,
or architecture.

**Why now:** Phase 18 §7 recorded the boundary this deletes —
"active-flow sessions survive if the peer's retry budget outlasts the
reload gap." The 2026-07-16 field find already froze the DYING tab
before capture (the "refreshed quickly" telnet wedge); this brief adds
the peer-facing half.

## 1. Design settled by recon (verified in source 2026-07-17)

- **Worker self-freeze is precedented.** The paced loop gates the CPU
  on `#paused` (src/browser/worker-host.ts:819) and already self-stalls
  on in-flight DNS/gateway fetches (worker-host.ts:830) — skip pacer,
  yield, step nothing. Only the CPU clock gates; the message fabric
  stays live.
- **The dying tab already freezes itself.** `pagehide` sends
  `set-paused: true` then forces the teardown capture (web/main.ts:806);
  `pageshow` thaws (bfcache revival). pagehide fires only on real
  navigation/close — NEVER on tab switches. The visibilitychange-hidden
  capture (main.ts:789) fires on plain tab switches and must not
  trigger any peer freeze.
- **The trunk is the conntrack tap.** By construction only inter-tab
  traffic crosses it — resident gateway/DNS frames are filtered both
  directions (src/net/tan.ts header, the 2026-07-15 anycast fix). Peer
  identity is free: peer tab = host octet of the 10.0.2.X address,
  names via nameForOctet() (src/net/tan-names.ts).
- **Parsers exist.** parseIpv4 (src/net/wire.ts:129), TCP flag
  constants (wire.ts:243). The TAN envelope (frame/claim/here,
  tan.ts:93-116) extends naturally with control variants.
- **Worker-to-worker end to end.** The TAN channel lives in the worker
  (web/worker.ts:81); main's only role is surfacing syslog/toast events
  and the inspect popup list.
- **Timerless timeout.** The 10 s peer deadline is checked inside the
  paced loop's frozen turn — the loop keeps spinning on the unclamped
  MessageChannel yield, immune to hidden-tab timer throttling. No
  setTimeout.

Decisions taken in-session (Jonathan, 2026-07-17): peer freeze wait =
**10 seconds**; visibility = **inspect popup connection list +
syslog/toast events**.

## 2. Milestones

### M1 — conntrack + the connection list

New `src/net/conntrack.ts` (TanConntrack): observes raw frames in both
trunk directions; tracks TCP tuples (srcIP, srcPort, dstIP, dstPort)
via SYN / SYN+ACK / FIN / RST. Timerless (the tcp.ts precedent —
no clocks in the substrate): entries retire at RST or the second
FIN; a DATA segment on an unknown tuple creates the flow as
established (this carries a session across restore — the restored
tab's empty table rebuilds from the first keystroke; pure ACKs
deliberately create nothing, or every clean close's final ACK would
leave a ghost); LRU cap as a backstop against leaks. API:
`flows()` (endpoint-neutral, tab-shark's view), `connectionsFor(octet)`
(peer octet + name, ports, state, direction) and `hasPeer` /
`hasAnyPeerFor`.

**Correction found during M1 implementation (deviation from the
draft):** NO pruning on TAN claims. A restored tab re-announces its
claim at boot, so prune-on-claim would wipe the peer's live entries
at the exact moment the session resumes — blinding the next freeze
decision. Flows to genuinely dead octets die by RST on first contact
or fall off the LRU cap.

Wire into TabAreaNetwork at the trunk: outbound in the trunk-port
transmit, inbound in the channel frame path. Surface: the
`machine-inspected` reply (src/browser/protocol.ts:713) gains
`tanConnections`; the inspect popup (web/inspect-panel.ts) renders an
"open TAN connections" section. Unit tests with synthetic frames.

### M2 — the network freeze protocol

New TAN control messages `{tan:'freeze', octet}` / `{tan:'thaw', octet}`.

- **Dying side.** `set-paused` grows optional `reason: 'teardown'`
  (protocol.ts:376); main.ts:806 sends it. On teardown-pause with
  `hasAnyPeer()`, the worker broadcasts `freeze` with its octet and
  remembers it did. pageshow unpause → broadcast `thaw` (bfcache,
  symmetric). After a reload, the worker broadcasts `thaw` once the
  restore outcome is known — on success (clocks realign) AND on
  refusal/cold boot (the peer resumes; its stale connections die fast
  by honest RSTs from the rebooted guest). Inspect-popup pauses (no
  reason) never broadcast.
- **Peer side.** On `freeze`, each worker consults ITS OWN conntrack —
  self-selection: no trust in the sender, multi-peer for free. If
  involved: set a TAN-freeze flag (distinct from `#paused`; the loop
  gates on either) with deadline now + 10 000 ms, checked in the
  frozen turn. On matching `thaw` or expiry: clear, resume. RX and
  keystrokes queue during the freeze (fabric stays live).
- **Visibility.** New worker→main messages land in the syslog with
  toasts: "frozen: waiting for mouse (telnet :23) to reload" /
  "resumed: mouse is back" / "resumed: gave up after 10 s".

Tests: two TabAreaNetworks on a stub channel + scripted TCP exchange —
freeze self-selection, thaw release, deadline expiry, claim-pruning.
Full suite gates the commit (protocol/worker/net are shared surfaces).

### M3 — tab-shark

A separate minimal page (new vite entry: web/tabshark.html + .ts)
subscribing to `emu86-tan-v1` read-only. Renders: rolling decoded
frame log (time, src→dst by TAN name, proto/ports/flags/len — wire.ts
parsers), live connection table (TanConntrack reused verbatim),
membership census, freeze/thaw control events. Build wiring: second
vite input; confirm the deploy worker serves the extra asset.

## 3. Hard-rule notes

- Rule 1 untouched: conntrack observes in frame callbacks; the freeze
  is a loop gate — nothing async enters cpu.step().
- Rule 2: no new deps. Parsers and channel plumbing all exist.
- Rule 3: no architectural change — conntrack is a new leaf module;
  the loop gate composes with the existing pause.
- Rule 6 cadence: targeted tests per milestone; full suite for the
  M2 protocol commit and anything touching worker/protocol/net.

## 4. Recorded follow-ons (not in scope)

- **Inspect-popup freezes wedge peers the same way** — a long
  inspection burns the peer's retry budget exactly like a reload gap.
  The same protocol could hold peers, but indefinite holds need their
  own ruling (a popup can stay open for minutes).
- **tab-shark capture/export** (pcap-style download) if the field
  finds it wanted.

## 5. Field verification (the acceptance pass)

- M1: telnet mouse→cat on the dev tier; both inspect popups list the
  connection with correct peer names and ports.
- M2 the crown case: F5 mouse mid-telnet — cat freezes (toast), mouse
  resumes, cat thaws, the session continues as if nothing happened.
  Close-forever: cat resumes after 10 s, session dies the old honest
  way. bfcache back/forward: immediate thaw.
- M3: tab-shark open beside two machines shows the telnet SYN →
  ESTABLISHED → data → freeze/thaw live.
