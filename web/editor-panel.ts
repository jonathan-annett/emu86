/**
 * The system-level editor panel (Phase 16 M4 — "the editor seam,
 * built"). A minimal file editor over THIS TAB's /dev/hdb: the same
 * drive the guest builds on, read through the M3 peek (never marking
 * clean) and written back through write-secondary (wholesale image
 * swap). It is the mechanism the huxley/lite editor will sit on,
 * built small enough to double as a permanent diagnostic fallback.
 *
 * Deliberate boundaries (brief §0/§3 M4):
 *   - CodeJar (web/vendor/codejar.ts, MIT) with NO highlighter —
 *     plain text; a real widget is huxley/lite's call.
 *   - Edit existing files only: no create/delete/rename UI. The
 *     minix-fs module can create (M2); the panel stays a viewer-
 *     editor so the 14-char name-mangling question never arises here.
 *   - Binary files are skipped by POLICY, not ability: a NUL in the
 *     first 512 bytes, or size over EDITOR_MAX_FILE_BYTES. The guest
 *     is unaffected; the skip is listed, not hidden.
 *   - The panel NEVER writes the image library's base template; its
 *     writes land in the running machine + this tab's fork row. The
 *     persistence hint points at the existing Save-as-default button.
 *   - Coherence is floppy-passing: after a panel write the guest must
 *     (re)mount to see it — shown as a NOTICE (mounts are
 *     undetectable from the host, recorded in the brief).
 *
 * Text crosses the seam as latin1: MINIX v1 stores bytes, ELKS speaks
 * ASCII, and latin1 round-trips every byte value 0–255 losslessly.
 *
 * The pure policy half (tree walk, binary sniff, latin1 helpers)
 * lives in editor-files.ts — CodeJar reads `window` at module scope,
 * so THIS module is browser-only by construction and the policy gets
 * unit-tested from the other one.
 */

import { CodeJar } from './vendor/codejar.js';
import {
  openMinixImage,
  type MinixFileSystem,
} from '../src/disk/minix-fs.js';
import { bytesToLatin1, latin1ToBytes, listEditableFiles } from './editor-files.js';

export interface EditorPanelDeps {
  /** M3 peek (keepDirty) of the RUNNING drive; null = none attached. */
  peekDrive(): Promise<Uint8Array | null>;
  /** M3 write-secondary: swap bytes into the running machine. */
  writeDrive(bytes: Uint8Array): Promise<{ ok: boolean; detail?: string }>;
  /** Persist bytes to THIS tab's fork row (reload safety; M0). */
  persistFork(bytes: Uint8Array): Promise<void>;
  /** Provenance label for the header (the boot banner's wording). */
  driveLabel: string;
}

export function mountEditorPanel(deps: EditorPanelDeps): void {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'editor-toggle';
  toggle.textContent = '/mnt files';
  toggle.title = "Edit files on this tab's /dev/hdb";
  document.body.appendChild(toggle);

  const panel = document.createElement('aside');
  panel.id = 'editor-panel';
  panel.hidden = true;
  document.body.appendChild(panel);

  const header = document.createElement('div');
  header.className = 'editor-header';
  const title = document.createElement('span');
  title.textContent = `/dev/hdb — ${deps.driveLabel}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'editor-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  header.append(title, close);

  const status = document.createElement('div');
  status.className = 'editor-status';
  status.setAttribute('aria-live', 'polite');

  const body = document.createElement('div');
  body.className = 'editor-body';
  panel.append(header, status, body);

  const say = (text: string, warning = false): void => {
    status.textContent = text;
    status.classList.toggle('is-warning', warning);
  };

  let open = false;
  toggle.addEventListener('click', () => {
    open = !open;
    panel.hidden = !open;
    if (open) void showList();
  });
  close.addEventListener('click', () => {
    open = false;
    panel.hidden = true;
  });

  /** Peek + parse, with the panel's honest empty states. */
  async function openDrive(): Promise<MinixFileSystem | null> {
    const bytes = await deps.peekDrive();
    if (bytes === null) {
      say('no drive is attached in the running machine.', true);
      return null;
    }
    const opened = openMinixImage(bytes);
    if (!opened.ok) {
      const blocks = Math.round(bytes.byteLength / 1024);
      say(
        opened.kind === 'not-minix'
          ? `drive is unformatted (${opened.detail}). In the guest: mkfs /dev/hdb ${blocks}`
          : `cannot read drive: ${opened.kind} — ${opened.detail}`,
        true,
      );
      return null;
    }
    return opened.fs;
  }

  async function showList(): Promise<void> {
    body.innerHTML = '';
    say('reading drive…');
    const fs = await openDrive();
    if (fs === null) return;
    const { files, skipped } = listEditableFiles(fs);
    say(
      `${files.length} text file${files.length === 1 ? '' : 's'}` +
        (skipped.length > 0 ? ` · ${skipped.length} skipped (binary/large/special)` : '') +
        ' — reads the RUNNING drive; guest changes appear after its sync.',
    );
    const list = document.createElement('ul');
    list.className = 'editor-list';
    for (const f of files) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = f.path;
      const size = document.createElement('span');
      size.textContent = `${f.sizeBytes} B`;
      btn.addEventListener('click', () => void showFile(f.path));
      li.append(btn, size);
      list.appendChild(li);
    }
    if (files.length === 0) {
      const li = document.createElement('li');
      li.className = 'editor-empty';
      li.textContent = 'no text files on the drive yet.';
      list.appendChild(li);
    }
    for (const s of skipped) {
      const li = document.createElement('li');
      li.className = 'editor-skip';
      li.textContent = `${s.path} — ${s.reason}, not editable here`;
      list.appendChild(li);
    }
    body.appendChild(list);
  }

  async function showFile(path: string): Promise<void> {
    const fs = await openDrive();
    if (fs === null) return;
    const read = fs.readFile(path);
    if (!read.ok) {
      say(`${path}: ${read.kind} — ${read.detail}`, true);
      return;
    }
    body.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '‹ files';
    back.addEventListener('click', () => void showList());
    const name = document.createElement('span');
    name.className = 'editor-filename';
    name.textContent = path;
    const write = document.createElement('button');
    write.type = 'button';
    write.className = 'editor-write';
    write.textContent = 'write to drive';
    bar.append(back, name, write);

    const code = document.createElement('div');
    code.className = 'editor-code';
    body.append(bar, code);

    // Plain text: the highlight callback is a no-op on purpose —
    // "leave that for huxley/lite to decide" (brief §0).
    const jar = CodeJar(code, () => { /* no highlighter */ }, { tab: '    ' });
    jar.updateCode(bytesToLatin1(read.value));
    say(`${path} — ${read.value.byteLength} B. Editing the panel's copy; the guest owns the fs while it has it mounted.`);

    write.addEventListener('click', () => {
      void (async () => {
        write.disabled = true;
        say('writing…');
        try {
          // Fresh peek so concurrent guest writes since our open are
          // kept (floppy-passing still applies — see the notice).
          const bytes = await deps.peekDrive();
          if (bytes === null) {
            say('drive vanished from the running machine.', true);
            return;
          }
          const opened = openMinixImage(bytes);
          if (!opened.ok) {
            say(`drive no longer parses: ${opened.detail}`, true);
            return;
          }
          const w = opened.fs.writeFile(path, latin1ToBytes(jar.toString()));
          if (!w.ok) {
            say(`write failed: ${w.kind} — ${w.detail}`, true);
            return;
          }
          // Reload safety first (fork row), then the running machine.
          await deps.persistFork(bytes);
          const ack = await deps.writeDrive(bytes);
          if (!ack.ok) {
            say(`machine refused the drive: ${ack.detail ?? 'unknown'}`, true);
            return;
          }
          say(
            `written ✓ — in the guest: umount/mount /dev/hdb to see it ` +
              `(the guest owns the fs while mounted). To make this the base for ` +
              `new tabs, use "Save as default".`,
          );
        } finally {
          write.disabled = false;
        }
      })();
    });
  }
}
