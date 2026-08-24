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
import { C, SOURCE_DISPLAY, footprintLUT } from '../palette.js';
import { MapView } from './mapview.js';
import {
  FRAMES, SHOW_RECORD_LOW, RELEASES, resolveFrames, buildBeats, toSlides, resolvePlay,
} from './beats.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'ghg.story.frames';


const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * "Sunday 2 February, 12pm" rather than "Sun 02 Feb · 12:00 UTC".
 *
 * The deck says the date out loud in the same words the presenter would use. UTC
 * is dropped deliberately: in February, British time *is* UTC, and the caveat
 * costs more attention than it buys this audience.
 */
function friendly(d) {
  const h = d.getUTCHours();
  const hour = h === 0 ? 'midnight' : h === 12 ? 'midday'
    : h < 12 ? `${h}am` : `${h - 12}pm`;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hour}`;
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Private windows and blocked site data both throw here. A deck that will
    // not start because it could not read a preference is a worse failure than
    // one that opens on its defaults.
    return null;
  }
}

function writeStore(frames) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(frames)); } catch { /* see above */ }
}

export async function mountDeck({ defaultData = 'data-rgl/' } = {}) {
  const setProgress = (msg, frac) => {
    $('loadMsg').textContent = msg;
    $('loadBar').style.width = `${Math.round(frac * 100)}%`;
  };

  const params = new URLSearchParams(location.search);
  const base = params.get('data') || defaultData;

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

  const n = data.nTime;
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
  // opens on the numbers in `beats.js`. `?dirty=153` still works either way --
  // an explicit override in the URL is visible in the URL.
  const tuning = params.get('tune') === '1';
  const resolved = resolveFrames({
    search: location.search, store: tuning ? readStore() : null, nTime: n,
  });
  let frames = resolved.frames;
  if (resolved.rejected.length) {
    console.warn('story: ignored out-of-range frame overrides:', resolved.rejected.join(', '));
  }

  let acts = [];
  let slides = [];
  let i = 0;                                  // current slide index

  function rebuild() {
    acts = buildBeats(frames, { showRecordLow: SHOW_RECORD_LOW });
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
    speciesLabel: { get: () => 'methane' },
  });
  const ts = new TimeSeries($('ts'), chartData, { onScrub: (k) => setT(k) });

  const state = { t: frames.clean, playing: false, scrubbing: false };
  let play = null;                            // resolved window for this slide
  let holdsLeft = [];
  let dirty = true;

  // ---- chrome -----------------------------------------------------------
  const obsMin = data.meta.species[0].obsMin ?? 1900;
  const obsMax = data.meta.species[0].obsMax ?? 2200;

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

  /** Reading as a share of the month's range: no numbers, just a little to a lot. */
  function paintMeter(stop) {
    const show = stop.layers.footprint > 0 && !stop.chart;
    $('meter').hidden = !show;
    if (!show) return;
    const v = data.current.obs ? data.current.obs[state.t] : null;
    const f = v == null ? 0 : (v - obsMin) / Math.max(1e-9, obsMax - obsMin);
    $('meterFill').style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
    $('meterNum').textContent = v == null ? '' : `${Math.round(v)}`;
  }

  function paintChrome() {
    const stop = slides[i];
    $('caption').textContent = stop.caption;
    $('stamp').textContent = friendly(data.time(state.t));
    // A stop whose animation is not built yet still shows its framing, and says
    // so, rather than being silently dropped from the running order.
    const missing = stop.needs.includes('wind') && !hasWind;
    $('pill').hidden = !missing;
    paintMeter(stop);
    $('scrubRange').value = String(state.t);
    $('scrubTime').textContent = friendly(data.time(state.t));
    $('scrubAnchor').textContent = stop.anchor ? `moment: ${stop.anchor}` : 'no moment on this slide';
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
   * A release named in `beats.js` is resolved here, so `beats.js` stays free of
   * imports and an unknown name fails loudly at the console rather than
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
      release = RELEASES[stop.release.from] || null;
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

    const chart = !!stop.chart;
    $('chartShell').hidden = !chart;
    document.body.classList.toggle('with-chart', chart);
    if (chart) { ts.resize(); ts.draw(); }
    // The map's own box changed size when the chart appeared or left. Before
    // `aimWind`, not after: the seed box is computed from the canvas aspect, so
    // it has to be the size the slide is actually going to be.
    map.resize();
    aimWind(stop);

    play = resolvePlay(stop.play, { anchor: stop.anchor, frames, nTime: n });
    holdsLeft = play ? [...play.holdAt] : [];
    state.playing = !!play;

    if (!keepTime) setT(play ? play.from : stop.t);
    else setT(state.t);

    paintDots();
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
    writeStore(frames);
    rebuild();
    enter(false);
  }

  function nudge(hours) {
    const stop = slides[i];
    retime((stop.anchor ? frames[stop.anchor] : state.t) + hours);
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

  $('copyFrames').addEventListener('click', async () => {
    const text = JSON.stringify(frames, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      $('copyFrames').textContent = 'copied';
    } catch {
      // Clipboard is gated on permissions and a user gesture; the console is a
      // reliable fallback and this is a developer-facing affordance anyway.
      console.log(text);
      $('copyFrames').textContent = 'see console';
    }
    setTimeout(() => { $('copyFrames').textContent = 'copy frames'; }, 1400);
  });

  $('clearFrames').addEventListener('click', () => {
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    frames = { ...FRAMES };
    rebuild();
    enter(false);
  });

  // ---- sources contrast --------------------------------------------------
  //
  // Same bargain as the frame scrubber: tune on the screen you are presenting
  // on, then copy the numbers back into SOURCE_DISPLAY in palette.js. Persisted
  // under its own key so a tuned look survives a refresh without entangling
  // itself with the frame overrides.
  const LOOK_KEY = 'ghg.story.look';
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
    const stored = JSON.parse(localStorage.getItem(LOOK_KEY) || 'null');
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
    applyLook({ ...SOURCE_DISPLAY }, false);
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
    else if (k === 't' || k === 'T') { toggleScrubber(); }
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
      const ai = Number(k) - 1;
      const first = slides.findIndex((s) => s.actIndex === ai);
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
    // Which slide is showing. Read-only, and exposed so the headless suite can
    // check that a key press actually moved the deck rather than just not
    // throwing -- `go` is callable from a test, but the key bindings are what a
    // presenter uses and they were previously unobservable.
    get index() { return i; },
    go, next, prev, retime,
  };
}
