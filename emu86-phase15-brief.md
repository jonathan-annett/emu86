# emu86 — Agent Brief: Phase 15 — The Machine Reaches Out (M3d gateway → virtual drives → ktcp-ping)

Status: **APPROVED** (drafted in-session 2026-07-14 from three
parallel scoping reads; Jonathan approved in-session same day —
"lets go"). This is the living plan. Ordering is his: M3d first,
then virtual drives, then ping.

## TL;DR

Phase 14 gave the machine a LAN, DNS, and an in-VM toolchain. Phase 15
is three milestones that each grow one of those into something bigger:

1. **M1 — M3d: TCP termination for arbitrary destinations + HTTP
   gateway.** The guest fetches real web pages: `urlget
   http://example.com/` works. Grows `src/net/tcp.ts` (the M3c
   listener engine) into a promiscuous terminator at the gateway, plus
   an HTTP pseudo-host that turns terminated connections into
   `fetch()` calls.
2. **M2 — Virtual drives v1: `/dev/hdb` persistence.** A "create
   blank image" button in the library + write-back persistence for the
   secondary disk slot. `mkfs /dev/hdb 8192 && mount /dev/hdb /mnt`
   gives a per-browser persistent drive. The secondary slot has been
   fully plumbed since Phase 11 — this is almost entirely `web/`-layer
   work.
3. **M3 — ktcp-ping: the dogfooding milestone.** A real `ping` for
   ELKS — a ~100-line NS_PING patch to ktcp plus a ~150-line
   `ping.c` netconf client, **both compiled in-VM with c86**.
   Acceptance: `ping 10.0.2.2` and tab-pings-tab across the TAN with
   honest RTTs.

**Standing constraint (Jonathan, 2026-07-14): all bleeding-edge field
testing happens on the dev worker tier**
(`emu86-dev.jonathan-max-annett.workers.dev`, `npm run deploy:dev`).
The stable domain (8086-tab.net) moves only when Jonathan explicitly
promotes with `npm run deploy:prod`. Nothing in this phase touches
stable by default. Deploys remain permission-gated — Jonathan runs
them.

## Hard rules

1. **Don't break existing tests.** Baseline 1,126 passing as of the
   pacing/RTC session (run the full suite first — the last formal
   green run predates the small autoexec onDone change).
2. **`cpu.step()` stays pure synchronous.** Locked.
3. **No custom CPU opcodes.** Locked.
4. **Strict TypeScript.** No `any`, no `as unknown as`,
   `noUncheckedIndexedAccess` stays on.
5. **No new dependencies.** Browser platform APIs (IndexedDB, Web
   Locks) are fine; packages are not.
6. **Net tests inherit the recorded gotchas:** promise completions
   reach the guest only at run-batch boundaries — Node tests batch
   small (~20k instr) and flush microtasks between batches
   (`DNS_DOH_REPORT.md` §4.2); paced-loop tests must stop hosts in
   `finally` or vitest wedges silently (`BROWSER_PACING_REPORT.md`
   §3.2–3.3).
7. **Integration tests stay offline/deterministic** — the HTTP gateway
   takes an injected `fetch` the same way DnsHost takes an injected
   `resolve`; no test hits the real network.
8. **No fix-and-pray.** Negative results are findings for the report.

## M1 — M3d: arbitrary-destination TCP termination + HTTP gateway

**STATUS: LANDED 2026-07-14** (commits `6cb3304`, `00665bc` + the
mixed-content follow-up; `HTTP_GATEWAY_REPORT.md` is the record —
including one recorded deviation: FIN-after-transmit rather than
FIN-after-ACK, unobservable on a lossless wire). Field verification
on the dev tier pending (report §8).

Per `emu86-networking-plan.md:72-76,140-166`: recognise guest SYNs to
off-LAN destinations at the gateway, terminate the TCP, parse the HTTP
request, `fetch()` the real internet, pipe the response back as
TCP-with-correct-seq/ack, clean FIN. The plan sized this as "probably
2 briefs"; the M3c engine seed (`src/net/tcp.ts`, 321 lines) collapses
it to one milestone with two commits: **(a) engine**, **(b) gateway
host**.

### (a) Engine work — grow `src/net/tcp.ts`

The guest is always the initiator, so no client-side TCP is needed —
what's needed is *promiscuous passive open* plus a real close story:

- **Promiscuous accept**: terminate SYNs addressed to *any* dst IP/port
  (today the stack answers only for its one `#localIp`,
  `tcp.ts:106,140-141`; the reply-source IP is hardwired at
  `tcp.ts:300`). Per-connection local identity = the destination the
  guest asked for.
- **Active close**: a method to initiate FIN while ESTABLISHED
  (HTTP-response-then-close needs it; today only passive close
  exists, `tcp.ts:220-233`). The reserved `onRemoteClose` hook
  (`tcp.ts:70-75`) gets exercised.
- **Close-after-drain**: `send()` is fire-and-forget today; the
  gateway must know all response bytes are ACKed before FIN. Add a
  sent-unACKed watermark.
- **Window pacing**: `seg.window` is parsed but unused; multi-KB HTTP
  bodies vs ktcp's 4380-byte buffer is the first real stress of the
  no-timers/no-retransmit bet. Pace sends against the guest's
  advertised window. (The lossless-wire argument covers loss, not
  overflow.)

### (b) HttpGatewayHost

- New pseudo-host joining the LanGateway's interception point: today
  `gateway.ts:201` drops any IPv4 not addressed to the gateway itself —
  that's where TCP-to-anywhere gets picked up. Registration follows
  the DnsHost pattern (`worker-host.ts:613-634` + Node harness).
- **Reverse-mapping dst IP → hostname**: Host-header-first (HTTP/1.1
  requests carry it; verify what ELKS `urlget` actually sends —
  capture reference traffic early, the proven M3c method), with a
  DNS-answer IP↔name cache as fallback for Host-less clients. The
  cache means `dns.ts` starts parsing A records out of DoH answers —
  a deliberate posture change from byte-pass-through, confined to
  answer parsing.
- Async completion follows the DnsHost pattern (ACK in the frame
  callback, transmit when the promise settles, `dns.ts:16-22`).
  **Check whether the DNS in-flight stall (`dns.ts:110-120`) is still
  needed now that the host-paced clock exists** — reconcile, don't
  duplicate; finding goes in the report.
- **Free acceptance test**: terminate `208.67.222.222:53` (OpenDNS) —
  deliberately skipped in `DNS_DOH_REPORT.md` §5 "until M3d" — so DNS
  with `DNSIP` unset starts working with zero extra code.

### Scope decisions (recommendations baked in — flag disagreement)

- **D1 — transport: pure-fetch now; the CF Worker WS↔TCP relay is a
  separate later decision.** The brief flagged it (`:536-539`): CF
  Workers have raw TCP `connect()`, so the emu86 worker could relay
  WebSocket↔TCP and open up real FTP/telnet/IRC beyond CORS. But it
  adds a server dependency to a browser-only story and makes the
  worker an abuse surface needing allowlists/rate limits.
  Recommendation: ship pure-fetch M3d (the planned shape — HTTP only,
  CORS-bounded, no inbound); if the relay is ever adopted, it starts
  dev-tier-only with an allowlist. Decide *after* M3d lands, per the
  brief's own note.
- **D2 — HTTPS**: stays impossible through the gateway (plan
  `:204-226`); the `webget`/ttyS1 escape hatch remains the sanctioned
  answer and is NOT in this phase.
- **D3 — config surface** (plan open-question 3, still parked): v1
  hardcodes sensible policy (port 80 + a permissive port set for
  telnet-style raw TCP to CORS-safe targets is NOT attempted —
  fetch can't do it; HTTP only).

### Acceptance

- Unit: engine (promiscuous accept, active close, drain, window
  pacing) + gateway host against an injected fetch fixture.
- Integration: boot ELKS, `urlget http://<fixture>/` returns the body
  byte-exact; OpenDNS interception resolves with `DNSIP` unset.
- Field (dev tier): `urlget http://example.com/` (CORS-permissive)
  from a browser tab.

## M2 — Virtual drives v1: `/dev/hdb` persistence

**STATUS: LANDED 2026-07-14** (commit `e4015b1`;
`VIRTUAL_DRIVES_REPORT.md` is the record — including two recorded
deviations: full-bytes write-back instead of the D4 sector-diff, and
presets-only sizes; plus the answered flush question — ELKS `sync`
DOES flush MINIX-fs, unlike FAT). Field verification on the dev tier
pending (report §6).

Per the wish (`HUMANS_WISH_LIST.md`) as digested in
`emu86-phase14-brief.md:499-513`: no kernel driver, no new device —
the secondary disk slot (Phase 11, `MULTI_DISK_REPORT.md`) already
routes DL=0x81→hdb end-to-end, images ship `/dev/hdb` nodes, ELKS
`/bin/mkfs` is proven (`RAMDISK_REPORT.md`), and partitionless MINIX
HDs are a supported shape. What's missing is creation + persistence:

1. **"Create blank image (size N)" in the library UI** — an all-zero
   `StoredImage`. Store explicit geometry on the entry (additive
   optional field, same forward-compat trick as `viability?`) and pass
   it through `buildBootMessage` → `DiskSlotSpec.geometry` (already
   honored over size-inference, `worker-host.ts:699-709`). Sizes must
   factor as C×H×S×512, S≤63 — UI offers sane presets (8/16/32 MiB)
   plus a validated custom size.
2. **Snapshot path out of the worker**: new protocol pair
   (Main→Worker `snapshot-secondary` / reply with transferable
   bytes), snapshot by looping `readSector` (probe-disk precedent,
   `ARTIFACT_EXTRACTION_REPORT.md` §2). A dirty flag/count in the
   worker stats drives an "unsaved changes" indicator.
3. **Explicit Save button** — sector-diff vs boot bytes, persisted to
   the library entry (the golden-overlay design's save-time diff:
   no live COW, no write-behind). For blank-created drives the base is
   all zeros so the diff store doubles as sparse storage. On next
   boot the composed bytes load as the secondary.
4. **Single-writer guard**: per-origin IDB means TAN tabs share the
   library; two tabs mounting one writable image = silent corruption.
   Web Locks advisory lock per image id; second tab gets the image
   read-only (or a warning — v1 may be advisory-only).
5. **Flush etiquette**: `sync` did not flush FAT data clusters;
   `umount` is the reliable flush (`ARTIFACT_EXTRACTION_REPORT.md`
   §4; MINIX-fs behavior unverified — test it, record the finding).
   Save UI instructs umount-or-sync first; verify what MINIX-fs
   actually needs and record it.

### Scope decisions

- **D4 — persistence representation**: sector-diff (recommended —
  sparse for blank drives, shares machinery with future golden boot
  overlays) vs full-bytes put-back (simpler, 32 MiB writes). Pinning
  rule from the overlay design applies: a diff is valid only against
  its base image identity.
- **D5 — save trigger**: explicit button only (recommended — matches
  the recorded no-write-behind design; crash-before-save loses data
  and the UI says so) vs also beforeunload/periodic.
- Out of scope, recorded: the cross-tab live "NAS" (FTP pseudo-host —
  wants M1's TCP maturity; natural follow-on), the real
  `/dev/browser1` kernel driver (flagship in-VM-compile target,
  later), golden boot overlays themselves.

### Acceptance

- Unit: blank-image creation/geometry validation; diff/compose
  round-trip; library write-back under fake-indexeddb (rig exists).
- Integration (the actual persistence proof): boot hd32-minix +
  blank secondary → guest `mkfs /dev/hdb` + mount + write file +
  umount → snapshot → persist → **second boot** from persisted bytes
  re-mounts and reads the file back byte-exact.
- Field (dev tier): create drive in one tab, mkfs+write, save,
  reload, remount, file's still there.

## M3 — ktcp-ping: compile a real ping in-VM

**STATUS: LANDED 2026-07-14** (commit `cd56498`;
`KTCP_PING_REPORT.md` is the record). The compile worked FIRST TRY —
c86 took all ~350 lines of ping.c; `ping 10.0.2.2` gets three honest
replies from the gateway and `ping 8.8.8.8` gets D6's
dest-unreachable. Field follow-up: get the binary into a browser VM
(autoexec compile, or an M2 persistent drive) for the TAN
tab-pings-tab demo.

**SCOPE AMENDMENT (2026-07-14, discovered at implementation time —
flagged for Jonathan's review):** stage 1 as written below contains a
hidden dependency on stage 2: the NS_PING server side lives *inside*
ktcp, so shipping it means recompiling the entire ~4k-line daemon
with c86 — exactly the risk this brief deferred to the stage-2
flagship. Amended stage 1 is the scout's option C: a **standalone
raw-frame `ping.c`** (~300 lines, one file) that opens the ethernet
device directly and does its own ARP + ICMP echo — the purest c86
dogfood, zero changes to the load-bearing daemon. Cost: it cannot run
while ktcp holds the NIC (`net stop` first, or ping before `net
start`), which is acceptable for a diagnostic tool. The NS_PING
netconf patch moves to stage 2 alongside the full-ktcp compile it
always required. D6 (gateway dest-unreachable) is unchanged.

Flagged in `ARP_ICMP_REPORT.md:7,51` and `emu86-phase14-brief.md:488-492`
("alongside ktcp-ping, THE flagship dogfooding target"). Verified
facts: ktcp's `icmp.c:43-84` is reply-only; ELKS ships no ping; but
the **netconf control channel already exists** (TCP socket to
address 0 port 2, `netstat.c` is a working 138-line client template),
`ip_sendpacket` already routes off-subnet via the gateway with
ARP handled, and **libc86.a already has socket/bind/connect/select/
gettimeofday stubs** — a ping client is compilable in-VM today.

**Stage 1 (this milestone):**

- ktcp patch: `NS_PING` netconf request (new request struct — the
  existing one is 2 bytes), `icmp_send_echo()`, `ECHO_REPL` handler
  → result back on the netconf socket. ~70–100 lines across
  `icmp.c`/`netconf.[ch]`/`tcpdev.c`.
- `ping.c`: ~130–150-line netconf client cloned from `netstat.c`
  (request, `select` timeout, `gettimeofday` RTT, N iterations).
  Header gap: the image ships no `sys/socket.h` etc. — ping.c
  self-declares the structs/prototypes it needs (c86 `-lang=c99`
  takes prototypes), or the few headers ride the probe floppy.
- **Both compiled in-VM with c86** (probe floppy carries sources in
  the Node harness — the proven path). The patched ktcp replaces
  `/bin/ktcp` for the test session; note the running binary is the
  prebuilt v0.9.0 release, and the submodule HEAD may skew from it —
  diff before patching, record any skew.
- **Off-LAN behavior (D6, recommended)**: the gateway answers echo
  requests to its own IP today (`gateway.ts:207-213`) and silently
  drops the rest — add **ICMP dest-unreachable for off-LAN echo
  targets** (ktcp's icmp.c already handles DST_UNRCH; clean UX). No
  synthesized fake RTTs from fetch timing — browsers can't do ICMP
  and we don't pretend otherwise.

### Acceptance

- `ping 10.0.2.2` answers with honest RTTs (which will be dominated
  by guest processing at authentic pacing — that's the machine being
  honest, not a bug).
- TAN: tab pings tab — genuine end-to-end ICMP, ktcp echo-replying
  on the far side, zero gateway/switch changes.
- `ping 8.8.8.8` reports destination unreachable (not a hang).
- The binaries used in acceptance were built *inside the VM*.

**Stage 2 (recorded follow-on, own milestone, NOT this phase):**
compile the *full unpatched* ktcp with c86 in-VM and run the machine
on it (telnet + DNS still work) — the flagship dogfooding result.
Risk concentrates there: ~4k lines of 2001-era C through c86 is
unproven (no bitfields spotted; `vjhc.c` can be stubbed). Host
cross-compiling is NOT a fallback: no ia16-elf-gcc exists on this
box, and building that environment produces exactly the artifact the
dogfooding thesis says shouldn't be needed.

## Report obligations

One report per milestone, existing standard (negative results
included): `HTTP_GATEWAY_REPORT.md`, `VIRTUAL_DRIVES_REPORT.md`,
`KTCP_PING_REPORT.md`. Known questions each report must answer:
M1 — is the DNS in-flight stall still needed under host pacing?
what does urlget actually send? M2 — what does MINIX-fs need for a
clean flush? M3 — ktcp v0.9.0-vs-submodule skew, and c86's verdict
on the patch sources.

## PHASE CLOSE (2026-07-14)

All three milestones landed same-session, in order, with reports:
`HTTP_GATEWAY_REPORT.md`, `VIRTUAL_DRIVES_REPORT.md`,
`KTCP_PING_REPORT.md`. **Final full suite: 1,169 passed, 106 files +
1 skipped (SST corpus), typecheck clean on all three configs.**
Session-start baseline was 1,128/100 — the +41 tests are this phase.
Field verification of all three milestones is pending on the dev
tier only (each report's last section is the checklist); nothing has
been deployed anywhere by the agent.

## M4 — The .tabs namespace (Jonathan, 2026-07-14, in-session)

**His design:** every tab gets a deterministic short animal name —
`mouse.tabs`, `cat.tabs`, `dog.tabs` — and the gateway, invisible
until now, is **`elk.tabs`** (ELK-S). The fake DNS server resolves
them, `nslookup cat.tabs` works, `ping cat` works, and each browser
tab's title *is* its name. The TAN stops being a set of octets you
have to remember and becomes a neighbourhood.

### The crux: how `ping cat` resolves without DNS

Jonathan flagged this as needing "clever coaxing". It needs none —
**because the names are deterministic**, which is the whole trick.
Ping cannot use DNS (the resolver speaks DNS-over-TCP through ktcp,
and ktcp is exactly what must not be running while ping owns the NIC),
but it doesn't need to: `name → octet` is a pure function, so ping
carries the table compiled into it. `ping cat` is an array lookup, not
a network round trip. The same table drives DNS, the tab title, and
the guest tool — one list, three consumers, and a test that pins them
together.

### Naming

- Octets are `10.0.2.[16..199]` (`tan.ts:65`), so 184 names,
  `name = ANIMALS[octet - 16]`. Names are lowercase, short, and
  distinct.
- Reserved: `elk` = 10.0.2.2 (gateway), `owl` = 10.0.2.3 (the DNS
  host — it looks things up). Both also answer as `gateway` / `dns`.
- Suffix `.tabs`. Bare names resolve too (`cat` and `cat.tabs` are the
  same thing).

### Allocation: first tab should be `mouse`, not `narwhal`

Today the TAN picks a **random** free octet, so the first tab would
land on a random animal — which throws away most of the charm. The
lease already tracks `#knownOctets`, but a newcomer only ever learns
about the *one* octet it collided with, so it cannot pick the lowest
free.

Fix — a one-message census, small and terminating:
- New `here` message. A settled tab that hears someone *else's*
  `claim` answers `here <octet>`. `here` never triggers a reply, so
  there is no echo storm (an unconditional re-`claim` would ping-pong
  forever — the reason for a distinct type).
- The newcomer records every `here`, then picks the **lowest free**
  octet instead of a random one. Worst case it collides once, learns
  the whole membership from that round, and picks correctly on the
  second attempt — bounded regardless of how many tabs are open.
- Sticky IPs are unchanged: a returning tab still prefers its
  remembered octet, so `cat` stays `cat` across reloads.

### Scope

1. `src/net/tan-names.ts` — the canonical list + `nameForOctet` /
   `octetForName` / `.tabs` suffix handling. One source of truth.
2. `src/net/tan.ts` — the `here` census + lowest-free pick.
3. `src/net/dns.ts` — answer `<name>` and `<name>.tabs` locally
   (synthesized A records) *before* falling through to DoH. This is
   the DNS host's first real message parsing on the question side; the
   answer-side reader (`parseAnswerARecords`) already exists.
4. `web/guest/ping.c` — the built-in name table, so `ping cat` works
   with ktcp stopped. Mirrors the TS list; a test pins them equal.
5. `web/main.ts` — `document.title` becomes the tab's name; the boot
   banner announces it.

### Acceptance

- `nslookup cat.tabs` from a booted guest returns the right 10.0.2.x.
- `ping cat` and `ping cat.tabs` reach the neighbouring tab (ktcp
  stopped), and `ping elk` reaches the gateway.
- Two tabs opened in order are `mouse` and `cat` — not two random
  animals — and their titles say so.
- The C name table and the TS name table cannot drift (pinned test).

## Still open from Phase 14 (not this phase's scope, don't lose them)

- Promote dev→stable when Jonathan accepts the dev tier.
- `BROWSER_PACING_REPORT.md` §2 numbers: invaders-under-Turbo
  impressions + browser instr/s via localhost tab + `/agent/stats`.
