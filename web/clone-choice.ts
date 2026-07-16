/**
 * Phase 18 M3 — the clone boot-choice modal (field ask, 2026-07-16:
 * "when we duplicate a tab, can we pop up a modal, saying 'you have
 * cloned "mouse" … do you want to reboot it as "cat", or resume
 * mouse's session as is'").
 *
 * Duplicating a tab serves two intents that M3's auto-resume
 * conflated: MINTING A NEW PC (the pre-M3 behaviour — copied disks,
 * cold boot, own name, full network) and CLONING THE RUNNING MACHINE
 * (frozen in amber, network detached until reboot). This modal asks,
 * before any handshake runs — so a fresh-PC choice never bothers the
 * parent, and a resume choice captures the parent AT decision time
 * (D3's no-staleness window, kept).
 *
 * The new machine's name can't be printed here — it leases during
 * boot — so the copy promises "its own name" and the identity line
 * announces it moments later.
 */

export type CloneChoice = 'fresh' | 'resume';

export interface CloneChoiceHandle {
  /** Resolves when the user picks. Never rejects; no timeout — the
   *  user duplicated deliberately, the machine waits. */
  choice: Promise<CloneChoice>;
  /** Swap the buttons for a status line (the resume handshake runs
   *  after the pick — "asking the original tab…"). */
  setBusy(text: string): void;
  close(): void;
}

const CHOICE_CSS = `
.emu86-clone-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
}
.emu86-clone-panel {
  background: #14171b;
  color: #d7e0e6;
  border: 1px solid #394048;
  border-radius: 8px;
  padding: 1.1rem 1.4rem;
  width: min(92vw, 30rem);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 0.85rem;
  line-height: 1.55;
}
.emu86-clone-panel h2 {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  color: #8ecfa8;
}
.emu86-clone-panel .buttons {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  margin-top: 0.9rem;
}
.emu86-clone-panel button {
  font: inherit;
  text-align: left;
  background: #1a2129;
  color: #d7e0e6;
  border: 1px solid #394048;
  border-radius: 6px;
  padding: 0.55rem 0.8rem;
  cursor: pointer;
}
.emu86-clone-panel button:hover { border-color: #5a8a6a; background: #1d2a22; }
.emu86-clone-panel button .title { color: #8ecfa8; font-weight: 700; }
.emu86-clone-panel button .sub { color: #8b98a3; font-size: 0.78rem; display: block; }
.emu86-clone-panel .busy { color: #e0a83a; margin-top: 0.9rem; }
`;

/**
 * Show the choice. `parentName` is the duplicated tab's `.tabs` name
 * when known (the copied session's sticky octet), null otherwise.
 */
export function askCloneChoice(parentName: string | null): CloneChoiceHandle {
  const style = document.createElement('style');
  style.textContent = CHOICE_CSS;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'emu86-clone-backdrop';
  const panel = document.createElement('div');
  panel.className = 'emu86-clone-panel';

  const who = parentName !== null ? `“${parentName}”` : 'a running PC';
  const title = document.createElement('h2');
  title.textContent = `you have duplicated ${who}`;
  panel.appendChild(title);

  const blurb = document.createElement('div');
  blurb.textContent = 'This tab can become:';
  panel.appendChild(blurb);

  const buttons = document.createElement('div');
  buttons.className = 'buttons';

  const make = (titleText: string, subText: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = titleText;
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = subText;
    b.append(t, s);
    buttons.appendChild(b);
    return b;
  };

  const freshBtn = make(
    'a new PC (reboot)',
    'same disks, fresh boot, its own name and full network — what duplicating did before',
  );
  const resumeBtn = make(
    `${parentName !== null ? `${parentName}’s` : 'the'} session, frozen in amber`,
    'resumes exactly where it is — no tab network until you reboot it; ' +
      'internet, files and editing still work',
  );
  panel.appendChild(buttons);

  const busy = document.createElement('div');
  busy.className = 'busy';
  busy.hidden = true;
  panel.appendChild(busy);

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  const choice = new Promise<CloneChoice>((resolve) => {
    freshBtn.addEventListener('click', () => resolve('fresh'));
    resumeBtn.addEventListener('click', () => resolve('resume'));
  });

  return {
    choice,
    setBusy(text: string) {
      buttons.hidden = true;
      busy.hidden = false;
      busy.textContent = text;
    },
    close() {
      backdrop.remove();
    },
  };
}
