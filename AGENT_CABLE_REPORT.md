# AGENT_CABLE_REPORT — live console access for the agent (M1 + M2)

2026-07-18. Brief: `emu86-agent-cable-brief.md` (approved in-session).
M1 landed in the previous session; M2 landed in this one. M3 (field
acceptance) is Jonathan's pass.

## What exists now

**M1 — the localhost server** (`tools/agent-cable/server.mjs`, prior
session): plain Node ≥18, zero dependencies, binds 127.0.0.1 only.
Browsers dial `ws:///cable` and speak JSON text frames (hello / tx);
the agent reads `GET /machines`, tails `GET /console?from=&since=`
(the `x-console-offset` header carries the next offset), and types
with `POST /rx?to=`. Run: `node tools/agent-cable/server.mjs`
(port 8737). Tested end-to-end in vitest against Node's built-in
WebSocket client (`tests/unit/agent-cable-server.test.ts`).

**M2 — the page client** (this session):

- `web/agent-cable.ts` — `isValidAgentCableUrl()` (the security
  boundary: `ws:` protocol, hostname `localhost` or `127.0.0.1`, no
  credentials — everything else refused, including `wss://`) and
  `plugAgentCable()` (dial, hello, base64 tx/rx bridging, exponential
  redial 1 s → 30 s cap resetting on success, `refreshIdentity()`,
  `unplug()`).
- Settings: `agentCableUrl: string | null` (default null = off),
  validated by the SAME predicate at save (modal refuses, shows why)
  and on load (hand-edited localStorage garbage loads as off).
  Additive field, no key bump — the v2-era rule bites only on
  semantic changes to existing fields.
- Settings modal: an "Agent cable" section (text input + refusal
  line) between Machine state and Storage usage. Applies LIVE — no
  reload: main.ts replugs off `settings-changed`.
- main.ts: the bridge rides the exact production paths — worker `tx`
  messages mirror to the cable; cable `rx` bytes go through the same
  `{type:'rx'}` postMessage the keyboard uses. Identity re-hellos
  when `tan-identity` settles (name + octet + `?pc=` + build stamp).
  Rack iframes read the same localStorage and dial in as themselves —
  no rack changes needed.
- `tests/unit/agent-cable-client.test.ts` — the validator matrix,
  plus the client plugged into a REAL M1 server instance: hello/tx/rx
  round trip, identity refresh, unplug-stays-gone, redial after a
  server restart, and quietness (transition-only status lines).

## Findings worth keeping

- **Node's undici WebSocket fires ONLY `error` on a refused dial —
  never `close`.** Browsers fire error then close. The client settles
  end-of-life on whichever arrives first, exactly once per socket;
  found by the client's own test, would have been an invisible
  never-reconnects bug in any Node-side consumer.
- Status lines are TRANSITION-only by design: one when the plug
  lands, one when an established connection drops, one single
  "nothing listening" per plug lifetime. A syslog that ticks every
  backoff would be worse than no cable.
- Console bytes produced while the cable is down are NOT buffered or
  replayed — deliberate; recorded in the module header.
- Deliberately NOT done (per brief): no freeze/capture verbs, no
  non-loopback transport ever, no tokens (single user, single box —
  a path token is a five-line addition if that changes).

## How the agent uses it

1. `node tools/agent-cable/server.mjs` (loopback:8737).
2. Jonathan sets `ws://localhost:8737/cable` in Settings → Agent
   cable on whatever tier he's testing (dev included — ws://localhost
   from HTTPS is mixed-content-exempt; Chrome may show one Local
   Network Access prompt; Safari blocks, accepted).
3. `curl -s 127.0.0.1:8737/machines`, then tail
   `/console?from=<name>&since=<offset>` and type with
   `POST /rx?to=<name>`.

## M2.5 — the spawn verb (same session)

Jonathan's counter-proposal to his own guest-side idea ("or just do
it as a websocket command… over the reverse websocket channel"):
`POST /spawn?to=&kind=tab|rack` → `{cable:'spawn', kind}` down the
socket → the page opens a sibling tab or relays `{emu86:'spawn-pc'}`
to its rack (source-bound). The spawned context reads the same
origin settings and dials the cable itself. Honest limits, syslogged
in place: 'tab' has no user gesture behind it (popups must be
allowed for the origin once); 'rack' from a standalone or floated PC
has no rack to relay to and says so. Tested both sides against the
real server (kind validation, 404s, push→onSpawn).
