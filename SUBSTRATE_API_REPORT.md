# Substrate API v1 Report — the machine talks to the substrate under it

2026-07-15, late in the field session that accepted ping rev 5. Scope:
Phase 15 post-close addendum F (and the E/G designs it sits inside).
Direction context: Jonathan's consolidation call — stop expanding the
guest-OS frontier; get the environment ready to hand to the huxley/lite
editor project. This API is handover surface, not a new frontier.

## 0. TL;DR

Two capabilities, both driven by tools the guest already has:

1. **The shell knows who it is.** `HOSTNAME=<tabs-name>` is stamped
   into bootopts beside `LOCALIP`. Stock `/etc/profile` runs
   `PS1="$HOSTNAME$PS1"` — a line nobody had ever fed — so every TAN
   tab's prompt is now `mouse# `, `cat# `, … and `$HOSTNAME` answers
   scripts. No network, no new tooling. (Field ask: "there does not
   seem to be any way for the shell to know its own hostname.")
2. **A control endpoint on the gateway's own address** — TCP to
   10.0.2.2 used to be silently dropped (the gateway handled only ICMP
   for itself); `src/net/control.ts` now serves HTTP/1.0 there:

   ```
   urlget http://10.0.2.2/?whoami        -> cat 10.0.2.17
   urlget http://10.0.2.2/?peers        -> live TAN directory
   urlget http://10.0.2.2/?mkdrive=8086  -> create + attach a drive
   ```

   `whoami`/`peers` answer synchronously from the worker's TAN state.
   `mkdrive` round-trips to the main thread (`control-request` /
   `control-response` protocol pair) where the image library and
   settings live — the same create-and-select the modal's button does,
   against the same preset table (now shared in `image-library.ts`,
   so the two cannot drift). Reboot stays manual; mkfs stays guest
   business; anything unparseable gets usage text a human can read in
   the guest terminal.

## 1. Decisions worth recording

- **A separate `ControlHost`, not a mode of `HttpGatewayHost`.** The
  fetch gateway reaches the web; the control endpoint is the machine
  talking to its own substrate. Different trust, different lifecycle,
  ~40 lines of shared shape (the DnsHost pattern). The gateway gained
  `registerLocalTcp`, deliberately distinct from the off-subnet
  terminator.
- **No run-loop stall for mkdrive.** The round trip is two
  postMessages, not a fetch; the guest's urlget read timeout is not in
  danger. Headless hosts (tests/Node, nobody on the other end) get an
  honest "nobody answered" after 10 s instead of a hang.
- **Preset sizes only** (`8086, 16128, 32256` KB): arbitrary KB needs
  CHS-exact factoring and invites geometry bugs; the modal's presets
  are field-proven shapes. A wrong size answers with the valid list.
- **`?save` and `?file` deliberately absent** — recorded in the brief
  (F.3, E): Save has Web-Lock interplay and a working button; file
  interchange is the editor seam (E: the drive IS the file interface).
- **`ktcp` bare-invocation caveat** (recorded, accepted): with
  `HOSTNAME` set, a bare `ktcp` with no IP argument resolves the name
  instead of using its builtin default. `/bin/net` always passes the
  IP explicitly, so the supported path is unaffected.

## 2. Verified

- Unit: `control-host.test.ts` — a hand-rolled TCP client (the DNS
  tests' pattern) dials 10.0.2.2:80 through a real switch + gateway:
  whoami, peers, async mkdrive settle-after-flush, 400s for unknown
  actions and malformed sizes, usage on bare GET, and the no-host case
  still drops TCP silently (old behavior preserved). `tan.test.ts`
  pins the HOSTNAME line derivation (and its absence outside the lease
  range — solo machines keep a bare prompt). Protocol exhaustiveness
  switches extended (they caught both new messages at compile time,
  as designed).
- Full suite + typecheck: **1,218 passed, 111 files, 1 skipped** (SST
  corpus, as always), typecheck clean on all three configs. The new
  baseline, up from 1,210. The TAN integration suites ran with the new
  `mouse# ` prompts and held — the prompt-suffix matching survived the
  one regression risk this change carried.

**Not verified here, honestly:** no integration test yet drives a real
guest's `urlget` against the control endpoint end-to-end (that needs a
booted ELKS + ktcp, ~90 s of suite time — worth adding if the field
finds anything). Field verification is the acceptance, as usual. The
`mouse# ` prompt change rides through the existing TAN integration
tests — they match prompt suffixes, and the full suite is the proof.

## 3. Where this leaves the handover (brief addendum E/F/G)

- E (editor seam): settled design — the editor edits the SAME drive
  the guest builds on; host-side MINIX-fs utility is the enabling
  piece; floppy-passing coherence. Recorded, not built.
- F (this): built.
- G (system-level editor, CodeJar vendored under MIT — Jonathan's
  rule-2 authorization, "MIT all the way"): scoped, next.
