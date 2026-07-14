# ktcp-ping Report — Phase 15 M3 (a real ping, compiled in the VM)

2026-07-14. Brief: `emu86-phase15-brief.md` §M3 including the scope
amendment recorded there. Commit: `cd56498`. Everything below was
run, not assumed.

## 0. TL;DR

ELKS on emu86 has a working `ping` — and the machine built it itself.
`tests/probe/surveys/guest/ping.c` (~350 lines, one file) rode the
probe floppy into a booted hd32-minix, went through the on-disk C86
toolchain (`cpp → c86 → as → ld`, every stage rc=0, **on the first
try**), and then ran against the live LAN in the same boot:

    PING 10.0.2.2 from 10.0.2.15: 32 data bytes
    40 bytes from 10.0.2.2: seq=1 time=0 ms
    40 bytes from 10.0.2.2: seq=2 time=0 ms
    40 bytes from 10.0.2.2: seq=3 time=0 ms
    --- 10.0.2.2 ping statistics ---
    3 packets transmitted, 3 received

    PING 8.8.8.8 from 10.0.2.15: 32 data bytes
    From 10.0.2.2: Destination Host Unreachable

The first block is the TypeScript `LanGateway` answering genuine ICMP
from a genuinely 8086-compiled binary doing its own ARP on the raw
NIC. The second is decision D6 landing: routed echo requests get an
honest RFC 792 host-unreachable — a browser cannot originate ICMP,
and emu86 does not synthesize fake RTTs. The gateway's own counters
corroborate from the other side of the wire (2 ARP replies, 3 echo
replies, 1 unreachable), and the exported binary's md5 matches the
guest's receipt byte-exactly.

## 1. The scope amendment (flagged in the brief, restated here)

The brief's stage 1 — an `NS_PING` netconf request patched into ktcp —
contained a hidden dependency discovered at implementation time: the
server side lives *inside* ktcp, so shipping it means recompiling the
entire ~4k-line daemon with c86, which is precisely the risk the brief
itself deferred to stage 2. Rather than smuggle the flagship risk into
stage 1, the landed shape is the scouting report's option C: a
**standalone raw-frame ping** that opens the ethernet device directly
and needs zero changes to the load-bearing daemon. The trade, recorded
honestly: it cannot run while ktcp holds the NIC — `net stop` first,
or ping before `net start`. For a diagnostic tool that is acceptable
(and the tool says so itself when the open fails). The NS_PING patch
moves to stage 2 alongside the full-ktcp-compile it always required.

## 2. What the C tool is

- Opens `/dev/ne0` (`ktcp.c:47`; falls back to the older `/dev/eth`),
  `IOCTL_ETH_ADDR_GET` for the MAC, whole ethernet frames per
  read/write — the same substrate ktcp's `deveth.c` uses.
- Own ARP resolve (3 tries × 1 s), own IP/ICMP construction with RFC
  1071 checksums, /24 routing (off-subnet → gateway 10.0.2.2),
  `select`-based timeouts, RTTs via `gettimeofday`.
- The ELKS ABI is **self-declared** (`O_RDWR`, the ioctl number,
  `struct timeval`, fd_set-as-u32-bitmask — verified against
  `linuxmt/{fcntl,ioctl,time}.h` and `posixtyp.h`) because the hd32
  image ships only the c86 subset of `/usr/include`. `<stdio.h>` is
  the only header included.
- Understands echo replies (id 0x8086, sequence-matched) and
  dest-unreachable; prints per-reply RTT lines, a summary, and exits
  0 only if something answered.

## 3. What c86 had to say about it (dogfooding findings)

- **It just compiled.** ~350 lines of deliberately conservative C
  (block-top declarations, no bitfields, no floats, byte-array wire
  handling) went through `cpp → c86 -O → as → ld` with rc=0 at every
  stage on the first attempt. The M3-stage-2 fear (4k lines of
  2001-era K&R) remains untested, but the toolchain's appetite for
  new, careful C is now proven at 10× hello-world scale.
- **stdio is fully buffered** — a crash or hang before `exit`
  produces zero output. The tool prints its banner before touching
  the network and `fflush`es at progress points; without that, the
  first debugging round was blind (see §5).
- Binary: 9,176 bytes; md5 receipt `f9289e…` verified host-side after
  probe-floppy extraction (the Phase 14 M1 fidelity scheme).

## 4. Substrate changes (TypeScript side)

- **D6 in `LanGateway`**: routed (off-subnet) ICMP echo requests now
  answer with type 3 code 1, quoting the original IP header + 8 bytes
  per RFC 792 (`buildIcmpDestUnreachable` in wire.ts). Echo *replies*
  and unroutable senders stay silent. Unit tests pin the quote bytes.
  Note: ktcp's own `icmp.c` understands DST_UNRCH, so future
  stack-level tools benefit too.
- **Probe harness grows a LAN** (`runProbe`'s optional
  `createNetwork` hook): the caller wires a switch/gateway around an
  inject callback, everything synchronous with traceRun — a frame the
  guest writes can be answered before its `write()` returns. That
  synchronicity is why the in-harness RTTs print as 0 ms: the reply
  is queued before the guest's next instruction. Honest for this
  wire; browser RTTs at authentic pacing will be nonzero and real.
- `buildBootoptsWithScript` accepts extra kernel-option lines (the
  probe needs `ne0=5,0x300,,0x80`, same as the browser auto-patch).

## 5. Debugging log (what it took — two failures, both instructive)

1. **Budget, not bug**: first run died silently mid-`ld` —
   `timeoutPhase=boot`. The init `-c` pipeline runs entirely inside
   the harness's *boot* phase, and hello-world's 48M-instruction
   budget doesn't stretch to c86 `-O` on 350 lines. 140M does (wall
   ≈ 2 min). The LAN waits cost almost nothing — blocked selects idle
   in HLT; the compile is what burns instructions.
2. **`/dev/eth` is stale knowledge**: the ELKS tree's `test_eth.c`
   opens `/dev/eth`, but current images name the node `/dev/ne0`
   (`ktcp.c:47`). The tool now tries both, and its failure message
   points at the real usual suspect (ktcp holding the device).

## 6. Verified

- `tests/integration/elks-ping-invm.test.ts` (green, ~120 s): one
  boot compiles ping.c (all stages rc=0), pings the gateway 3-for-3
  (transcript lines AND gateway counters), gets exactly one
  unreachable for 8.8.8.8 with tool exit code 1 (no hang), and the
  extracted binary's host md5 equals the guest receipt.
- D6 unit tests in `lan-gateway.test.ts`; wire builder exercised
  end-to-end by the integration test (ktcp-independent path).
- Full-suite number lands in the phase-close commit (run follows this
  report; unit suite and typecheck were green at M3 commit time).

## 7. Not done / field follow-ups

- **TAN tab-pings-tab** is field work: it needs the ping binary
  inside a *browser* VM (compile it there via an autoexec script — the
  landing demo already proves in-browser compiles — or copy it onto a
  persistent /dev/hdb drive, which M2 just made possible; the two
  milestones compose nicely). The far side needs no changes: ktcp's
  `icmp.c` echo-replies, exactly as the M3b test proved.
- **Stage 2 (the flagship)**: compile the full, unpatched ktcp with
  c86 in-VM and boot the machine on it; then the NS_PING netconf
  patch (+ a ~140-line netstat-clone client) makes ping a first-class
  citizen that coexists with the running stack. Groundwork from this
  milestone: the toolchain path, budgets, and LAN-attached probe
  harness are all in place.
- RTT realism in the Node harness (0 ms by construction) — nothing to
  fix, just don't quote harness RTTs as performance numbers.
