// Sample-accurate snippet playback.
//
// The whole game hinges on "play exactly 0.1s" being *exactly* 0.1s. An
// <audio> element plus setTimeout drifts by 20-50ms, which at the first tier is
// a 50% error. So: fetch the preview, decode it once, and schedule slices off
// the decoded AudioBuffer. The iTunes preview CDN sends CORS headers, so the
// fetch is allowed.
//
// A short gain ramp on each end kills the click you'd otherwise get from
// starting and stopping mid-waveform.

const FADE_IN = 0.004;
const FADE_OUT = 0.015;

export class SnippetPlayer {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.startedAt = 0;
    this.playingFor = 0;
    this.onProgress = null; // (elapsedSeconds | null) => void
    this._raf = 0;
  }

  /** Must be called from a user gesture on iOS/Safari. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /** Download + decode a preview. Resolves once the clip is ready to slice. */
  async load(url, { signal } = {}) {
    this.stop();
    this.buffer = null;
    const ctx = this.unlock();
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`preview fetch failed: ${res.status}`);
    const bytes = await res.arrayBuffer();
    this.buffer = await ctx.decodeAudioData(bytes);
    return this.buffer.duration;
  }

  /** Play `seconds` from the top of the clip. */
  play(seconds) {
    if (!this.buffer) return;
    this.stop();
    const ctx = this.unlock();
    const dur = Math.min(seconds, this.buffer.duration);

    const src = ctx.createBufferSource();
    src.buffer = this.buffer;

    const gain = ctx.createGain();
    const t0 = ctx.currentTime + 0.02;
    const fin = Math.min(FADE_IN, dur / 8);
    const fout = Math.min(FADE_OUT, dur / 4);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(1, t0 + fin);
    gain.gain.setValueAtTime(1, t0 + dur - fout);
    gain.gain.linearRampToValueAtTime(0.0001, t0 + dur);

    src.connect(gain).connect(ctx.destination);
    src.start(t0, 0, dur);
    src.stop(t0 + dur + 0.02);

    this.source = src;
    this.startedAt = t0;
    this.playingFor = dur;
    src.onended = () => {
      if (this.source === src) this.source = null;
      this._tick();
    };
    this._tick();
  }

  stop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source = null;
    }
    cancelAnimationFrame(this._raf);
    this.onProgress?.(null);
  }

  get isPlaying() {
    return !!this.source;
  }

  _tick = () => {
    if (!this.source) {
      cancelAnimationFrame(this._raf);
      this.onProgress?.(null);
      return;
    }
    const elapsed = this.ctx.currentTime - this.startedAt;
    this.onProgress?.(Math.max(0, Math.min(elapsed, this.playingFor)));
    this._raf = requestAnimationFrame(this._tick);
  };
}
