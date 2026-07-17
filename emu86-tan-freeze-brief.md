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

## 6. Addendum — the debug trace (field ask 2026-07-17)

Field (Jonathan, heading out to test telnet-restore bugs): "are you
able to include other logging items in tab shark, like when pc state
is frozen etc. this will help debug later."

Scope: a passive `emu86-debug-v1` channel. Every tab broadcasts its
lifecycle breadcrumbs (`web/debug-log.ts`, createDebugTrace):
freezes/thaws (TAN, inspect popup, rack commands), capture and
restore outcomes (including the deliberately-silent fresh resume and
every resume-slot heartbeat — "when was the last good capture?" is
the first question a torn restore asks), pagehide/pageshow/hidden,
migration steps, PLUS a mirror of every syslog line (anything a tab
tells its user, it tells the wire). tab-shark subscribes read-only
and renders traces in the event log with the sender named — one
merged, timestamped story across every involved tab.

Rules kept: nothing in the app ever LISTENS on the channel; no
behavior depends on a trace arriving; tracing failures are swallowed
(the trace must never break the machine it narrates).

## 7. Addendum — the diagnostic export (field ask 2026-07-18)

Field (Jonathan): "a button in tab shark which downloads a zip file
with all the events in a format you can analyze … since you are
already capturing the screen memory in indexedDb for each
hibernation this will give you a concrete view of what the resumed
pc was displaying … better for you to have the raw data, right?"
(This is §4's recorded pcap-style follow-on, asked for by name.)

Scope: an ⬇ export button producing one zip (dependency-free
STORE-only writer, web/zip.ts, validated against the real unzip):
- events.json — census, live flows, both rendered logs, counters,
  build stamp;
- frames.pcap — a 2,000-frame raw ring in classic pcap
  (LINKTYPE_ETHERNET), tcpdump/tshark-readable;
- states/ — every `emu86-machines` row (IDB is origin-global, so
  every tab's slots and saves): meta + capture provenance in
  states.json, and per state the stored terminal snapshot as
  terminal.bin (the byte-exact TX tail a restore replays — the
  "screen memory") and terminal.txt (escape-stripped for eyeballs).
Assembly is DOM-free (web/tabshark-export.ts) with an injected
state source; full machine RAM/disk payloads stay OUT of the export
(size — the meta says they exist and how big).

## 8. Field fix #7 — non-promiscuous residents (found via the §7
## export, 2026-07-18: the telnet-restore kill)

Field: "boot mouse, boot cat, telnet from mouse to cat, refresh,
press enter. connection is dropped." Diagnosed ENTIRELY from one
tab-shark export zip + the guests' screens + ktcp's source — no
paste-debugging.

**The kill chain (traced):** a reload-resume boots a FRESH worker:
empty switch CAM, empty resident ARP tables — but the restored
guest's warm ARP cache never asks again. Its first OUTBOUND segment
(the user's Enter) is unknown-unicast to the peer's MAC → the switch
floods it to every port, including the gateway resident. The gateway
had no destination-MAC filter, so the peer-bound frame fell into the
"routed traffic" arm and the HTTP gateway's TCP terminator answered
a mid-stream segment for a connection it didn't know: a RST wearing
THE PEER'S OWN ADDRESS, delivered locally (resident-sourced frames
never cross the trunk — invisible to tab-shark by design). ktcp
removes a connection on RST silently (tcp.c:143); the peer's real
ACK arrived 3 ms later to a dead connection, drew the observed
tcp_reject RST (win=1, the 1-byte dummy cb — the fingerprint that
cracked the case), killed the peer's cb, and telnetd's next read
printed "ktcp: panic in read".

**Why the freeze exposed it:** the M2 freeze holds the peer
perfectly still through the reload — nothing inbound re-teaches the
restored side's CAM, so the first post-restore packet is guaranteed
outbound, guaranteed flooded. (Pre-freeze, the peer's live
retransmits usually taught the CAM first, masking the hole.)

**Fix:** real-NIC semantics at both residents — gateway.ts and
dns.ts accept only their own MAC + broadcast (a non-promiscuous NIC
drops flooded unknown-unicast). Regression tests replay the exact
field frame through an empty-CAM switch. The clocks were verified
INNOCENT: ktcp's Now is kernel jiffies (paced, frozen-corrected on
both machines by the existing law).

**Recorded follow-on (Jonathan's design, this session): the RTC
nudge.** The MC146818 is the one real-wall-time leak in the paced
universe: after freezes/hibernation, `date` runs ahead of guest
uptime. Proposal: an accumulated nudge subtracted from RTC reads,
incremented by pause/hibernation time — and, once the conntrack
shows NO open connections, decayed back toward zero so the clock
re-approaches real time when nobody's TCP could notice. Not built;
needs its own scope.

## 9. Field fix #8 — the 0-stale teardown capture, for real
## (2026-07-18: "tetris really is a fuzzer")

Field: first telnet refresh survived (fix #7 confirmed); a refresh
MID-TETRIS died with ktcp's "tcp retrans: max retries exceeded". The
export's trace convicted in one line: "restore resumed ok (state
from 8s ago)" — the pagehide teardown capture lost the page-death
race AGAIN, the machine rewound 5.7 s while the frozen peer held the
death point, and ktcp (strictly in-order, never dup-ACKing) can't
reconcile a rewound sender: mutual retransmit exhaustion. The trace
also measured the cause: forced captures took 600–950 ms under
Tetris — the 8 MB drive snapshot + sha riding EVERY reference
capture, exactly the "v1 compromise" §7 recorded together with its
escalation. The field said the window is tight; this is that
escalation, landed:

- **Reference captures never touch the drive.** The worker slices
  only the unconfirmed sectors (the fix-#4 pending set) into the
  reply — delta-sized, never 8 MB — and posts the fork row's full
  snapshot AFTERWARDS as its own `fork-snapshot` message, killable
  by teardown without harm.
- **The fork row is pinned by GENERATION, not hash.** Every
  `updateImageBytes` stamps a uuid (out-of-band writers get a fresh
  mint, so an editor write-back honestly breaks the pin instead of
  silently corrupting a fold). The slot row records the confirmed
  generation its delta folds over PLUS the generation its own
  capture's fork write will stamp; restore accepts either (both tear
  arms reconstruct — the fold is idempotent over the newer bytes,
  the fix-#4 invariant). Anything else refuses honestly.
- **Transition** (the §7 precedent): secondarySha-era slot rows
  refuse once and are deleted; the next heartbeat writes a pinned
  row. The worker still honors old-style expected.secondarySha for
  named-save flows that keep full-image integrity.
- **Active-flow cadence** (the companion half): stats now carry the
  guest's open TAN flow count, and main tightens the heartbeat from
  5 s to 1.5 s while a session is live — the fallback slot, if the
  race is ever lost again, is at most ~1.5 s stale instead of ~6.

NOT fixed here, recorded: ktcp cannot reconcile ANY rewind while
data is in flight, however small — the true guarantee needs the
teardown capture to always win (the incremental dirty-page slot,
next brief) and until then a lost race mid-session still costs the
session, just with a much smaller window.
