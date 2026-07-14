/**
 * Boot-script runner (Phase 14 — boot scripts; landing-showcase
 * directives added 2026-07-15).
 *
 * Types a user-authored script into the guest console at boot,
 * prompt-aware: each line waits for the guest to show a prompt before
 * it is sent, so the same script works regardless of how long the boot
 * takes — no timers on the waiting side. Original purpose (Jonathan):
 * speed up the manual testing loop — `root` + `net start ne0` typed
 * hands-free puts every tab on the TAN. The landing showcase grew it
 * into a stage direction language.
 *
 * Script format, one line per line:
 *
 *   - A plain line is sent (with a trailing newline) once the guest
 *     shows a prompt: `login:`, `Password:`, `# ` or `$ `.
 *   - `@expect some text` — the NEXT line waits for `some text` to
 *     appear in the output (since the last send) instead of a prompt.
 *   - `@type` / `@instant` — switch how lines are SENT: clackety mode
 *     types character by character at fake-human cadence, firing
 *     `onKeystroke` per character (the keyboard-FX hook); instant mode
 *     (default) sends whole lines.
 *   - `@here` … `@end` — a verbatim block, the heredoc device: every
 *     enclosed line (blanks included) is sent as-is, each one waiting
 *     for the shell's `> ` continuation prompt first. That wait IS
 *     the flow control: the shell prints `> ` only after consuming
 *     the previous line, so the guest tty paces the paste. (The
 *     original no-wait design overran the kernel's raw tty queue at
 *     ~35 lines — the 380-line ping installer arrived as soup; field
 *     find 2026-07-14.)
 *   - `@turbo` / `@authentic` — fire the `setSpeed` hook (live CPU
 *     speed change) when the script reaches them; no send. The
 *     showcase compiles in turbo and reveals in authentic.
 *   - Blank lines are skipped OUTSIDE @here blocks, kept inside them
 *     (source files have blank lines). Other `#`-prefixed lines are
 *     typed verbatim — the ELKS shell treats them as comments.
 *
 * Mechanics: `feed()` receives decoded guest TX. Output accumulates
 * (bounded) since the last send; default prompts match its tail, so a
 * prompt split across two TX batches still fires. The buffer resets on
 * every send — the prompt that triggered line N can't also trigger
 * line N+1. While clackety typing is in flight, matching is suspended
 * (the guest's own echo of our keystrokes must not satisfy anything).
 * Injection rides the ordinary rx path, so the worker host's UART FIFO
 * pacing (M2.5) applies unchanged.
 *
 * The scheduler and inter-key delays are injectable so tests drive
 * typing deterministically; defaults are setTimeout and a humanish
 * randomized cadence.
 */

/**
 * Prompts that release the next plain line: getty, login, sh — and
 * sh's `> ` continuation prompt, so a script line ending in `\` flows
 * naturally into its continuation line (field find, 2026-07-15: the
 * shell supported it all along; the matcher didn't know the prompt).
 */
const DEFAULT_PROMPT = /(login: ?|Password: ?|[#$>] )$/;

/** Output retained since the last send — plenty for any boot chatter. */
const BUFFER_CAP = 65_536;

export type SpeedDirective = 'authentic' | 'turbo';

interface Step {
  /** Substring to wait for (from `@expect`), or null for a prompt. */
  readonly expect: string | null;
  /** Send without waiting for anything. Dormant since the @here
   *  flow-control change — no parser output sets it anymore. */
  readonly nowait: boolean;
  /** Send character by character with keystroke FX. */
  readonly typed: boolean;
  /** Line to send; null for pure-action steps. */
  readonly text: string | null;
  /** Side effect to run when the script reaches this step. */
  readonly speed?: SpeedDirective;
}

export interface AutoexecOptions {
  script: string;
  /** Sink for keystrokes — main.ts wires this to the worker rx path. */
  send: (text: string) => void;
  /** Fired once per character in clackety (@type) mode — keyboard FX. */
  onKeystroke?: (char: string) => void;
  /** Fired by @turbo/@authentic — main.ts posts set-speed. */
  setSpeed?: (mode: SpeedDirective) => void;
  /**
   * Fired exactly once, when the last step has fully completed —
   * including the final keystroke of a typed line, which lands on a
   * timer, outside any feed() (field bug: completion checks hung off
   * feed() never fired for a show that ends in clackety mode).
   */
  onDone?: () => void;
  /** Timer injection (tests). Default setTimeout. */
  schedule?: (ms: number, fn: () => void) => void;
  /** Inter-key delay in ms for @type mode (tests inject a constant). */
  typeDelayMs?: () => number;
}

/** Humanish cadence: quick base with jitter, a beat after newlines. */
function defaultTypeDelay(): number {
  return 35 + Math.random() * 105;
}

export class AutoexecRunner {
  readonly #steps: Step[];
  readonly #send: (text: string) => void;
  readonly #onKeystroke: (char: string) => void;
  readonly #setSpeed: (mode: SpeedDirective) => void;
  readonly #schedule: (ms: number, fn: () => void) => void;
  readonly #typeDelayMs: () => number;
  readonly #onDone: () => void;
  #next = 0;
  #buffer = '';
  #typing = false;
  #doneFired = false;

  constructor(opts: AutoexecOptions) {
    this.#send = opts.send;
    this.#onKeystroke = opts.onKeystroke ?? (() => { /* silent keys */ });
    this.#setSpeed = opts.setSpeed ?? (() => { /* no speed control wired */ });
    this.#schedule = opts.schedule ?? ((ms, fn) => { setTimeout(fn, ms); });
    this.#typeDelayMs = opts.typeDelayMs ?? defaultTypeDelay;
    this.#onDone = opts.onDone ?? (() => { /* unobserved */ });
    this.#steps = parseScript(opts.script);
  }

  /** True while lines remain to be sent (or typing is in flight). */
  get active(): boolean {
    return this.#typing || this.#next < this.#steps.length;
  }

  /** Number of steps already dispatched — for banners/diagnostics. */
  get sent(): number {
    return this.#next;
  }

  /** Feed decoded guest output; dispatches any steps whose wait is satisfied. */
  feed(chunk: string): void {
    if (!this.active) return;
    this.#buffer = (this.#buffer + chunk).slice(-BUFFER_CAP);
    if (this.#typing) return; // our own echo must not satisfy anything
    this.#advance();
  }

  /**
   * Dispatch as many steps as are currently runnable: action steps and
   * no-wait sends chain; a waited step stops the chain until fresh
   * output satisfies it; a typed send suspends the chain until the
   * last character lands.
   */
  #advance(): void {
    for (;;) {
      const step = this.#steps[this.#next];
      if (step === undefined) {
        // Fully complete (never mid-typing — typeOut re-enters here
        // only after its last character). Announce once.
        if (!this.#doneFired && !this.#typing) {
          this.#doneFired = true;
          this.#onDone();
        }
        return;
      }

      if (step.speed !== undefined) {
        this.#next++;
        this.#setSpeed(step.speed);
        continue;
      }

      if (!step.nowait) {
        const satisfied =
          step.expect !== null
            ? this.#buffer.includes(step.expect)
            : DEFAULT_PROMPT.test(this.#buffer);
        if (!satisfied) return;
      }

      this.#buffer = '';
      this.#next++;
      const text = step.text ?? '';
      if (step.typed) {
        this.#typeOut(`${text}\n`);
        return; // #typeOut resumes the chain when the last char lands
      }
      this.#send(`${text}\n`);
      // Chain onward only into a nowait text step. Since the @here
      // flow-control change no parser output is nowait anymore (every
      // line waits for a prompt — heredoc bodies wait for `> `), so
      // this branch is dormant; it stays because the shape is correct
      // if a future directive reintroduces unwaited sends. Speed
      // actions must NOT chain here: @turbo/@authentic reflect the
      // previous command COMPLETING, not being sent.
      const nxt = this.#steps[this.#next];
      // No next step: loop once more so the done branch announces
      // completion (an instant final line otherwise exited here and
      // onDone never fired).
      if (nxt === undefined || (nxt.nowait && nxt.speed === undefined)) continue;
      return;
    }
  }

  /**
   * Clackety mode: one character per scheduled tick, FX per key.
   *
   * Buffer discipline is subtle and was got wrong once (found by
   * driving the real demo script against a real boot):
   *
   *   - The guest ECHOES every character we type, so mid-typing the
   *     buffer fills with our own line — which must never satisfy the
   *     next step's wait. Hence matching is suspended while typing.
   *   - But the command only RUNS at the newline, and a fast command's
   *     whole reply (output + fresh prompt) can land inside the final
   *     inter-key delay. Clearing the buffer when typing *ends* would
   *     therefore discard the very prompt the next step waits for, and
   *     the script would hang forever mid-show.
   *
   * So the buffer is cleared exactly when the newline goes out: the
   * echo before it is dropped, everything the command says after it is
   * kept.
   */
  #typeOut(text: string): void {
    this.#typing = true;
    const typeAt = (idx: number): void => {
      if (idx >= text.length) {
        this.#typing = false;
        this.#advance(); // chain onward; a trailing prompt may already be here
        return;
      }
      const ch = text.charAt(idx);
      this.#send(ch);
      if (ch === '\n') {
        // Command committed: drop our own echo, keep whatever it says.
        this.#buffer = '';
      } else {
        this.#onKeystroke(ch);
      }
      // A beat after newlines — humans glance at the screen.
      const delay = ch === '\n' ? this.#typeDelayMs() * 3 : this.#typeDelayMs();
      this.#schedule(delay, () => typeAt(idx + 1));
    };
    typeAt(0);
  }
}

function parseScript(script: string): Step[] {
  const steps: Step[] = [];
  let pendingExpect: string | null = null;
  let typed = false;
  let inHere = false;
  for (const raw of script.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!inHere) {
      if (line.trim() === '') continue;
      if (line === '@type') { typed = true; continue; }
      if (line === '@instant') { typed = false; continue; }
      if (line === '@here') { inHere = true; continue; }
      if (line === '@turbo' || line === '@authentic') {
        steps.push({ expect: null, nowait: true, typed: false, text: null, speed: line.slice(1) as SpeedDirective });
        continue;
      }
      if (line.startsWith('@expect ')) {
        pendingExpect = line.slice('@expect '.length);
        continue;
      }
      steps.push({ expect: pendingExpect, nowait: false, typed, text: line });
      pendingExpect = null;
    } else {
      if (line === '@end') { inHere = false; continue; }
      // Inside @here: everything verbatim (blank lines included), each
      // line WAITING for the `> ` continuation prompt like any other
      // step (DEFAULT_PROMPT includes it). The shell only prints `> `
      // after consuming the previous line, so the guest tty paces the
      // paste — a ~380-line heredoc sent without waits overran the
      // kernel's raw tty queue and arrived as soup (field find,
      // 2026-07-14: the ping installer). The UART-FIFO pacing in the
      // worker can't help with that; only end-to-end flow control can.
      steps.push({ expect: null, nowait: false, typed, text: line });
    }
  }
  return steps;
}
