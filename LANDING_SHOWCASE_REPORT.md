# Landing Showcase Report — the machine compiles "hello human"

**Date:** 2026-07-15
**Brief:** `emu86-phase14-brief.md` — landing showcase addendum
**Outcome:** ✅ The landing page is a two-act show. First visit boots the bundled floppy instantly while the 32 MB `hd32-minix.img` streams into the library in the background; when it lands, a **breaking-news banner** invites a refresh; the refresh boots ELKS from the hard disk and the demo boot script runs the machine's **own C toolchain** end-to-end, clackety-typed before your eyes — login, `net start ne0`, a heredoc'd C source, `cpp → c86 → as → ld`, then `./hello` prints **`hello human`**. Homage to the eldest sibling (retro.sophtwhere.com), whose DOS demo types into `debug`; this one types into a compiler. **Verified against a real ELKS boot: 23 s wall, greeting printed.**

## What was built

| Piece | File | Shape |
|---|---|---|
| Stage directives | `web/autoexec.ts` | `@type`/`@instant` (clackety vs whole-line), `@here`/`@end` (no-wait heredoc block — ELKS sh prompts `> ` for continuations, which the matcher rightly ignores), `@turbo`/`@authentic` (live speed change fired in script order). Scheduler + key-cadence injectable for deterministic tests |
| Keyboard FX | `web/keyfx.ts` | Per-keystroke WebAudio click (square-wave burst, jittered pitch, deep thock on space) — no assets, no deps; AudioContext resumes on first gesture, silent-but-watchable before |
| Demo script | `web/settings.ts` | `SEED_DEMO_SCRIPT` — the exact `/usr/src/Makefile` pipeline flags (HELLO_WORLD_COMPILE_REPORT.md), compiled in turbo, revealed in authentic |
| Orchestration | `web/main.ts` | First-run-only background HD fetch via `/gh-assets`, breaking-news banner, next-reload staging (re-checks that the user hasn't chosen their own machine/script meanwhile — their choice always wins) |
| Banner | `web/style.css` | Bottom-center chip: progress → glowing green news card with Refresh/dismiss |
| Tests | `tests/unit/autoexec.test.ts` (+6) | Directive behaviors + the lost-prompt race below |

## Findings (both from driving the real script against a real boot)

1. **A prompt can arrive inside the final keystroke delay.** After the newline commits a *fast* command, its whole reply (echo, output, fresh prompt) can land before the runner's last inter-key timer fires. The first cut cleared the buffer when typing *ended* — discarding the prompt the next step waited for, hanging the show forever. Fix: clear the buffer exactly **when the newline is sent** — drops our own pre-newline echo, keeps everything the command says after. Pinned by a regression test that reproduces the interleaving tick-by-tick.
2. **`@authentic` fired on send, not on completion.** Action steps chained immediately after a send, so the speed flip to authentic happened the instant the build command was *typed*, not when it *finished* — the compile would have run at authentic speed, defeating the turbo. Fix: after a send, chain onward only into a heredoc-body line; a following waited-command or speed-change waits for the command's prompt. So turbo genuinely covers `cpp`/`c86`/`as`/`ld` and authentic returns for the `./hello` reveal.
3. **ELKS `sh` supports both heredocs and backslash continuation** (probed live). Heredocs are the demo's source-injection device; backslash continuation is available if a future edit wants the long `c86` line typed as pretty multi-line instead of scroll-wrapping in 80 columns (left as-is for now — the wrap is momentary and the compile output scrolls past it).

## Timing

Full show ~23 s wall in Node against hd32-minix (turbo compile). The browser will differ with real pacing; the script flips to turbo for the build precisely so the compile doesn't drag at an authentic 4.77 MHz. Cadence and exact timing are the one thing best tuned live in a browser (the agent bridge can drive it) rather than asserted in a headless test.

## Not done / deliberate

- No forced autoplay: the show only runs when the demo script is the active boot script — the seeded default for a fresh profile, but never overriding a returning user's own choice. The download-and-stage path is first-run-only (bundled image source, no chosen script).
- Cadence/FX are seasoning: the whole show is fully watchable muted, and correct output does not depend on any timing.
- The demo script is an ordinary editable boot script — a curious user can open it in settings and read exactly what the machine is about to do to itself.

## Test state

1,119 → **1,125** (6 new autoexec cases). Typecheck clean; dist rebuilt. Live-verified end-to-end against hd32-minix.img.
