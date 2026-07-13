/**
 * Keyboard FX for clackety mode (landing showcase, 2026-07-15).
 *
 * A tiny synthesized key-click per typed character — WebAudio
 * oscillator bursts, no audio assets, no dependencies. Each click is
 * slightly detuned at random so a typed line sounds like a keyboard,
 * not a metronome; the spacebar gets a deeper thock, as it deserves.
 *
 * Autoplay policy: browsers keep an AudioContext suspended until a
 * user gesture. We hook one-time pointer/key listeners to resume it;
 * clicks before the unlock are silently skipped (the show is still
 * fully watchable muted — sound is seasoning, not load-bearing).
 */

export function createKeyClick(): (char: string) => void {
  let ctx: AudioContext | null = null;

  function ensureContext(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    if (ctx === null) {
      ctx = new AudioContext();
      const unlock = (): void => {
        void ctx?.resume();
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      };
      window.addEventListener('pointerdown', unlock);
      window.addEventListener('keydown', unlock);
    }
    return ctx;
  }

  return (char: string): void => {
    const audio = ensureContext();
    if (audio === null || audio.state !== 'running') return;

    const now = audio.currentTime;
    const isSpace = char === ' ';
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    // Keys chirp high with jitter; the spacebar thocks low.
    osc.frequency.value = isSpace
      ? 90 + Math.random() * 30
      : 1800 + Math.random() * 1400;
    gain.gain.setValueAtTime(isSpace ? 0.05 : 0.028, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (isSpace ? 0.03 : 0.014));
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(now);
    osc.stop(now + 0.04);
  };
}
