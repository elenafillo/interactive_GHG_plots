/**
 * The workbench.
 *
 * A place to hear the mapping and retune it without touching the explorer.
 * Everything on this page is a control over sonify.js's options or a view of
 * what those options produced; the page itself makes no decisions.
 *
 * The piano roll follows the project's colour rules rather than inventing new
 * ones. Two jobs, two encodings: a plant hit's *strength* is a magnitude, so it
 * takes the emissions ramp light-to-dark, the same violet family the plant
 * markers already use on the map; the measurement layer is a different kind of
 * thing, so it takes the observation blue it wears on the chart. Region is
 * never carried by colour -- each region owns a register, so it is carried by
 * vertical position and a label on the axis, which survives both colour-blind
 * vision and a greyscale print.
 */

import { loadData, formatTime } from './data.js';
import { C } from './palette.js';
import { Sonifier, DEFAULTS, REGION_VOICES, midiToHz } from './sonify.js';
import { AudioEngine } from './audio.js';
import { PianoRoll } from './pianoroll.js';
import { publishTuning } from './tuning.js';

const $ = (id) => document.getElementById(id);
const loader = $('loader');

function fatal(err) {
  console.error(err);
  loader.classList.remove('done');
  $('loadMsg').innerHTML = `<strong>Could not start.</strong><br>${err && err.message ? err.message : err}`;
  $('loadBar').style.background = C.model;
}
window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

(async function main() {
  const params = new URLSearchParams(location.search);
  const base = params.get('data') || 'data-gsn/';

  let data;
  try {
    data = await loadData(base.endsWith('/') ? base : `${base}/`, (msg, frac) => {
      $('loadMsg').textContent = msg;
      $('loadBar').style.width = `${Math.round(frac * 100)}%`;
    });
  } catch (err) {
    $('loadMsg').textContent = `Could not load ${base}: ${err.message}. Serve this folder over HTTP.`;
    return;
  }

  // The lab is tuned against one gas. Switching would move every percentile the
  // pad is built from, and there is nothing to compare against yet.
  const wanted = params.get('species') || 'hfc-23';
  if (data.speciesKeys.includes(wanted)) data.setSpecies(wanted);

  const score = new Sonifier(data);
  const engine = new AudioEngine();
  engine.attach(score);

  const st = data.meta.station;
  document.title = `Sound lab · ${st.name}`;
  $('title').textContent = `Hearing what ${st.id} was breathing`;

  let stats = score.stats();

  const first = score.timeAt(0);
  const last = score.timeAt(score.nSteps - 1);
  const period = `${first.toUTCString().slice(5, 16)} – ${last.toUTCString().slice(5, 16)}`;

  $('standfirst').innerHTML =
    `Two things happen at every two-hour step, and they are independent: the ${data.speciesLabel} ` +
    `measured at <strong>${st.name}</strong>, and which reported plants the footprint was sitting on. ` +
    'The first is pitched and sustained, the second is struck. ' +
    `Twelve steps is a day, so <strong>one bar is one day</strong> — ${stats.bars} bars, ${period}.`;

  // ---- transport --------------------------------------------------------
  const timeline = $('timeline');
  timeline.max = String(score.nSteps - 1);
  let cur = 0;

  // Dragging the timeline fires `input` continuously, and a note per event would
  // be a smear rather than an audition. One every 70 ms is enough to hear what
  // is under the cursor without the drag turning into a glissando.
  let lastAudition = 0;
  function auditionable() {
    const now = performance.now();
    if (now - lastAudition < 70) return false;
    lastAudition = now;
    return true;
  }

  function setStep(step, { audition = false } = {}) {
    cur = Math.max(0, Math.min(score.nSteps - 1, step | 0));
    timeline.value = String(cur);
    const ev = score.eventsAt(cur);
    $('tstamp').textContent = ev.missing
      ? `${score.timeAt(cur).toUTCString().slice(5, 16)} · not in the archive`
      : formatTime(score.timeAt(cur));
    $('barPos').textContent = `bar ${ev.bar + 1}/${stats.bars} · beat ${ev.beat + 1}/${score.opts.stepsPerBar}`;
    if (audition && auditionable()) engine.preview(ev);
    roll.setStep(cur);
  }

  $('play').addEventListener('click', () => {
    if (engine.playing) {
      engine.stop();
      $('play').textContent = 'Play';
    } else {
      // The click is the gesture the AudioContext needs; nothing can sound
      // before one, so the graph is built here rather than at load.
      engine.start(cur);
      $('play').textContent = 'Pause';
    }
  });

  timeline.addEventListener('input', (e) => {
    const v = +e.target.value;
    engine.seek(v);
    setStep(v, { audition: !engine.playing });
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const day = score.opts.stepsPerBar;
    if (e.key === ' ') { e.preventDefault(); $('play').click(); return; }
    let next = null;
    if (e.key === 'ArrowRight') next = cur + (e.shiftKey ? day : 1);
    else if (e.key === 'ArrowLeft') next = cur - (e.shiftKey ? day : 1);
    else return;
    e.preventDefault();
    engine.seek(next);
    setStep(next, { audition: !engine.playing });
  });

  // ---- what is tunable, and what the listen page mirrors -----------------
  // Both tables sit here, ahead of the two panels that build their controls,
  // because the publisher below is assembled out of the pair of them.
  const LAYERS = [
    ['plants', 'Plant hits', 'model geometry — where the air had just been'],
    ['glow', 'Still lit', 'a visit continuing, not a fresh arrival'],
    ['pad', 'Reading', `measurement — ${data.speciesLabel} above baseline`],
    ['bass', 'Day tone', "the day's mean reading, on the bar line"],
    ['hat', 'Land/ocean', 'share of the footprint over land'],
  ];
  const KNOBS = [
    ['bpm', 'tempo (BPM)', 60, 200, 1, (v) => `${v} — ${(60 / (v * 4) * 1000).toFixed(0)} ms/step`],
    ['velocityDecades', 'velocity headroom (decades)', 0.4, 2.0, 0.05, (v) => v.toFixed(2)],
    ['padRoot', 'reading: root (MIDI)', 26, 74, 1, (v) => String(v)],
    ['padSpan', 'reading: degrees', 3, 20, 1, (v) => String(v)],
    ['bassRoot', 'day tone: root (MIDI)', 14, 50, 1, (v) => String(v)],
    ['landFracFullScale', 'land fraction full scale', 0.1, 1.0, 0.05, (v) => v.toFixed(2)],
    ['maxVoicesPerRegion', 'max notes per region', 1, 8, 1, (v) => String(v)],
    ['maxVoicesPerStep', 'max notes per step', 1, 20, 1, (v) => String(v)],
  ];

  /**
   * Everything currently away from its default, in the lab's own words.
   *
   * Composed here rather than on the listen page because this is where the
   * labels and the formatters already live, and there is no second copy of
   * them to drift.
   */
  function summarize() {
    const parts = [];
    for (const [key, label] of LAYERS) {
      // A muted layer's gain is inaudible, so naming both would be noise.
      if (engine.muted[key]) parts.push(`${label} muted`);
      else if (engine.gains[key] !== 1) parts.push(`${label} ×${engine.gains[key].toFixed(2)}`);
    }
    for (const [key, label, , , , fmt] of KNOBS) {
      if (score.opts[key] !== DEFAULTS[key]) parts.push(`${label} ${fmt(score.opts[key])}`);
    }
    return parts.join(' · ');
  }

  // listen.html retunes live off this while it is open. Only the keys named
  // above go out -- the rest of `opts` is derived from the archive's own
  // cadence, and the other page has its own archive to derive it from. Master
  // volume stays local: the listen page has its own slider wired to it, and a
  // remote write would leave that slider's position lying about the level.
  const tuning = publishTuning(() => ({
    opts: Object.fromEntries(KNOBS.map(([k]) => [k, score.opts[k]])),
    mix: Object.fromEntries(LAYERS.map(([k]) => [k, engine.gains[k]])),
    mutes: Object.fromEntries(LAYERS.map(([k]) => [k, engine.muted[k]])),
    summary: summarize(),
  }));

  // ---- mixer ------------------------------------------------------------
  const mixer = $('mixer');
  for (const [key, label, title] of LAYERS) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:150px';
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-pressed', 'true');
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      engine.muted[key] = !on;
      tuning.patch('mute', key, !on);
    });
    const sl = document.createElement('input');
    sl.type = 'range';
    sl.min = '0'; sl.max = '1.5'; sl.step = '0.01'; sl.value = '1';
    sl.addEventListener('input', () => {
      engine.setGain(key, +sl.value);
      tuning.patch('mix', key, +sl.value);
    });
    wrap.append(btn, sl);
    mixer.appendChild(wrap);
  }

  $('master').addEventListener('input', (e) => {
    engine.setGain('master', +e.target.value);
    $('vMaster').textContent = (+e.target.value).toFixed(2);
  });

  $('honesty').innerHTML =
    'A hit means the footprint reached that plant — the station was well placed to smell it during those hours. ' +
    '<strong>It does not mean the plant emitted.</strong> The two layers are never gated on each other: ' +
    `hits keep sounding through the ${stats.nSteps - stats.nObs - stats.missingSteps} steps with no measurement, ` +
    'where the pad is silent and the model is all there is.';

  // ---- regions ----------------------------------------------------------
  const regBox = $('regions');
  for (const r of score.regionSummary()) {
    const div = document.createElement('div');
    div.className = 'reg' + (r.voice ? '' : ' silent');
    const lo = r.midi[0];
    const hi = r.midi[r.midi.length - 1];
    const edges = stats.byRegion[r.id] || 0;
    div.innerHTML =
      `<strong style="min-width:74px">${r.id}</strong>` +
      `<span style="color:var(--ink2)">${r.label}</span>` +
      `<span class="n">${r.onGrid}/${r.n} on grid · ` +
      (r.voice ? `${r.voice} · MIDI ${lo}–${hi} · ${edges} notes` : 'silent') +
      '</span>';
    regBox.appendChild(div);
  }

  // ---- knobs ------------------------------------------------------------
  const knobs = $('knobs');
  for (const [key, label, min, max, step, fmt] of KNOBS) {
    const l = document.createElement('label');
    l.className = 'slider';
    const val = DEFAULTS[key];
    l.innerHTML = `<span>${label}</span><b id="k_${key}">${fmt(val)}</b>`;
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(val);
    inp.addEventListener('input', () => {
      const v = +inp.value;
      $(`k_${key}`).textContent = fmt(v);
      score.setOpts({ [key]: v });
      if (key === 'bpm') engine.setTempo(v);
      refreshStats();
      roll.draw();
      tuning.patch('opt', key, v);
    });
    l.appendChild(inp);
    knobs.appendChild(l);
  }

  // ---- stats ------------------------------------------------------------
  function refreshStats() {
    stats = score.stats();
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    const mmss = (s) => `${Math.floor(s / 60)}m ${Math.round(s % 60).toString().padStart(2, '0')}s`;
    const rows = [
      ['length', `${stats.nSteps} steps · ${stats.bars} bars · ${mmss(stats.durationSec)}`],
      ['archive', `${stats.nRows} rows present, ${stats.missingSteps} steps missing ` +
        `(${stats.silentBars} whole days absent — those bars are rests)`],
      ['grid', stats.uniformGrid ? 'every row lands on the 2-hour grid' : 'NOT uniform — bar lines are unreliable'],
      ['plant notes', `${stats.notes} arrivals · ${stats.notesPerStep.toFixed(3)}/step · ` +
        `${pct(stats.stepsWithNotesFrac)} of steps have one · densest step ${stats.maxPerStep}`],
      ['dropped by the caps', `${stats.dropped} notes`],
      ['notes by region', Object.entries(stats.byRegion)
        .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ')],
      ['notes with no reading', `${stats.notesInGaps} (${pct(stats.notesInGaps / Math.max(1, stats.notes))}) ` +
        '— the model playing on while the instrument was down'],
      ['observations', `${stats.nObs} of ${stats.nRows} rows`],
      ['r(reading, plants lit)', Number.isNaN(stats.correlation) ? '—'
        : `${stats.correlation >= 0 ? '+' : ''}${stats.correlation.toFixed(3)} — real, and a long way from deterministic`],
    ];
    $('stats').innerHTML = rows
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  }
  refreshStats();

  $('footnote').innerHTML =
    `Footprints: NAME, ${st.id}, ${period}, 2-hourly. Plant list: ${data.meta.factories ? data.meta.factories.nListed : 0} ` +
    `reported ${data.meta.factories ? data.meta.factories.label : ''} sites at ` +
    `${data.meta.factories ? data.meta.factories.nSites : 0} distinct locations, positions only — no capacities, ` +
    `so a hit says a plant is there and the air came past, not how much it emitted. A plant sounds when the ` +
    `footprint over it first reaches 10<sup>${data.meta.factories ? data.meta.factories.litLog10 : ''}</sup>; the note's ` +
    'strength is the peak sensitivity reached over that whole visit, which is more than the map shows — the ' +
    'marker is on or off. Wind is not mapped: this export carries zeros for it.';

  // ---- piano roll -------------------------------------------------------
  // The roll itself lives in pianoroll.js, because listen.html draws it too. It
  // reports a clicked step and leaves the transport to this page.
  const roll = new PianoRoll($('roll'), score, data, {
    onSeek: (s) => {
      engine.seek(s);
      setStep(s, { audition: !engine.playing });
    },
  });
  window.addEventListener('resize', () => roll.resize().draw());

  // ---- follow the sound -------------------------------------------------
  // The audio clock is the master. This only reads where it has got to.
  function tick() {
    if (engine.playing) {
      const at = engine.poll();
      if (at) setStep(at.step);
    }
    requestAnimationFrame(tick);
  }

  setStep(0);
  loader.classList.add('done');
  requestAnimationFrame(tick);
})();
