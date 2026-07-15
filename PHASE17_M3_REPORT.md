# Phase 17 M3 Report — the stamp set and the un-typed boot

2026-07-15, same session as M1+M2, with Jonathan designing
in-session: Addendum B was drafted from recon, he countered with the
fork-layout design ("mount /dev/hdb as /home and on first boot add
/home/root (empty) and /home/user1 with .profile … hello.sh"), chose
the typed show ("the typing relay minus the cheezy sound fx"),
resolved D2's caveat, and killed the blank-drive button (D5). Scope:
brief §3 M3 as revised by §4.7 Addendum B.

## 0. TL;DR

**Reload → `mouse$` prompt, net up, /home mounted, NOTHING typed.**
A brand-new tab now boots a machine that formats its own home drive,
seeds it (`/home/root`, `/home/user1` with `.profile` + `hello.sh`),
logs in as user1 with no prompt, and plays the hello-human compile
show ONCE per drive through the boot-script typing relay with the
key-click silenced. The next reload: no show, network up at sysinit,
the drive's `.profile` sourced — the tab's drive carries its own
boot behavior (brief §1.5, delivered). Autologin is a settings
3-way (off / root / user1, default user1); `autoNet` is a checkbox
(default on). The typed seed script is now a demo prop, exactly as
§1.5 predicted.

## 1. What was built (files)

- `src/browser/image-stamps.ts` (new): the stamp set, minix-fs on
  the folded+patched primary, applied per-boot pre-wrapper (stamps
  never enter the overlay hot map): passwd home surgery (root →
  /home/root, user1 → /home/user1; toor keeps /root), the inittab
  ttyS0 line (ours-per-boot: `exec /bin/login user1|root`, or the
  stock getty for 'off'), `/etc/skel.profile` + `/etc/skel.hello`
  (per-boot seeds), `/etc/home.sh` (per-boot, current drive's block
  count baked into its mkfs line), and the ONE marker-guarded
  stamp — mount.cfg gains a size-free `test -f /etc/home.sh && sh
  /etc/home.sh` (guest edits win thereafter, brief §1.4). Also
  `showPending()`: the worker reads the SECONDARY's bytes pre-boot
  (unformatted, or /user1 absent, or .welcome present ⇒ the show
  will fire this boot).
- `src/browser/worker-host.ts`: the secondary now resolves BEFORE
  the primary (its size and show-state feed the primary's stamps);
  `net=ne0` rides the existing bootopts patch's extraLines when
  `autoNet && !showPending` — the recorded 640K constraint
  (ktcp+telnetd+ftpd vs c86 compiling) made Jonathan's "unless that
  messes up build" a hard gate, so the show boot never stages net.
- `src/browser/protocol.ts`: `BootConfig.autologin` / `autoNet`.
  ABSENT autologin = no stamps at all — every existing test and CLI
  boot keeps untouched images.
- `web/settings.ts`: `autologin` (default 'user1') + `autoNet`
  (default true), additive fields, no key bump; seed script rev 3
  (mount + ping lines dropped — §4.3 executed).
- `web/settings-modal.ts`: "Console login" section (3-way select +
  autoNet checkbox); the "Create blank drive" button is GONE (D5),
  replaced by a hint pointing at `?mkdrive` (+ note that the fresh
  drive formats itself at next boot).
- `web/main.ts`: boot config carries the two fields; the show
  relay — the fork's seeded `.profile` emits
  `[[emu86:hello-human]]` once per drive, main spots it in TX and
  runs the landing demo's ceremony (minus its login/net lines)
  through a dedicated AutoexecRunner with NO onKeystroke (the
  runner's default is silent keys) and a set-speed restore onDone.

## 2. Decisions and findings recorded

- **user1's home became /home/user1 on the DRIVE** (Jonathan's
  fork-layout counter-design). The earlier plan (home = /home
  itself) died for a good reason found in recon: /home on the base
  is root-owned 0755, and a guest-mkfs'd fork root is root-owned
  too — user1 could not write its own $HOME. The populate step
  (running as root at sysinit) mkdirs and chowns REAL homes
  instead. Proven in the field-shaped test: user1's own shell
  consumed .welcome — write access confirmed, no chmod-777 hack.
- **`chown user1 <paths>` works in ELKS sh** (it was an open risk —
  name-based chown; the integration pass settles it).
- **Show-once state rides the DRIVE, not the overlay** (.welcome on
  the fork): factory reset alone does not replay the show; a fresh
  drive does — "a new drive is a new user's first day". Supersedes
  §4.6's "factory reset resurrects", accepted by Jonathan with the
  design.
- **The show boot suppresses net=ne0 by READING THE DRIVE**, not by
  guessing from overlay state: `showPending()` opens the secondary
  bytes pre-boot. Precise across mkdrive swaps, mismatched
  overlays, and promoted bases.
- **FINDING — `cat /bootopts` lies, and always has**: the Phase 14
  serial-console patch is a raw 1024-byte block write; the KERNEL
  reads the whole block (that is why it works), but the file's
  inode still says 692 bytes, so any fs read — guest cat, our own
  minix-fs — sees only the pristine prefix and none of the stamped
  lines. Cost this milestone an hour of ghost-hunting when the
  integration test probed via cat; the honest probe is behavioral
  (`Starting networking` from rc.sys). Pre-existing since Phase 14,
  harmless to the machine, recorded here. A future nicety could
  have the patch update the inode size via minix-fs — NOT done (out
  of scope, and guests re-reading /bootopts is a corner none of our
  flows touch).
- **Autologin respawn semantics**: `exit` in the autologin shell
  respawns a fresh login shell (nice REPL feel); init disables
  respawn only for a line that exits <3 s after its FIRST spawn
  (init.c:457) — theoretical console-death edge, noted, not
  mitigated.
- **The stale-mkfs-size edge died by design**: /etc/home.sh is
  per-boot ours (bootopts-block semantics) so the baked block count
  is always this boot's drive; only the one-line mount.cfg call is
  marker-guarded.

## 3. Honest limits

- **The show's typed look is field-untested.** The relay mechanics
  are the landing demo's (field-proven), but the M3 integration
  test sees the marker, not the performance (no main thread in
  worker tests). M4's field pass owns the aesthetic verdict —
  including whether the ceremony reads well at authentic speed
  after autologin's instant landing.
- **`login:` on tty1 still exists** (runlevels 1356 getty) — on the
  invisible CGA console. Nothing typed on SERIAL, which is the
  machine users see.
- **A guest that deletes /etc/home.sh's caller line** (the mount.cfg
  marker block) owns that choice forever — mount/populate stop; the
  drive still auto-persists. Convergence semantics, per brief.
- **autoNet=on + autologin=off**: net=ne0 stamps whenever the show
  isn't pending, including with autologin off — the stock getty
  boot gets net up untyped too. Judged coherent (the toggle says
  what it does), flagging that the combination exists.
- **The M1-era ensureOverlayId fallback in main.ts** now only
  matters on the degraded resolve-threw path; harmless, left as is.

## 4. What was verified

- `tests/unit/image-stamps.test.ts` (9) — real surgery on a copy of
  the committed hd32 image: passwd field-exactness (root/user1
  moved, toor and all other fields byte-stable, line count stable),
  inittab mode matrix incl. off-restores-stock, per-boot home.sh
  size refresh vs marker-guarded mount.cfg (exactly one marker after
  two applies), byte-level idempotence of a second identical apply,
  non-MINIX skip-all, showPending truth table on the 2 MB fixture.
- `tests/integration/untyped-boot.test.ts` (1 test, 3 boots,
  ~50 s) — the §4.6 acceptance: blank 8086 KB fork boots to a
  `$` prompt with NOTHING typed (no `login:`/`Password` on serial),
  HOME=/home/user1 USER=user1, marker emitted; drive snapshot shows
  mkfs'd fs with /user1/.profile + hello.sh present and .welcome
  CONSUMED (user1-writability proven); no `Starting networking` on
  the show boot. Boot 2 same drive: marker absent, `Starting
  networking` present, home intact. Boot 3 autologin=root:
  HOME=/home/root, `sync; fsck /dev/hda` silent — the oracle
  passing the host's stamp surgery.
- `tests/unit/settings.test.ts` — new fields ride every literal;
  defaults verified via DEFAULT_SETTINGS equality.
- Typecheck clean across all three configs.
- **Full suite: 1,338 passed / 124 files / 1 skipped — the new
  baseline** (was 1,328 / 122 after M2).

## 5. Pointer for M4

Field acceptance owns: the show's look (typed ceremony after
autologin — pacing, the marker line's visibility on screen), the
first-boot wait (mkfs at sysinit adds a beat before the prompt),
`exit`-respawn feel, the mismatch/reset flows end-to-end on the dev
tier, and the label fix (ac7280f) riding this deploy. The boot-script
system still exists untouched; §4.6's end state (removing keystroke
injection entirely) stays a LATER phase, gated on the landing demo
moving off it.
