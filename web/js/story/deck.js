/**
 * The presenter deck.
 *
 * Drives a fullscreen map through a fixed sequence of stops while somebody talks
 * over it. That is a different job from the explorer, and the difference shows up
 * in three places:
 *
 *   - **Time is owned by the slide, not the page.** Most stops hold one frame.
 *     The ones that move declare a window and a speed, and pause themselves at
 *     named moments so the presenter can talk into the silence rather than
 *     racing the animation.
 *   - **The chrome is nearly all hidden.** One caption, one meter, one date. No
 *     toggles, no legend, no numbers competing with each other.
 *   - **The moments are editable live.** Which hour counts as "the dirty day" is
 *     a judgement call, so it is a scrubber and two keys rather than a constant
 *     you have to rebuild to change.
 *
 * Everything it imports from ../ is read-only: the explorer and this deck share
 * data.js, timeseries.js and palette.js untouched. The one fork is ./mapview.js,
 * for reasons given at the top of that file.
 */

import { loadData } from '../data.js';
import { TimeSeries } from '../timeseries.js';
import { WindLayer, viewFromCamera } from '../wind.js';
import { C, sourceDisplayFor, footprintLUT } from '../palette.js';
import { MapView } from './mapview.js';
import { resolveFrames, buildDeck, toSlides, resolvePlay, resolveFigures, pickTargets, showsStamp } from './engine.js';

const $ = (id) => document.getElementById(id);

/**
 * Where a tuning session is remembered, per deck.
 *
 * ⚠ Both keys were unscoped, which was harmless while there was one deck and a
 * silent corruption the moment there were two: tuning Gosan's dirty day would
 * have written a frame index into the same slot Ridge Hill reads, and Ridge Hill
 * would have opened on it. The frame indices are not even comparable between
 * sites -- 193 is a Sunday in June at one and past the end of the record at the
 * other.
 */
const storeKeys = (id) => ({
  frames: `ghg.story.frames.${id}`,
  look: `ghg.story.look.${id}`,
});


const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * "Sunday 2 February, 12pm" rather than "Sun 02 Feb · 12:00 UTC".
 *
 * The deck says the date out loud in the same words the presenter would use, in
 * the *station's* local time -- "Sunday, 11am" has to mean Sunday 11am where the
 * sensor is, or the story of a working week is being told against the wrong
 * clock. The zone is never printed: naming it costs more attention than it buys
 * this audience.
 *
 * ⚠ This used to read the UTC parts and stop, which is right only where the
 * station keeps UTC. It survived because Ridge Hill in February *is* UTC. Nine
 * hours east it is not: every stamp would have been nine hours out and the day
 * names would have flipped -- and a Sunday afternoon episode reading as Sunday
 * morning is exactly the kind of wrong that no test catches and no audience
 * questions. `tzOffsetH: 0` leaves Ridge Hill byte-identical.
 *
 * @param {number} tzOffsetH  hours to add to UTC. From the deck spec.
 */
function friendly(d, tzOffsetH = 0) {
  const local = new Date(d.getTime() + tzOffsetH * 3600e3);
  const h = local.getUTCHours();
  const hour = h === 0 ? 'midnight' : h === 12 ? 'midday'
    : h < 12 ? `${h}am` : `${h - 12}pm`;
  return `${DAYS[local.getUTCDay()]} ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}, ${hour}`;
}

function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Private windows and blocked site data both throw here. A deck that will
    // not start because it could not read a preference is a worse failure than
    // one that opens on its defaults.
    return null;
  }
}

function writeStore(key, frames) {
  try { localStorage.setItem(key, JSON.stringify(frames)); } catch { /* see above */ }
}

/**
 * Mount a deck.
 *
 * @param {object} deck  a deck spec -- `DECK` from a `beats-<site>.js`. Which
 *   site this is, what it calls its gas, where its data lives and what its
 *   moments are all come from here; nothing below names a site.
 */
export async function mountDeck({ deck } = {}) {
  const setProgress = (msg, frac) => {
    $('loadMsg').textContent = msg;
    $('loadBar').style.width = `${Math.round(frac * 100)}%`;
  };

  const params = new URLSearchParams(location.search);
  const base = params.get('data') || deck.data;

  let data;
  try {
    // The deck is the only page that draws wind, so it is the only one that
    // pays for it. See loadData's note on why this is opt-in.
    data = await loadData(base.endsWith('/') ? base : `${base}/`, setProgress, { wind: true });
  } catch (err) {
    $('loadMsg').innerHTML =
      `<strong>Could not load ${base}.</strong><br>${err.message}<br>` +
      '<span style="font-size:12px">Serve this folder over HTTP — see WEB_PIPELINE.md.</span>';
    $('loadBar').style.background = C.model;
    return null;
  }

  // Which gas this deck is about. The export picks its own `defaultSpecies` and
  // for both sites so far that is already the right one, but a deck that argues
  // about one gas must not be able to end up drawing another because an export
  // was re-run with a different default.
  //
  // `setSpecies` ignores a key it does not have, so the result is checked: a
  // deck naming a gas its export does not carry would otherwise draw the wrong
  // one in silence, with every caption still claiming the right one.
  if (data.setSpecies(deck.species) !== deck.species) {
    console.warn(`story: ${base} has no species "${deck.species}" — drawing "${data.activeSpecies}"`);
  }

  const n = data.nTime;
  // Hours per frame. Every "hours" the deck talks about -- a play window, a
  // nudge -- is in these, and it is 1 only at Ridge Hill.
  const stepHours = data.meta.timeStepHours || 1;
  /** Frame index to a spoken date, in the station's own local time. */
  const stamp = (t) => friendly(data.time(t), deck.tzOffsetH || 0);
  // Three separate things have to be true before a wind stop shows anything, and
  // they landed at different times: the export ships the atlases (`meta.wind`),
  // this page can sample them (`data.wind`), and something paints them. Gating
  // the placeholder on the first alone -- which is what it did -- meant it
  // vanished the moment the Python half shipped, leaving those stops as a camera
  // move over an empty map with nothing throwing. The layer is the honest
  // predicate, so it is the one the pill asks.
  // Where the back-trajectories start from, and the grid the painted tracks
  // accumulate on -- handed in as plain data so `wind.js` stays ignorant of how
  // any of it was loaded.
  //
  // `alphaAt` is how the stream is told where the plume actually is. It reports
  // the **drawn** opacity of the footprint at a point -- what the audience can
  // see, not the raw value -- so air is seeded where the map is red rather than
  // where the number is technically non-zero. Everything below the display cut
  // is invisible on screen, and seeding air into it would put marks where the
  // audience has been told there is nothing.
  const fpLUT = footprintLUT(data.meta);
  const alphaAt = (t, lon, lat) => {
    const g = data.grid;
    const j = Math.floor(((lon - g.lonMin) / (g.lonMax - g.lonMin)) * data.width);
    const i = Math.floor(((g.latMax - lat) / (g.latMax - g.latMin)) * data.height);
    if (i < 0 || i >= data.height || j < 0 || j >= data.width) return 0;
    return fpLUT[data.frame(t)[i * data.width + j] * 4 + 3] / 255;
  };
  const windLayer = data.wind
    ? new WindLayer(data.wind, {
      plume: { grid: data.grid, station: data.meta.station, alphaAt },
    })
    : null;
  const hasWind = !!windLayer;
  const drawWind = windLayer ? (cx, m) => windLayer.draw(cx, m) : null;

  // ---- frames -----------------------------------------------------------
  // A moment nudged on the night is written to localStorage, and it used to be
  // read back on every load from then on -- silently outranking `FRAMES` with a
  // number nothing on screen names. That is how the dirty day came up on the
  // wrong weather days after it was tuned. The write stays, so a tuning session
  // still survives a refresh; the read is gated, so a plain `story.html` always
  // opens on the numbers in its beats file. `?dirty=153` still works either way --
  // an explicit override in the URL is visible in the URL.
  const tuning = params.get('tune') === '1';
  const KEY = storeKeys(deck.id);
  const resolved = resolveFrames({
    search: location.search, store: tuning ? readStore(KEY.frames) : null, nTime: n,
    defaults: deck.frames,
  });
  let frames = resolved.frames;
  if (resolved.rejected.length) {
    console.warn('story: ignored out-of-range frame overrides:', resolved.rejected.join(', '));
  }

  let acts = [];
  let slides = [];
  let i = 0;                                  // current slide index

  function rebuild() {
    acts = buildDeck(deck, frames);
    slides = toSlides(acts);
    i = Math.max(0, Math.min(slides.length - 1, i));
  }
  rebuild();

  // ---- views ------------------------------------------------------------
  const map = new MapView($('map'), data);

  // The chart names the gas and its units, and "ppb" is exactly the sort of word
  // this deck does not put on screen. Rather than fork timeseries.js for two
  // strings, hand it a view of the dataset with those two properties shadowed --
  // everything else falls through the prototype chain unchanged.
  const chartData = Object.create(data, {
    units: { get: () => '' },
    speciesLabel: { get: () => deck.gasWord },
  });
  const ts = new TimeSeries($('ts'), chartData, { onScrub: (k) => setT(k) });

  const state = { t: frames.clean, playing: false, scrubbing: false };
  let play = null;                            // resolved window for this slide
  let holdsLeft = [];
  let dirty = true;

  // ---- chrome -----------------------------------------------------------
  // How full the bar is: the reading's height above clean air, as a share of
  // `smell.span`. The record's own min and max are deliberately not used -- see
  // SMELL in the deck's own beats file for why, and for where the two numbers
  // came from.
  const smell = deck.smell;
  const smellOf = (v) => (v == null ? 0
    : Math.max(0, Math.min(1, (v - smell.base) / smell.span)));

  function paintDots() {
    const el = $('dots');
    el.innerHTML = '';
    acts.filter((a) => a.enabled).forEach((a, ai) => {
      const b = document.createElement('button');
      b.className = 'dot';
      b.title = a.title;
      b.setAttribute('aria-label', a.title);
      if (ai === slides[i].actIndex) b.classList.add('on');
      b.addEventListener('click', () => {
        const first = slides.findIndex((s) => s.actIndex === ai);
        if (first >= 0) go(first);
      });
      el.appendChild(b);
    });
  }

  // ---- picks ------------------------------------------------------------
  //
  // A row of letters that jump straight to a named stop, for an act meant to be
  // run in the room's order rather than the file's. The presenter asks which
  // region to look at first and clicks it; the camera does not move, so only the
  // hour changes and the map answers.
  //
  // Everything a pick needs already existed -- `go(k)` sets the frame, the
  // framing, the layers and the bar. What was missing was a way to reach stop
  // *k* out of order, and that is all this is.

  /** Which picks have been shown. Survives leaving the act and coming back. */
  const visited = new Set();

  /**
   * The buttons on screen right now, resolved. Read by the headless suite.
   *
   * Same reason `figures` is exposed: `appendChild` is a no-op in the stub, so
   * the elements themselves are unobservable and a row that stopped being built
   * would look exactly like a slide with no picks on it.
   */
  let picks = [];

  /**
   * Paint the row for this slide, if it declares one.
   *
   * **On every stop of the act, not only the chooser.** After region A you click
   * B directly rather than walking back to a menu, and the row doubles as the
   * record of which ones the room has already been shown.
   *
   * ⚠ **The label is the letter and nothing else.** It comes off the stop's own
   * `id`, so there is no second place for the text to drift from the letters
   * `_drawBeacons` puts on the boxes. A place name on a button during the game
   * is the answer, and text on screen is text on screen whether it was drawn on
   * the canvas or not -- the suite checks both against `meta.beacons`.
   *
   * ⚠ **`$('picks')` may be null.** Two other pages share this file and neither
   * has the element; a missing tag is also exactly what the headless suite
   * cannot see, since its `getElementById` conjures any id it is asked for.
   */
  function paintPicks() {
    const stop = slides[i];
    const targets = stop.picks ? pickTargets(slides, stop.picks) : [];
    // Marked on arrival, and only where the slide we are on is itself a pick --
    // the chooser declares the row without being on it. The one you are looking
    // at reads as done as well as current: the row is a record of where the room
    // has been, and it has been here.
    if (targets.includes(i)) visited.add(i);
    picks = targets.map((target) => ({
      // `pick-C` -> `C`. Anything else keeps its id, which would show up on
      // screen as a wrong-looking button rather than as a missing one.
      label: String(slides[target].id).replace(/^pick-/, ''),
      target,
      on: target === i,
      done: visited.has(target),
    }));

    const el = $('picks');
    if (!el) return;
    el.hidden = picks.length === 0;
    el.innerHTML = '';
    for (const p of picks) {
      const b = document.createElement('button');
      b.className = `pick${p.on ? ' on' : ''}${p.done ? ' done' : ''}`;
      b.textContent = p.label;
      // The visible label is one letter, so the button needs to say what it is
      // for out loud. "Region C" is what the presenter would call it, and it
      // gives away no more than the map already shows.
      b.setAttribute('aria-label', `Region ${p.label}`);
      b.setAttribute('aria-current', p.on ? 'true' : 'false');
      b.addEventListener('click', () => go(p.target));
      el.appendChild(b);
    }
  }

  // ---- figures ----------------------------------------------------------
  //
  // Still pictures a stop can put on the stage: a photograph of the mast, the
  // inlet, the instrument in its hut. **DOM images over the canvas, not drawn
  // into it**, for three reasons that all point the same way. `mapview.js` is
  // already a deliberate fork of the explorer's and stays byte-comparable
  // against it; the render loop repaints every frame while the wind is running,
  // so a canvas blit would re-draw a photograph sixty times a second to no
  // effect; and the browser's own decode, aspect fit and cache are free here and
  // would all have to be written by hand there.
  //
  // The one case this is the wrong shape is a picture pinned to a **place** --
  // an image at a lon/lat that grows as the camera pushes in. That is a map
  // layer, belongs in the fork beside `_drawBeacons`, and is not this.

  /** The pictures on screen right now, resolved. Read by the headless suite. */
  let figures = [];

  /**
   * Ask the browser for every picture the deck will ever show, once, at mount.
   *
   * Not awaited, and deliberately: a deck that will not start because a
   * photograph is missing is a worse failure than one that shows a slide with a
   * gap in it, and this runs while the presenter is still on the title slide
   * either way. What it buys is that no image decodes *during* a sentence --
   * a JPEG arriving three frames late is a flash of empty stage in the middle
   * of the one act it was added for.
   *
   * The `Image` objects are held in the map so nothing can collect them before
   * the browser has cached the decode.
   */
  const figureCache = new Map();
  function preloadFigures() {
    const srcs = new Set();
    for (const s of slides) for (const fig of resolveFigures(s)) srcs.add(fig.src);
    for (const src of srcs) {
      if (figureCache.has(src)) continue;
      const img = new Image();
      img.src = src;
      figureCache.set(src, img);
    }
    return figureCache.size;
  }
  preloadFigures();

  /**
   * Put this stop's pictures on the stage.
   *
   * Rebuilt per stop rather than shown and hidden, which is the same bargain
   * `enter` already makes with the layer table: a stop lists what it has, and
   * nothing can be left behind three slides later. The cost is one element
   * creation per picture per slide change, against a deck that changes slide
   * when somebody presses a key.
   *
   * Placement is a class, so the stylesheet owns every number. See
   * `FIGURE_SLOTS` in engine.js for why it is a name and not a coordinate.
   */
  function paintFigures(stop) {
    const box = $('figures');
    figures = resolveFigures(stop);
    if (!box) return;
    box.innerHTML = '';
    for (const fig of figures) {
      const el = document.createElement('img');
      el.className = `fig fig-${fig.at} fig-${fig.size}`;
      el.src = fig.src;
      // Empty rather than absent when a beat gives none: an unlabelled picture
      // should read as decoration to a screen reader, not as an unnamed thing.
      // The suite makes the beats files give one anyway.
      el.alt = fig.alt || '';
      box.appendChild(el);
    }
  }

  /**
   * What the bar says about an hour the instrument does not have.
   *
   * Written on every paint rather than toggled, so the words hold their place in
   * the layout whatever state the meter is in -- the month act steps nine times
   * a second across a record a third empty, and a note that took its space as it
   * appeared would make the whole meter jump for twenty seconds. The stylesheet
   * moves its `visibility`, not its box. See `.meter-note` in story.css.
   */
  const NO_READING = 'no reading';

  /** How much is being smelled, as a height: nothing to a lot, no numbers. */
  function paintMeter(stop) {
    // Only where there is air on screen to be smelling. The bar answers "how
    // much of *this* can the mast smell", so on the sources card -- guessed
    // emissions, no footprint, no hour attached -- it has nothing to say and
    // would be read as a comment on the guess. `stop.chart` is no longer part
    // of the test: the last act dropped its chart so this could carry the month.
    const show = stop.layers.footprint > 0;
    $('meter').hidden = !show;
    if (!show) return;
    const v = data.current.obs ? data.current.obs[state.t] : null;
    /**
     * ⚠ **Three states, because empty and missing are different claims.**
     *
     * `smellOf(null)` is 0, so a blank hour used to draw the same flat bar as an
     * hour that genuinely read background -- which on this deck means clean air.
     * 46% of the Gosan record has no observation, so that was the deck asserting
     * "nothing here" for half of June and July, in the register the audience
     * reads fastest, while the caption said the opposite. It is also what forced
     * every anchored play window onto a run of consecutive observed frames and
     * cut the CFC-11 episode to four hours.
     *
     * So: hidden (no air on screen), a height (a reading), or struck out and
     * captioned (no reading). The fill is driven to zero here rather than left
     * where it was, so there is no level under the hatch to misread.
     *
     * Ridge Hill is 696 of 696 observed and never reaches this branch; Gosan and
     * the CFC-11 deck both do, on 341 and 307 frames respectively.
     */
    const blank = v == null;
    $('meter').classList.toggle('no-reading', blank);
    $('meterNote').textContent = NO_READING;
    $('meterFill').style.height = blank ? '0%' : `${Math.round(smellOf(v) * 100)}%`;
    // Presenter-only, behind N: the reading, then what the bar is actually
    // drawing. Two numbers are allowed here and nowhere else on screen -- and on
    // a blank hour there are none to give, so it says so in words instead.
    $('meterNum').textContent = blank ? NO_READING
      : `${Math.round(v)} · +${Math.round(Math.max(0, v - smell.base))}`;
  }

  function paintChrome() {
    const stop = slides[i];
    $('caption').textContent = stop.caption;
    $('stamp').textContent = stamp(state.t);
    /**
     * The date shows on the stops that have an hour on them, and `showsStamp` is
     * where that is decided -- see `DATED_LAYERS` in engine.js. A stop with only
     * geography and an emissions guess on it gets no date, because it does not
     * come from one; the same reasoning as `paintMeter` a few lines up, which
     * hides the bar where there is no air on screen for it to be about.
     *
     * Written every paint rather than toggled once, like everything else here,
     * so re-entering a slide cannot leave it in the other state. `.stamp` is
     * absolutely positioned, so nothing moves when it goes -- which matters on
     * the month act, stepping nine frames a second past the meter.
     */
    $('stamp').hidden = !showsStamp(stop);
    // A stop whose animation is not built yet still shows its framing, and says
    // so, rather than being silently dropped from the running order.
    const missing = stop.needs.includes('wind') && !hasWind;
    $('pill').hidden = !missing;
    paintMeter(stop);
    $('scrubRange').value = String(state.t);
    $('scrubTime').textContent = stamp(state.t);
  }

  function setT(t, { redrawChart = true } = {}) {
    state.t = Math.max(0, Math.min(n - 1, Math.round(t)));
    map.t = state.t;
    if (redrawChart) ts.setCursor(state.t).draw();
    paintChrome();
    dirty = true;
  }

  // ---- slides -----------------------------------------------------------
  /**
   * Point the wind layer at this stop.
   *
   * A release named in the deck spec is resolved here, so the beats file stays
   * free of imports and an unknown name fails loudly at the console rather than
   * silently drawing an ambient-only slide that was meant to show a journey.
   */
  function aimWind(stop) {
    if (!windLayer) return;
    // A stop that only holds the painted air has `wind: 0` -- the tracers are
    // gone and the tracks are not. So the layer is switched off only when there
    // is neither, which is what lets the reveal survive the act boundary.
    if (!(stop.layers.wind > 0) && !stop.paint) { windLayer.setStop(null); return; }
    let release = null;
    if (stop.release) {
      release = (deck.releases || {})[stop.release.from] || null;
      if (!release) console.warn(`story: no release box named "${stop.release.from}"`);
    }
    windLayer.setStop({
      anchor: stop.t,
      release,
      mode: stop.mode || 'forward',
      paint: stop.paint || null,
      ambient: stop.ambient === undefined ? 1 : stop.ambient,
      // The framing the slide is flying *to*. Without it the layer reseeds
      // against the camera it is leaving, which put a square of air in the top
      // right of the Atlantic frame -- see `viewFromCamera`.
      view: viewFromCamera(stop.camera, map.w, map.h, data.wind),
    });
  }

  function enter(keepTime = false) {
    const stop = slides[i];
    map.flyTo(stop.camera);
    Object.assign(map.layers, stop.layers);
    paintFigures(stop);

    const chart = !!stop.chart;
    $('chartShell').hidden = !chart;
    document.body.classList.toggle('with-chart', chart);
    if (chart) { ts.resize(); ts.draw(); }
    // The map's own box changed size when the chart appeared or left. Before
    // `aimWind`, not after: the seed box is computed from the canvas aspect, so
    // it has to be the size the slide is actually going to be.
    map.resize();
    aimWind(stop);

    play = resolvePlay(stop.play, { anchor: stop.anchor, frames, nTime: n, stepHours });
    holdsLeft = play ? [...play.holdAt] : [];
    state.playing = !!play;

    if (!keepTime) setT(play ? play.from : stop.t);
    else setT(state.t);

    paintDots();
    paintPicks();
    paintChrome();
    dirty = true;
  }

  function go(k) {
    i = Math.max(0, Math.min(slides.length - 1, k));
    enter();
  }
  const next = () => { if (i < slides.length - 1) go(i + 1); };
  const prev = () => { if (i > 0) go(i - 1); };

  // ---- retiming ---------------------------------------------------------
  /**
   * Move the moment this slide hangs off.
   *
   * Writing back to `frames` and rebuilding is what makes the change stick
   * across the whole deck: nudging "the dirty day" on Act 5 moves the marker on
   * the chart *and* the framing three slides earlier, because both read the same
   * number.
   */
  function retime(t) {
    const stop = slides[i];
    if (!stop.anchor) { setT(t); return; }
    frames = { ...frames, [stop.anchor]: Math.max(0, Math.min(n - 1, Math.round(t))) };
    writeStore(KEY.frames, frames);
    rebuild();
    enter(false);
  }

  /**
   * Move the moment by a number of *hours*, which is what `[` and `]` promise.
   *
   * Rounded to whole frames, and never to none: at a 2-hourly export a one-hour
   * nudge is half a frame, and a key that visibly does nothing reads as a broken
   * deck rather than as a sub-frame request. So the smallest nudge is one frame,
   * whatever that is worth in hours here.
   */
  function nudge(hours) {
    const stop = slides[i];
    const steps = Math.sign(hours) * Math.max(1, Math.round(Math.abs(hours) / stepHours));
    retime((stop.anchor ? frames[stop.anchor] : state.t) + steps);
  }

  // ---- render loop ------------------------------------------------------
  let last = performance.now();
  let acc = 0;

  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (state.playing && play && !state.scrubbing) {
      acc += dt * play.stepsPerSec;
      if (acc >= 1) {
        const step = Math.floor(acc);
        acc -= step;
        let t = state.t + step;

        // Stop *on* the first named moment we would have run past, so the pause
        // lands on the frame the caption is about rather than a frame or two
        // beyond it.
        const hit = holdsLeft.find((h) => h > state.t && h <= t);
        if (hit !== undefined) {
          t = hit;
          holdsLeft = holdsLeft.filter((h) => h !== hit);
          state.playing = false;
          acc = 0;
        } else if (t >= play.to) {
          t = play.to;
          state.playing = false;
          acc = 0;
        }
        setT(t);
      }
    }

    // The loop used to draw only when something set `dirty`, which was right
    // when the wind was a static arrow lattice and wrong for anything that
    // moves while the deck's own clock is held. A wind stop animates on its own
    // clock -- ambient tracers always, a released cohort while it is travelling
    // -- so it repaints every frame regardless of `dirty`, and every other stop
    // still costs nothing.
    if (windLayer && map.layers.wind > 0) {
      windLayer.tick(dt);
      dirty = true;
    }

    if (map.stepCamera()) dirty = true;
    if (dirty) { map.draw(drawWind); dirty = false; }
    requestAnimationFrame(loop);
  }

  // ---- controls ---------------------------------------------------------
  $('next').addEventListener('click', next);
  $('prev').addEventListener('click', prev);

  const scrub = $('scrubRange');
  scrub.max = String(n - 1);
  scrub.addEventListener('pointerdown', () => { state.scrubbing = true; });
  scrub.addEventListener('pointerup', () => { state.scrubbing = false; retime(+scrub.value); });
  scrub.addEventListener('input', () => {
    // Preview while dragging; the anchor only moves on release, so a drag across
    // the month does not rebuild the deck sixty times.
    setT(+scrub.value);
  });

  $('clearFrames').addEventListener('click', () => {
    try { localStorage.removeItem(KEY.frames); } catch { /* ignore */ }
    frames = { ...deck.frames };
    rebuild();
    enter(false);
  });

  // ---- sources contrast --------------------------------------------------
  //
  // Same bargain as the frame scrubber: tune on the screen you are presenting
  // on, then copy the numbers back into SOURCE_DISPLAY in palette.js. Persisted
  // under its own key so a tuned look survives a refresh without entangling
  // itself with the frame overrides -- and, since the split, under its own key
  // *per deck*, because the two sites draw different inventories on different
  // display windows and a contrast tuned for one says nothing about the other.
  const LOOK_KEY = KEY.look;
  const lookInputs = { floor: $('lookFloor'), ceil: $('lookCeil'), gamma: $('lookGamma') };

  // The window is settled, so the row is off the panel unless it is asked for.
  // Everything below still runs: a look stored from an earlier session is still
  // restored, and `?tune=1` is how you get back to the boxes and to `reset`.
  // Retiring the wiring instead would strand that stored value with nothing on
  // screen able to see it or clear it.
  $('lookRow').hidden = !tuning;

  function showLook(d) {
    lookInputs.floor.value = String(d.floor);
    lookInputs.ceil.value = String(d.ceil);
    lookInputs.gamma.value = String(d.gamma);
  }

  function applyLook(patch, persist = true) {
    const d = map.setSourceDisplay(patch);
    if (persist) {
      try { localStorage.setItem(LOOK_KEY, JSON.stringify(d)); } catch { /* ignore */ }
    }
    showLook(d);
    dirty = true;
  }

  try {
    // The unscoped key is what this was stored under before the split, and it
    // is read back if the scoped one is empty. Not politeness: a look tuned in
    // an earlier session is applied on *every* load, so dropping it would change
    // how Ridge Hill looks -- and the one thing this refactor promises is that
    // Ridge Hill is unchanged. Written back scoped, so it migrates on first
    // tune. Delete this fallback once nobody's browser is carrying one.
    const stored = JSON.parse(
      localStorage.getItem(LOOK_KEY) || localStorage.getItem('ghg.story.look') || 'null',
    );
    // Only numbers, and only the three keys -- a stale or hand-mangled entry
    // must not be able to blank the map.
    if (stored) {
      const clean = {};
      for (const k of ['floor', 'ceil', 'gamma']) {
        if (Number.isFinite(Number(stored[k]))) clean[k] = Number(stored[k]);
      }
      if (Object.keys(clean).length) map.setSourceDisplay(clean);
    }
  } catch { /* ignore */ }
  showLook(map.sourceDisplay);

  for (const [key, el] of Object.entries(lookInputs)) {
    el.addEventListener('input', () => {
      const v = Number(el.value);
      if (Number.isFinite(v)) applyLook({ [key]: v });
    });
  }

  $('copyLook').addEventListener('click', async () => {
    const text = JSON.stringify(map.sourceDisplay, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      $('copyLook').textContent = 'copied';
    } catch {
      console.log(text);
      $('copyLook').textContent = 'see console';
    }
    setTimeout(() => { $('copyLook').textContent = 'copy'; }, 1400);
  });

  $('resetLook').addEventListener('click', () => {
    try { localStorage.removeItem(LOOK_KEY); } catch { /* ignore */ }
    // The same fallback `mapview` opens on: the sources card where the deck has
    // one, the coarse map where it does not. Reading only `fluxHires` here
    // would reset the CFC-11 deck to methane's window, which paints its map
    // empty -- the exact failure `SOURCE_DISPLAY_BY_SPECIES` exists to prevent,
    // reintroduced by the one button whose job is to undo a mistake.
    applyLook(sourceDisplayFor(data.meta.fluxHires || data.meta.flux), false);
  });

  function toggleScrubber(force) {
    const el = $('scrubber');
    el.hidden = force === undefined ? !el.hidden : !force;
  }

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key;
    if (k === 'ArrowRight' || k === ' ' || k === 'PageDown') { e.preventDefault(); next(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); prev(); }
    else if (k === '.') { state.playing = !state.playing; if (state.playing && play && state.t >= play.to) { holdsLeft = [...play.holdAt]; setT(play.from); } }
    else if (k === 'r' || k === 'R') { enter(false); }
    // H and T are the same switch, and that is on purpose for now. T was always
    // the documented key and is in the notes; H is the one you reach for when
    // the panel is over the map mid-sentence, because it is what "hide" is
    // called everywhere else. Both are in the tuning-keys audit; whichever
    // survives, the other is one line.
    else if (k === 't' || k === 'T' || k === 'h' || k === 'H') { toggleScrubber(); }
    else if (k === 'n' || k === 'N') { document.body.classList.toggle('show-number'); }
    // Square cells vs a smoothed field, on the sources card. A judgement to make
    // on the screen you are presenting on, not in the source.
    else if (k === 'g' || k === 'G') { map.crispSources = !map.crispSources; dirty = true; }
    // How many tracers the air is drawn with. The arrow lattice this replaced
    // was killed for being too busy at a density that had already been halved
    // once, which is the tell that this cannot be settled from a desk: it
    // depends on the screen, the room and how far back the audience sits. So it
    // is a key, tuned on the night, like the sources contrast above.
    else if (k === 'w' || k === 'W') {
      if (windLayer) {
        console.log(`story: wind tracers at a ${windLayer.cyclePitch()} px pitch`);
        dirty = true;
      }
    }
    // The same argument, for the red air. How many marks read as a stream
    // rather than as clutter is the other half of the same judgement, and the
    // two are tuned against each other in the room.
    else if (k === 'e' || k === 'E') {
      if (windLayer) {
        console.log(`story: ${windLayer.cycleStream()} parcels in the stream`);
        dirty = true;
      }
    }
    else if (k === '[') { nudge(e.shiftKey ? -6 : -1); }
    else if (k === ']') { nudge(e.shiftKey ? 6 : 1); }
    else if (k === 'f' || k === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    } else if (k >= '1' && k <= '9') {
      /**
       * ⚠ **On a slide that declares picks, 1-5 are the picks** -- and there
       * only. Everywhere else in every deck they are still the act jumps they
       * have always been, which is why this shadows rather than rebinds: the
       * alphabet is nearly all spoken for (`e`/`w`/`g`/`n`/`r`/`t`/`h`/`f` are
       * bound above) and a global pick key would have cost an act jump on three
       * decks to serve one act on one.
       *
       * A presentation clicker sends arrows and nothing else, so this is a
       * convenience for whoever is at the keyboard. Clicking is the primary
       * path and the linear order still reads on its own.
       */
      const n1 = Number(k) - 1;
      if (picks[n1]) { go(picks[n1].target); return; }
      const first = slides.findIndex((s) => s.actIndex === n1);
      if (first >= 0) go(first);
    } else return;
  });

  // The seed box is derived from the canvas aspect, so a window that changes
  // shape leaves the wind seeding the frame the deck used to have. `setView`
  // rather than `aimWind`: re-aiming would restart the journey and wipe a
  // reveal that is halfway through, for a resize.
  const onResize = () => {
    map.resize(); ts.resize(); ts.draw();
    if (windLayer) windLayer.setView(viewFromCamera(slides[i].camera, map.w, map.h, data.wind));
    dirty = true;
  };
  window.addEventListener('resize', onResize);

  enter(false);
  onResize();
  $('loader').classList.add('done');
  requestAnimationFrame(loop);

  return {
    data, map, ts, state, slides, hasWind, windLayer,
    get frames() { return frames; },
    // What is on the stage beside the map. Exposed for the same reason `index`
    // is: the suite stubs `appendChild` to a no-op, so the elements themselves
    // are unobservable, and a picture that stopped being mounted would look
    // exactly like a deck with no pictures in it.
    get figures() { return figures; },
    // The letter buttons this slide offers, and where each one lands. Exposed
    // for the same reason as `figures`, and for one more: the suite has to be
    // able to read the *labels*, because "no button says Shandong" is a claim
    // about the text on screen and the elements are not observable.
    get picks() { return picks; },
    // Which slide is showing. Read-only, and exposed so the headless suite can
    // check that a key press actually moved the deck rather than just not
    // throwing -- `go` is callable from a test, but the key bindings are what a
    // presenter uses and they were previously unobservable.
    get index() { return i; },
    go, next, prev, retime,
  };
}
