/**
 * Status LEDs (Phase 18 field-loop UI — Jonathan: "some leds on the
 * emu86 chrome/status bar might be useful").
 *
 * Four lights in the page header, fed from data main already has:
 *
 *   CPU   — green while the guest executes, dim while it idles in HLT,
 *           blue in turbo. Tooltip: instr/s and % of a real 4.77 MHz.
 *   DISK  — flashes on write activity (overlay hot sectors or fork
 *           dirty sectors), amber while unswept/unpersisted data
 *           exists, dim when everything has been persisted.
 *   NET   — flashes on NIC frame deltas between stats beats.
 *   STATE — the resume slot's health: green = captured moments ago (a
 *           refresh resumes), amber = capture in flight, dim = no slot
 *           yet, red = resume machinery degraded.
 *
 * All rendering is 1 Hz stats-beat sampling with short CSS flashes —
 * per-event blinking would need chatty worker messages for no visible
 * difference. Pure DOM; styles are injected here so the module is
 * self-contained.
 */

export type LedTone = 'off' | 'dim' | 'green' | 'amber' | 'red' | 'blue';

export interface StatusLeds {
  /**
   * `detail` is the low-lighted bracketed suffix after the label —
   * field ask 2026-07-16: "STATE hh:mm:ss so you see it ticking
   * over". Undefined leaves the current detail untouched (so the
   * amber capture-in-flight beat doesn't blink the timestamp away);
   * null clears it; a string shows `(string)`.
   */
  set(name: LedName, tone: LedTone, title: string, detail?: string | null): void;
  /** One short flash (activity blip) layered over the current tone. */
  flash(name: LedName): void;
}

export type LedName = 'cpu' | 'disk' | 'net' | 'state';

const LED_ORDER: readonly LedName[] = ['cpu', 'disk', 'net', 'state'];

const LED_CSS = `
.emu86-leds {
  display: inline-flex;
  gap: 0.55em;
  margin-left: 0.9em;
  vertical-align: middle;
}
.emu86-led {
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  font-size: 0.62em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.85;
  cursor: default;
  user-select: none;
}
.emu86-led .dot {
  width: 0.7em;
  height: 0.7em;
  border-radius: 50%;
  background: #333;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.6) inset;
  transition: background 0.25s, box-shadow 0.25s;
}
.emu86-led .detail {
  opacity: 0.5;
  text-transform: none;
  letter-spacing: normal;
  font-variant-numeric: tabular-nums;
}
.emu86-led .detail:empty { display: none; }
.emu86-led[data-tone='dim'] .dot { background: #3a4a3a; }
.emu86-led[data-tone='green'] .dot { background: #37d05c; box-shadow: 0 0 6px #37d05c; }
.emu86-led[data-tone='amber'] .dot { background: #e0a83a; box-shadow: 0 0 6px #e0a83a; }
.emu86-led[data-tone='red'] .dot { background: #e05252; box-shadow: 0 0 6px #e05252; }
.emu86-led[data-tone='blue'] .dot { background: #4aa8ff; box-shadow: 0 0 6px #4aa8ff; }
.emu86-led.flash .dot {
  background: #d9f7e2;
  box-shadow: 0 0 8px #d9f7e2;
  transition: none;
}
`;

/** Mount the LED strip into `host` (the header's <p> in practice). */
export function mountStatusLeds(host: HTMLElement): StatusLeds {
  const style = document.createElement('style');
  style.textContent = LED_CSS;
  document.head.appendChild(style);

  const strip = document.createElement('span');
  strip.className = 'emu86-leds';
  const els = new Map<LedName, HTMLSpanElement>();
  const details = new Map<LedName, HTMLSpanElement>();
  for (const name of LED_ORDER) {
    const led = document.createElement('span');
    led.className = 'emu86-led';
    led.dataset.tone = 'off';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = name;
    const detail = document.createElement('span');
    detail.className = 'detail';
    led.append(dot, label, detail);
    strip.appendChild(led);
    els.set(name, led);
    details.set(name, detail);
  }
  host.appendChild(strip);

  const flashTimers = new Map<LedName, number>();
  return {
    set(name, tone, title, detail) {
      const led = els.get(name);
      if (led === undefined) return;
      led.dataset.tone = tone;
      led.title = title;
      if (detail !== undefined) {
        const el = details.get(name);
        if (el !== undefined) el.textContent = detail === null ? '' : `(${detail})`;
      }
    },
    flash(name) {
      const led = els.get(name);
      if (led === undefined) return;
      led.classList.add('flash');
      const prior = flashTimers.get(name);
      if (prior !== undefined) clearTimeout(prior);
      flashTimers.set(
        name,
        window.setTimeout(() => led.classList.remove('flash'), 180),
      );
    },
  };
}
