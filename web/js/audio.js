/**
 * The instrument.
 *
 * Everything here is Web Audio and nothing here decides what to play -- sonify.js
 * owns the score, this owns the sound. Keeping the split clean is what lets the
 * mapping be tested headlessly; an AudioContext cannot exist in Node, and the
 * part worth testing is the part that decides which plant sounds when.
 *
 * No samples, no libraries, no external files: every timbre is built from
 * oscillators and one procedurally generated noise buffer, and the reverb's
 * impulse response is synthesised at startup. The rest of this project renders
 * its own coastlines and colour ramps rather than pulling in a dependency, and
 * an audio layer that needed a CDN would be the first thing here that could not
 * be opened from a folder.
 *
 * ---- why the audio clock is the master ----
 * explore.js advances time from a requestAnimationFrame accumulator, which is
 * right for an animation and wrong for a pulse: rAF fires every ~16 ms and a
 * sixteenth note here is 111 ms, so notes would land up to 14% early or late.
 * Audible, and the sloppiness would read as a property of the data. So the
 * scheduler below runs on a timer, books notes ahead against ctx.currentTime --
 * which is sample-accurate -- and publishes where it has got to. The picture
 * follows the sound rather than the other way round.
 */

const LOOKAHEAD_MS = 25;   // how often the scheduler wakes
const SCHEDULE_AHEAD = 0.12; // how far ahead of the clock it books, in seconds

/** Struck-voice recipes: partial ratios, relative gains, and decay in seconds. */
const VOICES = {
  // Low and blunt: a near-sine with a fast decay and a touch of second
  // harmonic, plus a noise transient for the strike.
  wood: { partials: [[1, 1], [2.01, 0.22], [3.9, 0.08]], decay: 0.42, type: 'sine', noise: 0.35, noiseHz: 1400, noiseDecay: 0.035 },
  // Electric-piano tine: a strong odd partial and a long-ish tail.
  tine: { partials: [[1, 1], [3.02, 0.4], [5.1, 0.12]], decay: 0.85, type: 'sine', noise: 0.18, noiseHz: 2600, noiseDecay: 0.025 },
  // Bright and short, so a seventeen-plant cluster stays legible.
  glass: { partials: [[1, 1], [2.76, 0.3], [4.1, 0.14]], decay: 0.55, type: 'sine', noise: 0.22, noiseHz: 5200, noiseDecay: 0.02 },
  // The near-field pair. Inharmonic and longer -- Korea and Japan sit almost
  // under the station and fire often, so they need to be identifiable rather
  // than merely rare.
  chime: { partials: [[1, 1], [2.4, 0.5], [3.84, 0.25], [6.2, 0.1]], decay: 1.6, type: 'sine', noise: 0.12, noiseHz: 7000, noiseDecay: 0.02 },
  bell: { partials: [[1, 1], [2.76, 0.55], [5.4, 0.28], [8.9, 0.1]], decay: 2.4, type: 'sine', noise: 0.1, noiseHz: 6000, noiseDecay: 0.03 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.playing = false;
    this.step = 0;
    this.stepSeconds = 1 / 9;
    this.queue = [];        // {step, when} published for the visuals to follow
    this._timer = null;
    this._nextTime = 0;
    this._nextStep = 0;
    this.onEnd = null;
    this.loop = true;
    this.nSteps = 0;
    this.score = null;
    this.gains = { master: 0.8, plants: 1, pad: 1, bass: 1, hat: 1, glow: 1 };
    this.muted = { plants: false, pad: false, bass: false, hat: false, glow: false };
  }

  /**
   * Build the graph. Must be called from a user gesture -- browsers start an
   * AudioContext suspended and only a real click will resume it.
   */
  init() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;

    // Master chain. The limiter is not decoration: the score can put eight
    // struck voices, a pad, a bass and a hat on the same 111 ms step, and the
    // dense steps are exactly the interesting ones.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = this.gains.master;
    this.master.connect(this.limiter).connect(ctx.destination);

    // A short synthesised hall. Plant hits are sent to it, the pulse layers are
    // not, so the percussive layer sits in a space and the measurement layer
    // stays dry and close.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.0, 2.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.32;
    this.reverb.connect(this.reverbGain).connect(this.master);

    this.bus = {};
    for (const k of ['plants', 'pad', 'bass', 'hat', 'glow']) {
      const g = ctx.createGain();
      g.gain.value = this.gains[k];
      g.connect(this.master);
      this.bus[k] = g;
    }
    this.bus.plants.connect(this.reverb);
    this.bus.glow.connect(this.reverb);

    this.noiseBuf = this._noise(2.0);
    this.ready = true;
  }

  _noise(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  // ---- voices -----------------------------------------------------------
  _panned(bus, pan) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      p.connect(bus);
      return p;
    }
    const g = ctx.createGain();
    g.connect(bus);
    return g;
  }

  /** A struck note: inharmonic partials with an exponential tail. */
  strike(when, { voice, hz, velocity, pan = 0, count = 1 }) {
    const spec = VOICES[voice] || VOICES.glass;
    const ctx = this.ctx;
    // Velocity is measured (peak footprint sensitivity over the visit) and most
    // of it sits low, so a square-law curve here would make the median note
    // inaudible. A gentle curve keeps the quiet ones present and still leaves
    // the strong ones clearly on top.
    const amp = 0.06 + 0.5 * Math.pow(Math.max(0, Math.min(1, velocity)), 0.7);
    const dst = this._panned(this.bus.plants, pan);
    const decay = spec.decay * (0.8 + 0.4 * velocity);

    for (const [ratio, g] of spec.partials) {
      // Sites that share a coordinate ring as a thickened unison rather than
      // getting a marker each -- three plants sit on 120.25/29.27 and two on
      // 118.9/28.9, and the export already carries that count.
      for (let u = 0; u < Math.min(count, 3); u++) {
        const osc = ctx.createOscillator();
        osc.type = spec.type;
        osc.frequency.value = hz * ratio;
        if (u) osc.detune.value = (u === 1 ? 7 : -9);
        const env = ctx.createGain();
        const peak = amp * g * (u ? 0.45 : 1);
        env.gain.setValueAtTime(0.0001, when);
        env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.004);
        env.gain.exponentialRampToValueAtTime(0.0001, when + decay / (1 + ratio * 0.16));
        osc.connect(env).connect(dst);
        osc.start(when);
        osc.stop(when + decay + 0.05);
      }
    }

    if (spec.noise) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = spec.noiseHz;
      bp.Q.value = 1.2;
      const env = ctx.createGain();
      env.gain.setValueAtTime(amp * spec.noise, when);
      env.gain.exponentialRampToValueAtTime(0.0001, when + spec.noiseDecay);
      src.connect(bp).connect(env).connect(dst);
      src.start(when, Math.random() * 1.5);
      src.stop(when + spec.noiseDecay + 0.02);
    }
  }

  /** The measurement layer: a sustained, filtered pair held across one step. */
  pad(when, { hz, rank, gain = 1 }) {
    const ctx = this.ctx;
    const dur = this.stepSeconds;
    const env = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // Brightness carries the reading as much as pitch does, so a climb is
    // audible even when the quantised note has not moved a degree.
    lp.frequency.value = 320 + 3600 * Math.pow(rank, 1.4);
    lp.Q.value = 0.7;

    const peak = 0.1 * gain * (0.45 + 0.55 * rank);
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + dur * 0.25);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur * 1.6);

    for (const [type, det, g] of [['sawtooth', -6, 1], ['sawtooth', 6, 0.8], ['triangle', 0, 0.5]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz;
      osc.detune.value = det;
      const vg = ctx.createGain();
      vg.gain.value = g;
      osc.connect(vg).connect(lp);
      osc.start(when);
      osc.stop(when + dur * 1.7);
    }
    lp.connect(env).connect(this.bus.pad);
  }

  /** One note a day, on the bar line. */
  bass(when, { hz, gain = 1 }) {
    const ctx = this.ctx;
    const dur = this.stepSeconds * 8;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.22 * gain, when + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, when);
    lp.frequency.exponentialRampToValueAtTime(140, when + dur * 0.7);

    for (const [type, g] of [['triangle', 1], ['sine', 0.7]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz;
      const vg = ctx.createGain();
      vg.gain.value = g;
      osc.connect(vg).connect(lp);
      osc.start(when);
      osc.stop(when + dur + 0.05);
    }
    lp.connect(env).connect(this.bus.bass);
  }

  /** Land fraction: the only layer with no gaps, so it keeps time throughout. */
  hat(when, { norm, gain = 1, open = 0 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    // Clean marine air is thin and high; continental air opens downward and
    // gets some body.
    hp.frequency.value = 9000 - 4500 * norm;
    const dur = 0.018 + 0.09 * open;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.055 * gain * (0.4 + 0.6 * norm), when);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(hp).connect(env).connect(this.bus.hat);
    src.start(when, Math.random() * 1.5);
    src.stop(when + dur + 0.02);
  }

  /**
   * Plants still lit but not freshly arrived.
   *
   * One aggregated texture rather than a note per plant: 45% of steps have at
   * least one plant lit and the longest single visit runs five and a half days,
   * so voicing each one would drown the arrivals that carry the information.
   */
  glow(when, { count, mean, gain = 1 }) {
    const ctx = this.ctx;
    const dur = this.stepSeconds * 1.4;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 + 1500 * mean + 90 * Math.min(count, 12);
    bp.Q.value = 3.5;
    const env = ctx.createGain();
    const peak = 0.02 * gain * Math.min(1, 0.35 + 0.2 * count) * (0.5 + 0.5 * mean);
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(peak, when + dur * 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp).connect(env).connect(this.bus.glow);
    src.start(when, Math.random() * 1.5);
    src.stop(when + dur + 0.02);
  }

  // ---- one step ---------------------------------------------------------
  playStep(ev, when) {
    if (!ev) return;
    const m = this.muted;
    if (!m.plants) for (const p of ev.plants) this.strike(when, p);
    if (!m.glow && ev.glow) this.glow(when, ev.glow);
    if (!m.pad && ev.pad) this.pad(when, ev.pad);
    if (!m.bass && ev.bass) this.bass(when, ev.bass);
    if (!m.hat && ev.hat) this.hat(when, ev.hat);
  }

  /**
   * Audition a single step outside playback, for scrubbing.
   *
   * Builds the graph if it does not exist yet: a scrub is a click, so it is a
   * gesture the AudioContext will accept, and requiring Play first would make
   * the first drag of the timeline silent for no reason.
   */
  preview(ev) {
    if (!ev) return;
    this.init();
    this.playStep(ev, this.ctx.currentTime + 0.01);
  }

  // ---- transport --------------------------------------------------------
  attach(score) {
    this.score = score;
    this.nSteps = score.nSteps;
    this.stepSeconds = score.stepSeconds();
  }

  setTempo(bpm) {
    if (!this.score) return;
    this.score.opts.bpm = bpm;
    this.stepSeconds = this.score.stepSeconds();
  }

  setGain(name, v) {
    this.gains[name] = v;
    if (!this.ready) return;
    if (name === 'master') this.master.gain.value = v;
    else if (this.bus[name]) this.bus[name].gain.value = v;
  }

  start(fromStep = null) {
    this.init();
    if (this.playing) return;
    if (fromStep != null) this.step = fromStep;
    this.playing = true;
    this._nextStep = this.step;
    this._nextTime = this.ctx.currentTime + 0.08;
    this.queue.length = 0;
    this._timer = setInterval(() => this._schedule(), LOOKAHEAD_MS);
    this._schedule();
  }

  stop() {
    this.playing = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.queue.length = 0;
  }

  seek(step) {
    this.step = Math.max(0, Math.min(this.nSteps - 1, step | 0));
    if (this.playing) {
      this._nextStep = this.step;
      this._nextTime = this.ctx.currentTime + 0.05;
      this.queue.length = 0;
    }
  }

  _schedule() {
    if (!this.playing || !this.score) return;
    const ctx = this.ctx;
    while (this._nextTime < ctx.currentTime + SCHEDULE_AHEAD) {
      if (this._nextStep >= this.nSteps) {
        if (!this.loop) { this.stop(); if (this.onEnd) this.onEnd(); return; }
        this._nextStep = 0;
      }
      const ev = this.score.eventsAt(this._nextStep);
      this.playStep(ev, this._nextTime);
      this.queue.push({ step: this._nextStep, when: this._nextTime, ev });
      this._nextTime += this.stepSeconds;
      this._nextStep++;
    }
  }

  /**
   * Where the sound has actually got to, for the picture to follow.
   *
   * Drains everything the clock has passed and returns the most recent, so a
   * dropped animation frame catches up rather than falling progressively behind.
   */
  poll() {
    if (!this.ready) return null;
    const now = this.ctx.currentTime;
    let last = null;
    while (this.queue.length && this.queue[0].when <= now) last = this.queue.shift();
    if (last) this.step = last.step;
    return last;
  }
}
