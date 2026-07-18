# emu86 agent-cable brief — live console access for the agent

Drafted 2026-07-18 from Jonathan's ask, approved in-session ("sure,
go ahead and make a plan, maybe start the local host side of it
now"). Successor in spirit to the Phase 14 M2.5 agent bridge — which
still exists but lives INSIDE the vite dev server (HMR-websocket
transport, dev-server-only by construction) and therefore cannot
reach the machines Jonathan actually field-tests on the deployed dev
tier.

## 0. What this is, and what it is NOT

**The agent cable**: the deployed page dials OUT to a websocket on
the user's own localhost, where a dependency-free Node server gives
the agent a curl-friendly view of every connected machine's serial
console — read output live, inject keystrokes, list who's plugged
in. The direction inversion is the whole idea: the old bridge made
the dev server reach into the page; the cable makes any page
(localhost vite, dev tier, one day stable) reach out to the agent.

While Jonathan field-tests on emu86-dev, the agent can watch the
same telnet session his hands are in — or drive a repro end to end
without asking him to press Enter.

NOT: a remote-control protocol beyond console I/O + identity (no
freeze/capture verbs in v1 — recorded as possible growth), no
cloud transport ever (localhost-only by hard validation), no new
runtime dependencies on either side.

**Browser policy (checked):** `ws://localhost` from an HTTPS page is
exempt from mixed-content blocking (localhost is a potentially
trustworthy origin) — Chrome/Firefox allow it; newer Chrome may show
a one-click Local Network Access permission prompt; Safari blocks
(accepted — this is a dev tool for this box).

## 1. Milestones

### M1 — the localhost server (STARTED THIS SESSION; lives in
### tools/agent-cable/, deliberately outside the web build)

`tools/agent-cable/server.mjs`, plain Node ≥18, zero dependencies
(the websocket handshake is SHA-1 + base64 from node:crypto; frame
parse/build is ~150 lines — the zip-writer precedent). Binds
127.0.0.1 ONLY.

- **Websocket side** (`/cable`): browsers connect and speak JSON
  text frames — `{cable:'hello', name, octet, pc, build}` once, then
  `{cable:'tx', data:<base64>}` per console output chunk. Server →
  browser: `{cable:'rx', data:<base64>}` injects keystrokes.
- **Agent side** (same port, plain HTTP):
  - `GET /machines` — connected machines (id, name, octet, pc,
    build, connectedAt, buffered bytes);
  - `GET /console?from=<id>&since=<offset>` — the rolling console
    buffer (256 KiB/machine), with the next offset in a header for
    incremental tailing;
  - `POST /rx?to=<id>` — body bytes go to that machine's keyboard.
- Tested end-to-end in vitest using Node's built-in WebSocket client
  against a real server instance (ephemeral port): handshake,
  masked-frame parsing across chunk boundaries, hello/tx/rx round
  trip, buffer paging, machine listing, disconnect cleanup.
- Run: `node tools/agent-cable/server.mjs` (default port 8737).

### M2 — the page client (DONE 2026-07-18 — see AGENT_CABLE_REPORT.md)

- Settings gains "agent cable URL". HARD validation: only
  `ws://localhost[:port]/...` or `ws://127.0.0.1...` ever accepted —
  a deployed page must be impossible to talk into streaming a
  console anywhere but the user's own machine. Empty = off.
- main.ts, when set: open the socket, send hello (name/octet/?pc=,
  build stamp), bridge TX out and RX in through the exact paths the
  keyboard and terminal use; quiet exponential reconnect; syslog
  line + status on plug/unplug. Rack iframes dial in as themselves.
- Full suite + dev deploy per the standing rulings.

### M2.5 — the spawn verb (Jonathan's counter-proposal, 2026-07-18;
### DONE same session)

His first shape was guest-side (`urlget http://elk/?newtabpc` through
the M3d gateway); his counter — "or just do it as a websocket
command… over the reverse websocket channel" — is strictly better:
no guest changes, no gateway surgery, works on every tier. So:
`POST /spawn?to=<id>&kind=tab|rack` pushes `{cable:'spawn', kind}`
down the reverse channel; the page opens a sibling tab (`'tab'` —
may need popups allowed for the origin, no user gesture backs it) or
relays `{emu86:'spawn-pc'}` to its embedding rack (`'rack'` —
source-bound there; a standalone/floated PC logs the refusal
honestly). The new machine reads the same origin settings, so it
dials the cable itself and reports for duty — the agent can grow the
lab from one terminal.

### M3 — field acceptance

Jonathan tests on the dev tier with the cable set; the agent tails
`/console` live during a repro and injects a command; the rack shows
multiple machines on one cable server; the agent spawns a PC over
the cable and drives both ends of a telnet session.

## 2. Hard-rule notes

Rule 2 (no new deps): both sides dependency-free. Rule 1/3: no
machine or architecture changes — the client rides existing rx/tx
paths. Rule 6: the server tests join the suite; M2 is a shared-
surface change and gets the full gate.

## 3. Security posture (the one that matters here)

The ONLY permitted cable targets are loopback URLs, validated at the
setting, not at connect time. The server binds loopback and serves
no TLS (localhost is its trust boundary). No tokens in v1 — single
user, single box; recorded: a path token is a five-line addition if
the box ever becomes multi-user.

### M2.6 / M2.7 — proposed same session (Jonathan, during the ttt
### debugging loop; NOT yet built)

- **M2.6 — tab-shark on the cable**: the tab-shark page also dials
  ws://localhost, with verbs to CLEAR the capture and DOWNLOAD the
  export over HTTP — the agent stops needing a human ⬇ click per
  diagnostic round (this loop needed four). Same loopback-only
  trust story as the console cable.
- **M2.7 — a refresh verb per PC**: `POST /refresh?to=<id>` →
  `{cable:'refresh'}` → the page reloads itself — the agent can
  roll a fleet onto a fresh dev deploy without hands (reload-resume
  makes it safe by construction).
