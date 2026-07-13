# Agent Bridge Report — Phase 14 M2.5

**Date:** 2026-07-13
**Brief:** `emu86-phase14-brief.md` M2.5 (Jonathan's idea, proposed and executed in-session the same afternoon)
**Outcome:** ✅ An agent can now drive the browser-hosted emulator over plain HTTP. Verified live end-to-end: a `curl` POST from the working terminal typed a command into the xterm of Jonathan's open browser tab; the ELKS shell executed it; the output came back via a `curl` GET. Zero new dependencies. **En route, M2.5's first >16-character injection exposed and fixed a silent input-truncation bug affecting every paste into the browser terminal since Phase 9.**

---

## 1. The API

With `npm run dev:browser` running and the page open in any browser:

```
POST /agent/rx           body = keystrokes (include the trailing \n)
GET  /agent/transcript   cumulative UART output, text/plain
```

Live verification transcript (this session):

```
$ curl -d $'echo agent-bridge-ok $((6*7))\n' localhost:5173/agent/rx
sent 30 chars
$ curl -s localhost:5173/agent/transcript | tail -4
# echo agent-bridge-ok $((6*7))
6*7: not found
agent-bridge-ok
#
```

(The `6*7: not found` is ELKS ash predating `$((…))` — the guest being authentically 1990s, not a bridge defect.)

## 2. How it works

Transport is the dev server's **existing HMR WebSocket** — Vite plugins can carry custom events over it, so no `ws` package and no second server:

- `vite.config.ts` — inline `emu86AgentBridge()` plugin (`apply: 'serve'`, so it does not exist in production builds): accumulates `emu86:tx` events into a capped in-memory transcript (1 MB, halved on overflow); `POST /agent/rx` (64 KB body cap) broadcasts an `emu86:rx` event; `GET /agent/transcript` serves the text.
- `web/main.ts` — inside `if (import.meta.hot)` (dev-only; production builds tree-shake the whole block): mirrors worker `tx` bytes up as `emu86:tx`, injects `emu86:rx` payloads as worker keystrokes. UTF-8 text pipe by design — binary extraction stays on the probe-harness path (M1).

Caveats, documented in the plugin header: one transcript per dev server (multiple open tabs would interleave), and input goes to every connected tab — keep one tab.

## 3. The bug it flushed out: input bursts silently truncated at 16 bytes

First bridge test: `# echo agent-bridg` — **exactly 16 characters** of a 30-character command arrived. Root cause chain (each step verified in code):

1. `WorkerHost.#drainRx` shoved the entire queued input into the UART in one batch.
2. The 16550's RX FIFO holds 16 bytes; `injectByte` on a full FIFO **drops** the byte with real overrun semantics (`uart-16550.ts:331-345`) — and in non-FIFO mode (guest hasn't written FCR yet) the holding register holds ONE byte and gets **overwritten**.
3. Human typing through xterm never exceeds the FIFO between batches, which is why five phases of browser use never noticed. Any **paste** into the terminal had been silently truncated since Phase 9 — the bridge just made it reproducible.

**Fix (`worker-host.ts:#drainRx`):** capacity-aware pacing — at most 12 bytes in flight when the FIFO is enabled (the probe harness's established margin), 1 byte in non-FIFO mode, remainder stays queued in `BrowserConsole` for subsequent batches. Two regression tests pin both modes (`bootopts-patch.test.ts`, RX-pacing describe block: FIFO-enabled burst leaves exactly 12 pending; non-FIFO burst leaves exactly 1, unoverwritten).

The probe harness was never affected (it already paced at 12 with drain windows); `tools/elks/run-serial.ts` feeds per-keystroke and is likewise safe in practice.

## 4. Changes

| File | Change |
|---|---|
| `vite.config.ts` | `emu86AgentBridge()` inline plugin (serve-only) |
| `web/main.ts` | dev-only HMR bridge block + `vite/client` type reference |
| `src/browser/worker-host.ts` | capacity-aware RX pacing in `#drainRx` (the paste-truncation fix) |
| `tests/unit/bootopts-patch.test.ts` | +2 RX-pacing regression tests (10 total in file) |
| `dist-cli/`, `dist-web/` | regenerated |

## 5. Deliberately not done

- **No auth on the endpoints** — they bind to the vite dev server (localhost by default). Anyone who can reach the dev server can drive the machine; that's the dev-mode threat model already accepted for HMR itself. Do not expose the dev server to a network you don't trust.
- **No binary channel** — text only; artifacts leave the guest via the M1 probe-disk path.
- **No transcript-since-offset / clear endpoints** — polling with `tail` semantics client-side is fine at this scale; add if agent usage gets chatty.
- **No production-build presence** — `apply: 'serve'` + `import.meta.hot` guard; verified the built `dist-web` bundles contain no bridge code by construction.

## 6. Use pattern for agents (this includes future me)

```bash
npm run dev:browser            # if not already running (needs a browser tab open on it)
curl -s localhost:5173/agent/transcript | tail -20     # where is the machine?
curl -d $'ls /usr/bin\n' localhost:5173/agent/rx       # type
sleep 2; curl -s localhost:5173/agent/transcript | tail -30   # read
```

Combined with M2's auto-serial-patch, this means an agent can hold an interactive session against `hd32-minix.img` — including driving `c86` builds by hand in the browser-hosted machine — while the human watches the same xterm live.

## 7. Test state

1,008 → **1,010 tests** expected (2 pacing regressions added); full-suite result recorded in the phase commit. Typecheck clean across all configs; dist rebuilds exercised cli+web emit paths.
