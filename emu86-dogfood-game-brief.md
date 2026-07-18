# emu86 dogfood-game brief — two machines, one game, zero host hands

Drafted 2026-07-18 from Jonathan's ask ("a good dogfooding test would
be to locate some simple c source code text based game that works
between two clients (battleships? or chess or something) and build
it, then run it. this will prove a number of things"). STATUS:
DRAFT — needs his D1–D3 rulings below.

## 0. What it proves

One artifact — a two-player text game, source-delivered into the
guests, compiled by the guests, played guest-to-guest over the TAN,
with the agent driving both consoles — exercises in a single pass:
source delivery (the urlget routes), the in-VM c86 toolchain on a
non-toy program, ELKS's socket layer against ktcp between two tab
machines, the rack, and the agent cable as an operations surface.

## 1. Recon — ALL of it verified live this session (2026-07-18, on
## dog via the agent cable; see AGENT_CABLE_REPORT.md for the how)

- **Guest TCP sockets work from c86-compiled code.** A 7-line probe
  declaring `extern int socket();` (the ping.c idiom — the image
  ships NO socket headers) compiled with the exact hello-world flag
  set, linked against `/usr/lib/libc86.a`, ran, and got fd 3 from
  ktcp. The c86 libc build includes `net/` (in_connect,
  in_gethostbyname…) and `sys/socket.h` in the ELKS source declares
  accept/bind/connect/listen as libc calls — the stubs are in the
  image's archive, proven by the link.
- **The guests can unpack repos**: `/bin/tar` creates and extracts
  (`tar -{txu}[cvfblmhop]`), and the minimal gzip does `-d`
  (round-trip proven). No gunzip binary — `gzip -d` IS gunzip here.
- **Delivery today**: raw.githubusercontent.com is CORS-open through
  the gateway (the ping installer's proven route). Tarballs from
  codeload.github.com are CORS-blocked; serving them needs the
  `/gh-assets` allowlist widened on the cf-worker (separate ruling,
  pending — NOT required for this brief if D2 picks per-file).
- **Two-machine ops are agent-drivable end to end**: spawn over the
  cable, console both ends, telnet mouse→cat as root — all done in
  the M3 acceptance earlier today.
- Console gotcha for the install path: typing >80-column commands
  into the ELKS line editor triggers a redraw storm (cosmetic but
  ugly); real installs go `urlget … | sh` or use the demo script's
  `\` continuation style.

## 2. Milestones

### M0 — pick the game (D1)

Hunt for an existing tiny two-player C game to port (public-domain
battleships/reversi/etc). Honest expectation: most known code wants
curses and BSD headers, and the c86 dialect + 640K + stdio-only
reality means ANY find gets a real port. Fallback, likely faster and
recommended: purpose-write it —
  - **M1 wire-proof: tic-tac-toe** (~150 lines): stdin moves, stdout
    board, one byte per move on the wire. Server binds and waits;
    client connects by IP (in_gethostbyname/`/etc/hosts` may allow
    `cat.tabs` — probe during M1).
  - **M2 showpiece: battleships** (~350 lines): placement, salvo
    exchange, hit/miss board rendering — still pure stdio, still a
    tiny turn protocol.
The game ships its OWN minimal extern declarations + numeric
AF_INET/SOCK_STREAM constants read from the ELKS headers at port
time (the image has none — recon fact).

### M1 — deliver + build + play, agent-driven

Stage source in the delivery repo (D3), install by the ping-installer
pattern (`urlget …/install-game.sh | sh` → fetches source, compiles
turbo-style, drops binaries in /bin or ~). Then: two rack PCs, server
on one, client on the other, the agent plays a full game over the
cable and captures the transcript for the report. Acceptance =
a completed game + tab-shark showing the game's TCP flow between
the two octets.

### M2 — battleships, same pipeline, plus Jonathan playing one seat
### against the agent (the actual fun)

## 3. Hard-rule notes

Zero emulator/repo changes — the entire deliverable lives in the
delivery repo and inside the guests. (The optional gh-assets
widening is its own separately-ruled change.) Nothing here touches
the suite; the report records the transcript and any toolchain
findings.

## 4. Decisions — Jonathan rules

- **D1 — find-and-port vs purpose-write** (recommended:
  purpose-write, tic-tac-toe then battleships; the hunt is allowed
  one bounded hour before falling back).
- **D2 — delivery route**: per-file raw fetches via install script
  (works today) vs the codeload tarball through a widened
  /gh-assets (needs the worker ruling). Recommended: per-file now,
  tarball when/if the proxy ruling lands.
- **D3 — where the source lives**: 8086-tab-tools (his repo, his
  push) vs a new repo. Recommended: 8086-tab-tools, beside the ping
  installer it imitates.

## 5. Addenda (same session)

- **M3 — the useful payload** (Jonathan: "we can even do something
  useful once we prove the loop"): once ttt proves the pipeline,
  fetch and build the RECENT upstream ELKS `dhcp` and `ping` (the
  ones learned about from the maintainer — both newer than our
  pinned submodule, whose elkscmd/inet has neither) straight from
  raw.githubusercontent.com/ghaerr/elks — CORS-open, so the loop
  reaches them today. c86-compatibility of upstream sources is the
  expected porting work.
- **XMS memory ruling** (Jonathan, on seeing `SBRK … OUT OF HEAP
  SPACE`): XMS-era machines keep the network UP through compiles —
  the daemons no longer starve c86 (supporting datum: the socket()
  probe compiled with ktcp+telnetd+ftpd all resident).
  install-ttt.sh ships without `net stop`; the failure hint keeps
  the pre-XMS escape hatch documented. Console-paste delivery is
  DEAD — the shell heredoc heap is a 64K segment XMS cannot grow;
  urlget writes files without shell buffering and is the loop
  anyway.
- **Status**: ttt.c + install-ttt.sh committed to 8086-tab-tools
  (9e31456), AWAITING JONATHAN'S PUSH; then the loop runs agent-
  driven end to end.
