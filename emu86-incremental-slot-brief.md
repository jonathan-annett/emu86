# emu86 incremental-slot brief — the always-wins teardown capture

Drafted 2026-07-18, in-session, as the successor the tan-freeze
brief's §9/§10 recorded limits both point at. STATUS: **DRAFT — needs
Jonathan's ruling on D1/D2 below before any code.** Nothing here is
started.

## 0. The remaining hole, stated exactly

Fixes #8/#9 (tan-freeze brief §9–§10) got the teardown capture to
23 ms, couriered the death-point slot through any live peer, and made
un-couriered rewinds reset honestly in one second instead of rotting
for forty. What remains, recorded there verbatim:

1. **The whole-rack refresh has no catcher** — every page dies at
   once, so the courier has nobody to hand the slot to, and N
   sessions fall to the honest reset. Rack-internal telnet/Tetris
   dies on every rack F5, cleanly but always.
2. **Any lost race still costs the session.** ktcp cannot reconcile
   ANY rewind with data in flight (strictly in-order, never
   dup-ACKs); the fallback slot being ≤1.5 s stale bounds the loss,
   not the outcome.

The true guarantee — the reason this brief exists — is that the
death-point state must become durable WITHOUT depending on a
surviving page. Only one actor is still alive in every refresh
variant: the worker itself, for the few milliseconds the browser
takes to tear the realm down (fix #9 measured its broadcast escaping
in 4 ms; that window is real and repeatable).

## 1. D1 — the rule-3 exception: the worker writes IDB at teardown

Today `emu86-machines` is written by main only; the worker assembles
slots and hands them over (or broadcasts them, fix #9). Rule 3 (no
architectural changes) is why the courier exists at all — a
worker-side IDB write was recorded in §10 as "a rule-3 exception
only Jonathan can grant". This brief formally asks.

**Proposal (M1):** the worker opens `emu86-machines` itself and, at
teardown ONLY, `put()`s the same complete slot row it currently
broadcasts as the courier payload. Ordering: fire the IDB put AND
the courier broadcast concurrently; whichever lands, lands — the
row is idempotent (same stateId, same generation pair), so both
landing is harmless. Main's normal heartbeat path stays main-side
and untouched; this is a death-only write, ~one screen of code in
worker-host plus the store open.

- Why it's safe where the main-side write wasn't: the pagehide
  handler's postMessage reaches the worker (proven — fix #9 rides
  it); the worker's event loop keeps draining microtasks while the
  document dies, and an IDB put needs no reply to anyone.
- Honest unknown, measured in M3 not assumed: whether the put's
  TRANSACTION commits before realm teardown on this box's Chrome.
  If it loses sometimes, the courier still catches the single-tab
  case, and the rack case degrades to today's honest reset — the
  fix can only add durability, never subtract.
- The courier STAYS (D4 below rules on retiring it later, not now).

**M1 acceptance:** whole-rack F5 mid-Tetris (2 PCs, rack-internal
telnet) → both machines resume at the death point, session alive —
the §10-recorded gap, closed.

## 2. D2 — the incremental dirty-page slot proper (the eponymous
## milestone, and the second ruling)

M1 makes the death write POSSIBLE; keeping it comfortably inside the
teardown window forever means making it SMALL. The 640K RAM copy +
gzip is the bulk of the 23 ms; under a 4 MiB XMS machine (Phase 18
M3(a)) it will not stay 23 ms.

**Proposal (M2):** the slot becomes base + deltas. PagedMemory gains
per-page dirty bits (4 KiB pages, one Uint8Array flag per page, set
synchronously on write — cpu.step() stays pure sync, rule 1 intact;
this is a MEMORY-SUBSYSTEM change and that is why it needs the
ruling). The heartbeat writes only pages dirtied since the last
confirmed slot write (the fix-#4 pending-set pattern, applied to
RAM); the teardown write is then the residual delta — typically a
handful of pages — plus registers and device state. Restore folds
base + confirmed deltas + the death delta, refusing honestly on any
generation tear exactly as the fork rows do (fix #8's machinery,
reused shape-for-shape).

- Cost when idle: zero extra copies (clean pages never re-copy) —
  this also shrinks the steady-state heartbeat, today a full-RAM
  copy every 1.5 s during sessions.
- Cost per write: one flag store per memory write. The paced 4.77 MHz
  loop has headroom; measure in M2, revert-able by construction
  (flags unused = today's behavior).
- Deliberately NOT: no COW page snapshots, no worker threads, no
  change to what a slot MEANS (a complete machine at a moment) —
  only to how its bytes are stored.

## 3. Milestones

- **M1 — the death write** (needs D1): worker-side `emu86-machines`
  open + teardown put, concurrent with the courier. Tests: the store
  write path unit-tested worker-side; field = whole-rack F5.
- **M2 — dirty-page deltas** (needs D2): PagedMemory dirty bits,
  delta slot rows, fold-on-restore, generation-tear refusal. Full
  suite + the equivalence harness (the M1 LAW pairs) must stay green
  — a folded restore must be byte-identical to a full capture.
- **M3 — field acceptance:** single-tab F5 mid-Tetris (still wins),
  whole-rack F5 mid-Tetris (now wins), XMS 4 MiB machine F5 (stays
  inside the window), plus the §10 honest-reset path still firing
  for genuinely stale rows.

## 4. Decisions — Jonathan rules

- **D1**: grant the rule-3 exception — worker-side IDB write, death
  path only? (Recommended: yes; it is the only actor alive in the
  no-catcher case.)
- **D2**: PagedMemory dirty-page tracking (a memory-subsystem
  change)? (Recommended: yes, gated behind M1 landing first —
  M1 alone may already win every present-day race.)
- **D3**: page granularity + heartbeat cadence stay as proposed
  (4 KiB / 1.5 s-during-flows) or tuned?
- **D4**: once M1 is field-proven, does the courier retire, or stay
  as belt-and-braces? (Recommended: stays — it is proven, cheap,
  and covers an IDB layer that refuses to open.)
