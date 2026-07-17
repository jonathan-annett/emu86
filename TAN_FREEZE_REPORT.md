# TAN-freeze report — conntrack, the network freeze, tab-shark

Written 2026-07-17, the session that drafted and landed the whole
brief (`emu86-tan-freeze-brief.md`, approved in-session via plan-mode
review the same morning). All three milestones shipped; the field
pass is Jonathan's next move. Same session, before this line: field
fix #5 (the invaders cursor — sticky terminal modes across restore,
Phase 18 brief §8, commit 43dfae5).

## What landed

**M1 — conntrack (74888df).** `src/net/conntrack.ts` (TanConntrack)
taps the TAN trunk in both directions inside TabAreaNetwork — the one
point that carries exactly the inter-tab traffic (resident frames are
already filtered there). Timerless TCP accounting: SYN/SYN+ACK create
(initiator known even from a half-seen handshake), first plain
segment establishes, second FIN or RST retires, LRU cap 256. The
table is endpoint-neutral (the BroadcastChannel is a bus — third-party
flows arrive anyway), so one module serves the per-tab views
(`connectionsFor`, `hasPeer`) AND tab-shark's whole-network view
(`flows()`). The inspect popup gained an "open TAN connections"
section (peer name, ports, state, direction; "(none)" renders too).

**M2 — the network freeze (dc0bbcf).** pagehide's set-paused now says
`reason: 'teardown'`; the worker broadcasts a `freeze` control word on
the TAN channel when its conntrack shows open connections. Peers
self-select against their own tables, hold their CPUs with a 10 s
deadline checked in the paced loop's frozen turns (throttle-immune —
no setTimeout), and release on `thaw` or expiry. Thaw is broadcast on
bfcache revival and on the reload's restore outcome EITHER WAY —
success realigns clocks, refusal cold-boots and the fresh guest RSTs
stale flows dead. Everything surfaces: syslog + toasts on freeze,
return, and give-up.

**M3 — tab-shark (this commit).** `web/tabshark.html` + `tabshark.ts`
(+ `tabshark-decode.ts`, the DOM-free decoder): a passive analyzer
page at `/tabshark.html`, second Vite entry, served by both tiers with
no routing changes (the deploy worker serves dist-web verbatim).
Subscribes to `emu86-tan-v1` read-only — never posts, never claims an
octet, boots nothing (a transmitting observer would perturb the
network; a claim from a machineless page would burn an octet).
Renders the decoded frame log (ARP conversations, TCP ports/flags/len,
ping/pong, everything else by its numbers), the live connection table
(TanConntrack reused verbatim), the census chips (❄ while a member is
frozen), and the lease/freeze event log.

## Decisions and deviations

- **10 s freeze wait; popup + syslog visibility** — Jonathan's
  in-session rulings, recorded in the brief.
- **NO pruning on TAN claims** (deviation from the approved draft,
  brief M1 records it): a restored tab re-announces its claim at
  boot, so prune-on-claim would wipe the peer's live entries exactly
  when the session resumes — blinding the very next freeze decision.
  Dead-octet flows die by RST on first contact or fall off the LRU.
- **Pure ACKs never create flows.** The final ACK of a clean close
  would otherwise resurrect every finished connection as a ghost.
  DATA segments do create flows mid-stream — that rule is what
  rebuilds the restored tab's empty table from the first keystroke.
- **The dying tab needed nothing new for itself.** The 2026-07-16
  field fix already freezes it at pagehide before the capture; this
  line added only the peer-facing half.

## Verified (this session)

- Typecheck (all three configs) clean throughout.
- Unit: 9 conntrack + 7 tan-freeze + 6 tabshark-decode tests, plus a
  two-TabAreaNetwork hub test for the trunk tap and 2 new protocol
  exhaustiveness arms. Full suite after M2: **1,446 passed / 1
  skipped** (= 1,430 pre-line baseline + 16). Closing run with M3's
  decode tests: **1,452 passed / 1 skipped** — the line's baseline.
- Build: multi-entry `vite build` emits both index.html and
  tabshark.html (verified into a scratch outDir — the committed
  dist-web was deliberately not rebuilt; that belongs to the deploy).
- Dev server: /tabshark.html serves 200 with all modules resolving.

## NOT verified — the field pass (Jonathan)

The crown case end-to-end needs real guests: telnet mouse→cat, F5
mouse mid-session → cat freezes (toast) → mouse resumes → cat thaws →
the session keeps typing. Close-forever → cat gives up at 10 s.
bfcache back/forward → immediate thaw. tab-shark alongside showing
SYN → ESTABLISHED → freeze/thaw. None of this ran here — no browser
automation on this box, and the loop's freeze gate is exercised by
unit tests plus a fake clock, not by a live paced loop.

## Warts, recorded honestly

- A peer frozen ≥10 s in a HIDDEN tab may resume late: the paced
  loop's yield is unclamped, but a fully-throttled background tab
  still schedules macrotasks in bursts. The deadline check is
  monotonic so it can only over-wait, never under-wait.
- A flow whose two ends BOTH reload simultaneously freezes nobody
  usefully (each side's freeze lands after the other's capture) —
  both sides resume from their own slots and TCP reconciles by
  retransmission, exactly as before this line. No worse, sometimes
  better.
- tab-shark's census can't see members that have never spoken since
  the page opened (claims are not replayed) — it learns them from
  their first frame. A refresh of tab-shark forgets freeze state
  until the next control word.
- The inspect-popup wedge (a long inspection burns the peer's retry
  budget the same way a reload gap did) is recorded in the brief §4
  as a follow-on ruling, not built.

## Files

- `src/net/conntrack.ts`, `src/net/tan.ts` (tap + control words)
- `src/browser/protocol.ts`, `src/browser/worker-host.ts` (reason,
  freeze map, loop gate, thaw-on-restore)
- `web/main.ts` (pagehide reason, syslog surfacing),
  `web/inspect-panel.ts` (connection list)
- `web/tabshark.html`, `web/tabshark.ts`, `web/tabshark-decode.ts`,
  `vite.config.ts` (second entry)
- Tests: `tests/unit/conntrack.test.ts`, `tan-freeze.test.ts`,
  `tabshark-decode.test.ts`, `browser-protocol.test.ts` (2 arms)
