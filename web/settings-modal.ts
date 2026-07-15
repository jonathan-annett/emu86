/**
 * Settings modal — vanilla DOM. No frameworks (the brief is explicit).
 *
 * Surface:
 *   - A gear button fixed top-right of the viewport.
 *   - A modal opened from the gear:
 *       * Font size (range 8–32, live preview).
 *       * Theme dropdown (5 presets, live preview).
 *       * Image source: a "Default (bundled)" entry plus the IDB library;
 *         per-row rename / delete / select-as-boot-source.
 *       * Storage usage (formatted from navigator.storage.estimate).
 *       * Upload button (file picker; .img / application/octet-stream).
 *
 * Accessibility:
 *   - Esc closes; gear regains focus.
 *   - Click outside the inner panel closes (background sink absorbs the
 *     click on the backdrop element only).
 *   - Focus trap: Tab/Shift+Tab cycles within the modal while open. The
 *     trap is opt-in only when the modal is open, so the rest of the page
 *     keeps default tab order otherwise.
 *
 * Image source vs live update:
 *   - Font and theme dispatch `settings-changed` so the running terminal
 *     updates immediately.
 *   - Image source applies on next reload (don't try to swap a running
 *     emulator's disk). The UI shows a "Reload to apply" notice when the
 *     selection differs from the booted source.
 */

import {
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  type BootScript,
  type ImageSource,
  type Settings,
} from './settings.js';
import {
  THEME_LABELS,
  THEME_PRESET_NAMES,
  type ThemePresetName,
} from './themes.js';
import type { ImageLibrary, StoredImageMeta } from './image-library.js';
import { DRIVE_PRESETS } from './image-library.js';
import {
  listReleases,
  downloadAsset,
  RateLimitError,
  AssetDownloadError,
  type GitHubRelease,
  type GitHubAsset,
  type DownloadProgress,
} from './github-releases.js';
import {
  classifyAsset,
  describeTag,
  type ViabilityTag,
} from './viability-tagging.js';

export interface SettingsModalDeps {
  /** IDB image library used for upload / list / rename / delete / bytes. */
  library: ImageLibrary;
  /** Current persisted settings; modal mutates these and calls onChange. */
  getSettings: () => Settings;
  /** Persist new settings + dispatch live-update event. */
  onChange: (s: Settings) => void;
  /** Source the running emulator booted from (so we can flag pending reloads). */
  bootedFrom: ImageSource;
  /**
   * CPU-speed live toggle (pacing milestone): called on change so
   * main.ts can post a set-speed message to the running worker —
   * unlike image sources, speed applies without a reload.
   */
  onCpuSpeedChange?: (mode: 'authentic' | 'turbo') => void;
  /**
   * Machine state (Phase 17 M2 — the boot-disk overlay). Absent in
   * the degraded no-overlay boot. `onFactoryReset` QUEUES the reset
   * (consumed at the tab's next boot — the pendingBlankKb pattern);
   * `staleState` is non-null when this session detected machine
   * state saved against a DIFFERENT base image (kept unused; the
   * callback discards it now).
   */
  machineState?: {
    onFactoryReset: () => void;
    staleState: () => { discard: () => Promise<void> } | null;
  };
}

/** 100 MB cap on local uploads — aligned with GITHUB_DOWNLOAD_MAX_BYTES.
 *  The Phase 9.2 cap was 10 MB ("HD images route through the GitHub
 *  browser instead"), but the GitHub asset CDN sends no CORS headers, so
 *  that route can never actually fetch — which left hard-disk images with
 *  NO working path into the library (found by Jonathan uploading
 *  hd32-minix.img, Phase 14 M3b). Upload is the supported HD path; the
 *  cap exists only to keep an accidental multi-gigabyte pick from
 *  stalling the main thread / blowing the IDB quota. ELKS hd64 images
 *  (~67 MB) are the largest real bootables. */
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** 100 MB cap on GitHub downloads. ELKS hd64 images are ~67 MB; this allows
 *  them through with headroom. Above this, the user is prompted before the
 *  download starts. The cap exists because IDB writes that big can stall
 *  the main thread and may push the origin past its quota — both better as
 *  explicit prompts than silent failures. */
const GITHUB_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** When projected usage (current + asset) crosses this fraction of quota,
 *  warn the user before the download starts. Quota writes that fail
 *  mid-stream lose the bytes — it's worth a one-line confirm. */
const QUOTA_WARNING_FRACTION = 0.8;

/** Number of recent prereleases to surface when the toggle is on. */
const PRERELEASE_LIMIT = 5;

export function mountSettingsModal(deps: SettingsModalDeps): void {
  const gear = ensureGear();
  const root = ensureModalRoot();

  let isOpen = false;
  let backdrop: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let pendingReload = false;
  let reloadNotice: HTMLDivElement | null = null;

  const open = () => {
    if (isOpen) return;
    isOpen = true;
    backdrop = document.createElement('div');
    backdrop.className = 'emu86-modal-backdrop';
    backdrop.setAttribute('role', 'presentation');

    panel = document.createElement('div');
    panel.className = 'emu86-modal-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'emu86-modal-title');

    void renderPanel(panel);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);

    // Backdrop click closes; clicks on the panel itself shouldn't bubble out.
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    document.addEventListener('keydown', onKeydown);

    // First focusable element gets focus; falls back to the panel itself.
    requestAnimationFrame(() => {
      const first = panel?.querySelector<HTMLElement>(focusableSelector);
      (first ?? panel)?.focus();
    });
  };

  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    document.removeEventListener('keydown', onKeydown);
    if (backdrop) backdrop.remove();
    backdrop = null;
    panel = null;
    reloadNotice = null;
    gear.focus();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab' && panel) {
      trapFocus(panel, e);
    }
  };

  gear.addEventListener('click', () => {
    if (isOpen) close();
    else open();
  });

  /* ---------------------------------------------------------------- */
  /* Panel rendering                                                   */
  /* ---------------------------------------------------------------- */

  async function renderPanel(host: HTMLDivElement): Promise<void> {
    host.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'emu86-modal-header';
    const title = document.createElement('h2');
    title.id = 'emu86-modal-title';
    title.textContent = 'Settings';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'emu86-modal-close';
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', close);
    header.append(title, closeBtn);
    host.appendChild(header);

    /* Font size --------------------------------------------------- */
    const fontSection = section('Font size');
    const settingsAtRender = deps.getSettings();
    const fontInput = document.createElement('input');
    fontInput.type = 'number';
    fontInput.min = String(FONT_SIZE_MIN);
    fontInput.max = String(FONT_SIZE_MAX);
    fontInput.step = '1';
    fontInput.value = String(settingsAtRender.fontSize);
    fontInput.className = 'emu86-input-number';
    fontInput.setAttribute('aria-label', 'Font size in pixels');

    const fontHint = document.createElement('span');
    fontHint.className = 'emu86-hint';
    fontHint.textContent = ` px (${FONT_SIZE_MIN}–${FONT_SIZE_MAX})`;

    fontInput.addEventListener('input', () => {
      const next = Number(fontInput.value);
      if (!Number.isFinite(next)) return;
      const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(next)));
      const cur = deps.getSettings();
      if (cur.fontSize === clamped) return;
      deps.onChange({ ...cur, fontSize: clamped });
    });
    fontSection.body.append(fontInput, fontHint);
    host.appendChild(fontSection.el);

    /* Theme ------------------------------------------------------- */
    const themeSection = section('Theme');
    const themeSelect = document.createElement('select');
    themeSelect.className = 'emu86-input-select';
    themeSelect.setAttribute('aria-label', 'Terminal theme');
    for (const name of THEME_PRESET_NAMES) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = THEME_LABELS[name];
      if (name === settingsAtRender.themeName) opt.selected = true;
      themeSelect.appendChild(opt);
    }
    themeSelect.addEventListener('change', () => {
      const next = themeSelect.value as ThemePresetName;
      const cur = deps.getSettings();
      if (cur.themeName === next) return;
      deps.onChange({ ...cur, themeName: next });
    });
    themeSection.body.appendChild(themeSelect);
    host.appendChild(themeSection.el);

    /* CPU speed (pacing milestone) -------------------------------- */
    const speedSection = section('CPU speed');
    const speedHint = document.createElement('div');
    speedHint.className = 'emu86-hint';
    speedHint.textContent =
      'Authentic caps the CPU at a real 4.77 MHz 8086 (games run true). ' +
      'Turbo uncaps it for heavy work like in-VM compiles — the clock ' +
      'stays wall-true either way. Applies immediately.';
    speedSection.body.appendChild(speedHint);
    const speedSelect = document.createElement('select');
    speedSelect.className = 'emu86-input-select';
    speedSelect.setAttribute('aria-label', 'CPU speed');
    for (const [value, label] of [
      ['authentic', 'Authentic (4.77 MHz)'],
      ['turbo', 'Turbo (uncapped)'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === settingsAtRender.cpuSpeed) opt.selected = true;
      speedSelect.appendChild(opt);
    }
    speedSelect.addEventListener('change', () => {
      const mode = speedSelect.value === 'turbo' ? 'turbo' : 'authentic';
      const cur = deps.getSettings();
      if (cur.cpuSpeed === mode) return;
      deps.onChange({ ...cur, cpuSpeed: mode });
      deps.onCpuSpeedChange?.(mode);
    });
    speedSection.body.appendChild(speedSelect);
    host.appendChild(speedSection.el);

    /* Image source ----------------------------------------------- */
    const imageSection = section('Boot image');
    const reloadDiv = document.createElement('div');
    reloadDiv.className = 'emu86-reload-notice';
    reloadDiv.setAttribute('aria-live', 'polite');
    reloadDiv.hidden = true;
    reloadNotice = reloadDiv;
    imageSection.body.appendChild(reloadDiv);

    const list = document.createElement('div');
    list.className = 'emu86-image-list';
    imageSection.body.appendChild(list);

    const uploadRow = document.createElement('div');
    uploadRow.className = 'emu86-upload-row';
    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'emu86-button';
    uploadBtn.textContent = 'Upload image…';
    const uploadStatus = document.createElement('span');
    uploadStatus.className = 'emu86-hint';
    uploadStatus.setAttribute('aria-live', 'polite');
    uploadRow.append(uploadBtn, uploadStatus);
    imageSection.body.appendChild(uploadRow);

    uploadBtn.addEventListener('click', () => {
      void pickAndUpload(uploadStatus).then(() => refreshList(list));
    });

    /* GitHub releases sub-pane ---------------------------------- */
    const ghPane = renderGithubPane({
      library: deps.library,
      onLibraryChanged: () => { void refreshList(list); },
    });
    imageSection.body.appendChild(ghPane);

    host.appendChild(imageSection.el);

    /* Secondary disk (Phase 11) ---------------------------------- */
    // Optional second slot. Defaults to "None" — single-disk operation,
    // no behavioural change vs Phase 10. The secondary is a *data disk*,
    // not a boot disk, so we don't surface viability tagging prominently.
    // Class is inferred from image bytes by the worker host's size table.
    // Phase 16 M0: this picks the BASE image — the template every newly
    // opened tab forks its private /dev/hdb from. It never touches a
    // running tab's fork; those persist on their own.
    const secondarySection = section('Base drive image (new tabs fork this)');
    const secondaryHelp = document.createElement('div');
    secondaryHelp.className = 'emu86-hint';
    secondaryHelp.textContent =
      'Every tab gets its own private copy of this image as /dev/hdb ' +
      '(or /dev/fd1 for floppy-class images) when it first opens. ' +
      'Tabs already open keep the copy they have. The "Save as default" ' +
      'button on the main page replaces this base with a tab\'s current drive.';
    secondarySection.body.appendChild(secondaryHelp);

    const secondaryList = document.createElement('div');
    secondaryList.className = 'emu86-image-list';
    secondarySection.body.appendChild(secondaryList);

    /* Create blank drive (Phase 15 M2 — virtual drives) ----------- */
    // An all-zero image with explicit CHS geometry, stored in the
    // library like any other entry and selected as the base template.
    // Guest formats its fork of it (mkfs) after the next reload... of a
    // NEW tab — existing tabs keep their forks (M0 semantics).
    const createRow = document.createElement('div');
    createRow.className = 'emu86-upload-row';
    const sizeSelect = document.createElement('select');
    // The shared table (image-library.ts) — the `?mkdrive` control
    // endpoint offers exactly these shapes, so the two cannot drift.
    const PRESETS = DRIVE_PRESETS;
    for (const [i, p] of PRESETS.entries()) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = p.label;
      sizeSelect.appendChild(opt);
    }
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.textContent = 'Create blank drive';
    const createStatus = document.createElement('div');
    createStatus.className = 'emu86-hint';
    createStatus.setAttribute('aria-live', 'polite');
    createRow.append(sizeSelect, createBtn);
    secondarySection.body.appendChild(createRow);
    secondarySection.body.appendChild(createStatus);
    createBtn.addEventListener('click', () => {
      void (async () => {
        const preset = PRESETS[Number.parseInt(sizeSelect.value, 10)];
        if (preset === undefined) return;
        const geometry = {
          cylinders: preset.cylinders,
          heads: preset.heads,
          sectorsPerTrack: preset.sectorsPerTrack,
        };
        try {
          const id = await deps.library.createBlankImage(
            `blank-${preset.label.replace(' ', '').toLowerCase()}.img`,
            geometry,
          );
          // Select it as the base right away — creating a template and
          // not selecting it is never what the user meant.
          deps.onChange({
            ...deps.getSettings(),
            secondaryImageSource: { kind: 'library', id },
          });
          const blocks =
            (preset.cylinders * preset.heads * preset.sectorsPerTrack * 512) / 1024;
          createStatus.textContent =
            `Created and set as the base. New tabs fork it; in the guest: ` +
            `mkfs /dev/hdb ${blocks} && mount /dev/hdb /mnt.`;
          await refreshSecondaryList(secondaryList);
          await refreshList(list);
        } catch (err) {
          createStatus.textContent = `Create failed: ${describeError(err)}`;
        }
      })();
    });

    host.appendChild(secondarySection.el);

    void refreshSecondaryList(secondaryList);

    /* Boot script (Phase 14 — autoexec) ---------------------------- */
    // Named keystroke scripts typed into the console at boot by the
    // prompt-aware runner (web/autoexec.ts). The picker chooses both
    // what runs at next reload and what the editor below edits; "None"
    // hides the editor and boots silent.
    const scriptSection = section('Boot script');
    const scriptHelp = document.createElement('div');
    scriptHelp.className = 'emu86-hint';
    scriptHelp.textContent =
      'Typed into the console at boot — each line waits for a prompt ' +
      '(login:/Password:/#/$); a line "@expect some text" makes the next ' +
      'line wait for that output instead. Applies on next reload.';
    scriptSection.body.appendChild(scriptHelp);
    scriptSection.body.appendChild(renderBootScriptPane({
      getSettings: deps.getSettings,
      onChange: deps.onChange,
    }));
    host.appendChild(scriptSection.el);

    /* Machine state (Phase 17 M2) --------------------------------- */
    if (deps.machineState !== undefined) {
      const ms = deps.machineState;
      const stateSection = section('Machine state');
      const stateHint = document.createElement('div');
      stateHint.className = 'emu86-hint';
      stateHint.textContent =
        'Changes the guest makes to its boot disk persist per-tab and ' +
        'are restored on reload. Reset boots the pristine base image ' +
        'again — the escape hatch if the guest wrecks its own root ' +
        'filesystem.';
      stateSection.body.appendChild(stateHint);

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'emu86-button';
      // Name WHOSE state resets (field ask, M2 pass). The tab title is
      // already `<name>.tabs — emu86` once the TAN lease settles
      // (Jonathan: "the name can come from the tab title") — no
      // plumbing, and solo machines fall back to the plain label.
      const tabsTitle = /^([a-z0-9-]+)\.tabs /.exec(document.title);
      resetBtn.textContent = tabsTitle !== null
        ? `Reset '${tabsTitle[1] ?? ''}' machine state…`
        : 'Reset machine state…';
      resetBtn.addEventListener('click', () => {
        ms.onFactoryReset();
        resetBtn.textContent = 'Reset queued — reload to apply';
        resetBtn.disabled = true;
      });
      stateSection.body.appendChild(resetBtn);

      const stale = ms.staleState();
      if (stale !== null) {
        const staleRow = document.createElement('div');
        staleRow.className = 'emu86-upload-row';
        const staleBtn = document.createElement('button');
        staleBtn.type = 'button';
        staleBtn.className = 'emu86-button';
        staleBtn.textContent = 'Discard state from previous base image';
        const staleNote = document.createElement('span');
        staleNote.className = 'emu86-hint';
        staleNote.textContent =
          'saved against a different base image — kept, but unused';
        staleRow.append(staleBtn, staleNote);
        staleBtn.addEventListener('click', () => {
          staleBtn.disabled = true;
          void stale.discard().then(
            () => { staleNote.textContent = 'discarded.'; },
            (err: unknown) => {
              staleBtn.disabled = false;
              staleNote.textContent = `discard failed: ${String(err)}`;
            },
          );
        });
        stateSection.body.appendChild(staleRow);
      }
      host.appendChild(stateSection.el);
    }

    /* Storage usage ---------------------------------------------- */
    const storageSection = section('Storage usage');
    const storageLine = document.createElement('div');
    storageLine.className = 'emu86-hint';
    storageLine.textContent = 'Calculating…';
    storageSection.body.appendChild(storageLine);
    host.appendChild(storageSection.el);

    void refreshList(list);
    void refreshStorage(storageLine);
    updateReloadNotice();
  }

  async function refreshList(host: HTMLDivElement): Promise<void> {
    host.innerHTML = '';

    // Bundled entry — always present, never deletable. Renders identical to
    // a library entry except the action set is constrained.
    host.appendChild(
      renderRow({
        title: 'Default (bundled)',
        subtitle: '/elks-serial.img — built into the page',
        isBundled: true,
        isSelected: deps.getSettings().imageSource.kind === 'bundled',
        onSelect: () => {
          const cur = deps.getSettings();
          if (cur.imageSource.kind === 'bundled') return;
          deps.onChange({ ...cur, imageSource: { kind: 'bundled' } });
          updateReloadNotice();
          void refreshList(host);
        },
      }),
    );

    let entries: StoredImageMeta[] = [];
    try {
      entries = await deps.library.listImages();
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'emu86-error';
      errEl.textContent = `Failed to read library: ${describeError(err)}`;
      host.appendChild(errEl);
      return;
    }

    const cur = deps.getSettings();
    for (const entry of entries) {
      if (entry.source === 'fork') continue; // machine-managed tab drives (Phase 16 M0)
      const isSelected = cur.imageSource.kind === 'library'
        && cur.imageSource.id === entry.id;
      // Subtitle includes source tag (upload | github) so the user can
      // tell their own uploads apart from GitHub-sourced entries at a
      // glance, plus the viability tag if known.
      const tagBits: string[] = [
        formatBytes(entry.sizeBytes),
        `${entry.source} · ${formatDate(entry.uploadedAt)}`,
      ];
      if (entry.viability) {
        tagBits.push(`tag: ${describeTag(entry.viability)}`);
      }
      host.appendChild(
        renderRow({
          title: entry.name,
          subtitle: tagBits.join(' · '),
          isBundled: false,
          isSelected,
          onSelect: () => {
            deps.onChange({
              ...deps.getSettings(),
              imageSource: { kind: 'library', id: entry.id },
            });
            updateReloadNotice();
            void refreshList(host);
          },
          onRename: async () => {
            const proposed = window.prompt('Rename image', entry.name);
            if (proposed === null) return;
            const trimmed = proposed.trim();
            if (trimmed.length === 0 || trimmed === entry.name) return;
            try {
              await deps.library.renameImage(entry.id, trimmed);
            } catch (err) {
              window.alert(`Rename failed: ${describeError(err)}`);
            }
            void refreshList(host);
          },
          onDelete: async () => {
            if (!window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) return;
            try {
              await deps.library.removeImage(entry.id);
            } catch (err) {
              window.alert(`Delete failed: ${describeError(err)}`);
              return;
            }
            // If the deleted entry was the selected one, fall back to bundled.
            const after = deps.getSettings();
            if (after.imageSource.kind === 'library' && after.imageSource.id === entry.id) {
              deps.onChange({ ...after, imageSource: { kind: 'bundled' } });
            }
            updateReloadNotice();
            void refreshList(host);
            // Storage usage may have changed materially; refresh that line if
            // the panel still has it. It's a best-effort UI nicety, so the
            // safe-look here matches the modal lifecycle.
            const usageEl = panel?.querySelector<HTMLDivElement>('.emu86-storage-line');
            if (usageEl) void refreshStorage(usageEl);
          },
        }),
      );
    }
  }

  /**
   * Render the base-image picker (Phase 16 M0: what NEW tabs fork —
   * changing it never touches a running tab, so the old "reload to
   * apply" notice is gone; there is nothing to reload for). Mirrors
   * `refreshList` but omits the bundled entry (a boot image, not a
   * data disk) and machine-managed 'fork' rows, and leads with a
   * "None" entry — which no longer means "no drive": every tab always
   * gets one; None just makes it a fresh blank 8086 KB.
   */
  async function refreshSecondaryList(host: HTMLDivElement): Promise<void> {
    host.innerHTML = '';

    host.appendChild(
      renderRow({
        title: 'None (blank default)',
        subtitle: 'New tabs start with a fresh blank 8086 KB drive.',
        isBundled: true,
        isSelected: deps.getSettings().secondaryImageSource === null,
        onSelect: () => {
          const cur = deps.getSettings();
          if (cur.secondaryImageSource === null) return;
          deps.onChange({ ...cur, secondaryImageSource: null });
          void refreshSecondaryList(host);
        },
      }),
    );

    let entries: StoredImageMeta[] = [];
    try {
      entries = await deps.library.listImages();
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'emu86-error';
      errEl.textContent = `Failed to read library: ${describeError(err)}`;
      host.appendChild(errEl);
      return;
    }

    const cur = deps.getSettings();
    for (const entry of entries) {
      if (entry.source === 'fork') continue; // tabs' private copies — not templates
      const isSelected = cur.secondaryImageSource !== null
        && cur.secondaryImageSource.id === entry.id;
      const tagBits: string[] = [
        formatBytes(entry.sizeBytes),
        `${entry.source} · ${formatDate(entry.uploadedAt)}`,
      ];
      // No viability tag here — the base is a data disk, not a boot disk.
      host.appendChild(
        renderRow({
          title: entry.name,
          subtitle: tagBits.join(' · '),
          isBundled: false,
          isSelected,
          onSelect: () => {
            deps.onChange({
              ...deps.getSettings(),
              secondaryImageSource: { kind: 'library', id: entry.id },
            });
            void refreshSecondaryList(host);
          },
        }),
      );
    }
  }

  async function refreshStorage(host: HTMLDivElement): Promise<void> {
    host.classList.add('emu86-storage-line');
    const usage = await deps.library.getQuotaUsage();
    if (usage.quotaBytes === null) {
      host.textContent = `Used: ${formatBytes(usage.usedBytes)} (origin quota unknown)`;
    } else {
      const pct = usage.quotaBytes > 0
        ? ((usage.usedBytes / usage.quotaBytes) * 100).toFixed(1)
        : '0.0';
      host.textContent =
        `Used ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)} (${pct}%)`;
    }
  }

  function updateReloadNotice(): void {
    if (!reloadNotice) return;
    const cur = deps.getSettings().imageSource;
    pendingReload = !sameSource(cur, deps.bootedFrom);
    reloadNotice.hidden = !pendingReload;
    reloadNotice.textContent = pendingReload
      ? 'Image-source change takes effect on next reload.'
      : '';
  }

  /* ---------------------------------------------------------------- */
  /* Upload                                                             */
  /* ---------------------------------------------------------------- */

  async function pickAndUpload(statusEl: HTMLSpanElement): Promise<void> {
    statusEl.textContent = '';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.img,application/octet-stream';
    // The file picker is one-shot: the input is GC'd as soon as we're done.
    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener('change', () => {
        const f = input.files && input.files.length > 0 ? input.files[0] : null;
        resolve(f ?? null);
      }, { once: true });
      // If the user cancels, no `change` fires in some browsers — listen for
      // the focus-back-to-window heuristic as a soft-cancel. Not perfect but
      // good enough; the worst case is a stale "Uploading…" line that gets
      // overwritten on the next pick.
      input.click();
    });

    if (!file) return;

    if (file.size === 0) {
      statusEl.textContent = 'Upload rejected: empty file.';
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      statusEl.textContent =
        `Upload rejected: ${formatBytes(file.size)} exceeds ${formatBytes(UPLOAD_MAX_BYTES)} cap.`;
      return;
    }

    statusEl.textContent = `Reading ${formatBytes(file.size)}…`;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      statusEl.textContent = `Read failed: ${describeError(err)}`;
      return;
    }

    const proposed = window.prompt('Name this image', file.name);
    if (proposed === null) {
      statusEl.textContent = 'Upload cancelled.';
      return;
    }
    const name = proposed.trim() || file.name;

    statusEl.textContent = 'Storing…';
    try {
      await deps.library.addImage(name, bytes, 'upload');
    } catch (err) {
      statusEl.textContent = `Store failed: ${describeError(err)}`;
      return;
    }
    statusEl.textContent = `Uploaded "${name}".`;
  }
}

/* ------------------------------------------------------------------ */
/* GitHub releases sub-pane                                             */
/* ------------------------------------------------------------------ */

interface GithubPaneOpts {
  library: ImageLibrary;
  /** Called after a successful download → addImage so the parent list refreshes. */
  onLibraryChanged: () => void;
}

function renderGithubPane(opts: GithubPaneOpts): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'emu86-github-pane';

  // Disclosure (a `<details>` element so closed/open state is browser-managed
  // and keyboard-accessible without bespoke ARIA).
  const details = document.createElement('details');
  details.className = 'emu86-github-disclosure';
  const summary = document.createElement('summary');
  summary.textContent = 'Browse ELKS releases (GitHub)';
  details.appendChild(summary);

  // Toolbar: prereleases toggle + status line.
  const toolbar = document.createElement('div');
  toolbar.className = 'emu86-github-toolbar';
  const preLabel = document.createElement('label');
  preLabel.className = 'emu86-github-toggle';
  const preCheckbox = document.createElement('input');
  preCheckbox.type = 'checkbox';
  const preText = document.createElement('span');
  preText.textContent = 'Show prereleases';
  preLabel.append(preCheckbox, preText);
  const statusEl = document.createElement('span');
  statusEl.className = 'emu86-hint';
  statusEl.setAttribute('aria-live', 'polite');
  toolbar.append(preLabel, statusEl);
  details.appendChild(toolbar);

  // The list itself.
  const listEl = document.createElement('div');
  listEl.className = 'emu86-github-list';
  details.appendChild(listEl);

  let loaded = false;
  // Lazy load on first open. Closing then reopening doesn't refetch
  // (cache is in localStorage anyway).
  details.addEventListener('toggle', () => {
    if (details.open && !loaded) {
      loaded = true;
      void renderList();
    }
  });

  preCheckbox.addEventListener('change', () => {
    void renderList();
  });

  async function renderList(): Promise<void> {
    listEl.innerHTML = '';
    statusEl.textContent = 'Loading releases…';
    let releases: GitHubRelease[];
    try {
      releases = await listReleases({
        includePrereleases: preCheckbox.checked,
        prereleaseLimit: PRERELEASE_LIMIT,
      });
    } catch (err) {
      if (err instanceof RateLimitError) {
        statusEl.textContent =
          `Rate limit hit (${err.limit}/hr). Try again after ` +
          `${new Date(err.resetAtSeconds * 1000).toLocaleTimeString()}.`;
      } else {
        statusEl.textContent = `Failed to load releases: ${describeError(err)}`;
      }
      return;
    }
    statusEl.textContent = `Loaded ${releases.length} release${releases.length === 1 ? '' : 's'}.`;
    if (releases.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'emu86-hint';
      empty.textContent = preCheckbox.checked
        ? 'No releases found.'
        : 'No stable releases found. Try toggling "Show prereleases".';
      listEl.appendChild(empty);
      return;
    }
    for (const r of releases) {
      listEl.appendChild(renderRelease(r));
    }
  }

  function renderRelease(release: GitHubRelease): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'emu86-github-release';

    const head = document.createElement('div');
    head.className = 'emu86-github-release-head';

    const titleEl = document.createElement('div');
    titleEl.className = 'emu86-github-release-title';
    const titleText = document.createElement('span');
    titleText.textContent = `${release.name} (${release.tag})`;
    titleEl.appendChild(titleText);
    if (release.prerelease) {
      const badge = document.createElement('span');
      badge.className = 'emu86-github-prerelease-badge';
      badge.textContent = 'prerelease';
      titleEl.appendChild(badge);
    }
    head.appendChild(titleEl);

    const dateEl = document.createElement('div');
    dateEl.className = 'emu86-github-release-date';
    dateEl.textContent = release.publishedAt > 0
      ? formatDate(release.publishedAt)
      : 'date unknown';
    head.appendChild(dateEl);

    card.appendChild(head);

    if (release.body && release.body.trim().length > 0) {
      const notesDetails = document.createElement('details');
      notesDetails.className = 'emu86-github-notes';
      const notesSummary = document.createElement('summary');
      notesSummary.textContent = 'Show release notes';
      const notesPre = document.createElement('pre');
      notesPre.className = 'emu86-github-notes-body';
      notesPre.textContent = release.body;
      notesDetails.append(notesSummary, notesPre);
      card.appendChild(notesDetails);
    }

    if (release.assets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'emu86-hint';
      empty.textContent = 'No .img assets in this release.';
      card.appendChild(empty);
    } else {
      const assetList = document.createElement('div');
      assetList.className = 'emu86-github-asset-list';
      for (const a of release.assets) {
        assetList.appendChild(renderAsset(a));
      }
      card.appendChild(assetList);
    }

    return card;
  }

  function renderAsset(asset: GitHubAsset): HTMLDivElement {
    const tag = classifyAsset(asset.name, { sizeBytes: asset.sizeBytes });
    const row = document.createElement('div');
    row.className = 'emu86-github-asset';

    const meta = document.createElement('div');
    meta.className = 'emu86-github-asset-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'emu86-github-asset-name';
    nameEl.textContent = asset.name;
    const subEl = document.createElement('div');
    subEl.className = 'emu86-github-asset-sub';
    subEl.append(
      document.createTextNode(`${formatBytes(asset.sizeBytes)} · `),
      tagBadge(tag),
    );
    meta.append(nameEl, subEl);

    const actions = document.createElement('div');
    actions.className = 'emu86-github-asset-actions';
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'emu86-button';
    dlBtn.textContent = 'Download';
    actions.appendChild(dlBtn);

    const progress = document.createElement('div');
    progress.className = 'emu86-github-asset-progress emu86-hint';
    progress.setAttribute('aria-live', 'polite');

    dlBtn.addEventListener('click', () => {
      void runDownload(asset, tag, dlBtn, progress);
    });

    row.append(meta, actions, progress);
    return row;
  }

  async function runDownload(
    asset: GitHubAsset,
    tag: ViabilityTag,
    btn: HTMLButtonElement,
    progress: HTMLDivElement,
  ): Promise<void> {
    btn.disabled = true;
    progress.textContent = '';

    if (asset.sizeBytes > GITHUB_DOWNLOAD_MAX_BYTES) {
      const proceed = window.confirm(
        `${asset.name} is ${formatBytes(asset.sizeBytes)} ` +
        `(over the ${formatBytes(GITHUB_DOWNLOAD_MAX_BYTES)} download cap). ` +
        `Proceed anyway?`,
      );
      if (!proceed) {
        progress.textContent = 'Download cancelled.';
        btn.disabled = false;
        return;
      }
    }

    // Quota check — best effort. If quota is unknown we skip the warning.
    try {
      const quota = await opts.library.getQuotaUsage();
      if (quota.quotaBytes !== null) {
        const projected = quota.usedBytes + asset.sizeBytes;
        const fraction = quota.quotaBytes > 0 ? projected / quota.quotaBytes : 0;
        if (fraction > QUOTA_WARNING_FRACTION) {
          const proceed = window.confirm(
            `Downloading ${asset.name} would put origin storage at ` +
            `${(fraction * 100).toFixed(1)}% of quota ` +
            `(${formatBytes(projected)} of ${formatBytes(quota.quotaBytes)}). ` +
            `Proceed?`,
          );
          if (!proceed) {
            progress.textContent = 'Download cancelled.';
            btn.disabled = false;
            return;
          }
        }
      }
    } catch {
      // Probe failure is non-fatal — the download attempt itself will
      // report quota errors if they happen.
    }

    progress.textContent = 'Starting download…';
    let bytes: Uint8Array;
    try {
      bytes = await downloadAsset(asset.downloadUrl, (p: DownloadProgress) => {
        progress.textContent = formatProgress(p);
      });
    } catch (err) {
      if (err instanceof AssetDownloadError) {
        progress.textContent = `Download failed: ${err.message}`;
      } else {
        progress.textContent = `Download failed: ${describeError(err)}`;
      }
      btn.disabled = false;
      return;
    }

    progress.textContent = `Storing ${formatBytes(bytes.byteLength)} in library…`;
    try {
      await opts.library.addImage(asset.name, bytes, 'github', tag);
    } catch (err) {
      progress.textContent = `Store failed: ${describeError(err)}`;
      btn.disabled = false;
      return;
    }
    progress.textContent = `Saved "${asset.name}" to library.`;
    btn.disabled = false;
    opts.onLibraryChanged();
  }

  wrap.appendChild(details);
  return wrap;
}

/* -------------------------------------------------------------------- */
/* Boot script pane (Phase 14 — autoexec)                                 */
/* -------------------------------------------------------------------- */

interface BootScriptPaneOpts {
  getSettings: () => Settings;
  onChange: (s: Settings) => void;
}

/**
 * Picker + inline editor for boot scripts. The picker selects what runs
 * at next reload AND what the editor edits; "None" hides the editor and
 * boots silent. Edits write through on every input, same live-persist
 * pattern as the font/theme fields.
 */
function renderBootScriptPane(opts: BootScriptPaneOpts): HTMLDivElement {
  const root = document.createElement('div');

  const pickerRow = document.createElement('div');
  pickerRow.className = 'emu86-upload-row';
  const select = document.createElement('select');
  select.className = 'emu86-input-select';
  select.setAttribute('aria-label', 'Boot script');
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'emu86-button';
  newBtn.textContent = 'New script';
  pickerRow.append(select, newBtn);

  const editor = document.createElement('div');
  editor.className = 'emu86-bootscript-editor';
  const nameRow = document.createElement('div');
  nameRow.className = 'emu86-upload-row';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'emu86-input-text';
  nameInput.setAttribute('aria-label', 'Boot script name');
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'emu86-button';
  deleteBtn.textContent = 'Delete';
  nameRow.append(nameInput, deleteBtn);
  const textArea = document.createElement('textarea');
  textArea.className = 'emu86-textarea';
  textArea.rows = 6;
  textArea.spellcheck = false;
  textArea.setAttribute('aria-label', 'Boot script contents');

  // @directive cheat sheet (field request) — collapsed by default,
  // content mirrors parseScript() in web/autoexec.ts. If a directive
  // changes there, change it here.
  const cheat = document.createElement('details');
  cheat.className = 'emu86-cheatsheet';
  const cheatSummary = document.createElement('summary');
  cheatSummary.textContent = '@directive cheat sheet';
  const cheatBody = document.createElement('pre');
  cheatBody.textContent = [
    'plain line      sent after the next prompt (login: / Password: / # / $ / > )',
    '@expect TEXT    next line waits for TEXT in output instead of a prompt',
    '@type           lines below are typed key-by-key, with key clicks',
    '@instant        lines below are sent whole (default)',
    '@here … @end    verbatim block for heredocs: every line incl. blanks,',
    '                each waiting for the "> " continuation prompt (tty-safe)',
    '@turbo          uncap CPU speed from here on (this session only)',
    '@authentic      back to 4.77 MHz pacing (this session only)',
  ].join('\n');
  cheat.append(cheatSummary, cheatBody);

  editor.append(nameRow, textArea, cheat);

  root.append(pickerRow, editor);

  function activeScript(): BootScript | undefined {
    const s = opts.getSettings();
    return s.bootScripts.find((x) => x.id === s.activeBootScriptId);
  }

  /** Replace one script by id, immutably, and persist. */
  function updateScript(id: string, patch: Partial<BootScript>): void {
    const cur = opts.getSettings();
    opts.onChange({
      ...cur,
      bootScripts: cur.bootScripts.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    });
  }

  function render(): void {
    const s = opts.getSettings();
    select.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None (boot silent)';
    select.appendChild(none);
    for (const script of s.bootScripts) {
      const opt = document.createElement('option');
      opt.value = script.id;
      opt.textContent = script.name;
      if (script.id === s.activeBootScriptId) opt.selected = true;
      select.appendChild(opt);
    }
    const active = activeScript();
    editor.hidden = active === undefined;
    if (active !== undefined) {
      nameInput.value = active.name;
      textArea.value = active.text;
    }
  }

  select.addEventListener('change', () => {
    const cur = opts.getSettings();
    opts.onChange({
      ...cur,
      activeBootScriptId: select.value === '' ? null : select.value,
    });
    render();
  });

  newBtn.addEventListener('click', () => {
    const cur = opts.getSettings();
    const script: BootScript = {
      id: crypto.randomUUID(),
      name: 'new script',
      text: '',
    };
    opts.onChange({
      ...cur,
      bootScripts: [...cur.bootScripts, script],
      activeBootScriptId: script.id,
    });
    render();
    nameInput.focus();
    nameInput.select();
  });

  // Editing a seeded script ADOPTS it: `userEdited` makes it the user's
  // for good, so no shipped fix ever silently overwrites their work
  // (see reconcileSeededScripts in settings.ts).
  nameInput.addEventListener('input', () => {
    const active = activeScript();
    if (active === undefined) return;
    updateScript(active.id, { name: nameInput.value, userEdited: true });
    // Keep the picker label in sync without a full re-render (which
    // would fight the user's caret).
    for (const opt of Array.from(select.options)) {
      if (opt.value === active.id) opt.textContent = nameInput.value;
    }
  });

  textArea.addEventListener('input', () => {
    const active = activeScript();
    if (active === undefined) return;
    updateScript(active.id, { text: textArea.value, userEdited: true });
  });

  deleteBtn.addEventListener('click', () => {
    const active = activeScript();
    if (active === undefined) return;
    const cur = opts.getSettings();
    opts.onChange({
      ...cur,
      bootScripts: cur.bootScripts.filter((x) => x.id !== active.id),
      activeBootScriptId: null,
    });
    render();
  });

  render();
  return root;
}

function tagBadge(tag: ViabilityTag): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `emu86-tag-badge emu86-tag-${tag}`;
  span.textContent = describeTag(tag);
  return span;
}

function formatProgress(p: DownloadProgress): string {
  if (p.total === null) {
    return `Downloading ${formatBytes(p.loaded)}…`;
  }
  const pct = p.total > 0 ? ((p.loaded / p.total) * 100).toFixed(1) : '0.0';
  return `Downloading ${formatBytes(p.loaded)} / ${formatBytes(p.total)} (${pct}%)`;
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                          */
/* ------------------------------------------------------------------ */

function ensureGear(): HTMLButtonElement {
  let gear = document.getElementById('settings-gear');
  if (!gear) {
    gear = document.createElement('button');
    gear.id = 'settings-gear';
    gear.setAttribute('type', 'button');
    gear.setAttribute('aria-label', 'Open settings');
    gear.textContent = '⚙';
    document.body.appendChild(gear);
  }
  return gear as HTMLButtonElement;
}

function ensureModalRoot(): HTMLElement {
  let root = document.getElementById('settings-modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'settings-modal-root';
    document.body.appendChild(root);
  }
  return root;
}

interface SectionRefs {
  el: HTMLElement;
  body: HTMLDivElement;
}

function section(label: string): SectionRefs {
  const el = document.createElement('section');
  el.className = 'emu86-modal-section';
  const heading = document.createElement('h3');
  heading.textContent = label;
  const body = document.createElement('div');
  body.className = 'emu86-modal-section-body';
  el.append(heading, body);
  return { el, body };
}

interface RowOpts {
  title: string;
  subtitle: string;
  isBundled: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onRename?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}

function renderRow(opts: RowOpts): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'emu86-image-row' + (opts.isSelected ? ' is-selected' : '');

  const meta = document.createElement('div');
  meta.className = 'emu86-image-meta';
  const t = document.createElement('div');
  t.className = 'emu86-image-title';
  t.textContent = opts.title;
  const s = document.createElement('div');
  s.className = 'emu86-image-sub';
  s.textContent = opts.subtitle;
  meta.append(t, s);

  const actions = document.createElement('div');
  actions.className = 'emu86-image-actions';

  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'emu86-button';
  if (opts.isSelected) {
    selectBtn.textContent = 'Selected';
    selectBtn.disabled = true;
  } else {
    selectBtn.textContent = 'Boot on next reload';
    selectBtn.addEventListener('click', () => opts.onSelect());
  }
  actions.appendChild(selectBtn);

  if (opts.onRename) {
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'emu86-button-link';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => void opts.onRename!());
    actions.appendChild(renameBtn);
  }
  if (opts.onDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'emu86-button-link';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => void opts.onDelete!());
    actions.appendChild(deleteBtn);
  }

  row.append(meta, actions);
  return row;
}

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(container: HTMLElement, e: KeyboardEvent): void {
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter((el) => !el.hasAttribute('disabled'));
  if (focusables.length === 0) {
    e.preventDefault();
    container.focus();
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !container.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !container.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }
}

function sameSource(a: ImageSource, b: ImageSource): boolean {
  if (a.kind === 'bundled' && b.kind === 'bundled') return true;
  if (a.kind === 'library' && b.kind === 'library') return a.id === b.id;
  return false;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
