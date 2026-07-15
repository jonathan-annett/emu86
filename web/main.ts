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
import { DRIVE_PRESETS, ImageLibrary, presetKb } from './image-library.js';
import {
  createWebForkLocks,
  gcOrphanForks,
  resolveDriveSession,
  type DriveSession,
} from './drive-session.js';
import { mountSettingsModal } from './settings-modal.js';
import { AutoexecRunner } from './autoexec.js';
import { createKeyClick } from './keyfx.js';
import { loadSession, saveSession } from './session-store.js';
import { OverlayStore } from './overlay-store.js';
import {
  gcOrphanOverlays,
  mintOverlayId,
  overlayLockName,
  resolveOverlaySession,
  type OverlaySession,
} from './overlay-session.js';
import { mountEditorPanel } from './editor-panel.js';
import { SEED_BOOT_SCRIPT, SEED_DEMO_SCRIPT, reconcileSeededScripts } from './settings.js';
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
  // Focus the terminal immediately (field ask, 2026-07-15): Ctrl-R,
  // wait, keep typing — the keyboard jockeys never touch the mouse.
  term.focus();
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

  // Seeded scripts: add ones the profile has never seen, and refresh
  // pristine copies of seeds we have since fixed. Scripts the user has
  // edited are never touched (see reconcileSeededScripts). Seeding used
  // to be absent-only, which meant a stored copy of a seeded script
  // shadowed every later fix — Jonathan ran a broken installer twice
  // after I had fixed it, because his browser had the old text.
  const reconciled = reconcileSeededScripts(settings.bootScripts);
  if (JSON.stringify(reconciled) !== JSON.stringify(settings.bootScripts)) {
    settings = { ...settings, bootScripts: reconciled };
    saveSettings(settings);
  }

  // Per-tab drive fork (Phase 16 M0 — brief Addendum A): settle which
  // /dev/hdb this tab owns BEFORE the banner so the provenance line is
  // true. Every tab gets a drive; failure (no usable IDB) degrades to a
  // solo boot rather than a dead page. Orphan forks from long-gone tabs
  // are swept in the background — never awaited on the boot path.
  const forkLocks = createWebForkLocks();
  let drive: DriveSession | null = null;
  try {
    drive = await resolveDriveSession({
      library,
      locks: forkLocks,
      loadSession,
      saveSession,
      base: settings.secondaryImageSource,
    });
  } catch (err) {
    console.warn('[emu86] drive fork unavailable, booting solo:', err);
  }
  void gcOrphanForks(library, forkLocks).then((n) => {
    if (n > 0) console.debug(`[emu86] swept ${n} orphaned tab drive${n === 1 ? '' : 's'}`);
  }).catch(() => { /* sweep is best-effort */ });

  // Boot-disk overlay session (Phase 17 M2): settle this tab's
  // overlayId — fresh / reload / duplicate-copies-under-fresh-id /
  // queued-factory-reset — and load the chunks the worker will fold.
  // Same lock wrapper as the forks (the octet-lease pattern's third
  // deployment); failure degrades to a pristine boot, never a dead
  // page. Orphans GC in the background, mirror of the fork sweep.
  const overlayStore = new OverlayStore();
  let overlaySession: OverlaySession | null = null;
  try {
    overlaySession = await resolveOverlaySession({
      store: overlayStore,
      locks: forkLocks,
      loadSession,
      saveSession,
    });
    for (const note of overlaySession.notes) {
      console.debug(`[emu86] machine state: ${note}`);
    }
  } catch (err) {
    console.warn('[emu86] machine-state overlay unavailable, booting pristine:', err);
  }
  void gcOrphanOverlays(overlayStore, forkLocks).then((n) => {
    if (n > 0) console.debug(`[emu86] swept ${n} orphaned machine overlay${n === 1 ? '' : 's'}`);
  }).catch(() => { /* sweep is best-effort */ });

  const sourceLabel = await describeImageSource(library, settings.imageSource);
  const buildLabel = import.meta.env.DEV ? `${__EMU86_BUILD__} · dev-server` : __EMU86_BUILD__;
  term.writeln(`emu86 — ELKS in the browser [${buildLabel}]`);
  term.writeln(`Image: ${sourceLabel}`);
  if (drive !== null) {
    term.writeln(`Secondary: ${describeDrive(drive)}`);
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
        // One-night-only act (Jonathan, 2026-07-15): when the landing
        // show fully completes — including the final typed keystroke,
        // which lands on a timer outside any feed() — demote the
        // active script to the plain network one-liner so reloads get
        // a working machine, not a rerun. Only the demo self-retires.
        onDone: () => {
          if (activeScript.id !== SEED_DEMO_SCRIPT.id) return;
          settings = { ...settings, activeBootScriptId: SEED_BOOT_SCRIPT.id };
          saveSettings(settings);
        },
      })
    : null;

  // Per-tab drive persistence (Phase 16 M0). Two consumers share the
  // worker's snapshot-secondary round trip via a FIFO of waiting
  // resolvers (postMessage ordering means the worker answers strictly
  // in request order):
  //   - auto-persist: while the guest writes, snapshot + write THIS
  //     tab's fork row, at most one write per AUTO_PERSIST_MS. This is
  //     what makes a reload (soft reboot) keep the drive. Honest
  //     limit, recorded in the brief: a reload can lose the last
  //     ≤5 s of guest writes — the floppy-yank class of loss.
  //   - promote: the banner's button publishes the tab's current drive
  //     as the shared base image — the thing NEW tabs fork. Tabs
  //     already open keep their forks (floppy-passing, not sync).
  const driveBanner = ensureDriveBanner(() => { void promoteToBase(); });
  const snapshotSinks: Array<(bytes: Uint8Array | null) => void> = [];
  function requestSnapshot(keepDirty = false): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      snapshotSinks.push(resolve);
      // keepDirty (Phase 16 M3): a PEEK for the editor's read path —
      // must not mark clean, or the auto-persist trigger starves.
      const msg: MainToWorkerMessage = keepDirty
        ? { type: 'snapshot-secondary', keepDirty: true }
        : { type: 'snapshot-secondary' };
      worker.postMessage(msg);
    });
  }

  // write-secondary acks (Phase 16 M3), FIFO like snapshotSinks. The
  // panel (M4) is the pusher; the branch in the message handler is the
  // shifter. An ack with no waiter means a protocol bug — warn loudly.
  const secondaryWriteAcks: Array<(r: { ok: boolean; detail?: string }) => void> = [];
  function requestSecondaryWrite(bytes: Uint8Array): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      secondaryWriteAcks.push(resolve);
      const msg: MainToWorkerMessage = { type: 'write-secondary', bytes };
      worker.postMessage(msg);
    });
  }

  // Boot-disk overlay persistence (Phase 17 M1+M2). The worker sweeps
  // coalesced chunk epochs at its own cadence (5 s throttle / 4 MB
  // forced); this side persists each epoch in ONE IndexedDB
  // transaction and acks with the same epoch id — a nack (or silence)
  // folds the epoch back into the worker's hot map for retry, so a
  // failed IDB write loses nothing. Identity (M2): sweeps land under
  // the session's resolved overlayId and stamp the base fingerprint
  // the worker reported this boot; on a fingerprint MISMATCH (base
  // changed under the tab's machine state) sweeps move to a fresh id
  // so the kept rows aren't clobbered — discard is a settings action.
  let activeOverlayId: string | null = overlaySession?.overlayId ?? null;
  let bootFingerprint: string | null = null;
  let staleOverlayId: string | null = null;
  function ensureOverlayId(): string {
    // Fallback for the degraded path (resolveOverlaySession threw but
    // sweeps still arrive): mint-and-persist, no lock, best effort.
    if (activeOverlayId !== null) return activeOverlayId;
    activeOverlayId = loadSession().overlayId ?? mintOverlayId();
    saveSession({ overlayId: activeOverlayId });
    return activeOverlayId;
  }

  const AUTO_PERSIST_MS = 5_000;
  let persistInFlight = false;
  let lastPersistAt = 0;
  let latestDirtySectors = 0;
  function maybeAutoPersist(force = false): void {
    if (drive === null || persistInFlight) return;
    if (!force && Date.now() - lastPersistAt < AUTO_PERSIST_MS) return;
    persistInFlight = true;
    const target = drive;
    void requestSnapshot()
      .then(async (bytes) => {
        if (bytes === null) return; // no secondary mounted in the worker
        await library.updateImageBytes(target.imageId, bytes);
        driveBanner.autoSaved();
      })
      .catch((err: unknown) => driveBanner.error(String(err)))
      .finally(() => {
        persistInFlight = false;
        lastPersistAt = Date.now();
      });
  }
  // Tab going to the background is the best predictor we get of a
  // close/reload — flush regardless of the throttle window. The
  // overlay flush is unconditional: the worker no-ops on a clean hot
  // map, and main doesn't track the hot count.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (latestDirtySectors > 0) maybeAutoPersist(true);
      const flush: MainToWorkerMessage = { type: 'overlay-flush' };
      worker.postMessage(flush);
    }
  });

  async function promoteToBase(): Promise<void> {
    if (drive === null) return;
    driveBanner.promoting();
    try {
      const bytes = await requestSnapshot();
      if (bytes === null) {
        driveBanner.error('no drive mounted');
        return;
      }
      // The fork row rides along so this tab's own persistence is
      // exactly as current as the base it just published.
      await library.updateImageBytes(drive.imageId, bytes);
      const baseId = settings.secondaryImageSource?.id ?? null;
      let updatedExisting = false;
      if (baseId !== null) {
        const meta = (await library.listImages()).find((m) => m.id === baseId);
        if (meta !== undefined && meta.sizeBytes === bytes.byteLength) {
          await library.updateImageBytes(baseId, bytes);
          updatedExisting = true;
        }
      }
      if (!updatedExisting) {
        // No base yet — or the drive changed size (?mkdrive swap). A
        // base image's geometry is its identity, so publish a NEW
        // entry and repoint; an old base stays in the library, user-
        // owned and user-deletable.
        const preset = DRIVE_PRESETS.find((p) => presetKb(p) * 1024 === bytes.byteLength);
        const label = preset?.label ?? `${Math.round(bytes.byteLength / 1024)} KB`;
        const id = await library.addImage(
          `default drive (${label})`,
          bytes,
          'blank',
          undefined,
          drive.geometry,
        );
        settings = { ...settings, secondaryImageSource: { kind: 'library', id } };
        saveSettings(settings);
      }
      driveBanner.promoted();
    } catch (err) {
      driveBanner.error(String(err));
    }
  }

  worker.addEventListener('message', (event: MessageEvent<WorkerToMainMessage>) => {
    const msg = event.data;
    if (msg.type === 'tx') {
      term.write(msg.bytes);
      if (autoexec !== null && autoexec.active) {
        autoexec.feed(txDecoder.decode(msg.bytes, { stream: true }));
      }
      return;
    }
    if (msg.type === 'ready') {
      // Boot started. The ELKS Setup banner (BIOS INT 10h teletype)
      // and the post-set_console UART traffic both stream via `tx`
      // messages — see worker-host.ts shared txBuffer.
      return;
    }
    if (msg.type === 'secondary-snapshot') {
      // Hand the bytes to whichever requester is next in line (auto-
      // persist, promote, or an editor peek) — FIFO, see requestSnapshot.
      const sink = snapshotSinks.shift();
      if (sink !== undefined) sink(msg.bytes);
      return;
    }
    if (msg.type === 'secondary-written') {
      const ack = secondaryWriteAcks.shift();
      if (ack !== undefined) {
        ack({ ok: msg.ok, ...(msg.detail !== undefined ? { detail: msg.detail } : {}) });
      } else {
        console.warn('[emu86] unsolicited secondary-written ack:', msg);
      }
      return;
    }
    if (msg.type === 'overlay-sweep') {
      // Phase 17 M1: persist the epoch — one transaction — then ack
      // with the same id. On failure, nack honestly: the worker folds
      // the epoch back and retries, so an IDB hiccup costs latency,
      // not data. M2: the meta row carries the base fingerprint the
      // worker reported this boot (null only on the degraded path —
      // the store's merge rule never downgrades a real one).
      const overlayId = ensureOverlayId();
      overlayStore
        .putChunks(overlayId, msg.chunks, {
          chunkSizeBytes: msg.chunkSizeBytes,
          baseFingerprint: bootFingerprint,
        })
        .then(
          () => {
            const ack: MainToWorkerMessage = {
              type: 'overlay-swept',
              epochId: msg.epochId,
              ok: true,
            };
            worker.postMessage(ack);
          },
          (err: unknown) => {
            console.warn('[emu86] overlay sweep persist failed:', err);
            const nack: MainToWorkerMessage = {
              type: 'overlay-swept',
              epochId: msg.epochId,
              ok: false,
              detail: String(err),
            };
            worker.postMessage(nack);
          },
        );
      return;
    }
    if (msg.type === 'control-request') {
      // Substrate API v1: the guest ran `urlget http://10.0.2.2/?...`.
      // Phase 16 M0 semantics: mkdrive queues a swap of THIS TAB's fork
      // (consumed at the tab's next boot) and never touches the shared
      // base image — so the old "already attached" refusal is gone.
      // Field, 2026-07-15: it fired even on brand-new tabs, because the
      // attach it guarded was origin-global. Whatever text we answer
      // with lands in the guest's terminal.
      void (async (): Promise<string> => {
        const preset = DRIVE_PRESETS.find((p) => presetKb(p) === msg.kb);
        if (preset === undefined) {
          const sizes = DRIVE_PRESETS.map((p) => presetKb(p)).join(', ');
          return `mkdrive: size must be one of: ${sizes} (KB)`;
        }
        saveSession({ pendingBlankKb: msg.kb });
        return [
          `queued: a fresh blank ${preset.label} drive will replace this tab's /dev/hdb.`,
          `reload this browser tab to boot with it, then: mkfs /dev/hdb ${msg.kb}`,
          'only this tab is affected; the shared base image is untouched.',
        ].join('\n');
      })().then(
        (text) => {
          const resp: MainToWorkerMessage = { type: 'control-response', id: msg.id, text };
          worker.postMessage(resp);
        },
        (err: unknown) => {
          const resp: MainToWorkerMessage = {
            type: 'control-response',
            id: msg.id,
            text: `mkdrive failed: ${String(err)}`,
          };
          worker.postMessage(resp);
        },
      );
      return;
    }
    if (msg.type === 'overlay-identity') {
      // Phase 17 M2: the base's fingerprint, every boot. Future sweeps
      // stamp it into the meta row. applied:false with chunks offered
      // means the worker REFUSED the fold — this tab's machine state
      // belongs to a different base image. Keep those rows (the user
      // may switch the base back); move this session's sweeps to a
      // fresh id so they can't clobber what we kept; the settings
      // modal offers the discard.
      bootFingerprint = msg.fingerprint;
      if (!msg.applied && msg.chunksOffered > 0) {
        staleOverlayId = activeOverlayId;
        activeOverlayId = mintOverlayId();
        saveSession({ overlayId: activeOverlayId });
        void forkLocks.acquireForever(overlayLockName(activeOverlayId));
        term.writeln(
          '[machine state was saved against a different base image — ' +
            'kept unused; Settings → Machine state can discard it]',
        );
      }
      return;
    }
    if (msg.type === 'tan-identity') {
      // Sticky IP: persist the settled octet so the next reload offers
      // it back to the lease; tell the user where they live — and WHO
      // they are. The tab's name IS its hostname on the .tabs network
      // (Phase 15 M4), so it titles the browser tab too: a row of open
      // tabs reads mouse / cat / dog.
      saveSession({ tanHostOctet: msg.hostOctet });
      if (msg.name !== undefined) {
        document.title = `${msg.name}.tabs — emu86`;
        term.writeln(
          `[you are ${msg.name}.tabs at 10.0.2.${msg.hostOctet} — ` +
            `the gateway is elk.tabs]`,
        );
      } else {
        term.writeln(`[TAN address: 10.0.2.${msg.hostOctet}]`);
      }
      return;
    }
    if (msg.type === 'stats') {
      // Pacing telemetry (~1/sec). Console-only by design — the numbers
      // are for the pacing report and the dev /agent/stats endpoint.
      latestStats = msg;
      // Fork auto-persist rides the same heartbeat: dirty sectors mean
      // guest writes since the last snapshot; the throttle inside
      // maybeAutoPersist keeps IDB writes to one per AUTO_PERSIST_MS.
      if (typeof msg.secondaryDirtySectors === 'number') {
        latestDirtySectors = msg.secondaryDirtySectors;
        if (msg.secondaryDirtySectors > 0) {
          driveBanner.dirty(msg.secondaryDirtySectors);
          maybeAutoPersist();
        }
      }
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
    // Backspace: xterm.js emits DEL (0x7F), but the ELKS line editor
    // binds 0x7F to delete-FORWARD and 0x08 (Ctrl-H) to backspace —
    // field-diagnosed 2026-07-15 (brief Addendum B; Jonathan's Ctrl-H
    // probe confirmed 0x08 behaves). Map it here, at the one seam
    // between the human keyboard and the guest; scripted input
    // (autoexec, agent bridge) never contains 0x7F.
    const mapped = data.includes('\x7f') ? data.replaceAll('\x7f', '\b') : data;
    const bytes = encoder.encode(mapped);
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
    drive === null ? null : { kind: 'library', id: drive.imageId },
  );
  // Sticky IP: offer last session's TAN octet as the lease's first
  // pick (defend/repick still applies — a duplicated tab repicks).
  const session = loadSession();
  if (session.tanHostOctet !== null) {
    boot.config.tanPreferredOctet = session.tanHostOctet;
  }
  // Pacing: initial CPU speed from settings.
  boot.config.cpuSpeed = settings.cpuSpeed;
  // Machine state (Phase 17 M2): hand the worker this tab's overlay to
  // fold. Chunk buffers ride as Transferables — fresh out of IDB,
  // referenced nowhere else on this side, and a 32 MB machine's worth
  // of chunks would otherwise structured-clone twice.
  const bootTransfers = new Set<ArrayBuffer>();
  if (overlaySession !== null && overlaySession.boot !== null) {
    boot.config.overlay = {
      chunks: overlaySession.boot.chunks,
      chunkSizeBytes: overlaySession.boot.chunkSizeBytes,
      fingerprint: overlaySession.boot.fingerprint,
    };
    for (const chunk of overlaySession.boot.chunks) {
      if (chunk.bytes.buffer instanceof ArrayBuffer) {
        bootTransfers.add(chunk.bytes.buffer);
      }
    }
  }
  worker.postMessage(boot, [...bootTransfers]);

  // (The Phase 15 M2 single-writer Web Lock that used to live here is
  // retired: it guarded a shared mutable attach that no longer exists.
  // Every tab now writes only its own fork; the per-fork lock inside
  // drive-session.ts covers the one collision left — tab duplication.)

  // Mount the settings UI. `bootedFrom` captures the source that is
  // actually running, so the modal can render a "Reload to apply"
  // notice when the user picks a different one.
  mountSettingsModal({
    library,
    getSettings: () => settings,
    onChange: (next) => {
      settings = next;
      saveSettings(next);
    },
    bootedFrom: settings.imageSource,
    // Speed applies live: forward the toggle to the running worker.
    onCpuSpeedChange: (mode) => {
      const msg: MainToWorkerMessage = { type: 'set-speed', mode };
      worker.postMessage(msg);
    },
    // Machine state (Phase 17 M2): factory reset queues (consumed at
    // next boot — a running machine can't un-write its RAM); the
    // stale-state discard appears only after a mismatch this session.
    machineState: {
      onFactoryReset: () => {
        saveSession({ overlayResetPending: true });
      },
      staleState: () => {
        const stale = staleOverlayId;
        if (stale === null) return null;
        return {
          discard: async () => {
            await overlayStore.deleteOverlay(stale);
            staleOverlayId = null;
          },
        };
      },
    },
  });

  // The system-level editor (Phase 16 M4): a panel over THIS tab's
  // /dev/hdb — peek reads (never marking clean), whole-image writes
  // through M3, fork-row persistence for reload safety. Not mounted
  // in the no-drive degraded case (broken IDB): there is nothing for
  // it to edit and its empty states would lie.
  if (drive !== null) {
    const activeDrive = drive;
    mountEditorPanel({
      peekDrive: () => requestSnapshot(true),
      writeDrive: (bytes) => requestSecondaryWrite(bytes),
      persistFork: (bytes) => library.updateImageBytes(activeDrive.imageId, bytes),
      driveLabel: activeDrive.name,
    });
  }

  // Previous-version link (release procedure, 2026-07-15): every
  // promotion archives the outgoing build under /<stamp>/ (see
  // scripts/release-capture.mjs + RELEASE_PROCEDURE.md) and prepends
  // it to /version-history.json. The newest entry gets a subtle header
  // link so users can go back to a version they know as the site
  // grows (Jonathan's ask). Best-effort: no manifest — dev server,
  // offline — means no link, never an error.
  void (async () => {
    try {
      const res = await fetch('/version-history.json');
      if (!res.ok) return;
      const history: unknown = await res.json();
      if (!Array.isArray(history) || history.length === 0) return;
      const latest = history[0] as { stamp?: unknown; path?: unknown };
      if (typeof latest.stamp !== 'string' || typeof latest.path !== 'string') return;
      const headerP = document.querySelector('header p');
      if (headerP === null) return;
      const link = document.createElement('a');
      link.className = 'prev-version-link';
      link.href = latest.path;
      link.textContent = `previous version (${latest.stamp})`;
      headerP.append(' · ', link);
    } catch {
      // Manifest unreachable — the link is a nicety, not a feature.
    }
  })();

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
  // size table infers the class — unless the entry carries an explicit
  // geometry (Phase 15 M2 blank drives, whose sizes the table doesn't
  // know). Failure to read the secondary's bytes is surfaced to the
  // caller; partial-success boot would leave the user confused about
  // why /dev/hdb didn't appear.
  if (secondary !== null) {
    const entry = await library.getImageEntry(secondary.id);
    config.secondary = {
      imageBytes: entry.bytes,
      ...(entry.geometry !== undefined ? { geometry: entry.geometry } : {}),
    };
  }
  return { type: 'boot', config };
}

/**
 * The per-tab drive pill (bottom-left; the showcase banner owns
 * bottom-center). Hidden until the guest first writes /dev/hdb, then
 * stays for the session — dirty count alternating with the auto-saved
 * tick — plus the ONE deliberate action left on it (Phase 16 M0):
 * publish this tab's drive as the base image new tabs fork. The old
 * nag semantics are gone because persistence is automatic now; the
 * cross-tab lockWarning state is gone with the shared attach it warned
 * about.
 */
function ensureDriveBanner(onPromote: () => void): {
  dirty: (sectors: number) => void;
  autoSaved: () => void;
  promoting: () => void;
  promoted: () => void;
  error: (message: string) => void;
} {
  const el = document.createElement('div');
  el.id = 'drive-banner';
  el.hidden = true;
  const text = document.createElement('span');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'drive-save';
  btn.textContent = 'Save as default';
  btn.addEventListener('click', () => onPromote());
  el.append(text, btn);
  document.body.appendChild(el);

  // Draggable (field request, 2026-07-14): any fixed corner ends up
  // over something — the original bottom-left sat exactly where the
  // prompt lands once the scrollback fills. Pointer events cover
  // mouse and touch; grabbing anywhere except the Save button moves
  // the pill, clamped to the viewport. Position is page-lifetime
  // only (a reload returns it to the bottom-right anchor).
  let dragPointer: number | null = null;
  let dragDx = 0;
  let dragDy = 0;
  el.addEventListener('pointerdown', (ev) => {
    if (ev.target === btn) return;
    dragPointer = ev.pointerId;
    const rect = el.getBoundingClientRect();
    dragDx = ev.clientX - rect.left;
    dragDy = ev.clientY - rect.top;
    el.setPointerCapture(ev.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (ev) => {
    if (dragPointer !== ev.pointerId) return;
    const x = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, ev.clientX - dragDx));
    const y = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, ev.clientY - dragDy));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  const endDrag = (ev: PointerEvent): void => {
    if (dragPointer !== ev.pointerId) return;
    dragPointer = null;
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  let state: 'idle' | 'promoting' | 'promoted' = 'idle';
  let promotedTimer: number | null = null;

  const show = (message: string, withButton: boolean, warning = false): void => {
    el.hidden = false;
    el.classList.toggle('is-warning', warning);
    text.textContent = message;
    btn.hidden = !withButton;
  };

  return {
    dirty(sectors: number): void {
      if (state !== 'idle') return;
      btn.disabled = false;
      show(
        `/dev/hdb: ${sectors} sector${sectors === 1 ? '' : 's'} pending auto-save —`,
        true,
      );
    },
    autoSaved(): void {
      if (state !== 'idle') return;
      btn.disabled = false;
      show('/dev/hdb auto-saved (this tab only) —', true);
    },
    promoting(): void {
      state = 'promoting';
      btn.disabled = true;
      show('Publishing this drive as the default…', true);
    },
    promoted(): void {
      state = 'promoted';
      show('Saved as default — new tabs will start from this drive ✓', false);
      if (promotedTimer !== null) window.clearTimeout(promotedTimer);
      promotedTimer = window.setTimeout(() => {
        state = 'idle';
        btn.disabled = false;
        show('/dev/hdb auto-saved (this tab only) —', true);
      }, 4000);
    },
    error(message: string): void {
      state = 'idle';
      btn.disabled = false;
      show(`drive: ${message} —`, true, true);
    },
  };
}

/** The boot banner's provenance line for this tab's drive fork. */
function describeDrive(d: DriveSession): string {
  const blocks = Math.round(d.sizeBytes / 1024);
  switch (d.origin) {
    case 'fresh-blank':
      return `${d.name} — this tab's own drive, blank (mkfs /dev/hdb ${blocks} to format)`;
    case 'fork-of-base':
      return `${d.name} — this tab's own copy`;
    case 'reload':
      return `${d.name} — this tab's drive, restored`;
    case 'duplicate':
      return `${d.name} — forked from the duplicated tab`;
    case 'swap':
      return `${d.name} — fresh blank via ?mkdrive (mkfs /dev/hdb ${blocks} to format)`;
  }
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
