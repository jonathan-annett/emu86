import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
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

/**
 * Phase 14 M2.5 — agent bridge (dev server only; Jonathan's idea,
 * 2026-07-13).
 *
 * Lets an agent (or any script) drive the browser-hosted machine over
 * plain HTTP, using the dev server's existing HMR WebSocket as the
 * transport — zero new dependencies, and none of this exists in a
 * production build.
 *
 *   POST /agent/rx           body text is injected into the emulator
 *                            as keystrokes (remember the trailing \n)
 *   GET  /agent/transcript   cumulative UART output as text/plain
 *
 * The page side (web/main.ts, inside `if (import.meta.hot)`) forwards
 * worker `tx` bytes up as `emu86:tx` custom events and injects
 * `emu86:rx` events as worker keystrokes. This is a TEXT pipe (UTF-8
 * both ways), fit for terminal traffic — binary extraction stays on
 * the probe-harness path.
 *
 * With several tabs open, every tab receives `/agent/rx` input and all
 * tabs' output lands in one transcript — keep one tab per dev server.
 */
function emu86AgentBridge(): Plugin {
  let transcript = '';
  const TRANSCRIPT_CAP = 1_000_000;
  const RX_BODY_CAP = 65_536;
  return {
    name: 'emu86-agent-bridge',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.ws.on('emu86:tx', (data: { text?: unknown }) => {
        if (typeof data?.text !== 'string') return;
        transcript += data.text;
        if (transcript.length > TRANSCRIPT_CAP) {
          transcript = transcript.slice(-Math.floor(TRANSCRIPT_CAP / 2));
        }
      });
      server.middlewares.use('/agent/rx', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST keystroke text to this endpoint\n');
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => {
          if (body.length < RX_BODY_CAP) body += chunk.toString('utf8');
        });
        req.on('end', () => {
          server.ws.send('emu86:rx', { text: body });
          res.setHeader('content-type', 'text/plain');
          res.end(`sent ${body.length} chars\n`);
        });
      });
      server.middlewares.use('/agent/transcript', (_req, res) => {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(transcript);
      });
    },
  };
}

export default defineConfig({
  plugins: [emu86AgentBridge()],
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
    proxy: {
      // Dev mirror of the production worker's /gh-assets CORS proxy
      // (deploy/cf-worker.ts) so the release-image download path behaves
      // identically on localhost. followRedirects makes the proxy chase
      // github.com → release-assets.githubusercontent.com itself; the
      // browser only ever sees a same-origin response.
      '/gh-assets': {
        target: 'https://github.com',
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path: string) => path.replace(/^\/gh-assets/, ''),
      },
    },
  },
});
