# emu86 — Phase 13 release: Toolchain Survey

Self-contained snapshot of the Phase 13 deliverable. This phase
ships **evidence and a recommendation**, not new infrastructure:
the Phase 12 probe harness was used to survey published ELKS
v0.9.0 images for self-hosted compilers, and the findings shape
how Phase 14 (NE2000 driver dogfooding) starts.

For the full survey, see `TOOLCHAIN_SURVEY_REPORT.md` in the repo
root. **Outcome C** (survey blocked by infrastructure): the
harness's hardcoded 8M-instruction boot budget and the geometry
inferer reject the candidate set before the survey can complete
on most images. The HD32 surveys captured enough partial data to
identify the dev86 toolchain in `/usr/bin/`, but full version-
flag verification is deferred.

```
phase-13-toolchain-survey/
├── README.md                              # this file
├── package.json                           # copy of root manifest
├── package-lock.json                      # copy of root lockfile
├── dist-cli/                              # compiled Node CLI tools
│   └── tools/
│       ├── elks/{run.js, run-serial.js, secondary-disk.js}
│       └── elks-build/{build-serial-image.js, fetch-hd-image.js}
├── dist-web/                              # Vite production bundle
│   ├── index.html
│   ├── elks-serial.img
│   └── assets/{index,worker}-*.{js,css}
└── reference/
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img          # Phase 8 baseline
    │   └── fd1440-minix-serial.img        # the canonical probe primary
    ├── elks-images/fd1440-minix.img       # source for the serial-MINIX image
    └── elks-images-hd/
        ├── hd32-fat.img                   # surveyed (boot timed out at 8M)
        └── hd32-minix.img                 # surveyed (boot timed out at 8M)
```

`node_modules/` is **not** copied. The release shares the repo
root's installed dependencies; run from inside the release folder
once the root has `npm install`-ed.

The `hd32mbr-*.img` images are **not** included — the harness's
`inferGeometry()` rejects their 32546304-byte size against the
hd32 32514048-byte CHS geometry. This is one of the deferred
infrastructure findings (see report § "Things future briefs
should address").

## What's new vs Phase 12

Phase 12 shipped the harness; Phase 13 is its first real user.
The deliverable is the report, not new code. What landed in the
repo:

- `tests/probe/surveys/survey-runner.ts` — orchestration. Builds a
  `/bootopts` blob with `init=/bin/sh -c "<script>"`, applies it
  to a copy of the candidate image, runs the harness, parses the
  captured transcript. Handles partial-data extraction when the
  boot budget runs out before the script's `__E__` sentinel.
- `tests/probe/surveys/parse-binary-listing.ts` — turns `ls -la`
  output into a structured `BinaryListing` with compiler-shape
  detection.
- `tests/probe/surveys/parse-version-output.ts` — classifies
  per-compiler version-flag responses as `working` / `broken` /
  `missing`.
- `tests/probe/surveys/*.test.ts` — 11 unit tests (synthetic
  transcripts, no boot).
- `tests/integration/toolchain-survey.test.ts` — 5 candidates,
  one test each, 5-minute test timeout.
- `TOOLCHAIN_SURVEY_REPORT.md` (repo root) — the deliverable.

Test count: **1,274 → 1,294** (+20). All Phase 1-12 tests still
pass.

## Survey outcome

| Image | Boots? | Compilers found | Status |
|---|---|---|---|
| `fd1440-minix.img` | yes (full) | 0 | `no-compilers` — 138 binaries enumerated, none compiler-shaped |
| `fd1440-fat.img` | partial | 0 (in seen prefix) | `boot-failed` — 26 entries captured before 8M timeout |
| `hd32-minix.img` | partial | 8 (dev86: c86, cpp, as, ld, make, ar, objdump, …) | `boot-failed` — 138 entries before timeout, version-check phase not reached |
| `hd32-fat.img` | partial | 7 (same dev86 set) | `boot-failed` — 27 entries before timeout |
| `hd32mbr-minix.img` | n/a | n/a | `boot-failed` — harness `inferGeometry()` rejects the 32546304 B size |

**Recommendation for Phase 14:** defer in-VM dogfooding. Use
host-cross-compile + probe-disk deployment for the NE2000 driver
work, targeting `hd32-minix.img` if a Phase 12.x follow-up
extends the harness's boot budget and geometry support. The
dev86 toolchain is present in the HD32 images but the harness
can't verify it executes within the current budget.

## How to use this snapshot

The snapshot is self-contained at the level of compiled artifacts;
runtime deps come from the repo root. From the repo root:

```bash
npm install
cd releases/phase-13-toolchain-survey

# Boot the canonical serial primary (CGA via 0xB8000 framebuffer)
node dist-cli/tools/elks/run.js \
  --primary reference/elks-images-serial/fd1440-minix-serial.img

# Boot via UART (serial console)
node dist-cli/tools/elks/run-serial.js \
  --primary reference/elks-images-serial/fd1440-minix-serial.img
```

The browser harness is `dist-web/index.html` — serve the
directory with any static server (e.g. `python3 -m http.server`)
and load it.

## Verification

This snapshot was launch-verified manually before shipping. See
the **Verification** section of `TOOLCHAIN_SURVEY_REPORT.md` for
the exact commands and outputs.
