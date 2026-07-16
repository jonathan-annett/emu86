/**
 * Freeze-and-inspect popup (Phase 18 field-loop UI — Jonathan: "for
 * geek value: a popup on request showing all the registers, and hex
 * dump of cs:ip (freezes the cpu until popup dismissed) ... maybe even
 * a few interesting ports").
 *
 * A ⏸ button next to the settings gear. Opening it freezes the CPU
 * (set-paused — the worker skips the pacer while frozen, so no wall
 * time becomes guest time), requests one coherent inspection, and
 * renders: registers, decoded FLAGS, a hex+ASCII dump at CS:IP, the
 * stack window at SS:SP, and device/port summaries (PIC, PIT ch0,
 * UART, NE2000 — all straight off the M1 serialize pairs). Dismissing
 * unfreezes. Hex dump over disassembly by his call ("hex dump is
 * better than nothing, easy enough"); a disassembler is a later toy.
 */

import type { InspectSnapshot } from '../src/browser/protocol.js';

export interface InspectPanelDeps {
  /** Freeze/unfreeze the CPU (posts set-paused). */
  setPaused: (paused: boolean) => void;
  /** One coherent machine inspection. */
  inspect: () => Promise<InspectSnapshot>;
  /**
   * Save the (frozen) machine as a named state — Jonathan's call: the
   * popup is the natural home for the save button, because the state
   * you are LOOKING at is exactly what gets captured. Wired to the
   * same flow as the settings modal's save; absent in degraded boots.
   */
  saveState?: (label: string) => Promise<void>;
  /**
   * Restore straight from the popup (Jonathan: "a drop down of
   * previous saved states, click - restore - boom"). Same queue-and-
   * reload flow as the settings modal's Restore.
   */
  savedStates?: {
    list: () => Promise<Array<{ stateId: string; label: string | null; lastTouched: number }>>;
    restore: (stateId: string) => void;
    /** Field ask (2026-07-16): delete straight from the picker. */
    remove?: (stateId: string) => Promise<void>;
  };
  /**
   * Reboot the machine (field loop: reload-resume removed the only
   * reboot the machine had — reloading the page). Queues a one-shot
   * cold boot and reloads; disk state (overlay + fork) persists.
   */
  reboot?: () => void;
  /**
   * Called after the popup closes, however it closes (field report
   * 2026-07-16: dismissing stole focus from the terminal — main.ts
   * hands it back here).
   */
  onClosed?: () => void;
}

const PANEL_CSS = `
#emu86-inspect-btn {
  position: fixed;
  right: 3.4rem;
  bottom: 1rem;
  z-index: 30;
  font-size: 1.1rem;
  background: #1c1f24;
  color: #cfd8dc;
  border: 1px solid #394048;
  border-radius: 50%;
  width: 2.2rem;
  height: 2.2rem;
  cursor: pointer;
}
#emu86-inspect-btn:hover { color: #fff; border-color: #5a646e; }
.emu86-inspect-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
}
.emu86-inspect-panel {
  background: #14171b;
  color: #d7e0e6;
  border: 1px solid #394048;
  border-radius: 8px;
  padding: 1rem 1.25rem;
  max-width: min(92vw, 46rem);
  max-height: 86vh;
  overflow: auto;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 0.78rem;
  line-height: 1.45;
}
.emu86-inspect-panel h2 {
  margin: 0 0 0.4rem;
  font-size: 0.9rem;
  color: #8ecfa8;
}
.emu86-inspect-panel h3 {
  margin: 0.8rem 0 0.2rem;
  font-size: 0.8rem;
  color: #7fb3d5;
}
.emu86-inspect-panel pre { margin: 0; white-space: pre; }
.emu86-inspect-panel .hint { color: #7c8790; font-size: 0.72rem; margin-top: 0.7rem; }
.emu86-inspect-panel .save-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.8rem;
}
.emu86-inspect-panel .save-row button {
  font: inherit;
  background: #1d2a22;
  color: #8ecfa8;
  border: 1px solid #3a5a46;
  border-radius: 4px;
  padding: 0.25rem 0.7rem;
  cursor: pointer;
}
.emu86-inspect-panel .save-row button:hover { border-color: #5a8a6a; color: #b8ecc8; }
.emu86-inspect-panel .save-row button:disabled { opacity: 0.5; cursor: default; }
`;

export function mountInspectPanel(deps: InspectPanelDeps): void {
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'emu86-inspect-btn';
  btn.type = 'button';
  btn.title = 'Freeze CPU and inspect the machine';
  btn.setAttribute('aria-label', 'Freeze and inspect the machine');
  btn.textContent = '⏸';
  document.body.appendChild(btn);

  let open = false;
  btn.addEventListener('click', () => {
    if (open) return;
    open = true;
    deps.setPaused(true);
    void deps
      .inspect()
      .then((snapshot) =>
        showPanel(snapshot, close, deps.saveState, deps.savedStates, deps.reboot))
      .catch((err: unknown) => {
        showError(String(err), close);
      });
  });

  function close(backdrop: HTMLDivElement): void {
    backdrop.remove();
    deps.setPaused(false);
    open = false;
    deps.onClosed?.();
  }
}

/**
 * Backdrop dismissal that ignores text-selection drags: close only
 * when the press STARTED on the backdrop too — releasing a selection
 * sweep over the backdrop must not dismiss (field ask, 2026-07-16).
 */
function wireBackdropDismiss(backdrop: HTMLDivElement, close: () => void): void {
  let pressStartedOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (ev) => {
    pressStartedOnBackdrop = ev.target === backdrop;
  });
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop && pressStartedOnBackdrop) close();
  });
}

/** The explicit ✕ every overlay now carries (field ask, 2026-07-16). */
function closeButton(onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '✕';
  btn.setAttribute('aria-label', 'Close and resume the CPU');
  btn.style.cssText =
    'float:right;font:inherit;background:none;border:1px solid #394048;' +
    'border-radius:4px;color:#9fb2bf;cursor:pointer;padding:0.1rem 0.5rem;';
  btn.addEventListener('click', onClick);
  return btn;
}

function showPanel(
  s: InspectSnapshot,
  close: (b: HTMLDivElement) => void,
  saveState?: (label: string) => Promise<void>,
  savedStates?: InspectPanelDeps['savedStates'],
  reboot?: () => void,
): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'emu86-inspect-backdrop';
  const panel = document.createElement('div');
  panel.className = 'emu86-inspect-panel';
  panel.appendChild(closeButton(() => dismiss()));

  const r = s.regs;
  const regs = [
    `AX=${hex4(r.ax)}  BX=${hex4(r.bx)}  CX=${hex4(r.cx)}  DX=${hex4(r.dx)}`,
    `SI=${hex4(r.si)}  DI=${hex4(r.di)}  BP=${hex4(r.bp)}  SP=${hex4(r.sp)}`,
    `CS=${hex4(r.cs)}  DS=${hex4(r.ds)}  ES=${hex4(r.es)}  SS=${hex4(r.ss)}`,
    `IP=${hex4(r.ip)}  FLAGS=${hex4(s.flags)} [${decodeFlags(s.flags)}]`,
    `${s.halted ? 'HALTED (waiting for interrupt)' : 'running'} · ${s.mode}`,
  ].join('\n');

  const d = s.devices;
  const devices = [
    `PIC   IRR=${hex2(d.pic.irr)} ISR=${hex2(d.pic.isr)} IMR=${hex2(d.pic.imr)} base=${hex2(d.pic.vectorBase)}`,
    `PIT0  counter=${hex4(d.pit.counter)} divisor=${hex4(d.pit.divisor & 0xffff)} mode=${d.pit.mode}`,
    `UART  IER=${hex2(d.uart.ier)} LCR=${hex2(d.uart.lcr)} MCR=${hex2(d.uart.mcr)} rxQueued=${d.uart.rxQueued}`,
    `NE2K  ISR=${hex2(d.nic.isr)} IMR=${hex2(d.nic.imr)} CURR=${hex2(d.nic.curr)} BNRY=${hex2(d.nic.bnry)} ${d.nic.running ? 'running' : 'stopped'}`,
  ].join('\n');

  panel.append(
    heading('h2', 'machine frozen — dismiss to resume'),
    heading('h3', 'registers'),
    pre(regs),
    heading('h3', `code @ CS:IP (${hex5(s.code.linear)})`),
    pre(hexDump(s.code.bytes, s.code.linear)),
    heading('h3', `stack @ SS:SP (${hex5(s.stack.linear)})`),
    pre(hexDump(s.stack.bytes, s.stack.linear)),
    heading('h3', 'devices'),
    pre(devices),
  );

  // Save the frozen machine as a named state — the capture happens at
  // the message boundary while the paced loop is parked, so what lands
  // in the library is exactly the picture on screen.
  if (saveState !== undefined) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save machine state…';
    const note = document.createElement('span');
    note.className = 'hint';
    row.append(saveBtn, note);
    saveBtn.addEventListener('click', () => {
      const label = prompt(
        'Name this state:',
        `frozen ${new Date().toLocaleString()}`,
      );
      if (label === null) return;
      saveBtn.disabled = true;
      note.textContent = 'capturing…';
      void saveState(label).then(
        () => {
          saveBtn.disabled = false;
          note.textContent = `saved '${label}' — restore from Settings → Machine state.`;
        },
        (err: unknown) => {
          saveBtn.disabled = false;
          note.textContent = `save failed: ${String(err)}`;
        },
      );
    });
    panel.appendChild(row);
  }

  // Restore straight from the freeze: dropdown of named states,
  // click → restore → boom (queue + reload; the machine being frozen
  // makes "replace this machine" an easy decision to stand behind).
  if (savedStates !== undefined) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const select = document.createElement('select');
    select.style.cssText =
      'font:inherit;background:#161d24;color:#d7e0e6;border:1px solid #394048;' +
      'border-radius:4px;padding:0.2rem 0.4rem;max-width:16rem;';
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.textContent = 'Restore';
    restoreBtn.disabled = true;
    const removeFn = savedStates.remove;
    const deleteBtn = removeFn !== undefined ? document.createElement('button') : null;
    if (deleteBtn !== null) {
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Delete';
      deleteBtn.disabled = true;
      deleteBtn.style.borderColor = '#6e3a3a';
      deleteBtn.style.color = '#d08080';
    }
    const note = document.createElement('span');
    note.className = 'hint';
    row.append(select, restoreBtn, ...(deleteBtn !== null ? [deleteBtn] : []), note);
    panel.appendChild(row);

    const refresh = (): void => {
      void savedStates.list().then(
        (rows) => {
          select.innerHTML = '';
          if (rows.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = 'no saved states yet';
            select.appendChild(opt);
            restoreBtn.disabled = true;
            if (deleteBtn !== null) deleteBtn.disabled = true;
            return;
          }
          for (const r of rows) {
            const opt = document.createElement('option');
            opt.value = r.stateId;
            opt.textContent =
              `${r.label ?? r.stateId} (${new Date(r.lastTouched).toLocaleString()})`;
            select.appendChild(opt);
          }
          restoreBtn.disabled = false;
          if (deleteBtn !== null) deleteBtn.disabled = false;
        },
        (err: unknown) => { note.textContent = `list failed: ${String(err)}`; },
      );
    };
    refresh();

    restoreBtn.addEventListener('click', () => {
      const stateId = select.value;
      if (stateId === '') return;
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring…';
      savedStates.restore(stateId); // queues + reloads the page
    });

    // Field ask (2026-07-16): delete straight from the picker. A
    // named save is user-curated (D4) — confirm before it goes.
    if (deleteBtn !== null && removeFn !== undefined) {
      deleteBtn.addEventListener('click', () => {
        const stateId = select.value;
        const label = select.selectedOptions[0]?.textContent ?? stateId;
        if (stateId === '') return;
        if (!confirm(`Delete saved state ${label}? This cannot be undone.`)) return;
        deleteBtn.disabled = true;
        void removeFn(stateId).then(
          () => { note.textContent = 'deleted.'; refresh(); },
          (err: unknown) => {
            deleteBtn.disabled = false;
            note.textContent = `delete failed: ${String(err)}`;
          },
        );
      });
    }
  }

  // The reset button a frozen machine deserves. Disk state persists
  // (overlay + fork); only RAM restarts. No confirm — real reset
  // buttons don't, and nothing durable is lost.
  if (reboot !== undefined) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const rebootBtn = document.createElement('button');
    rebootBtn.type = 'button';
    rebootBtn.textContent = 'Reboot machine';
    rebootBtn.style.borderColor = '#6e4a3a';
    rebootBtn.style.color = '#e0a83a';
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = 'cold boot — RAM restarts, disk state kept';
    row.append(rebootBtn, note);
    rebootBtn.addEventListener('click', () => {
      rebootBtn.disabled = true;
      rebootBtn.textContent = 'Rebooting…';
      reboot();
    });
    panel.appendChild(row);
  }

  panel.appendChild(
    hintEl('click anywhere outside this panel (or press Esc) to resume the CPU'),
  );

  backdrop.appendChild(panel);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') dismiss();
  };
  const dismiss = (): void => {
    document.removeEventListener('keydown', onKey);
    close(backdrop);
  };
  wireBackdropDismiss(backdrop, dismiss);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
}

function showError(reason: string, close: (b: HTMLDivElement) => void): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'emu86-inspect-backdrop';
  const panel = document.createElement('div');
  panel.className = 'emu86-inspect-panel';
  panel.appendChild(closeButton(() => close(backdrop)));
  panel.append(heading('h2', 'inspection failed'), pre(reason),
    hintEl('click outside to resume'));
  backdrop.appendChild(panel);
  wireBackdropDismiss(backdrop, () => close(backdrop));
  document.body.appendChild(backdrop);
}

function heading(tag: 'h2' | 'h3', text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function pre(text: string): HTMLPreElement {
  const el = document.createElement('pre');
  el.textContent = text;
  return el;
}

function hintEl(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'hint';
  el.textContent = text;
  return el;
}

/** Classic hex+ASCII dump, 16 bytes per row, absolute linear addresses. */
function hexDump(bytes: Uint8Array, baseLinear: number): string {
  const rows: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.subarray(off, off + 16);
    const hexes = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    rows.push(`${hex5(baseLinear + off)}  ${hexes.padEnd(47)}  ${ascii}`);
  }
  return rows.join('\n');
}

function decodeFlags(f: number): string {
  const names: Array<[number, string]> = [
    [0x0800, 'OF'], [0x0400, 'DF'], [0x0200, 'IF'], [0x0100, 'TF'],
    [0x0080, 'SF'], [0x0040, 'ZF'], [0x0010, 'AF'], [0x0004, 'PF'],
    [0x0001, 'CF'],
  ];
  return names
    .map(([bit, name]) => ((f & bit) !== 0 ? name : name.toLowerCase()))
    .join(' ');
}

function hex2(n: number): string { return n.toString(16).padStart(2, '0'); }
function hex4(n: number): string { return n.toString(16).padStart(4, '0'); }
function hex5(n: number): string { return n.toString(16).padStart(5, '0'); }
