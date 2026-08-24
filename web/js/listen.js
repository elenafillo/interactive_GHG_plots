/**
 * Entry point for listen.html: the explorer and the sonification, one Play button.
 *
 * The two used to be separate pages, run side by side with Play pressed on each
 * at roughly the same moment. They were already the same speed -- the sonifier's
 * default 135 BPM is 9 steps a second, which is exactly the map's own rate -- so
 * what was missing was a shared start and a shared clock, not a shared tempo.
 *
 * The audio clock is the master. A wall-clock rAF accumulator and an
 * AudioContext are two different clocks and will drift apart over an eight-week
 * archive, so while sound is playing the picture follows `engine.poll()`, which
 * reports where the sound has actually got to. When sound is stopped the
 * explorer's own accumulator takes back over and the page behaves as it always
 * did.
 *
 * Mixing and mapping stay in sound-lab.html. This page is for hearing the score
 * against the picture, not for tuning it.
 */

import { mountExplorer } from './explorer.js';
import { Sonifier } from './sonify.js';
import { AudioEngine } from './audio.js';
import { PianoRoll } from './pianoroll.js';
import { subscribeTuning } from './tuning.js';

const $ = (id) => document.getElementById(id);

const hooks = {};

// Gosan 2016 and HFC-23: the one export with a plant list, and the gas the whole
// mapping was calibrated against. Pinned rather than switchable because the
// pitched layer is percentile-ranked against this gas's own distribution.
const ex = await mountExplorer({
  defaultData: 'data-gsn/',
  pinSpecies: 'hfc-23',
  hooks,
});

// mountExplorer returns null when the data could not be loaded, having already
// put the reason on screen. Nothing below would have anything to run against.
if (ex) {
  const score = new Sonifier(ex.data);
  const engine = new AudioEngine();
  engine.attach(score);
  engine.setGain('master', +$('vol').value);

  /**
   * The nearest row to an absolute step.
   *
   * Only needed for a click that lands on one of the missing days, which the
   * roll draws hatched -- there is no frame there to show, so the map goes to
   * the closest one either side.
   */
  function rowNear(step) {
    for (let d = 0; d < score.nSteps; d++) {
      const a = score.rowAt[step + d];
      if (a !== undefined && a >= 0) return a;
      const b = score.rowAt[step - d];
      if (b !== undefined && b >= 0) return b;
    }
    return 0;
  }

  const roll = new PianoRoll($('roll'), score, ex.data, {
    onSeek: (s) => ex.setT(rowNear(s)),
  });
  window.addEventListener('resize', () => roll.resize().draw());
  // The explorer opened on the biggest spike of the period, before any of this
  // existed to be told about it.
  roll.setStep(score.absOf[ex.state.t]);

  /**
   * The explorer counts rows; the score counts two-hour slots.
   *
   * They are not the same number. The Gosan archive is missing five days, and
   * the score plays those as rests rather than splicing them out -- so 1044 rows
   * span 1104 steps, and by the end of the summer the two indices are five days
   * apart. `absOf` and `rowAt` are the translation, and they already exist on
   * the Sonifier; `rowAt` is -1 for a step the archive has nothing for.
   */
  hooks.tick = () => {
    if (!engine.playing) return null; // hand back to the explorer's accumulator
    const at = engine.poll();
    if (!at) return undefined; // clock has not reached a new step yet
    // The roll follows the true step, not the row, so its playhead keeps
    // travelling across the hatched missing days while the map holds.
    roll.setStep(at.step);
    const row = score.rowAt[at.step];
    // A missing day: the music rests and the map has nothing to show, so hold
    // the last frame rather than jumping to an unrelated one.
    return row >= 0 ? row : undefined;
  };

  hooks.onTime = (row, { userSeek }) => {
    if (userSeek) engine.seek(score.absOf[row]);
    // While the engine is running it owns the roll, from hooks.tick above.
    if (!engine.playing) roll.setStep(score.absOf[row]);
  };

  hooks.onPlayToggle = (on) => {
    // Called from inside the click handler, which is the user gesture an
    // AudioContext needs; the graph is built on the first start().
    if (on) engine.start(score.absOf[ex.state.t]);
    else engine.stop();
  };

  $('vol').addEventListener('input', (e) => engine.setGain('master', +e.target.value));

  // ---- live retuning from the sound lab ---------------------------------
  // Open the lab in another tab and its Mapping knobs and its Layers mixer both
  // move the music here, mid-playback. Nothing is stored: reload and this page
  // is back to the defaults in sonify.js, whatever the lab's dials still read.
  //
  // The lab's master fader is deliberately not among them -- the volume control
  // in this page's own transport owns that, and two writers would leave the
  // slider sitting somewhere that no longer matches what is coming out.
  function applyOpts(patch) {
    score.setOpts(patch);
    // Tempo is the one that is owned in two places -- the score computes the
    // step length from it, the engine caches that length for the scheduler.
    if ('bpm' in patch) engine.setTempo(patch.bpm);
    roll.draw();
  }

  // Gains and mutes are the engine's, not the score's, so they need no rebuild.
  // Setting one before the first Play is safe: with no AudioContext yet, the
  // engine banks the value and applies it when it builds the graph.
  const applyMix = (key, value) => engine.setGain(key, value);
  const applyMute = (key, value) => { engine.muted[key] = value; };

  // The status line has to separate four states, because three of them used to
  // look identical -- blank. No lab open, a lab open but untouched, a lab open
  // and retuning, and two tabs that disagree about the message shape. That last
  // one is what an edited-while-open page looks like, and it is silent: the
  // older side drops what it does not understand and nothing sounds different.
  let live = { connected: false, protocolOk: true };
  let summary = '';

  function showTuned() {
    const el = $('tuned');
    if (!live.connected) el.textContent = '';
    else if (!live.protocolOk) {
      el.textContent = 'sound lab connected, but the two tabs are running different '
        + 'versions of this page — reload both';
    } else if (summary) el.textContent = `retuned from the sound lab — ${summary}`;
    else el.textContent = 'sound lab connected — nothing retuned yet';
  }

  subscribeTuning({
    // The lab may already be open with knobs moved, so it is asked on startup.
    onState: ({ opts, mix, mutes, summary: s }) => {
      applyOpts(opts);
      for (const [key, value] of Object.entries(mix)) applyMix(key, value);
      for (const [key, value] of Object.entries(mutes)) applyMute(key, value);
      summary = s;
      showTuned();
    },
    onPatch: ({ kind, key, value, summary: s }) => {
      if (kind === 'mix') applyMix(key, value);
      else if (kind === 'mute') applyMute(key, value);
      else applyOpts({ [key]: value });
      summary = s;
      showTuned();
    },
    onPresence: (p) => { live = p; showTuned(); },
  });

  const s = score.stats();
  $('soundNote').innerHTML =
    'Two things are sounding, and they are independent. <strong>Struck notes</strong> are model ' +
    'geometry — a reported HFC-23 plant fires once each time the footprint arrives over it, ' +
    'pitched by region and panned by longitude. The <strong>sustained tone</strong> is the ' +
    'measurement itself, and it goes quiet over the stretches with no reading — ' +
    `${s.notesInGaps} of the ${s.notes} plant notes land there, the model playing on alone. ` +
    'A hit means the station was well placed to smell that plant, <strong>not that the plant ' +
    'emitted</strong> — the two layers are never gated on each other. ' +
    `${s.silentBars} whole days are absent from the archive and are heard as silence. ` +
    'Per-layer mixing and the mapping controls are in the <a href="sound-lab.html">sound lab</a>.';
}
