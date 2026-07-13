# emu86 — Networking Architecture Plan (Pre-Phase 14)

This document captures a planning conversation between human and
planning-instance after Phase 12 closed and during Phase 13's run.
The toolchain survey hadn't reported in yet when this was written;
this document is **planning, not result**. It's the shape of the
networking arc as discussed, intended to outlast the planning
instance's context window so a successor can continue without
re-deriving the architecture.

## The user's stated motivation

Way back at Phase 8: "we'll hopefully be talking to the box via
some sort of network card / ssh simulation." That motivated
choosing serial over CGA-polish at Phase 8.

Refined here: the user wants real-feeling networking inside the VM
— not just a host-cross-compile-and-deploy story. They explicitly
want to model the network outside the VM (in the browser) before
writing any C in the VM. The ELKS box should think it's on a
network. Authenticity matters; this is consistent with the
project's posture (Phase 10.1's authentic-vs-virtual-shift call,
the unmodified-ELKS-as-reference-target rule, etc.).

## The fundamental browser constraint

Browsers can't access raw network interfaces. Three primitives
are available:

- `fetch()` / XHR — application-layer HTTP(S) only.
- WebSocket — bidirectional message stream.
- WebRTC — peer-to-peer, complex, NAT traversal.

None of these is an ethernet frame. So a fully real network
exposed to ELKS isn't possible without a host-side daemon, which
the project explicitly doesn't want (different deployment story,
"open URL in browser, see ELKS" becomes "install our daemon
first").

What we *can* do: simulate a complete fake LAN inside the
browser. Frames from ELKS go to a JavaScript switch; pseudo-hosts
on that switch (DNS server, gateway, optionally NTP) respond
authentically; the gateway terminates connections and proxies
upstream via `fetch()`.

## The two-layer plan

After discussion, the agreed shape is **two layers, not one
replacing the other**:

### Layer 1: Real(ish) networking via NE2000 + virtual LAN

The substantive work. Authentic kernel networking. Daily-driver
path for everything except HTTPS. Components:

- **NE2000 device.** A faithful 8390-class NIC at standard
  ports/IRQ. The card exists, the kernel sees it, frames move.
- **Virtual switch.** JavaScript frame-router. Receives frames,
  dispatches by destination MAC. Broadcast → all attached;
  unicast → matching host or drop.
- **Pseudo-hosts on the switch.** Each has a MAC and an IP.
  Different roles:
  - **ARP responder.** Replies to ARP-who-has queries for
    pseudo-host IPs.
  - **ICMP responder.** Replies to pings. Demos like
    `ping 10.0.0.1` from inside the VM.
  - **DNS server.** Listens on UDP/53. On query, issues a
    DoH (DNS-over-HTTPS) request to Cloudflare's
    `1.1.1.1/dns-query` (or similar CORS-permissive DoH
    endpoint) and returns the result. The kernel never knows
    it isn't real DNS.
  - **HTTP gateway.** Accepts TCP connections destined for
    arbitrary IPs. Terminates the TCP. Parses HTTP requests.
    Issues a `fetch()` to the real internet. Pipes the
    response back as TCP. Kernel thinks it's talking to a
    real web server.
  - **NTP server (optional).** Listens on UDP/123. Returns
    `Date.now()` as a properly-formatted NTP response.

### Layer 2: HTTPS escape hatch (`webget`)

For the case the user explicitly named: HTTPS via the gateway
is structurally impossible. `fetch()` does TLS on our behalf to
the destination; we never see bytes-on-the-wire; we can't
forge encrypted frames back to the kernel.

Solution: a small userspace tool inside the VM (`webget` or
similar) that bypasses the network stack entirely. It writes a
structured request to a second UART; the browser's second-UART
handler does `fetch()` (which transparently handles HTTPS); the
response comes back via the same UART. From inside ELKS:
`webget https://example.com/page > out.html`.

This is **not authentic to real-PC ELKS** — the tool wouldn't
exist on real hardware. But it's a clearly-labelled exception
beside an otherwise authentic network stack. The architectural
posture trade is: one tool is non-canonical to make HTTPS
possible.

The second UART (16550 instance + different I/O sink) is
substrate work that's also useful generally — a `host-services`
channel for future host-side capabilities (file share, host
time, etc.). Don't name it `webget`-specifically.

## Layer-by-layer architectural notes

### NE2000 + Switch (the foundation)

The device emulation pattern is the same shape as PIC, PIT,
keyboard, UART. Port I/O at 0x300-0x31F (or wherever ELKS's
driver expects), IRQ 9 (typically), `onTransmit(frame)` callback
for frames the kernel sends, `injectFrame(frame)` for frames the
kernel should receive.

The switch is JavaScript. ~few hundred lines. Frame in →
inspect destination MAC → dispatch. Pseudo-hosts register
themselves at construction time.

### ARP / ICMP (trivial pseudo-hosts)

Smallest pieces. ARP is a request/response over ethernet
broadcast; we synthesise replies for our own pseudo-host IPs.
ICMP echo is a few-byte transformation of the request. Each is
maybe 50 lines.

### DNS via DoH

DoH is HTTPS, browser-friendly, CORS-permitted by Cloudflare.
The pseudo-host parses incoming UDP/53 queries, issues a
`fetch()` to `https://cloudflare-dns.com/dns-query` with
appropriate headers, packages the response back into a UDP/53
reply, sends it via the switch. Real resolution, real answers.

**Caveat.** The IP returned will probably fail to *connect*
unless Layer 1's HTTP gateway handles that destination. DNS
working but TCP not is a real intermediate state. Document.

### HTTP gateway via TCP termination

This is where the substantial complexity lives. The gateway
must:

1. Recognise incoming TCP SYN packets.
2. Synthesise SYN+ACK with valid sequence numbers.
3. Receive the kernel's ACK; track connection state.
4. Receive HTTP request bytes from the kernel.
5. Reverse-resolve the destination IP back to a hostname (we
   just resolved it via DNS — cache the mapping there).
6. Issue `fetch(http://hostname:port/...)` with the HTTP
   request's path/headers/body.
7. Receive the response, format as HTTP-over-TCP back to the
   kernel.
8. Handle FIN cleanly.

This is a small TCP implementation. Track:
- Per-connection state by `(src_ip, src_port, dst_ip, dst_port)`.
- Sequence numbers, window sizes, ACK numbers.
- Retransmit handling (kernel may resend if it doesn't see our
  ACKs fast enough).
- Connection lifecycle: SYN-SENT → ESTABLISHED → FIN-WAIT →
  CLOSED.

Reference: v86 (the JavaScript x86 emulator) does something
similar in its `network.js`. Worth consulting for the TCP
shape; not for code-cargo-cult.

This is meaningfully larger than 1-3 combined. Probably 2 briefs:
TCP termination engine, then HTTP proxy logic on top.

### `webget` + second UART (the escape hatch)

`tools/elks/run-serial.ts`-style harness exposes COM1 already.
Add COM2 as an `onTransmit` channel that the browser-side
intercepts. The browser-side handler:

1. Receives bytes from COM2 in some structured format
   (length-prefixed JSON request, or simpler).
2. Issues `fetch(...)` per the request.
3. Streams the response back over COM2.

Inside the VM, `webget` is a userspace C tool that opens
`/dev/ttyS1`, writes its request, reads the response. ELKS
already supports multiple ttyS devices.

Independent of Layer 1 architecturally. Could land before,
after, or in parallel.

### NTP / RTC

Two ways to give the VM a sane wall-clock:

- **NTP pseudo-host.** Ties into the network stack. Listens on
  UDP/123, returns `Date.now()` as NTP. Demonstrates the
  network is alive at the application layer.
- **Fake RTC chip.** Real PC has a CMOS RTC at I/O ports
  0x70-0x71. We don't model it; the kernel sets a default time
  at boot. Adding an RTC device is small substrate work, no
  network dependency.

Both are valid; do both eventually. RTC is more substrate-
honest; NTP is more network-elegant. Neither is on the critical
path for the primary networking arc.

## What's structurally impossible (and why)

**HTTPS through the NE2000 + gateway path.** `fetch()` does TLS
on our behalf to the destination; we never see encrypted bytes
to forward; the kernel can't be persuaded to trust certificates
we'd forge. Three notional workarounds and why they don't work:

- *Terminate TLS at the gateway, re-encrypt to the kernel.*
  Requires the kernel to trust a "browser-side gateway CA."
  Per-image config burden. ELKS's TLS implementation
  (does it have one?) is probably minimal anyway.
- *Tunnel TLS bytes through.* Can't — `fetch()` does TLS
  for us. There's no `socket(AF_INET, SOCK_STREAM)` in the
  browser to tunnel raw bytes over.
- *WebSocket as TCP.* Could let us tunnel raw bytes to *a
  service we control*, not to arbitrary HTTPS endpoints. So
  it's the host-side daemon shape (Shape B in earlier
  conversations). Not in scope.

The escape hatch (`webget`) sidesteps this by **not pretending
to be the network**. The browser does the HTTPS; the VM gets
plaintext bytes via UART. Honest, bounded, clearly an
exception.

**Inbound connections.** Nothing in this design lets external
hosts initiate connections *to* the VM. No `nc -l`, no SSH
server, no inbound HTTP. The browser is always the
initiator (via `fetch()` or DNS or whatever); the VM is always
on the inside of the gateway. To support inbound, you'd need a
WebSocket relay (other VMs connecting through a public relay)
or a host-side daemon. Documented as a known limit.

**CORS.** Even outbound, CORS limits what the gateway can
fetch. CORS-permissive endpoints (`api.github.com`,
Cloudflare's DoH, many public APIs) work; CORS-strict ones
don't. Same constraint a real `curl` user faces from a browser
context. Not a blocker, but a known scope-limit on the demo
surface.

## Phase ordering as discussed

Tentative, not committed:

- **Phase 14**: NE2000 device + Switch substrate. Card exists,
  frames flow, no pseudo-hosts attached. Validates device runs
  on our substrate.
- **Phase 15**: ARP + ICMP pseudo-host. `ping 10.0.0.1` works.
- **Phase 16**: DNS via DoH. `nslookup google.com` works,
  returns real answers.
- **Phase 17**: TCP termination engine. Possibly split into
  17a (engine) + 17b (HTTP proxy on top). After this,
  `wget http://example.com` works.
- **Phase 18** (or earlier, opportunistic): `webget` + second
  UART. HTTPS escape hatch.
- **Phase 19+**: NTP/RTC, multi-NIC configs, WebSocket relay
  for inter-VM peering, etc. As demand surfaces.

## How this interacts with the dogfooding goal

The dogfooding narrative ("build NE2000 driver from source
inside the VM") is preserved but reshaped:

- The toolchain survey (Phase 13) determines what's compilable
  inside ELKS.
- If a serious compiler (`bcc` reporting sensible version,
  building moderate programs) is available, the NE2000 driver
  is a plausible dogfooding target — it's a few hundred to a
  couple thousand lines of K&R-ish C.
- If the compiler is barely-functional, `webget` becomes the
  more achievable dogfooding target — much smaller code.
- The toolchain survey output **shapes which dogfooding target
  is realistic**, but doesn't block the network arc.

The two arcs intersect (driver source + working compiler =
built driver) but neither blocks the other. The networking
architecture above can land with a host-cross-compiled NE2000
driver if the in-VM compile path doesn't pan out.

## Open questions for whoever picks this up

These didn't get answered before context pressure:

1. **Order priority within the network arc.** Linear (14 → 15
   → 16 → 17) or are some independent enough to parallelise?
   DNS doesn't strictly require ARP/ICMP — could come right
   after Phase 14. Probably depends on whether the agent is
   doing one brief at a time or capable of parallel work.
2. **`webget` placement in the order.** Earliest possible (cheap
   user-visible win even before any network stack lands)? Or
   after the network is real, when its purpose is clearer as a
   labelled exception? Either is defensible.
3. **Configuration surface.** Each pseudo-host has an IP, MAC,
   behaviour. The VM has its own IP, gateway, DNS. Where does
   this configuration live? Worker host config? Settings panel
   in the browser UI? Both? Decide before any of the
   pseudo-hosts ship so each brief can reference it.

## One framing thing worth preserving

The user said: "we model outside of the vm first — i.e., before
writing a line of c/c++ on the driver, we need to know if we
can model the network support we need in the browser." This is
the right instinct and the explicit reason the network arc
should land independently of (and possibly before) any in-VM
driver work. The browser-side network being real makes the
in-VM driver's success or failure cleanly diagnosable.

## What was explicitly considered and rejected

- **Host-side daemon** (Shape B in earlier conversations) for
  bridging to real ethernet. Different deployment story; the
  project's "open URL, see ELKS" identity stays.
- **Protocol-aware HTTPS proxy with cert forging** (Shape C).
  Lossy, fragile, architecturally wrong. Lies to the kernel.
- **Replacing the network stack with `webget`-only** (the
  user's earlier suggestion before settling on two layers).
  Loses too much authenticity; the kernel never thinks it's
  networked. Rejected in favour of two layers, with `webget`
  as labelled exception.

## What this document is NOT

- A brief. Each phase above will need its own brief when its
  time comes.
- A commitment. Priorities and shapes can change as the
  toolchain survey lands and the project's posture evolves.
- An architecture spec. The implementation details of TCP
  termination, the exact NE2000 register set, the switch's
  internal data structures — all to be worked out per-brief.

It's an orientation document for whichever planning instance
picks up after Phase 13. Read alongside `emu86-handover-brief-v3.md`
and the recent reports.
