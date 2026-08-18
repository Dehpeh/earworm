// Sample-accurate snippet playback.
//
// The whole game hinges on "play exactly 0.1s" being *exactly* 0.1s. An
// <audio> element plus setTimeout drifts by 20-50ms, which at the first tier is
// a 50% error. So: fetch the preview, decode it once, and schedule slices off
// the decoded AudioBuffer. The iTunes preview CDN sends CORS headers, so the
// fetch is allowed.
//
// Decoding the whole clip up front is also what makes scrubbing possible.
// Playback is `source.start(when, offset, duration)`, so moving the start point
// costs nothing: any region of the buffer can be scheduled as precisely as the
// region starting at zero. Nothing is streamed and nothing seeks.
//
// A short gain ramp on each end kills the click you'd otherwise get from
// starting and stopping mid-waveform.

const FADE_IN = 0.004;
const FADE_OUT = 0.015;

export class SnippetPlayer {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffer = null;
    this.source = null;
    this.onset = 0; // seconds of dead air before the clip actually starts
    this.startedAt = 0; // ctx time the current region began
    this.regionFrom = 0; // clip time the current region began
    this.regionTo = 0;
    this.volume = 0.8;
    this.onProgress = null; // (clipSeconds | null) => void
    this._raf = 0;
    this._peakCache = new Map();
  }

  /** Must be called from a user gesture on iOS/Safari. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = gainFor(this.volume);
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** Playable length measured from the first audible sample, not from the file. */
  get duration() {
    return this.buffer ? Math.max(0, this.buffer.duration - this.onset) : 0;
  }

  get isPlaying() {
    return !!this.source;
  }

  /**
   * 0..1, applied on a squared curve because loudness is not linear in gain:
   * a linear slider spends its top half doing almost nothing audible.
   */
  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) {
      // Ramp rather than jump, or dragging the slider crackles.
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(gainFor(this.volume), t, 0.015);
    }
    return this.volume;
  }

  /** Download + decode a preview. Resolves once the clip is ready to slice. */
  async load(url, { signal } = {}) {
    this.stop();
    this.buffer = null;
    this._peakCache.clear();
    this._scale = 0; // recomputed per clip, or the previous song's scale leaks in
    this.onset = 0;
    const ctx = this.unlock();
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`preview fetch failed: ${res.status}`);
    const bytes = await res.arrayBuffer();
    this.buffer = await ctx.decodeAudioData(bytes);
    this.onset = this._findOnset();
    return this.duration;
  }

  /**
   * Play the region [from, to] of the clip, in seconds.
   *
   * `from` is what scrubbing moves. The caller is responsible for keeping the
   * region inside what the player has unlocked; this method only clamps to the
   * buffer.
   */
  play(from, to) {
    if (!this.buffer) return;
    this.stop();
    const ctx = this.unlock();
    const start = Math.max(0, Math.min(from, this.duration));
    const end = Math.max(start, Math.min(to, this.duration));
    const dur = end - start;
    if (dur <= 0.001) return;

    const src = ctx.createBufferSource();
    src.buffer = this.buffer;

    const env = ctx.createGain();
    const t0 = ctx.currentTime + 0.02;
    const fin = Math.min(FADE_IN, dur / 8);
    const fout = Math.min(FADE_OUT, dur / 4);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(1, t0 + fin);
    env.gain.setValueAtTime(1, t0 + dur - fout);
    env.gain.linearRampToValueAtTime(0.0001, t0 + dur);

    src.connect(env).connect(this.master);
    src.start(t0, this.onset + start, dur);
    src.stop(t0 + dur + 0.02);

    this.source = src;
    this.startedAt = t0;
    this.regionFrom = start;
    this.regionTo = end;
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

  /**
   * Min/max envelope over [from, to], bucketed to `buckets` columns, normalized
   * to the loudest point in the *whole* clip so that zooming into a quiet
   * opening doesn't inflate it into a wall of noise.
   *
   * Cached per (from, to, buckets): the waveform is redrawn on every resize and
   * every tier change, and a 30s stereo buffer is around 2.6M samples.
   */
  peaks(from, to, buckets) {
    if (!this.buffer) return null;
    const key = `${from.toFixed(3)}|${to.toFixed(3)}|${buckets}`;
    const hit = this._peakCache.get(key);
    if (hit) return hit;

    const data = this.buffer.getChannelData(0);
    const rate = this.buffer.sampleRate;
    const s0 = Math.max(0, Math.floor((this.onset + from) * rate));
    const s1 = Math.min(data.length, Math.ceil((this.onset + to) * rate));
    const span = Math.max(1, s1 - s0);
    const per = span / buckets;

    const out = new Float32Array(buckets);
    for (let b = 0; b < buckets; b++) {
      const a = s0 + Math.floor(b * per);
      const z = Math.min(s1, s0 + Math.floor((b + 1) * per));
      let peak = 0;
      // Stride on long windows: at 16s a bucket can span 20k samples, and the
      // envelope is identical whether every sample is read or every eighth.
      const step = Math.max(1, Math.floor((z - a) / 512));
      for (let i = a; i < z; i += step) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > peak) peak = v;
      }
      out[b] = peak;
    }

    const norm = this._fullScale();
    for (let b = 0; b < buckets; b++) out[b] = Math.min(1, out[b] / norm);
    this._peakCache.set(key, out);
    return out;
  }

  /**
   * Where the music actually starts, in seconds.
   *
   * Apple's previews are cut at a fixed offset into the track, not at a musical
   * boundary, so a good few of them open on silence, a fade-in, or room tone. At
   * the 0.1s tier that is a dead round: the first two guesses are spent on
   * nothing audible, which is not a difficulty curve, it is a broken puzzle.
   * Every public time on this player is therefore measured from here rather than
   * from the head of the file.
   *
   * The threshold is relative to the clip's own level (a share of its 90th
   * percentile loudness) so it works on a quiet ballad and a loud mix alike, and
   * it demands *sustained* energy so a single click or a vinyl pop does not
   * count as the song starting.
   */
  _findOnset() {
    const data = this.buffer.getChannelData(0);
    const rate = this.buffer.sampleRate;
    const hop = Math.max(1, Math.floor(rate * 0.01)); // 10ms frames
    const frames = Math.floor(data.length / hop);
    if (frames < 4) return 0;

    const rms = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const a = f * hop;
      let sum = 0;
      let n = 0;
      for (let i = a; i < a + hop; i += 4, n++) sum += data[i] * data[i];
      rms[f] = Math.sqrt(sum / Math.max(1, n));
    }

    const sorted = Float32Array.from(rms).sort();
    const loud = sorted[Math.floor(frames * 0.9)];
    // A clip with no loud part at all has nothing to align to; play it as-is
    // rather than inventing an offset.
    if (!(loud > 1e-4)) return 0;

    const thresh = loud * 0.12;
    const need = 10; // 100ms, i.e. the whole first tier must have signal in it
    for (let f = 0; f + need <= frames; f++) {
      if (rms[f] < thresh) continue;
      let hits = 0;
      for (let g = f; g < f + need; g++) if (rms[g] >= thresh) hits++;
      if (hits >= need * 0.7) {
        const onset = (f * hop) / rate;
        // Never trim so far that the 16s ladder no longer fits.
        return Math.max(0, Math.min(onset, this.buffer.duration - 17));
      }
    }
    return 0;
  }

  /** Loudest sample in the clip, computed once, so zoom levels stay comparable. */
  _fullScale() {
    if (this._scale) return this._scale;
    const data = this.buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i += 32) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) peak = v;
    }
    this._scale = peak || 1;
    return this._scale;
  }

  _tick = () => {
    if (!this.source) {
      cancelAnimationFrame(this._raf);
      this.onProgress?.(null);
      return;
    }
    const elapsed = this.ctx.currentTime - this.startedAt;
    const pos = this.regionFrom + Math.max(0, elapsed);
    this.onProgress?.(Math.min(pos, this.regionTo));
    this._raf = requestAnimationFrame(this._tick);
  };
}

function gainFor(v) {
  return v * v;
}
