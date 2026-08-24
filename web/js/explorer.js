/**
 * The footprint explorer: the original canvas prototype, rewired to real data.
 *
 * Everything the synthetic version faked now comes from the export:
 *   obs[t]            -> the measured mole fraction at the inlet
 *   sourceOverlap[t]  -> sum(footprint * emissions), the forward model, where an
 *                        inventory exists; otherwise the share of the footprint
 *                        sitting over land
 *   windAngle[t]      -> the station's measured wind direction
 * and the footprint itself is the real gridded field rather than a particle
 * cloud standing in for one.
 *
 * Which dataset loads is set by ?data= (default the Ridge Hill export). Sites
 * differ in what they have -- Gosan has no emissions inventory yet -- so the
 * controls are built from what the export actually contains.
 *
 * This module is the explorer itself; explore.js and listen.js are the two thin
 * entries that mount it. It expects the markup in explore.html -- both pages
 * carry the same ids -- and it owns time, so a page that wants time to come from
 * somewhere else (listen.js, where the audio clock is the master) says so
 * through `hooks` rather than by running a second loop of its own.
 */

import { loadData, formatTime } from './data.js';
import { MapView, fitMapWidth } from './mapview.js';
import { TimeSeries } from './timeseries.js';
import { ParticleField } from './particles.js';
import { C, RAMPS, rampGradient } from './palette.js';

const $ = (id) => document.getElementById(id);

const loader = $('loader');
const setProgress = (msg, frac) => {
  $('loadMsg').textContent = msg;
  $('loadBar').style.width = `${Math.round(frac * 100)}%`;
};

// Without this, anything thrown during setup leaves the loader sitting on its
// last message forever, which looks exactly like a slow download.
function fatal(err) {
  console.error(err);
  loader.classList.remove('done');
  $('loadMsg').innerHTML =
    `<strong>Could not start.</strong><br>${err && err.message ? err.message : err}` +
    '<br><span style="font-size:11px">See the browser console for the full trace.</span>';
  $('loadBar').style.background = '#eb6834';
}
window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Build the explorer into the page and start it.
 *
 * `hooks` is the seam for a page that wants to drive time from somewhere else.
 * All three are optional, and with none of them this behaves exactly as the
 * standalone explorer always has:
 *
 *   tick()            called once per animation frame, before the internal
 *                     accumulator. Return a row index to jump to, `undefined`
 *                     to hold the current frame, or `null` to let the
 *                     accumulator advance time as usual.
 *   onTime(row, o)    called after every setT, whatever moved it. `o.userSeek`
 *                     is true when a person moved it -- the slider, a click on
 *                     the chart, an arrow key -- and false when whatever is
 *                     already driving the clock did. A follower that seeks on
 *                     every call would seek its own clock back to itself nine
 *                     times a second; one that only redraws can ignore the flag.
 *   onPlayToggle(on)  called when the Play button flips, with its new state.
 *
 * `pinSpecies` fixes the page to one gas and drops the switcher. Anything built
 * from `data.current` outside this module -- the sonifier's pitched layer, which
 * is percentile-ranked against one gas's own distribution -- would otherwise go
 * stale the moment someone switched, so a page that holds such a thing pins.
 *
 * Returns the pieces a caller needs to wire something to: the loaded data, the
 * three views, the mutable state object, setT, and the frame count.
 */
export async function mountExplorer({
  defaultData = 'data-rgl/',
  pinSpecies = null,
  hooks = {},
} = {}) {
  const params = new URLSearchParams(location.search);
  const base = params.get('data') || defaultData;

  let data;
  try {
    data = await loadData(base.endsWith('/') ? base : `${base}/`, setProgress);
  } catch (err) {
    $('loadMsg').textContent = `Could not load ${base}: ${err.message}. Serve this folder over HTTP (see README).`;
    // Null rather than a throw: this message is more use than the generic one
    // fatal() would paint over it. Callers check before wiring anything on.
    return null;
  }

  // Before the views are built: the chart reads the active species in its
  // constructor.
  if (pinSpecies && data.speciesKeys.includes(pinSpecies)) data.setSpecies(pinSpecies);

  const map = new MapView($('map'), data);
  const ts = new TimeSeries($('ts'), data, { onScrub: (i) => setT(i) });
  const particles = new ParticleField(data);

  const wideView = { ...map.cam };
  const st = data.meta.station;
  // Zoomed framing: close enough to read the station's surroundings, wide
  // enough that the plume still has somewhere to go.
  const nearView = { lon: st.lon, lat: st.lat + 1.5, span: Math.max(12, map.cam.span * 0.35) };
  const n = data.nTime;

  // The readout needs one number per timestep saying "how continental is this
  // air". The forward model is the right answer where an inventory exists; the
  // share of footprint mass over land is the honest fallback where it does not.
  // Both depend on the active species, so this is rebuilt on every switch.
  let driver = null;
  let driverKind = null;
  let loCut = 0;
  let hiCut = 1;

  function rebuildDriver() {
    driver = data.has.model ? data.current.modelled : data.series.landFrac;
    driverKind = data.has.model ? 'model' : data.has.landFrac ? 'land' : null;
    if (driver) {
      const sorted = [...driver].filter(Number.isFinite).sort((a, b) => a - b);
      loCut = quantile(sorted, 1 / 3);
      hiCut = quantile(sorted, 2 / 3);
    }
  }
  rebuildDriver();

  const state = { t: 0, playing: false, particles: false, zoom: false };
  let tableFilled = false;

  $('slider').max = String(n - 1);
  $('rampFp').style.background = rampGradient(RAMPS.footprint);
  $('rampFlux').style.background = rampGradient(RAMPS.flux);

  document.title = `Footprint explorer · ${st.name}`;
  $('title').textContent = `What was ${st.id} breathing?`;

  const first = data.time(0);
  const lastT = data.time(n - 1);
  const period = `${first.toUTCString().slice(5, 16)} – ${lastT.toUTCString().slice(5, 16)}`;
  const stepTxt = data.meta.timeStepHours === 1 ? 'hourly' : `${data.meta.timeStepHours}-hourly`;

  /** Copy that names the gas, so it has to be rebuilt when the gas changes. */
  function refreshCopy() {
    // Kept to a few lines: in a one-screen layout every line of standfirst is a
    // line taken off the map.
    $('standfirst').innerHTML =
      `A model runs the wind backwards from the inlet at <strong>${st.name}</strong> to find the patch of ` +
      `map the air had just crossed — its <strong>footprint</strong>. Drag the timeline: over land the ` +
      `${data.speciesLabel} reading climbs, over open ocean the air arrives clean.`;

    const nObs = data.has.obs ? data.current.obs.filter((v) => v != null).length : 0;
    const f = data.meta.factories;
    $('footnote').innerHTML = [
      `Footprints: NAME, ${st.id}${st.inletMagl ? ` inlet at ${st.inletMagl} m above ground` : ''}, ${period}.`,
      data.has.obs
        ? `Observations: ${data.speciesLabel}, ${nObs} of ${n} ${stepTxt} slots have a measurement` +
          `${nObs < n ? ' — gaps are gaps in the record, and the line breaks across them' : ''}.`
        : `No ${data.speciesLabel} observations overlap this period.`,
      data.has.model
        ? 'Modelled line: footprint × EDGAR v7 emissions, the forward model an inversion inverts.'
        : 'No emissions inventory for this domain yet, so there is no modelled line — the readout uses the share of the footprint over land instead.',
      data.has.factories
        ? `Plant markers: ${f.nListed} reported ${f.label} production sites at ${f.nSites} distinct ` +
          'locations (several share a coordinate). Positions only — the list carries no ' +
          'capacities, so a marker says "a plant is here", not how much it emits. ' +
          `A marker turns yellow when the footprint over that plant reaches 10<sup>${f.litLog10}</sup> ` +
          '— a fixed sensitivity, the same at every site and in every year, so the highlight ' +
          'means the same thing wherever you see it. It says the station was well placed to ' +
          'smell that plant during those hours, not that the plant emitted.'
        : '',
      `The whole period is ${n} frames in one <code>${data.meta.footprint.sizeMB} MB</code> sprite atlas, ` +
        'decoded once, so scrubbing costs a memcpy rather than a redraw. All species on this page share it.',
    ].filter(Boolean).join(' ');
  }

  // Only offer controls the data can back.
  if (!data.has.flux) $('tFlux').remove();
  if (!data.has.obs) $('tTable').remove();
  if (!data.has.factories) {
    $('tFactories').remove();
    $('factoryLegend').remove();
  } else {
    // Name the gas in the control, because the claim of the layer is that these
    // plants vent that specific gas. The label comes from the export, not from
    // the active species -- switching the chart to CFC-11 must not relabel a
    // list of HFC-23 plants.
    const f = data.meta.factories;
    $('tFactories').textContent = `${f.label} plants`;
    $('factoryLegendText').textContent = `reported ${f.label} plants (${f.nSites})`;
    $('factoryLitText').textContent = 'plume overhead';
  }

  // Species switcher, only when there is more than one gas to switch between
  // and the page has not pinned itself to one.
  if (data.has.manySpecies && !pinSpecies) {
    const row = $('speciesRow');
    row.hidden = false;
    for (const s of data.speciesList) {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.setAttribute('aria-pressed', String(s.key === data.activeSpecies));
      b.disabled = !s.hasObs;
      if (!s.hasObs) b.title = 'no measurements overlap this period';
      b.addEventListener('click', () => {
        ts.setSpecies(s.key);
        for (const other of row.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === b));
        }
        rebuildDriver();
        refreshCopy();
        $('tModel').hidden = !data.has.model;
        tableFilled = false;
        if ($('tableWrap').classList.contains('open')) fillTable();
        ts.draw();
        updateReadout();
      });
      row.appendChild(b);
    }
  }
  $('tModel').hidden = !data.has.model;
  refreshCopy();

  // ---- readout ----------------------------------------------------------
  // The prose readout is currently not in the page. `driver` is still built --
  // the opening-frame choice falls back to it when a site has no observations --
  // so this degrades to just the timestamp rather than being torn out.
  const statusEl = $('status');
  const statusDot = $('statusDot');

  function updateReadout() {
    $('tstamp').textContent = formatTime(data.time(state.t));
    if (!statusEl || !driver) return;
    const v = driver[state.t];
    const lf = data.has.landFrac ? data.series.landFrac[state.t] : null;
    const pct = lf == null ? null : Math.round(lf * 100);

    let text;
    let colour;
    if (v >= hiCut) {
      text = `The footprint is sitting over <b>land</b> — the ${data.speciesLabel} reading climbs.`;
      colour = C.model;
    } else if (v >= loCut) {
      text = 'A <b>mix of land and ocean</b> — a moderate reading.';
      colour = C.muted;
    } else {
      text = 'The footprint reaches out over <b>open ocean</b> — clean marine air, low reading.';
      colour = C.obs;
    }
    if (pct != null) text += ` <span style="color:var(--muted)">${pct}% of the footprint is over land`
      + (driverKind === 'model' ? `; modelled +${v.toFixed(1)} ${data.units}` : '') + '.</span>';
    statusEl.innerHTML = text;
    if (statusDot) statusDot.style.background = colour;
  }

  /**
   * The only thing that moves time.
   *
   * `seek` is false when the move came from whatever is already driving the
   * clock, and true when a person moved it. Without that distinction a page
   * following an external clock would seek it back to itself on every frame,
   * which for the audio engine means flushing and re-booking the scheduler
   * queue nine times a second.
   */
  function setT(t, { seek = true } = {}) {
    state.t = Math.max(0, Math.min(n - 1, t | 0));
    $('slider').value = String(state.t);
    map.t = state.t;
    ts.setCursor(state.t).draw();
    updateReadout();
    dirty = true;
    if (hooks.onTime) hooks.onTime(state.t, { userSeek: seek });
  }

  // ---- render loop ------------------------------------------------------
  let dirty = true;
  let last_ = performance.now();
  let acc = 0;
  const STEPS_PER_SEC = 9;

  function loop(now) {
    const dt = Math.min(0.05, (now - last_) / 1000);
    last_ = now;

    // An external clock gets first refusal on the frame. `null` means it is not
    // driving right now and the accumulator below should; anything else means it
    // is, and the accumulator must stay out of the way -- including when it
    // returns `undefined`, which is "hold this frame", not "no opinion".
    const external = hooks.tick ? hooks.tick() : null;
    if (external !== null) {
      if (external !== undefined) setT(external, { seek: false });
      // Keep the accumulator level with wherever the external clock has got to,
      // so handing back on pause resumes smoothly instead of jumping a frame.
      acc = 0;
    } else if (state.playing) {
      acc += dt * STEPS_PER_SEC;
      if (acc >= 1) {
        setT((state.t + Math.floor(acc)) % n, { seek: false });
        acc -= Math.floor(acc);
      }
    }
    if (state.particles) {
      particles.update(dt, state.t);
      dirty = true;
    }
    if (map.stepCamera()) dirty = true;

    if (dirty) {
      map.draw(state.particles ? (cx, m) => particles.draw(cx, m) : null);
      dirty = false;
    }
    requestAnimationFrame(loop);
  }

  // ---- controls ---------------------------------------------------------
  $('slider').addEventListener('input', (e) => setT(+e.target.value));

  $('play').addEventListener('click', () => {
    state.playing = !state.playing;
    $('play').textContent = state.playing ? 'Pause' : 'Play';
    // Inside the click, so a hook that needs a user gesture -- an AudioContext
    // cannot be built without one -- still has it.
    if (hooks.onPlayToggle) hooks.onPlayToggle(state.playing);
  });

  function toggle(id, fn) {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      fn(on);
      dirty = true;
    });
  }

  toggle('tFootprint', (on) => { map.layers.footprint = on ? 1 : 0; });
  toggle('tFlux', (on) => {
    map.layers.flux = on ? 0.85 : 0;
    $('fluxLegend').hidden = !on;
  });
  toggle('tFactories', (on) => {
    map.layers.factories = on ? 1 : 0;
    $('factoryLegend').hidden = !on;
  });
  toggle('tParticles', (on) => {
    state.particles = on;
    if (!on) particles.clear();
  });
  toggle('tModel', (on) => { ts.setAlpha({ model: on ? 1 : 0 }).draw(); });
  toggle('tZoom', (on) => {
    state.zoom = on;
    map.flyTo(on ? nearView : wideView);
  });
  toggle('tTable', (on) => {
    $('tableWrap').classList.toggle('open', on);
    if (on) fillTable();
  });

  function fillTable() {
    if (tableFilled) return;
    tableFilled = true;
    const head = $('dataTable').querySelector('thead tr');
    head.innerHTML =
      `<th scope="col">Time (UTC)</th><th scope="col">Observed ${data.speciesLabel} (${data.units})</th>` +
      (data.has.model ? `<th scope="col">Modelled ${data.speciesLabel} (${data.units})</th>` : '') +
      (data.has.landFrac ? '<th scope="col">Footprint over land</th>' : '');

    const cur = data.current;
    const b = cur.baseline ?? 0;
    const cell = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
    const rows = data.series.timeMs.map((_, i) => {
      let r = `<tr><td>${formatTime(data.time(i))}</td><td>${cell(cur.obs && cur.obs[i])}</td>`;
      if (data.has.model) r += `<td>${cell(cur.modelled[i] + b)}</td>`;
      if (data.has.landFrac) r += `<td>${Math.round(data.series.landFrac[i] * 100)}%</td>`;
      return `${r}</tr>`;
    });
    $('dataTable').querySelector('tbody').innerHTML = rows.join('');
  }

  // Keyboard scrubbing, since the slider is the primary control.
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const day = Math.round(24 / (data.meta.timeStepHours || 1));
    if (e.key === 'ArrowRight') setT(state.t + (e.shiftKey ? day : 1));
    else if (e.key === 'ArrowLeft') setT(state.t - (e.shiftKey ? day : 1));
    else if (e.key === ' ') { e.preventDefault(); $('play').click(); }
    else return;
    e.preventDefault();
  });

  // ---- fit to one screen ------------------------------------------------
  // The CSS clamp on --map-w gets close without any JS, but it has to guess the
  // header's height, and that depends on how the standfirst wraps and whether
  // the site has a species row. Measuring beats guessing.
  //
  // This runs on every resize rather than once, because the window here is not
  // a fixed thing -- an embedded editor preview gets dragged around constantly,
  // and the map should follow it.
  const wrapEl = document.querySelector('.wrap');
  const stageEl = document.querySelector('.stage');
  const shellEl = document.querySelector('.map-shell');

  function fitToViewport() {
    // Portrait and phone layouts want a full-width, taller map and expect to
    // scroll; the media query owns those, so leave the CSS value alone.
    if (window.innerWidth < 860) {
      wrapEl.style.removeProperty('--map-w');
      return;
    }
    // One pass is exact. Both inputs are invariant under the thing we are about
    // to change: the header no longer rewraps when the map resizes (the column
    // is a fixed width now), and `rows` is a difference that cancels the map's
    // own height out. When the column was pinned to the map this needed two.
    const rows = stageEl.getBoundingClientRect().height - shellEl.getBoundingClientRect().height;
    wrapEl.style.setProperty(
      '--map-w',
      `${fitMapWidth({
        viewportH: window.innerHeight,
        // offsetTop rather than a viewport rect: scroll-independent, so a
        // resize part-way down the page measures the same as one at the top.
        aboveStage: stageEl.offsetTop,
        stageRows: rows,
        // Never wider than the column it sits in.
        max: stageEl.clientWidth,
      })}px`,
    );
  }

  const onResize = () => { fitToViewport(); map.resize(); ts.resize(); ts.draw(); dirty = true; };
  window.addEventListener('resize', onResize);
  // Run it once now: the canvases were sized from the CSS default in their
  // constructors, so they need re-measuring against the fitted width.
  onResize();

  // Open on the strongest event of the period -- a better first impression than
  // an arbitrary midnight. Prefer the largest *observed* spike: that is the
  // thing the reader is looking at, and the biggest events are the ones where
  // the plume is parked over a source. Land fraction is a poor stand-in here --
  // its maximum is some unremarkable hour with the footprint pinned inland,
  // while the real spikes sit around a third to a half land.
  const rank = data.has.obs
    ? data.current.obs.map((v) => (v == null ? -Infinity : v))
    : driver || [];
  let peak = 0;
  let best = -Infinity;
  for (let i = 0; i < rank.length; i++) {
    if (Number.isFinite(rank[i]) && rank[i] > best) { best = rank[i]; peak = i; }
  }
  setT(peak);
  ts.draw();
  loader.classList.add('done');
  requestAnimationFrame(loop);

  return { data, map, ts, particles, state, setT, n };
}
