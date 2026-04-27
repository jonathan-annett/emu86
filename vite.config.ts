import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Vite config for the browser harness.
 *
 * - `root: web/` — the entry HTML and main-thread script live there. Using
 *   a sub-directory keeps Vite from scooping up `tools/` and `tests/`.
 * - `build.outDir: ../dist-web/` — Phase-9 release snapshot copies this
 *   tree directly into the release folder.
 * - `node:fs` alias — `src/disk/disk.ts` imports from `node:fs` for the
 *   NodeFileDisk class. The browser bundle doesn't use NodeFileDisk (we
 *   use InMemoryDisk), but Rollup needs the import target to exist with
 *   the expected named exports. We alias `node:fs` to a small throwing-
 *   stub module so unused references compile cleanly and any accidental
 *   runtime call surfaces immediately.
 *
 * Worker bundling: `new Worker(new URL('./worker.ts', import.meta.url),
 * { type: 'module' })` is Vite's recommended pattern — emits the worker
 * as a separate chunk while keeping TypeScript happy.
 */

const nodeFsStub = fileURLToPath(new URL('./web/stubs/node-fs.ts', import.meta.url));

export default defineConfig({
  root: 'web',
  base: './',
  publicDir: 'public',
  resolve: {
    alias: [
      { find: /^node:fs$/, replacement: nodeFsStub },
    ],
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
