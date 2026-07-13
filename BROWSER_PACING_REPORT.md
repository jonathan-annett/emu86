# Browser Pacing Report — real-time clock, authentic cap, turbo

**Date:** 2026-07-14/15
**Brief:** `emu86-phase14-brief.md` — "Pacing / real-time clock" addendum (approved plan)
**Outcome:** ✅ Guest time is wall time in the browser. The worker's run loop now drives the virtual clock from host elapsed time at 4,772.7 cycles/ms instead of instruction count, in both directions: a starved CPU no longer slows the guest's clocks (games were running at a fraction of speed), and an idle CPU no longer races them (Jonathan's field find: **`sleep 30` completed in ~1 wall second** — halt spins were advancing virtual time ~30× faster than wall). CPU speed is capped at an authentic 4.77 MHz with a live **turbo** toggle in the settings modal for in-VM compile workloads. Only the CPU is governed — the network fabric stays event-driven and unclocked throughout, per Jonathan's explicit principle.

## 1. What was built

| Piece | File | Shape |
|---|---|---|
| Pacer | `src/browser/pacing.ts` | `RealTimePacer`: wall-ms → whole cycles with fractional carry; catch-up capped at 100 ms (throttled tabs fall behind wall instead of fast-forwarding jiffies); `advanceClock` slices ≤10,000 cycles per `clock.advance` call — the PIT fires at most one rising edge per advance (`pit.ts:43`), so unsliced catch-up would silently lose timer ticks; `skip()` resets the baseline (DNS stall); authentic/turbo instruction budgeting |
| Paced run loop | `src/browser/worker-host.ts` | `#runPacedLoop` replaces the instruction-paced autoRun loop: per turn — drain RX, cycles due, execute `min(adaptiveBatch, budget)` instructions, advance clock by elapsed, flush TX, yield. Idle (HLT + IF) is legitimate, no halt-spin bail; HLT with IF clear = dead machine → `halted`. Adaptive batch targets ~4 ms/turn within [2k..250k]. `runUntil` keeps its instruction-paced semantics — every existing test untouched |
| Yield | `worker-host.ts` | In a real web worker: MessageChannel ping (unclamped; immune to background-tab timer throttling — TAN servers in hidden tabs stay live). In Node: `setTimeout(0)` (see finding §3.2) |
| Protocol | `src/browser/protocol.ts` | `BootConfig.cpuSpeed`; `set-speed` (main→worker, live); `stats` (worker→main, ~1/sec: instr/s, cycles/s, ratio to 4.77M, mode, batch) |
| Settings/UI | `web/settings.ts`, `web/settings-modal.ts`, `web/main.ts` | `cpuSpeed` setting (authentic default); "CPU speed" section applying live via `set-speed`; stats to `console.debug` and mirrored to the dev bridge |
| Dev telemetry | `vite.config.ts` | `GET /agent/stats` returns the latest stats JSON (scriptable measurement, `/agent/transcript` pattern) |
| Tests | `tests/unit/pacing.test.ts` (9), `tests/unit/worker-host-pacing.test.ts` (2), protocol/settings updates | Fake-time pacer contracts; paced loop: virtual time tracks fake wall time exactly (47,727 cycles for 10 ms) and freezes with it; live turbo switch visible in stats |

## 2. Measurements

- **Node, real ELKS boot workload** (hd32-minix, 20M instructions, legacy 1:1 pacing, this box): **2,430,661 instr/s = 50.9 % of a real 4.77 MHz 8086.** This is the pure-TS-vs-WASM anchor number huxley/lite wanted: on desktop-class hardware, an un-optimized pure-TS interpreter delivers about half an authentic XT — and with honest pacing, *the guest cannot tell* except by running CPU-bound code slower; all clocks are true.
- **Browser instr/s: pending field run** — the worker posts stats every second; read them from the console or `curl localhost:5173/agent/stats` with a dev tab open. To be recorded here after Jonathan's session (before/after comparison needs the old build's number, which no longer exists to measure — the after number and the ratio-to-real-time are the meaningful ones).

## 3. Findings

1. **The PIT edge-dedup constraint is load-bearing for any host-paced design.** `pit.ts` fires at most one rising edge per `clock.advance` regardless of span. Host pacing without slicing would lose most timer ticks during catch-up (100 ms = 10 jiffies = 9 lost). Sliced at 10,000 cycles, no advance can span two edges of any divisor ≥ 2,500 input ticks — ELKS's 11,932 clears that comfortably. Slicing lives caller-side in the pacer; the PIT is untouched.
2. **A continuously ping-ponging MessageChannel wedges vitest.** With the MessageChannel yield active under vitest (thread AND fork pools), the run hangs with no output at all — tests complete (breadcrumbs prove it) but the worker never tears down. Bare Node runs the identical loop perfectly. Resolution: the unclamped MessageChannel path activates only in a real dedicated worker (`importScripts` discriminator); Node/tests use `setTimeout(0)`, which Node doesn't clamp meaningfully. Consequence, stated honestly: **the MessageChannel yield is field-verified only, not unit-tested.**
3. **A paced loop that outlives its test wedges the suite** — a failing assertion before the reset left the loop spinning forever and vitest hanging silently. The paced-loop tests now stop their hosts in `finally`, documented in the test header for the next author.
4. **The DNS stall is now belt-and-braces, not load-bearing.** With honest time, the guest's 2-second resolver alarm means 2 real seconds — most DoH fetches fit. The stall stays (a slow fetch still shouldn't burn guest time), and `pacer.skip()` keeps stalled wall time out of the guest clock.
5. **Fake-frozen time + turbo grows the adaptive batch to its cap** (stepMs always reads 0). Harmless in production (real time never freezes); noted for test authors.

## 4. Deliberately not done

- CLI (`tools/elks/run-serial.ts`) pacing, visible stats overlay, PIT multi-edge semantics, reduced-duty background mode — all out of scope per the plan.
- No attempt to make instruction-paced integration tests real-time — they deliberately keep virtual time fast (a 30 s guest `sleep` in a test SHOULD take milliseconds).

## 5. Field acceptance (on the DEV deploy tier)

1. ✅ **`sleep 30` takes 30 wall seconds** — field-verified (Jonathan, 2026-07-15, emu86-dev tier): "i can confirm that 30 seconds is 30 seconds." The idle direction (previously ~1 wall second) is fixed.
2. invaders/tetris over TAN telnet run at proper speed (the busy direction).
3. First-try `nslookup` still works (stall + pacing compose).
4. Turbo toggle visibly speeds an in-VM `c86` compile, and games slow back down when returned to authentic.
5. `/agent/stats` numbers recorded into §2.

## 6. Test state

1,101 → **1,112** (9 pacer + 2 paced-loop; settings/protocol fixtures updated). Typecheck clean across all configs; `dist-web`/`dist-cli` regenerated. Deploy tier for field testing: `npm run deploy:dev` → emu86-dev.jonathan-max-annett.workers.dev; promote to 8086-tab.net with `npm run deploy:prod` only after acceptance.
