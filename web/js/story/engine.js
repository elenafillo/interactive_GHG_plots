/**
 * The deck machinery, with no story in it.
 *
 * Everything here is true of *any* site: what a caption may say, how a frame
 * override is resolved, how an act's play window becomes frame indices, how a
 * list of acts flattens into the sequence the right-arrow walks. The story --
 * which hour is the dirty day, what the captions are, where the air is released
 * from -- lives in a `beats-<site>.js` next door and is handed in as a spec.
 *
 * Split out of `beats.js` when the second deck arrived. The rule for the split
 * was mechanical: if a second site would want it unchanged, it is here; if a
 * second site would want to say something different, it is in the deck spec.
 *
 * No DOM, no canvas, no imports -- so the headless suite can assert on every
 * caption, camera and frame without a browser.
 *
 * ---
 *
 * A **deck spec** is a plain object. `buildDeck` reads these keys:
 *
 *   frames   {clean, dirty, peak, ...}  the moments, as frame indices
 *   flags    {...}                      story switches the acts branch on
 *   acts(f, flags) -> [act]             the acts, given resolved frames
 *
 * and `deck.js` reads several more (`data`, `species`, `gasWord`, `smell`,
 * `tzOffsetH`, `releases`, `next`). Those are documented on the specs
 * themselves, since what they mean is a fact about a site rather than about
 * the engine.
 */

/**
 * Words that must never appear on screen.
 *
 * The audience is families. Every one of these has a plain-English replacement
 * that is already in use in the captions: footprint -> "what it can smell",
 * emissions -> "where it comes from", enhancement -> "a lot".
 */
export const BANNED_WORDS = [
  'footprint', 'flux', 'enhancement', 'inversion', 'inverse', 'ppb', 'ppt',
  'baseline', 'sensitivity', 'lagrangian', 'dispersion', 'advection',
  'mole fraction', 'anomaly', 'boundary layer', 'concentration', 'timeseries',
  'parameterisation',
];

/** Hard cap. One line, read from the back of a room, in the time you say it. */
export const MAX_CAPTION_WORDS = 10;

export const countWords = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/** Which banned terms a caption contains, if any. */
export function bannedIn(caption) {
  const low = String(caption).toLowerCase();
  return BANNED_WORDS.filter((w) => low.includes(w));
}

// ---------------------------------------------------------------------------
// Frame overrides
// ---------------------------------------------------------------------------

/**
 * Resolve the deck's frames, letting a URL or a saved session move them.
 *
 * Precedence is URL > stored > default, so a link you paste into a talk is
 * reproducible no matter what the last person left in localStorage. An override
 * that is not a whole number inside the record is *ignored*, not clamped:
 * clamping turns a typo into a silently wrong slide, which is exactly the thing
 * a presenter cannot debug on stage.
 *
 * @param {string} search    location.search
 * @param {object|null} store  parsed localStorage payload, or null
 * @param {number} nTime     frame count, for validation
 * @param {object} defaults  the deck's own FRAMES, and the set of valid keys
 * @returns {{frames: object, source: object, rejected: string[]}}
 */
export function resolveFrames({
  search = '', store = null, nTime = Infinity, defaults = {},
} = {}) {
  const KEYS = Object.keys(defaults);
  const frames = { ...defaults };
  const source = Object.fromEntries(KEYS.map((k) => [k, 'default']));
  const rejected = [];

  const valid = (v) => Number.isInteger(v) && v >= 0 && v < nTime;

  if (store && typeof store === 'object') {
    for (const k of KEYS) {
      if (!(k in store)) continue;
      const v = Number(store[k]);
      if (valid(v)) { frames[k] = v; source[k] = 'stored'; }
      else rejected.push(`stored ${k}=${store[k]}`);
    }
  }

  const params = new URLSearchParams(search);
  for (const k of KEYS) {
    if (!params.has(k)) continue;
    const raw = params.get(k);
    const v = Number(raw);
    if (valid(v)) { frames[k] = v; source[k] = 'url'; }
    else rejected.push(`url ${k}=${raw}`);
  }

  return { frames, source, rejected };
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

/**
 * Layer state every stop starts from. A stop lists only what it changes, so a
 * caption edit cannot accidentally leave the emissions map switched on three
 * slides later.
 */
export const DEFAULT_LAYERS = {
  graticule: 0, station: 1, cities: 0,
  footprint: 0, flux: 0, contribution: 0, wind: 0, factories: 0,
  fluxHi: 0, srcFarming: 0, srcWaste: 0, srcFossil: 0,
  // The CFC-11 deck's five named regions. Listed here rather than only in that
  // deck's fork of the map because every stop of every deck carries a full layer
  // set -- a layer the table does not know about is one a stop can name and have
  // silently ignored, which the suite checks for and this is the cheap half of.
  // Costs the other two decks nothing: their exports carry no beacons, so the
  // layer draws nothing however it is set.
  beacons: 0,
};

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * Where a still picture may sit on the stage.
 *
 * A **closed set of named slots**, not x/y, and that is the whole design. The
 * deck's chrome already owns fixed regions -- the caption bottom-left, the meter
 * mid-right, the date bottom-right, the presenter panel across the bottom half
 * of the screen -- and a pair of coordinates in a beats file knows about none of
 * them. It would land on one of them the first time the deck met a projector
 * with a different aspect. A slot is a placement the stylesheet can honour on
 * any screen, and a name the suite can check.
 *
 * Two families:
 *
 *   - **Frame-relative** -- `top-left`, `top-right`, `left`, `right` -- pinned to
 *     the edge of the map, out of the way of whatever is on it.
 *   - **Centre-relative** -- `left-of-centre` and its three siblings -- pinned to
 *     the *middle of the map*, which is the point the camera centres on. On a
 *     stop framed at `CLIFF` that is the station itself, so `right-of-centre` is
 *     "beside the sensor" and stays beside it on any screen. They clear the
 *     centre by `--fig-gap` so the subject is never underneath the picture.
 *
 * And `card`, which is the case where the picture *is* the slide.
 *
 * ⚠ Lives here rather than in the stylesheet because the stylesheet cannot fail
 * a typo. `fig-top-rigth` is a class that matches no rule, so the image draws at
 * the container's origin -- top left, over the map, silently. The suite checks
 * every `at` against this list for the same reason it checks every layer name
 * against `DEFAULT_LAYERS`.
 */
export const FIGURE_SLOTS = [
  'top-left', 'top-right', 'left', 'right',
  'left-of-centre', 'right-of-centre', 'above-centre', 'below-centre',
  'card',
];

/**
 * How big, as three steps rather than a length.
 *
 * Same argument as the slots: a beats file has no business naming pixels, and
 * three named sizes are what the stylesheet can hold against a caption whose own
 * type is a `clamp`.
 */
export const FIGURE_SIZES = ['sm', 'md', 'lg'];

/**
 * Slot and size are not independent, and two pairs collide with chrome.
 *
 * `below-centre` grows toward the caption and `right-of-centre` toward the
 * meter, so at `lg` either can reach something that must never be covered -- the
 * caption is the one thing on screen that has to survive a bright hall. Both
 * are fine at `sm` and `md`, which is why this is a pair rule rather than a
 * shorter list of slots.
 */
export const CROWDED_SLOTS = ['below-centre', 'right-of-centre'];

/** Top-right at a middling size: out of the way, and big enough to read. */
export const DEFAULT_FIGURE = { at: 'top-right', size: 'md' };

/**
 * A stop's pictures, with the defaults filled in.
 *
 * Pure, so the suite can ask what a stop draws without mounting anything -- the
 * same reason every other decision in this file is here rather than in
 * `deck.js`. A stop with no `images` draws none, which is every stop of two of
 * the three decks.
 */
export function resolveFigures(stop) {
  return (stop.images || []).map((fig) => ({ ...DEFAULT_FIGURE, ...fig }));
}

/**
 * Build a deck from its spec.
 *
 * An *act* is a beat of the story; a *stop* is one press of the right-arrow.
 * Splitting them lets a single idea land in two or three moves -- fade the
 * emissions map up, then name what is on it, then say it is only a guess --
 * without either cramming three sentences onto a slide or inventing three acts
 * for one idea.
 *
 * `play.from`/`play.to` are **offsets in hours from the act's anchor frame**, so
 * retiming an act by dragging the scrubber slides its animation window with it
 * instead of leaving the window behind. An act with `anchor: null` reads them as
 * absolute frame indices, with 'end' meaning the last frame.
 *
 * The defaulting below is the reason acts can be written as sparsely as they
 * are: a stop names only the layers it changes and only the hour it disagrees
 * with, and everything else is filled in from the act and from DEFAULT_LAYERS.
 *
 * @param {object} spec    the deck spec: {frames, flags, acts}
 * @param {object} frames  resolved frames, overriding spec.frames
 * @param {object} flags   story switches, overriding spec.flags
 */
export function buildDeck(spec, frames = {}, flags = {}) {
  const f = { ...spec.frames, ...frames };
  const on = { ...spec.flags, ...flags };

  return spec.acts(f, on).map((act) => ({
    ...act,
    needs: act.needs || [],
    enabled: act.enabled !== false,
    stops: act.stops.map((s) => ({
      ...s,
      needs: s.needs || act.needs || [],
      layers: { ...DEFAULT_LAYERS, ...s.layers },
      t: s.t ?? (act.anchor ? f[act.anchor] : f.clean),
    })),
  }));
}

/**
 * Turn an act's play window into absolute frame indices.
 *
 * Kept out of buildDeck so the beat list stays declarative and this stays
 * unit-testable: "does moving the anchor move the window" is the behaviour worth
 * pinning down, and it is one function.
 *
 * ⚠ `play.from`/`play.to` are **hours**, and a frame is `stepHours` of them.
 * This used to add the offset to the anchor frame directly, which is the same
 * arithmetic only where a frame is an hour -- true at Ridge Hill and nowhere
 * else. At a 2-hourly export every window ran to twice its stated length, and
 * silently: the deck plays, it just plays too far. Ridge Hill divides by 1 and
 * is unchanged, which is what the suite's play-window checks pin down.
 *
 * @param {number} stepHours  hours per frame, from `meta.timeStepHours`
 */
export function resolvePlay(play, { anchor, frames, nTime, stepHours = 1 }) {
  if (!play) return null;
  const clamp = (v) => Math.max(0, Math.min(nTime - 1, Math.round(v)));
  const base = anchor ? frames[anchor] : 0;
  // An act with no anchor reads from/to as absolute frame indices, so there is
  // nothing to convert -- the hours are an offset *from a moment*, and it has
  // no moment.
  const abs = (v) => (v === 'end' ? nTime - 1 : anchor ? base + v / stepHours : v);
  return {
    from: clamp(abs(play.from)),
    to: clamp(abs(play.to)),
    stepsPerSec: play.stepsPerSec || 9,
    holdAt: (play.holdAt || [])
      .map((k) => (typeof k === 'string' ? frames[k] : k))
      .filter((v) => Number.isFinite(v))
      .map(clamp)
      .sort((a, b) => a - b),
  };
}

/**
 * Flatten acts to the linear list the right-arrow key walks.
 *
 * ⚠ **`anchor` falls back to the act's rather than replacing it.** This wrote
 * `act.anchor` unconditionally, which silently threw away a stop-level one --
 * and the failure is invisible rather than loud: `[` and `]` on such a stop
 * would nudge the *act's* moment, redraw nothing, and leave the presenter
 * pressing a key that appears dead while quietly moving another slide's hour.
 * The beacons act is the case that found it: anchored on `clean`, with five
 * stops that each name their own hour outright. No stop in any deck declares an
 * `anchor` today, so every existing slide resolves exactly as before.
 */
export function toSlides(acts) {
  const out = [];
  acts.filter((a) => a.enabled).forEach((act, ai) => {
    act.stops.forEach((stop, si) => {
      out.push({ ...stop, actId: act.id, actTitle: act.title, actIndex: ai, stopIndex: si, anchor: stop.anchor ?? act.anchor, chart: !!act.chart, picks: act.picks || null });
    });
  });
  return out;
}

/**
 * Where an act's `picks` point, as indices into the flat slide list.
 *
 * An act can name a handful of its own stops by `id` and say "these are
 * reachable out of order" -- the beacon game's five regions, where the
 * presenter asks the room which one to look at and clicks it. Everything else a
 * pick needs (the frame, the camera, the beacon states, the bar) already
 * follows from `go(i)`, so a pick is nothing more than a slide index with a
 * button in front of it.
 *
 * Here rather than in `deck.js` because this half has no DOM and no canvas,
 * which is what lets the suite assert "every button on screen lands on a real
 * slide" without mounting anything. A dead button is the one failure that would
 * otherwise surface in front of an audience: it looks perfectly fine until it
 * is pressed.
 *
 * ⚠ **Throws rather than skipping a name it cannot find.** A silently dropped
 * pick is four buttons where the deck promised five, and the letters would
 * quietly shift along the row -- so the button labelled D would run C's hour.
 * Failing at mount puts it in the console before the room is in the seats.
 *
 * @param {object[]} slides  the output of `toSlides`
 * @param {string[]} picks   stop ids, in the order the buttons are to read
 */
export function pickTargets(slides, picks = []) {
  return picks.map((id) => {
    const k = slides.findIndex((s) => s.id === id);
    if (k < 0) throw new Error(`story: pick "${id}" names no stop`);
    return k;
  });
}
