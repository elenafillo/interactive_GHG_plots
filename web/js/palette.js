/**
 * Colour system for the essay.
 *
 * Roles, not hexes, everywhere else in the codebase. Two sequential ramps carry
 * magnitude (footprint sensitivity, emissions) and two categorical slots carry
 * series identity (observed CH4, modelled CH4). The categorical pair was
 * validated on the #fcfcfb surface: worst all-pairs CVD dE 24.7, normal-vision
 * dE 33.6, both series >= 3:1 contrast. The ramps are single-hue and monotone in
 * lightness; their light ends deliberately recede into the surface, which is the
 * sequential rule (near-zero should disappear) rather than an ordinal one.
 */

export const C = {
  surface: '#fcfcfb',
  page: '#f4f4f1',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  hairline: 'rgba(11,11,11,0.10)',

  // Categorical slots 1 and 2.
  obs: '#2a78d6',
  model: '#eb6834',

  // Categorical slot 3: point sources on the map. This is step 5 of the
  // emissions ramp rather than a new hue, which is the point -- the violet
  // family already means "emissions" here, so plotting emission *sources* in it
  // reads as the same idea in a different mark type instead of a fourth colour
  // the reader has to learn. Validated as a categorical triple against obs and
  // model on the #fcfcfb surface: worst pair factory-obs, CVD dE 13.0 (deutan),
  // normal-vision dE 16.3, all three above 3:1 contrast. Identity is not
  // carried by colour alone in any case -- the station is a circle and a
  // factory is a diamond.
  factory: '#4a3aa7',

  // Same marker with the plume overhead -- footprint sensitivity at or above
  // 10^litLog10 in that plant's cell. A state change, not a third category, so
  // it is deliberately loud. Yellow separates cleanly from the orange plume it
  // sits on: CVD dE 19.5 (deutan), 23.2 (tritan), normal-vision 25.3.
  factoryLit: '#f5d000',

  // Map furniture. Kept low-chroma so the data layers own all the colour.
  ocean: '#e8eef4',
  oceanDeep: '#dde6ef',
  land: '#eceae2',

  // One grey for all linework: coastlines, borders and marker edges. It has to
  // do two jobs at once, which is what fixes its value. As a marker edge it is
  // load-bearing -- yellow on the pale end of the plume ramp is 1.03:1, i.e.
  // invisible, so without an outline a lit marker vanishes exactly where the
  // footprint is faint. As a hairline it has to stay recessive. Measured against
  // every background it lands on, this reaches 3.2:1 on land, 3.3:1 on ocean and
  // 3.2:1 on the palest plume step while holding 2.8:1 on the dark plume core.
  // The one weak pairing is mid-plume orange (1.2:1), where luminance is close
  // by construction; there the hue difference and the marker fill carry it.
  mapEdge: '#84827a',
  station: '#0b0b0b',
};

// Sequential: footprint sensitivity (orange family, hue spread 13 deg).
const FOOTPRINT_RAMP = [
  '#fde4d6', '#fbc4a8', '#f79f76', '#eb6834', '#c94d1e', '#9c3812', '#6e2409',
];

// Sequential: emissions (violet family, hue spread 9 deg). A second magnitude
// layer needs its own hue so the "multiply" beat reads as two things overlaid.
const FLUX_RAMP = [
  '#e3e0f5', '#c5bfea', '#a397db', '#8272c9', '#6350b8', '#4a3aa7', '#372a80',
];

// Sequential, one per source family, for the deck's "where it comes from" card.
//
// These three are the only ramps in the codebase that must be told apart from
// *each other* rather than just from the surface, so they were picked by
// measurement rather than by taste. All-pairs CIEDE2000 at matched steps 3-6 --
// matched, because a reader separates two families at equal magnitude, and the
// pale steps below 3 are meant to recede into the surface anyway -- under normal
// vision and simulated deutan, protan and tritan: worst pair is
// waste-vs-fossil at step 3, dE 12.1 (protan), normal vision 25.8. Contrast on
// #fcfcfb: 2.7:1 / 3.5:1 / 4.7:1 at mid, 9.5:1 / 11.4:1 / 16.4:1 at the dark end.
//
// The obvious triple failed. Green/magenta/slate-blue collapses for deutans
// (magenta vs slate dE 2.9 at step 2, 7.1 at step 3) because both sit on the
// red-green confusion line; swapping the blue for a near-neutral charcoal moves
// the separation onto lightness, which no dichromacy touches, and doubles the
// worst pair. Charcoal carries a slight blue cast so it does not read as the
// warm grey of the land fill beneath it.
//
// Colour is not the only channel even so: the card introduces the three one at a
// time, each named by its own caption, before any of them share a frame.
const FARMING_RAMP = [
  '#dff0dc', '#b6dfb0', '#86c87e', '#54ad4e', '#388e36', '#276e27', '#194e1b',
];
// Sequential: wind speed, for the deck's arrows. Teal, and the one ramp here
// that deliberately breaks the rule stated at the top of this file.
//
// Every other sequential ramp lets its light end recede into the surface,
// because near-zero should disappear. That rule is for *area* fills. An arrow is
// a hairline, and a hairline that recedes does not read as "light wind" -- it
// reads as a hole in the field, which is a lie about the data. So the ladder was
// fixed first (CIE L* 54 down to 20, evenly spaced) and the hue and chroma found
// inside it, rather than the other way round.
//
// Measured, not eyeballed. Contrast of the *palest* step, which is the binding
// one: 3.33:1 on ocean, 3.08:1 on the deep-ocean end of the gradient, 3.23:1 on
// land -- so every step of the ramp clears 3:1 everywhere it can land. The
// gradient's bottom edge is what fixes this: at L* 56 the pale end measured
// 2.87:1 down there, which is why the ladder starts at 54.
//
// Separation, all-pairs CIEDE2000 under normal vision and simulated deutan,
// protan and tritan, worst step reported: coastline 12.3, station marker 12.4,
// plant markers 13.3, modelled series 31.0. Across the ramp itself, step 0 to
// step 6, dE 27.9 -- so "faster" is legible as well as ordered.
//
// The one close pair is the **observed** series at dE 7.5 (tritan), where teal
// and blue converge. It is not a co-presence: wind is only on `clean-wind` and
// the first `dirty` stop, neither of which shows the chart, and a self-test
// asserts no stop needs wind while the chart is up. Recorded rather than fixed,
// because moving the hue far enough to fix it costs the coastline separation,
// which *is* a co-presence -- arrows cross coastlines on every wind frame.
//
// Hue 205 was chosen on that trade. At 185 the coastline pair collapses to
// dE 3.5; at 215 it reaches 14.9 but the ramp stops reading as teal and closes
// on the observed blue. Colour is not the only channel in any case: arrow
// *length* carries speed as well, which is also why the dark end stops at
// L* 20 rather than near-black -- a black tip would compete with the station.
const WIND_RAMP = [
  '#0e8f97', '#048088', '#077076', '#026167', '#045257', '#054548', '#02363a',
];
const WASTE_RAMP = [
  '#f8dfee', '#efbadb', '#e08fc0', '#cc61a0', '#b03f80', '#8c2b62', '#661a44',
];
const FOSSIL_RAMP = [
  '#e0e1e2', '#bcbfc3', '#94989f', '#6d727b', '#4c515a', '#31353d', '#1a1d23',
];

/**
 * The CFC-11 deck's five beacons, in letter order A..E.
 *
 * One hue each, because these are five *places* the audience is asked to choose
 * between and a shared colour would make them one category with five labels.
 * Identity is not carried by colour alone in any case -- each beacon draws its
 * own letter, always, and the letter never changes.
 *
 * **Colour here is identity, never state.** The three states -- dark, lit, high
 * -- are carried by fill opacity, ring weight and radius within a beacon's own
 * hue, so a reader who cannot separate the five hues at all still sees which
 * ones are lit. That is the deck's rule and this is the one place it could most
 * easily have been broken.
 *
 * ⚠ **Unmeasured, unlike every other entry in this file.** Chosen by name at the
 * user's direction -- brown, orange, blue, green, pink -- and none of the
 * all-pairs CVD work above has been done on them. Two pairings to look at on
 * screen before the night, both against the plume they sit on top of:
 *
 *   - **B's orange against the footprint ramp**, which is the orange family.
 *     This is the beacon most likely to disappear exactly when it lights, since
 *     a lit beacon is by definition one with plume underneath it. Pushed toward
 *     amber to open the gap, and the three-pass stroke in `_drawBeacons` is what
 *     actually carries it.
 *   - **A's brown against the plume's dark end** (#6e2409), same reason, at the
 *     other end of the ramp.
 *
 * Green, pink and charcoal are the source families' hues and blue is the
 * observed series -- all four are free here, because this deck has no source
 * card and draws no chart on the beacon stops.
 *
 * **These are meant to be swapped.** `_beaconInk` in the story fork's mapview
 * chooses each letter's ink from the fill it actually lands on, so a new hue
 * cannot make a letter unreadable by surprise, and the suite's floor on that is
 * deliberately loose. Change a hex here and nothing else needs touching.
 *
 * The one thing worth knowing before you do: a fill in the **mid-luminance band**
 * clears 4.5:1 against neither black nor white -- there is a real dead zone
 * between them. C's blue started at #1f6ec4, which landed in it at the solid
 * state (4.4:1 whichever ink it was given); #1857a3 clears 5.8:1. Worst pairing
 * across all five hues and all three states today is 5.5:1, on the green.
 */
export const BEACON_COLOURS = ['#7a4a2b', '#e07a1f', '#1857a3', '#2f8f4e', '#d2529a'];

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A ramp sampled at t in [0,1], as [r,g,b]. */
export function sampleRamp(ramp, t) {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(ramp[i]);
  const b = hexToRgb(ramp[i + 1]);
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/**
 * Build a 256-entry RGBA lookup table for a uint8-encoded raster.
 *
 * Index 0 is reserved by the exporter for "nothing here" and stays fully
 * transparent. Opacity climbs with magnitude as well as colour, so a faint
 * footprint edge dissolves into the map instead of stopping at a hard line.
 *
 * `saturateAt` is where the ramp reaches its darkest step, as a fraction of the
 * encoded range. It exists so display contrast can be tuned without touching
 * the stored values: the atlas encodes all the way to the field's true maximum,
 * and the ramp saturates well below that so ordinary plumes are not left
 * washed out by the one extreme hour.
 */
export function buildLUT(ramp, {
  alphaMin = 0.05, alphaMax = 0.95, gamma = 0.6,
  saturateAt = 1, floorAt = 0, rampGamma = 1,
} = {}) {
  const lut = new Uint8Array(256 * 4);
  const span = Math.max(1e-6, saturateAt - floorAt);
  for (let i = 1; i < 256; i++) {
    const raw = (i - 1) / 254;
    // Below the floor the cell is drawn as nothing at all. Leaving the entry
    // zeroed is what makes it transparent, so this is a `continue`, not a clamp.
    if (raw < floorAt) continue;
    const t = Math.min(1, (raw - floorAt) / span);
    const [r, g, b] = sampleRamp(ramp, Math.pow(t, rampGamma));
    const a = alphaMin + (alphaMax - alphaMin) * Math.pow(t, gamma);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = Math.round(a * 255);
  }
  return lut;
}

/** Footprint LUT for a given export, honouring its display cut. */
export function footprintLUT(meta) {
  const { logMin, logMax, logDisplayMax } = meta.footprint;
  const saturateAt = logDisplayMax != null ? (logDisplayMax - logMin) / (logMax - logMin) : 1;
  return buildLUT(FOOTPRINT_RAMP, { saturateAt });
}

export const FLUX_LUT = buildLUT(FLUX_RAMP, { alphaMin: 0.08, alphaMax: 0.9, gamma: 0.7 });

/**
 * ===========================================================================
 * THE SOURCES CARD'S CONTRAST KNOBS -- change these by hand.
 * ===========================================================================
 *
 * Also adjustable live: press `T` on the deck for the presenter panel, tune,
 * then `C` copies these three numbers back here as JSON ready to paste.
 *
 * `floor` and `ceil` are log10 of mol/m2/s, the units the rasters store. The
 * data is already log-scaled by the exporter; these decide which *part* of that
 * range the eye gets, which is a different question and the one that was
 * actually hurting contrast.
 *
 * Why these defaults. The emissions field is bimodal, and measurably so: a
 * histogram of the whole view has a background hump peaking at 10^-11.6, a
 * clean valley at 10^-9.4, and a source hump peaking at 10^-8.0. The old window
 * started at 10^-11.5, so more than a third of the map -- shipping lanes,
 * diffuse combustion, background farmland -- was painted as a dim wash that the
 * eye averages into mud, with the sources themselves compressed into the top
 * third of the ramp. `fossil` was the worst case: 95% of its cells non-zero and
 * a median of 21/255.
 *
 * Cutting at 10^-9.75, just on the source side of the valley, hides 64% of the
 * cells while discarding 0.2% of the methane. That ratio is the whole argument:
 * what disappears is area, not substance.
 *
 * `gamma` then stretches what is left. Above 1 it holds the low end light and
 * saves the dark steps of each ramp for the genuinely large sources, which is
 * the "low ones light, high ones prominent" shape. Below 1 does the opposite.
 */
export const SOURCE_DISPLAY = {
  floor: -9.75,
  ceil: -7.0,
  gamma: 1.35,
};

/**
 * The same three knobs, per gas, for a deck whose field is not methane's.
 *
 * These are absolute log10 of mol/m2/s, so they cannot be shared between gases:
 * HFC-23's entire field inside the Gosan view runs 10^-21.4 to 10^-10.1, which
 * is *below* methane's floor everywhere. Handing it `SOURCE_DISPLAY` paints the
 * map empty -- not dim, empty -- which is a blank slide with a caption pointing
 * at it.
 *
 * ⚠ **Gosan's are a measured starting point, not a tuned look.** The floor is
 * where the top 95% of the view's mass sits and the ceiling is the field
 * maximum. Methane's came off a bimodal histogram with a clean valley to put the
 * floor in; HFC-23's has no valley — one broad hump peaking near 10^-13 — so
 * there is no principled cut here, only a defensible one. Press `T` and move it.
 */
export const SOURCE_DISPLAY_BY_SPECIES = {
  'hfc-23': { floor: -12.25, ceil: -10.25, gamma: 1.35 },
  /**
   * CFC-11's is **not an inventory** — it is 40 Gg/yr spread by 2015
   * population, the guess an inversion starts from when nothing is known — and
   * unlike the other two it drives the *coarse* `flux.png` rather than a
   * sources card, because this deck has no hi-res rasters at all.
   *
   * Same rule as HFC-23's, applied to this field: the floor is where the top
   * 95% of the view's emission sits and the ceiling is the field maximum.
   * Measured inside the Gosan view (11,628 cells, 6,771 of them positive):
   * cutting at 10^-12.64 hides **41.5% of the positive cells while discarding
   * 5.0% of the emission**, and leaves 34% of the view painted.
   *
   * ⚠ That 5% is generous next to methane's 0.2%, and it is the honest cost:
   * this field has **no valley to cut in** — one broad hump peaking at
   * 10^-12.4 with a long thin tail — so any floor trades cells against
   * substance on a smooth curve. The alternative worth knowing is **-13.06**,
   * the 99%-of-emission cut: 25.6% of cells hidden, 1.0% of substance, 43% of
   * the view painted. That is the one to move to if the map reads too sparse
   * from the back of the room. Press `T`.
   */
  'cfc-11': { floor: -12.65, ceil: -10.7, gamma: 1.35 },
};

/**
 * The display window a given export should open on.
 *
 * Keyed off `meta.fluxHires.species`, which the exporter writes, so a deck gets
 * the right window by shipping the right data rather than by anyone remembering
 * to pass it. An unknown gas falls back to methane's rather than throwing: a
 * wrong-looking map is recoverable with `T` mid-talk, a dead deck is not.
 *
 * @param {object|null} meta  meta.fluxHires
 */
export function sourceDisplayFor(meta) {
  const key = meta && meta.species;
  return { ...(SOURCE_DISPLAY_BY_SPECIES[key] || SOURCE_DISPLAY) };
}

/**
 * The coarse `flux.png`'s LUT, honouring this gas's display window if it has one.
 *
 * The hi-res rasters have always separated what the PNG *encodes* from what the
 * eye *gets*; the coarse one never did, because methane's encoding window and
 * its display window were the same -11.5..-7.0 pair and `FLUX_LUT` spreading
 * itself over the whole byte range was already right.
 *
 * That stops being true for a gas whose field is encoded wide so it is not
 * clipped and then wants a narrow slice of that shown. So: a species with an
 * entry in `SOURCE_DISPLAY_BY_SPECIES` gets a windowed LUT, and **a species
 * without one gets `FLUX_LUT` itself** — the same object, not an equivalent
 * rebuild. Ridge Hill's methane map is therefore byte-for-byte what it was.
 *
 * @param {object|null} meta     meta.flux, for the encoded range and the species
 * @param {object|null} display  {floor, ceil, gamma}; defaults to the gas's own
 */
export function fluxLUT(meta, display = null) {
  const win = display || (meta && SOURCE_DISPLAY_BY_SPECIES[meta.species]);
  if (!meta || !win) return FLUX_LUT;
  const span = meta.logMax - meta.logMin;
  const at = (v) => Math.max(0, Math.min(1, (v - meta.logMin) / span));
  return buildLUT(FLUX_RAMP, {
    floorAt: at(win.floor),
    saturateAt: at(win.ceil),
    rampGamma: win.gamma,
    // FLUX_LUT's own alphas, so the only thing the window changes is which part
    // of the field is drawn -- not how solid the drawn part looks.
    alphaMin: 0.08,
    alphaMax: 0.9,
    gamma: 0.7,
  });
}

/**
 * One LUT per source family, keyed exactly as `meta.fluxHires.layers`.
 *
 * `total` reuses the violet emissions ramp on purpose: the card opens on the
 * same colour the reader has already been taught means "where methane comes
 * from", then breaks that one colour into three. Violet is never on screen at
 * the same time as the families, so it does not have to separate from them.
 *
 * Every family shares one window, which is not a detail: per-layer autoscaling
 * would make the smallest source look as strong as the largest, and comparing
 * them by eye is the entire point of the card.
 *
 * @param {object} meta     meta.fluxHires, for the encoded range
 * @param {object} display  {floor, ceil, gamma}; defaults to this gas's window
 */
export function buildSourceLUTs(meta, display = null) {
  const win = display || sourceDisplayFor(meta);
  const { logMin, logMax } = meta;
  const span = logMax - logMin;
  const at = (v) => Math.max(0, Math.min(1, (v - logMin) / span));
  const opts = {
    floorAt: at(win.floor),
    saturateAt: at(win.ceil),
    rampGamma: win.gamma,
    alphaMin: 0.1,
    alphaMax: 0.95,
    gamma: 0.75,
  };
  return {
    total: buildLUT(FLUX_RAMP, opts),
    farming: buildLUT(FARMING_RAMP, opts),
    waste: buildLUT(WASTE_RAMP, opts),
    fossil: buildLUT(FOSSIL_RAMP, opts),
  };
}

/**
 * Where the wind ramp reaches its darkest step, in m/s.
 *
 * Same separation of concerns as the footprint's `logDisplayMax`: the atlas
 * stores the field's true range and the ramp saturates below it, so ordinary
 * weather is not left washed out by the one extreme hour.
 *
 * Measured on the shipped export. Over the whole domain and all 232 steps the
 * median speed is 10.7 m/s and the 95th percentile 23.3; on the two framings the
 * wind acts actually use, the clean day runs a median of 13.2 (max 24.9 on
 * screen) and the dirty day 7.6 (max 17.8). Saturating at 22 puts the clean day
 * across most of the ramp with only its top few percent clipped, and leaves the
 * dirty day sitting visibly lower -- which is not a shortcoming to correct, it
 * is the story: the dirty day really is the lighter-wind one.
 *
 * Arrow length uses the same scale, so the two channels agree.
 */
export const WIND_SATURATE_MS = 22;

/**
 * Wind speed to an `rgb()` string, quantised.
 *
 * A wind frame paints on the order of a thousand arrows, and building a colour
 * string per arrow is the one part of that loop that allocates. 24 levels is
 * well past the point the eye resolves on a ramp spanning dE 28, so the strings
 * are built once and indexed.
 */
const WIND_LEVELS = 24;
const WIND_COLOURS = Array.from({ length: WIND_LEVELS }, (_, i) => {
  const [r, g, b] = sampleRamp(WIND_RAMP, i / (WIND_LEVELS - 1));
  return `rgb(${r},${g},${b})`;
});

export function windColour(speedMs, saturateAt = WIND_SATURATE_MS) {
  const t = Math.max(0, Math.min(1, speedMs / saturateAt));
  return WIND_COLOURS[Math.round(t * (WIND_LEVELS - 1))];
}

/**
 * Sequential: wind speed again, for the *released* air the deck follows.
 *
 * Two populations of one mark share the wind stops -- ambient tracers, which
 * are "the air, everywhere", and a released cohort, which is "*this* air, the
 * bit we are following". They have to read as the same kind of thing and not as
 * the same thing, so the cohort keeps the mark, the speed encoding and the
 * lightness ladder, and changes only its hue.
 *
 * **It is the plume ramp, not a new red.** Literally: the darker end of
 * `FOOTPRINT_RAMP`, resampled. The deck already has exactly one warm family and
 * it means "what the mast can smell", so air drawn in that family is the air
 * that arrives carrying something -- which is what the released cohort is, two
 * slides before the red patch lands on the cities. Deriving it rather than
 * copying seven hexes means retuning the plume retunes this with it.
 *
 * **Why only the darker end.** The plume ramp is an *area fill* ramp and its
 * light end is designed to recede into the surface. A trail is a hairline, and
 * a hairline that recedes reads as a hole in the field rather than as slow air
 * -- the same rule that fixed the teal's ladder. Measured on the shipped
 * backgrounds, the crossover is sharp and sits right here: cutting at 0.575
 * gives 2.97:1 on the deep-ocean end of the gradient and fails, and 0.6 gives
 * **3.38:1 on ocean, 3.13:1 on deep ocean, 3.28:1 on land** at the palest step,
 * which is the binding one. Every step clears 3:1 on everything it can land on.
 * The cut lands the ramp at L* 53.6 down to 25.6, within a step of the teal's
 * own 54-to-20 ladder, so the two populations sit at matched weights.
 *
 * Separation from the teal it shares every frame with, all-pairs CIEDE2000 at
 * matched steps under normal vision and simulated deutan, protan and tritan:
 * **37.4 / 29.2 / 22.3 / 43.7**. The worst case is protanopia at dE 22.3 --
 * three times the dE 7.5 the teal's own close pair was accepted at, and the two
 * never confuse. Against the rest of what a wind stop shows: coastline dE 20.6,
 * built-up areas dE 31.1. Across the ramp itself, step 0 to 6, dE 21.6.
 *
 * Colour is not the only channel even so. The cohort is drawn thicker, over a
 * pale halo, and it is the only air on screen trailing a line back to where it
 * started -- so it separates by weight and by behaviour as well as by hue.
 */
export const PARCEL_CUT = 0.6;

const toHex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

const PARCEL_RAMP = Array.from({ length: 7 }, (_, i) => toHex(
  sampleRamp(FOOTPRINT_RAMP, PARCEL_CUT + (1 - PARCEL_CUT) * (i / 6)),
));

const PARCEL_COLOURS = Array.from({ length: WIND_LEVELS }, (_, i) => {
  const [r, g, b] = sampleRamp(PARCEL_RAMP, i / (WIND_LEVELS - 1));
  return `rgb(${r},${g},${b})`;
});

/** Speed to an `rgb()` string for released air. Same scale as `windColour`. */
export function parcelColour(speedMs, saturateAt = WIND_SATURATE_MS) {
  const t = Math.max(0, Math.min(1, speedMs / saturateAt));
  return PARCEL_COLOURS[Math.round(t * (WIND_LEVELS - 1))];
}

export const RAMPS = {
  footprint: FOOTPRINT_RAMP,
  flux: FLUX_RAMP,
  total: FLUX_RAMP,
  farming: FARMING_RAMP,
  waste: WASTE_RAMP,
  fossil: FOSSIL_RAMP,
  wind: WIND_RAMP,
  parcel: PARCEL_RAMP,
};

/** CSS gradient string for legend swatches. */
export function rampGradient(ramp) {
  return `linear-gradient(90deg, ${ramp.join(', ')})`;
}
