# Guest Tooling Report — the machine downloads, builds, and runs its own software

2026-07-14, same session as Phase 15 (M1–M4). This is the record of the
ping-installer arc and, more importantly, of **four ELKS constraints
that will bite anyone who tries to push software into the guest.** Every
one was found by a field report, not by a test. Read §1 before you write
anything that types at the guest or builds inside it.

## 0. TL;DR

`ping` — the tool ELKS never had — is now installed by the machine
itself:

```
net start ne0
U=http://raw.githubusercontent.com:443/jonathan-annett/8086-tab-tools/main
urlget $U/install-ping.sh > /tmp/ip.sh
sh /tmp/ip.sh
```

The script fetches `ping.c` from the public repo, builds it with the C
compiler on the image (`cpp → c86 → as → ld`), installs it, and stashes
source + binary + md5 on `/dev/hdb` if a drive is mounted. Then
`ping elk` answers 3-for-3.

Verified end to end (`tests/integration/browser-ping-installer.test.ts`):
both files fetched through the M3d gateway, c86 built the download, and
the compiled binary pinged the gateway by name.

**The tools live in a public repo now:**
https://github.com/jonathan-annett/8086-tab-tools (MIT). Shipping a fix
to ping means pushing there — no emu86 release at all.

## 1. THE FOUR CONSTRAINTS (read this before writing guest tooling)

### 1.1 A typed command line over ~128 chars is SILENTLY TRUNCATED

No error. No warning. The tail just evaporates. A 129-character
`urlget … > /tmp/install-ping.sh` lost its final two characters, so a
perfect download landed in a file named `/tmp/install-ping.` and the
next line died with "Can't open /tmp/install-ping.sh".

Every line the field proved works is under it (Jonathan's
`urlget … | sh` = 111, `… | md5sum` = 115, the c86 invocation = 117).
Only the 129 failed.

**Rule: keep typed lines short. Put long things in a shell variable.**
`web/ping-installer.ts` exports `MAX_GUEST_LINE = 110` and throws if a
generated line exceeds it; a unit test enforces it. (Note this applies to
lines *typed at the tty*. Lines inside a script file are fine — the c86
invocation in `install-ping.sh` is 130 chars and works.)

### 1.2 ELKS `sh` buffers heredoc bodies in its heap — and the heap is small

A heredoc carrying 14 KB of C died at ~6 KB with
`(7)SBRK 8226 FAIL, OUT OF HEAP SPACE`, then fell out of heredoc mode
and interpreted the C source as shell commands. Chunking into 20-line
heredocs worked, but every time the source grew the paste crept back
toward the wall.

**Do not push large content through heredocs. Fetch it.** (§2)

### 1.3 The shell never gives its heap back, and `fork` copies it

After a ~450-line paste the login shell's data segment is fat, and
*every subsequent fork copies it*. Symptom: the build and the ping
worked, then `net start` brought ktcp up but `/bin/net`'s own shell died
on `SBRK 1028 FAIL` — it could not spare a kilobyte for an `echo`, and
telnetd/ftpd never started.

**Cure: `exec sh`.** It replaces the process image, and the bloat goes
with the old one. (Moot now that nothing large is typed, but the fact
stands.)

### 1.4 `net start` costs three daemons, and the compiler wants that RAM

This is a **640K machine with ~472K free** (`ibm-pc.ts:257` gives the CPU
its full 1 MiB address space; the BIOS reports 640K — the real PC ceiling,
since above `0xA0000` is video/ROM). It is not an emulator limit we can
lift: more RAM would mean it stops being an 8086.

`net start` brings up ktcp **and telnetd and ftpd**, and those three
leave so little that the shell cannot even fork (`net: Cannot fork`),
let alone run c86 (`c86: not enough memory`).

Two fixes, both used:
- `echo netstart= >> /etc/net.cfg` before `net start` — `/bin/net`
  *sources* that file, so a later assignment wins, and only ktcp starts.
- The installer takes the network **down** before compiling. It has to
  anyway: ping drives the NIC directly and a running ktcp drains every
  inbound frame before ping can see it.

## 2. The design that fell out of it (Jonathan's)

The first installer typed all of `ping.c` into the guest — 722 lines,
20,806 bytes, 28 chunked heredocs — and lost a war with the shell on
three separate fronts (§1.1–1.3). Jonathan's call was `urlget … | sh`:
**don't manage the paste problem, delete it.**

What that bought:
- Nothing large ever goes through the tty again.
- Shipping a ping fix means pushing to the tools repo; emu86 doesn't move.
- It *demonstrates* the M3d gateway doing real work instead of merely
  existing.

`install-ping.sh` is idempotent, cheapest path first:

| state | cost |
|---|---|
| `/bin/ping` present | nothing |
| binary + source on `/dev/hdb` | a copy. No network, no compiler. |
| source on `/dev/hdb` | a build. No network. |
| nothing | download, then build |

**The drive is the workshop** (Jonathan's design): source, binary and md5
live there and the build happens *in place*, so a saved drive means every
later boot installs ping with no download and no compile. Intermediates
(`.i`/`.as`/`.o`) are cleaned up — a drive should hold the source and the
binary, not the rubble.

## 3. Verified

- **End to end, offline** (`browser-ping-installer.test.ts`): boots ELKS
  under `WorkerHost`, drives the real seeded boot script through the real
  `AutoexecRunner`, and stubs only `fetch` — serving the two files from
  the local tools checkout. Everything else is real: the guest's urlget,
  the TCP terminator, the HTTP gateway, DoH, the toolchain, the raw-frame
  ping, and the gateway's ICMP. Transcript ends
  `3 packets transmitted, 3 received`.
- **In the field** (Jonathan, dev tier): `urlget` fetched
  `install-ping.sh` and its **md5 matched GitHub's CDN and the git object
  byte-for-byte** — a hard proof the whole gateway chain is lossless.

## 4. Traps in the test harness itself (cost two cycles)

- **Stub the DNS too.** The guest must *resolve* before it can fetch, and
  on this machine DNS is itself a `fetch` (DoH). A stub that serves only
  the file leaves the guest unable to resolve, so nothing is ever
  requested and the test hangs with an empty `served` list.
- **Batch small.** `DNS_DOH_REPORT` §4.2 again: a blocked guest burns
  virtual time at halt-spin rate, so a 250k-instruction slice runs
  `in_resolv`'s 2-second alarm out before the host's DoH promise settles
  between slices. Use ~20k. (The paste-based test got away with 250k only
  because it never touched the network.)

## 5. Open / next

- **Workshop-on-drive is untested with a real `/dev/hdb`** — the
  integration test boots without a secondary, so the no-download,
  no-compile second boot is unproven. That is the next thing to verify.
- A reboot-and-build-from-the-drive path (Jonathan's idea) remains the
  fallback if memory ever gets tighter: a fresh boot has no daemons and
  no bloated shell. The catch is that `/dev/hdb` is in-memory until Save,
  so a reload would need an auto-snapshot first (the M2
  `snapshot-secondary` protocol already provides it).
- The tools repo is the natural home for anything else the machine should
  be able to build itself.
