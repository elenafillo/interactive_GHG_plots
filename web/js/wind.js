/**
 * The wind field.
 *
 * `scripts/export_web_data.py` ships the 100 m wind as two single-channel PNG
 * atlases -- `wind_u.png` and `wind_v.png`, eastward and northward m/s -- packed
 * exactly like the footprint atlas and decoded by the same `decodeAtlas`. This
 * module is the other half of that contract: it turns the two `Uint8Array`s back
 * into a field you can ask for a vector at any lon/lat and any moment.
 *
 * Everything it needs is in `meta.wind`. Nothing here re-derives a grid from a
 * filename or a cadence from a timestamp, because the two halves disagreeing
 * about either would produce a picture that is wrong rather than absent -- air
 * blowing confidently in the wrong direction looks exactly as convincing as air
 * blowing in the right one.
 *
 * Three things about the encoding are easy to get wrong and expensive to get
 * wrong, so they are stated once here and asserted in `story/selftest.mjs`:
 *
 *   - **`0` is missing, not `-uvMax`.** Codes run `1..255` over
 *     `[-uvMax, +uvMax]` and `0` is reserved. It never appears inside a tile the
 *     export actually wrote, but it is what an out-of-range read finds, and
 *     decoding it naively returns a confident 40 m/s gale.
 *   - **Row 0 is north.** The flip is applied at export, same as the footprint,
 *     so the row index counts down from `latMax`.
 *   - **The wind is 3-hourly and the deck is hourly.** `frameStride` is 3: wind
 *     step *k* covers footprint frames `[3k, 3k+3)`, and everything in between
 *     is interpolated. The record ends at 29 Feb 21:00 while the footprints run
 *     to 23:00, so the last two footprint frames have no step after them and
 *     clamp to the final one.
 *
 * Grid bounds in `meta.wind.grid` are cell **edges**, as they are everywhere
 * else in this pipeline, so a cell centre sits half a cell in from the edge.
 * That half-cell is the difference between the wind and the footprint being
 * registered and being one cell apart, which at 0.35 deg is ~24 km of lie.
 */

import { windColour, parcelColour, WIND_SATURATE_MS } from './palette.js';
import {
  AdvectedParcels, trailPoint, buildFan, kmBetween, degPerSec,
} from './advect.js';

/**
 * One uint8 code back to m/s. `NaN` for missing -- callers must not treat it as
 * a value, which is the whole reason it is not simply `-uvMax`.
 *
 * Written as `-uvMax + (code-1)/254 * 2*uvMax` rather than in a precomputed
 * offset-and-scale form so the two ends land on exactly `∓uvMax` in floating
 * point: `(255-1)/254` is exactly 1, where `254 * (2*uvMax/254)` is not exactly
 * `2*uvMax`.
 */
export function decodeWind(code, uvMax) {
  return code === 0 ? NaN : -uvMax + ((code - 1) / 254) * 2 * uvMax;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Reused by speed(), which throws its vector away. */
const scratch = { u: 0, v: 0 };

/**
 * Samples the exported wind atlases.
 *
 * @param {object} meta       `meta.wind` from the export, unmodified
 * @param {Uint8Array} u      eastward codes, `nTime * nx * ny`, row 0 north
 * @param {Uint8Array} v      northward codes, same shape
 */
export class WindField {
  constructor(meta, u, v) {
    const { grid, atlas } = meta;

    // The atlas tile is the memory layout and the grid is the geography. They
    // are the same numbers today and a re-export could quietly make them differ
    // -- widening `view` without re-slicing the met, say -- at which point every
    // sample would be read from the wrong offset with no other symptom.
    if (atlas.tileW !== grid.nx || atlas.tileH !== grid.ny) {
      throw new Error(
        `wind atlas tiles ${atlas.tileW}x${atlas.tileH} do not match grid ${grid.nx}x${grid.ny}`,
      );
    }
    const cells = grid.nx * grid.ny;
    if (u.length < meta.nTime * cells || v.length < meta.nTime * cells) {
      throw new Error(
        `wind atlas decoded short: ${u.length}/${v.length} for ${meta.nTime} x ${cells}`,
      );
    }

    this.meta = meta;
    this.u = u;
    this.v = v;

    this.nx = grid.nx;
    this.ny = grid.ny;
    this.cells = cells;
    this.lonMin = grid.lonMin;
    this.lonMax = grid.lonMax;
    this.latMin = grid.latMin;
    this.latMax = grid.latMax;
    this.dLon = (grid.lonMax - grid.lonMin) / grid.nx;
    this.dLat = (grid.latMax - grid.latMin) / grid.ny;

    this.uvMax = meta.uvMax;
    this.nTime = meta.nTime;
    this.frameStride = meta.frameStride;
    this.framesCovered = meta.framesCovered;
    this.levelLabel = meta.levelLabel || '';
  }

  /**
   * Footprint frame -- fractional is fine -- to a position on the wind time
   * axis. The clamp at the top is what covers footprint frames 694 and 695,
   * which have no wind step after them.
   */
  windFrame(t) {
    return clamp(t / this.frameStride, 0, this.nTime - 1);
  }

  /** Is this point on the wind grid at all? Used by the parcels' edge fade. */
  inside(lon, lat) {
    return lon >= this.lonMin && lon <= this.lonMax
      && lat >= this.latMin && lat <= this.latMax;
  }

  /**
   * The vector at a moment and a place, in m/s.
   *
   * Writes into `out` and returns it, or returns `null` where there is no data,
   * so the hot path in `advect.js` can hand in one scratch object rather than
   * allocating per parcel per substep. `null` and not `{u:0,v:0}`: still air and
   * absent air have to stay distinguishable.
   *
   * @param {number} t     footprint frame, fractional allowed
   * @param {number} lon
   * @param {number} lat
   * @param {{u:number,v:number}} [out]
   */
  sample(t, lon, lat, out = { u: 0, v: 0 }) {
    if (!Number.isFinite(t) || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;

    const w = this.windFrame(t);
    const k0 = Math.floor(w);
    const k1 = k0 + 1 < this.nTime ? k0 + 1 : this.nTime - 1;
    const tk = w - k0;

    // Edges to centres: cell j is centred half a cell in from `lonMin`, and the
    // latitude axis counts *down* from `latMax` because row 0 is north.
    const fx = clamp((lon - this.lonMin) / this.dLon - 0.5, 0, this.nx - 1);
    const fy = clamp((this.latMax - lat) / this.dLat - 0.5, 0, this.ny - 1);

    const su = this._attime(this.u, k0, k1, tk, fx, fy);
    const sv = this._attime(this.v, k0, k1, tk, fx, fy);
    if (Number.isNaN(su) || Number.isNaN(sv)) return null;

    out.u = su;
    out.v = sv;
    return out;
  }

  /** Wind speed in m/s, or `NaN` where there is no data. */
  speed(t, lon, lat) {
    const s = this.sample(t, lon, lat, scratch);
    return s ? Math.hypot(s.u, s.v) : NaN;
  }

  /**
   * Linear in time between two wind steps.
   *
   * `tk === 0` returns the first step untouched rather than lerping against
   * itself, so a footprint frame that lands exactly on a wind step -- frame 36
   * on step 12, the deck's clean day -- reads that step exactly.
   */
  _attime(arr, k0, k1, tk, fx, fy) {
    const a = this._bilinear(arr, k0, fx, fy);
    if (tk === 0 || k1 === k0) return a;
    const b = this._bilinear(arr, k1, fx, fy);
    // Missing does not occur inside a written tile, so these two are belt and
    // braces: one end of the interval absent is still better than nothing.
    if (Number.isNaN(a)) return b;
    if (Number.isNaN(b)) return a;
    return a + (b - a) * tk;
  }

  /**
   * Bilinear over one wind step, with missing cells dropped from the weighted
   * mean rather than decoded. Callers pass indices already clamped into range,
   * which is what makes sampling off the edge return the edge rather than wrap.
   */
  _bilinear(arr, k, fx, fy) {
    const { nx, ny, uvMax } = this;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = x0 + 1 < nx ? x0 + 1 : nx - 1;
    const y1 = y0 + 1 < ny ? y0 + 1 : ny - 1;
    const tx = fx - x0;
    const ty = fy - y0;

    const r0 = k * this.cells + y0 * nx;
    const r1 = k * this.cells + y1 * nx;
    const c00 = arr[r0 + x0];
    const c10 = arr[r0 + x1];
    const c01 = arr[r1 + x0];
    const c11 = arr[r1 + x1];

    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;

    let sum = 0;
    let wsum = 0;
    if (c00 && w00 > 0) { sum += w00 * decodeWind(c00, uvMax); wsum += w00; }
    if (c10 && w10 > 0) { sum += w10 * decodeWind(c10, uvMax); wsum += w10; }
    if (c01 && w01 > 0) { sum += w01 * decodeWind(c01, uvMax); wsum += w01; }
    if (c11 && w11 > 0) { sum += w11 * decodeWind(c11, uvMax); wsum += w11; }
    return wsum > 0 ? sum / wsum : NaN;
  }
}

/**
 * How fast the weather runs, in simulated hours per wall-clock second.
 *
 * The one number that decides whether the layer reads as weather or as a
 * screensaver. At the deck's wide framings a 10 m/s wind covers about 19 px of
 * screen per simulated hour, so this puts an ordinary parcel at roughly 45 px/s
 * -- fast enough to be obviously moving from the back of a room, slow enough to
 * follow one dot with your eye.
 *
 * **Ambient tracers and a released cohort share it.** They have to: two
 * populations of the same mark drifting at different screen speeds in the same
 * frame looks like a bug, not like two ideas.
 */
export const HOURS_PER_SEC = 2.4;

/**
 * Screen pitch the ambient population is sized from, in CSS px.
 *
 * Density is the knob that got the arrow lattice killed, so it is worth being
 * explicit about the difference. A *static* arrow at 56 px was still too busy:
 * the eye has to read every mark to get anything, so more marks is more work.
 * A *moving* tracer is read collectively -- the flow is the percept and the
 * individual dot is not -- so it tolerates, and wants, more of them. `W` on the
 * slide cycles this live, which is the only honest way to settle it: it depends
 * on the room and the projector.
 *
 * **56 px, on the user's call after seeing it -- 78, then 71, now this.** Count
 * goes as the inverse square of the pitch, so each step of that ladder is a
 * little over half as much air again: ~236 tracers on a 1600x900 deck at 78,
 * ~285 at 71, **~459 at 56**. The red air got much sparser in the same pass,
 * which is part of why the teal can afford to thicken: the two populations are
 * judged against each other, not in isolation.
 */
export const AMBIENT_PITCH_PX = 56;

/** The pitches `W` walks, coarsest first. Same ratios, shifted with the default. */
export const AMBIENT_PITCHES = [78, 56, 40];

const TAU = Math.PI * 2;

/** Seconds the paint front takes to walk the fan out from the mast to its far ends. */
export const BACK_REVEAL_SEC = 7;

/**
 * How much history a stream parcel's tail shows, in simulated hours.
 *
 * Short on purpose. The cohort this replaced carried its whole journey in its
 * trail, because the trail *was* the evidence -- a day of track drawn behind
 * each mark. The painted fan does that job now, and does it better, which frees
 * the mark to be what it is good at: a moving thing with a direction and a
 * speed. Long tails on a stream also read as clutter rather than as air,
 * because there are always some of them everywhere.
 */
export const STREAM_TRAIL_HOURS = 3;

/**
 * How red the map has to be, as drawn opacity, for air to be shown there.
 *
 * ---
 *
 * **This is a hard gate, and the measurement is why.** Decoded from the shipped
 * atlases (`node scripts/measure_seeding.mjs`), the drawn opacity along the clean
 * day's fan is bimodal: p10 0.00, median 0.00, p90 0.89. A track is either
 * firmly inside the red patch or firmly outside it, with almost nothing in
 * between -- so a soft weighting buys nothing a threshold does not, and the
 * threshold is insensitive to where it is put. **Half the fan's track length is
 * outside**: 50.4% inside at 0.15, 49.1% at 0.35, 46.2% at 0.55. That half is
 * what the user saw as parcels "really off in the clean footprint", and no
 * amount of reweighting removes it -- only refusing to draw it does.
 *
 * The share inside is also flat with distance -- 60% in the first two hours,
 * then 31-40% all the way out to 24 h -- so gating does not collapse the stream
 * into the near field. Air still starts throughout the plume; it just does not
 * start where the map says there is nothing.
 *
 * The dirty day is the opposite case and needs no gate at all: 99.9% of its
 * track length is inside its (much larger) patch.
 */
export const PLUME_GATE = 0.35;

/**
 * Simulated hours a parcel takes to fade once it has left the red.
 *
 * Short, because the point is that it goes *before* it leaves -- air outside
 * the patch is air the deck is claiming the mast cannot smell. Long enough that
 * it dissolves rather than blinking out, which reads as a rendering fault.
 */
const CULL_FADE_HOURS = 0.5;

/** How many stream parcels, as multiples of the release's own count. `E` cycles it. */
export const STREAM_SCALES = [0.6, 1, 1.6];

/**
 * The lon/lat box a camera framing shows, without needing a `MapView` to draw
 * first.
 *
 * The layer learns its seed region from the map on every frame, which is right
 * while a slide is up and **wrong at the moment a slide opens**: the ambient
 * population is reset inside `setStop`, one tick before any frame has been drawn
 * at the new camera, so it would seed itself against the *previous* act's
 * framing. Stepping from the UK view into the Atlantic one seeded a span-15 box
 * at lon -3, lat 54 into a span-27 frame at lon -10, lat 50 -- a square of air
 * in the top right of an otherwise empty map, which is exactly what it looked
 * like. So the deck hands the target framing in, and this is what turns a camera
 * into one.
 *
 * `span` is degrees of longitude across the canvas *width*, and `y()` uses the
 * same px/deg, so the latitude half-span is the aspect ratio times the
 * longitude one. Clipped to the field, because seeding outside the data buys
 * nothing: those parcels find no wind and respawn immediately.
 */
export function viewFromCamera(cam, w, h, field = null) {
  const halfLon = cam.span / 2;
  const halfLat = (h / Math.max(1, w)) * halfLon;
  const v = {
    lonMin: cam.lon - halfLon, lonMax: cam.lon + halfLon,
    latMin: cam.lat - halfLat, latMax: cam.lat + halfLat,
  };
  if (!field) return v;
  return {
    lonMin: Math.max(field.lonMin, v.lonMin),
    lonMax: Math.min(field.lonMax, v.lonMax),
    latMin: Math.max(field.latMin, v.latMin),
    latMax: Math.min(field.latMax, v.latMax),
  };
}

/**
 * How far upwind of the frame the ambient air is seeded, as a fraction of the
 * frame, and how much extra population that is allowed to buy.
 *
 * Seeding uniformly across the visible frame is not a uniform *steady state*
 * under advection. Every tracer enters the population where it respawns and
 * then drifts downwind for a lifetime, so density ramps up from nothing at the
 * upwind edge to full a lifetime's travel downwind of it -- on the Atlantic
 * framing, 12 h at 11 m/s is ~475 km, which is a quarter of the frame thin on
 * the left. Real air would advect in from off screen; here nothing did.
 *
 * Extending the seed box upwind by exactly one lifetime of travel makes the
 * visible density uniform, and the count is scaled by the area so the frame
 * keeps the tracers it had. Both are capped: a gale must not be able to seed a
 * region that dwarfs the frame, or spend the whole population outside it.
 *
 * ⚠ **The extension is clipped to the data, and on the Atlantic framing the
 * data runs out first** -- the frame's west edge sits 1.36 deg inside the crop,
 * against the ~7 deg a 12 h lifetime wants. So that act keeps a residual thin
 * band on the left that this cannot reach. The remaining levers are a shorter
 * ambient life (the ramp is life x speed) or spawning a share of the population
 * on the inflow edge itself; neither is worth building until the fix above has
 * been seen on screen.
 */
const SEED_UPWIND_MAX = 0.5;
const SEED_COUNT_MAX = 1.5;

/** Supersampling on the accumulation buffer, as a multiple of the footprint grid. */
const PAINT_SCALE = 4;

/** What the painted tracks drop to once the real plume is up over them. */
const PAINT_HOLD_ALPHA = 0.5;

/**
 * What the backwards parcels leave behind.
 *
 * ⚠ **Nothing in the shipped deck asks for this.** On screen an accumulating
 * buffer under the plume read as a second map competing with the real one, and
 * the moving parcels were already saying what it said, so every stop dropped
 * its `paint` key -- see the third stop of `clean-wind` in `beats.js`. The
 * machinery is kept, and kept exercised by the suite, because it is one word on
 * a stop to bring back and it was measured to be registered with the footprint
 * raster by construction.
 *
 * An offscreen canvas on the **footprint grid's own extent**, not on the screen.
 * That matters: painting in screen space would smear the accumulated tracks the
 * moment the camera moved, and would have to be thrown away and rebuilt on every
 * resize. On the grid it composites through exactly the rectangle the footprint
 * raster uses, so the painted air and the real plume are registered by
 * construction rather than by agreement.
 *
 * ---
 *
 * ⚠ **This illustrates the plume; it does not compute it.** Measured against the
 * patch the audience sees, a plume-seeded cohort's tracks cover ~41% of the
 * clean day's drawn footprint. The real thing is thirty days of turbulent
 * mixing through a boundary layer, and this is one level of wind carrying a few
 * dozen parcels for a day. The captions have to say "where this air has been",
 * never "this is how we work it out" -- the second would be a claim the picture
 * cannot support, in a deck whose whole argument is about not assuming.
 */
export class PlumeCanvas {
  constructor(grid, scale = PAINT_SCALE) {
    this.grid = grid;
    this.w = Math.max(1, Math.round(grid.nx * scale));
    this.h = Math.max(1, Math.round(grid.ny * scale));
    this.cv = null;
    this.cx = null;
    // Lazily, and never fatally: `WindLayer` is constructed in the headless
    // suite where there is no document, and a deck that will not start because
    // it could not make a scratch canvas is a worse failure than one that
    // simply does not paint.
    try {
      const cv = document.createElement('canvas');
      cv.width = this.w;
      cv.height = this.h;
      this.cv = cv;
      this.cx = cv.getContext('2d');
      if (this.cx) {
        this.cx.lineCap = 'round';
        this.cx.lineJoin = 'round';
      }
    } catch { /* no DOM: the layer degrades to tracers without paint */ }
  }

  get ok() { return !!this.cx; }

  x(lon) { return ((lon - this.grid.lonMin) / (this.grid.lonMax - this.grid.lonMin)) * this.w; }

  y(lat) { return ((this.grid.latMax - lat) / (this.grid.latMax - this.grid.latMin)) * this.h; }

  clear() {
    if (this.cx) this.cx.clearRect(0, 0, this.w, this.h);
    return this;
  }

  /**
   * Lay one segment of track down.
   *
   * Stamped once as the reveal passes over it rather than redrawn every frame:
   * the buffer is the memory, so a segment already painted costs nothing to keep
   * and repainting it would darken the early part of every track.
   */
  stamp(lon1, lat1, lon2, lat2, { colour, width = 5, alpha = 0.16 }) {
    const cx = this.cx;
    if (!cx) return;
    cx.globalAlpha = alpha;
    cx.strokeStyle = colour;
    cx.lineWidth = width;
    cx.beginPath();
    cx.moveTo(this.x(lon1), this.y(lat1));
    cx.lineTo(this.x(lon2), this.y(lat2));
    cx.stroke();
  }

  /** Composite onto the map, through the footprint's own rectangle. */
  drawTo(cx, map, alpha) {
    if (!this.cv || !(alpha > 0)) return;
    const x0 = map.x(this.grid.lonMin);
    const x1 = map.x(this.grid.lonMax);
    const y0 = map.y(this.grid.latMax);
    const y1 = map.y(this.grid.latMin);
    cx.save();
    cx.globalAlpha = alpha;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(this.cv, x0, y0, x1 - x0, y1 - y0);
    cx.restore();
  }
}

/**
 * The wind, drawn as air that moves.
 *
 * Rendered through `MapView.draw(extra)`, which needs no change to `MapView`.
 *
 * Two populations of one mark:
 *
 *   - **ambient** -- seeded across whatever the camera is showing, recycled
 *     forever, drifting through the field held at the slide's own hour. This is
 *     "the air, everywhere", and it is what makes a held slide alive instead of
 *     frozen.
 *   - **a journey** -- present only on a stop that names a release. A cohort
 *     leaves a box some hours before the anchor and is carried forward through
 *     the *real, evolving* field to the anchor hour, trailing its track behind
 *     it. This is "*this* air, the bit we are following".
 *
 * They are deliberately the same mark at different weights rather than two
 * different marks, because the two ideas land one slide apart: "today the wind
 * comes off the Atlantic", then "this air has crossed nothing but sea". An
 * audience shown a moving dot on one slide must not have to unlearn what a
 * moving dot means on the next. Nothing is unlearned here -- the second slide
 * just picks one body of air out of the same moving field and follows it.
 *
 * **The field time is shared too.** During a journey the whole picture, ambient
 * included, runs from the release hour up to the anchor and comes to rest
 * there. Holding the ambient at the anchor while the cohort travelled through
 * the past would have the two populations disagreeing about the weather in the
 * same frame.
 */
export class WindLayer {
  /**
   * @param {WindField} field
   * @param {object} [opts]
   * @param {number} [opts.pitch]        ambient density, as a screen pitch in px
   * @param {number} [opts.hoursPerSec]  how fast simulated time runs
   * @param {number} [opts.saturateAt]   m/s at which the colour tops out
   * @param {number} [opts.fadeDeg]      fade this far inside the data edge
   */
  constructor(field, {
    pitch = AMBIENT_PITCH_PX,
    hoursPerSec = HOURS_PER_SEC,
    saturateAt = WIND_SATURATE_MS,
    fadeDeg = 1.2,
    ambientLifeHours = 12,
    ambientTrailHours = 2.6,
    plume = null,
  } = {}) {
    this.field = field;
    this.pitch = pitch;
    this.hoursPerSec = hoursPerSec;
    this.saturateAt = saturateAt;
    this.fadeDeg = fadeDeg;

    // Everything the plume seeding needs, or null. Handed in rather than
    // imported so this module keeps knowing nothing about `data.js`: the layer
    // wants the mast, a grid to paint on, and a way to ask how red the map is
    // at a point, and does not care that any of it came from an atlas.
    this.plume = plume;
    this.paint = null;                         // the accumulation buffer
    this.paintAlpha = 0;                       // what of it is on screen
    this.reveal = 0;                           // 0..1 of the way out from the mast
    this.ambientAlpha = 1;

    // Seeded across the visible frame, which the layer learns from the map on
    // every draw. Before the first draw there is no camera to ask, so the whole
    // grid stands in -- one frame of slightly-off seeding that nothing sees.
    //
    // `stopView` is the framing the current slide is flying *to*, handed in by
    // the deck. It takes precedence over `view` for seeding, because the
    // population is reset before the camera has arrived: see `viewFromCamera`.
    this.view = null;
    this.stopView = null;
    this.spawnBox = null;                      // view, extended upwind
    this.spawnRatio = 1;                       // its area, over the frame's
    this._boxKey = '';
    this.ambientLifeHours = ambientLifeHours;
    this.ambient = new AdvectedParcels(field, {
      count: 1,
      lifeHours: ambientLifeHours,
      trailHours: ambientTrailHours,
      trailStepHours: 0.22,
      recycle: true,
      stagger: true,
      spawn: () => this._spawnInView(),
    });

    this.journey = null;                       // the stream, when a stop has one
    this.release = null;
    this.anchor = 0;
    this.tau = 0;
    this.phase = 'ambient';                    // off | ambient | stream
    this.fade = 1;
    this.painting = false;
    this.fan = null;                           // [{track, arrival, stampedTo}]
    this.fanKey = '';
    this.seeds = null;                         // the weighted seed table
    this.streamScale = 1;
    this._pt = { lon: 0, lat: 0 };
  }

  /**
   * Re-point the seed box at a framing without disturbing anything alive.
   *
   * A resize changes the canvas aspect and so the frame's latitude extent, and
   * the deck has to be able to say so without going through `setStop` -- that
   * would restart the journey and wipe a reveal that is halfway through.
   */
  setView(view) {
    this.stopView = view;
    this._updateSpawnBox();
    return this;
  }

  /** The frame the ambient air is seeded against, before the upwind extension. */
  _baseView() {
    const f = this.field;
    return this.stopView || this.view || {
      lonMin: f.lonMin, lonMax: f.lonMax, latMin: f.latMin, latMax: f.latMax,
    };
  }

  /**
   * Recompute the seed box: the frame, pushed out on the side the air arrives
   * from by one ambient lifetime of travel. See `SEED_UPWIND_MAX`.
   *
   * The mean wind is read off the field itself over the frame rather than taken
   * from the act -- one sample would be the weather at a point, and the frames
   * here are twenty degrees wide. Cheap: sixteen samples, and only when the
   * framing or the hour actually changes.
   */
  _updateSpawnBox() {
    const b = this._baseView();
    const key = `${b.lonMin.toFixed(2)},${b.lonMax.toFixed(2)},${b.latMin.toFixed(2)},${b.latMax.toFixed(2)},${this.anchor}`;
    if (key === this._boxKey && this.spawnBox) return this.spawnBox;
    this._boxKey = key;

    const f = this.field;
    const wLon = b.lonMax - b.lonMin;
    const wLat = b.latMax - b.latMin;
    let uM = 0;
    let vM = 0;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const lon = b.lonMin + ((i + 0.5) / 4) * wLon;
        const lat = b.latMin + ((j + 0.5) / 4) * wLat;
        const s = f.sample(this.anchor, lon, lat, scratch);
        if (!s) continue;
        uM += s.u; vM += s.v; n++;
      }
    }

    const box = { ...b };
    if (n > 0) {
      const k = degPerSec(uM / n, vM / n, (b.latMin + b.latMax) / 2);
      const sec = this.ambientLifeHours * 3600;
      const extLon = Math.min(Math.abs(k.dLon) * sec, SEED_UPWIND_MAX * wLon);
      const extLat = Math.min(Math.abs(k.dLat) * sec, SEED_UPWIND_MAX * wLat);
      // Upwind is the side the air comes *from*: eastward wind arrives from the
      // west, so the box grows west.
      if (k.dLon > 0) box.lonMin -= extLon; else box.lonMax += extLon;
      if (k.dLat > 0) box.latMin -= extLat; else box.latMax += extLat;
      box.lonMin = Math.max(f.lonMin, box.lonMin);
      box.lonMax = Math.min(f.lonMax, box.lonMax);
      box.latMin = Math.max(f.latMin, box.latMin);
      box.latMax = Math.min(f.latMax, box.latMax);
    }

    const area = (box.lonMax - box.lonMin) * (box.latMax - box.latMin);
    const frame = Math.max(1e-9, wLon * wLat);
    this.spawnBox = box;
    this.spawnRatio = clamp(area / frame, 1, SEED_COUNT_MAX);
    return box;
  }

  /** A point somewhere in the seed box, which is the frame plus its upwind margin. */
  _spawnInView() {
    const b = this.spawnBox || this._baseView();
    return {
      lon: b.lonMin + Math.random() * (b.lonMax - b.lonMin),
      lat: b.latMin + Math.random() * (b.latMax - b.latMin),
    };
  }

  /**
   * Point the layer at a slide.
   *
   * `null` switches it off. Otherwise `anchor` is the footprint frame the slide
   * holds, and `release` is a resolved entry from `RELEASES` in `beats.js`, or
   * null for an ambient-only stop.
   *
   * **The ambient population deliberately survives a stop change** when the
   * anchor has not moved. That is what makes stepping from "today the wind comes
   * off the Atlantic" to "this air has crossed nothing but sea" a caption change
   * over a continuous picture rather than a restart -- the tracers already on
   * screen simply carry on while a cohort sets off through them.
   */
  setStop(stop) {
    if (!stop) {
      this.release = null;
      this.journey = null;
      this.phase = 'off';
      this.paintAlpha = 0;
      this.stopView = null;
      return this;
    }
    const {
      anchor, release = null, mode = 'forward',
      paint = null, ambient = 1, view = null,
    } = stop;
    // The seed box is rebuilt before anything is reset, and from the framing
    // the slide is flying *to*: that is the whole point of being handed a
    // camera. It is refreshed on every stop rather than only on a new anchor,
    // because a slide can move the camera without moving the hour.
    const moved = anchor !== this.anchor;
    this.stopView = view;
    this.anchor = anchor;
    this._updateSpawnBox();
    if (moved) {
      this.ambient.reset();
      // The painted air belongs to one hour. Carrying it to another day would
      // show yesterday's tracks under today's plume.
      this._clearPaint();
    }
    this.release = release;
    this.mode = mode;
    this.ambientAlpha = ambient;
    this.painting = paint === 'draw';
    this.fade = 1;

    // 'draw' accumulates as the front walks out; 'hold' keeps what is already
    // there while the real plume comes up over it; null clears.
    if (paint === null) {
      this.paintAlpha = 0;
      this._clearPaint();
    } else if (paint === 'hold') {
      // Held under the real plume rather than over it. `MapView.draw` calls the
      // extra hook *after* the footprint raster, so the painted air is
      // physically on top and has to give way in alpha instead -- at 1 it would
      // hide the thing the slide exists to reveal.
      this.paintAlpha = PAINT_HOLD_ALPHA;
    } else {
      this.paintAlpha = 1;
      this._ensurePaint();
      this._clearPaint();
    }

    this.tau = anchor;

    if (!release) {
      this.journey = null;
      this.phase = 'ambient';
      return this;
    }

    this._buildStream();
    this.phase = 'stream';

    // The painted tracks are the fan itself, walked out from the mast on their
    // own clock -- not a rendering of where the parcels happen to have been.
    // Two reasons it is separate from the marks. The stream recycles, so its
    // parcels retrace the same tracks over and over and a buffer painted from
    // them would keep darkening for as long as the slide is up. And the reveal
    // has to be *complete* on the following stop however that stop was reached,
    // which a live population cannot promise.
    if (paint === 'hold') {
      this.reveal = 1;
      this._stampFan();
    } else if (paint === 'draw') {
      this.reveal = 0;
    }
    return this;
  }

  _ensurePaint() {
    if (!this.paint && this.plume && this.plume.grid) {
      this.paint = new PlumeCanvas(this.plume.grid);
    }
    return this.paint;
  }

  /**
   * Empty the buffer *and* forget how far the front had walked.
   *
   * The two go together: the fan remembers per track how much of itself is on
   * the canvas, so clearing one without the other leaves a stop that can never
   * repaint -- every track believes it is already down, and the map stays
   * blank however long the slide is up.
   */
  _clearPaint() {
    if (this.paint) this.paint.clear();
    this.reveal = 0;
    if (this.fan) for (const entry of this.fan) entry.stampedTo = 0;
  }

  /**
   * The fan of back-trajectories this stop hangs off, built once and cached.
   *
   * Keyed on the hour and the release, so stepping between the two stops of an
   * act -- the stream out and the same air walked back -- reuses the tracks
   * rather than integrating two dozen trajectories again and, worse, getting
   * *different* ones from the jitter.
   */
  /**
   * How far back this stop follows the air, in hours.
   *
   * One number per release, shared by the stop that flies the air in and the
   * stop that runs it back out -- they are the same air and it would be odd for
   * them to disagree about how far it came. It is also the number that decides
   * whether a caption is true: on the dirty day the flow *stalls*, 6.45 m/s at
   * the mast falling to 0.99 m/s eighteen hours back, so a rewind of twelve
   * hours covers 268 km and never leaves the North Sea while the caption names
   * Belgium. Measured on the shipped export: no track reaches lon 2.5 at 12 h,
   * one of twenty-four at 24 h, and **all of them at 36 h**, which is why that
   * release runs three times as long as the Atlantic one.
   */
  _hours() {
    return this.release.hours;
  }

  _ensureFan() {
    const r = this.release;
    const st = this.plume && this.plume.station;
    // Everything that changes the shape of the fan or of the table hanging off
    // it. Two releases with identical numbers on the same hour really are the
    // same fan, which is what makes stepping between an act's two stops free.
    const key = [
      this.anchor, this._hours(), r.arrivals, r.count, r.jitterKm, r.maxHours,
    ].join('|');
    if (this.fanKey === key && this.fan) return this.fan;
    if (!st) { console.warn('story: no station to run back-trajectories from'); return []; }

    this.fan = buildFan(this.field, {
      lon: st.lon, lat: st.lat, anchor: this.anchor,
      hours: this._hours(), arrivals: r.arrivals, count: r.count, jitterKm: r.jitterKm,
    });
    this.fanKey = key;
    this.seeds = null;
    // How much of each track is on the paint buffer. Initialised here rather
    // than lazily so a fresh fan is unambiguously unpainted -- `undefined` and
    // `0` mean the same thing to the stamper but not to anything checking it.
    for (const entry of this.fan) entry.stampedTo = 0;
    if (!this.fan.length) console.warn('story: no back-trajectory left the mast');
    return this.fan;
  }

  /**
   * Every point on every track, as somewhere a parcel could start, weighted by
   * how red the map is there.
   *
   * ---
   *
   * **This is the whole of "along the plume".** A back-trajectory is already a
   * line the air really travelled, so any point on it flows home to the mast --
   * that part is free, and it is what the 300 km corridor gave up when it seeded
   * *off* the tracks and carried the cross-track error straight through to the
   * arrival. What the tracks do not know is which parts of themselves the
   * audience can see. The drawn footprint does, and it is allowed to veto: air
   * starts only where the map is red. See `PLUME_GATE` for the measurement that
   * made it a veto rather than a weighting.
   *
   * Sampling is uniform in *time* along the surviving track -- points are
   * recorded every `recordHours` of travel, not every so many km -- so a steady
   * stream of starts is a steady stream of arrivals, which is what the mast
   * actually sees.
   *
   * Degrades to the whole track when there is no plume to ask, which is the
   * headless suite's case and any future export without a footprint.
   */
  _seedTable() {
    // The fan first, *then* the cache. The other order is a bug that shipped
    // for one round: `_ensureFan` is what notices the hour has changed and
    // clears this table, so checking the table first meant it never got the
    // chance -- and the dirty day drew the clean day's fan, tracks running
    // south-west out of a mast the air was arriving at from the south-east.
    // The table's own validity is not a fact about the table.
    const fan = this._ensureFan();
    if (this.seeds) return this.seeds;
    const r = this.release;
    const maxHours = r.maxHours || this._hours();
    const alphaAt = this.plume && this.plume.alphaAt;

    const pts = [];
    const all = [];
    for (const { track, arrival } of fan) {
      // From 1, not 0: index 0 is the mast itself, and a parcel spawned there
      // is born having already arrived.
      for (let k = 1; k < track.length; k++) {
        const p = track[k];
        if (p.hours > maxHours) break;
        const seed = { lon: p.lon, lat: p.lat, hours: p.hours, arrival };
        all.push(seed);
        if (!alphaAt || alphaAt(this.anchor, p.lon, p.lat) >= PLUME_GATE) pts.push(seed);
      }
    }
    // A gate that leaves nothing is a broken slide, not an empty one. It should
    // not happen -- every track starts at the mast, which is the reddest cell on
    // the map -- but a re-export could move the display cut out from under it.
    if (!pts.length && all.length) {
      console.warn('story: the plume gate left no seeds; falling back to the whole track');
      this.seeds = { pts: all };
      return this.seeds;
    }
    this.seeds = { pts };
    return this.seeds;
  }

  /** One seed, uniformly along whatever survived the gate. */
  _pickSeed() {
    const { pts } = this._seedTable();
    if (!pts.length) return null;
    return pts[(Math.random() * pts.length) | 0];
  }

  /**
   * End a parcel that has drifted out of the red.
   *
   * The other half of "only where the footprint is high". Seeding decides where
   * air *starts*; this decides where it stops, and it is what the backwards
   * stops need -- their parcels run outward until the patch runs out, and on the
   * clean day that is about half way along the track. Without it they carry on
   * into open ocean the slide has just said the mast cannot smell.
   *
   * The fade is run here rather than by shortening `p.life`, because life is
   * what sets the parcel's own field clock: cutting it short would jump the hour
   * it is reading and kink the last of its track.
   */
  _cull(dtHours) {
    const alphaAt = this.plume && this.plume.alphaAt;
    if (!alphaAt || !this.journey) return;
    const ps = this.journey.parcels;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p.alive || p.age <= 0) continue;
      if (alphaAt(this.anchor, p.lon, p.lat) >= PLUME_GATE) { p.fadeOut = undefined; continue; }
      p.fadeOut = (p.fadeOut === undefined ? CULL_FADE_HOURS : p.fadeOut) - dtHours;
      if (p.fadeOut <= 0) {
        this.journey.respawn(i);
        p.fadeOut = undefined;
      }
    }
  }

  /**
   * The stream: a few parcels at a time, always somewhere along the plume,
   * always on their way to the mast.
   *
   * ---
   *
   * **What this replaced, and why.** The deck used to release the fan as a
   * *cohort*: two dozen parcels, all seeded at the far ends of the tracks, all
   * flying at once, all freezing at the mast, then a hold and a replay. Three
   * things were wrong with it on screen. There were too many marks. They all set
   * off from the outer rim, so the near half of the plume was empty until they
   * crossed it. And the whole thing was a cycle with a beginning and an end,
   * which meant the slide was sometimes a picture of nothing much.
   *
   * A stream fixes all three with one change of bookkeeping. Parcels start
   * *anywhere* on the tracks, so every part of the plume has air in it at every
   * moment; each one only has as far to come as its own start point, so the
   * population turns over briskly with far fewer marks alive at once; and it
   * never ends, so there is no cycle to be caught at the wrong point in.
   *
   * Backwards is the same object with `sign: -1`: released *at* the mast and
   * integrated back out along the same weather. It needs no seed table, because
   * where the air came from is what the integration is for -- only the arrival
   * hour is drawn, and that is what opens the fan.
   */
  _buildStream() {
    const r = this.release;
    const back = this.mode === 'back';
    const st = (this.plume && this.plume.station) || { lon: 0, lat: 0 };
    // `parcels`, not `count`: `count` is how many *trajectories* the fan holds,
    // which wants to be generous because the fan is also the painted picture.
    // How many marks are alive at once is a separate judgement and a much
    // smaller number.
    const count = Math.max(1, Math.round((r.parcels || 12) * this.streamScale));

    const spawn = back
      ? () => {
        // The sampling volume again: the mast is a point, the air it measures
        // is not, and without the disc every parcel leaving at the same hour
        // would draw the same line.
        const a = Math.random() * TAU;
        const g = Math.sqrt(Math.random());
        const jitter = (r.jitterKm || 15) * g;
        return {
          lon: st.lon + (jitter / (111.32 * Math.cos((st.lat * Math.PI) / 180))) * Math.cos(a),
          lat: st.lat + (jitter / 110.54) * Math.sin(a),
          // No age: backwards parcels take the population's stagger, which is
          // what stops them leaving in lock step. They all fly the *same* length
          // of journey -- out to the end of the window -- so without it they
          // would also die in unison, and the stop would pulse rather than
          // stream.
          life: this._hours(),
          tauOffset: Math.random() * (r.arrivals || 0),
        };
      }
      : () => {
        const s = this._pickSeed();
        if (!s) return { lon: st.lon, lat: st.lat, age: 0, life: 0.01 };
        return { lon: s.lon, lat: s.lat, age: 0, life: s.hours, tauOffset: s.arrival };
      };

    const trailHours = r.trailHours || STREAM_TRAIL_HOURS;
    this.journey = new AdvectedParcels(this.field, {
      count,
      lifeHours: this._hours(),
      // A rolling window, not the whole journey. The cohort's full-length trail
      // was the evidence for "this air crossed nothing but sea"; that job now
      // belongs to the painted fan, which does it better because it does not
      // have to be carried by a mark that is also trying to look like moving
      // air. What is left for the trail to do is show direction and speed.
      trailHours,
      trailStepHours: Math.max(0.12, trailHours / 24),
      sign: back ? -1 : 1,
      recycle: true,
      // Every parcel is at a different point of a different journey, so each one
      // reads the weather of its own hour. See `anchorTau` in advect.js.
      anchorTau: this.anchor,
      // Forward, the *positions* are what spread the population out -- they are
      // scattered along the tracks by `_pickSeed`, and each parcel's journey is
      // as long as its own start point says. Backwards there is only one start
      // point, so the spread has to come from the clock instead.
      stagger: back,
      spawn,
    });

    // Every parcel is a point with no trail at the instant it is made, and a
    // forward stop opens on a map that is meant to be already flowing. So the
    // stream is flown for a couple of tail-lengths before the slide sees it.
    //
    // Not backwards: that stop's whole job is air *leaving* the mast, and
    // warming it up would have the air already gone by the time the caption
    // asking where it came from is read.
    if (!back) {
      const warm = Math.min(trailHours * 1.5, this._hours());
      for (let k = 0; k < 8; k++) this.journey.advance(warm / 8, 0, 0);
    }
  }

  /**
   * Advance the simulation by one animation frame.
   *
   * Called from the deck's render loop with real seconds, which is the only
   * place wall-clock time enters the wind at all.
   */
  tick(dtSec) {
    if (!(dtSec > 0) || this.phase === 'off') return this;

    const simHours = dtSec * this.hoursPerSec;

    // Three clocks, and this is where they are kept apart. Wall seconds come in
    // as `dtSec` and drive only the paint front. Simulated hours are what both
    // populations drift by. Field time -- the hour of weather being read -- is
    // held at the anchor for the ambient air, which is honest as "the wind at
    // this hour", while every stream parcel carries its own: see `anchorTau`.
    if (this.painting && this.reveal < 1) {
      this.reveal = Math.min(1, this.reveal + dtSec / BACK_REVEAL_SEC);
    }

    this.ambient.advance(simHours, this.tau, this.tau);
    if (this.journey && this.phase === 'stream') {
      this.journey.advance(simHours, 0, 0);
      this._cull(simHours);
    }
    return this;
  }

  /**
   * How many ambient tracers a canvas this size wants.
   *
   * Scaled by the seed box's area, so the *visible* density is the one the
   * pitch names: the tracers seeded in the upwind margin are off screen until
   * they blow in, and charging the frame for them would thin it.
   */
  countFor(w, h) {
    const n = ((w * h) / (this.pitch * this.pitch)) * this.spawnRatio;
    return Math.max(24, Math.min(1200, Math.round(n)));
  }

  /** Cycle the ambient density. Returns the new pitch, for the caller to show. */
  cyclePitch() {
    const i = AMBIENT_PITCHES.indexOf(this.pitch);
    this.pitch = AMBIENT_PITCHES[(i + 1) % AMBIENT_PITCHES.length];
    return this.pitch;
  }

  /**
   * Cycle how much air the stream carries, and rebuild it at the new count.
   *
   * The same argument as `W`: how many marks read as a flow rather than as a
   * mat depends on the room and the projector, and it is not settleable from a
   * desk. Returns the new count, for the caller to show.
   */
  cycleStream() {
    const i = STREAM_SCALES.indexOf(this.streamScale);
    this.streamScale = STREAM_SCALES[(i + 1) % STREAM_SCALES.length];
    if (this.release && this.phase === 'stream') this._buildStream();
    return this.journey ? this.journey.count : 0;
  }

  /**
   * One frame.
   *
   * Signature matches the `extra` callback `MapView.draw` invokes. The context
   * arrives already scaled by the device pixel ratio, so everything is in CSS
   * pixels.
   */
  draw(cx, map) {
    if (!this.field) return;

    // The camera is the seed region, refreshed every frame so a fly-in does not
    // leave the population seeded for the framing it started from.
    const tl = map.lonLatAt(0, 0);
    const br = map.lonLatAt(map.w, map.h);
    this.view = {
      lonMin: Math.max(this.field.lonMin, tl.lon),
      lonMax: Math.min(this.field.lonMax, br.lon),
      latMin: Math.max(this.field.latMin, br.lat),
      latMax: Math.min(this.field.latMax, tl.lat),
    };
    // Only does work when the framing or the hour has actually changed, so a
    // settled slide pays nothing and a resize is picked up without being told.
    this._updateSpawnBox();

    // The paint is gated on itself, not on `layers.wind`. The reveal stop and
    // the stop that brings the real plume up over it are in different acts with
    // different layer sets, and the accumulated tracks have to survive the step
    // between them -- that step is the whole point of the pair.
    if (this.paintAlpha > 0 && this.release) this._stampFan();
    if (this.paint && this.paintAlpha > 0) this.paint.drawTo(cx, map, this.paintAlpha);

    const alpha = map.layers.wind;
    if (!(alpha > 0) || this.fade <= 0) return;
    this.ambient.setCount(this.countFor(map.w, map.h));

    cx.save();
    cx.lineCap = 'round';
    cx.lineJoin = 'round';

    const a = alpha * this.fade;
    if (this.ambientAlpha > 0) {
      for (const p of this.ambient.parcels) this._comet(cx, map, p, a * this.ambientAlpha, 1);
    }
    if (this.journey && this.phase === 'stream') {
      for (const p of this.journey.parcels) this._comet(cx, map, p, a, 2);
    }

    cx.restore();
  }

  /**
   * Lay down the fan, out to wherever the reveal front has walked.
   *
   * **The front walks in hours, not in fraction of a track.** The tracks are
   * deliberately unequal -- one runs to the edge of the record, another was cut
   * short by the grid -- so uncovering each by the same *fraction* finishes the
   * short ones almost immediately, and the picture that makes is a scatter of
   * stubs popping up across the near field instead of one front leaving the
   * mast. In hours, every track is uncovered at the same moment of weather, so
   * they leave together.
   *
   * Only what the front has newly passed over is stamped, remembered per track:
   * the buffer keeps what is on it, so restamping would darken the near end a
   * little more every frame until the oldest air was the brightest thing on the
   * map.
   */
  _stampFan() {
    if (!this._ensurePaint() || !this.paint.ok || !this.release) return;
    const fan = this._ensureFan();
    const front = this.reveal * this._hours();

    for (const entry of fan) {
      const { track } = entry;
      if (entry.stampedTo === undefined) entry.stampedTo = 0;
      let k = entry.stampedTo;
      while (k + 1 < track.length && track[k + 1].hours <= front) {
        const a = track[k];
        const b = track[k + 1];
        // The track carries no speed of its own, so it is read back off the
        // geometry: this is how far the air moved between two recorded points
        // and how long it took. Same ramp as the marks, so the painted air and
        // the air still flying agree about what fast looks like.
        const dh = Math.max(1e-6, b.hours - a.hours);
        const speed = (kmBetween(a.lon, a.lat, b.lon, b.lat) * 1000) / (dh * 3600);
        this.paint.stamp(a.lon, a.lat, b.lon, b.lat, {
          colour: parcelColour(speed, this.saturateAt),
        });
        k++;
      }
      entry.stampedTo = k;
    }
  }

  /**
   * One parcel, as a tapering trail.
   *
   * Speed is carried by the trail's own *length* rather than by a mapped size:
   * the tail holds a fixed number of simulated hours, so a fast parcel has
   * simply travelled further in that time. That is the same double-encoding the
   * arrows had -- length and colour agreeing -- except here the length channel
   * is the data rather than a rendering of it.
   *
   * @param {number} weight  1 ambient, 2 a released cohort
   */
  _comet(cx, map, p, alpha, weight) {
    if (!p.alive || p.n < 2 || p.age < 0) return;

    const f = this.field;
    // Insurance only: with the cameras in beats.js the data edge sits over a
    // degree off-screen. It exists so re-framing an act cannot produce a hard
    // line of tracers stopping mid-sea, which reads as a rendering fault rather
    // than as the edge of a crop.
    const edge = Math.min(
      p.lon - f.lonMin, f.lonMax - p.lon, p.lat - f.latMin, f.latMax - p.lat,
    );
    let fade = edge >= this.fadeDeg ? 1 : Math.max(0, edge / this.fadeDeg);

    const wide = weight === 2;
    const from = 0;

    // A parcel that stopped -- arrived, or run off the grid -- stays drawn but
    // stops competing for attention. It must not vanish: a parcel that
    // disappears at the edge tells the audience the air stopped there.
    if (p.frozen) fade *= 0.55;
    if (fade <= 0) return;

    const head = this.trailXY(map, p, p.n - 1);
    const m = 60;
    if (head.x < -m || head.x > map.w + m || head.y < -m || head.y > map.h + m) return;

    // Teal for the air, the plume's own red for the air we are following. Same
    // mark, same speed scale, same lightness ladder -- only the hue moves, so
    // the cohort reads as a body of *this* air rather than as a second kind of
    // thing. See the note above PARCEL_CUT in palette.js for the measurement.
    const colour = wide
      ? parcelColour(p.speed, this.saturateAt)
      : windColour(p.speed, this.saturateAt);
    // Fade in at birth and out at death, so a recycled tracer appears and
    // leaves rather than popping. Both populations recycle constantly now and a
    // pop is exactly the kind of flicker that pulls an audience's eye off the
    // speaker. The windows are in simulated hours, so they scale with the
    // playback rate instead of drifting out of step with it.
    //
    // The stream's death fade is deliberately short -- half an hour of weather,
    // which at 10 m/s is 18 km, so the mark is on top of the mast as it goes.
    // It has to *arrive*: fading it out over its last couple of hours would
    // delete the payoff of the slide and leave a ring of air around a tower
    // nothing ever reaches.
    const born = Math.min(
      1, p.age / 0.6, (p.life - p.age) / (wide ? 0.5 : 1.2),
      // Leaving the red is a third way to die, and the only one that is about
      // the footprint rather than the journey. See `_cull`.
      p.fadeOut === undefined ? 1 : p.fadeOut / CULL_FADE_HOURS,
    );
    if (!(born > 0)) return;
    const base = alpha * fade * born;

    // The recent part of the trail is the head of the comet; the older part is
    // its tail. Two strokes rather than a per-segment gradient -- a few hundred
    // parcels at 60 fps cannot afford a stroke per segment, and two weights read
    // as a taper anyway.
    // Where the taper turns over: the recent 40% is the bright head. Backwards
    // air needs no special case any more -- it is integrated backwards rather
    // than replayed, so its newest trail point is its leading one, exactly as
    // for air moving forwards.
    const split = Math.max(1, Math.floor(p.n * 0.6));

    if (wide) {
      // A pale halo under the cohort only, the same device the station marker
      // uses. It is what separates "this air" from "the air" without spending a
      // second hue -- the mark stays identical, it just gains weight.
      cx.globalAlpha = base * 0.5;
      cx.strokeStyle = 'rgba(252,252,251,0.9)';
      cx.lineWidth = 5.5;
      this._path(cx, map, p, from, p.n);
      cx.stroke();
    }

    // Dim stroke over the whole trail, then the bright one over the leading
    // section only.
    cx.globalAlpha = base * 0.42;
    cx.strokeStyle = colour;
    cx.lineWidth = wide ? 2.1 : 1.3;
    this._path(cx, map, p, from, split + 1);
    cx.stroke();

    cx.globalAlpha = base * (wide ? 1 : 0.92);
    cx.lineWidth = wide ? 3.2 : 1.9;
    this._path(cx, map, p, split, p.n);
    cx.stroke();
  }

  /** Project trail point `k` of parcel `p` to screen. */
  trailXY(map, p, k) {
    const t = trailPoint(p, k, this._pt);
    return { x: map.x(t.lon), y: map.y(t.lat) };
  }

  _path(cx, map, p, from, to) {
    cx.beginPath();
    for (let k = from; k < to; k++) {
      const t = trailPoint(p, k, this._pt);
      const x = map.x(t.lon);
      const y = map.y(t.lat);
      if (k === from) cx.moveTo(x, y);
      else cx.lineTo(x, y);
    }
  }
}
