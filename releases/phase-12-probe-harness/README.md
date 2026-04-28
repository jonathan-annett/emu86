# emu86 — Phase 12 release: Probe Harness

Self-contained snapshot of the Phase 12 deliverable. This phase
ships **infrastructure**, not a feature: a reusable test-side
harness — `runProbe()` — that boots ELKS in our emulator, mounts
a freshly-built FAT12 floppy with a probe script on it, runs the
script, and captures its stdout. The trivial probe
(`echo hello-from-probe`) round-trips end-to-end in ~6.5 s as
proof the harness works; Phase 13 (toolchain survey) is the
first real user.

For the full diagnosis (FAT12 choice, ELKS mount semantics,
sentinel design, image-construction approach), see
`PROBE_HARNESS_REPORT.md` in the repo root.

```
phase-12-probe-harness/
├── README.md                              # this file
├── package.json                           # copy of root manifest
├── package-lock.json                      # copy of root lockfile
├── dist-cli/                              # compiled Node CLI tools
│   └── tools/
│       ├── elks/{run.js, run-serial.js, secondary-disk.js}
│       └── elks-build/{build-serial-image.js, fetch-hd-image.js}
├── dist-web/                              # Vite production bundle
│   ├── index.html
│   └── assets/{index,worker}-*.{js,css}
└── reference/
    ├── elks-images-serial/
    │   ├── fd1440-fat-serial.img          # Phase 8 baseline
    │   └── fd1440-minix-serial.img        # Phase 11.6 — the canonical probe primary
    ├── elks-images/fd1440-minix.img       # source for the serial-MINIX image
    └── elks-images-hd/{hd32-fat.img, hd32-minix.img}
```

`node_modules/` is **not** copied. The release shares the repo
root's installed dependencies; run from inside the release folder
once the root has `npm install`-ed.

## What's new vs Phase 11.6

The harness lives entirely under `tests/probe/` and isn't part of
the compiled CLI — it's vitest-driven test infrastructure. So the
snapshot's `dist-cli/` and `dist-web/` are byte-equivalent to
Phase 11.6's; Phase 12 adds:

- `tests/probe/probe-disk.ts` — pure-TypeScript FAT12 floppy
  builder. Produces deterministic byte images.
- `tests/probe/probe-harness.ts` — `runProbe(req)` plus parsing
  helpers (`buildLaunchLine`, `extractProbeStdout`,
  `PROBE_SENTINEL`).
- `tests/probe/probe-disk.test.ts` — 9 unit tests on the FAT12
  writer.
- `tests/probe/probe-harness.test.ts` — 9 unit tests on the
  parsing logic (synthetic transcripts, no boot).
- `tests/integration/probe-harness-trivial.test.ts` — 1 end-to-
  end test that exercises the full pipeline.

Test count: **1,255 → 1,274** (+19). All Phase 1-11.6 tests still
pass.

## How to use the harness (next-up Phase 13 example)

```ts
import { runProbe } from './tests/probe/probe-harness.js';

const result = await runProbe({
  primaryImage: 'reference/elks-images-serial/fd1440-minix-serial.img',
  probe: {
    filename: 'survey.sh',
    script: [
      'cd /usr/bin',
      'ls',
    ].join('\n') + '\n',
  },
  timeoutInstructions: 80_000_000,
});

console.log(result.stdout);
```

Returns the exact bytes the script wrote to stdout, with the
boot-time output and the sentinel echo stripped.

## Verification

The release was launch-verified by:

```
$ npm test
…
 Test Files  76 passed (76)
      Tests  1274 passed (1274)
   Duration  334.33s

$ npm run typecheck
(clean)

$ npx vitest run tests/integration/probe-harness-trivial.test.ts
 ✓ tests/integration/probe-harness-trivial.test.ts (1 test) 6580ms
```

The boot-loop sanity checks (running `dist-cli/tools/elks/run-serial.js`
against both serial images, reaching `# `) inherit from Phase 11.6
— the dist-cli bytes haven't changed since.
