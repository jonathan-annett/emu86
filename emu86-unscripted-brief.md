# The un-scripted machine — brief (draft for Jonathan's review)

**Interim step landed 2026-07-17 (field ask, pre-promotion):** the
AUTOMATIC show is retired — no marker/.welcome seeding, no first-boot
performance, no show-boot net suppression (the XMS M3(b) question now
answers itself whenever someone plays the demo on a net-up machine).
The show plays from a one-shot ▶ button next to the gear
(settings.demoPlayed retires it forever). The browser typing relay
SURVIVES as the button's engine — M2/M3 below (slowtype, retiring the
relay) are unchanged in scope, just smaller: the relay now has exactly
one remaining customer.

Drafted 2026-07-16, mid Phase 18 M4 field loop, from Jonathan's
direction: "i was hoping to eliminate the concept of the browser
injected script entirely. i'm happy to implement a clipboard paste
feature, but i think having the original idea is sub-optimal. maybe
we can make a stdio pipe tool that injects sleeps?"

This finishes what Phase 17 §4.6 recorded as intent ("keystroke
injection to be retired entirely") — and the field find that
motivates doing it NOW: a machine state saved mid-show restores with
the typing dead, because the typist is main-thread choreography, not
guest RAM (Phase 18 field loop, 2026-07-16). Move the typist into the
guest and the seam closes by construction: a mid-show save resumes
typing exactly where it froze, like everything else.

## 0. What this is NOT

- Not a change to how humans type (xterm onData → paced RX, kept).
- Not a Phase 18 item — it queues behind the M4 field close. Listed
  here so scope lands before implementation, per process.
- The one-show-per-drive semantics (the .profile marker, self-consumed
  on the fork) are UNCHANGED — only who does the typing moves.

## 1. M1 — `slowtype`: a guest stdio pipe tool, in C

Reads stdin, writes stdout byte-at-a-time with typewriter pacing.
Sub-second sleep via `select(0, NULL, NULL, NULL, &tv)` — ktcp proves
select in-guest; fallback is a busy-loop calibrated to the paced
4.77 MHz (a demo tool may honestly burn demo-machine cycles).
Suggested knobs, all optional: `-c <ms>` per char (default ~35),
`-n <ms>` extra after newline (default ~350). Tiny — same size class
as the stamped ping.

Build/commit exactly like `/bin/ping`: the env-gated in-VM generator
(EMU86_SLOWTYPE_GEN=1) compiles it with the guest's own c86 inside a
booted machine and the binary is committed + stamped onto the image at
load time with the other M3 pieces.

## 2. M2 — the show goes native

The first-boot show becomes a plain guest script: for each demo step,
`slowtype` prints the command with typewriter pacing (the theatre),
then the script executes it for real (the substance). The .profile
marker stops being a relay trigger and becomes the script's own
launch. Result: zero host participation; the LED strip shows it as
plain CPU work; a mid-show save restores WITH the typing continuing
(the Phase 18 convergence — the typist is finally machine state).

Acceptance: fresh-profile show plays end to end with the browser
sending NO rx messages; freeze mid-show → save → restore → typing
resumes from the frozen character.

## 3. M3 — retire the browser script engine

Delete: AutoexecRunner, the show relay (maybeStartShow/showRunner),
the @type/@turbo grammar, the script key-click wiring. Settings
fields (`bootScripts`, `activeBootScriptId`) go PARSED-BUT-UNUSED for
an era — archived builds share this origin's localStorage (the
settings-versioning rule); actual field removal waits for a future
key-era bump. Report records what was deleted and what deliberately
lingers.

## 4. M4 — clipboard paste affordance (optional, small)

Paste already works: xterm delivers it through onData into the paced
RX path (the 16550-honest FIFO pacing absorbs bursts). This milestone
is only the affordance: a paste button (mobile/clipboard-permission
contexts), reading navigator.clipboard with the permission prompt,
feeding the same path. No "paste as typed" theatre unless Jonathan
asks — that would be `slowtype`'s job anyway, guest-side.

## 5. Open questions for Jonathan

- Q1: pacing defaults for slowtype (35 ms/char, 350 ms/line?) — will
  be field-tuned during his pass regardless.
- Q2: does the paste button rank into M4, or park it separately?
- Q3: timing — after the Phase 18 close (recommended), or interleaved?
