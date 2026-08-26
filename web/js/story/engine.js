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
};

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

/** Flatten acts to the linear list the right-arrow key walks. */
export function toSlides(acts) {
  const out = [];
  acts.filter((a) => a.enabled).forEach((act, ai) => {
    act.stops.forEach((stop, si) => {
      out.push({ ...stop, actId: act.id, actTitle: act.title, actIndex: ai, stopIndex: si, anchor: act.anchor, chart: !!act.chart });
    });
  });
  return out;
}
