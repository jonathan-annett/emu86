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

/** Build stamp injected by vite define — see buildStamp() in vite.config.ts. */
declare const __EMU86_BUILD__: string;

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
// Bundled by Vite (dev and build alike) — see the note in index.html
// for why this must NOT be a <link> tag.
import '@xterm/xterm/css/xterm.css';

import type {
  BootConfig,
  BootMessage,
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
import { AutoexecRunner } from './autoexec.js';
import { createKeyClick } from './keyfx.js';
import { loadSession, saveSession } from './session-store.js';
import { SEED_BOOT_SCRIPT, SEED_DEMO_SCRIPT } from './settings.js';
import { listReleases, downloadAsset } from './github-releases.js';

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

  // Landing showcase: profiles stored before the demo script was
  // seeded gain it here (id-keyed; absent-only, so user edits win).
  if (!settings.bootScripts.some((s) => s.id === SEED_DEMO_SCRIPT.id)) {
    settings = {
      ...settings,
      bootScripts: [...settings.bootScripts, SEED_DEMO_SCRIPT],
    };
    saveSettings(settings);
  }

  const sourceLabel = await describeImageSource(library, settings.imageSource);
  const buildLabel = import.meta.env.DEV ? `${__EMU86_BUILD__} · dev-server` : __EMU86_BUILD__;
  term.writeln(`emu86 — ELKS in the browser [${buildLabel}]`);
  term.writeln(`Image: ${sourceLabel}`);
  if (settings.secondaryImageSource !== null) {
    const secondaryLabel = await describeImageSource(library, settings.secondaryImageSource);
    term.writeln(`Secondary: ${secondaryLabel}`);
  }
  const activeScript = settings.bootScripts.find(
    (s) => s.id === settings.activeBootScriptId,
  );
  if (activeScript !== undefined) {
    term.writeln(`Boot script: ${activeScript.name}`);
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

  // Latest pacing stats (worker posts ~1/sec) — read by the console
  // logger below and the dev agent bridge's /agent/stats endpoint.
  let latestStats: WorkerToMainMessage & { type: 'stats' } | null = null;

  // Boot script (Phase 14 — autoexec): a prompt-aware runner types the
  // active script into the console as the guest becomes ready. Fed from
  // the same TX stream the terminal renders; sends through the same rx
  // path as the keyboard, so the M2.5 FIFO pacing applies. Clackety
  // (@type) keystrokes get a synthesized click; @turbo/@authentic post
  // live speed changes (session-scoped — the stored setting is not
  // touched).
  const txDecoder = new TextDecoder();
  const keyClick = createKeyClick();
  const autoexec = activeScript !== undefined
    ? new AutoexecRunner({
        script: activeScript.text,
        send: (text) => {
          const msg: MainToWorkerMessage = {
            type: 'rx',
            bytes: new TextEncoder().encode(text),
          };
          worker.postMessage(msg);
        },
        onKeystroke: keyClick,
        setSpeed: (mode) => {
          const msg: MainToWorkerMessage = { type: 'set-speed', mode };
          worker.postMessage(msg);
        },
      })
    : null;

  worker.addEventListener('message', (event: MessageEvent<WorkerToMainMessage>) => {
    const msg = event.data;
    if (msg.type === 'tx') {
      term.write(msg.bytes);
      if (autoexec !== null && autoexec.active) {
        autoexec.feed(txDecoder.decode(msg.bytes, { stream: true }));
        // One-night-only act (Jonathan, 2026-07-15): when the landing
        // show finishes its run, demote the active script to the plain
        // network one-liner so reloads get a working machine, not a
        // rerun. Only the demo self-retires — a user-chosen script
        // keeps replaying, as before.
        if (!autoexec.active && activeScript?.id === SEED_DEMO_SCRIPT.id) {
          settings = { ...settings, activeBootScriptId: SEED_BOOT_SCRIPT.id };
          saveSettings(settings);
        }
      }
      return;
    }
    if (msg.type === 'ready') {
      // Boot started. The ELKS Setup banner (BIOS INT 10h teletype)
      // and the post-set_console UART traffic both stream via `tx`
      // messages — see worker-host.ts shared txBuffer.
      return;
    }
    if (msg.type === 'tan-identity') {
      // Sticky IP: persist the settled octet so the next reload offers
      // it back to the lease; tell the user where they live.
      saveSession({ tanHostOctet: msg.hostOctet });
      term.writeln(`[TAN address: 10.0.2.${msg.hostOctet}]`);
      return;
    }
    if (msg.type === 'stats') {
      // Pacing telemetry (~1/sec). Console-only by design — the numbers
      // are for the pacing report and the dev /agent/stats endpoint.
      latestStats = msg;
      console.debug(
        `[emu86] ${msg.instrPerSec.toLocaleString()} instr/s ` +
          `(${(msg.realTimeRatio * 100).toFixed(0)}% of 4.77 MHz), ` +
          `${msg.mode}, batch ${msg.batch}`,
      );
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
      if (msg.type === 'stats') {
        // Mirror pacing stats to the dev server for GET /agent/stats.
        hot.send('emu86:stats', { stats: msg });
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
  // Sticky IP: offer last session's TAN octet as the lease's first
  // pick (defend/repick still applies — a duplicated tab repicks).
  const session = loadSession();
  if (session.tanHostOctet !== null) {
    boot.config.tanPreferredOctet = session.tanHostOctet;
  }
  // Pacing: initial CPU speed from settings.
  boot.config.cpuSpeed = settings.cpuSpeed;
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
    // Speed applies live: forward the toggle to the running worker.
    onCpuSpeedChange: (mode) => {
      const msg: MainToWorkerMessage = { type: 'set-speed', mode };
      worker.postMessage(msg);
    },
  });

  // Landing showcase (2026-07-15): while the bundled floppy runs,
  // stream the 32 MB HD image through /gh-assets into the library in
  // the background; when it lands, break the news and stage the next
  // reload to boot it with the demo script. First-run shape only — a
  // profile that already picked a boot image is never hijacked.
  void stageShowcase();

  async function stageShowcase(): Promise<void> {
    if (settings.imageSource.kind !== 'bundled') return;

    const status = ensureShowcaseBanner();
    try {
      let imageId: string | null = null;
      const existing = (await library.listImages()).find(
        (m) => m.name === 'hd32-minix.img',
      );
      if (existing !== undefined) {
        imageId = existing.id; // downloaded on an earlier visit, never staged
      } else {
        const releases = await listReleases({ includePrereleases: false, prereleaseLimit: 0 });
        const asset = releases
          .flatMap((r) => r.assets)
          .find((a) => a.name === 'hd32-minix.img');
        if (asset === undefined) return;
        status.show(`fetching a hard disk… 0 / ${Math.round(asset.sizeBytes / 1048576)} MB`);
        const bytes = await downloadAsset(asset.downloadUrl, (p) => {
          const total = p.total ?? asset.sizeBytes;
          status.show(
            `fetching a hard disk… ${Math.round(p.loaded / 1048576)} / ${Math.round(total / 1048576)} MB`,
          );
        });
        imageId = await library.addImage('hd32-minix.img', bytes, 'github', 'likely-works');
      }

      // Stage the show — but re-check: the user may have chosen a
      // machine (or a script) while the download ran; their choice wins.
      if (settings.imageSource.kind !== 'bundled') { status.hide(); return; }
      const nextScript =
        settings.activeBootScriptId === null
          ? SEED_DEMO_SCRIPT.id
          : settings.activeBootScriptId;
      settings = {
        ...settings,
        imageSource: { kind: 'library', id: imageId },
        activeBootScriptId: nextScript,
      };
      saveSettings(settings);
      status.breakingNews();
    } catch (err) {
      // Rate limits / offline / quota: the showcase is a bonus, not a
      // requirement. The floppy machine keeps running.
      console.warn('[emu86] showcase staging failed:', err);
      status.hide();
    }
  }

  // Page unload cleans up workers automatically; no manual teardown needed.
}

/**
 * The showcase status chip / breaking-news banner (bottom of the
 * viewport). One element, three states: hidden, progress, news.
 */
function ensureShowcaseBanner(): {
  show: (text: string) => void;
  breakingNews: () => void;
  hide: () => void;
} {
  const el = document.createElement('div');
  el.id = 'showcase-banner';
  el.hidden = true;
  document.body.appendChild(el);

  return {
    show(text: string): void {
      el.hidden = false;
      el.classList.remove('is-news');
      el.textContent = text;
    },
    breakingNews(): void {
      el.hidden = false;
      el.classList.add('is-news');
      el.innerHTML = '';
      const msg = document.createElement('span');
      msg.innerHTML =
        '<strong>BREAKING NEWS:</strong> this machine just grew a 32&nbsp;MB ' +
        'hard disk with a C compiler on it. Refresh to boot ELKS from disk — ' +
        'and watch it write, build, and run a program for you.';
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'showcase-refresh';
      refresh.textContent = 'Refresh now';
      refresh.addEventListener('click', () => location.reload());
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'showcase-dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.textContent = '×';
      dismiss.addEventListener('click', () => { el.hidden = true; });
      el.append(msg, refresh, dismiss);
    },
    hide(): void {
      el.hidden = true;
    },
  };
}

async function buildBootMessage(
  library: ImageLibrary,
  source: ImageSource,
  secondary: { kind: 'library'; id: string } | null,
): Promise<BootMessage> {
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
