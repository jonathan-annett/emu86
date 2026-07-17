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
import { modeSequence, TxModeTracker, type TxModeState } from './tx-modes.js';
import {
  loadSession,
  mintSessionId,
  sanitizePcId,
  saveSession,
  storageKeyFor,
} from './session-store.js';
import { RACK_CHANNEL_NAME, mountMoveToRack } from './migrate.js';
import {
  CLONE_CHANNEL_NAME,
  mountCloneParent,
  requestCloneState,
} from './clone-session.js';
import { askCloneChoice } from './clone-choice.js';
import { nameForOctet } from '../src/net/tan-names.js';
import { OverlayStore } from './overlay-store.js';
import { SECTOR_SIZE } from '../src/disk/disk.js';
import {
  gcOrphanOverlays,
  mintOverlayId,
  overlayLockName,
  resolveOverlaySession,
  type OverlaySession,
} from './overlay-session.js';
import { mountEditorPanel, type EditorPanelHandle } from './editor-panel.js';
import {
  SEED_BOOT_SCRIPT,
  SEED_DEMO_SCRIPT,
  SEED_PING_SCRIPT,
  reconcileSeededScripts,
} from './settings.js';
import { listReleases, downloadAsset } from './github-releases.js';
import { gunzipStream, gunzipBytes, gzipBytes } from './gzip.js';
import {
  MACHINE_STATE_SCHEMA_VERSION,
  MachineStore,
  gcOrphanResumeSlots,
  gcStaleCloneStates,
  resumeSlotId,
  resumeSlotLockName,
  type MachineStateKind,
  type MachineStateRecord,
  type MachineStateMeta,
} from './machine-store.js';
import { mountStatusLeds, type StatusLeds } from './status-leds.js';
import { mountInspectPanel } from './inspect-panel.js';
import { mountSystemLog, type SystemLog } from './system-log.js';
import { createDebugTrace } from './debug-log.js';

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

  // First visit installs the hard disk IMMEDIATELY (field ask,
  // 2026-07-17: "now we have the hard drive loading fast, lets just
  // install it immediately"). The old shape — boot the bundled floppy
  // while the HD streams in the background, then break the news —
  // gave every first-time visitor (and ghaerr) a floppy session with
  // no toolchain, a different net-start failure mode, and a resume
  // path no test exercises. Now: ~3 MB gzipped fetch, into the
  // library, boot the real machine first. Offline/degraded keeps the
  // floppy fallback honestly.
  if (settings.imageSource.kind === 'bundled') {
    settings = await installHardDiskNow(settings);
  }

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

  // Phase 18 M3 — the clone ("tab duplicate = frozen in amber").
  // One channel serves both roles: every tab answers requests as a
  // potential parent; a tab whose overlay session says 'duplicate'
  // ALSO dials as a child. The inherited sessionId is what names the
  // parent — grab it, then mint our own BEFORE anything keys off it
  // (two tabs sharing an id fight over one resume-slot row). The
  // HANDSHAKE waits for the boot-choice modal (field ask: duplicating
  // also mints new PCs — ask which one this is) so a fresh-PC pick
  // never bothers the parent and a resume captures at decision time.
  const cloneChannel = new BroadcastChannel(CLONE_CHANNEL_NAME);
  let cloneParentInfo: {
    parentSessionId: string;
    childSessionId: string;
    parentName: string | null;
  } | null = null;
  if (overlaySession?.origin === 'duplicate') {
    const inherited = loadSession();
    const childSessionId = mintSessionId();
    saveSession({ sessionId: childSessionId });
    cloneParentInfo = {
      parentSessionId: inherited.sessionId,
      childSessionId,
      // The copied session carries the parent's sticky octet — its
      // name is a pure function of it. Null on degraded parents.
      parentName:
        inherited.tanHostOctet !== null ? nameForOctet(inherited.tanHostOctet) : null,
    };
  }

  // Whole-machine save-states + the reload-resume slot (Phase 18 M2).
  // The store is the fourth IDB tenant; this tab's resume slot is
  // keyed by sessionId and guarded by a Web Lock so the GC's
  // unheld-lock + staleness conjunction can tell abandoned slots from
  // live ones. Named saves never age out (D4).
  const machineStore = new MachineStore();
  const ownResumeSlotId = resumeSlotId(loadSession().sessionId);
  void forkLocks.acquireForever(resumeSlotLockName(ownResumeSlotId));
  void gcOrphanResumeSlots(machineStore, forkLocks).then((n) => {
    if (n > 0) console.debug(`[emu86] swept ${n} orphaned resume slot${n === 1 ? '' : 's'}`);
  }).catch(() => { /* sweep is best-effort */ });
  void gcStaleCloneStates(machineStore).then((n) => {
    if (n > 0) console.debug(`[emu86] swept ${n} abandoned clone snapshot${n === 1 ? '' : 's'}`);
  }).catch(() => { /* sweep is best-effort */ });

  // Rack M1: this context's instance id (?pc=…) — embedded in a rack
  // iframe when non-null. Read once, early: the debug trace and the
  // rack status reporting both key off it.
  const embeddedPcId = sanitizePcId(new URLSearchParams(location.search).get('pc'));

  // The debug trace (field ask 2026-07-17): lifecycle breadcrumbs +
  // every syslog line, broadcast for tab-shark's merged event log.
  const dbg = createDebugTrace(embeddedPcId);

  // The system log (Phase 18 field-loop UI): every HOST-side message
  // lands here — the terminal is the machine's alone from this point
  // on (Jonathan: "a system log that is totally detached from what the
  // machine actually prints out"). Dismissing any overlay hands focus
  // back to the terminal (field report 2026-07-16). The debug-trace
  // mirror means anything a tab tells its user, it also tells the wire.
  const syslogPanel = mountSystemLog({ onClosed: () => term.focus() });
  const syslog: SystemLog = {
    log: (text, opts) => {
      syslogPanel.log(text, opts);
      dbg(text);
    },
  };

  const sourceLabel = await describeImageSource(library, settings.imageSource);
  const buildLabel = import.meta.env.DEV ? `${__EMU86_BUILD__} · dev-server` : __EMU86_BUILD__;
  syslog.log(`emu86 — ELKS in the browser [${buildLabel}]`);
  syslog.log(`image: ${sourceLabel}`);
  if (drive !== null) {
    syslog.log(`secondary: ${describeDrive(drive)}`);
  }
  const activeScript = settings.bootScripts.find(
    (s) => s.id === settings.activeBootScriptId,
  );
  // Phase 17 M3: the seeded scripts open by typing `root` at a login
  // prompt that no longer exists under autologin — and the demo is
  // the native show's job now. Seeded scripts are skipped while
  // autologin is on (settings untouched — flip autologin off and
  // they run again); a user-authored script is the user's business.
  const scriptSuppressed =
    activeScript !== undefined &&
    settings.autologin !== 'off' &&
    (activeScript.id === SEED_DEMO_SCRIPT.id ||
      activeScript.id === SEED_BOOT_SCRIPT.id ||
      activeScript.id === SEED_PING_SCRIPT.id);
  if (activeScript !== undefined) {
    syslog.log(
      scriptSuppressed
        ? `boot script: ${activeScript.name} (skipped — autologin is on)`
        : `boot script: ${activeScript.name}`,
    );
  }
  syslog.log('booting…');

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

  // Phase 18 M2: which stored state (if any) this boot is restoring —
  // the restore-result handler touches it (success keeps the GC away)
  // or deletes a refused resume slot.
  let activeRestoreStateId: string | null = null;

  // Phase 18 field-loop UI: the restored screen. A rolling tail of raw
  // serial TX bytes rides the resume slot (and named saves); replaying
  // it through xterm before the machine resumes reproduces the screen
  // byte-faithfully — colors, cursor and all — because it is literally
  // the same output stream. Deliberately main-side state: this is
  // xterm's history, not guest memory.
  const TX_TAIL_CAP = 48 * 1024;
  const txTailChunks: Uint8Array[] = [];
  let txTailTotal = 0;
  function txTailAppend(bytes: Uint8Array): void {
    txTailChunks.push(new Uint8Array(bytes));
    txTailTotal += bytes.byteLength;
    while (txTailTotal > TX_TAIL_CAP && txTailChunks.length > 1) {
      const dropped = txTailChunks.shift();
      txTailTotal -= dropped?.byteLength ?? 0;
    }
  }
  function txTailSnapshot(): Uint8Array {
    const out = new Uint8Array(txTailTotal);
    let off = 0;
    for (const chunk of txTailChunks) {
      out.set(chunk, off);
      off += chunk.byteLength;
    }
    return out;
  }
  // Rack M1: when embedded (?pc= present), report identity/status to
  // the parent so the rail can name this machine and dot its state.
  // Post-only — the rack binds rows by message SOURCE, so nothing in
  // the payload is security-relevant. (embeddedPcId is read once,
  // early, beside the debug trace.)
  const rackStatus: {
    name: string | null;
    octet: number | null;
    state: 'booting' | 'running' | 'frozen' | 'halted';
  } = { name: null, octet: null, state: 'booting' };
  function postRackStatus(patch: Partial<typeof rackStatus>): void {
    if (embeddedPcId === null || window.parent === window) return;
    Object.assign(rackStatus, patch);
    window.parent.postMessage(
      { emu86: 'pc-status', pc: embeddedPcId, ...rackStatus },
      location.origin,
    );
  }

  // Field fix #5: modes set BEFORE the tail window (invaders' hide-
  // cursor at game start) are invisible to the tail replay — this
  // tracker watches the same stream and carries their final state.
  const txModes = new TxModeTracker();
  let pendingTerminalRestore: {
    tail: Uint8Array;
    viewportY: number;
    modes?: TxModeState[];
  } | null = null;

  // Status LEDs (mounted onto the header once the DOM is settled).
  let leds: StatusLeds | null = null;
  let lastNetFrames = 0;
  let lastDiskHot = 0;

  // Boot script (Phase 14 — autoexec): a prompt-aware runner types the
  // active script into the console as the guest becomes ready. Fed from
  // the same TX stream the terminal renders; sends through the same rx
  // path as the keyboard, so the M2.5 FIFO pacing applies. Clackety
  // (@type) keystrokes get a synthesized click; @turbo/@authentic post
  // live speed changes (session-scoped — the stored setting is not
  // touched).
  const txDecoder = new TextDecoder();
  const keyClick = createKeyClick();
  const autoexec = activeScript !== undefined && !scriptSuppressed
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
  /** The /mnt drawer's live-refresh handle (set at mount, below). */
  let editorPanel: EditorPanelHandle | null = null;
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
        // The drawer follows the machine for free: these are the
        // freshest drive bytes there are, already in hand — a guest
        // sync reaches the file list within one persist beat.
        editorPanel?.driveUpdated(bytes);
      })
      .catch((err: unknown) => driveBanner.error(String(err)))
      .finally(() => {
        persistInFlight = false;
        lastPersistAt = Date.now();
      });
  }
  // Whole-machine capture round trips (Phase 18 M2). Keyed by
  // requestId — the reference (resume slot) and embedded (named save)
  // flows can overlap, so the FIFO idiom the snapshot path uses isn't
  // enough here.
  type CapturedReply = WorkerToMainMessage & { type: 'state-captured' };
  const captureSinks = new Map<number, (reply: CapturedReply) => void>();
  let nextCaptureId = 1;
  function requestCapture(
    disks: 'embedded' | 'reference',
    opts: { markSecondaryClean?: boolean } = {},
  ): Promise<CapturedReply> {
    return new Promise((resolve) => {
      const requestId = nextCaptureId++;
      captureSinks.set(requestId, resolve);
      const msg: MainToWorkerMessage = {
        type: 'capture-state',
        requestId,
        disks,
        ...(opts.markSecondaryClean === true ? { markSecondaryClean: true } : {}),
      };
      worker.postMessage(msg);
    });
  }

  // Freeze-and-inspect plumbing (Phase 18 field-loop UI).
  type InspectedReply = WorkerToMainMessage & { type: 'machine-inspected' };
  const inspectSinks = new Map<number, (reply: InspectedReply) => void>();
  function requestInspect(): Promise<InspectedReply> {
    return new Promise((resolve) => {
      const requestId = nextCaptureId++; // shared id space, distinct sink maps
      inspectSinks.set(requestId, resolve);
      const msg: MainToWorkerMessage = { type: 'inspect-machine', requestId };
      worker.postMessage(msg);
    });
  }

  /** Rough stored footprint for the meta row (UI only, not quota math). */
  function roughStateSize(reply: CapturedReply, gzBytes = 0): number {
    const ramBytes = (reply.state?.ram.pages.length ?? 0) * 4096;
    const carriedBytes =
      (reply.overlayEpoch?.chunks ?? []).reduce((n, c) => n + c.bytes.length, 0) +
      (reply.carriedSecondary?.length ?? 0) * SECTOR_SIZE;
    return ramBytes + carriedBytes + 64 * 1024 + gzBytes; // devices + NIC ring ride in the fudge
  }

  /**
   * Refresh this tab's reload-resume slot (Phase 18 M2, D2(b)
   * reference form): machine state + disk hashes ride the slot row;
   * the fork row is written from the capture's OWN secondary bytes
   * (one snapshot, one truth — a separate snapshot round trip could
   * land newer bytes and break the hash pairing). The capture's
   * worker-side final overlay sweep covers the primary.
   *
   * FIELD FIX (Jonathan, 2026-07-16, first M2 test: "seems to just
   * reboot the machine when I refresh"): capture-at-hidden alone
   * loses the unload race on a plain F5 — visibilitychange fires
   * DURING teardown and the worker round trip + IDB write rarely
   * complete, so no slot exists and the boot is cold. The overlay
   * survives that same race only because it persists CONTINUOUSLY;
   * the resume slot now does too — this funnel rides the ~1 Hz stats
   * heartbeat under a 5 s throttle (the auto-persist rhythm), with
   * the hidden event forcing past the throttle as belt-and-braces.
   * The slot is therefore ≤~5 s stale at any F5; the honesty notice
   * covers the gap and TCP's retransmission tolerates it. It also
   * REPLACES maybeAutoPersist while active: two independent snapshot
   * paths would interleave and break the fork-row ↔ secondarySha
   * pairing (the capture marks the drive clean, exactly the
   * snapshot-secondary semantics).
   */
  const RESUME_CAPTURE_MS = 5_000;
  /**
   * Field fix #8 (the Tetris staleness): while the guest has open TAN
   * flows, a teardown's FALLBACK slot (the last heartbeat, when the
   * final capture loses the page-death race) must be young enough for
   * the frozen peer to reconcile — ktcp never dup-ACKs, so a stale
   * rewind mid-session ends in "max retries exceeded". Tighten the
   * heartbeat while a session is live.
   */
  const RESUME_CAPTURE_ACTIVE_MS = 1_500;
  let latestTanFlows = 0;
  let resumeCaptureInFlight = false;
  let lastResumeCaptureAt = 0;
  /**
   * Fix #8: the fork row's last CONFIRMED generation (seeded from the
   * row at boot; advanced by each acked fork-snapshot write). Every
   * slot row records it as the base its carried delta folds over.
   */
  let confirmedForkGeneration: string | null = null;
  /** Fork writes awaiting their fork-snapshot message, by requestId. */
  const pendingForkWrites = new Map<
    number,
    { generation: string; carriedCount: number; force: boolean }
  >();
  let resumeSlotBroken = false; // IDB failed — stop hammering it
  /** Field fix #4: fold a capture's claimed deltas back worker-side —
   *  the epoch nack and the clean nack — when this beat can't (or
   *  won't) persist them. The next capture re-carries them. */
  function nackCaptureDeltas(reply: CapturedReply): void {
    if (reply.overlayEpoch != null) {
      const nack: MainToWorkerMessage = {
        type: 'overlay-swept',
        epochId: reply.overlayEpoch.epochId,
        ok: false,
        detail: 'resume funnel abandoned this beat',
      };
      worker.postMessage(nack);
    }
    if (reply.carriedSecondary !== undefined) {
      pendingForkWrites.delete(reply.requestId);
      const nack: MainToWorkerMessage = {
        type: 'secondary-persisted',
        requestId: reply.requestId,
        ok: false,
      };
      worker.postMessage(nack);
    }
  }

  // A forced capture arriving mid-beat must not be dropped: at
  // pagehide it is the FINAL word over a frozen machine (field find,
  // 2026-07-16 — the in-flight beat's state predates the freeze, and
  // the sliver between them is exactly a half-typed line).
  let forceQueued = false;
  // Multi-PC brief M2: the migrate dance must WAIT for the slot row
  // to be durable before handing the session to a rack — F5 gets this
  // from the teardown grace; a live handover has to await it.
  let resumeCaptureSettled: Promise<void> = Promise.resolve();
  function maybeRefreshResumeSlot(force = false): void {
    if (resumeCaptureInFlight) {
      if (force) forceQueued = true;
      return;
    }
    if (resumeSlotBroken) return;
    const cadence = latestTanFlows > 0 ? RESUME_CAPTURE_ACTIVE_MS : RESUME_CAPTURE_MS;
    if (!force && Date.now() - lastResumeCaptureAt < cadence) return;
    resumeCaptureInFlight = true;
    leds?.set('state', 'amber', 'capturing resume slot…');
    let replyForNack: CapturedReply | null = null;
    resumeCaptureSettled = (async () => {
      const reply = await requestCapture('reference', { markSecondaryClean: true });
      replyForNack = reply;
      if (!reply.ok || reply.state === undefined || reply.capturedAt === undefined) {
        nackCaptureDeltas(reply);
        return;
      }
      // An embedded-restore session applies its disks verbatim — no
      // reference reconstruction can ever match it, so a slot written
      // now would be a guaranteed refusal at the next boot. Skip.
      // (§7: a chunk-size era mismatch also lands here — the worker
      // reports referenceValid false and sends no storeDigest.)
      if (reply.referenceValid !== true || reply.storeDigest === undefined) {
        nackCaptureDeltas(reply);
        leds?.set(
          'state', 'dim',
          'no reload-resume this session (restored from a named save; a reload cold-boots)',
          null,
        );
        return;
      }
      // Field fix #4 — the write ORDER is the fix: the slot row lands
      // FIRST, carrying the deltas the other rows are about to get,
      // so whatever subset of {slot, fork, chunks} survives a
      // teardown, the newest committed slot always reconstructs.
      const carriedPrimary =
        reply.overlayEpoch != null
          ? {
              chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
              chunks: reply.overlayEpoch.chunks.map((c) => ({
                chunkIndex: c.chunkIndex,
                bytes: c.bytes,
              })),
            }
          : null;
      // Fix #8: the delta arrives pre-sliced (the reply never hauls
      // the full drive), and the slot pins the fork row by generation.
      const carriedSecondary =
        reply.carriedSecondary !== undefined && reply.carriedSecondary.length > 0
          ? reply.carriedSecondary
          : null;
      const pendingForkGeneration =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `g-${Math.random().toString(36).slice(2)}`;
      pendingForkWrites.set(reply.requestId, {
        generation: pendingForkGeneration,
        carriedCount: reply.carriedSecondary?.length ?? 0,
        force,
      });
      const now = Date.now();
      await machineStore.putState({
        meta: {
          stateId: ownResumeSlotId,
          label: null,
          kind: 'resume',
          createdAt: now,
          lastTouched: now,
          baseFingerprint: reply.baseFingerprint ?? null,
          schemaVersion: MACHINE_STATE_SCHEMA_VERSION,
          sizeBytes: roughStateSize(reply),
        },
        payload: {
          stateId: ownResumeSlotId,
          state: reply.state,
          capturedAt: reply.capturedAt,
          primary: null,
          secondary: null,
          primarySha: null, // §7: reference slots pin inputs, not the image
          secondarySha: null, // fix #8: reference slots pin the fork by GENERATION
          storeDigest: reply.storeDigest,
          terminal: {
            tail: txTailSnapshot(),
            viewportY: term.buffer.active.viewportY,
            modes: txModes.snapshot(),
          },
          carriedPrimary,
          carriedSecondary,
          secondaryGeneration: confirmedForkGeneration,
          pendingForkGeneration,
        },
      });
      // Fix #8: the fork row is no longer written here — the worker's
      // fork-snapshot message (posted after this reply, killable by a
      // teardown) carries the bytes, and its handler confirms the
      // clean epoch. The slot above reconstructs either way.
      // Overlay chunks THIRD, then the ack that lets the worker drop
      // the epoch. A teardown before the commit leaves the slot's
      // carried copy as the only survivor — exactly what restore folds.
      if (reply.overlayEpoch != null) {
        try {
          await overlayStore.putChunks(ensureOverlayId(), reply.overlayEpoch.chunks, {
            chunkSizeBytes: reply.overlayEpoch.chunkSizeBytes,
            baseFingerprint: reply.baseFingerprint ?? bootFingerprint,
          });
          const ack: MainToWorkerMessage = {
            type: 'overlay-swept',
            epochId: reply.overlayEpoch.epochId,
            ok: true,
          };
          worker.postMessage(ack);
        } catch (err) {
          const nack: MainToWorkerMessage = {
            type: 'overlay-swept',
            epochId: reply.overlayEpoch.epochId,
            ok: false,
            detail: String(err),
          };
          worker.postMessage(nack);
          throw err;
        }
      }
      replyForNack = null; // every delta settled (acked or nacked)
      // The ticking timestamp (field ask): the label reads
      // STATE (hh:mm:ss) and updates every landed capture.
      leds?.set(
        'state', 'green',
        'resume slot fresh — a reload resumes from this moment',
        new Date().toLocaleTimeString(),
      );
      // Chatty on purpose (debug trace): when chasing a torn restore,
      // "when was the last good capture?" is the first question.
      dbg(`resume slot captured${force ? ' (forced)' : ''}`);
    })()
      .catch((err: unknown) => {
        console.warn('[emu86] resume-slot capture failed:', err);
        resumeSlotBroken = true;
        leds?.set('state', 'red', 'resume machinery degraded — reload cold-boots', null);
        // Degrade to the pre-M2 pair from here on (stats handler
        // checks resumeSlotBroken). Fold any unsettled deltas back
        // FIRST — the flush below re-sweeps them the moment the
        // nacked epoch settles.
        if (replyForNack !== null) nackCaptureDeltas(replyForNack);
        if (latestDirtySectors > 0) maybeAutoPersist(true);
        const flush: MainToWorkerMessage = { type: 'overlay-flush' };
        worker.postMessage(flush);
      })
      .finally(() => {
        resumeCaptureInFlight = false;
        lastResumeCaptureAt = Date.now();
        if (forceQueued) {
          forceQueued = false;
          maybeRefreshResumeSlot(true);
        }
      });
  }

  // Tab going to the background still forces a capture past the
  // throttle — the freshest slot we can manage before a likely
  // close/reload. NO pause here: visibilitychange fires on plain tab
  // switches, and a hidden tab must keep running (cat serves mouse's
  // telnet from the background).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      dbg('hidden — forcing a resume-slot capture (tab switch or pre-close)');
      maybeRefreshResumeSlot(true);
    }
  });

  // REAL teardown (field find, 2026-07-16: "deliberately refreshed
  // quickly" mid-line wedged the telnet — the machine kept running
  // for the ~100-300 ms between the last capture and page death, and
  // the keystroke's TCP round trip inside that sliver rewound the
  // restored endpoint behind its peer). pagehide fires only on
  // navigation/close, never on tab switches: FREEZE the machine
  // first, then capture the frozen state — nothing moves in the
  // sliver, so the restored state IS the death state and the peer's
  // unACKed sends retransmit into the resumed session. pageshow
  // (bfcache revival) thaws; the pacer's paused-turn skip keeps the
  // frozen wall time out of guest time.
  window.addEventListener('pagehide', () => {
    // reason 'teardown' (TAN-freeze M2): the worker also tells peers
    // with open connections to hold still through the reload gap.
    dbg('pagehide — teardown freeze + final capture (page is dying)');
    const freeze: MainToWorkerMessage = {
      type: 'set-paused',
      paused: true,
      reason: 'teardown',
    };
    worker.postMessage(freeze);
    maybeRefreshResumeSlot(true);
  });
  window.addEventListener('pageshow', () => {
    dbg('pageshow — bfcache revival thaw');
    const thaw: MainToWorkerMessage = { type: 'set-paused', paused: false };
    worker.postMessage(thaw);
  });

  // Multi-PC brief M2: the tab→rack move. The affordance appears only
  // while a rack tab is announcing, and never inside a rack iframe
  // (an embedded PC has nowhere further to move). The dance is the F5
  // path aimed elsewhere: freeze (+ TAN freeze), await a durable slot
  // row, hand the session record to the rack, navigate to moved.html.
  const moveBtn = document.getElementById('move-to-rack') as HTMLButtonElement | null;
  if (moveBtn !== null && embeddedPcId === null) {
    // The literal bridges DOM BroadcastChannel to the module's
    // structural channel shape (the worker.ts onmessage-setter trick).
    const rackChannelRaw = new BroadcastChannel(RACK_CHANNEL_NAME);
    const mover = mountMoveToRack({
      channel: {
        postMessage: (data: unknown) => rackChannelRaw.postMessage(data),
        set onmessage(handler: ((ev: { data: unknown }) => void) | null) {
          rackChannelRaw.onmessage = handler;
        },
      },
      onRackPresence: (present) => {
        moveBtn.hidden = !present;
      },
      freeze: () => {
        dbg('migrate — freezing for handover (teardown freeze)');
        const msg: MainToWorkerMessage = {
          type: 'set-paused',
          paused: true,
          reason: 'teardown',
        };
        worker.postMessage(msg);
      },
      unfreeze: () => {
        dbg('migrate — aborted, machine resumed here');
        const msg: MainToWorkerMessage = { type: 'set-paused', paused: false };
        worker.postMessage(msg);
        term.focus();
      },
      settleResumeSlot: async () => {
        // Drain any in-flight beat, then capture the frozen machine.
        await resumeCaptureSettled.catch(() => { /* that beat already reported */ });
        maybeRefreshResumeSlot(true);
        await resumeCaptureSettled;
        dbg('migrate — resume slot durable, handing over');
      },
      slotFreshSince: async (since) => {
        const meta = await machineStore.getMeta(ownResumeSlotId);
        return meta !== null && meta.lastTouched >= since;
      },
      currentRecord: () => loadSession(),
      currentName: () => {
        const octet = loadSession().tanHostOctet;
        return octet !== null ? nameForOctet(octet) : null;
      },
      clearOwnSession: () => {
        // A later visit to ./ in this tab must mint a fresh PC, not
        // fight the rack over the one that just moved.
        try {
          sessionStorage.removeItem(storageKeyFor(null));
        } catch { /* nothing to clear */ }
      },
      report: (text) => syslog.log(text, { toast: true }),
      navigateToMoved: (name) => {
        dbg('migrate — adopted by the rack, navigating to moved.html');
        location.replace(
          `./moved.html${name !== null ? `?name=${encodeURIComponent(name)}` : ''}`,
        );
      },
    });
    moveBtn.addEventListener('click', () => {
      void mover.requestMove();
    });
  }

  // Rack M3: an embedded PC obeys two parent commands — freeze/thaw
  // (the package capture holds the whole rack still) and save-named
  // (a member capture, answered with its stateId for the manifest).
  // Source-gated to the parent window; nothing else may drive us.
  if (embeddedPcId !== null) {
    window.addEventListener('message', (e: MessageEvent<unknown>) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      const data = e.data;
      if (typeof data !== 'object' || data === null) return;
      const cmd = data as {
        emu86?: unknown;
        paused?: unknown;
        label?: unknown;
        requestId?: unknown;
      };
      if (cmd.emu86 === 'set-paused' && typeof cmd.paused === 'boolean') {
        dbg(cmd.paused ? 'rack command — machine frozen' : 'rack command — machine resumed');
        const msg: MainToWorkerMessage = { type: 'set-paused', paused: cmd.paused };
        worker.postMessage(msg);
        return;
      }
      if (cmd.emu86 === 'focus') {
        // Rail selection (field ask 2026-07-18): the rack focuses the
        // iframe window; the terminal inside needs it explicitly.
        term.focus();
        return;
      }
      if (
        cmd.emu86 === 'save-named' &&
        typeof cmd.label === 'string' &&
        typeof cmd.requestId === 'number'
      ) {
        const requestId = cmd.requestId;
        void saveNamedState(cmd.label)
          .then((stateId) => {
            window.parent.postMessage(
              { emu86: 'named-saved', pc: embeddedPcId, requestId, ok: true, stateId },
              location.origin,
            );
          })
          .catch((err: unknown) => {
            window.parent.postMessage(
              { emu86: 'named-saved', pc: embeddedPcId, requestId, ok: false, error: String(err) },
              location.origin,
            );
          });
      }
    });
  }

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

  /**
   * Save a NAMED machine state (Phase 18 M2, D2(a) self-contained):
   * capture with embedded disks, gzip the images (~10:1 on
   * mostly-empty MINIX zones), store meta + payload in one
   * transaction. The two-phase law (§1.4) holds by construction: the
   * capture's worker-side final overlay sweep covers the boot disk,
   * and the fork row is force-written here — awaited — from the
   * capture's own secondary bytes before the state row lands.
   */
  /**
   * The embedded-capture persistence core: capture → gzip → one
   * machine-store row. Named saves and clone couriers (Phase 18 M3,
   * D3(a): "one code path shared with save-states") differ only in
   * row identity.
   */
  async function persistEmbeddedCapture(row: {
    stateId: string;
    kind: MachineStateKind;
    label: string | null;
  }): Promise<void> {
    const reply = await requestCapture('embedded');
    if (
      !reply.ok ||
      reply.state === undefined ||
      reply.capturedAt === undefined ||
      reply.primary === undefined
    ) {
      throw new Error(reply.reason ?? 'capture failed');
    }
    if (drive !== null && reply.secondary != null) {
      await library.updateImageBytes(drive.imageId, reply.secondary.bytes);
    }
    const primaryGz = await gzipBytes(reply.primary.bytes);
    const secondaryGz =
      reply.secondary != null ? await gzipBytes(reply.secondary.bytes) : null;
    const now = Date.now();
    await machineStore.putState({
      meta: {
        stateId: row.stateId,
        label: row.label,
        kind: row.kind,
        createdAt: now,
        lastTouched: now,
        baseFingerprint: reply.baseFingerprint ?? null,
        schemaVersion: MACHINE_STATE_SCHEMA_VERSION,
        sizeBytes: roughStateSize(
          reply,
          primaryGz.byteLength + (secondaryGz?.byteLength ?? 0),
        ),
      },
      payload: {
        stateId: row.stateId,
        state: reply.state,
        capturedAt: reply.capturedAt,
        primary: {
          gz: primaryGz,
          geometry: reply.primary.geometry,
          diskClass: reply.primary.diskClass,
        },
        secondary:
          reply.secondary != null && secondaryGz !== null
            ? {
                gz: secondaryGz,
                geometry: reply.secondary.geometry,
                diskClass: reply.secondary.diskClass,
              }
            : null,
        primarySha: reply.primarySha ?? null,
        secondarySha: reply.secondarySha ?? null,
        terminal: {
          tail: txTailSnapshot(),
          viewportY: term.buffer.active.viewportY,
          modes: txModes.snapshot(),
        },
      },
    });
  }

  async function saveNamedState(label: string): Promise<string> {
    const stateId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `named-${crypto.randomUUID()}`
        : `named-${Math.random().toString(36).slice(2)}`;
    await persistEmbeddedCapture({ stateId, kind: 'named', label });
    return stateId; // rack M3: the package manifest needs the id
  }

  // Phase 18 M3: every tab answers the clone channel as a potential
  // parent. The child names its parent by the inherited sessionId;
  // requests naming anyone else are ignored here. A pre-boot request
  // fails honestly ("no machine is running") and the child cold-boots.
  mountCloneParent(cloneChannel, {
    sessionId: () => loadSession().sessionId,
    saveCloneState: async (childSessionId: string) => {
      const stateId = `clone-${childSessionId}`;
      await persistEmbeddedCapture({ stateId, kind: 'clone', label: null });
      return stateId;
    },
    onServed: (child, ok) => {
      syslog.log(
        ok
          ? 'clone: a duplicated tab asked for this machine — snapshot served, frozen in amber'
          : 'clone: failed to serve a duplicated tab (it cold-boots instead)',
      );
    },
  });

  // Phase 17 M3 — the hello-human show. The fork's seeded .profile
  // emits the marker exactly once per drive (guest-initiated); the
  // host renders the performance through the SAME typing relay as
  // boot scripts, with the key-click silenced (Jonathan: "the typing
  // relay minus the cheezy sound fx"). The script is the landing
  // demo's ceremony minus its login/net lines — autologin already
  // landed us at the prompt, and net is suppressed on show boots.
  const showScriptText = SEED_DEMO_SCRIPT.text
    .split('\n')
    .filter((line) => line !== 'root' && line !== 'net start ne0')
    .join('\n');
  const showDecoder = new TextDecoder();
  let showRunner: AutoexecRunner | null = null;
  // Field ask (2026-07-17): the AUTOMATIC show is gone — no marker
  // watching, no first-boot performance ("has been making things
  // complicated to test"). The show now plays from the ▶ button next
  // to the gear, exactly once, then the button retires forever
  // (settings.demoPlayed). Old forks' persisted .profile may print
  // the legacy marker line once — cosmetic, ignored.
  function playDemoShow(): void {
    if (showRunner !== null) return;
    showRunner = new AutoexecRunner({
      script: showScriptText,
      send: (t) => {
        const msg: MainToWorkerMessage = { type: 'rx', bytes: new TextEncoder().encode(t) };
        worker.postMessage(msg);
      },
      // No onKeystroke: the runner's default is silent keys.
      setSpeed: (mode) => {
        const msg: MainToWorkerMessage = { type: 'set-speed', mode };
        worker.postMessage(msg);
      },
      onDone: () => {
        // The ceremony ends @authentic — restore the user's setting.
        const msg: MainToWorkerMessage = { type: 'set-speed', mode: settings.cpuSpeed };
        worker.postMessage(msg);
        showRunner = null;
      },
    });
  }

  // The ▶ demo button (top panel, next to the gear). One click, one
  // showing, gone forever — and it types into whatever is on screen,
  // so it wants a shell prompt, same contract the auto-show had.
  if (!settings.demoPlayed) {
    const demoBtn = document.createElement('button');
    demoBtn.id = 'demo-button';
    demoBtn.type = 'button';
    demoBtn.textContent = '▶ demo';
    demoBtn.title = 'Play the "hello human" demo (types into the machine — best at a shell prompt). One showing; the button then retires.';
    demoBtn.setAttribute('aria-label', 'Play the demo once');
    document.body.appendChild(demoBtn);
    demoBtn.addEventListener('click', () => {
      demoBtn.remove();
      settings = { ...settings, demoPlayed: true };
      saveSettings(settings);
      syslog.log('the show: playing once — the button retires (the machine types by itself now)');
      playDemoShow();
      // Kick (field: the button "did nothing"): the runner is
      // TX-driven, and a machine idling at a prompt emits no TX to
      // feed it. A bare newline makes the shell reprint its prompt —
      // exactly the output the runner's first step matches on.
      const kick: MainToWorkerMessage = { type: 'rx', bytes: new Uint8Array([0x0a]) };
      worker.postMessage(kick);
      term.focus();
    });
  }

  worker.addEventListener('message', (event: MessageEvent<WorkerToMainMessage>) => {
    const msg = event.data;
    if (msg.type === 'tx') {
      term.write(msg.bytes);
      txTailAppend(msg.bytes);
      txModes.feed(msg.bytes);
      if (autoexec !== null && autoexec.active) {
        autoexec.feed(txDecoder.decode(msg.bytes, { stream: true }));
      }
      const showText = showDecoder.decode(msg.bytes, { stream: true });
      if (showRunner !== null && showRunner.active) {
        showRunner.feed(showText);
      }
      return;
    }
    if (msg.type === 'ready') {
      // Boot started. The ELKS Setup banner (BIOS INT 10h teletype)
      // and the post-set_console UART traffic both stream via `tx`
      // messages — see worker-host.ts shared txBuffer.
      postRackStatus({ state: 'running' });
      dbg('boot ready — machine running');
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
    if (msg.type === 'fork-snapshot') {
      // Fix #8: the fork row's bytes arrive AFTER the capture reply,
      // on their own killable message. Persist when the beat had
      // anything to persist (or was forced), stamp the generation the
      // slot row already named, confirm the clean epoch either way.
      const expected = pendingForkWrites.get(msg.requestId);
      if (expected === undefined) return; // a nacked/abandoned beat
      pendingForkWrites.delete(msg.requestId);
      void (async () => {
        let ok = false;
        try {
          if (drive !== null && (expected.carriedCount > 0 || expected.force)) {
            await library.updateImageBytes(drive.imageId, msg.bytes, expected.generation);
            driveBanner.autoSaved();
            editorPanel?.driveUpdated(msg.bytes);
            confirmedForkGeneration = expected.generation;
            ok = true;
          } else {
            // Clean beat: confirm only a truly-empty pending set;
            // anything else stays unconfirmed and re-carries.
            ok = expected.carriedCount === 0;
          }
        } catch (err) {
          console.warn('[emu86] fork-snapshot persist failed:', err);
          ok = false;
        }
        const settle: MainToWorkerMessage = {
          type: 'secondary-persisted',
          requestId: msg.requestId,
          ok,
        };
        worker.postMessage(settle);
      })();
      return;
    }
    if (msg.type === 'state-captured') {
      // Phase 18 M2: route by requestId — capture flows can overlap.
      const sink = captureSinks.get(msg.requestId);
      if (sink !== undefined) {
        captureSinks.delete(msg.requestId);
        sink(msg);
      } else {
        console.warn('[emu86] unsolicited state-captured reply:', msg.requestId);
      }
      return;
    }
    if (msg.type === 'machine-inspected') {
      const sink = inspectSinks.get(msg.requestId);
      if (sink !== undefined) {
        inspectSinks.delete(msg.requestId);
        sink(msg);
      }
      return;
    }
    if (msg.type === 'tan-freeze') {
      // TAN-freeze M2: our machine is holding still for a dying peer.
      const peer = msg.peerName ?? `10.0.2.${msg.peerOctet}`;
      const services = msg.connections
        .map((c) => {
          // The service end of the flow: our local port when the peer
          // dialed us, their port when we dialed them; either when the
          // flow was picked up mid-stream.
          const port = c.outbound === false ? c.localPort : c.peerPort;
          return TAN_SERVICE_NAMES[port] ?? `:${port}`;
        })
        .join(', ');
      syslog.log(
        `machine frozen — waiting for ${peer}${services !== '' ? ` (${services})` : ''} to reload`,
        { toast: true },
      );
      postRackStatus({ state: 'frozen' });
      return;
    }
    if (msg.type === 'tan-thaw') {
      const peer = msg.peerName ?? `10.0.2.${msg.peerOctet}`;
      syslog.log(
        msg.outcome === 'returned'
          ? `machine resumed — ${peer} is back`
          : `machine resumed — gave up waiting for ${peer}`,
        { toast: true },
      );
      postRackStatus({ state: 'running' });
      return;
    }
    if (msg.type === 'restore-result') {
      // Phase 18 M2 honesty: a fresh resume is silent (the crown's
      // "nothing breaks"); a stale one says when it's from; a refusal
      // says why the machine cold-booted instead. A refused RESUME
      // slot is deleted — it describes a world that no longer exists,
      // and the next hidden-capture rewrites it.
      if (msg.ok) {
        // The restored screen: replay the captured TX tail through
        // xterm — literally the same output stream, so the rendering
        // (colors, cursor position) reproduces itself. Then re-scroll.
        const terminal = pendingTerminalRestore;
        if (terminal !== null && terminal.tail.byteLength > 0) {
          term.reset();
          txTailAppend(terminal.tail); // the tail is history going forward too
          term.write(terminal.tail, () => {
            try {
              const delta = terminal.viewportY - term.buffer.active.viewportY;
              if (delta !== 0) term.scrollLines(delta);
            } catch { /* scroll restore is a nicety, never an error */ }
          });
          // Field fix #5: the tail reproduces content, not modes whose
          // set/reset predates its window — re-assert the captured
          // final state AFTER the replay (queued writes keep order),
          // and seed the live tracker so future captures carry it.
          const modes = terminal.modes ?? [];
          if (modes.length > 0) {
            term.write(modeSequence(modes));
            txModes.seed(modes);
          }
        }
        const age = msg.capturedAt !== undefined ? Date.now() - msg.capturedAt : null;
        // The fresh resume is deliberately SILENT in the syslog (the
        // crown's "nothing breaks") — but the debug trace tells all.
        dbg(`restore resumed ok (state from ${age !== null ? describeAge(age) : '?'} ago)`);
        if (age !== null && age > RESTORE_NOTICE_AGE_MS) {
          syslog.log(`resumed machine state from ${describeAge(age)} ago`, { toast: true });
        }
        if (activeRestoreStateId !== null) {
          void machineStore.touch(activeRestoreStateId);
        }
      } else {
        syslog.log(
          `couldn't resume saved state — ${msg.reason ?? 'unknown'}; cold-booting instead`,
          { toast: true },
        );
        if (activeRestoreStateId === ownResumeSlotId) {
          void machineStore.deleteState(ownResumeSlotId);
        }
      }
      // Field fix #6 (Jonathan, 2026-07-17): a duplicated tab's resume
      // or a fresh restore boot landed without keyboard focus — the
      // mount-time focus() predates the restore flow. Focus follows
      // the outcome either way (a refusal's cold boot types too).
      term.focus();
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
        syslog.log(
          'machine state was saved against a different base image — ' +
            'kept unused; Settings → Machine state can discard it',
          { toast: true },
        );
      }
      return;
    }
    if (msg.type === 'tan-identity') {
      // Sticky IP: persist the settled octet so the next reload offers
      // it back to the lease; tell the user where they live — and WHO
      // they are. The tab's name IS its hostname on the .tabs network
      // (Phase 15 M4), so it titles the browser tab too: a row of open
      // tabs reads mouse / cat / dog. Toast only when the address
      // CHANGED — a sticky re-lease on reload is old news.
      const octetChanged = loadSession().tanHostOctet !== msg.hostOctet;
      saveSession({ tanHostOctet: msg.hostOctet });
      postRackStatus({ name: msg.name ?? null, octet: msg.hostOctet });
      dbg.setIdentity(msg.hostOctet, msg.name ?? null);
      if (msg.detached === true) {
        // Phase 18 M3 field find: a restored (cloned / named-save)
        // machine wears the CAPTURE's network identity, so its cable
        // is deliberately unplugged from the tab network — attached,
        // it would answer for the original machine and RST its
        // connections. The lease below is for the NEXT reboot.
        if (msg.name !== undefined) document.title = `${msg.name}.tabs (detached) — emu86`;
        syslog.log(
          'restored machine: tab-network cable detached (the guest still wears ' +
            `its original identity) — reboot to rejoin as ${
              msg.name !== undefined ? `${msg.name}.tabs at ` : ''
            }10.0.2.${msg.hostOctet}. Internet via the gateway still works.`,
          { toast: true },
        );
      } else if (msg.name !== undefined) {
        document.title = `${msg.name}.tabs — emu86`;
        syslog.log(
          `you are ${msg.name}.tabs at 10.0.2.${msg.hostOctet} — ` +
            'the gateway is elk.tabs',
          { toast: octetChanged },
        );
      } else {
        syslog.log(`TAN address: 10.0.2.${msg.hostOctet}`, { toast: octetChanged });
      }
      return;
    }
    if (msg.type === 'stats') {
      // Pacing telemetry (~1/sec). Console-only by design — the numbers
      // are for the pacing report and the dev /agent/stats endpoint.
      latestStats = msg;
      // Field fix #8: live TAN flows tighten the resume-slot cadence.
      latestTanFlows = msg.tanFlows ?? 0;
      // Fork auto-persist rides the same heartbeat: dirty sectors mean
      // guest writes since the last snapshot. Phase 18 M2 field fix:
      // while the resume machinery is healthy, the CAPTURE is the
      // persistence path (one snapshot feeds fork row + slot row, so
      // the hash pairing can't race); maybeAutoPersist is the
      // degraded-mode fallback.
      if (typeof msg.secondaryDirtySectors === 'number') {
        latestDirtySectors = msg.secondaryDirtySectors;
        if (msg.secondaryDirtySectors > 0) {
          driveBanner.dirty(msg.secondaryDirtySectors);
        }
      }
      if (!resumeSlotBroken) {
        maybeRefreshResumeSlot();
      } else if (latestDirtySectors > 0) {
        maybeAutoPersist();
      }
      // LEDs sample the same beat. Idle detection: an ELKS at the
      // prompt executes a few-thousand instr/s of timer ticks; a busy
      // one runs six figures and up.
      if (leds !== null) {
        const busy = msg.instrPerSec >= 100_000;
        leds.set(
          'cpu',
          msg.mode === 'turbo' ? 'blue' : busy ? 'green' : 'dim',
          `${msg.instrPerSec.toLocaleString()} instr/s · ` +
            `${(msg.realTimeRatio * 100).toFixed(0)}% of 4.77 MHz · ${msg.mode}`,
        );
        const hot = (msg.overlayHotSectors ?? 0) + (msg.secondaryDirtySectors ?? 0);
        leds.set(
          'disk',
          hot > 0 ? 'amber' : 'dim',
          `${msg.overlayHotSectors ?? 0} unswept boot-disk sectors · ` +
            `${msg.secondaryDirtySectors ?? 0} unpersisted drive sectors`,
        );
        if (hot !== lastDiskHot) leds.flash('disk');
        lastDiskHot = hot;
        const frames = (msg.nicRxFrames ?? 0) + (msg.nicTxFrames ?? 0);
        leds.set(
          'net',
          frames > 0 ? 'green' : 'dim',
          `${msg.nicRxFrames ?? 0} frames in · ${msg.nicTxFrames ?? 0} frames out`,
        );
        if (frames > lastNetFrames) leds.flash('net');
        lastNetFrames = frames;
      }
      console.debug(
        `[emu86] ${msg.instrPerSec.toLocaleString()} instr/s ` +
          `(${(msg.realTimeRatio * 100).toFixed(0)}% of 4.77 MHz), ` +
          `${msg.mode}, batch ${msg.batch}`,
      );
      return;
    }
    if (msg.type === 'halted') {
      syslog.log(`machine halted — ${msg.reason}`, { toast: true });
      postRackStatus({ state: 'halted' });
      return;
    }
    if (msg.type === 'error') {
      syslog.log(
        `machine error — ${msg.message}${msg.stack ? `\n${msg.stack}` : ''}`,
        { toast: true },
      );
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
  // XMS (brief M2): browser machines get 4 MiB — 3 MiB of extended
  // memory reachable via the BIOS block move, which ELKS's XMS_INT15
  // mode turns into buffer/ramdisk space OUTSIDE the 640 K. The goal
  // (Jonathan): network and compiling in the same boot session.
  boot.config.memorySize = 4 * 1024 * 1024;
  // Phase 17 M3 — the un-typed boot: inittab autologin + net=ne0
  // stamps ride the boot config; the worker suppresses net on a
  // first-boot-show boot (640K: ktcp vs the compile show).
  boot.config.autologin = settings.autologin;
  boot.config.autoNet = settings.autoNet;
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

  // Phase 18 M2/M3 — restore carriage. Three sources, one BootConfig
  // field:
  //   1. A queued NAMED restore (settings → Restore…): embedded disks,
  //      gunzipped here, fed to the worker verbatim.
  //   2. A CLONE handshake (M3, origin 'duplicate'): the parent wrote
  //      an embedded snapshot to emu86-machines and broadcast its
  //      stateId — same carriage as 1, one-shot row.
  //   3. This tab's reload-resume slot: reference form — the pure
  //      pipeline reconstructs the disks and the INPUTS must verify
  //      (§7). Gated on origin === 'reload'.
  // Failures here NEVER block the boot — worst case is the cold boot
  // the tab would have done before M2 existed.

  /** Wire one embedded row (named save or clone courier) into the
   *  boot config. Returns false when the row can't be used. */
  const applyEmbeddedRestore = async (
    rec: MachineStateRecord,
  ): Promise<boolean> => {
    if (
      rec.meta.schemaVersion !== MACHINE_STATE_SCHEMA_VERSION ||
      rec.payload.primary === null
    ) {
      return false;
    }
    const primaryBytes = await gunzipBytes(rec.payload.primary.gz);
    const secondaryBytes =
      rec.payload.secondary !== null ? await gunzipBytes(rec.payload.secondary.gz) : null;
    boot.config.restore = {
      state: rec.payload.state,
      capturedAt: rec.payload.capturedAt,
      embedded: {
        primary: {
          imageBytes: primaryBytes,
          geometry: rec.payload.primary.geometry,
          diskClass: rec.payload.primary.diskClass,
        },
        secondary:
          secondaryBytes !== null && rec.payload.secondary !== null
            ? {
                imageBytes: secondaryBytes,
                geometry: rec.payload.secondary.geometry,
                diskClass: rec.payload.secondary.diskClass,
              }
            : null,
      },
    };
    if (primaryBytes.buffer instanceof ArrayBuffer) bootTransfers.add(primaryBytes.buffer);
    if (secondaryBytes !== null && secondaryBytes.buffer instanceof ArrayBuffer) {
      bootTransfers.add(secondaryBytes.buffer);
    }
    pendingTerminalRestore = rec.payload.terminal ?? null;
    return true;
  };

  // Fix #8: read the fork row's current generation once — it seeds
  // the confirmed-generation bookkeeping every slot row records, and
  // it is the pin the reload-resume acceptance below checks.
  let bootForkGeneration: string | null = null;
  if (drive !== null) {
    try {
      const meta = (await library.listImages()).find((m) => m.id === drive.imageId);
      bootForkGeneration = meta?.generation ?? null;
    } catch { /* no generation → fresh-fork semantics below */ }
  }
  confirmedForkGeneration = bootForkGeneration;

  try {
    // Queued reboot (field loop): consume the flag, skip the resume
    // once, drop the slot. RAM restarts; overlay + fork persist — a
    // real PC's reset button, restored to existence after reload-
    // resume took the old one (reloading the page) away.
    const coldBootQueued = session.pendingColdBoot;
    if (coldBootQueued) {
      saveSession({ pendingColdBoot: false });
      void machineStore.deleteState(ownResumeSlotId).catch(() => { /* best effort */ });
      syslog.log('rebooting — machine state restarts, disk state kept');
    }
    const pendingRestoreId = session.pendingRestoreStateId;
    if (coldBootQueued) {
      // fall through to a plain cold boot
    } else if (pendingRestoreId !== null) {
      saveSession({ pendingRestoreStateId: null }); // consume the flag first
      const rec = await machineStore.getState(pendingRestoreId);
      if (rec !== null && (await applyEmbeddedRestore(rec))) {
        activeRestoreStateId = pendingRestoreId;
        syslog.log(
          `restoring saved state${rec.meta.label !== null ? ` '${rec.meta.label}'` : ''}…`,
          { toast: true },
        );
      } else {
        syslog.log('saved state unavailable or from a different era — cold-booting', { toast: true });
      }
    } else if (cloneParentInfo !== null) {
      // Phase 18 M3: this tab is a duplicate. Ask WHICH thing the
      // user meant (field ask): a new PC (the pre-M3 reboot — copied
      // disks, own name, full network) or the parent's live session
      // frozen in amber (detached until reboot). The handshake only
      // runs on 'resume', so the snapshot is fresh at decision time.
      const modal = askCloneChoice(cloneParentInfo.parentName);
      const picked = await modal.choice;
      if (picked === 'fresh') {
        modal.close();
        syslog.log('duplicated tab: booting as a new PC (disks copied, fresh machine)');
        // fall through to the plain cold boot below
      } else {
        modal.setBusy('asking the original tab for its machine state…');
        const cloneStateId = await requestCloneState(
          cloneChannel,
          cloneParentInfo.parentSessionId,
          cloneParentInfo.childSessionId,
          {
            onAccepted: () =>
              modal.setBusy('the original tab is capturing its machine…'),
          },
        );
        if (cloneStateId === null) {
          modal.close();
          syslog.log(
            'clone: no snapshot from the original tab — booting as a new PC instead',
            { toast: true },
          );
        } else {
          const rec = await machineStore.getState(cloneStateId);
          // One-shot courier: the row dies now whatever happens next
          // (the boot-time age sweep is only the backstop).
          void machineStore.deleteState(cloneStateId).catch(() => { /* best effort */ });
          if (rec !== null && (await applyEmbeddedRestore(rec))) {
            modal.close();
            syslog.log(
              'clone: frozen in amber — resuming the original tab’s machine (its network re-leases on reboot)',
              { toast: true },
            );
          } else {
            modal.close();
            syslog.log('clone: snapshot unusable — booting as a new PC instead', { toast: true });
          }
        }
      }
      // Field fix #6 (Jonathan, 2026-07-17): the choice dialog's
      // buttons took keyboard focus and nothing gave it back — every
      // duplicate landed with a dead keyboard until a click. All
      // branches funnel here; the restore-result handler covers the
      // restore flows the dialog doesn't see.
      term.focus();
    } else if (overlaySession !== null && overlaySession.origin === 'reload') {
      const rec = await machineStore.getState(ownResumeSlotId);
      // §7: only storeDigest slots can be verified now. A pre-§7 row
      // (primarySha era) cold-boots once, honestly, and is deleted —
      // the next heartbeat writes a new-style slot. Fix #8 repeats
      // the transition: a secondarySha-era row (no generation pin)
      // also refuses once and is deleted.
      const preFix8 =
        rec !== null &&
        drive !== null &&
        rec.payload.pendingForkGeneration === undefined;
      if (rec !== null && ((rec.payload.storeDigest ?? null) === null || preFix8)) {
        void machineStore.deleteState(ownResumeSlotId).catch(() => { /* best effort */ });
      }
      // Fix #8, the drive pin: the fork row's generation must be one
      // of the two the slot names — the confirmed base its delta
      // folds over, or the write its own capture began (either tear
      // arm reconstructs; anything else means the fork was rewritten
      // out from under the slot, e.g. by the editor, and folding the
      // delta over foreign bytes would corrupt silently).
      const forkGenerationOk =
        drive === null ||
        (rec !== null &&
          rec.payload.pendingForkGeneration !== undefined &&
          (bootForkGeneration === (rec.payload.secondaryGeneration ?? null) ||
            bootForkGeneration === rec.payload.pendingForkGeneration));
      if (rec !== null && !preFix8 && !forkGenerationOk) {
        syslog.log(
          'saved state does not match this drive (rewritten since the capture?) — cold-booting',
          { toast: true },
        );
        void machineStore.deleteState(ownResumeSlotId).catch(() => { /* best effort */ });
      }
      if (
        rec !== null &&
        !preFix8 &&
        forkGenerationOk &&
        rec.meta.schemaVersion === MACHINE_STATE_SCHEMA_VERSION &&
        typeof rec.payload.storeDigest === 'string' &&
        // Field fix #4: a carried delta needs the slot's base identity
        // for the worker's fingerprint gate — a row that has one
        // without the other can't be trusted; cold-boot honestly.
        (rec.payload.carriedPrimary == null || rec.meta.baseFingerprint !== null)
      ) {
        const carriedPrimary =
          rec.payload.carriedPrimary != null && rec.meta.baseFingerprint !== null
            ? {
                chunkSizeBytes: rec.payload.carriedPrimary.chunkSizeBytes,
                fingerprint: rec.meta.baseFingerprint,
                chunks: rec.payload.carriedPrimary.chunks,
              }
            : null;
        boot.config.restore = {
          state: rec.payload.state,
          capturedAt: rec.payload.capturedAt,
          expected: {
            storeDigest: rec.payload.storeDigest,
            secondarySha: rec.payload.secondarySha,
          },
          ...(carriedPrimary !== null ? { carriedPrimary } : {}),
          ...(rec.payload.carriedSecondary != null
            ? { carriedSecondary: rec.payload.carriedSecondary }
            : {}),
        };
        if (carriedPrimary !== null) {
          for (const c of carriedPrimary.chunks) {
            if (c.bytes.buffer instanceof ArrayBuffer) bootTransfers.add(c.bytes.buffer);
          }
        }
        for (const s of rec.payload.carriedSecondary ?? []) {
          if (s.bytes.buffer instanceof ArrayBuffer) bootTransfers.add(s.bytes.buffer);
        }
        activeRestoreStateId = ownResumeSlotId;
        pendingTerminalRestore = rec.payload.terminal ?? null;
      }
    }
  } catch (err) {
    console.warn('[emu86] restore unavailable, cold-booting:', err);
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
      onReboot: () => {
        saveSession({ pendingColdBoot: true });
        location.reload();
      },
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
      // Phase 18 M2 — named save-states (D4: user-curated library
      // semantics; never aged out, user-deletable). Restore = queue +
      // reload, the overlayResetPending pattern: a running machine
      // can't un-write its RAM.
      savedStates: {
        list: async (): Promise<MachineStateMeta[]> =>
          (await machineStore.listMeta())
            .filter((m) => m.kind === 'named')
            .sort((a, b) => b.lastTouched - a.lastTouched),
        save: async (label: string) => {
          await saveNamedState(label); // the modal ignores the id
        },
        restore: (stateId: string) => {
          saveSession({ pendingRestoreStateId: stateId });
          location.reload();
        },
        remove: (stateId: string) => machineStore.deleteState(stateId),
      },
    },
    // Field report 2026-07-16: hands live in the terminal.
    onClosed: () => term.focus(),
  });

  // Phase 18 field-loop UI: the LED strip in the header and the
  // freeze-and-inspect popup. Both are read-only affordances over the
  // running machine; degraded mounts (missing header) just skip.
  const headerH1 = document.querySelector<HTMLElement>('header h1');
  if (headerH1 !== null) {
    leds = mountStatusLeds(headerH1);
    leds.set('cpu', 'dim', 'waiting for the first stats beat');
    leds.set('disk', 'dim', 'no disk activity yet');
    leds.set('net', 'dim', 'no frames yet');
    leds.set('state', 'dim', 'no resume capture yet');
  }
  mountInspectPanel({
    setPaused: (paused) => {
      dbg(paused ? 'inspect popup — machine frozen' : 'inspect popup dismissed — machine resumed');
      const msg: MainToWorkerMessage = { type: 'set-paused', paused };
      worker.postMessage(msg);
    },
    inspect: async () => {
      const reply = await requestInspect();
      if (!reply.ok || reply.snapshot === undefined) {
        throw new Error(reply.reason ?? 'inspection failed');
      }
      return reply.snapshot;
    },
    // Save from the popup (Jonathan: "this would be a great place to
    // add the save machine state button") — same flow as the settings
    // modal's, capturing the frozen picture exactly.
    saveState: async (label: string) => {
      await saveNamedState(label); // popup ignores the id the rack needs
    },
    // …and restore from it too ("click - restore - boom"), and delete
    // (field ask 2026-07-16: "<dropdown> [Restore] [Delete]").
    savedStates: {
      list: async () =>
        (await machineStore.listMeta())
          .filter((m) => m.kind === 'named')
          .sort((a, b) => b.lastTouched - a.lastTouched),
      restore: (stateId: string) => {
        saveSession({ pendingRestoreStateId: stateId });
        location.reload();
      },
      remove: (stateId: string) => machineStore.deleteState(stateId),
    },
    // The reset button (field loop: "there is now no way to reboot the
    // pc" — reload-resume ate the old one). One-shot cold boot.
    reboot: () => {
      saveSession({ pendingColdBoot: true });
      location.reload();
    },
    // Field report 2026-07-16: hands live in the terminal.
    onClosed: () => term.focus(),
  });

  // The system-level editor (Phase 16 M4): a panel over THIS tab's
  // /dev/hdb — peek reads (never marking clean), whole-image writes
  // through M3, fork-row persistence for reload safety. Not mounted
  // in the no-drive degraded case (broken IDB): there is nothing for
  // it to edit and its empty states would lie.
  if (drive !== null) {
    const activeDrive = drive;
    editorPanel = mountEditorPanel({
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

  // (The landing showcase's background-stream-then-break-the-news
  // shape retired 2026-07-17 — the hard disk installs BEFORE the
  // first boot now; see installHardDiskNow near the top of main.)

  async function installHardDiskNow(current: Settings): Promise<Settings> {
    const status = ensureShowcaseBanner();
    try {
      let imageId: string;
      const existing = (await library.listImages()).find(
        (m) => m.name === 'hd32-minix.img',
      );
      if (existing !== undefined) {
        imageId = existing.id; // installed on an earlier visit
      } else {
        // Same-origin gzipped image first (Phase 17 follow-on): ~3 MB
        // over the wire instead of ~31 MB, no GitHub API rate limit,
        // byte-pinned to the repo's verified image. The release flow
        // stays as the fallback for hosts without the asset.
        const bytes = await fetchBundledHd(status) ?? await fetchReleaseHd(status);
        if (bytes === null) {
          status.hide();
          return current; // offline/degraded: the floppy still boots
        }
        imageId = await library.addImage('hd32-minix.img', bytes, 'github', 'likely-works');
      }
      status.hide();
      const next: Settings = {
        ...current,
        imageSource: { kind: 'library', id: imageId },
      };
      saveSettings(next);
      return next;
    } catch (err) {
      // Rate limits / offline / quota: degrade to the floppy honestly.
      console.warn('[emu86] hard-disk install failed — floppy fallback:', err);
      status.hide();
      return current;
    }
  }

  /** The same-origin gzipped HD image, or null if this host lacks it. */
  async function fetchBundledHd(
    status: ReturnType<typeof ensureShowcaseBanner>,
  ): Promise<Uint8Array | null> {
    try {
      const res = await fetch('/hd32-minix.img.gz');
      if (!res.ok || res.body === null) return null;
      const totalMb = Math.round(
        Number(res.headers.get('content-length') ?? 3_279_912) / 1048576,
      );
      status.show(`fetching a hard disk… 0 / ${totalMb} MB`);
      const bytes = await gunzipStream(res.body, (loaded) => {
        status.show(
          `fetching a hard disk… ${Math.round(loaded / 1048576)} / ${totalMb} MB`,
        );
      });
      return bytes;
    } catch (err) {
      // Corrupt asset (gzip CRC) or missing — the release flow decides.
      console.warn('[emu86] bundled hd32 gz unavailable:', err);
      return null;
    }
  }

  /** The original GitHub-releases flow — the fallback path. */
  async function fetchReleaseHd(
    status: ReturnType<typeof ensureShowcaseBanner>,
  ): Promise<Uint8Array | null> {
    const releases = await listReleases({ includePrereleases: false, prereleaseLimit: 0 });
    const asset = releases
      .flatMap((r) => r.assets)
      .find((a) => a.name === 'hd32-minix.img');
    if (asset === undefined) return null;
    status.show(`fetching a hard disk… 0 / ${Math.round(asset.sizeBytes / 1048576)} MB`);
    return downloadAsset(asset.downloadUrl, (p) => {
      const total = p.total ?? asset.sizeBytes;
      status.show(
        `fetching a hard disk… ${Math.round(p.loaded / 1048576)} / ${Math.round(total / 1048576)} MB`,
      );
    });
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
/**
 * Age threshold for the restore honesty notice (Phase 18 M2): a resume
 * younger than this is silent (the crown's fresh-reload case); older
 * says when it's from. Field-tuned — a plain reload round-trips in
 * well under a second, so anything past this is a genuinely old state.
 */
const RESTORE_NOTICE_AGE_MS = 10_000;

/**
 * Well-known ELKS service ports for the TAN-freeze toast — "waiting
 * for mouse (telnet)" reads better than "(:23)". Anything else shows
 * its number.
 */
const TAN_SERVICE_NAMES: Readonly<Record<number, string>> = {
  21: 'ftp',
  23: 'telnet',
  80: 'http',
};


/** Human-readable age for the restore notice. */
function describeAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

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
