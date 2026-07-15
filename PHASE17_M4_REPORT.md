# Phase 17 M4 Report — field acceptance, and the day's live fix loop

2026-07-15, evening. M4 was not a build milestone — it was Jonathan
field-testing the dev tier for hours while fixes shipped against his
one-line reports in real time. This report is the closing field
record the brief's M4 asked for. Verdict up front: **Phase 17 is
field-accepted end to end** — overlay (M1), fold+identity (M2), the
un-typed boot (M3), and everything the field pass shook out of them.

## 0. The verdicts, in the order they landed

- **M2, all five behaviors**: "all five behaviours check out" —
  persistent rm across reload, queued factory reset,
  duplicate-then-diverge, base-switch mismatch keep/discard,
  terminal focus. (Recorded same-day in PHASE17_M2_REPORT.md §4.)
- **Autologin, all three modes**: on = instant respawn as user1/root
  on `exit`; off = stock getty banner + login: prompt. Both
  confirmed correct in his transcripts.
- **Password durability**: a hash set in-guest survives via the
  overlay and gates the autologin line thereafter — §1.4's
  "pleasingly durable" observed live. Factory reset clears it.
- **setuid passwd + login**: "the passwd and login works."
- **The show**: "hello human works." — pure first pass, fresh
  profile, on the replay-hardened build.

## 1. What the field pass found and what shipped for it (same day)

1. **The keyboard runner fought the un-typed boot** ("i think the
   original keyboard runner is still there") → 160aaa8: the landing
   showcase stages the machine only (the HD's first boot IS the
   show); seeded scripts are skipped under autologin with an honest
   banner note; user-authored scripts untouched.
2. **passwd unusable as user1** (permission denied) → a1647fe:
   `chmod 4755 /bin/passwd` in the per-boot home.sh — passwd.c's own
   line-7 todo says setuid was always the intent; the binary already
   enforces own-password-only.
3. **No path to root under user1 autologin** (two nested-login
   probes: died at setgid, then at fchown — the first failure's SysV
   chown-giveaway had donated the tty to root) → ebe4ce6: setuid
   login = ELKS's su. `login root` → `#`, `exit` → back to `$`.
   Integration performs the actual nested login.
4. **The show replayed on a quick refresh** (his hunch; he then
   proved the mechanism himself — "i did the sync myself, it held")
   → 648340b: the seeded .profile syncs between consuming .welcome
   and emitting the marker, and main force-persists the fork the
   moment the marker arrives. Drives seeded by older builds keep the
   old .profile (seeds copy once) — noted, not chased.
5. **"emu86 gateway: TypeError: Failed to fetch"** (ipinfo.io/ vs
   /json) → ef6b233: a TypeError 502 now explains the likely-CORS
   refusal; other fetch errors pass through verbatim.
6. **The ping installer died under user1** (`net stop` couldn't kill
   root's ktcp — /dev/null wasn't even world-writable — so c86 hit
   the 640K wall) → his call: "just quietly add the executable to
   the overlay", echoing his §4.3 note. Delivered as a stamped
   /bin/ping: compiled ONCE in-VM by an env-gated generator
   (EMU86_PING_GEN=1; source planted pre-boot via minix-fs, no
   network, full RAM), extracted from the quiescent image, committed
   with provenance (16,572 bytes), stamped per-boot, execute bit +
   /dev/null + /dev/ne0 modes restored by home.sh. Present even
   after factory reset — part of the machine, like the serial
   console.

## 2. Observations recorded, deliberately not "fixed"

- **urlget needs `/?`** — its parser splits the authority only at
  `/`, so `http://elk?peers` resolves the whole string as a
  hostname. Canonical form works everywhere we ship. Filed with the
  parked upstream-ELKS patches (beside the urlget overflow and
  in_resolv signedness). His words: "no drama. just an observation."
- **Live ping keeps its net-stop dance** — ping.c opens /dev/ne0 raw
  and contends with ktcp by design (its own diagnostic says
  `try: net stop`, which now works from a `login root` shell).
- **`shutdown -r` reboot-trap**: designed (BIOS reset-vector
  re-entry → guest-reboot message → clean flush + reload; composes
  with ?mkdrive for scripted drive cycling; `hard_reset_now()` is
  `ljmp $0xFFFF,$0` after stamping the 0x1234 warm flag), then
  DROPPED on his word: "don't worry about the shutdown -r". The
  design lives here and in memory for whenever it earns its way
  back.
- **`cat /bootopts` lies** (M3 report finding, restated because the
  field will hit it): the serial patch is a raw block write the
  kernel reads whole; the inode still says 692 bytes, so fs reads
  show the pristine prefix. Probe behaviorally.

## 3. Where this leaves the phase

All four milestones done and field-accepted; dev tier carries the
full line (final build of the day: overlay + fold + un-typed boot +
the six fixes above), every deploy gated by the full suite per the
cadence ruling. **Stable promotion is Jonathan's call**, per
RELEASE_PROCEDURE.md (capture the outgoing version first).

Next-phase candidates on record, all gated on his word: EMBEDDING.md
(the Phase 16 M5 handover doc — recommended, it is what the
consolidation order points at), whole-machine state capture (brief
§3.5 — his own sequencing said "overlay first, then once proven";
it is proven now), boot-script system retirement (§4.6's end state —
genuinely unblocked, nothing automatic ships on keystroke injection
anymore).

The brief's §1.5 promise, verbatim, is now the observed daily loop:
reload → net up → /home mounted → `.profile` runs — the tab's drive
carries its own boot behavior, and the keyboard-injected seed script
is a demo prop.
