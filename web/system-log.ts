/**
 * The host system log (Phase 18 field-loop UI — Jonathan: "we almost
 * need a system log that is totally detached from what the machine
 * actually prints out").
 *
 * The terminal is the MACHINE's: after this module, main.ts never
 * writes a host-side message into xterm — the restored screen and the
 * live serial stream stay byte-faithful. Everything the host wants to
 * say lands here instead:
 *
 *   - a capped in-memory log (timestamped, 500 entries),
 *   - a ☰ button (next to ⏸ and ⚙) opening the log overlay,
 *   - an optional transient toast per entry (dismissable, auto-fade)
 *     for the messages that shouldn't wait to be discovered,
 *   - an unread-count badge on the button.
 */

export interface SystemLog {
  /** Append an entry; `toast: true` also surfaces it transiently. */
  log(text: string, opts?: { toast?: boolean }): void;
}

export interface SystemLogOptions {
  /**
   * Called after the overlay closes, however it closes (field report
   * 2026-07-16: dismissing the log stole focus from the terminal —
   * this is where main.ts hands it back).
   */
  onClosed?: () => void;
}

interface LogEntry {
  at: Date;
  text: string;
}

const LOG_CAP = 500;

const LOG_CSS = `
#emu86-syslog-btn {
  position: fixed;
  right: 5.8rem;
  bottom: 1rem;
  z-index: 30;
  font-size: 1.05rem;
  background: #1c1f24;
  color: #cfd8dc;
  border: 1px solid #394048;
  border-radius: 50%;
  width: 2.2rem;
  height: 2.2rem;
  cursor: pointer;
}
#emu86-syslog-btn:hover { color: #fff; border-color: #5a646e; }
#emu86-syslog-btn .badge {
  position: absolute;
  top: -0.3rem;
  right: -0.3rem;
  background: #4aa8ff;
  color: #0b0e11;
  border-radius: 0.6rem;
  font-size: 0.6rem;
  line-height: 1;
  padding: 0.15rem 0.3rem;
  font-weight: 700;
}
.emu86-syslog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
}
.emu86-syslog-panel {
  background: #14171b;
  color: #d7e0e6;
  border: 1px solid #394048;
  border-radius: 8px;
  padding: 1rem 1.25rem;
  width: min(92vw, 44rem);
  max-height: 80vh;
  overflow: auto;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 0.76rem;
  line-height: 1.5;
}
.emu86-syslog-panel h2 {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  color: #7fb3d5;
}
.emu86-syslog-panel .head {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.emu86-syslog-panel .head h2 { flex: 1; }
.emu86-syslog-panel .head button {
  font: inherit;
  background: none;
  border: 1px solid #394048;
  border-radius: 4px;
  color: #9fb2bf;
  cursor: pointer;
  padding: 0.1rem 0.5rem;
}
.emu86-syslog-panel .head button:hover { color: #fff; border-color: #5a646e; }
.emu86-syslog-panel .entry { white-space: pre-wrap; }
.emu86-syslog-panel .entry .ts { color: #6a7680; }
.emu86-syslog-panel .hint { color: #7c8790; font-size: 0.7rem; margin-top: 0.6rem; }
#emu86-machine-toast {
  position: fixed;
  top: 0.8rem;
  right: 0.8rem;
  z-index: 50;
  max-width: 26rem;
  background: #1c2733;
  color: #cfe3f5;
  border: 1px solid #3a556e;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font: 0.8rem/1.4 ui-monospace, Menlo, monospace;
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  transition: opacity 0.6s;
}
#emu86-machine-toast button {
  background: none;
  border: none;
  color: #7fa3c5;
  cursor: pointer;
  font-size: 1rem;
  padding: 0;
}
`;

export function mountSystemLog(opts: SystemLogOptions = {}): SystemLog {
  const style = document.createElement('style');
  style.textContent = LOG_CSS;
  document.head.appendChild(style);

  const entries: LogEntry[] = [];
  let unread = 0;

  const btn = document.createElement('button');
  btn.id = 'emu86-syslog-btn';
  btn.type = 'button';
  btn.title = 'System log (host-side events — the terminal is the machine’s)';
  btn.setAttribute('aria-label', 'Open the system log');
  btn.textContent = '☰';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;
  btn.appendChild(badge);
  document.body.appendChild(btn);

  function refreshBadge(): void {
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
  }

  btn.addEventListener('click', () => {
    unread = 0;
    refreshBadge();
    openPanel(entries, opts.onClosed);
  });

  return {
    log(text, opts = {}) {
      entries.push({ at: new Date(), text });
      if (entries.length > LOG_CAP) entries.shift();
      unread++;
      refreshBadge();
      if (opts.toast === true) showToast(text);
    },
  };
}

function openPanel(entries: readonly LogEntry[], onClosed?: () => void): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'emu86-syslog-backdrop';
  const panel = document.createElement('div');
  panel.className = 'emu86-syslog-panel';

  const asText = (): string =>
    entries
      .map((e) => `${e.at.toLocaleTimeString()}  ${e.text}`)
      .join('\n');

  // Header row: title, copy-to-clipboard, and an explicit ✕ — both
  // field asks (2026-07-16).
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('h2');
  title.textContent = 'system log — host events, not machine output';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'copy';
  copyBtn.title = 'Copy the whole log to the clipboard';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(asText()).then(
      () => { copyBtn.textContent = 'copied ✓'; },
      () => { copyBtn.textContent = 'copy failed'; },
    );
    window.setTimeout(() => { copyBtn.textContent = 'copy'; }, 2_000);
  });
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close the system log');
  head.append(title, copyBtn, closeBtn);
  panel.appendChild(head);

  for (const entry of entries) {
    const line = document.createElement('div');
    line.className = 'entry';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = `${entry.at.toLocaleTimeString()}  `;
    line.append(ts, document.createTextNode(entry.text));
    panel.appendChild(line);
  }
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'nothing yet.';
    panel.appendChild(empty);
  }
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'click outside (or press Esc) to close';
  panel.appendChild(hint);

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClosed?.();
  };
  closeBtn.addEventListener('click', close);

  backdrop.appendChild(panel);
  // Close on backdrop click ONLY when the press also started there —
  // releasing a text-selection drag over the backdrop must not close
  // the window (field ask, 2026-07-16).
  let pressStartedOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (ev) => {
    pressStartedOnBackdrop = ev.target === backdrop;
  });
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop && pressStartedOnBackdrop) close();
  });
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  panel.scrollTop = panel.scrollHeight;
}

/** Transient surface for entries that shouldn't wait to be found. */
function showToast(text: string): void {
  document.getElementById('emu86-machine-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'emu86-machine-toast';
  const span = document.createElement('span');
  span.textContent = text;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.addEventListener('click', () => toast.remove());
  toast.append(span, closeBtn);
  document.body.appendChild(toast);
  window.setTimeout(() => { toast.style.opacity = '0'; }, 12_000);
  window.setTimeout(() => toast.remove(), 13_000);
}
