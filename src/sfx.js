// Tiny synthesized sound cues. No audio assets — the game ships as a plain
// folder, so the cues are built from oscillators at play time instead of files.
//
// Everything routes through the SnippetPlayer's master gain, which is what
// makes the volume slider govern the effects as well as the music. Every cue
// fires from a user-gesture code path (guess, skip, round end), so autoplay
// policy never blocks them.

export class Sfx {
  constructor(player) {
    this.player = player;
  }

  /** One enveloped oscillator note. Attack is 12ms so nothing ever clicks. */
  _note(freq, { type = 'sine', at = 0, dur = 0.12, peak = 0.18, glide = 0 } = {}) {
    const ctx = this.player.unlock();
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.player.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Correct answer: a quick rising major arpeggio, C to C. */
  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) =>
      this._note(f, {
        type: 'triangle',
        at: i * 0.07,
        dur: i === notes.length - 1 ? 0.34 : 0.14,
        peak: 0.16,
      })
    );
  }

  /** Out of guesses: two low tones falling a semitone each. */
  lose() {
    this._note(220, { type: 'sawtooth', dur: 0.2, peak: 0.08, glide: 196 });
    this._note(164.81, { type: 'sawtooth', at: 0.18, dur: 0.34, peak: 0.08, glide: 138.59 });
  }

  /** Wrong guess: a short dull buzz, kept tiny so it never scolds. */
  wrong() {
    this._note(130, { type: 'square', dur: 0.09, peak: 0.05 });
  }

  /** Close (right artist, wrong song): two quick notes a third apart, warm not scolding. */
  close() {
    this._note(392, { type: 'triangle', dur: 0.09, peak: 0.1 });
    this._note(493.88, { type: 'triangle', at: 0.08, dur: 0.12, peak: 0.1 });
  }

  /** Skip: a soft downward blip. */
  skip() {
    this._note(560, { dur: 0.08, peak: 0.08, glide: 392 });
  }
}
