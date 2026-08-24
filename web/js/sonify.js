/**
 * Turning a footprint archive into a score.
 *
 * Two independent things happen at every 2-hourly timestep, and the whole point
 * of hearing them rather than only seeing them is that they are independent:
 *
 *   the mole fraction measured at the inlet   -> a pitched, sustained layer
 *   which plants the footprint was sitting on -> struck, percussive hits
 *
 * The first is a measurement. The second is model geometry -- where the air had
 * just been. They are kept in separate timbral families and neither is ever
 * gated on the other, because the hours when a plant lights up and the reading
 * does *not* climb are as much of the result as the hours when it does. Over
 * this period they correlate at r = +0.50: real, and a long way from
 * deterministic. Anything that made them sound tighter than that would be
 * lying. See stats() -- the number is measured here, not asserted.
 *
 * This module is deliberately pure: no Web Audio, no DOM, no canvas. It turns a
 * loaded dataset into events and stops. That is what lets selftest.mjs run the
 * whole mapping headlessly, which matters because there is no browser
 * automation in this project and the alternative is trusting it by ear.
 */

const HOUR_MS = 3600000;

// ---- regions --------------------------------------------------------------
// The plant list is `number,lat,lon` and nothing else -- no country, no name,
// no capacity -- so a region has to be inferred from the coordinate. These are
// hand-drawn boxes, checked against all 42 exported points, and they are
// approximate by construction: they say "roughly this part of the map", not
// "this administrative area".
//
// Order matters and rule 3 is why. The four Sichuan plants sit at lat ~29.3,
// so a pure latitude cut would file them with Zhejiang, about 1500 km away.
// They are also west of the footprint grid's western edge, so they can never
// light up whatever the rules say -- but classifying them honestly keeps the
// list defensible rather than merely convenient.
export const REGION_RULES = [
  { id: 'JAPAN', test: (lon) => lon >= 131.0 },
  { id: 'KOREA', test: (lon, lat) => lon >= 128.0 && lat < 40.0 },
  { id: 'WEST', test: (lon) => lon < 105.5 },
  { id: 'NORTH', test: (lon, lat) => lat >= 35.0 },
  { id: 'CENTRAL', test: (lon, lat) => lat >= 30.0 },
  { id: 'SOUTH', test: () => true },
];

/**
 * Voice and register per region.
 *
 * `base` is the MIDI note the region's southernmost plant plays; `span` is how
 * many scale degrees the region's plants are spread across, so a region with
 * seventeen plants stays inside a usable register instead of climbing off the
 * top of the keyboard. `null` means the region is silent.
 *
 * NORTH/CENTRAL/SOUTH are stacked low to high, which makes the sweep of a plume
 * moving down the coast audible as a fall in pitch. KOREA and JAPAN are the
 * near-field pair -- Gosan is on Jeju, so the station sits almost among them and
 * they fire far more often than their three plants would suggest (10% and 6% of
 * all notes). They get their own struck timbres rather than a rare-event bell.
 */
export const REGION_VOICES = {
  NORTH: { voice: 'wood', base: 38, span: 7, label: 'N China · Shandong' },
  CENTRAL: { voice: 'tine', base: 50, span: 7, label: 'Yangtze · Jiangsu/Hubei' },
  SOUTH: { voice: 'glass', base: 62, span: 9, label: 'SE China · Zhejiang/Fujian' },
  KOREA: { voice: 'chime', base: 57, span: 1, label: 'Korea' },
  JAPAN: { voice: 'bell', base: 69, span: 2, label: 'Japan' },
  WEST: { voice: null, base: 0, span: 1, label: 'Sichuan (off-grid — never fires)' },
};

export const REGION_ORDER = ['NORTH', 'CENTRAL', 'SOUTH', 'KOREA', 'JAPAN', 'WEST'];

export function classifyRegion(lon, lat) {
  for (const r of REGION_RULES) if (r.test(lon, lat)) return r.id;
  return 'SOUTH';
}

// ---- scale ----------------------------------------------------------------
// Minor pentatonic, chosen for a reason that is about the data rather than
// taste: up to seventeen plants can fire on the same step, and the set of them
// is whatever the wind happened to do. A pentatonic has no interval that sours
// when an arbitrary subset sounds together, so a dense frame reads as a chord
// instead of a cluster. A diatonic scale would put a tritone in some of them.
export const PENTATONIC = [0, 3, 5, 7, 10];

export function degreeToMidi(base, degree) {
  const oct = Math.floor(degree / PENTATONIC.length);
  return base + oct * 12 + PENTATONIC[((degree % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length];
}

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---- cell resolution ------------------------------------------------------
/**
 * Footprint cell index for each [lon, lat], or -1 for points off the grid.
 *
 * This has to invert the raster's own mapping exactly. MapView._resolveCells
 * does the same arithmetic for the same reason, and the two must not drift:
 * a transposed or off-by-one mapping still renders and still plays, it just
 * lights and sounds the wrong plants, which is not something either the picture
 * or the music would give away. selftest.mjs asserts the two agree element for
 * element rather than trusting that they were written from the same formula.
 */
export function resolveCells(points, grid, W, H) {
  const out = new Int32Array(points.length).fill(-1);
  for (let i = 0; i < points.length; i++) {
    const [lon, lat] = points[i];
    const col = Math.floor(((lon - grid.lonMin) / (grid.lonMax - grid.lonMin)) * W);
    const row = Math.floor(((grid.latMax - lat) / (grid.latMax - grid.latMin)) * H);
    if (col >= 0 && col < W && row >= 0 && row < H) out[i] = row * W + col;
  }
  return out;
}

// ---- defaults -------------------------------------------------------------
// Every one of these is exposed as a slider in the sound lab. The values are
// where the calibration pass landed, not guesses -- see the notes on each.
export const DEFAULTS = {
  bpm: 135,           // one timestep = one sixteenth => 9 steps/sec, the map's own rate
  // Derived from the archive's own cadence unless overridden: one bar is one
  // day, which is 12 steps of the 2-hourly Gosan exports and 24 of hourly
  // Ridge Hill. Hard-coding 12 silently halves the day at any hourly site.
  stepsPerBar: null,
  velocityDecades: 1.0, // run-peak headroom above the lit threshold; measured max is 1.48
  padRoot: 50,        // D3
  padSpan: 11,        // scale degrees the enhancement percentile is spread across
  bassRoot: 26,       // D1
  bassSpan: 5,
  // Loose on purpose. Tight caps (3/8) threw away a fifth of all the notes, and
  // almost all of them came off the handful of steps where a plume sweeps the
  // whole coast at once -- the climaxes. Dense steps are rare enough that the
  // polyphony costs nothing, and a pentatonic in five separate registers reads
  // as a chord rather than a cluster. Both are sliders in the lab.
  maxVoicesPerRegion: 6,
  maxVoicesPerStep: 14,
  glowGain: 1,        // sustained-lit texture; 0 disables it
  hatGain: 1,
  padGain: 1,
  bassGain: 1,
  plantGain: 1,
  landFracFullScale: 0.5, // landFrac p90 is 0.40 and max 0.77; 1.0 would barely move
};

/**
 * The score.
 *
 * Construction walks the decoded atlas once and keeps three small arrays: the
 * per-plant uint8 through time, the lit flags, and the peak of each lit run.
 * That last one is the fix for a mistake worth recording. Velocity was going to
 * come from the footprint value at the moment a plant lights up -- but a rising
 * edge is *by definition* the step where the value crosses the threshold, so
 * every note would have arrived at almost exactly the same strength (measured:
 * uint8 86..134, mean 96, against a threshold of 86). Taking the peak over the
 * whole visit instead asks a better question -- how hard did the plume sit on
 * this plant while it was there -- and recovers the full 1.48 decades of
 * headroom the field actually has.
 */
export class Sonifier {
  constructor(data, opts = {}) {
    this.data = data;
    this.opts = { ...DEFAULTS, ...opts };
    const meta = data.meta;
    const f = meta.factories;

    // Optional all the way down. Ridge Hill has no plant list at all, and a
    // layer that assumes 42 plants would throw during setup -- which on this
    // page looks exactly like a slow download rather than like a crash.
    // One step is one sixteenth and one day is one bar, whatever the archive's
    // cadence happens to be.
    this.stepHours = meta.timeStepHours || 2;
    this.stepMs = this.stepHours * HOUR_MS;
    if (this.opts.stepsPerBar == null) {
      this.opts.stepsPerBar = Math.max(1, Math.round(24 / this.stepHours));
    }

    this.points = f && f.points ? f.points : [];
    this.hasPlants = this.points.length > 0;
    this.litCode = f && f.litCode ? f.litCode : Infinity;
    this.litLog10 = f && typeof f.litLog10 === 'number' ? f.litLog10 : 0;
    // Velocity is measured from the code that actually gates, not from the
    // log10 the export advertises alongside it. They agree in every shipped
    // export -- verify_export.py fails the build otherwise -- but if they ever
    // drifted apart the quiet failure is total: every note computes a negative
    // headroom, clamps to zero, and the whole plant layer goes silent while
    // still firing. Deriving the floor from litCode makes that unrepresentable.
    this.litFloorLog10 = Number.isFinite(this.litCode)
      ? Math.log10(data.toPhysical(this.litCode))
      : this.litLog10;
    this.cells = resolveCells(this.points, data.grid, data.width, data.height);
    this.regions = this.points.map(([lon, lat]) => classifyRegion(lon, lat));

    this.nTime = data.nTime;
    this.nPlants = this.points.length;

    this._buildTimeline();
    this._buildPlantIndex();
    this._buildPitches();
    this._buildPad();
  }

  // ---- timeline ---------------------------------------------------------
  /**
   * Absolute step index, and the row (if any) that occupies it.
   *
   * The exported series is not contiguous: three stretches of the archive are
   * missing outright -- 3 days from 28 June, and one day each from 16 and 24
   * July -- and those rows are simply absent rather than present-and-null. So
   * 1044 rows span 1104 two-hour slots. Indexing the music by array position
   * would silently splice five days out of the summer and leave the bar lines
   * drifting off midnight afterwards.
   *
   * Indexing by timestamp instead costs nothing and makes the missing days do
   * the right thing on their own: they become five empty bars.
   */
  _buildTimeline() {
    const t = this.data.series.timeMs;
    this.t0 = t[0];
    this.absOf = new Int32Array(this.nTime);
    for (let i = 0; i < this.nTime; i++) this.absOf[i] = Math.round((t[i] - this.t0) / this.stepMs);
    this.nSteps = this.absOf[this.nTime - 1] + 1;

    this.rowAt = new Int32Array(this.nSteps).fill(-1);
    for (let i = 0; i < this.nTime; i++) this.rowAt[this.absOf[i]] = i;

    this.uniformGrid = true;
    for (let i = 0; i < this.nTime; i++) {
      if (Math.abs(t[i] - (this.t0 + this.absOf[i] * this.stepMs)) > 1) this.uniformGrid = false;
    }
  }

  // ---- plants -----------------------------------------------------------
  _buildPlantIndex() {
    const n = this.nTime;
    const p = this.nPlants;
    this.codes = new Uint8Array(n * p);
    this.lit = new Uint8Array(n * p);
    this.edgePeak = new Uint8Array(n * p); // non-zero only on a rising edge

    if (!p) return;
    for (let t = 0; t < n; t++) {
      const frame = this.data.frame(t);
      const off = t * p;
      for (let i = 0; i < p; i++) {
        const cell = this.cells[i];
        const u = cell >= 0 ? frame[cell] : 0;
        this.codes[off + i] = u;
        this.lit[off + i] = u >= this.litCode ? 1 : 0;
      }
    }

    // Walk each plant's column, find the runs, hang the run's peak on its first
    // step. A plant lit for a 20-step stretch must fire once -- "the plume
    // arrived" -- or it machine-guns; the busiest plant here is lit on 230 of
    // 1044 steps and the longest single visit lasts 64 steps, five and a half
    // days.
    for (let i = 0; i < p; i++) {
      let t = 0;
      while (t < n) {
        if (!this.lit[t * p + i]) { t++; continue; }
        const start = t;
        let peak = 0;
        while (t < n && this.lit[t * p + i]) {
          const u = this.codes[t * p + i];
          if (u > peak) peak = u;
          t++;
        }
        this.edgePeak[start * p + i] = peak;
      }
    }
  }

  /** uint8 code -> 0..1 velocity, measured against the lit threshold. */
  velocityOf(u) {
    if (!u) return 0;
    const phys = this.data.toPhysical(u);
    if (!(phys > 0)) return 0;
    const v = (Math.log10(phys) - this.litFloorLog10) / this.opts.velocityDecades;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // ---- pitch ------------------------------------------------------------
  /**
   * One MIDI note per plant: region picks the register and the timbre,
   * latitude picks the degree within it.
   *
   * `points` arrives sorted latitude-descending, so the ordering is already
   * there for free. Spreading each region across its own `span` rather than
   * across a shared scale is what stops SOUTH -- seventeen of the thirty-eight
   * audible plants, packed into four degrees of latitude -- from either
   * flattening into a unison or climbing three octaves.
   */
  _buildPitches() {
    this.midi = new Float64Array(this.nPlants);
    this.pan = new Float64Array(this.nPlants);
    this.degree = new Int32Array(this.nPlants);

    const view = this.data.meta.view;
    const byRegion = {};
    for (let i = 0; i < this.nPlants; i++) {
      (byRegion[this.regions[i]] ||= []).push(i);
    }

    for (const [region, idx] of Object.entries(byRegion)) {
      const v = REGION_VOICES[region] || REGION_VOICES.SOUTH;
      const lats = idx.map((i) => this.points[i][1]);
      const lo = Math.min(...lats);
      const hi = Math.max(...lats);
      for (const i of idx) {
        const lat = this.points[i][1];
        // South of the region -> degree 0, north -> the top of its span.
        const f = hi > lo ? (lat - lo) / (hi - lo) : 0;
        const d = Math.round(f * (v.span - 1));
        this.degree[i] = d;
        this.midi[i] = degreeToMidi(v.base, d);
      }
    }

    for (let i = 0; i < this.nPlants; i++) {
      const lon = this.points[i][0];
      const f = (lon - view.lonMin) / (view.lonMax - view.lonMin);
      this.pan[i] = Math.max(-1, Math.min(1, f * 2 - 1));
    }
  }

  // ---- concentration ----------------------------------------------------
  /**
   * Enhancement, ranked rather than scaled.
   *
   * HFC-23 above its baseline runs -1.1 to +42.6 ppt, but 47% of the observed
   * slots sit within 1 ppt of baseline and the median is +1.1. Mapped linearly,
   * two thirds of the summer would be inaudible and the whole range would be
   * spent on a handful of spikes. Percentile rank spends the register where the
   * data actually is, and the spikes still come out on top because rank is
   * monotone. Nulls stay null -- 341 of them, a third of the record.
   */
  _buildPad() {
    const cur = this.data.current;
    const obs = cur && cur.obs ? cur.obs : null;
    const base = cur && typeof cur.baseline === 'number' ? cur.baseline : 0;
    this.enh = new Float64Array(this.nTime).fill(NaN);
    this.rank = new Float64Array(this.nTime).fill(NaN);
    this.hasObs = !!obs;
    if (!obs) return;

    for (let i = 0; i < this.nTime; i++) {
      const v = obs[i];
      if (v != null && Number.isFinite(v)) this.enh[i] = v - base;
    }
    const idx = [];
    for (let i = 0; i < this.nTime; i++) if (!Number.isNaN(this.enh[i])) idx.push(i);
    idx.sort((a, b) => this.enh[a] - this.enh[b]);
    const m = idx.length;
    for (let k = 0; k < m; k++) this.rank[idx[k]] = m > 1 ? k / (m - 1) : 0.5;
  }

  /**
   * Retune in place.
   *
   * Only the cheap derived tables depend on the options -- the plant index is a
   * property of the atlas and the threshold, so retuning never re-walks it.
   * That is what lets the lab's sliders be live rather than a reload.
   */
  setOpts(patch) {
    Object.assign(this.opts, patch);
    this._buildPitches();
    this._buildPad();
    return this;
  }

  // ---- the score --------------------------------------------------------
  /**
   * Everything that sounds at absolute step `step`.
   *
   * Returns `null` only for a step outside the piece. A step that the archive
   * is missing returns a populated object with nothing in it -- a real rest,
   * carrying its bar and beat, so the scheduler keeps counting through it.
   */
  eventsAt(step) {
    if (step < 0 || step >= this.nSteps) return null;
    const o = this.opts;
    const bar = Math.floor(step / o.stepsPerBar);
    const beat = step % o.stepsPerBar;
    const row = this.rowAt[step];

    const out = { step, bar, beat, row, missing: row < 0, plants: [], pad: null, bass: null, hat: null, glow: null };
    if (row < 0) return out;

    // -- plants: rising edges only ---------------------------------------
    if (this.hasPlants) {
      const off = row * this.nPlants;
      const perRegion = {};
      const cand = [];
      for (let i = 0; i < this.nPlants; i++) {
        const peak = this.edgePeak[off + i];
        if (!peak) continue;
        const region = this.regions[i];
        const v = REGION_VOICES[region];
        if (!v || !v.voice) continue; // WEST is silent, and cannot fire anyway
        cand.push({
          plant: i,
          region,
          voice: v.voice,
          midi: this.midi[i],
          hz: midiToHz(this.midi[i]),
          pan: this.pan[i],
          velocity: this.velocityOf(peak),
          count: this.points[i][2] || 1,
          peak,
        });
      }
      // Loudest first, then capped -- per region so one dense cluster cannot
      // crowd out a lone plant somewhere else on the map, then globally so the
      // rare seventeen-at-once step stays a chord rather than a wall. Measured:
      // this engages on about 1% of steps.
      cand.sort((a, b) => b.velocity - a.velocity);
      for (const c of cand) {
        const n = (perRegion[c.region] || 0);
        if (n >= o.maxVoicesPerRegion) continue;
        if (out.plants.length >= o.maxVoicesPerStep) break;
        perRegion[c.region] = n + 1;
        out.plants.push(c);
      }
      out.plantsDropped = cand.length - out.plants.length;

      // -- glow: still lit, but not a fresh arrival ----------------------
      // Without this a five-day visit is one hit and then nothing. Aggregated
      // into a single texture event rather than a note per plant, because 1.4
      // plants are lit on an average step and 45% of steps have at least one.
      let nLit = 0;
      let sum = 0;
      for (let i = 0; i < this.nPlants; i++) {
        if (!this.lit[off + i]) continue;
        const v = REGION_VOICES[this.regions[i]];
        if (!v || !v.voice) continue;
        nLit++;
        sum += this.velocityOf(this.codes[off + i]);
      }
      if (nLit) out.glow = { count: nLit, mean: sum / nLit, gain: o.glowGain };
    }

    // -- pad and bass: the measurement ------------------------------------
    // Silent where the record is silent. Interpolating across a gap would
    // invent a measurement, and the chart already refuses to do it -- the line
    // breaks across nulls rather than bridging them.
    const r = this.rank[row];
    if (!Number.isNaN(r)) {
      const d = Math.round(r * (o.padSpan - 1));
      out.pad = {
        rank: r,
        enh: this.enh[row],
        midi: degreeToMidi(o.padRoot, d),
        hz: midiToHz(degreeToMidi(o.padRoot, d)),
        gain: o.padGain,
      };
    }

    if (beat === 0) {
      // One bass note a day, from the day's mean rank -- harmonic motion at the
      // scale the bar lines already mark.
      let sum = 0;
      let n = 0;
      for (let s = step; s < Math.min(this.nSteps, step + o.stepsPerBar); s++) {
        const rr = this.rowAt[s];
        if (rr >= 0 && !Number.isNaN(this.rank[rr])) { sum += this.rank[rr]; n++; }
      }
      if (n) {
        const d = Math.round((sum / n) * (o.bassSpan - 1));
        out.bass = { rank: sum / n, midi: degreeToMidi(o.bassRoot, d), hz: midiToHz(degreeToMidi(o.bassRoot, d)), gain: o.bassGain, nObs: n };
      }
    }

    // -- hats: how continental the air is ---------------------------------
    // The only layer with no gaps in it, so it is what keeps time through the
    // month-long stretches where the instrument was down.
    const lf = this.data.series.landFrac ? this.data.series.landFrac[row] : null;
    if (lf != null && Number.isFinite(lf)) {
      const norm = Math.min(1, lf / o.landFracFullScale);
      const onBeat = beat % 3 === 0;
      // Marine air ticks only on the beat; continental air fills in between.
      if (onBeat || norm > 0.45) {
        out.hat = { land: lf, norm, gain: o.hatGain * (onBeat ? 1 : 0.55), open: norm };
      }
    }

    return out;
  }

  /** Wall-clock seconds per step, from the tempo. */
  stepSeconds() {
    return 60 / (this.opts.bpm * 4);
  }

  timeAt(step) {
    return new Date(this.t0 + step * this.stepMs);
  }

  // ---- measurement ------------------------------------------------------
  /**
   * What the score actually came out as.
   *
   * There is precedent for measuring rather than asserting here:
   * verify_export.py already fails the build if the lit threshold fires on 0%
   * or more than 90% of frames, because a threshold that silently never fires
   * is the main risk in this whole feature. The same applies to a note density
   * of zero, and to the claim the piece is making -- so the correlation between
   * the two layers is computed rather than described.
   */
  stats() {
    const o = this.opts;
    const hist = [];
    let notes = 0;
    let stepsWithNotes = 0;
    let dropped = 0;
    let maxPerStep = 0;
    let notesInGaps = 0;
    let silentBars = 0;
    const byRegion = {};
    for (const k of REGION_ORDER) byRegion[k] = 0;

    for (let s = 0; s < this.nSteps; s++) {
      const e = this.eventsAt(s);
      const k = e.plants.length;
      hist[k] = (hist[k] || 0) + 1;
      notes += k;
      dropped += e.plantsDropped || 0;
      if (k) stepsWithNotes++;
      if (k > maxPerStep) maxPerStep = k;
      for (const p of e.plants) byRegion[p.region]++;
      if (k && !e.pad) notesInGaps += k;
    }
    for (let b = 0; b * o.stepsPerBar < this.nSteps; b++) {
      let any = false;
      for (let s = b * o.stepsPerBar; s < Math.min(this.nSteps, (b + 1) * o.stepsPerBar); s++) {
        if (this.rowAt[s] >= 0) { any = true; break; }
      }
      if (!any) silentBars++;
    }

    return {
      nSteps: this.nSteps,
      nRows: this.nTime,
      missingSteps: this.nSteps - this.nTime,
      bars: Math.ceil(this.nSteps / o.stepsPerBar),
      silentBars,
      durationSec: this.nSteps * this.stepSeconds(),
      notes,
      notesPerStep: notes / this.nSteps,
      stepsWithNotes,
      stepsWithNotesFrac: stepsWithNotes / this.nSteps,
      maxPerStep,
      dropped,
      hist,
      byRegion,
      notesInGaps,
      nObs: this.rank.reduce((a, v) => a + (Number.isNaN(v) ? 0 : 1), 0),
      correlation: this.correlation(),
      uniformGrid: this.uniformGrid,
    };
  }

  /**
   * r between the enhancement and how many plants were lit, over the observed
   * steps only. This is the number the piece is built on: the user's intuition
   * that the pings land near the peaks is right, and this says by how much.
   */
  correlation() {
    if (!this.hasPlants || !this.hasObs) return NaN;
    const xs = [];
    const ys = [];
    for (let t = 0; t < this.nTime; t++) {
      if (Number.isNaN(this.enh[t])) continue;
      let n = 0;
      const off = t * this.nPlants;
      for (let i = 0; i < this.nPlants; i++) if (this.lit[off + i]) n++;
      xs.push(this.enh[t]);
      ys.push(n);
    }
    const n = xs.length;
    if (n < 2) return NaN;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx;
      const dy = ys[i] - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    const d = Math.sqrt(sxx * syy);
    return d ? sxy / d : NaN;
  }

  /** Plants grouped by region, for the lab's legend. */
  regionSummary() {
    const out = [];
    for (const id of REGION_ORDER) {
      const idx = [];
      for (let i = 0; i < this.nPlants; i++) if (this.regions[i] === id) idx.push(i);
      if (!idx.length) continue;
      out.push({
        id,
        ...REGION_VOICES[id],
        n: idx.length,
        onGrid: idx.filter((i) => this.cells[i] >= 0).length,
        midi: idx.map((i) => this.midi[i]).sort((a, b) => a - b),
      });
    }
    return out;
  }
}
