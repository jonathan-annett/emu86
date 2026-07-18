# emu86 multi-PC brief — the rack: one tab, many machines

Drafted 2026-07-17 from Jonathan's ask (same session that landed the
TAN-freeze line — this brief builds directly on it): "a page that
looks like a typical file explorer or email client where the left
hand list is tab names, and the folder or document view is a booted
pc … each pc lives in its iframe … pcs in separate tabs will have the
option to migrate … this will then let the multi pc tab be saved as a
single infrastructure package."

STATUS: APPROVED 2026-07-17 — Jonathan ruled all of §4 in-session:
D1 = **rack** (rack.html, "move to the rack"), D2 = **unchanged
chrome for v1**, D3 = **freeze-all → capture → resume**, D4 =
**one-way tab → rack** (eject is recorded, not built).

## 0. What this is, and what it is NOT

**The rack** (working name): a page with an explorer-style layout —
left rail of PC names (mouse, cat, dog…), main pane showing the
selected machine. Each PC is the EXISTING app in an iframe. A [+]
button adopts a saved, not-currently-running PC into the rail. A PC
running in its own tab can migrate into the rack (the tab is left
showing "this PC has moved"). The whole rack saves as one
infrastructure package.

NOT: a rewrite of main.ts into components (architecture rule), PC
renaming (names stay TAN names), drag-reorder/nesting, cross-machine
package export (that's the back-burner "IDB NAS" idea), or running
the same PC in two places (the octet lease and fork locks already
forbid it — that protection is load-bearing here).

## 1. Why this mostly already works (recon 2026-07-17, in source)

- **BroadcastChannel is same-origin, not same-tab**: every iframe
  joins `emu86-tan-v1` unchanged — the TAN, the clone channel, and
  the freeze protocol all span the rack automatically. Zero changes.
- **iframes receive pagehide when the top-level tab dies**: every
  embedded PC runs its normal teardown capture on rack close/F5, so
  THE WHOLE RACK SURVIVES A REFRESH via N ordinary reload-resumes.
  The M2 network freeze even bridges rack-internal connections
  through the gap.
- **Migration IS the reload-resume + network-freeze path**: a tab
  that navigates away fires pagehide — freeze broadcast + teardown
  capture, byte-identical to an F5. If the rack then boots an iframe
  that ADOPTS the dead tab's session record (sessionId → resume slot,
  octet, driveForkId, overlayId), the existing restore pipeline
  resumes the machine with its identity, drive, and open connections
  intact, and thaws its peers. The "moved" page is just where the old
  tab navigates instead of reloading.
- **Liveness for the [+] picker exists**: named saves live in
  `emu86-machines`; a closed tab's PC is its orphaned resume slot,
  and `resumeSlotLockName` Web Locks already distinguish live from
  dead (the GC uses exactly this).

**The one structural blocker**: `session-store.ts` keys everything
under ONE fixed sessionStorage key, and same-origin iframes SHARE the
top-level tab's sessionStorage. N embedded PCs would thrash one
session record (the collision self-healers would fire on every
switch, re-minting identities forever). Fix first, small: M0.

## 2. Milestones

### M0 — per-instance session namespace (the enabler)

`session-store.ts` learns an instance qualifier: a `?pc=<id>` query
param namespaces the storage key (`emu86.session.v1.<id>`; absent =
today's key, existing tabs unchanged). main.ts passes its own
`location.search` through. Every session-record consumer (octet
stickiness, fork, overlay, resume slot, queued restores) then works
per-iframe without modification — they only ever see "their" record.
Tests: namespaced round-trip, absent-param compatibility.

### M1 — the rack page

New vite entry `rack.html` + `rack.ts` (the tabshark pattern):

- Left rail + one iframe per PC (`/?pc=<instanceId>`), only the
  selected iframe visible (`display:none` hides the rest — their
  workers keep running; hidden-tab throttling does not apply to a
  visible tab's iframes, and the paced loop yields unclamped anyway).
- [+] opens the picker: **new blank PC + named saves** (label + age).
  Adopting a save writes the namespaced session record FIRST
  (`pendingRestoreStateId`), then creates the iframe — the existing
  boot path does the rest.
  **Correction found during M1 implementation:** dead tabs' resume
  slots are NOT adoptable — a reference slot reconstructs from the
  overlay store, and the sessionId→overlayId mapping lived in the
  dead tab's sessionStorage. The slot row carries no overlay
  reference, so orphaned slots stay what they are today: GC fodder.
  (Adding an overlayId to slot meta would enable it — recorded as a
  possible follow-on, not built.) Migration (M2) is unaffected: the
  live tab hands over its whole session record before dying.
- Rail identity/status: main.ts, when embedded (`?pc=` present),
  posts a tiny `{emu86: 'status', name, octet, state}` to
  window.parent on boot/identity/freeze events. The rack renders
  names and a running/frozen dot. (Chosen over polling the shared
  sessionStorage: same-tab writes fire no storage events, and honest
  push beats polling.)
- Focus follows selection (iframe.contentWindow.focus() + xterm's
  own focus funnel).
- The rack's own rail list persists in ITS session record — a rack
  F5 recreates the same iframes, each of which reload-resumes.

### M2 — migration ("move to rack")

- Discovery: the rack announces itself on a `emu86-rack-v1`
  BroadcastChannel; standalone tabs with a machine show a "move to
  the rack" affordance while at least one rack answers (no rack, no
  button).
- The move: the tab sends its full session record to the rack
  (adoption message), waits for the ack, then NAVIGATES to
  `moved.html` — a third static entry that says where the PC went
  (with a "reclaim" note: closing the rack strands nothing — the
  resume slot is adoptable again). pagehide does capture + freeze
  broadcast exactly as on F5.
- The rack, on ack: writes the adopted record under a fresh `?pc=`
  namespace, spawns the iframe, reload-resume runs, peers thaw. Open
  TAN sessions to other tabs ride through — the M2 field case, with
  the resume landing in an iframe instead of a tab.
- Refusal honesty: if the resume refuses (torn state), the iframe
  cold-boots with the adopted identity — same behavior as an F5
  refusal today; the rail entry survives either way.

### M3 — the infrastructure package

- Save: freeze every member (set-paused — the popup law, applied
  rack-wide), request a NAMED capture from each iframe in turn
  (embedded main.ts already has the named-save path; it gains a
  parent-message trigger), unfreeze, then write one package row:
  `{name, createdAt, members: [{pcId, label, stateId}]}` in a new
  `packages` store beside `emu86-machines` (same DB versioning
  pattern).
- Load: [+] grows a "packages" section; adopting one spawns every
  member via the M1 named-save path. Octets re-lease on boot — two
  racks loading the same package coexist by repick, exactly like
  duplicated tabs today.
- Explicitly recorded: a package references CAPTURED states — it is
  not live-synced to the rack afterwards; re-save to update. Delete
  = the row plus its member states (confirm dialog).

## 3. Hard-rule notes

- Rule 1–3 untouched: no cpu.step() changes, no deps (iframes,
  postMessage, Web Locks all exist), no architectural change — the
  app stays the app; the rack composes it.
- Rule 6 cadence: M0 touches session-store (shared) → full suite;
  M1/M2 touch main.ts + new pages → full suite at each milestone
  commit; M3 adds a store → full suite + the report.

## 4. Open decisions — Jonathan rules

- **D1 — name.** "rack" is the working name (rack.html, the rail =
  the rack). Alternatives: multipc.html, fleet, lab.
- **D2 — embedded chrome.** v1 embeds the app UNCHANGED (header and
  all) inside each iframe. Option: a `?pc=` iframe also trims header
  chrome via CSS (the rail already names the machine). Recommend:
  unchanged for v1, trim later if the field asks.
- **D3 — package save semantics.** Recommended (above): freeze-all →
  capture-each → resume (a coherent-enough package; in-flight frames
  reconcile by TCP on load, same law as single-PC capture).
  Alternative: capture without freezing (cheaper, more skew).
- **D4 — migration direction.** One-way (tab → rack) for v1;
  "eject back to a tab" is symmetric and cheap later (the same
  adoption dance, reversed) but NOT in this brief unless ruled in.

## 5. Field verification (the acceptance pass)

- Rack with two adopted PCs telnetting each other; rack F5 → both
  resume, session intact (the M2 freeze bridging rack-internal
  connections).
- Standalone mouse telnetting rack-resident cat; migrate mouse in;
  the session survives the move; the old tab shows "moved".
- Save package → close rack → fresh rack → load package → both
  machines back, TAN re-leased, tab-shark shows the traffic.
- The [+] picker refuses PCs whose lock is live (a running tab's PC
  cannot be adopted out from under it).

## 5b. Addendum — the ⏻ power-off (field ask 2026-07-18)

Field, after the first real rack session ("nice work on rack"): "we
might need a 'turn off' ie delete a pc button." This was §D4's
recorded eject wart; the field asked, so v1 lands: a per-row ⏻
(hover-visible) with a confirm. Removing the iframe fires pagehide
inside it (the machine runs its normal teardown, TAN peers get the
honest 10 s give-up if it had connections); the instance's session
record and resume slot are deleted proactively; named saves and the
drive fork persist (the orphan-fork GC owns unowned forks, exactly
as with a closed tab). Eject-to-tab remains out (D4, one-way v1).

## 5c. Addendum — rail selection focuses the terminal (field ask
## 2026-07-18)

"when selecting a pc using the selection list, the xterm in the
iframe needs focus." contentWindow.focus() only reaches the iframe
WINDOW; the terminal inside needs it explicitly. The rack now also
posts `{emu86:'focus'}` down the parent-command channel and embedded
main.ts answers with term.focus() — the same funnel every overlay
dismissal uses.

## 5d. Addendum — move a PC OUT: to a tab or its own window (field
## ask 2026-07-18; this RULES IN D4's recorded "eject back")

Jonathan: "add a way to move a pc back to either a tab or a floating
window. with the floating window, keep the pc in the list, but put a
placeholder button in the iframe view to restore the floating window
back into the iframe" (clarified same session: floating = a separate
browser window, not system z-order).

The out-move mirrors the M2 dance with the requester reversed —
durable capture FIRST, never pagehide-and-pray:

1. The rail row gains ⇲ (to a tab) and 🗗 (to a window). The click
   opens the spawn window SYNCHRONOUSLY (popup blockers honor the
   gesture) as a blank "moving…" placeholder, then asks the iframe
   to hand off: `{emu86:'handoff'}` → embedded main.ts runs the SAME
   freeze → durable-capture → freshness-gate dance mountMoveToRack
   runs, and answers `handoff-ready` with its session record (or
   `handoff-refused` and unfreezes; a 15 s dead-man unfreezes the
   machine if the requester dies mid-dance).
2. The rack writes the record to a one-shot localStorage mailbox
   (`emu86.handoff.v1`, nonce'd, 60 s shelf life), removes the
   iframe, waits for its Web Locks to clear (the adopt() pattern),
   then navigates the spawn window to `./?pc=<id>&claim=<nonce>`.
   main.ts claims the mailbox into its own sessionStorage BEFORE
   anything reads the session record, strips `claim` from the URL,
   and the ordinary reload-resume path does the rest. (The spawned
   context keeps `?pc=`; a top-level `?pc=` page was already legal —
   postRackStatus self-gates on `window.parent === window`.)
3. To a TAB: the PC leaves the rack — row and namespaced session
   record removed; the resume slot is KEPT (the machine lives on;
   contrast ⏻ power-off, which deletes it).
   To a WINDOW: the row stays; the pane shows a placeholder with a
   "bring it back" button; the popup is a NAMED window
   (`emu86-pc-<id>`), so a double-click can't fork two.
4. Bring-back = the same handoff aimed at the popup through its
   WindowProxy: ready → saveSessionAt(pc, record) over the rack's
   stale copy → rack closes the popup → locks clear → fresh iframe,
   same pc id, same rail row. A popup the user closed by hand is
   noticed (2 s poll) and restored from the rack's copy — the
   popup's own pagehide teardown updated the resume slot, and
   sessionId is the continuity anchor. Recorded wart: identity that
   drifted while floating (sticky octet, fork generation) heals by
   re-lease / the generation machinery's honest refusal — the same
   law as every other rewind.

## 5e. Addendum — 🦈 on every PC (field ask 2026-07-18)

"add a link on each pc to open a tab-shark tab (or if one exists, to
switch to it)." A 🦈 button on the PC page itself — so standalone
tabs, rack iframes and floated windows all carry it — opens
tab-shark in a shared NAMED window (`emu86-tabshark`). The
open-or-focus trick: `window.open('', name)` first; an existing
named window comes forward UN-reloaded (a reload would dump its
live capture buffer), and only a genuinely fresh blank window gets
navigated to tabshark.html. Name lookup spans the browsing-context
group, so every PC in one rack shares one shark; an unrelated
standalone tab starts its own — accepted.
