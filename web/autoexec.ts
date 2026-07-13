/**
 * Boot-script runner (Phase 14 — boot scripts / autoexec).
 *
 * Types a user-authored script into the guest console at boot,
 * prompt-aware: each line waits for the guest to show a prompt before
 * it is sent, so the same script works regardless of how long the boot
 * takes — no timers, no blind delays. Purpose (Jonathan, 2026-07-14):
 * speed up the manual testing loop — `root` + `net start ne0` typed
 * hands-free puts every tab on the TAN.
 *
 * Script format, one keystroke line per line:
 *
 *   - A plain line is sent (with a trailing newline) once the guest
 *     shows a prompt: `login:`, `Password:`, `# ` or `$ `.
 *   - `@expect some text` — the NEXT line waits for `some text` to
 *     appear in the output (since the last send) instead of a prompt.
 *     Useful for output that isn't a prompt, e.g. waiting for ktcp's
 *     `ip 10.0.2.` line before a telnet.
 *   - Blank lines are skipped. Everything else is typed verbatim —
 *     including `#`-prefixed lines (the ELKS shell treats them as
 *     comments anyway, so scripts can carry their own annotations).
 *
 * Mechanics: `feed()` receives decoded guest TX. Output accumulates
 * (bounded) since the last send; default prompts match its tail, so a
 * prompt split across two TX batches still fires. The buffer resets on
 * every send — the prompt that triggered line N can't also trigger
 * line N+1; a fresh prompt must be printed by the guest. Injection
 * goes through the ordinary rx path, so the worker host's UART FIFO
 * pacing (M2.5) applies unchanged.
 *
 * If an expected prompt never appears the runner simply never fires —
 * it holds no timers and goes inert when the script is exhausted.
 */

/** Prompts that release the next plain line: getty, login, sh. */
const DEFAULT_PROMPT = /(login: ?|Password: ?|[#$] )$/;

/** Output retained since the last send — plenty for any boot chatter. */
const BUFFER_CAP = 65_536;

interface Step {
  /** Substring to wait for (from `@expect`), or null for a prompt. */
  readonly expect: string | null;
  readonly text: string;
}

export interface AutoexecOptions {
  script: string;
  /** Sink for keystrokes — main.ts wires this to the worker rx path. */
  send: (text: string) => void;
}

export class AutoexecRunner {
  readonly #steps: Step[];
  readonly #send: (text: string) => void;
  #next = 0;
  #buffer = '';

  constructor(opts: AutoexecOptions) {
    this.#send = opts.send;
    this.#steps = parseScript(opts.script);
  }

  /** True while lines remain to be sent. */
  get active(): boolean {
    return this.#next < this.#steps.length;
  }

  /** Number of lines already sent — for banners/diagnostics. */
  get sent(): number {
    return this.#next;
  }

  /** Feed decoded guest output; sends any lines whose wait is satisfied. */
  feed(chunk: string): void {
    if (!this.active) return;
    this.#buffer = (this.#buffer + chunk).slice(-BUFFER_CAP);

    // A single chunk can satisfy several steps only via fresh output
    // between sends — the buffer reset below guarantees one send per
    // satisfied wait, so a plain loop is safe.
    for (;;) {
      const step = this.#steps[this.#next];
      if (step === undefined) return;
      const satisfied =
        step.expect !== null
          ? this.#buffer.includes(step.expect)
          : DEFAULT_PROMPT.test(this.#buffer);
      if (!satisfied) return;
      this.#buffer = '';
      this.#next++;
      this.#send(`${step.text}\n`);
    }
  }
}

function parseScript(script: string): Step[] {
  const steps: Step[] = [];
  let pendingExpect: string | null = null;
  for (const raw of script.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    if (line.startsWith('@expect ')) {
      pendingExpect = line.slice('@expect '.length);
      continue;
    }
    steps.push({ expect: pendingExpect, text: line });
    pendingExpect = null;
  }
  return steps;
}
