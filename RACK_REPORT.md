# Rack report — one tab, many machines

Written 2026-07-17, the session that drafted the brief
(`emu86-multi-pc-brief.md`, approved in-session: rack / unchanged
chrome / freeze-all capture / one-way migration) and landed all four
milestones. Same session, earlier: the whole TAN-freeze line
(`TAN_FREEZE_REPORT.md`) — the rack composes directly on it — and
field fixes #5 (invaders cursor) and #6 (keyboard focus after
duplicate/restore, folded in mid-build from Jonathan's note).

## What landed

**M0 — per-instance session namespace.** Same-origin iframes share
the tab's sessionStorage, so `session-store.ts` learned `?pc=<id>`
key namespacing (`emu86.session.v1.<id>`; bare key without the param
— standalone tabs byte-for-byte unchanged) plus `loadSessionAt` /
`saveSessionAt` for the rack to address its iframes' records.

**M1 — the rack page.** `web/rack.html` + `rack.ts` (fifth vite
entry alongside tabshark): explorer layout, left rail, one iframe per
PC at `./?pc=<id>`, only the selected one visible — hidden PCs keep
running (workers are threads; the paced loop's yield is unclamped).
The [+] picker offers a new blank PC and every named save (adoption =
write `pendingRestoreStateId` into the fresh instance's record, spawn
the iframe — the app's own restore path does the rest). Embedded
main.ts posts `pc-status` to the parent (name, octet,
booting/running/frozen/halted) on identity/ready/halted/freeze/thaw;
the rack binds rows by message SOURCE, never by payload claim. The
rail persists in the rack's own `emu86.rack.v1` record, so a rack F5
recreates every iframe and each reload-resumes: THE WHOLE RACK
SURVIVES REFRESH via N ordinary resume slots, rack-internal telnet
sessions bridged by the TAN freeze.

**M2 — migration, tab → rack.** `web/migrate.ts` owns the tab side:
racks announce on `emu86-rack-v1` (open + every probe); the "move to
the rack ⇱" pill appears beside the gear only while a rack is
announcing (and never inside an iframe). The move is the F5 path
aimed elsewhere: freeze (set-paused reason 'teardown' — the TAN
freeze holds open connections), await a DURABLE slot row (the
`resumeCaptureSettled` refactor makes the capture chain awaitable;
F5 gets this from teardown grace, a live handover must wait), send
the whole session record, ack, clear the tab's own record, navigate
to `moved.html` (sixth entry — "this PC has moved"). The rack ACKs,
then spawns only after the dead document's Web Locks release
(navigator.locks.query poll, 5 s cap — all three names derivable
from the record: resume slot, overlay, fork), or the iframe's
session resolution would read "duplicate" and fork fresh identities
instead of resuming. Every abort path (no ack, refused, stale slot,
capture failure) unfreezes and reports; the record never leaves the
tab before the slot is proven fresh — a restored-from-named-save
session (which writes no reference slot) refuses the move honestly
with "needs a reboot first".

**M3 — infrastructure packages.** `web/package-store.ts`
(`emu86-packages` IDB, deliberately NOT a version bump of
emu86-machines): one manifest row per package — name, createdAt,
members as {label, stateId} pointers at named saves. Save (💾,
D3 ruling): freeze every member → capture each via a parent→iframe
`save-named` command (embedded main.ts answers with the stateId;
`saveNamedState` now returns it) → manifest LAST → unfreeze. An
interrupted save rolls members back and can only ever leave plain
named saves, never a dangling manifest. Load: the [+] picker's
"infrastructure packages" section spawns every member down the
named-save path. Delete: members first, manifest last, confirm
dialog.

## Warts and recorded honesty

- **Package-loaded PCs boot with a detached cable** until their first
  reboot — existing named-save restore semantics (the guest wears the
  capture's identity). A freshly loaded "two-node lab" needs each
  member rebooted before they can talk. Recorded, not fought — the
  reboot re-leases and rejoins, same as any named-save restore.
- **Dead tabs' resume slots are not adoptable** by [+] (brief M1
  correction): the sessionId→overlayId mapping died with the tab.
  Migration is unaffected — the live tab hands over its record.
- **prompt()/confirm() in rack v1** for package name and delete —
  deliberate minimal surface; the app's modal patterns can replace
  them if the field minds.
- The rack has no per-PC remove/eject affordance (D4: one-way v1);
  a mis-added PC can be F5'd away only by clearing the rail (its
  machine state survives in its slot/fork either way).
- The lock-release poll's 5 s cap falls back to spawning anyway; the
  overlay/fork self-healers then fork fresh identities (the machine
  still arrives, as a new PC rather than a resume — logged by the
  session modules).
- iframes are NOT sandboxed — they must be same-origin for
  sessionStorage/locks/channels to compose. Parent commands into an
  iframe are origin+source-gated on both sides.

## Verified (this session)

- Typecheck (all configs) clean throughout; six-entry vite build
  emits index/tabshark/rack/moved (+ worker chunks) — verified into a
  scratch outDir; dev server serves every entry 200 with modules
  resolving.
- Unit: 4 session-store instance tests (M0), 6 migrate-dance
  choreography tests (freeze→settle→request→ack ordering, abort paths
  all unfreezing, foreign-nonce immunity, rack forgetting on
  silence), 3 package-store tests. Suite baselines quoted per commit.
- NOT verified — the field pass: real iframes booting machines,
  rack F5 resume, a live migration with a telnet session riding
  through, package save/load round trip. No browser automation on
  this box; the composition arguments are traced in source and the
  protocol layers are unit-tested, but the end-to-end story needs
  eyes on dev.

## Files

- M0: `web/session-store.ts` + tests
- M1: `web/rack.html`, `web/rack.ts`, `web/main.ts` (pc-status,
  embedded detection), `vite.config.ts`
- M2: `web/migrate.ts` + tests, `web/moved.html`, `web/main.ts`
  (mover wiring, `resumeCaptureSettled`), `web/index.html` +
  `style.css` (the pill), rack.ts (adoption + lock poll)
- M3: `web/package-store.ts` + tests, rack.ts (save/load/delete),
  `web/main.ts` (parent commands, saveNamedState returns the id)

## Addenda §5d/§5e — the out-move + 🦈 (field asks 2026-07-18, same-day)

Jonathan's housekeeping asks, ruled in mid-session (this rules IN
D4's recorded "eject back"; brief §5d/§5e carry the full design):

- **⇲ / 🗗 on every rail row** — move a PC out to its own tab (it
  leaves the rack) or float it in its own window (it stays, the pane
  shows a "bring it back" placeholder; "floating" = a separate
  browser window, his clarification). The out-move mirrors the M2
  dance with the requester reversed: `{emu86:'handoff'}` →
  embedded main.ts runs the SAME freeze → durable-capture →
  freshness-gate sequence as mountMoveToRack → `handoff-ready`
  carries the record; only then is the iframe killed. The record
  reaches the spawned top-level context through a nonce'd one-shot
  localStorage mailbox (`emu86.handoff.v1`, 60 s TTL) claimed by
  main.ts BEFORE anything reads the session, because a new tab
  cannot read the rack's sessionStorage (the spec's session-storage
  copy on window.open exists but its timing against a
  blank-then-navigate spawn is not something to build on). The spawn
  window opens synchronously in the click — popup blockers honor the
  gesture, not the async dance. A 15 s dead-man in the PC unfreezes
  if the requester dies mid-move; a hand-closed floating window
  re-docks by itself (2 s poll; its pagehide teardown updated the
  slot, sessionId is the continuity anchor). Package save refuses
  while PCs float (their member capture would time out late).
  Recorded wart (brief §5d): identity drifted while floating heals
  by re-lease / honest refusal, the standing rewind law.
- **🦈 on every PC page** (standalone, iframe, floated alike): opens
  the shared NAMED tab-shark window, or brings it forward
  UN-reloaded (`window.open('', 'emu86-tabshark')` first — a reload
  would dump the capture buffer; only a genuinely fresh blank gets
  navigated).

Verified: typecheck clean; 4 new handoff-guard + 4 mailbox tests in
`tests/unit/migrate.test.ts` (one-shot claim, nonce mismatch burns
the row, TTL refusal, corrupt-mailbox survival). NOT verified, same
honesty as above: the real browser dance (spawn, claim, resume,
bring-back) needs the field pass on dev.

## Addendum §5f — the swapped-members package bug (field, 2026-07-18)

Loading a saved 2-PC rack sometimes swapped mouse/cat (and killed
telnet: unanswerable ARP for the swapped address). Root cause: the
package members' fresh PCs raced the TAN lease unseeded. Fix: the
manifest now records each member's octet and loadPackage seeds it as
the sticky lease ask. Pre-fix packages carry no octets — re-save the
package once to pin the pairing. Full diagnosis in brief §5f.

Field fix, same day: a ⇲-moved-out tab had no way back — the M2
mover was gated on ?pc=-absent, which §5d's moved-out tabs fail by
design, and its clearOwnSession cleared the bare key instead of the
ambient one. Gate is now top-level + not-a-float (window name);
the button reads "move to the rack" unchanged and works from bare
and ?pc= tabs alike.

## §5g — the pull model landed (same day)

Racks adopt; PCs are rack-agnostic. The [+] picker probes
(`pc-probe`), standalone PCs answer with identity cards
(`pc-here`: sessionId, name, octet, state), and picking a gold row
invites exactly that PC (`adopt-invite`) — which then runs the
unchanged M2 choreography aimed at the inviting rack. The per-tab
"move to the rack" button and the whole rack-discovery half of the
protocol ('here'/'probe', the racks Set, first-answerer targeting)
are RETIRED — including today's own move-back gate fix, alive for
about an hour. Multi-rack ambiguity is dissolved structurally: the
rack you clicked in is the answer.

Picker identities per Jonathan's spec: running = gold rows with a
breathing (running) or held (frozen) dot; cold storage (packages +
saved machines) = blue, on ice; "boot a new PC" = plain grey button.
Cross-era note: archived builds still probe for racks on this
channel and now go unanswered — their button stays hidden, which is
the retirement behaving; their adopt-request path was only reachable
from that button, so no half-era dances can start. main.ts also now
tracks machine state while standalone (rackStatus updated always,
posted only when embedded) so identity cards say running vs frozen
honestly. Choreography tests rewritten invite-driven (13 pass);
cross-rack poaching stays out, recorded as a §5d-based follow-on.
