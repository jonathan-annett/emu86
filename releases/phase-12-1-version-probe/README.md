# emu86 Phase 12.1 / 13.1 — Probe Harness Extension + HD32 Version Probe

This snapshot pins the state of `emu86` at the close of Phase 12.1
(probe harness extension) and Phase 13.1 (HD32 version probe).

**Outcome A — in-VM compile is VIABLE.** All seven Dev86-shaped
binaries on `hd32-minix.img` execute and self-identify under the
version-flag probe. Phase 14 reverts to the user's originally-stated
in-VM dogfooding arc — build the NE2000 driver inside ELKS using the
on-disk `c86` / `as` / `ld` toolchain.

See `PROBE_HARNESS_EXTENSION_REPORT.md` in the parent repo for the
full report (per-binary classifications, captured output, Phase 14
recommendation, and verification commands).

## Layout

```
phase-12-1-version-probe/
├── README.md                              — this file
├── package.json                           — dep snapshot
├── package-lock.json
├── dist-cli/                              — Node-side build (CLI tools + tests)
├── dist-web/                              — browser bundle (worker-built)
└── reference/
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img          — Phase 11.6 baseline
    │   └── fd1440-minix-serial.img        — Phase 12 trivial probe primary
    ├── elks-images/
    │   └── fd1440-minix.img               — Phase 13 fully-surveyed
    └── elks-images-hd/
        ├── hd32-fat.img                   — Phase 13 partial-survey corroboration
        └── hd32-minix.img                 — **Phase 13.1 version-probe target**
```

`node_modules/` is not copied; reinstall from the snapshot's
`package-lock.json` via `npm ci`.

## What changed since Phase 13

### Probe harness (Phase 12.1)

`tests/probe/probe-harness.ts` (test infrastructure, not part of
`dist-cli` / `dist-web`):

- `ProbeRequest.bootInstructionBudget?: number` — caller-configurable
  boot-phase instruction budget. Default raised from a hard-coded
  8M to **32M** so HD images boot under the harness without
  per-call overrides.
- `ProbeResult.timeoutPhase: 'boot' | 'probe' | null` — distinguishes
  "boot didn't reach a `# ` prompt" from "probe didn't reach the
  sentinel". `null` on success.
- `inferGeometry()` exported and extended to accept the HD32-MBR
  size (`32,546,304` bytes) with the correct `64×16×63` capacity,
  plus both HD64 sizes (`67,107,840` and `67,140,096` bytes) at
  `131×16×63`.

### Version probe (Phase 13.1)

New modules in `tests/probe/`:

- `version-probe.ts` — pure classifier and shell-script builder.
  19 unit tests in `version-probe.test.ts`.
- `surveys/hd32-version-probe.ts` — orchestration on top of
  `runProbe()`.
- New integration test at `tests/integration/hd32-version-probe.test.ts`.

## Verification

Run from this snapshot directory.

### Serial harnesses still boot to `# `

```
$ node dist-cli/tools/elks/run-serial.js \
    reference/elks-images-serial/fd1440-minix-serial.img
```

(Reaches the `# ` prompt; press Ctrl-C to exit. No regression vs
Phase 12 / 13 — same primary, same UART RX/TX flow.)

```
$ node dist-cli/tools/elks/run-serial.js \
    reference/elks-images-serial/fd1440-fat-serial.img
```

(Same.)

### Browser bundle loads

`dist-web/index.html` plus the two hashed assets
(`assets/index-*.js` and `assets/worker-*.js`) load when the
directory is served as a static site.

### Version-probe integration test

The version-probe tests live in `tests/probe/` and
`tests/integration/` of the source repo, not in `dist-cli/`.
Re-running them against this snapshot's fixtures requires:

```
$ cd <repo-root>
$ npx vitest run tests/integration/hd32-version-probe.test.ts
```

with `reference/elks-images-hd/hd32-minix.img` in place — which it
is, both in the snapshot and in the project root. The test passes
with the **`in-vm-viable`** verdict and all seven binaries
classified `works`.

## Per-binary version-probe findings (snapshot)

| Binary | Status | Summary line |
|---|---|---|
| `c86`     | **works** | `c86 v5.2.0 (dev) (22 Dec 2024)` |
| `cpp`     | **works** | `CPP Unknown option -v` |
| `as`      | **works** | `as86 v0.16.21` |
| `ld`      | **works** | `ld86 version: 0.17.00` |
| `make`    | **works** | `Usage: make [-f makefile] [-inpqrst] ...` |
| `ar`      | **works** | `Usage: ar [d|m|p|q|r|t|x ...]` |
| `objdump` | **works** | `Usage objdump [-s][-d][-n] ...` |

`hd32mbr-minix.img` is NOT included in this snapshot (consistent
with Phase 13's choice). Phase 12.1 unblocked its geometry, but the
brief's scope kept it out of the Phase 13.1 verification.
