/**
 * Main-thread bootstrap for the browser harness.
 *
 * - Loads user settings (font size, theme, default image source).
 * - Constructs an xterm.js Terminal with the configured font + theme.
 * - Resolves the image source against the IDB image library; if the user's
 *   stored library reference no longer exists, silently falls back to the
 *   bundled image and persists the corrected setting.
 * - Spawns the emulator worker.
 * - Wires worker → terminal (`tx` → `term.write(bytes)`) and terminal →
 *   worker (`term.onData` → `rx` postMessage).
 * - Posts boot config carrying either `imageBytes` (library entry, read
 *   from IDB) or `imageUrl` (bundled).
 * - Mounts the settings modal and listens for live settings changes.
 *
 * Phase 9.1 closed the early-printk dead window (BIOS INT 10h teletype
 * traffic flows through the same shared TX buffer the UART feeds, so the
 * ELKS Setup banner streams from the first batch). Phase 9.2 (this file)
 * adds the user-facing settings/library shell on top of that wiring; the
 * worker host is unchanged.
 */

// `import.meta.hot` types for the M2.5 agent-bridge block. File-local so
// every tsconfig that sweeps this file up (tsconfig.test.json includes
// web/**) sees them, not just tsconfig.web.json's `types` array.
/// <reference types="vite/client" />

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import type {
  BootConfig,
  MainToWorkerMessage,
  WorkerToMainMessage,
} from '../src/browser/protocol.js';
import {
  loadSettings,
  saveSettings,
  validateImageSourceAgainstLibrary,
  SETTINGS_CHANGED_EVENT,
  type ImageSource,
  type Settings,
} from './settings.js';
import { THEMES } from './themes.js';
import { ImageLibrary } from './image-library.js';
import { mountSettingsModal } from './settings-modal.js';

const BUNDLED_IMAGE_URL = '/elks-serial.img';

async function init(): Promise<void> {
  const container = document.getElementById('terminal');
  if (!container) {
    throw new Error('main.ts: missing #terminal container');
  }

  // Settings are read synchronously up-front. Library validation is async
  // and runs after the library is opened — we still want the terminal to
  // mount with the user's chosen font/theme immediately.
  let settings = loadSettings();

  const term = new Terminal({
    cursorBlink: false,
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
    fontSize: settings.fontSize,
    theme: THEMES[settings.themeName],
    convertEol: false,
    scrollback: 10_000,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();
  window.addEventListener('resize', () => {
    try { fit.fit(); } catch { /* ignore — first paint can race resize */ }
  });

  // Live settings updates: re-apply font + theme to the running terminal.
  // Image-source changes are intentionally ignored here — those take effect
  // on next reload (don't try to hot-swap a running emulator's disk).
  document.addEventListener(SETTINGS_CHANGED_EVENT, (e) => {
    const next = (e as CustomEvent<Settings>).detail;
    settings = next;
    term.options.fontSize = next.fontSize;
    term.options.theme = THEMES[next.themeName];
    // Font size change → cell grid changes → fit to container so text
    // doesn't overflow the previous geometry. Per the brief's "watch out
    // for" note: xterm.js does NOT auto-fit on font change.
    try { fit.fit(); } catch { /* ignore — addon may not be ready */ }
  });

  const library = new ImageLibrary();

  // Resolve image source against the library before showing the boot banner
  // so the banner reflects the source we're actually about to boot. If a
  // stale reference is fixed up here, the user sees the corrected text and
  // boots from bundled — no boot-fails-silently mystery. Same pattern
  // applies to the (optional) secondary disk: a stale id silently drops
  // back to no-secondary.
  settings = await validateImageSourceAgainstLibrary(
    settings,
    (id) => library.hasImage(id),
  );

  const sourceLabel = await describeImageSource(library, settings.imageSource);
  term.writeln('emu86 — ELKS in the browser');
  term.writeln(`Image: ${sourceLabel}`);
  if (settings.secondaryImageSource !== null) {
    const secondaryLabel = await describeImageSource(library, settings.secondaryImageSource);
    term.writeln(`Secondary: ${secondaryLabel}`);
  }
  term.writeln('Booting...');
  term.writeln('');

  // Vite picks up the worker via the `new URL(...) + { type: 'module' }`
  // pattern — keeps imports type-checked and lets the bundler emit the
  // worker as a separate chunk.
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'emu86-worker',
  });

  worker.addEventListener('message', (event: MessageEvent<WorkerToMainMessage>) => {
    const msg = event.data;
    if (msg.type === 'tx') {
      term.write(msg.bytes);
      return;
    }
    if (msg.type === 'ready') {
      // Boot started. The ELKS Setup banner (BIOS INT 10h teletype)
      // and the post-set_console UART traffic both stream via `tx`
      // messages — see worker-host.ts shared txBuffer.
      return;
    }
    if (msg.type === 'halted') {
      term.writeln('');
      term.writeln(`[emu86: halted — ${msg.reason}]`);
      return;
    }
    if (msg.type === 'error') {
      term.writeln('');
      term.writeln(`[emu86: error — ${msg.message}]`);
      if (msg.stack) {
        for (const line of msg.stack.split('\n')) term.writeln(line);
      }
      return;
    }
  });

  const encoder = new TextEncoder();
  term.onData((data: string) => {
    const bytes = encoder.encode(data);
    const msg: MainToWorkerMessage = { type: 'rx', bytes };
    worker.postMessage(msg);
  });

  // Phase 14 M2.5 — dev-only agent bridge. The HMR channel doubles as a
  // control pipe: worker TX is mirrored to the dev server (curl GET
  // /agent/transcript) and `emu86:rx` events arrive as keystrokes (curl
  // POST /agent/rx). See the plugin in vite.config.ts. Production
  // builds drop this whole block (`import.meta.hot` is undefined).
  if (import.meta.hot) {
    const hot = import.meta.hot;
    const decoder = new TextDecoder();
    worker.addEventListener('message', (event: MessageEvent<WorkerToMainMessage>) => {
      const msg = event.data;
      if (msg.type === 'tx') {
        hot.send('emu86:tx', { text: decoder.decode(msg.bytes) });
      }
    });
    hot.on('emu86:rx', (data: { text?: unknown }) => {
      if (typeof data?.text !== 'string' || data.text.length === 0) return;
      const msg: MainToWorkerMessage = { type: 'rx', bytes: encoder.encode(data.text) };
      worker.postMessage(msg);
    });
  }

  // Resolve the actual bytes from either the library (Uint8Array) or the
  // bundled URL (worker fetches). Using `imageBytes` for library entries
  // keeps the worker source-agnostic — matches Option A in the brief's
  // Section 6.
  const boot = await buildBootMessage(
    library,
    settings.imageSource,
    settings.secondaryImageSource,
  );
  worker.postMessage(boot);

  // Mount the settings UI. `bootedFrom` and `bootedSecondary` capture the
  // sources that are actually running, so the modal can render
  // "Reload to apply" notices when the user picks different ones.
  mountSettingsModal({
    library,
    getSettings: () => settings,
    onChange: (next) => {
      settings = next;
      saveSettings(next);
    },
    bootedFrom: settings.imageSource,
    bootedSecondary: settings.secondaryImageSource,
  });

  // Page unload cleans up workers automatically; no manual teardown needed.
}

async function buildBootMessage(
  library: ImageLibrary,
  source: ImageSource,
  secondary: { kind: 'library'; id: string } | null,
): Promise<MainToWorkerMessage> {
  // Primary slot — current behaviour: bundled URL or library bytes.
  const config: BootConfig = source.kind === 'library'
    ? { imageBytes: await library.getImageBytes(source.id) }
    : { imageUrl: BUNDLED_IMAGE_URL };

  // Secondary slot — Phase 11. Only library entries reach here (the
  // bundled image is a boot image, never a secondary). The worker host's
  // size table infers the class. Failure to read the secondary's bytes is
  // surfaced to the caller; partial-success boot would leave the user
  // confused about why /dev/hdb didn't appear.
  if (secondary !== null) {
    const bytes = await library.getImageBytes(secondary.id);
    config.secondary = { imageBytes: bytes };
  }
  return { type: 'boot', config };
}

async function describeImageSource(
  library: ImageLibrary,
  source: ImageSource,
): Promise<string> {
  if (source.kind === 'bundled') return `${BUNDLED_IMAGE_URL} (bundled)`;
  try {
    const all = await library.listImages();
    const hit = all.find((m) => m.id === source.id);
    return hit ? `library: ${hit.name}` : `library: ${source.id}`;
  } catch {
    return `library: ${source.id}`;
  }
}

void init();
