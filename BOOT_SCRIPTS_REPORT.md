# Boot Scripts (autoexec) Report — Phase 14

**Date:** 2026-07-14
**Brief:** `emu86-phase14-brief.md` — "Boot scripts / autoexec" addendum
**Outcome:** ✅ Named, editable keystroke scripts typed into the console at boot. Jonathan's motive: "to speed up the testing" — the seeded example (`root` + `net start ne0`) puts a tab on the TAN hands-free. Chosen over the golden-overlay design for editability and size; overlays and the shared-IDB-"NAS" idea are recorded as back-burner entries in the brief.

## What was built

| Piece | File | Shape |
|---|---|---|
| Runner | `web/autoexec.ts` | Prompt-aware line injector: each line waits for `login:`/`Password:`/`# `/`$ `; `@expect <text>` waits for arbitrary output instead (e.g. ktcp's `ip 10.0.2.` line before a telnet). No timers — purely TX-event-driven; buffer resets per send so the triggering prompt can't double-fire; inert when exhausted. |
| Settings schema | `web/settings.ts` | `bootScripts: BootScript[]` + `activeBootScriptId` (null = silent boot, the default), per-field validation like the rest; dangling active ids degrade to null. One seeded example script, editable/deletable. |
| Wiring | `web/main.ts` | Runner fed from the same TX stream the terminal renders; sends via the ordinary rx path, so M2.5's UART FIFO pacing applies unchanged. Boot banner names the active script. |
| UI | `web/settings-modal.ts`, `web/style.css` | "Boot script" section: picker (None + named scripts, doubles as editor target), name/textarea editor with write-through persistence, New/Delete. Applies on next reload, like image-source changes. |
| Tests | `tests/unit/autoexec.test.ts` (9), settings tests extended (+1, fixtures updated) | Login flow, no-double-fire, split-chunk prompts, `@expect`, CRLF scripts, inert states. |

## Notes

- **Comments type harmlessly**: `#`-prefixed lines are sent verbatim — the ELKS shell ignores them — so scripts can carry annotations without runner syntax.
- The runner is main-thread and image-agnostic; images that boot straight to `# ` (test bootopts) and images that boot to `login: ` both work with the same script, since the first line releases on either prompt.
- **Field-verified on the live site** (Jonathan, 2026-07-14, deployed as version `e01ba0bd`): "worked first time" — image fetched through the /gh-assets proxy, boot script logged in and joined the TAN unattended. The runner's contract is additionally pinned by unit tests against real ELKS prompt strings.
- **Emergent nicety, field-found (Jonathan, same evening): the browser's "Duplicate tab" is an instant new PC.** The duplicate re-runs the boot flow, the TAN lease assigns a fresh 10.0.2.x octet and MAC, and the active boot script joins it to the LAN — one gesture from "machine I'm looking at" to "second machine I can telnet into." No code made this happen on purpose; the lease + autoexec composition did.

## Test state

1,083 → **1,093** (9 autoexec + 1 settings). Typecheck clean across configs; `dist-web` rebuilt.
