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
  type ImageSource,
  type Settings,
} from './settings.js';
import {
  THEME_LABELS,
  THEME_PRESET_NAMES,
  type ThemePresetName,
} from './themes.js';
import type { ImageLibrary, StoredImageMeta } from './image-library.js';
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
   * Secondary disk source the running emulator booted with (Phase 11).
   * `null` ⇒ no secondary was attached. Used to flag pending reloads when
   * the user changes the secondary selection.
   */
  bootedSecondary: { kind: 'library'; id: string } | null;
}

/** 10 MB cap on local uploads. Floppies are <= 1.44 MB; this is a safety
 *  bound to keep a multi-gigabyte file pick from blocking the main thread
 *  on arrayBuffer. Hard-disk-class images are intentionally upload-rejected
 *  and routed through the GitHub browser instead, where the cap is higher
 *  (see GITHUB_DOWNLOAD_MAX_BYTES). */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

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
    const secondarySection = section('Secondary disk (optional)');
    const secondaryHelp = document.createElement('div');
    secondaryHelp.className = 'emu86-hint';
    secondaryHelp.textContent =
      'Mounts as /dev/hdb (HD-class image) or /dev/fd1 (floppy-class image). ' +
      'Primary still boots; mount via the kernel after boot.';
    secondarySection.body.appendChild(secondaryHelp);

    const secondaryReloadDiv = document.createElement('div');
    secondaryReloadDiv.className = 'emu86-reload-notice';
    secondaryReloadDiv.setAttribute('aria-live', 'polite');
    secondaryReloadDiv.hidden = true;
    secondarySection.body.appendChild(secondaryReloadDiv);

    const secondaryList = document.createElement('div');
    secondaryList.className = 'emu86-image-list';
    secondarySection.body.appendChild(secondaryList);

    host.appendChild(secondarySection.el);

    void refreshSecondaryList(secondaryList, secondaryReloadDiv);

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
      const isSelected = cur.imageSource.kind === 'library'
        && cur.imageSource.id === entry.id;
      // Subtitle includes source tag (upload | github) so the user can
      // tell their own uploads apart from GitHub-sourced entries at a
      // glance, plus the viability tag if known.
      const tagBits: string[] = [
        formatBytes(entry.sizeBytes),
        `${entry.source === 'github' ? 'github' : 'upload'} · ${formatDate(entry.uploadedAt)}`,
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
   * Render the secondary-disk picker. Mirrors `refreshList` but omits the
   * bundled entry (the bundled image is a boot image, not a data disk) and
   * leads with a "None" entry that turns the secondary off. Library entries
   * follow without rename/delete actions — those live on the primary picker
   * to avoid duplicating side-effects across two views.
   */
  async function refreshSecondaryList(
    host: HTMLDivElement,
    reloadEl: HTMLDivElement,
  ): Promise<void> {
    host.innerHTML = '';

    const updateSecondaryReload = (): void => {
      const cur = deps.getSettings().secondaryImageSource;
      const a = cur?.id ?? null;
      const b = deps.bootedSecondary?.id ?? null;
      const pending = a !== b;
      reloadEl.hidden = !pending;
      reloadEl.textContent = pending
        ? 'Secondary-disk change takes effect on next reload.'
        : '';
    };

    // "None" — explicitly off. Always present so the user can turn the
    // secondary off without rummaging through the library list.
    host.appendChild(
      renderRow({
        title: 'None',
        subtitle: 'Single-disk boot — no /dev/hdb or /dev/fd1 attached.',
        isBundled: true,
        isSelected: deps.getSettings().secondaryImageSource === null,
        onSelect: () => {
          const cur = deps.getSettings();
          if (cur.secondaryImageSource === null) return;
          deps.onChange({ ...cur, secondaryImageSource: null });
          updateSecondaryReload();
          void refreshSecondaryList(host, reloadEl);
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
      const isSelected = cur.secondaryImageSource !== null
        && cur.secondaryImageSource.id === entry.id;
      const tagBits: string[] = [
        formatBytes(entry.sizeBytes),
        `${entry.source === 'github' ? 'github' : 'upload'} · ${formatDate(entry.uploadedAt)}`,
      ];
      // No viability tag here — secondary is a data disk, not a boot disk.
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
            updateSecondaryReload();
            void refreshSecondaryList(host, reloadEl);
          },
        }),
      );
    }

    updateSecondaryReload();
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
