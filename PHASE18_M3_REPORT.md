# Phase 18 M3 — the clone: tab duplicate = frozen in amber

Written 2026-07-16, the session that landed field fix #4 (the torn
resume pair), §7 (the 0-stale capture), and XMS M3(a) earlier the
same evening. This is the phase's headline, built last per D1's
sequencing ruling. Code-complete and suite-gated; **field acceptance
is Jonathan's pass, still pending** — this report records what was
built, what was deliberately not, and what to watch in the field.

## 1. What shipped

Duplicating a tab (browser menu → Duplicate) now resumes the
PARENT'S LIVE MACHINE in the new tab instead of cold-booting:

1. **Detection** — the existing Web-Lock duplicate detect
   (overlay-session's origin 'duplicate') fires as before; nothing
   new listens for duplication.
2. **Identity first** (`session-store.mintSessionId`): the child
   remembers the inherited sessionId — that is precisely what NAMES
   its parent — then mints its own before anything keys off it.
   This also fixes a standing wart: a duplicate used to keep the
   parent's sessionId and the two tabs fought over one resume-slot
   row (last writer won; the loser's next F5 refused and cold-booted).
3. **Handshake** (`web/clone-session.ts`, D3(a)):
   `clone-request → clone-accepted → clone-ready{stateId}` over the
   `emu86-clone-v1` BroadcastChannel. Two timeouts, cold boot on any
   miss: 3 s for ACCEPT (is any parent alive), 20 s for READY (the
   parent is gzipping ~40 MB of disks). Every tab mounts the parent
   side; only the tab whose sessionId is named answers; concurrent
   children are served one at a time.
4. **Transport** — D3(a) exactly: the parent captures EMBEDDED
   through `persistEmbeddedCapture` (the named-save core, refactored
   out of `saveNamedState` — "one code path shared with save-states"
   was the decision's argument and it held), writes a
   `kind: 'clone'` row keyed `clone-<childSessionId>`, and
   broadcasts only the stateId. The child reads IDB, boots the
   embedded-restore carriage (shared with named restores via
   `applyEmbeddedRestore`), and deletes the row immediately — clone
   rows are one-shot couriers. A boot-time age sweep
   (`gcStaleCloneStates`, 1 h) is the backstop for handshakes that
   died between put and read.
5. **The restored screen** — the clone row carries the parent's
   terminal tail + scroll position like any save-state, so the new
   tab opens showing exactly what the parent showed at capture.

## 2. What was deliberately NOT done (recorded, accepted)

- **Network: D5(b) trunk-detached, verbatim.** The clone's guest
  RAM believes the parent's IP/hostname; its tab holds (or leases)
  a different TAN octet. No re-lease, no gratuitous ARP, no NAT
  work — the cable hangs loose until the user reboots the clone,
  which re-leases honestly. Same posture as a named-save restore
  today. The TAN redesign stays on the back burner (§3.5).
- **No reload-resume for the clone session.** An embedded-verbatim
  session can never reference-reconstruct (its boot disk is not
  base + fold), so the clone tab's F5 cold-boots until its first
  reboot — after which it is an ordinary tab in every way. The LED
  says so ("no reload-resume this session"). Recorded v1 wart;
  heals on reboot; the alternative (a reference-shaped clone rising
  from the child's copied overlay) was designed through and set
  aside — it adds a copy-vs-ack race for a wart a reboot cures.
- **The fork row starts one persist behind.** The child's
  drive-fork copy happens at its boot; the embedded snapshot's
  secondary bytes (newer, captured at request time) restore into
  RAM+disk, and the fork row converges on the first dirty persist
  (the degraded auto-persist path — embedded sessions skip the
  capture funnel). Consistent because nothing verifies an embedded
  session's fork row against anything.
- **Parent-side capture is the named-save flow**, gzip cost
  included (~1–3 s for the 32 MB HD + drive). The 'accepted'
  message exists so the child's syslog can say "waiting" honestly
  while that runs.

## 3. Verification

- `tests/unit/clone-session.test.ts` (8): happy path; no-parent
  timeout; accepted-but-hung timeout; fast-fail on capture error;
  wrong-parent ignored; two children serialized (never-interleaved
  gzips) each getting their own row; cross-child message isolation;
  parent unmount.
- `tests/unit/machine-store.test.ts` +1: the clone age sweep keeps
  fresh clones, named saves, and resume slots.
- Full suite green at commit time (count quoted in the commit).
- NOT verified here: the real two-tab browser flow — that is the
  field pass. Watch for: duplicate → parent syslog line ("snapshot
  served") → child opens on the parent's screen; a duplicate of a
  CLOSED parent cold-boots after ~3 s; duplicating mid-heavy-I/O.

## 3.5 Field find #1 (Jonathan, 2026-07-16, same evening): the clone
## ghost — FIXED

"if i dup mouse→cat then make a new pc dog, telnet from mouse to dog
fails as there are 2 machines trying to accept the ack reply ... if
close cat, mouse can telnet to dog." Exactly right: the restored
NIC's device state carries the CAPTURE's MAC (PAR registers ride the
M1 serialize pair) and the guest the capture's IP, and v1 attached
the clone's LAN to the TAN trunk anyway — so dog's replies to mouse
arrived at BOTH machines, and the clone's ktcp RST'd a connection it
never opened. My §2 claim that a stale identity was "effectively
detached" was falsified in the field within the hour.

Fix: D5(b) taken literally. An embedded restore (clone or named
save) LEASES its octet (defended, persisted, titled "(detached)")
but never bridges onto the trunk — `tan.attach` is skipped, the
tan-identity message carries `detached: true`, and the syslog says
the cable is unplugged and a reboot rejoins. The local LAN
(gateway/DNS/HTTP → real internet) still works; no frame crosses
between tabs. The reboot path re-attaches normally (regression test:
lease-but-never-attach, then reboot rejoins).

DHCP came up as the alternative (guest re-identifies itself): ruled
out by source inspection FOR OUR IMAGE'S VINTAGE — this ktcp has no
UDP layer at all (arp / icmp / ip / tcp only; the dhcpd man hits are
MINIX-heritage docs), so DHCP has no transport to ride. CORRECTED
2026-07-17, same evening: ghaerr reports upstream ELKS very recently
gained `ping` AND basic UDP in ktcp, "enough to support DHCP"
(discussion 2753). Receipts: PR #2692 (ping + ifconfig, June),
#2739 (the DHCP implementation — udp.c/dhcp.c in ktcp), #2740
(net.cfg refactor: DHCP is the FALLBACK whenever LOCALIP= is absent
from /bootopts or env). That last design fits us exactly: the TAN's
LOCALIP stamp keeps today's static behavior, and a future clone
re-identity is "reboot without the stamp, let the guest DHCP from an
elk responder". On a future image bump, that supersedes the recorded
interim path (guest-side ktcp restart with a fresh LOCALIP via the
control endpoint).

**DEFERRED (Jonathan, 2026-07-17): "we can do without it for now.
the dhcp might make cloned pcs easier, but i'm not sure how much
that is going to be useful for the editor project anyhow."** The
anchor stands: emu86 is a means to the huxley/lite editor end —
clone networking polish is off that critical path. No image bump,
no DHCP responder, until the editor project asks for it.

## 4. Findings for the record

- A duplicated tab shared its parent's sessionId from Phase 18 M2
  until now (§1.2) — resume-slot collision, degraded honestly by
  the digest refusal but wasteful. Fixed as a prerequisite, not a
  side effect: the handshake needs distinct identities anyway.
- The restore carriage refactor (`applyEmbeddedRestore`) fell out
  for free and the named-restore branch shrank to its syslog lines —
  D3(a)'s "one code path" argument was correct in both directions.
