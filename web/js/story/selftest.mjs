/**
 * Headless checks for the story decks.
 *
 *   node web/js/story/selftest.mjs
 *
 * Separate from ../selftest.mjs on purpose: that suite covers the explorer and
 * is passing, and neither should be able to break the other's run.
 *
 * There is no browser automation in this project, so the things worth testing
 * are the ones that would otherwise only fail in front of an audience: a caption
 * that has quietly grown to three lines, a frame index that points past the end
 * of the record, a camera aimed outside the domain, and a retimed act whose
 * animation window stayed where it was.
 *
 * ---
 *
 * **The body is one function over a deck spec, run once per deck.** It used to
 * hardcode `web/data-rgl/` in four places and assert Ridge Hill's numbers
 * inline. What made that worth changing is not tidiness: the three bugs the
 * second deck surfaced -- hours read as frames, a shared localStorage key, UTC
 * assumed to be local -- were all invisible at Ridge Hill *by arithmetic*, and a
 * suite that only ever sees one site cannot see any of them. A second spec is
 * the instrument.
 *
 * Two rules hold this together, and both are load-bearing:
 *
 *   1. **Ridge Hill's half must stay at 464 checks with no expected value
 *      changed.** That count is the entire regression guarantee for the engine
 *      extraction. Nothing new may be added to a code path Ridge Hill takes --
 *      every check added here is behind a gate Ridge Hill does not pass through,
 *      which is also the honest place for it, since each one exists for a
 *      property Ridge Hill does not have.
 *   2. **A site's expected values live in `SITES`, not in the body.** The body
 *      asserts shapes; the table says what shape this site is. Where the two
 *      sites disagree about a number rather than about a rule -- how full the
 *      bar is on the quiet day, say -- the number is in the table.
 */

import { existsSync, readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import {
  MAX_CAPTION_WORDS, BANNED_WORDS, countWords, bannedIn,
  resolveFrames as resolveFramesWith, buildDeck, toSlides, resolvePlay, DEFAULT_LAYERS,
  FIGURE_SLOTS, FIGURE_SIZES, CROWDED_SLOTS, resolveFigures, pickTargets,
} from './engine.js';
import { DECK as RGL } from './beats-rgl.js';
import { DECK as GSN } from './beats-gsn.js';
import { DECK as CFC11 } from './beats-cfc11.js';

let failures = 0;
let count = 0;
const check = (name, ok, detail = '') => {
  count++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
/**
 * A section this site has nothing to say about, announced rather than dropped.
 *
 * Deliberately not a check: a skipped section is neither a pass nor a failure,
 * and counting it either way would make the totals lie. Printing it is what
 * stops "the suite is green" from quietly meaning "the suite ran four sections".
 */
const skip = (what, why) => console.log(`  --    ${what}  (${why})`);

/**
 * A minimal PNG reader: 8-bit grey or RGB/RGBA, no interlace, first channel
 * only. Lifted from `scripts/measure_seeding.mjs`, which decodes the same
 * atlases with node's own zlib so that there is nothing to install.
 *
 * Needed because the headless mount stubs `Image` -- the atlas there decodes to
 * zeros, which is fine for checking wiring and useless for checking what is
 * actually in the picture. The plants-lit claim is a claim about the pixels.
 */
function readPNG(file) {
  const buf = readFileSync(file);
  let off = 8; let w = 0; let h = 0; let depth = 0; let colour = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; colour = body[9];
      if (depth !== 8) throw new Error(`depth ${depth}`);
      if (body[12] !== 0) throw new Error('interlaced');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const chans = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * chans;
  const out = new Uint8Array(w * h);
  let p = 0;
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    raw.copy(line, 0, p, p + stride); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= chans ? line[i - chans] : 0;
      const b = prev[i];
      const c = i >= chans ? prev[i - chans] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = line[x * chans];
    prev.set(line);
  }
  return { data: out, width: w, height: h };
}

/**
 * The decks, and what each is expected to be.
 *
 * `engine` marks the pass that also runs the site-agnostic sections -- the wind
 * sampler's synthetic fields, the integrator, the palette ramps, the graticule
 * rule, the stylesheet's [hidden] trap. Those test `engine.js` and its
 * neighbours rather than a deck, so a second run of them would print four
 * hundred identical lines and prove nothing. They ride along with Ridge Hill
 * because that is also what keeps its half of the suite at exactly 464.
 */
const SITES = [
  {
    deck: RGL,
    dir: 'web/data-rgl',
    engine: true,
    /**
     * When each moment is, in the station's own local time. `says` is how the
     * check names itself, `is` is the stamp it demands. UTC here, which at Ridge
     * Hill in February is also local time -- the assumption that held for one
     * site and broke at the second.
     */
    times: {
      clean: { says: '2 Feb 12:00', is: '2020-02-02 12:00' },
      dirty: { says: '7 Feb 09:00', is: '2020-02-07 09:00' },
      peak: { says: '7 Feb 10:00', is: '2020-02-07 10:00' },
      recordLow: { says: '15 Feb 13:00', is: '2020-02-15 13:00' },
    },
    /** The deck argues from an emissions inventory, so the export must carry one. */
    expectSources: true,
    /**
     * No stop here puts a picture on the stage, so the whole figures section is
     * skipped rather than passed. ⚠ This flag is what keeps this deck at **464
     * checks** -- see rule 1 at the top. Every figure check is written per
     * *picture*, so a deck with none would add none even without the flag; the
     * flag is what stops "this deck has pictures" being asserted here at all.
     */
    expectImages: false,
    /** The deck's acts include stops gated `needs: ['wind']`. */
    expectWind: true,
    /** And this export carries the atlases those stops draw from. */
    expectWindData: true,
    /**
     * How full the bar reads at each moment. A band, not a number, because the
     * point is the shape of the scale rather than any one hour: a bar that says
     * "a lot" on the quiet day argues against the caption beside it.
     */
    bar: {
      clean: { says: 'a sliver, not a third of the bar', band: [0.05, 0.2] },
      dirty: 0.8,
      clipped: 8,
      /**
       * The same three readings again, but off the mounted deck's own DOM --
       * `meterFill.style.height` after `retime`, so what is asserted is the pixel
       * height a presenter sees rather than the arithmetic behind it. Percent
       * here, fractions above.
       *
       * `at` names the moment; a deck without that moment skips the row rather
       * than testing it, which matters more than it looks. `FRAMES.recordLow` is
       * `undefined` at Gosan, and `retime(undefined)` clamps to NaN, whose
       * reading is `undefined`, which `smellOf` maps to an empty bar -- so
       * "the storm empties it" would have passed there by arithmetic accident,
       * on a deck with no storm and no such moment.
       */
      mount: [
        { at: 'clean', says: 'the clean day barely registers', band: [5, 20] },
        { at: 'peak', says: 'the peak nearly fills it', band: [90, 100] },
        { at: 'recordLow', says: 'the storm empties it', band: [0, 0] },
      ],
    },
  },
  {
    deck: GSN,
    dir: 'web/data-gsn',
    engine: false,
    /**
     * KST, not UTC. Gosan is UTC+9, so these are the hours the plan names and
     * the hours a presenter reads -- 26 Jun 11:00 KST is 02:00 UTC. That the
     * deck agrees with this table is `tzOffsetH` doing its job; before it
     * existed every one of these would have been nine hours out.
     */
    times: {
      clean: { says: 'Mon 20 Jun 09:00 KST', is: '2016-06-20 09:00' },
      dirty: { says: 'Sun 26 Jun 11:00 KST', is: '2016-06-26 11:00' },
      peak: { says: 'Sun 26 Jun 19:00 KST', is: '2016-06-26 19:00' },
    },
    /**
     * False until the inventory lands (Brief A). An expectation rather than a
     * fact about the data on purpose: when the flux is wired in and the deck
     * grows its three purple stops, flipping this to true is what makes the
     * suite start demanding the raster.
     */
    expectSources: false,
    /** No pictures on this deck's stops either. See Ridge Hill's note. */
    expectImages: false,
    /**
     * ⚠ **These two were one flag, and the second deck is what pulled them
     * apart.** While Gosan had no wind acts written, "the deck has wind stops"
     * and "the export has a wind field" were false together and one flag covered
     * both. They are not the same claim, and now they disagree: the acts exist
     * and are gated, and the met does not exist and will not until Brief C.
     *
     * Which is the interesting state, not an awkward one — it is the deck
     * degrading, which is the thing this half of the suite is for. `expectWind`
     * true is what turns those checks on; `expectWindData` false is what stops
     * them demanding a file nobody has.
     */
    expectWind: true,
    expectWindData: false,
    /**
     * The quiet day reads **empty**, where Ridge Hill's reads as a sliver: it is
     * -0.6 ppt, genuinely below the background, so it clamps to zero. That is
     * the honest picture and not a scale that needs fixing -- but it is exactly
     * the reading the meter's third state exists for (§3), because an empty bar
     * on this deck must not be confusable with a missing one.
     */
    bar: {
      clean: { says: 'empty — it reads below the background', band: [0, 0] },
      // 62%, against Ridge Hill's 89%. The bar is scaled so the record maximum
      // (+42.6 ppt, the two-hour spike the deck deliberately does not stop at)
      // sits at 95% with nothing clipping, which leaves the episode itself
      // well short of full. That is the honest picture and not a scale to fix.
      dirty: 0.5,
      clipped: 0,
      /**
       * Two rows, not three: this deck has no `recordLow`, so the storm check is
       * skipped rather than passed on a moment that does not exist.
       *
       * The peak reads **68%** where Ridge Hill's reads 97%, and the quiet day
       * reads a flat **0** where Ridge Hill's reads 13. Both follow from `span`
       * being set by the record's own maximum -- the 25 Jun spike -- rather than
       * by the episode the deck actually stops at.
       */
      mount: [
        { at: 'clean', says: 'the clean day reads empty, not merely low', band: [0, 0] },
        { at: 'peak', says: 'the peak fills two thirds, and no more', band: [60, 75] },
      ],
    },
  },
  {
    /**
     * Gosan a third time -- same island, same footprints, CFC-11 over June and
     * July. **A scaffold deck**, so what this row is really guarding is that the
     * scaffold cannot rot quietly: the axis is 672 frames where `data-gsn` is
     * 1044, and every index in `beats-cfc11.js` was copied from a file written
     * against the longer one.
     *
     * It is also the first row where **the wind actually exists**. Gosan's is
     * `expectWind` true / `expectWindData` false -- the deck degrading. This one
     * is true / true, which is the other half of that pair finally being
     * exercised by a deck rather than only by Ridge Hill.
     */
    deck: CFC11,
    dir: 'web/data-gsn-cfc11',
    engine: false,
    /**
     * The page this deck is actually served from.
     *
     * ⚠ **Here because the DOM stub cannot see a missing tag.** `byId` builds an
     * element on demand for any id it is asked for, so a `#picks` absent from
     * the real HTML passes every headless check in this file and breaks only in
     * front of a projector. There is no browser automation here, so the only
     * thing that can catch it is reading the page as text.
     */
    page: 'story-cfc11.html',
    /**
     * The beacon game's five letter buttons, and the only act in any deck that
     * can be run out of order.
     *
     * An expectation rather than a fact read off the beats file, for the same
     * reason `expectImages` is one: if the `picks` list ever falls out of
     * `beats-cfc11.js` the suite has to fail, not quietly stop checking.
     */
    expectPicks: true,
    /**
     * KST, like Gosan's. Two moments, not three -- and note the order: the
     * **clean day is nine days after the dirty one**, which is a break with
     * both other decks and the reason `beats-cfc11.js` may not say "six days
     * later". If a re-export ever slides the axis, this table is what notices.
     */
    times: {
      dirty: { says: 'Sun 26 Jun 11:00 KST', is: '2016-06-26 11:00' },
      clean: { says: 'Tue 5 Jul 23:00 KST', is: '2016-07-05 23:00' },
    },
    /**
     * False, and it will stay false -- but no longer because there is nothing to
     * draw. `meta.flux` now carries the **population prior**: 40 Gg/yr spread by
     * where people live, which is a guess and not an inventory. There is no
     * CFC-11 inventory to have, and that is the deck's argument.
     *
     * `expectSources` is a claim about the sources *card* -- four rasters
     * decomposing a total into families -- and this deck has no families to
     * decompose into, so it stays false.
     *
     * ⚠ That is no longer the same statement as "`meta.fluxHires` is null",
     * which is what this comment used to say. Since the 1 km population prior
     * landed, `meta.fluxHires` exists and carries a **single** `total` layer.
     * `expectHiResFlux` below is the claim about that; the two flags are
     * deliberately separate, because a deck can have a hi-res map without
     * having an inventory to take apart.
     */
    expectSources: false,
    /**
     * The 1 km map, at 4800x2880 over the view -- WorldPop's own 30 arc-second
     * cells, unresampled. Two things it guards, neither of which is a crash:
     *
     *  - **the window.** `flux_hi.png` and `flux.png` must encode on the same
     *    log range, because `G` flips between them and a viewer reads that as a
     *    change of resolution, not a change of scale.
     *  - **the zoom.** These cells are 0.00833 deg. Drawn at `DOMAIN`'s span of
     *    30 they are 0.4 px each, so the layer would cost 4.5 MB to render as
     *    the same picture the 5 KB coarse raster already gives. A stop that
     *    turns `fluxHi` on has to be flown in far enough to see it.
     */
    expectHiResFlux: true,
    /**
     * The only deck with pictures on it, and the reason the machinery exists.
     *
     * An expectation rather than a fact read off the beats file, for the same
     * reason `expectSources` is: if `beats-cfc11.js` ever loses its `images`,
     * the suite must fail rather than skip. A check that passes by being
     * skipped is the failure mode a gate is most likely to introduce.
     */
    expectImages: true,
    /**
     * True since the prior landed. The failure this guards against is not a
     * crash: an encoding window that misses the field paints one flat byte
     * across the map, which still draws -- as a rectangle, or as nothing -- on
     * the one slide whose job is to show *where*.
     */
    expectFlux: true,
    /** Six stops are gated `needs: ['wind']` -- the clean-wind act and the dirty one. */
    expectWind: true,
    /** And unlike Gosan, this export ships the atlases. 224 steps at 77 m. */
    expectWindData: true,
    /**
     * The clean day reads a **sliver**, where the HFC-23 deck's reads flat
     * empty: +2.1 against a background of 232.4, so about 3% of a 68-wide bar.
     * That is the third distinct answer the three decks give to the same
     * question, which is exactly why the number lives in this table.
     */
    bar: {
      clean: { says: 'a sliver — nearly, but not quite, background', band: [0.01, 0.1] },
      // 65%, between Ridge Hill's 89% and Gosan's 62%. `span` is set by the
      // record's own maximum (+64.3, which lands at 95%) rather than by the
      // episode the deck stops at, the same rule as both other decks.
      dirty: 0.5,
      clipped: 0,
      /**
       * Two rows. No `peak` -- see the note on FRAMES in `beats-cfc11.js`: a
       * pause has to land on a frame someone has measured, and nobody has.
       */
      mount: [
        { at: 'clean', says: 'the clean day reads as a sliver, not as empty', band: [1, 10] },
        { at: 'dirty', says: 'the dirty day fills about two thirds', band: [55, 75] },
      ],
    },
  },
];

/**
 * Run every check against one deck.
 *
 * @param {object} site  a row of SITES: the deck spec, its data, its expectations
 */
async function runSite(site) {
  const { deck } = site;
  const FRAMES = deck.frames;
  const SMELL = deck.smell;
  console.log(`\n${'='.repeat(68)}\n${deck.id.toUpperCase()} — ${deck.title}\n${'='.repeat(68)}`);

  const META = `${site.dir}/meta.json`;
  if (!existsSync(META)) {
    console.error(`missing ${META} — run scripts/export_web_data.py --site ${deck.id.toUpperCase()} first`);
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync(META, 'utf8'));
  const series = JSON.parse(readFileSync(`${site.dir}/series.json`, 'utf8'));
  const nTime = meta.footprint.nTime;
  // Hours per frame. 1 only at Ridge Hill, which is the whole reason the
  // hours-as-frames bug survived 464 checks -- see the play-window section.
  const stepHours = meta.timeStepHours || 1;
  console.log(`dataset: ${meta.station.name}, ${nTime} frames at ${stepHours} h`);

  const acts = buildDeck(deck, FRAMES, deck.flags);
  const slides = toSlides(acts);

  /**
   * `resolveFrames` with this deck's own moments as the defaults.
   *
   * The engine takes the valid key set as an argument rather than closing over a
   * module-level `FRAMES` -- that binding is exactly what made the old code
   * site-specific. The shim supplied it invisibly; the suite now supplies it per
   * deck, which is the whole point of the exercise.
   */
  const resolveFrames = (opts = {}) => resolveFramesWith({ ...opts, defaults: FRAMES });

  // ---- captions ------------------------------------------------------------
  // The rule that will slip first, under pressure to explain one more thing.
  console.log('\ncaptions');
  for (const s of slides) {
    const w = countWords(s.caption);
    check(`${s.actId}/${s.stopIndex}: ${w} words`, w <= MAX_CAPTION_WORDS, `"${s.caption}"`);
  }
  for (const s of slides) {
    const hits = bannedIn(s.caption);
    check(`${s.actId}/${s.stopIndex}: no jargon`, hits.length === 0, hits.join(', '));
  }
  check('the banned list is not empty', BANNED_WORDS.length > 5);
  check('every slide has a caption', slides.every((s) => s.caption && s.caption.trim().length > 0));

  // ---- frames --------------------------------------------------------------
  console.log('\nframes');
  for (const [k, v] of Object.entries(FRAMES)) {
    check(`${k}=${v} is inside the record`, Number.isInteger(v) && v >= 0 && v < nTime);
  }
  // The frames were chosen from a contribution analysis; if a re-export changes
  // the time axis these stop meaning what the captions say they mean.
  //
  // Rendered in the station's own local time -- the same shift `friendly()` in
  // deck.js applies -- so what is asserted here is what a presenter reads off
  // the screen rather than what the file happens to store. Ridge Hill adds
  // nothing and is byte-identical; Gosan is UTC+9, and in UTC every stamp below
  // would be nine hours out with half the day names flipped, which is precisely
  // the bug this arrangement exists to make visible.
  const at = (t) => new Date(series.timeMs[t] + (deck.tzOffsetH || 0) * 3600e3)
    .toISOString().slice(0, 16).replace('T', ' ');
  for (const [k, want] of Object.entries(site.times)) {
    check(`${k} is ${want.says}`, at(FRAMES[k]) === want.is, at(FRAMES[k]));
  }

  // The story's whole claim, in one assertion: the dirty day reads higher than the
  // clean one. If a re-export ever inverts this, every caption in the deck is wrong.
  const obs = series.species[deck.species].obs;
  check('the dirty day really does read higher than the clean day',
    obs[FRAMES.dirty] > obs[FRAMES.clean],
    `${obs[FRAMES.clean]} -> ${obs[FRAMES.dirty]}`);
  // Only a deck that stops at the record low has to care where it is.
  if ('recordLow' in FRAMES) {
    check('the record low is the lowest frame in the month',
      obs[FRAMES.recordLow] === Math.min(...obs.filter((v) => v != null)),
      `${obs[FRAMES.recordLow]}`);
  }

  // ---- override precedence -------------------------------------------------
  console.log('\nframe overrides');
  {
    const r = resolveFrames({ search: '', store: null, nTime });
    check('no overrides gives the defaults', r.frames.dirty === FRAMES.dirty && r.source.dirty === 'default');
  }
  {
    const r = resolveFrames({ search: '', store: { dirty: 200 }, nTime });
    check('a stored override applies', r.frames.dirty === 200 && r.source.dirty === 'stored');
  }
  {
    const r = resolveFrames({ search: '?dirty=300', store: { dirty: 200 }, nTime });
    check('url beats localStorage', r.frames.dirty === 300 && r.source.dirty === 'url');
  }
  {
    // Clamping would turn a typo into a plausible-looking wrong slide, which is
    // the one thing a presenter cannot debug on stage.
    const r = resolveFrames({ search: `?dirty=${nTime + 50}`, store: null, nTime });
    check('an out-of-range override is ignored, not clamped',
      r.frames.dirty === FRAMES.dirty && r.rejected.length === 1, r.rejected.join(','));
  }
  {
    const r = resolveFrames({ search: '?dirty=abc', store: null, nTime });
    check('a non-numeric override is ignored', r.frames.dirty === FRAMES.dirty && r.rejected.length === 1);
  }
  {
    const r = resolveFrames({ search: '?dirty=12.5', store: null, nTime });
    check('a fractional override is ignored', r.frames.dirty === FRAMES.dirty);
  }

  // ---- cameras and layers --------------------------------------------------
  console.log('\ncameras and layers');
  const v = meta.view;
  for (const s of slides) {
    const c = s.camera;
    const inside = c.lon >= v.lonMin && c.lon <= v.lonMax && c.lat >= v.latMin && c.lat <= v.latMax;
    check(`${s.actId}/${s.stopIndex}: camera centre inside the domain`, inside,
      `${c.lon.toFixed(2)}, ${c.lat.toFixed(2)}`);
    check(`${s.actId}/${s.stopIndex}: span is sane`, c.span > 0.05 && c.span <= (v.lonMax - v.lonMin),
      `span ${c.span}`);
  }

  // The centre being inside the domain says nothing about the frame. `clean-wind`
  // sat at lon -11 span 30, centre comfortably inside and the left third of the
  // screen off the western edge of the data -- which the wind layer would have
  // rendered as a hard vertical line rather than as ocean. Longitude is the axis
  // worth asserting on: `span` is degrees of longitude across the canvas *width*,
  // so the horizontal extent is the same on every screen, while the vertical
  // depends on the window's aspect and can only be checked against a stated one.
  {
    const g = meta.footprint.grid;               // cell edges: where data actually is
    const wg = meta.wind ? meta.wind.grid : null; // Part 2; narrower once cropped
    for (const s of slides) {
      const c = s.camera;
      // A stop drawing wind is bounded by the wind crop, which is tighter.
      const b = s.needs.includes('wind') && wg ? wg : g;
      const west = c.lon - c.span / 2;
      const east = c.lon + c.span / 2;
      check(`${s.actId}/${s.stopIndex}: frame stays on data`,
        west >= b.lonMin && east <= b.lonMax,
        `lon ${west.toFixed(2)}..${east.toFixed(2)} vs ${b.lonMin.toFixed(2)}..${b.lonMax.toFixed(2)}`);
    }
    // Latitude, at the two aspects a fullscreen deck actually meets.
    for (const [label, r] of [['16:9', 9 / 16], ['4:3', 3 / 4]]) {
      for (const s of slides) {
        const c = s.camera;
        const half = (c.span * r) / 2;
        check(`${s.actId}/${s.stopIndex}: frame stays on data at ${label}`,
          c.lat - half >= g.latMin && c.lat + half <= g.latMax,
          `lat ${(c.lat - half).toFixed(2)}..${(c.lat + half).toFixed(2)}`);
      }
    }
  }
  const KNOWN = Object.keys(DEFAULT_LAYERS);
  for (const s of slides) {
    const unknown = Object.keys(s.layers).filter((k) => !KNOWN.includes(k));
    check(`${s.actId}/${s.stopIndex}: only known layers`, unknown.length === 0, unknown.join(','));
    const bad = Object.entries(s.layers).filter(([, a]) => !(a >= 0 && a <= 1));
    check(`${s.actId}/${s.stopIndex}: layer alphas in [0,1]`, bad.length === 0, JSON.stringify(bad));
  }
  // A stop that leaves a layer on by accident is the classic deck bug: every stop
  // starts from the same defaults and lists only what it changes.
  check('every stop carries a full layer set',
    slides.every((s) => KNOWN.every((k) => k in s.layers)));

  // ---- figures -------------------------------------------------------------
  //
  // Still pictures on the stage. Everything here is per *picture*, so a deck
  // with none adds no checks -- which is what keeps Ridge Hill at 464 -- and the
  // section as a whole is announced rather than dropped.
  //
  // What is worth checking is not that the code runs. It is the four ways a
  // picture goes wrong quietly, none of which throws and all of which are
  // invisible until somebody is standing in front of a room:
  //
  //   - a **misspelled slot** matches no CSS rule, so the picture draws at the
  //     container's origin -- top left, over the map -- rather than where the
  //     beat said;
  //   - a **misspelled filename** is a broken-image glyph on a projector;
  //   - a **missing alt** is silent by definition;
  //   - and a **big picture in a crowded slot** lands on the caption, which is
  //     the one thing on screen that may never be covered.
  console.log('\nfigures');
  const pictured = slides.flatMap((s) => resolveFigures(s).map((fig) => ({ s, fig })));
  if (!site.expectImages) {
    skip('figures', 'no stop on this deck puts a picture on the stage');
  } else {
    // The feature cannot ship dead. Same argument as the beacons act: a drawing
    // path nothing exercises is one that regresses without anything looking
    // wrong.
    check('the deck actually carries pictures', pictured.length > 0,
      `${pictured.length} across ${slides.length} stops`);
  }
  for (const { s, fig } of pictured) {
    const where = `${s.actId}/${s.stopIndex}`;
    check(`${where}: "${fig.src}" sits in a known slot`, FIGURE_SLOTS.includes(fig.at), fig.at);
    check(`${where}: at a known size`, FIGURE_SIZES.includes(fig.size), fig.size);
    // `src` is relative to the page, and every page is in `web/`.
    check(`${where}: the file is there`, existsSync(`web/${fig.src}`), `web/${fig.src}`);
    check(`${where}: it says what it is a picture of`,
      typeof fig.alt === 'string' && fig.alt.trim().length > 0, fig.alt || '(none)');
    // The pair rule. Both of these grow toward chrome -- `below-centre` toward
    // the caption, `right-of-centre` toward the meter -- and both are fine until
    // `lg`.
    check(`${where}: not a large picture in a crowded slot`,
      !(CROWDED_SLOTS.includes(fig.at) && fig.size === 'lg'), `${fig.at} at ${fig.size}`);
  }

  // ---- the sources card ----------------------------------------------------
  //
  // This card is the one that carries the argument, and three of its claims live
  // in the exported data rather than in the code: that the hi-res rasters exist,
  // that they cover the framing the card actually flies to, and that the families
  // add up to the whole. A re-export that quietly drops a sector file would leave
  // every caption on this card wrong with nothing else failing.
  console.log('\nthe sources card');
  const hi = meta.fluxHires;
  // Gated on the *expectation*, not on the data. A deck that argues from an
  // inventory must fail loudly when the export stops carrying one -- which is
  // what `check(!!hi)` is for -- while a deck that has no inventory yet must not
  // fail for the same reason. Reading `meta.fluxHires` to decide would collapse
  // the two: the check would pass by being skipped, which is the failure mode a
  // gate is most likely to introduce.
  if (!site.expectSources) skip('the sources card', 'no emissions inventory in this export yet — Brief A');
  if (site.expectSources) check('the export carries hi-res emissions', !!hi);
  if (hi && site.expectSources) {
    const SRC = ['total', 'farming', 'waste', 'fossil'];
    check('all four rasters are present', SRC.every((k) => hi.layers && hi.layers[k]),
      Object.keys(hi.layers || {}).join(','));
    check('the hi-res grid is finer than the footprint grid',
      hi.grid.nLon > meta.footprint.grid.nx && hi.grid.nLat > meta.footprint.grid.ny,
      `${hi.grid.nLon}x${hi.grid.nLat} vs ${meta.footprint.grid.nx}x${meta.footprint.grid.ny}`);
    check('the hi-res grid sits inside the view',
      hi.grid.lonMin >= v.lonMin - 0.11 && hi.grid.lonMax <= v.lonMax + 0.11
      && hi.grid.latMin >= v.latMin - 0.11 && hi.grid.latMax <= v.latMax + 0.11,
      `${hi.grid.lonMin}..${hi.grid.lonMax}, ${hi.grid.latMin}..${hi.grid.latMax}`);

    // The three families are the answer to "what is making it". If they ever stop
    // covering nearly all of it, the card is telling a story about a minority.
    const named = ['farming', 'waste', 'fossil'].reduce((a, k) => a + hi.layers[k].shareOfView, 0);
    check('the three families cover the map', named > 99 && named <= 100.01,
      `${named.toFixed(1)}%`);
    check('every family shares the total\'s log scale',
      hi.logMin === meta.flux.logMin && hi.logMax === meta.flux.logMax,
      `${hi.logMin}..${hi.logMax}`);

    // Ordering is load-bearing for the captions -- "most of it is cows" is a
    // claim, not a layout choice.
    const order = ['farming', 'waste', 'fossil'].map((k) => hi.layers[k].shareOfView);
    check('farming really is the largest family', order[0] === Math.max(...order),
      order.map((x) => `${x}%`).join(' > '));

    // The card flies to one framing; the rasters have to cover it.
    const card = acts.find((b) => b.id === 'sources');
    check('the sources card exists', !!card);
    if (card) {
      const covered = card.stops.every((s) => {
        const half = s.camera.span / 2;
        return s.camera.lon - half >= hi.grid.lonMin && s.camera.lon + half <= hi.grid.lonMax;
      });
      check('the rasters cover every framing the card uses', covered);
      // The card used to sit at span 21 / lat 54 and stop at 48.09 N, cutting
      // northern France in half so the sources map read as a strip. How far south
      // it reaches is the framing decision, so it is asserted rather than left to
      // whoever next nudges the span.
      const bottom = Math.max(...card.stops.map((s) => s.camera.lat - (s.camera.span * (9 / 16)) / 2));
      check('the card holds France at 16:9', bottom <= 46.5, `frame bottom ${bottom.toFixed(2)} N`);
      const usesHiRes = card.stops.some((s) => s.layers.fluxHi > 0);
      const usesFamilies = ['srcFarming', 'srcWaste', 'srcFossil']
        .every((k) => card.stops.some((s) => s.layers[k] > 0));
      check('the card opens on the total and then names each family',
        usesHiRes && usesFamilies);
      // Purple means "all of it". If it were ever on screen beside a family
      // colour the reader would have to tell two magnitude ramps apart, which is
      // exactly what the palette note says these were not designed for.
      const clash = card.stops.some((s) => s.layers.fluxHi > 0
        && (s.layers.srcFarming > 0 || s.layers.srcWaste > 0 || s.layers.srcFossil > 0));
      check('the total is never on screen beside a family', !clash);
    }
  }

  // ---- the hi-res emissions map, without a card ----------------------------
  //
  // The sources card above is one way to use `meta.fluxHires`; this is the
  // other. One raster, no decomposition, and its whole reason for existing is
  // resolution -- so what has to be asserted is different, and neither section
  // can stand in for the other.
  console.log('\nthe hi-res emissions map');
  if (!site.expectHiResFlux) {
    skip('the hi-res emissions map', 'this deck draws no hi-res emissions raster');
  } else {
    check('the export carries a hi-res emissions map', !!hi);
    if (hi) {
      check('it is a single layer, not a card',
        !!(hi.layers && hi.layers.total) && Object.keys(hi.layers).length === 1,
        Object.keys(hi.layers || {}).join(','));
      // ⚠ Recalibrated: this used to demand 4x the cell *count* per axis, which
      // is an aspect-ratio rule wearing a fineness rule's clothes. The NAME grid
      // is anisotropic -- 0.3509 deg of longitude against 0.2353 of latitude --
      // so latitude always binds first, and *any* square grid coarser than about
      // 6.5 km failed it however much finer it actually was. The CFC-11 deck's
      // ~10 km map is 4.2x finer in longitude, 2.8x in latitude and carries 11.9x
      // the cells, and was being called "not finer than the coarse map".
      //
      // So compare cell sizes, which is what the words mean, and keep a margin
      // on both: meaningfully finer on each axis, and a real multiple overall.
      // The claim being defended is that the layer earns its bytes; the framing
      // check below is what defends it being *visible*.
      const coarseDLon = (v.lonMax - v.lonMin) / meta.footprint.grid.nx;
      const coarseDLat = (v.latMax - v.latMin) / meta.footprint.grid.ny;
      const hiDLon = (hi.grid.lonMax - hi.grid.lonMin) / hi.grid.nLon;
      const hiDLat = (hi.grid.latMax - hi.grid.latMin) / hi.grid.nLat;
      const cellRatio = (hi.grid.nLon * hi.grid.nLat)
        / (meta.footprint.grid.nx * meta.footprint.grid.ny);
      check('it is finer than the coarse map',
        coarseDLon / hiDLon >= 2 && coarseDLat / hiDLat >= 2 && cellRatio >= 8,
        `${(coarseDLon / hiDLon).toFixed(1)}x lon, ${(coarseDLat / hiDLat).toFixed(1)}x lat, `
        + `${cellRatio.toFixed(1)}x cells`);
      check('it covers the view',
        hi.grid.lonMin <= v.lonMin + 0.01 && hi.grid.lonMax >= v.lonMax - 0.01
        && hi.grid.latMin <= v.latMin + 0.01 && hi.grid.latMax >= v.latMax - 0.01,
        `${hi.grid.lonMin}..${hi.grid.lonMax}, ${hi.grid.latMin}..${hi.grid.latMax}`);

      // The one that would be a lie on screen rather than a crash. ⚠ The note
      // that used to sit here said `G` flips between the two rasters; it does
      // not -- `deck.js` binds `G` to `crispSources`, the smoothing switch. The
      // check stands on firmer ground anyway: the two files are *the same field
      // at two resolutions*, so a byte has to mean the same emission on both or
      // a stop that swaps one for the other is silently rescaling. A viewer
      // reads a resolution change as a
      // change of resolution. If the two encode on different windows it is also
      // a change of scale, and the same colour means two different emissions.
      check('it shares the coarse map\'s log window',
        hi.logMin === meta.flux.logMin && hi.logMax === meta.flux.logMax,
        `hi ${hi.logMin}..${hi.logMax} vs flux ${meta.flux.logMin}..${meta.flux.logMax}`);
      check('it is the same species as the coarse map',
        hi.species === meta.flux.species, `${hi.species} vs ${meta.flux.species}`);

      // Resolution you cannot see is bytes you did not need. A cell has to land
      // on at least a pixel at the framing the stop actually flies to, or the
      // layer is a 4.5 MB copy of a picture that already shipped for 5 KB.
      const cellDeg = (hi.grid.lonMax - hi.grid.lonMin) / hi.grid.nLon;
      const hiStops = acts.flatMap((b) => b.stops).filter((s) => (s.layers || {}).fluxHi > 0);
      check('some stop actually turns the hi-res map on', hiStops.length > 0,
        `${hiStops.length} stops`);
      for (const s of hiStops) {
        // ~1400 px of canvas is the deck's own working assumption elsewhere.
        const pxPerCell = (1400 / s.camera.span) * cellDeg;
        check('a hi-res stop is flown in far enough to see the cells', pxPerCell >= 1.0,
          `span ${s.camera.span} -> ${pxPerCell.toFixed(2)} px per cell`);
      }

      // Decode the raster itself. At 4800x2880 this is 13.8 M pixels -- by a
      // wide margin the largest single image the pipeline ships, and the only
      // one nothing had ever decoded outside the exporter that wrote it. The
      // same three questions the coarse map is asked: right shape, a field
      // rather than one flat byte, and something actually on it.
      const hp = readPNG(`${site.dir}/${hi.layers.total.file}`);
      check('the hi-res raster decodes at the size meta claims',
        hp.width === hi.grid.nLon && hp.height === hi.grid.nLat,
        `${hp.width}x${hp.height} vs ${hi.grid.nLon}x${hi.grid.nLat}`);
      const hiLevels = new Set(hp.data).size;
      check('the hi-res map is a field, not one flat byte', hiLevels >= 8,
        `${hiLevels} levels`);
      const hiDrawn = hp.data.reduce((a, x) => a + (x > 0 ? 1 : 0), 0) / hp.data.length;
      check('some of the hi-res view has something on it',
        hiDrawn > 0.001 && hiDrawn < 0.999, `${(100 * hiDrawn).toFixed(1)}% non-zero`);

      // The point of the whole layer, stated as a test: at 1 km the population
      // is *concentrated*, and averaging it onto 25 km cells is what destroys
      // that. If this ever stopped holding, the hi-res raster would have become
      // an upscaled copy of the coarse one and the download would buy nothing.
      const coarse = readPNG(`${site.dir}/${meta.flux.file}`);
      const hiNonZero = hiDrawn;
      const coarseNonZero = coarse.data.reduce((a, x) => a + (x > 0 ? 1 : 0), 0)
        / coarse.data.length;
      check('the hi-res map is sparser than the coarse one, as concentration implies',
        hiNonZero < coarseNonZero,
        `${(100 * hiNonZero).toFixed(1)}% vs ${(100 * coarseNonZero).toFixed(1)}% non-zero`);
    }
  }

  // ---- the coarse emissions map --------------------------------------------
  //
  // A different claim from the sources card above, and a smaller one: not "the
  // families add up" but "there is a field here, and the ramp shows it".
  //
  // It earns a section because the CFC-11 deck's map is the first whose encoding
  // window is not methane's, and a wrong window fails *silently*. Every cell
  // lands on one byte, the PNG still decodes, the layer still paints, and the
  // slide is a flat rectangle under a caption about where something comes from.
  // `verify_export.py` demands the bytes match a re-encode; this checks that
  // what those bytes draw is a picture.
  console.log('\nthe emissions map');
  if (!site.expectFlux) {
    skip('the emissions map', 'this deck draws no coarse emissions raster');
  } else {
    const fx = meta.flux;
    check('the export carries an emissions map', !!fx);
    if (fx) {
      const png = readPNG(`${site.dir}/${fx.file}`);
      const fg = meta.footprint.grid;
      check('the raster is on the footprint grid',
        png.width === fg.nx && png.height === fg.ny,
        `${png.width}x${png.height} vs ${fg.nx}x${fg.ny}`);

      // A field, not a wash. Eight is deliberately low: the question is whether
      // the window landed on the data at all, and a real field clears it by an
      // order of magnitude. This one ships 181.
      const levels = new Set(png.data).size;
      check('the map is a field, not one flat byte', levels >= 8, `${levels} levels`);
      const drawn = png.data.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / png.data.length;
      check('some of the view has something on it', drawn > 0.02 && drawn < 0.999,
        `${(100 * drawn).toFixed(0)}% non-zero`);

      // The ramp, as the deck will actually build it. `fluxLUT` hands back the
      // shared FLUX_LUT for a gas with no window of its own, so this is a real
      // test of the per-species path rather than of a default.
      const { fluxLUT } = await import('../palette.js');
      const lut = fluxLUT(fx);
      const alpha = (u) => lut[u * 4 + 3];
      const top = Math.max(...png.data);
      check('the strongest cell is drawn solidly', alpha(top) > 120, `alpha ${alpha(top)}`);
      check('empty stays empty', alpha(0) === 0);
      let mono = true;
      for (let i = 2; i < 256; i++) if (alpha(i) < alpha(i - 1)) mono = false;
      check('opacity never goes backwards', mono);
      // The floor has to hide *something*, or it is not a window -- and it must
      // not hide everything, which is the failure mode that draws a blank slide.
      const hidden = png.data.reduce((a, v) => a + (v > 0 && alpha(v) === 0 ? 1 : 0), 0);
      const visible = png.data.reduce((a, v) => a + (alpha(v) > 0 ? 1 : 0), 0);
      check('the window hides the faint end but not the map',
        visible > 0.02 * png.data.length,
        `${hidden} cells below the floor, ${visible} drawn`);

      // Every stop that turns the layer on has to be looking at somewhere the
      // map is not empty, or the caption points at blank ocean.
      //
      // ⚠ The *existence* claim is about emissions being drawn at all, not about
      // which resolution draws them. This used to demand a `flux` stop, which
      // was true of every deck until the CFC-11 one moved its emissions beats
      // onto `fluxHi` at the wide cameras and stopped drawing the coarse raster
      // anywhere. That deck still ships `flux.png` -- `meta.flux` drives the
      // tuning panel's reset and the per-species display window -- so the raster
      // checks above are still worth running on it; what is no longer true is
      // that a stop paints it.
      //
      // The framing test below stays on the `flux` stops alone. A deck that
      // draws only `fluxHi` has its own framing guard in the hi-res section, and
      // widening this one would put Ridge Hill's zoomed source-card stops
      // through a coarse-raster test they were never written against.
      const onStops = slides.filter((s) => s.layers.flux > 0);
      const drawsEmissions = slides.some((s) => s.layers.flux > 0 || s.layers.fluxHi > 0);
      check('some stop actually draws an emissions map', drawsEmissions,
        `${onStops.length} coarse, `
        + `${slides.filter((s) => s.layers.fluxHi > 0).length} hi-res`);
      const inFrame = onStops.every((s) => {
        const half = s.camera.span / 2;
        const halfLat = (s.camera.span * (9 / 16)) / 2;
        let any = false;
        for (let r = 0; r < png.height && !any; r++) {
          const lat = fg.latMax - ((r + 0.5) / png.height) * (fg.latMax - fg.latMin);
          if (Math.abs(lat - s.camera.lat) > halfLat) continue;
          for (let c = 0; c < png.width; c++) {
            const lon = fg.lonMin + ((c + 0.5) / png.width) * (fg.lonMax - fg.lonMin);
            if (Math.abs(lon - s.camera.lon) > half) continue;
            if (alpha(png.data[r * png.width + c]) > 0) { any = true; break; }
          }
        }
        return any;
      });
      check('every framing that draws it has something to draw', inFrame);
    }
  }

  // -------------------------------------------------------------------
  // Site-agnostic. See the note on `engine` in SITES.
  // -------------------------------------------------------------------
  if (site.engine) {
    // ---- sources contrast ----------------------------------------------------
    //
    // The display window is the difference between a legible card and a grey wash,
    // and it is three numbers a presenter can change on the night. Worth asserting
    // that they do what they say, since nothing else here would notice a floor that
    // hid everything or a gamma applied the wrong way round.
    console.log('\nsources contrast');
    {
      const { SOURCE_DISPLAY, buildSourceLUTs } = await import('../palette.js');
      const fh = meta.fluxHires;
      if (fh) {
        // Physical value -> the byte the exporter would have stored for it.
        const enc = (log10) => Math.max(1, Math.min(255,
          Math.round(1 + 254 * (log10 - fh.logMin) / (fh.logMax - fh.logMin))));
        const luts = buildSourceLUTs(fh, SOURCE_DISPLAY);
        const alpha = (lut, log10) => lut[enc(log10) * 4 + 3];

        check('the default floor sits between the two humps',
          SOURCE_DISPLAY.floor > -11.0 && SOURCE_DISPLAY.floor < -8.5,
          `10^${SOURCE_DISPLAY.floor}`);

        for (const key of ['total', 'farming', 'waste', 'fossil']) {
          const lut = luts[key];
          check(`${key}: background haze is invisible`, alpha(lut, -10.5) === 0);
          check(`${key}: a real source is opaque`, alpha(lut, -8.0) > 120,
            String(alpha(lut, -8.0)));
          // Monotone, or "more methane" stops meaning "darker".
          let mono = true;
          for (let i = 2; i < 256; i++) if (lut[i * 4 + 3] < lut[(i - 1) * 4 + 3]) mono = false;
          check(`${key}: opacity never goes backwards`, mono);
        }

        // Every family must share one window, or the smallest source would look as
        // strong as the largest and comparing them by eye would be meaningless.
        const profile = (lut) => Array.from({ length: 256 }, (_, i) => lut[i * 4 + 3]).join(',');
        check('all four families share one window',
          new Set(['total', 'farming', 'waste', 'fossil'].map((k) => profile(luts[k]))).size === 1);

        // Gamma above 1 holds the low end light. Compare luminance at the midpoint
        // of the window against a straight ramp.
        const mid = (SOURCE_DISPLAY.floor + SOURCE_DISPLAY.ceil) / 2;
        const lum = (lut) => { const i = enc(mid) * 4; return lut[i] + lut[i + 1] + lut[i + 2]; };
        const straight = buildSourceLUTs(fh, { ...SOURCE_DISPLAY, gamma: 1 });
        const stretched = buildSourceLUTs(fh, { ...SOURCE_DISPLAY, gamma: 2 });
        check('a bigger stretch keeps mid values lighter',
          lum(stretched.farming) > lum(straight.farming),
          `${lum(stretched.farming)} vs ${lum(straight.farming)}`);
        check('the shipped default is on the light side of straight',
          lum(luts.farming) >= lum(straight.farming));

        // A floor above the ceiling is the one setting that would blank the card.
        const inverted = buildSourceLUTs(fh, { floor: -7, ceil: -9, gamma: 1 });
        check('an inverted window still produces a drawable table',
          inverted.farming.length === 1024);
      }
    }
  }

  // ---- play windows --------------------------------------------------------
  console.log('\nplay windows');
  for (const s of slides) {
    if (!s.play) continue;
    // `stepHours` is not optional here even though it defaults to 1: leaving it
    // off is the suite committing the very bug the section below tests for.
    const p = resolvePlay(s.play, { anchor: s.anchor, frames: FRAMES, nTime, stepHours });
    check(`${s.actId}/${s.stopIndex}: window inside the record`,
      p.from >= 0 && p.to < nTime && p.from <= p.to, `${p.from}..${p.to}`);
    check(`${s.actId}/${s.stopIndex}: holds sit inside the window`,
      p.holdAt.every((h) => h >= p.from && h <= p.to), p.holdAt.join(','));
    check(`${s.actId}/${s.stopIndex}: speed is positive`, p.stepsPerSec > 0);
  }
  {
    // The reason play windows are stored as offsets: retiming an act has to move
    // its animation with it, not leave it behind.
    const play = { from: -4, to: 4, stepsPerSec: 2, holdAt: ['dirty'] };
    const a = resolvePlay(play, { anchor: 'dirty', frames: FRAMES, nTime });
    const b = resolvePlay(play, { anchor: 'dirty', frames: { ...FRAMES, dirty: FRAMES.dirty + 10 }, nTime });
    check('retiming an act slides its window with it',
      b.from === a.from + 10 && b.to === a.to + 10 && b.holdAt[0] === a.holdAt[0] + 10,
      `${a.from}..${a.to} -> ${b.from}..${b.to}`);
  }
  {
    const p = resolvePlay({ from: 0, to: 'end', stepsPerSec: 9, holdAt: ['clean', 'dirty'] },
      { anchor: null, frames: FRAMES, nTime });
    check("'end' resolves to the last frame", p.to === nTime - 1, String(p.to));
    check('absolute windows keep their holds in order', p.holdAt[0] < p.holdAt[1]);
  }
  {
    // Clamping matters at the edges: an act anchored near frame 0 must not ask for
    // negative frames.
    const p = resolvePlay({ from: -50, to: 10, stepsPerSec: 2 }, { anchor: 'clean', frames: { ...FRAMES, clean: 3 }, nTime });
    check('a window running off the start is clamped', p.from === 0, String(p.from));
  }

  // The bug the second deck surfaced, pinned where it can actually fail.
  //
  // `play.from`/`play.to` are hours, and a frame is `stepHours` of them. The old
  // code added them to the anchor frame directly -- the same arithmetic only
  // where a frame *is* an hour, which is true at Ridge Hill and nowhere else. At
  // Gosan's 2-hourly export every window ran to twice its stated length, and
  // silently: the deck plays, it just plays too far and ends on an hour the
  // caption is not talking about.
  //
  // Ridge Hill divides by one and cannot fail this, which is exactly why 464
  // checks never caught it. So the gate is the *step*, not the site: any future
  // export at anything other than 1 h inherits the guard for free.
  if (stepHours === 1) {
    skip('the hours-to-frames conversion', 'a frame is an hour here, so the two cannot disagree');
  } else {
    const H = 12;
    const p = resolvePlay({ from: 0, to: H }, { anchor: 'dirty', frames: FRAMES, nTime, stepHours });
    check(`a ${H} h window really is ${H} hours long, not ${H} frames`,
      (p.to - p.from) * stepHours === H,
      `${p.from}..${p.to} spans ${(p.to - p.from) * stepHours} h at ${stepHours} h a frame`);
    check('and reading the hours as frames really would have overrun it',
      p.to < FRAMES.dirty + H, `${p.to} against the old arithmetic's ${FRAMES.dirty + H}`);
  }

  // ---- play windows come to rest on real observations ----------------------
  //
  // **This rule used to be twice as strict, and the meter's third state is what
  // relaxed it.** `paintMeter` mapped a null reading through `smellOf(null) -> 0`,
  // so a frame with no observation drew an **empty bar** -- and an empty bar
  // means clean air. Playing a window across a gap therefore said "there is
  // nothing here" in the register the audience reads fastest while the caption
  // said the opposite, so an **anchored** window -- an episode, so many hours
  // from a named moment -- was required to be blank-free end to end. That is
  // what cut the CFC-11 episode to four hours: 183 is blank, so the window
  // stopped at 182.
  //
  // A blank hour now draws struck out and captioned "no reading" (the section
  // below), so crossing a gap is no longer a lie and playback runs through one.
  // The anchored/unanchored split goes with it: what is left is one rule for
  // every window on every deck, and it is about where playback comes to **rest**.
  // `from`, every `holdAt` and `to` are frames the deck stops on and talks over,
  // and a pause is a slide ending. Ending on a blank is no longer false, but it
  // is still an ending with nothing in it, under a caption written about a
  // reading.
  //
  // ⚠ A window may now be written across a gap, and one is: `record` crosses 93
  // of them. Whether an *anchored* window should is a story decision per stop
  // rather than a rule -- the CFC-11 deck's `dirty` deliberately stays inside its
  // own run of readings -- so nothing here demands either.
  //
  // Gated on the data rather than on a fixture opinion: Ridge Hill is 696 of 696
  // observed, so the question genuinely does not arise and the section says so.
  {
    const blankFrames = obs.filter((v) => v == null).length;
    if (!blankFrames) {
      skip('play windows come to rest on real observations',
        `${obs.length} of ${obs.length} frames observed — no gap to land in`);
    } else {
      for (const s of slides) {
        if (!s.play) continue;
        const p = resolvePlay(s.play, { anchor: s.anchor, frames: FRAMES, nTime, stepHours });
        const rests = [p.from, ...p.holdAt, p.to];
        const blank = rests.filter((t) => obs[t] == null);
        let crossed = 0;
        for (let t = p.from; t <= p.to; t++) if (obs[t] == null) crossed++;
        check(`${s.actId}/${s.stopIndex}: it comes to rest on real readings`,
          blank.length === 0,
          blank.length
            ? `blank at ${blank.join(',')}`
            : `rests at ${rests.join(',')}, crossing ${crossed} blank frames on the way`);
      }
    }
  }

  // ---- the bar's third state -----------------------------------------------
  //
  // An hour the instrument does not have is neither a hidden bar nor a low one,
  // and since this landed the deck can say so: the track is hatched and the words
  // "no reading" appear under it.
  //
  // ⚠ **A dead state would be invisible.** 307 of this deck's 672 frames have no
  // reading and 341 of the HFC-23 deck's 1044 do; if the class stopped being set,
  // or the stylesheet stopped acting on it, every one of those frames would go
  // quietly back to drawing an empty bar -- which on these decks means clean air
  // -- and nothing else on screen would look wrong. The two halves fail
  // independently, so both are asserted: the stylesheet's here, read as text
  // because there is no browser to ask, and the deck's on the mounted deck below.
  //
  // ⚠ **Colour is never the only channel, and grey least of all** -- on this bar
  // grey *is* the empty track. So what is checked is that the state carries a
  // texture and words, either of which survives colour-vision deficiency, a
  // washed-out projector, or the back row of a hall.
  //
  // Gated on the data, like the section above. Ridge Hill can never reach the
  // state, and demanding its stylesheet describe one would be demanding a rule
  // for a picture that deck cannot draw. The rules are shared, so the two decks
  // that can reach it are the two that check them.
  console.log('\nthe bar\'s third state');
  {
    const blankFrames = obs.filter((v) => v == null).length;
    if (!blankFrames) {
      skip('the bar\'s third state',
        `${obs.length} of ${obs.length} frames observed — it can never fire here`);
    } else {
      // ⚠ Reachable from the deck as it *runs*, not only by dragging the
      // scrubber into a gap. This is the check that stops the CFC-11 episode
      // being quietly trimmed back to a blank-free window: the whole point of
      // the state is that a window may now cross one, so if every window is
      // written to avoid gaps again, the state ships dead and this says so.
      let crossed = 0;
      for (const s of slides) {
        if (!s.play) continue;
        const p = resolvePlay(s.play, { anchor: s.anchor, frames: FRAMES, nTime, stepHours });
        for (let t = p.from; t <= p.to; t++) if (obs[t] == null) crossed++;
      }
      check('a window actually plays through hours with no reading', crossed > 0,
        `${crossed} blank frames inside play windows, of ${blankFrames} in the record`);

      const css = readFileSync(new URL('../../css/story.css', import.meta.url), 'utf8')
        // Comments first, or the prose about this very state parses as rules.
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .map(([, sel, body]) => ({ sel: sel.trim(), body }));
      const marked = (part) => rules.filter((r) => r.sel.includes('.no-reading') && r.sel.includes(part));

      // **Channel one: texture.** `background-image`, not `background-color` --
      // a hue swap is precisely the thing that does not survive being
      // colour-blind, and the empty track is already grey.
      const hatch = marked('.meter-track');
      check('the blank state hatches the track rather than only recolouring it',
        hatch.some((r) => /background-image\s*:\s*repeating-linear-gradient/.test(r.body)),
        hatch.map((r) => r.sel).join(' / ') || 'no .no-reading rule reaches .meter-track');

      // **Channel two: words.** Held in the layout at all times and only made
      // visible, so it can be read from the back of the room without the meter
      // changing size when it appears.
      const note = rules.filter((r) => r.sel.split(/\s+/).pop().startsWith('.meter-note'));
      check('the words "no reading" have a rule that shows them',
        marked('.meter-note').some((r) => /visibility\s*:\s*visible/.test(r.body)));
      check('and one that hides them the rest of the time',
        note.some((r) => r.sel === '.meter-note' && /visibility\s*:\s*hidden/.test(r.body)));
      // ⚠ `visibility`, never `display`. The month act steps nine times a second
      // across a record a third empty, so a note that took its space as it
      // appeared would make the whole meter jump up and down for twenty seconds.
      check('the note holds its place in the layout while it is not showing',
        !note.some((r) => /display\s*:/.test(r.body)),
        note.map((r) => r.sel).join(' / '));
    }
  }

  // ---- structure -----------------------------------------------------------
  console.log('\nstructure');
  check('every act has at least one stop', acts.every((a) => a.stops.length > 0));
  check('act ids are unique', new Set(acts.map((a) => a.id)).size === acts.length);
  check('slides are contiguous across acts',
    slides.every((s, k) => k === 0 || s.actIndex >= slides[k - 1].actIndex));
  // The chart and the bar swapped: the last act plays the month over a fullscreen
  // map with the bar rising beside it, rather than drawing the same quantity a
  // second time along the bottom. A stray `chart: true` would take a quarter of
  // the map back and suppress nothing, since the bar no longer stands aside for
  // it -- so the two would be on screen together saying the same thing.
  check('no act draws the chart -- the bar carries the month',
    acts.filter((a) => a.chart).length === 0);
  // Only a deck that has the flag, and an act for it to act on.
  if ('showRecordLow' in (deck.flags || {})) {
    check('the record-low flag adds a pause to the month playback', (() => {
      const holds = (on) => toSlides(buildDeck(deck, FRAMES, { ...deck.flags, showRecordLow: on }))
        .find((s) => s.actId === 'record').play.holdAt;
      return holds(true).length === holds(false).length + 1;
    })());
  } else {
    skip('the record-low flag', 'this deck does not have one');
  }

  // -------------------------------------------------------------------
  // Site-agnostic. See the note on `engine` in SITES.
  // -------------------------------------------------------------------
  if (site.engine) {
    // ---- the [hidden] trap ---------------------------------------------------
    //
    // Every element the deck shows and hides does it by setting the `hidden`
    // attribute. That works because the browser ships `[hidden] { display: none }`
    // -- a *user-agent* rule, which any author `display:` on the same element beats
    // outright. So a stylesheet that gives one of these a `display` silently
    // disables its own hide, and the symptom is not an error: the key works, the
    // attribute flips, and nothing moves on screen.
    //
    // It has now cost three elements. `.meter` sat on top of the deck for its whole
    // life; `.scrub-look` was caught in review; `.scrubber` was on screen from the
    // first slide for months while T appeared to be broken. That is enough
    // repetition to be worth a test rather than a comment.
    //
    // Read out of the stylesheet as text, because there is no browser here to ask.
    console.log('\nthe [hidden] trap');
    {
      const css = readFileSync(new URL('../../css/story.css', import.meta.url), 'utf8')
        // Comments first, or the prose about this very trap -- which quotes
        // `[hidden] { display: none }` -- parses as a rule and marks everything safe.
        .replace(/\/\*[\s\S]*?\*\//g, '');

      const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
        // The *subject* of each selector: the compound the rule actually applies
        // to. `.chart-shell canvas` styles the canvas, not the shell, so matching
        // anywhere in the selector would flag it for a `display` it does not have.
        subjects: sel.split(',').map((s) => s.trim().split(/\s+/).pop()),
        body,
      }));

      // id set from JS -> the class the stylesheet knows it by.
      const TOGGLED = {
        meter: 'meter', pill: 'pill', chartShell: 'chart-shell',
        scrubber: 'scrubber', lookRow: 'scrub-look',
      };

      for (const [id, cls] of Object.entries(TOGGLED)) {
        const declares = blocks.some((b) => b.subjects.includes(`.${cls}`) && /display\s*:/.test(b.body));
        const guarded = blocks.some((b) => b.subjects.includes(`.${cls}[hidden]`)
          && /display\s*:\s*none/.test(b.body));
        check(`#${id}: hiding it actually hides it`, !declares || guarded,
          declares
            ? (guarded ? 'declares display, and guards it' : 'declares display with NO [hidden] rule')
            : 'no author display, the browser rule applies');
      }
    }
  }

  // The deck has to run today, against an export with no wind in it.
  console.log('\ndegrades without wind');
  if (!site.expectWind) {
    // Not "this export has no wind" -- that would make the check pass by
    // vanishing on exactly the deck it matters most for. It is that the *deck*
    // has no wind-gated stops, which is a claim about the acts.
    skip('degrades without wind', 'this deck has no wind-gated stops');
  } else {
    const needWind = slides.filter((s) => s.needs.includes('wind'));
    check('some stops declare a wind dependency', needWind.length > 0, `${needWind.length} stops`);
    const without = slides.filter((s) => !s.needs.includes('wind'));
    check('most of the deck runs with no wind file', without.length >= slides.length - needWind.length);
    check('every wind stop still has a camera and a caption',
      needWind.every((s) => s.camera && s.caption));
    check('the month playback needs no wind',
      !slides.some((s) => s.actId === 'record' && s.needs.includes('wind')));
  }

  // ---- the smell bar -------------------------------------------------------
  // The bar is the only chrome with a number behind it, and the scale is the
  // whole claim: a bar that says "a lot" on the quiet day argues against the
  // caption next to it. These check the shape of the scale against the real
  // record rather than restating SMELL, so a re-export that moves the record
  // fails here instead of on stage.
  console.log('\nthe smell bar');
  {
    const gas = series.species[deck.species];
    const obs = gas.obs;
    const fill = (t) => Math.max(0, Math.min(1, (obs[t] - SMELL.base) / SMELL.span));
    const pct = (t) => `${Math.round(fill(t) * 100)}%`;
    const want = site.bar;

    check('the base sits on the export\'s own background',
      Math.abs(SMELL.base - gas.baseline) < 5, `${SMELL.base} vs ${gas.baseline}`);
    // How full the quiet day reads is the one number the two decks disagree
    // about rather than share a rule for, so the band and the words for it both
    // come from the table. Ridge Hill's quiet day is a genuine sliver -- the
    // model puts +13 ppb on it; Gosan's is below background and clamps to empty.
    check(`the clean day is ${want.clean.says}`,
      fill(FRAMES.clean) >= want.clean.band[0] && fill(FRAMES.clean) <= want.clean.band[1],
      pct(FRAMES.clean));
    check('the dirty day fills most of it',
      fill(FRAMES.dirty) > want.dirty, pct(FRAMES.dirty));
    // Gated the same way `recordLow` is, and for the same reason. The CFC-11
    // deck names no peak: its episode has not been measured well enough to put a
    // pause anywhere, so it has two moments rather than three. Ungated, both of
    // these read `fill(undefined)` -> NaN, and **both comparisons are false**, so
    // the deck would fail here for having been honest about what it does not
    // know. Ridge Hill and Gosan both have a peak and take the same path they
    // always did.
    if ('peak' in FRAMES) {
      check('the peak reads fuller than the dirty day',
        fill(FRAMES.peak) > fill(FRAMES.dirty), `${pct(FRAMES.dirty)} -> ${pct(FRAMES.peak)}`);
      check('the peak does not saturate -- a pinned bar has nowhere left to go',
        fill(FRAMES.peak) < 1, pct(FRAMES.peak));
    } else {
      skip('the peak reads fuller than the dirty day', 'this deck names no peak');
    }
    if ('recordLow' in FRAMES) {
      check('the record low is empty', fill(FRAMES.recordLow) === 0, pct(FRAMES.recordLow));
    }

    const valid = obs.filter((v) => v != null);
    const clipped = valid.filter((v) => v - SMELL.base > SMELL.span).length;
    check('the top clips only a handful of hours', clipped <= want.clipped,
      `${clipped} of ${valid.length}`);
    const floored = valid.filter((v) => v <= SMELL.base).length;
    check('the floor empties only the quietest hours', floored < valid.length * 0.1,
      `${floored} of ${valid.length}`);
  }

  // ---- plants under the plume ----------------------------------------------
  //
  // This deck's central claim, and the one thing in it that is a statement about
  // the pixels rather than about the writing: when the reading is high the
  // smelling area is sitting on the plants that make this gas, and when it is
  // low it is not. If that ever stops being true the deck is not making a weaker
  // argument, it is making a false one, with every caption still claiming
  // otherwise.
  //
  // The headless mount cannot answer it -- `Image` is stubbed there and the
  // atlas decodes to zeros -- so the shipped PNG is decoded here and the plant
  // list resolved against it, mirroring `_resolveCells` and `factoryLit` in
  // mapview.js exactly. Same grid arithmetic, same `litCode` threshold, so what
  // is asserted is what the deck will actually draw.
  //
  // Gated on the data: Ridge Hill's `meta.factories` is null, so it skips
  // without needing to be told to.
  console.log('\nplants under the plume');
  if (!meta.factories) {
    skip('plants under the plume', 'no plant list in this export');
  } else {
    const fa = meta.factories;
    const { cols, tileW, tileH } = meta.footprint.atlas;
    const g = meta.footprint.grid;
    const png = readPNG(`${site.dir}/${meta.footprint.atlas.file}`);
    const cells = tileW * tileH;

    // Which footprint cell each plant sits in. `_resolveCells`, verbatim.
    const cellOf = fa.points.map(([lon, lat]) => {
      const col = Math.floor(((lon - g.lonMin) / (g.lonMax - g.lonMin)) * tileW);
      const row = Math.floor(((g.latMax - lat) / (g.latMax - g.latMin)) * tileH);
      return (col >= 0 && col < tileW && row >= 0 && row < tileH) ? row * tileW + col : -1;
    });
    // One frame out of the atlas, at the tiling `decodeAtlas` uses.
    const litAt = (t) => {
      const tc = t % cols;
      const tr = Math.floor(t / cols);
      let n = 0;
      for (const c of cellOf) {
        if (c < 0) continue;
        const y = Math.floor(c / tileW);
        const x = c % tileW;
        if (png.data[(tr * tileH + y) * png.width + tc * tileW + x] >= fa.litCode) n++;
      }
      return n;
    };

    check('the plant list survived the export',
      fa.points.length > 0 && fa.litCode > 0, `${fa.points.length} plants, lit at ${fa.litCode}`);
    check('the atlas is the size the meta says it is',
      png.width === cols * tileW, `${png.width}x${png.height}`);
    // On-grid is what can ever light: four Sichuan plants sit west of the view.
    const onGrid = cellOf.filter((c) => c >= 0).length;
    check('the plants resolve onto the footprint grid', onGrid === fa.nOnGrid,
      `${onGrid} on grid, meta says ${fa.nOnGrid}`);

    const lit = { clean: litAt(FRAMES.clean), dirty: litAt(FRAMES.dirty) };
    check('the quiet day has no plants under the plume', lit.clean === 0,
      `${lit.clean} lit at frame ${FRAMES.clean}`);
    check('the dirty day does', lit.dirty > 0,
      `${lit.dirty} of ${onGrid} lit at frame ${FRAMES.dirty}`);
    // The gap is the argument, so a deck where the two days differ by one plant
    // has no argument. Ten is well inside the measured 12-vs-0 and leaves room
    // for a re-export to move a cell without failing on noise.
    check('and by enough to be the point, not a detail', lit.dirty - lit.clean >= 10,
      `${lit.clean} -> ${lit.dirty}`);
  }

  // -------------------------------------------------------------------
  // Site-agnostic. See the note on `engine` in SITES.
  // -------------------------------------------------------------------
  if (site.engine) {
    // ---- graticule -----------------------------------------------------------
    // Mirrors the fork's step selection. The original's rule returned 30 degrees at
    // every zoom, which drew nothing at the deck's Bristol opener.
    console.log('\ngraticule');
    {
      const steps = [30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05];
      const pick = (span) => steps.find((s) => span / s >= 4) ?? 0.05;
      for (const span of [45, 34, 30, 21, 15, 5, 1.4, 0.9, 0.3]) {
        const lines = span / pick(span);
        check(`span ${span}: ${lines.toFixed(1)} lines`, lines >= 4 && lines <= 12, `step ${pick(span)}`);
      }
      const old = (span) => steps.find((s) => span / s < 10) ?? 0.5;
      check('the original rule really was broken at the Bristol framing',
        1.4 / old(1.4) < 1, `old step ${old(1.4)}`);
    }

    // ---- the wind sampler ----------------------------------------------------
    //
    // The pixels are `verify_export.py`'s job -- it re-encodes both components from
    // the source and demands byte-equality. What it cannot see is the browser
    // reading them back wrong, and every way of doing that produces a plausible
    // picture rather than a blank one: a half-cell offset moves the wind 24 km, a
    // flipped latitude axis blows the Atlantic air the wrong way, and decoding the
    // reserved 0 gives a confident 40 m/s gale. So the field is built by hand here,
    // where the right answer is known exactly.
    console.log('\nwind sampler');
    {
      const { WindField, decodeWind } = await import('../wind.js');

      // The decode, including the trap.
      check('code 0 is missing, not -uvMax', Number.isNaN(decodeWind(0, 40)));
      check('code 1 is exactly -uvMax', decodeWind(1, 40) === -40, String(decodeWind(1, 40)));
      check('code 255 is exactly +uvMax', decodeWind(255, 40) === 40, String(decodeWind(255, 40)));
      check('the middle code is near still', Math.abs(decodeWind(128, 40)) < 0.2,
        decodeWind(128, 40).toFixed(3));
      check('the step is half the quantisation error the export reported',
        Math.abs((decodeWind(129, 40) - decodeWind(128, 40)) - 0.315) < 0.001,
        (decodeWind(129, 40) - decodeWind(128, 40)).toFixed(4));

      // A field built by hand: 4 cells across, 3 down, over a box whose edges divide
      // evenly, so the cell centres are numbers you can check in your head --
      // lon -7.5/-2.5/2.5/7.5, lat 52.5/47.5/42.5 with row 0 at the top.
      const synth = (nTime, fill) => {
        const nx = 4;
        const ny = 3;
        const m = {
          atlas: { u: 'u.png', v: 'v.png', cols: nTime, rows: 1, tileW: nx, tileH: ny },
          layout: 'two-l8',
          grid: { nx, ny, lonMin: -10, lonMax: 10, latMin: 40, latMax: 55 },
          uvMax: 40, nTime, frameStride: 3, framesCovered: (nTime - 1) * 3 + 1,
        };
        const u = new Uint8Array(nTime * nx * ny);
        const v = new Uint8Array(nTime * nx * ny);
        for (let k = 0; k < nTime; k++) {
          for (let i = 0; i < ny; i++) {
            for (let j = 0; j < nx; j++) {
              const [a, b] = fill(k, i, j);
              u[k * nx * ny + i * nx + j] = a;
              v[k * nx * ny + i * nx + j] = b;
            }
          }
        }
        return new WindField(m, u, v);
      };

      // Geometry. Every cell gets its own code, so a sample can be traced back to
      // the cell it came from rather than merely being plausible.
      {
        const code = (i, j) => 10 + i * 4 + j;          // 10..21, all distinct
        const f = synth(1, (k, i, j) => [code(i, j), code(i, j)]);
        const at = (lon, lat) => f.sample(0, lon, lat).u;

        check('a cell centre reads that cell exactly',
          at(-7.5, 52.5) === decodeWind(code(0, 0), 40), String(at(-7.5, 52.5)));
        check('the far corner reads its own cell',
          at(7.5, 42.5) === decodeWind(code(2, 3), 40), String(at(7.5, 42.5)));

        // The one that would silently mirror the whole field: row 0 is north, so
        // the top-left cell must answer to a *high* latitude.
        check('row 0 is north',
          at(-7.5, 52.5) !== at(-7.5, 42.5)
          && at(-7.5, 52.5) === decodeWind(code(0, 0), 40)
          && at(-7.5, 42.5) === decodeWind(code(2, 0), 40));

        // Half a cell out from the edge, not on it: an off-by-half here is 24 km on
        // the real grid, which looks like weather rather than like a bug.
        check('the cell centre sits half a cell in from the edge',
          at(-10, 55) === at(-7.5, 52.5) && at(-9.9, 54.9) === at(-7.5, 52.5));

        // Bilinear, checked where the answer is a mean of two known numbers.
        const mid = (decodeWind(code(0, 0), 40) + decodeWind(code(0, 1), 40)) / 2;
        check('midway between two centres is their mean',
          Math.abs(at(-5, 52.5) - mid) < 1e-9, `${at(-5, 52.5)} vs ${mid}`);
        const quarter = decodeWind(code(0, 0), 40) * 0.75 + decodeWind(code(0, 1), 40) * 0.25;
        check('a quarter of the way across is weighted, not rounded',
          Math.abs(at(-6.25, 52.5) - quarter) < 1e-9, String(at(-6.25, 52.5)));

        // Off the edge returns the edge rather than wrapping to the far side, which
        // is what makes a parcel drifting out of the domain slow to a halt instead
        // of teleporting.
        check('sampling far west clamps to the western edge',
          at(-40, 52.5) === at(-7.5, 52.5));
        check('sampling far north clamps to the northern edge',
          at(-7.5, 80) === at(-7.5, 52.5));
        check('clamping does not wrap', at(-40, 52.5) !== at(7.5, 52.5));

        check('inside() knows the box', f.inside(0, 50) && !f.inside(0, 30) && !f.inside(20, 50));
        check('inside() includes the edges', f.inside(-10, 55) && f.inside(10, 40));

        check('speed is the magnitude',
          Math.abs(f.speed(0, -7.5, 52.5) - Math.hypot(at(-7.5, 52.5), at(-7.5, 52.5))) < 1e-9);
        check('sample writes into a caller-supplied vector', (() => {
          const out = { u: 0, v: 0 };
          return f.sample(0, -7.5, 52.5, out) === out && out.u === decodeWind(code(0, 0), 40);
        })());
      }

      // Missing cells. Not reachable from the shipped export, but it is the failure
      // that would look most like real weather, so it gets its own field.
      {
        const f = synth(1, (k, i, j) => (i === 0 && j === 0 ? [0, 0] : [200, 200]));
        check('a missing cell samples as no data, not as a gale',
          f.sample(0, -7.5, 52.5) === null);
        check('speed over a missing cell is NaN', Number.isNaN(f.speed(0, -7.5, 52.5)));
        // The neighbour is real; the average must be the neighbour, not half of it.
        check('a missing corner drops out of the average rather than poisoning it',
          Math.abs(f.sample(0, -5, 52.5).u - decodeWind(200, 40)) < 1e-9,
          String(f.sample(0, -5, 52.5).u));
        check('non-finite arguments give no data',
          f.sample(NaN, -5, 52.5) === null && f.sample(0, undefined, 52.5) === null);
      }

      // A mis-sized atlas is caught at construction rather than read from the wrong
      // offset for the rest of the session.
      {
        const bad = {
          atlas: { u: 'u.png', v: 'v.png', cols: 1, rows: 1, tileW: 8, tileH: 3 },
          grid: { nx: 4, ny: 3, lonMin: -10, lonMax: 10, latMin: 40, latMax: 55 },
          uvMax: 40, nTime: 1, frameStride: 3, framesCovered: 1,
        };
        let threw = false;
        try { new WindField(bad, new Uint8Array(24), new Uint8Array(24)); } catch { threw = true; }
        check('an atlas whose tiles do not match the grid throws', threw);

        const short = { ...bad, atlas: { ...bad.atlas, tileW: 4 } };
        let threw2 = false;
        try { new WindField(short, new Uint8Array(4), new Uint8Array(4)); } catch { threw2 = true; }
        check('a short decode throws rather than reading undefined', threw2);
      }

      // Time, against the real export's cadence rather than a made-up one. The two
      // anchors are the frames this deck is actually built on.
      if (meta.wind) {
        const w = meta.wind;
        const cells = w.grid.nx * w.grid.ny;
        // One distinct, monotonic code per wind step, so a sample identifies the
        // step -- or the pair -- it was interpolated from.
        const codes = new Uint8Array(w.nTime * cells);
        for (let k = 0; k < w.nTime; k++) codes.fill(k + 1, k * cells, (k + 1) * cells);
        check('one code per wind step fits in a byte', w.nTime + 1 <= 255, `${w.nTime} steps`);

        const f = new WindField(w, codes, codes);
        const step = (k) => decodeWind(k + 1, w.uvMax);
        const at = (t) => f.sample(t, -5, 52).u;

        check('the wind is 3-hourly', w.frameStride === 3, `stride ${w.frameStride}`);
        check('footprint frame 36 is wind step 12 exactly',
          at(FRAMES.clean) === step(12), `${at(FRAMES.clean)} vs ${step(12)}`);
        // The interpolation path, on a literal frame rather than on an anchor.
        // These two used to run off `FRAMES.dirty`, and moving that anchor from 152
        // to 153 landed it exactly on wind step 51 -- so the checks failed while
        // testing nothing, and the code path they exist for stopped being covered.
        // A frame chosen for the story is the wrong thing to hang a numeric
        // property on. 152 is two thirds of the way from step 50 to step 51.
        check('footprint frame 152 sits strictly between steps 50 and 51',
          at(152) > step(50) && at(152) < step(51), String(at(152)));
        check('two thirds of the way is two thirds of the way',
          Math.abs(at(152) - (step(50) + (step(51) - step(50)) * (2 / 3))) < 1e-9);
        check('a fractional footprint frame interpolates',
          at(150.5) > at(150) && at(150.5) < at(151));

        // The tail. The wind record ends 29 Feb 21:00 and the footprints run to
        // 23:00, so the last two frames have no step after them -- and the atlas's
        // own tail is zero-padded, which is what an unclamped read would find.
        check('framesCovered matches the stride', w.framesCovered === (w.nTime - 1) * 3 + 1,
          String(w.framesCovered));
        check('the last covered frame reads the last wind step',
          at(w.framesCovered - 1) === step(w.nTime - 1), String(at(w.framesCovered - 1)));
        for (const t of [...new Set([w.framesCovered, w.framesCovered + 1, nTime - 1, 1e6])]) {
          check(`frame ${t} clamps to the last wind step rather than the padded tail`,
            at(t) === step(w.nTime - 1), String(at(t)));
        }
        check('a negative frame clamps to the first step', at(-10) === step(0));
        check('windFrame clamps at both ends',
          f.windFrame(-10) === 0 && f.windFrame(1e6) === w.nTime - 1);

        // The claim the whole crop rests on: wind cell (i, j) *is* footprint cell
        // (i, j). verify_export.py asserts the shared origin in Python; this is the
        // same claim from the side that does the indexing.
        const fg = meta.footprint.grid;
        const near = (a, b) => Math.abs(a - b) < 1e-9;
        check('the wind shares the footprint\'s western origin',
          near(w.grid.lonMin, fg.lonMin), `${w.grid.lonMin} vs ${fg.lonMin}`);
        check('the wind shares the footprint\'s latitude extent',
          near(w.grid.latMin, fg.latMin) && near(w.grid.latMax, fg.latMax));
        // Cell size is *derived* from edges that were float32 in the source grids,
        // so the two divisions disagree in the ninth decimal -- 0.3 mm. The Python
        // side holds met and footprint cell centres to 3e-6 deg; the same threshold
        // here is still five orders of magnitude tighter than the half-cell (0.18
        // deg) error this check exists to catch.
        const near6 = (a, b) => Math.abs(a - b) < 1e-6;
        check('the cells are the same size, so column j is column j',
          near6(f.dLon, (fg.lonMax - fg.lonMin) / fg.nx)
          && near6(f.dLat, (fg.latMax - fg.latMin) / fg.ny),
          `${f.dLon.toFixed(4)} x ${f.dLat.toFixed(4)} deg`);
        check('the crop only took the eastern end', w.grid.lonMax < fg.lonMax,
          `${w.grid.lonMax.toFixed(2)} vs ${fg.lonMax.toFixed(2)}`);
      } else {
        check('meta.wind is present', false, 'no wind in this export — run export_web_data.py');
      }

      // ---- the integrator ----------------------------------------------------
      //
      // The sign errors in here are the expensive kind: air drifting backwards is
      // completely convincing, and it makes the deck's central claim -- "this air
      // has come off the Atlantic" -- exactly wrong while looking correct. So the
      // physics is checked against answers that can be worked out by hand, and the
      // direction against winds whose answer is unarguable.
      console.log('\nadvection');

      // Codes chosen so the decoded values are exact: 1 is -uvMax, 128 is 0,
      // 255 is +uvMax.
      const CALM = 128;
      const uniform = (uCode, vCode) => synth(1, () => [uCode, vCode]);

      {
        const {
          AdvectedParcels, degPerSec, trailPoint, backTrack, seedFromBackTracks, kmBetween,
        } = await import('../advect.js');

        // One parcel, placed exactly, free of lifetimes and recycling.
        const one = (field, lon, lat, over = {}) => new AdvectedParcels(field, {
          count: 1, lifeHours: 1e6, trailHours: 8, trailStepHours: 0.25,
          recycle: false, stagger: false, spawn: () => ({ lon, lat }), ...over,
        });

        // Check 1: the analytic case. 10 m/s due east for an hour at 52 N is
        // 36 km, and a degree of longitude up there is 68.5 km, so 0.525 deg.
        check('the m/s to deg/s conversion is right at 52 N',
          Math.abs(degPerSec(10, 0, 52).dLon * 3600 - 0.5253) < 1e-3,
          `${(degPerSec(10, 0, 52).dLon * 3600).toFixed(5)} deg/h`);
        check('a degree of latitude does not shrink with latitude',
          degPerSec(0, 10, 0).dLat === degPerSec(0, 10, 60).dLat);
        check('longitude degrees shrink with latitude',
          degPerSec(10, 0, 60).dLon > degPerSec(10, 0, 0).dLon * 1.9);

        {
          const code = 190;
          const u = decodeWind(code, 40);
          const p = one(uniform(code, CALM), 0, 52);
          p.advance(1, 0, 0);
          const want = (u * 3600) / (111320 * Math.cos((52 * Math.PI) / 180));
          check('one hour of a uniform wind moves a parcel exactly that far',
            Math.abs(p.parcels[0].lon - want) < 1e-9,
            `${p.parcels[0].lon.toFixed(6)} vs ${want.toFixed(6)} deg`);
          check('a due-east wind does not change latitude',
            Math.abs(p.parcels[0].lat - 52) < 1e-12);
        }
        {
          // The one that inverts silently. Northward is +v, and +v must raise the
          // latitude -- the screen flip happens in the drawing, not here.
          const p = one(uniform(CALM, 255), 0, 48);
          p.advance(0.5, 0, 0);
          check('a northward wind raises the latitude', p.parcels[0].lat > 48);
          const s = one(uniform(CALM, 1), 0, 48);
          s.advance(0.5, 0, 0);
          check('a southward wind lowers it', s.parcels[0].lat < 48);
          const w = one(uniform(1, CALM), 0, 48);
          w.advance(0.5, 0, 0);
          check('a westward wind lowers the longitude', w.parcels[0].lon < 0);
        }

        // Check 2: backward inverts forward. The deck only ever runs forward, but
        // the release boxes it ships were *chosen* by integrating backward from the
        // mast, so the reverse path is load-bearing even though it is never drawn.
        {
          const field = uniform(200, 170);
          const fwd = one(field, -5, 45);
          fwd.advance(2, 0, 0);
          const { lon, lat } = fwd.parcels[0];
          const back = one(field, lon, lat, { sign: -1 });
          back.advance(2, 0, 0);
          const err = Math.hypot(back.parcels[0].lon + 5, back.parcels[0].lat - 45);
          check('backward integration returns to where forward started',
            err < 1e-6, `${err.toExponential(2)} deg`);
        }

        // Check 5: substepping is doing its job. A single 3 h leap through a
        // sheared field must differ from the same interval taken properly, and
        // halving the substep must converge rather than wander.
        {
          // Shear in latitude: eastward at the top, westward at the bottom, so a
          // parcel that drifts north genuinely meets a different wind.
          const sheared = synth(1, (k, i) => [255 - i * 60, 190]);
          const at = (maxStep) => {
            const p = one(sheared, -5, 44);
            p.maxStepHours = maxStep;
            p.advance(3, 0, 0);
            return p.parcels[0];
          };
          const coarse = at(3);
          const fine = at(3 / 64);
          const finer = at(3 / 128);
          const gap = (a, b) => Math.hypot(a.lon - b.lon, a.lat - b.lat);
          check('one leap across three hours is not the same answer',
            gap(coarse, fine) > 1e-3, `${gap(coarse, fine).toExponential(2)} deg apart`);
          check('halving the substep converges',
            gap(fine, finer) < gap(coarse, fine) / 10,
            `${gap(fine, finer).toExponential(2)} vs ${gap(coarse, fine).toExponential(2)}`);
        }

        // The 3-hourly trap (risk 1). Holding one wind frame across an interval
        // kinks every trajectory at the boundary, so the field has to be sampled at
        // each substep's own time. Two wind steps blowing opposite ways make the
        // difference impossible to miss.
        {
          const two = synth(2, (k) => [k === 0 ? 255 : 1, CALM]);
          const ramped = one(two, 0, 50);
          ramped.advance(3, 0, 3);                    // field runs step 0 -> step 1
          const held = one(two, 0, 50);
          held.advance(3, 0, 0);                      // field held at step 0
          check('the field is sampled per substep, not held for the interval',
            Math.abs(ramped.parcels[0].lon - held.parcels[0].lon) > 1,
            `${ramped.parcels[0].lon.toFixed(3)} vs ${held.parcels[0].lon.toFixed(3)}`);
          check('a reversing field nearly cancels out',
            Math.abs(ramped.parcels[0].lon) < Math.abs(held.parcels[0].lon) / 2,
            `${ramped.parcels[0].lon.toFixed(3)} deg net`);
        }

        // Per-parcel field clocks, which is what a stream needs and a cohort did
        // not. Two parcels in the same place at the same instant, one an hour from
        // the mast and one ten, are flying through weather ten hours apart -- and if
        // they are not, the stream is a picture of one hour's wind pretending to be
        // a day's. Here the field strengthens with time, so the parcel with further
        // to come reads the calmer hour and moves less.
        {
          const N = 12;
          // Wind frame k is footprint frames [3k, 3k+3), so k spans t = 0..33.
          // Codes: 128 is still, 255 is +40 m/s, and this ramps between them.
          const rising = synth(N, (k) => [Math.round(128 + (k / (N - 1)) * 127), CALM]);
          const near = one(rising, 0, 50, { anchorTau: 30 });
          const far = one(rising, 0, 50, { anchorTau: 30 });
          near.parcels[0].life = 1;
          far.parcels[0].life = 10;
          near.advance(0.5, 0, 0);
          far.advance(0.5, 0, 0);
          check('a parcel near the end of its journey reads the later weather',
            near.parcels[0].lon > far.parcels[0].lon * 1.2,
            `${near.parcels[0].lon.toFixed(3)} vs ${far.parcels[0].lon.toFixed(3)} deg in half an hour`);

          // ...and with no anchor of its own a population still reads the clock it
          // is handed -- the ambient air's case, which is held at the anchor hour
          // itself. That is later again than either journey, so the three order.
          const shared = one(rising, 0, 50);
          shared.parcels[0].life = 10;
          shared.advance(0.5, 30, 30);
          check('and without one it reads the clock it is handed',
            shared.parcels[0].lon > near.parcels[0].lon,
            `${shared.parcels[0].lon.toFixed(3)} deg at the anchor hour itself`);
        }

        // Leaving the grid. A cohort parcel must freeze rather than vanish -- a
        // parcel that disappears at the edge tells the audience the air stopped
        // there -- while an ambient tracer is scenery and recycles.
        {
          const p = one(uniform(255, CALM), 9.9, 50);
          p.advance(6, 0, 0);
          check('a cohort parcel that runs off the grid freezes',
            p.parcels[0].frozen && p.parcels[0].alive);
          check('it keeps its trail rather than vanishing', p.parcels[0].n >= 2);
          check('it stops at the edge rather than sailing on',
            p.parcels[0].lon <= 10 + 1e-9, String(p.parcels[0].lon));
          check('a settled cohort reports itself settled', p.settled);

          const amb = one(uniform(255, CALM), 9.9, 50, { recycle: true, lifeHours: 0.5 });
          amb.advance(6, 0, 0);
          check('an ambient tracer recycles instead of freezing',
            !amb.parcels[0].frozen && amb.parcels[0].alive);
          check('an ambient population never settles', !amb.settled);
        }

        // Trails. The ring buffer is read oldest-first by the drawer, and reading
        // it through the wrong capacity is silent -- the tail simply points
        // somewhere the parcel never was.
        {
          const p = one(uniform(220, CALM), -8, 50, { trailHours: 1, trailStepHours: 0.25 });
          p.advance(3, 0, 0);
          const q = p.parcels[0];
          check('the trail is capped at its window', q.n === q.cap, `${q.n} of ${q.cap}`);
          const first = trailPoint(q, 0);
          const last = trailPoint(q, q.n - 1);
          check('trail points run oldest to newest', last.lon > first.lon,
            `${first.lon.toFixed(2)} -> ${last.lon.toFixed(2)}`);
          check('the newest trail point is near the parcel',
            Math.abs(last.lon - q.lon) < 1, `${last.lon.toFixed(2)} vs ${q.lon.toFixed(2)}`);
          check('the capacity travels on the parcel, not the population',
            p.parcels.every((x) => x.cap === q.cap));
        }

        // Staggering. An ambient population that dies in unison blinks the whole
        // screen once a lifetime, which is exactly the flicker this mark exists to
        // avoid.
        {
          const p = new AdvectedParcels(uniform(200, CALM), {
            count: 40, lifeHours: 4, recycle: true, stagger: true,
          });
          const ages = new Set(p.parcels.map((x) => Math.round(x.age * 4)));
          check('ambient birthdays are spread over a lifetime', ages.size > 8,
            `${ages.size} distinct ages`);
          check('a cohort is released together', (() => {
            const c = new AdvectedParcels(uniform(200, CALM), {
              count: 20, lifeHours: 4, recycle: false, stagger: false,
            });
            return c.parcels.every((x) => x.age === 0);
          })());
        }

        // The substep cap is derived from the grid rather than picked, so a
        // re-export at a different resolution moves it on its own.
        {
          const p = one(uniform(200, CALM), 0, 50);
          check('the substep cap keeps a parcel inside a quarter cell',
            p.maxStepHours > 0 && p.maxStepHours < 24, `${p.maxStepHours.toFixed(4)} h`);
        }

        // ---- the back-track and the plume seeding ---------------------------
        //
        // The seeding is the piece that decides where the red air comes from, and
        // in the headless mount it runs against a stubbed footprint of all zeros --
        // so the mount only proves it does not throw. Here the field and the plume
        // are both built by hand, where the right answer is arithmetic.
        //
        // Code 160 decodes to +10.08 m/s, so the air runs due east and a back-track
        // runs due west at a rate a calculator can check.
        {
          const EAST = 160;
          const field = uniform(EAST, CALM);
          const mLon = 5;
          const mLat = 47.5;

          const track = backTrack(field, { lon: mLon, lat: mLat, anchor: 0, hours: 24 });
          check('a back-track starts where it was released',
            track[0].lon === mLon && track[0].lat === mLat && track[0].hours === 0);
          check('a back-track runs upwind', track[track.length - 1].lon < mLon,
            `${track[track.length - 1].lon.toFixed(2)}`);
          check('a back-track keeps its latitude in a due-east wind',
            Math.abs(track[track.length - 1].lat - mLat) < 1e-6);
          {
            // 10.08 m/s for an hour is 36.28 km, and a degree of longitude at
            // 47.5 N is 75.21 km, so 0.4824 deg/h. Checked as a *rate* rather than
            // at the one-hour mark: the substep cap is derived from the grid, and
            // on this coarse synthetic one it lands at 0.65 h, so there is no
            // recorded point at 1 h to look at.
            const p = track.reduce((a, b) => (Math.abs(b.hours - 1) < Math.abs(a.hours - 1) ? b : a));
            const rate = (mLon - p.lon) / p.hours;
            check('a back-track covers the right ground per hour',
              Math.abs(rate - 0.4824) < 0.01, `${rate.toFixed(4)} deg/h at ${p.hours.toFixed(2)} h`);
          }
          check('hours count backwards along the track',
            track.every((p, i) => i === 0 || p.hours > track[i - 1].hours));

          // The fan. A trajectory traced back from the mast ends at the mast, so
          // the property to hold onto is that flying the far ends home lands them
          // all on it -- which is exactly what the corridor design this replaced
          // could not do, and what the user saw as a diagonal scatter on screen.
          const seeds = seedFromBackTracks(field, {
            lon: mLon, lat: mLat, anchor: 0, hours: 24, arrivals: 12, count: 24,
            jitterKm: 15,
          });

          check('the fan returns the trajectories it was asked for',
            seeds.length === 24, `${seeds.length}`);
          check('every seed carries a journey and an arrival',
            seeds.every((s) => s.hours > 0.25 && s.hours <= 24
              && s.arrival >= 0 && s.arrival <= 12));
          check('the fan spreads its arrivals rather than stacking them',
            new Set(seeds.map((s) => Math.round(s.arrival * 4))).size > 8,
            `${new Set(seeds.map((s) => Math.round(s.arrival * 4))).size} distinct`);
          check('every seed is upwind of the mast in an eastward wind',
            seeds.every((s) => s.lon < mLon));

          // A single arrival hour collapses the fan to one thread, which is the
          // failure mode the `arrivals` dial exists to avoid. Worth pinning down,
          // because it is invisible until someone sets it to zero.
          {
            const thread = seedFromBackTracks(field, {
              lon: mLon, lat: mLat, anchor: 0, hours: 24, arrivals: 0, count: 24,
              jitterKm: 0,
            });
            const width = (xs) => Math.max(...xs.map((s) => s.lat)) - Math.min(...xs.map((s) => s.lat));
            check('no arrival spread and no jitter really is one thread',
              width(thread) < 1e-6, `${width(thread).toFixed(6)} deg`);
          }

          // The journey home. This is the claim the slide makes, and on this
          // synthetic field it can be checked exactly rather than statistically:
          // backward and forward integration are inverses, so every parcel should
          // return to within metres of where its track was traced from.
          {
            const window = 24 + 12;
            const pop = new AdvectedParcels(field, {
              count: seeds.length, lifeHours: window, trailHours: window,
              trailStepHours: 0.35, recycle: false, stagger: false,
              spawn: (i) => {
                const s = seeds[i];
                return {
                  lon: s.lon, lat: s.lat, age: -(window - s.arrival - s.hours), life: s.hours,
                };
              },
            });
            pop.runToEnd(window + 0.05, -window, 0);
            check('every parcel in the fan finishes its journey and stops', pop.settled);
            const miss = pop.parcels.map((p) => kmBetween(p.lon, p.lat, mLon, mLat));
            const worst = Math.max(...miss);
            // Every parcel comes home to within the jitter it started from -- the
            // only spread left is the sampling-volume disc, which is the honest
            // one. The corridor design this replaced measured a 532 km worst case
            // here, and that was the diagonal on screen.
            check('every trajectory in the fan ends at the mast', worst < 16,
              `worst ${worst.toFixed(1)} km, jitter is 15`);
            check('and the trails are the whole journey, not a window',
              pop.parcels.every((p) => p.n >= 2));
          }

          // The funnel needs weather that changes, so it gets its own field.
          //
          // In a steady uniform wind every back-trajectory is the same line
          // translated, whatever hour it arrives -- the fan has no width to open.
          // It opens because the weather *turns*, which is a real property of
          // February and the reason spreading arrival times spreads the air.
          {
            const codeFor = (x) => Math.round(1 + ((x + 40) / 80) * 254);
            const N = 20;
            const turning = synth(N, (k) => {
              const th = (k / (N - 1)) * 0.9;                 // ~52 deg of backing
              return [codeFor(10 * Math.cos(th)), codeFor(10 * Math.sin(th))];
            });
            const anchor = 40;
            const fan = seedFromBackTracks(turning, {
              lon: 5, lat: 47.5, anchor, hours: 12, arrivals: 8, count: 20, jitterKm: 5,
            });
            const latSpread = (xs) => Math.max(...xs.map((s) => s.lat))
              - Math.min(...xs.map((s) => s.lat));
            // Against the same call on a steady wind, where the only spread is the
            // jitter disc. Stated as a ratio rather than an absolute width because
            // the width depends on how hard this synthetic turns, which is
            // arbitrary -- what is not arbitrary is that turning is what opens it.
            const steady = seedFromBackTracks(uniform(EAST, CALM), {
              lon: 5, lat: 47.5, anchor, hours: 12, arrivals: 8, count: 20, jitterKm: 5,
            });
            check('a turning wind opens the fan and a steady one does not',
              latSpread(fan) > latSpread(steady) * 3,
              `${latSpread(fan).toFixed(2)} deg turning vs ${latSpread(steady).toFixed(2)} steady`);

            const window = 12 + 8;
            const pop = new AdvectedParcels(turning, {
              count: fan.length, lifeHours: window, trailHours: window,
              trailStepHours: 0.3, recycle: false, stagger: false,
              spawn: (i) => {
                const s = fan[i];
                return {
                  lon: s.lon, lat: s.lat, age: -(window - s.arrival - s.hours), life: s.hours,
                };
              },
            });
            pop.runToEnd(window + 0.05, anchor - window, anchor);
            const atEnd = latSpread(pop.parcels);
            check('and the cohort still thickens to a point at the mast',
              atEnd < latSpread(fan) / 4,
              `${atEnd.toFixed(2)} deg at the mast vs ${latSpread(fan).toFixed(2)} at the far end`);
            check('every parcel of a turning fan still comes home',
              pop.parcels.every((p) => kmBetween(p.lon, p.lat, 5, 47.5) < 12),
              `worst ${Math.max(...pop.parcels.map((p) => kmBetween(p.lon, p.lat, 5, 47.5))).toFixed(1)} km`);
          }
        }
      }

      // ---- the wind layer ----------------------------------------------------
      //
      // The mark this deck ships. The arrow lattice it replaced was legible and
      // correct and dead -- nothing moved, so the moment passed with nothing to
      // notice -- and the checks that went with it retired along with it. What
      // matters now is that the air moves the right way, that the two populations
      // stay one idea, and that a held slide never stops moving.
      console.log('\nthe wind layer');
      {
        const { WindLayer } = await import('../wind.js');
        const { RELEASES } = await import('./beats.js');

        const recorder = () => {
          const ops = [];
          return {
            ops,
            save() {}, restore() {},
            beginPath() { ops.push(['begin']); },
            moveTo(x, y) { ops.push(['move', x, y]); },
            lineTo(x, y) { ops.push(['line', x, y]); },
            stroke() { ops.push(['stroke']); },
            set strokeStyle(v) { ops.push(['colour', v]); },
            set lineWidth(v) { ops.push(['width', v]); },
            set globalAlpha(v) { ops.push(['alpha', v]); },
            set lineCap(_v) {}, set lineJoin(_v) {},
          };
        };

        // Camera well inside the synthetic grid (lon -10..10, lat 40..55), so
        // nothing is dropped for being off-grid or inside the edge fade.
        const fakeMap = (over = {}) => ({
          w: 1600, h: 900, t: 0,
          layers: { wind: 1 },
          cam: { lon: 0, lat: 47.5, span: 12 },
          get ppd() { return this.w / this.cam.span; },
          x(lon) { return this.w / 2 + (lon - this.cam.lon) * this.ppd; },
          y(lat) { return this.h / 2 - (lat - this.cam.lat) * this.ppd; },
          lonLatAt(px, py) {
            return {
              lon: this.cam.lon + (px - this.w / 2) / this.ppd,
              lat: this.cam.lat - (py - this.h / 2) / this.ppd,
            };
          },
          ...over,
        });

        /** A layer on a uniform field, seeded at one spot so motion is readable. */
        const layerAt = (uCode, vCode, lon, lat, opts = {}) => {
          const l = new WindLayer(uniform(uCode, vCode), opts);
          l.setStop({ anchor: 0, release: null });
          l.ambient.spawn = () => ({ lon, lat });
          l.ambient.stagger = false;
          l.ambient.reset();
          return l;
        };

        // Direction, through the whole layer rather than the integrator alone.
        {
          const e = layerAt(255, CALM, -5, 48);
          e.tick(0.5);
          check('the layer carries air east on an eastward wind',
            e.ambient.parcels[0].lon > -5, String(e.ambient.parcels[0].lon.toFixed(3)));
          const n = layerAt(CALM, 255, -5, 48);
          n.tick(0.5);
          check('the layer carries air north on a northward wind',
            n.ambient.parcels[0].lat > 48);
        }

        // The screen flip, which is the only place the sign can still invert: north
        // is up, and canvas y counts down.
        {
          const l = layerAt(CALM, 255, -5, 46);
          for (let k = 0; k < 8; k++) l.tick(0.1);
          const p = l.ambient.parcels[0];
          const oldest = l.trailXY(fakeMap(), p, 0);
          const newest = l.trailXY(fakeMap(), p, p.n - 1);
          check('northward air draws up the screen', newest.y < oldest.y,
            `${oldest.y.toFixed(1)} -> ${newest.y.toFixed(1)} px`);
          check('northward air does not drift sideways',
            Math.abs(newest.x - oldest.x) < 1e-6);
        }

        // A held slide must never stop moving. This is the fault that killed the
        // arrows -- the field was correct and the picture was a still image.
        {
          const l = layerAt(200, 170, -5, 46);
          l.draw(recorder(), fakeMap());              // sizes the population first
          for (let k = 0; k < 60; k++) l.tick(1 / 60);
          const cx = recorder();
          l.draw(cx, fakeMap());
          const segments = cx.ops.filter((o) => o[0] === 'line').length;
          const a = { ...l.ambient.parcels[0] };
          for (let k = 0; k < 20; k++) l.tick(1 / 60);
          const b = l.ambient.parcels[0];
          check('an ambient stop is still moving after it has settled',
            Math.hypot(b.lon - a.lon, b.lat - a.lat) > 1e-4);
          check('and it is drawing the whole population, not one parcel',
            segments > l.ambient.count, `${segments} segments for ${l.ambient.count} tracers`);
        }

        // Density scales with the canvas, and the key that retunes it works. The
        // arrow lattice was killed for being too busy at a density that had already
        // been halved once, which is the tell that this cannot be settled from a
        // desk.
        {
          const l = layerAt(200, CALM, -5, 46);
          const small = l.countFor(800, 450);
          const big = l.countFor(1600, 900);
          check('a bigger canvas gets more tracers, in proportion',
            Math.abs(big / small - 4) < 0.1, `${small} -> ${big}`);
          check('the shipped density is sparse enough to read as a flow',
            big >= 90 && big <= 500, `${big} tracers on a 1600x900 deck`);
          const first = l.pitch;
          const seen = new Set([first]);
          for (let k = 0; k < 6; k++) seen.add(l.cyclePitch());
          check('W cycles the density and comes back round', seen.size >= 3 && l.pitch === first,
            [...seen].join(', '));
          l.draw(recorder(), fakeMap());
          check('drawing sizes the population to the canvas',
            l.ambient.count === l.countFor(1600, 900), `${l.ambient.count}`);
        }

        // A layer that is switched off must cost nothing, not draw transparently.
        {
          const cx = recorder();
          layerAt(255, CALM, -5, 46).draw(cx, fakeMap({ layers: { wind: 0 } }));
          check('a stop with the layer off draws nothing at all', cx.ops.length === 0);
        }

        // N3: the seed region.
        //
        // The reported fault was ambient air appearing only in a square in the top
        // right of the Atlantic frame. The cause was not the distribution -- the
        // spawn is uniform and always was -- but *which* box it was uniform over:
        // `setStop` resets the population before any frame has been drawn at the new
        // camera, so it seeded against the framing the deck was leaving. Here that
        // is a small box up and to the right of a big one, which is the geometry of
        // the bug.
        {
          const { viewFromCamera } = await import('../wind.js');

          const small = viewFromCamera({ lon: 5, lat: 52, span: 4 }, 1600, 900);
          check('a camera becomes a frame, wide in longitude and shallow in latitude',
            Math.abs((small.lonMax - small.lonMin) - 4) < 1e-9
            && Math.abs((small.latMax - small.latMin) - 4 * (900 / 1600)) < 1e-9,
            `${(small.lonMax - small.lonMin).toFixed(2)} x ${(small.latMax - small.latMin).toFixed(2)} deg`);

          const l = new WindLayer(uniform(CALM, CALM), {});
          l.setStop({ anchor: 1, release: null, view: small });
          l.ambient.setCount(400);
          l.ambient.reset();
          const inSmall = l.ambient.parcels.filter((p) => p.lon >= small.lonMin && p.lon <= small.lonMax).length;
          check('the ambient air seeds inside the frame it was handed',
            inSmall === l.ambient.count, `${inSmall} of ${l.ambient.count}`);

          // Now the step that used to break: a new anchor *and* a new framing, with
          // no frame drawn in between. Every tracer must be in the new frame.
          const big = viewFromCamera({ lon: -5, lat: 46, span: 16 }, 1600, 900);
          l.setStop({ anchor: 2, release: null, view: big });
          const stale = l.ambient.parcels.filter((p) => p.lon > small.lonMin).length;
          check('a new slide reseeds against the camera it is flying to, not the one it left',
            stale === 0, `${stale} tracers left behind in the old frame`);
        }

        // ...and the second half of N3: uniform seeding across the frame is not a
        // uniform steady state. Tracers only enter where they respawn and all drift
        // downwind, so the upwind edge thins over one lifetime of travel. The seed
        // box is pushed out on the side the air arrives from to compensate.
        {
          const view = { lonMin: -8, lonMax: 8, latMin: 42, latMax: 52 };

          const calm = new WindLayer(uniform(CALM, CALM), {});
          calm.setStop({ anchor: 0, release: null, view });
          check('still air needs no upwind margin at all',
            calm.spawnBox.lonMin === view.lonMin && calm.spawnRatio === 1,
            `ratio ${calm.spawnRatio.toFixed(2)}`);

          // 255 is +uvMax: a 40 m/s easterly-bound gale, well past the cap.
          const gale = new WindLayer(uniform(255, CALM), {});
          gale.setStop({ anchor: 0, release: null, view });
          check('air arriving from the west is seeded west of the frame',
            gale.spawnBox.lonMin < view.lonMin && gale.spawnBox.lonMax === view.lonMax,
            `${gale.spawnBox.lonMin.toFixed(2)} vs frame ${view.lonMin}`);

          const west = new WindLayer(uniform(1, CALM), {});
          west.setStop({ anchor: 0, release: null, view });
          check('and air arriving from the east is seeded east of it',
            west.spawnBox.lonMax > view.lonMax && west.spawnBox.lonMin === view.lonMin,
            `${west.spawnBox.lonMax.toFixed(2)} vs frame ${view.lonMax}`);

          // The margin is bounded twice over: by the frame, so a gale cannot seed a
          // region that dwarfs it, and by the data, because there is no wind to
          // sample outside the crop.
          check('the margin is capped rather than scaled with the gale',
            gale.spawnBox.lonMin >= -10 - 1e-9
            && view.lonMin - gale.spawnBox.lonMin <= 0.5 * 16 + 1e-9,
            `${(view.lonMin - gale.spawnBox.lonMin).toFixed(2)} deg of margin`);
          check('and the count follows the seed area, so the frame keeps its density',
            gale.countFor(1600, 900) > calm.countFor(1600, 900)
            && gale.spawnRatio <= 1.5 + 1e-9,
            `${calm.countFor(1600, 900)} -> ${gale.countFor(1600, 900)} tracers, ratio ${gale.spawnRatio.toFixed(2)}`);
        }

        // The journey: a cohort released before the anchor, run forward to it, then
        // held with its track still drawn.
        //
        // The stream, which is what the red air is now. What it replaced was a
        // cohort: two dozen parcels seeded at the far ends of the tracks, flown to
        // the mast together, held, and replayed. The checks that went with it --
        // that the journey reached the anchor, held, and replayed -- retired with
        // it, because a stream has no such moments. What is load-bearing instead is
        // that it never stops, that it is spread along the whole plume rather than
        // bunched at the rim, and that every parcel still ends at the mast.
        {
          const { kmBetween: km } = await import('../advect.js');
          const { AdvectedParcels: Parcels } = await import('../advect.js');

          const field = uniform(160, CALM);            // ~10 m/s from the west
          const station = { lon: 5, lat: 47.5 };
          const grid = { nx: 4, ny: 3, lonMin: -10, lonMax: 10, latMin: 40, latMax: 55 };
          const release = {
            seed: 'backTrack', hours: 12, arrivals: 6, jitterKm: 10, count: 12, parcels: 8,
          };
          const layerFor = (extra = {}) => new WindLayer(field, {
            plume: { grid, station, ...extra },
          });

          {
            const l = layerFor();
            l.setStop({ anchor: 20, release });
            check('a release builds a stream that recycles, not a cohort that ends',
              l.phase === 'stream' && l.journey.recycle === true, l.phase);
            check('the stream carries far fewer marks than the fan has tracks',
              l.journey.count === 8 && l.fan.length > 8,
              `${l.journey.count} marks over ${l.fan.length} tracks`);

            // The whole of "starting throughout the plume". A cohort's seeds all
            // sit at one distance; a stream's are spread along the tracks, so at any
            // moment some air is nearly home and some has most of the way to come.
            const hrs = l._seedTable().pts.map((p) => p.hours);
            check('seeds are spread along the tracks, not bunched at the far end',
              Math.min(...hrs) < 2 && Math.max(...hrs) > release.hours * 0.8,
              `${Math.min(...hrs).toFixed(1)}..${Math.max(...hrs).toFixed(1)} h from the mast`);

            // ...and the whole of "ending at the mast". Every seed is a point on a
            // trajectory traced back from the tower, so flying it home lands on the
            // tower -- the property the 300 km corridor gave up.
            const pts = l._seedTable().pts;
            const pop = new Parcels(field, {
              count: pts.length, recycle: false, stagger: false, anchorTau: 20,
              trailHours: 1, trailStepHours: 0.5,
              spawn: (i) => ({
                lon: pts[i].lon, lat: pts[i].lat, age: 0, life: pts[i].hours,
                tauOffset: pts[i].arrival,
              }),
            });
            pop.runToEnd(release.hours + 0.2, 0, 0);
            const worst = Math.max(...pop.parcels.map((p) => km(p.lon, p.lat, station.lon, station.lat)));
            check('a parcel started anywhere on a track still ends at the mast',
              worst < release.jitterKm + 3, `worst ${worst.toFixed(1)} km, jitter is ${release.jitterKm}`);
          }

          // The fan belongs to an hour, and moving to another hour has to rebuild
          // it. This shipped broken for one round: the seed table cached itself and
          // was consulted *before* the fan was checked, so the fan's own
          // invalidation never ran -- and the dirty day drew the clean day's fan,
          // air running out to the south-west of a mast it was arriving at from the
          // south-east. Two anchors in a field that reverses, so a stale fan points
          // exactly the wrong way rather than merely being slightly off.
          {
            const N = 12;
            const rev = synth(N, (k) => [k < N / 2 ? 200 : 56, CALM]);
            const l = new WindLayer(rev, { plume: { grid, station } });

            l.setStop({ anchor: 6, release });             // eastward: air came from the west
            const early = l._seedTable().pts.map((p) => p.lon);
            const earlyKey = l.fanKey;
            l.setStop({ anchor: 30, release });            // westward: air came from the east
            const late = l._seedTable().pts.map((p) => p.lon);

            check('the fan is rebuilt when the slide moves to another hour',
              l.fanKey !== earlyKey, `${earlyKey} -> ${l.fanKey}`);
            check('air arriving on an easterly is seeded west of the mast',
              early.every((lon) => lon < station.lon), `worst ${Math.max(...early).toFixed(2)}`);
            check('and on a westerly it is seeded east of it, not left pointing the old way',
              late.every((lon) => lon > station.lon), `worst ${Math.min(...late).toFixed(2)}`);
          }

          // "Only where the footprint is high": the tracks say where the air went,
          // and the drawn plume vetoes the half of them the audience cannot see.
          // Measured on the shipped export, that really is about half the clean
          // day's track length -- see PLUME_GATE.
          {
            const red = (t, lon) => (lon > 2 ? 0.9 : 0.05);
            const l = layerFor({ alphaAt: (t, lon) => red(t, lon) });
            l.setStop({ anchor: 20, release });
            let inside = 0;
            for (let k = 0; k < 400; k++) if (l._pickSeed().lon > 2) inside++;
            check('the stream starts only where the map is red', inside === 400,
              `${inside} of 400 seeds in the red half`);
            // The gate must not collapse the stream into the near field. Here the
            // red reaches 3 deg west of the mast, which at 10 m/s is about six
            // hours of travel, so that is the whole of what survives -- and it is
            // still a spread rather than a ring around the tower. On the shipped
            // export the equivalent number is flat: 60% of track inside the red in
            // the first two hours, then 31-40% all the way out to 24 h.
            const spanned = l._seedTable().pts.map((p) => p.hours);
            check('and the gate still leaves air at a spread of distances',
              Math.min(...spanned) < 1 && Math.max(...spanned) > 4,
              `${Math.min(...spanned).toFixed(1)}..${Math.max(...spanned).toFixed(1)} h`);

            const flat = layerFor();
            flat.setStop({ anchor: 20, release });
            let flatIn = 0;
            for (let k = 0; k < 400; k++) if (flat._pickSeed().lon > 2) flatIn++;
            check('and without a plume to ask it seeds the whole track',
              Math.abs(flatIn - 200) < 70, `${flatIn} of 400`);
          }

          // The other half of the same rule: air that drifts out of the red goes,
          // rather than carrying on over sea the slide has just called empty. This
          // is what stops the backwards air running to the edge of the world.
          {
            const l = layerFor({ alphaAt: (t, lon) => (lon > 2 ? 0.9 : 0.05) });
            l.setStop({ anchor: 20, release, mode: 'back' });
            // Backwards into a westerly, so every parcel crosses lon 2 sooner or
            // later. Long enough that an unculled one would be far past it.
            for (let k = 0; k < 60 * 10; k++) l.tick(1 / 60);
            const out = l.journey.parcels.filter((p) => p.age > 0 && p.lon <= 2);
            check('air that leaves the red is culled, not left running',
              out.every((p) => p.fadeOut !== undefined && p.fadeOut <= 0.5 + 1e-9),
              `${out.length} parcels past the edge, all fading`);
            check('and none of them gets far past it',
              l.journey.parcels.every((p) => p.lon > 1.4),
              `furthest ${Math.min(...l.journey.parcels.map((p) => p.lon)).toFixed(2)} deg`);
          }

          // It never ends. The arrow lattice was killed for being a still image;
          // a stream that quietly ran out of parcels would be the same fault with
          // more steps.
          {
            const l = layerFor();
            l.setStop({ anchor: 20, release });
            l.draw(recorder(), fakeMap({ cam: { lon: 0, lat: 47.5, span: 24 } }));
            for (let k = 0; k < 60 * 20; k++) l.tick(1 / 60);   // 20 s, ~48 h of weather
            check('the stream is still running twenty seconds in',
              l.phase === 'stream' && l.journey.parcels.every((p) => p.alive),
              `${l.journey.parcels.filter((p) => p.alive).length} of ${l.journey.count} alive`);
            const a = { ...l.journey.parcels[0] };
            for (let k = 0; k < 20; k++) l.tick(1 / 60);
            check('and it is still moving',
              Math.hypot(l.journey.parcels[0].lon - a.lon, l.journey.parcels[0].lat - a.lat) > 1e-4
              || l.journey.parcels[0].age < a.age,
              'a parcel either moved or was recycled');
          }

          // ...and viceversa: the same fan run the other way. Air leaves the mast
          // and goes back out to where it came from, which is the stop whose
          // caption asks "where was this air?".
          {
            const l = layerFor();
            l.setStop({ anchor: 20, release, mode: 'back' });
            const start = l.journey.parcels.map((p) => km(p.lon, p.lat, station.lon, station.lat));
            check('backwards air starts at the mast',
              Math.max(...start) < release.jitterKm + 1,
              `worst ${Math.max(...start).toFixed(1)} km`);
            for (let k = 0; k < 60 * 3; k++) l.tick(1 / 60);
            const now = l.journey.parcels.map((p) => km(p.lon, p.lat, station.lon, station.lat));
            // Not all of them: they are staggered, so at any moment some have only
            // just set off. What matters is that the ones that have gone have gone
            // *upwind*, into a westerly, rather than downwind with it.
            check('and then leaves it, upwind',
              now.filter((d) => d > 40).length >= 2
              && l.journey.parcels.every((p) => p.lon <= station.lon + 0.2),
              `${now.filter((d) => d > 40).length} of ${l.journey.count} more than 40 km out`);
          }

          // The painted fan is on its own clock -- wall seconds, not weather -- and
          // it is complete the moment a stop that holds it opens, however that stop
          // was reached.
          {
            const l = layerFor();
            l.setStop({ anchor: 20, release, mode: 'back', paint: 'draw' });
            check('a painting stop starts with nothing down', l.reveal === 0);
            for (let k = 0; k < 60; k++) l.tick(1 / 60);
            check('and the front walks out from the mast on wall time',
              l.reveal > 0 && l.reveal < 1, l.reveal.toFixed(2));

            const j = layerFor();
            j.setStop({ anchor: 20, release, mode: 'back', paint: 'hold' });
            check('a stop that holds the tracks has them all, even jumped straight to',
              j.reveal === 1);

            j.setStop({ anchor: 21, release, paint: null });
            check('and moving day clears them, front and all',
              j.reveal === 0 && j.fan.every((e) => e.stampedTo === 0));
          }
        }

        // The continuity claim, and the reason the mark changed at all: stepping
        // from "today the wind comes off the Atlantic" to the backwards stop is a
        // caption change over a picture that does not restart. If the ambient
        // population were rebuilt on that step the audience would see the air blink
        // and start again, at the very moment they are asked to follow one piece of
        // it. (The two used to have a forwards stop between them; dropping it made
        // this step the one that carries the continuity, so it matters more, not
        // less.)
        {
          const l = layerAt(200, 170, -5, 46);
          for (let k = 0; k < 40; k++) l.tick(1 / 60);
          const before = l.ambient.parcels.map((p) => `${p.lon},${p.lat}`).join('|');
          l.setStop({ anchor: 0, release: RELEASES.ocean });
          const after = l.ambient.parcels.map((p) => `${p.lon},${p.lat}`).join('|');
          check('adding a release leaves the ambient air exactly where it was',
            before === after);
          check('and it does start a stream', !!l.journey && l.phase === 'stream');

          l.setStop({ anchor: 99, release: null });
          check('moving to another day does reseed the air',
            l.ambient.parcels.every((p) => p.age === 0),
            `ages ${l.ambient.parcels.map((p) => p.age.toFixed(2)).join(',')}`);
        }

        // The release boxes are claims about February 2020 and they have to land on
        // data and on screen. The trajectories themselves were measured in Python
        // against the shipped atlases -- see the note above RELEASES -- which is
        // what caught the plan's own box missing the mast by 940 km.
        {
          const wg = meta.wind ? meta.wind.grid : null;
          // A release either names a box or asks for a fan traced back from the
          // mast. Only the first has coordinates to check.
          const fixed = (r) => !r.seed;
          for (const [name, r] of Object.entries(RELEASES)) {
            check(`release "${name}" has a sane window`,
              r.hours > 0 && r.hours <= 48 && r.count > 0, `${r.hours} h, ${r.count} tracks`);
            if (r.seed === 'backTrack') {
              // A fan has no box to check -- it is traced from the mast at run
              // time. What can rot is the arrival spread, which is the only reason
              // there is more than one trajectory: at 0 it collapses to a thread.
              // It is allowed to reach the window: the two are independent, one
              // being how far back the air is followed and the other how many hours
              // of arrivals the fan is drawn from.
              check(`release "${name}" spreads its arrivals`,
                r.arrivals > 0 && r.arrivals <= r.hours, `${r.arrivals} h of ${r.hours} h`);
              // Marks and tracks are different numbers, and the point of the stream
              // is that there are far fewer of the first.
              check(`release "${name}" draws fewer marks than it has tracks`,
                r.parcels > 0 && r.parcels <= r.count,
                `${r.parcels} marks over ${r.count} tracks`);
              check(`release "${name}" jitters off the mast`,
                r.jitterKm > 0 && r.jitterKm < 60, `${r.jitterKm} km`);
            } else if (wg) {
              check(`release "${name}" sits on the wind grid`,
                r.lon - r.spreadLon >= wg.lonMin && r.lon + r.spreadLon <= wg.lonMax
                && r.lat - r.spreadLat >= wg.latMin && r.lat + r.spreadLat <= wg.latMax,
                `${r.lon} +/- ${r.spreadLon}, ${r.lat} +/- ${r.spreadLat}`);
            }
          }
          // Named releases must exist, and a fixed box must be visible on the stop
          // that uses it -- a cohort released off the bottom of the frame is
          // invisible for the half of the journey that makes the point.
          for (const s of slides) {
            if (!s.release) continue;
            const r = RELEASES[s.release.from];
            check(`${s.actId}/${s.stopIndex}: names a release that exists`, !!r, s.release.from);
            if (!r) continue;
            if (fixed(r)) {
              const halfLon = s.camera.span / 2;
              const halfLat = (s.camera.span * (9 / 16)) / 2;
              check(`${s.actId}/${s.stopIndex}: the release starts on screen`,
                Math.abs(r.lon - s.camera.lon) + r.spreadLon <= halfLon
                && Math.abs(r.lat - s.camera.lat) + r.spreadLat <= halfLat,
                `${r.lon}, ${r.lat} in ${s.camera.lon}+/-${halfLon.toFixed(1)}, `
                + `${s.camera.lat}+/-${halfLat.toFixed(1)}`);
            }
            // The reveal stop holds the painted tracks with the tracers switched
            // off, so it does not need the wind layer drawn -- but it does still
            // need a wind field to have made them.
            if (s.layers.wind > 0) {
              check(`${s.actId}/${s.stopIndex}: the release needs the wind to exist`,
                s.needs.includes('wind'));
            }
          }
          check('both wind acts release something',
            slides.filter((s) => s.release).length >= 2,
            `${slides.filter((s) => s.release).length} releases`);

          // The clean day's seeds are measured to reach lat 43.25 at 24 h / 300 km,
          // which is why the act's camera dropped two degrees. If someone shortens
          // the frame or lengthens the window, this is what says so.
          {
            const s = slides.find((x) => x.actId === 'clean-wind' && x.release);
            const bottom = s.camera.lat - s.camera.span * (9 / 16) / 2;
            check('the clean act frames the seeded cohort at 16:9', bottom <= 43.25,
              `frame bottom ${bottom.toFixed(2)} vs seeds at 43.25`);
          }

          // The reveal pair: the air runs back out on one slide and is still
          // running on the next, when the real plume comes up over it. They are in
          // different acts, so this is where the pair can silently come apart.
          //
          // Nothing is painted any more -- an accumulation buffer under the plume
          // read as a second map competing with the real one -- so what has to hold
          // is that both stops run the same air backwards and that they are
          // adjacent. If the second stopped releasing, the plume would land on an
          // empty map.
          {
            const backStops = slides.filter((s) => s.mode === 'back');
            const pair = backStops.find((s) => {
              const next = slides[slides.indexOf(s) + 1];
              return next && next.mode === 'back' && next.layers.footprint > 0;
            });
            check('a stop runs the air backwards', backStops.length > 0,
              backStops.map((s) => s.actId).join(', '));
            check('and the plume comes up over it while it is still running', !!pair,
              pair && pair.actId);
            if (pair) {
              const next = slides[slides.indexOf(pair) + 1];
              check('both stops follow the same air',
                pair.release.from === next.release.from, pair.release.from);
              check('the first shows no plume, so the reveal is a reveal',
                !(pair.layers.footprint > 0));
              check('and neither paints anything',
                !pair.paint && !next.paint);
            }
          }
        }

        // The ramp. Structure only -- the contrast and CVD numbers were measured
        // once and are recorded in palette.js; what can rot here is someone editing
        // a hex and quietly breaking "faster means darker".
        {
          const {
            RAMPS, windColour, parcelColour, WIND_SATURATE_MS, PARCEL_CUT,
          } = await import('../palette.js');

          const lum = (h) => {
            const n = parseInt(h.slice(1), 16);
            const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
              .map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
            return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
          };
          const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          const rgbOf = (h) => `rgb(${parseInt(h.slice(1, 3), 16)},`
            + `${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)})`;

          // Both populations share every wind frame, so both ramps get the same
          // treatment. The rule they break together is the sequential one -- a
          // trail is a hairline, and a hairline that recedes into the map reads as
          // a hole in the field rather than as slow air.
          for (const [name, ramp, colourAt] of [
            ['wind', RAMPS.wind, windColour], ['parcel', RAMPS.parcel, parcelColour],
          ]) {
            check(`the ${name} ramp has seven steps`, ramp.length === 7, `${ramp.length}`);
            check(`every ${name} step is a hex colour`, ramp.every((h) => /^#[0-9a-f]{6}$/.test(h)));
            const Ls = ramp.map(lum);
            check(`the ${name} ramp gets darker all the way down`,
              Ls.every((v, k) => k === 0 || v < Ls[k - 1]));
            for (const [label, bg] of [['ocean', '#e8eef4'], ['deep ocean', '#dde6ef'], ['land', '#eceae2']]) {
              const worst = Math.min(...Ls.map((L) => contrast(L, lum(bg))));
              check(`every ${name} step clears 3:1 on ${label}`, worst >= 3, `${worst.toFixed(2)}:1`);
            }
            check(`${name} colour saturates with speed`,
              colourAt(WIND_SATURATE_MS) === colourAt(WIND_SATURATE_MS * 3)
              && colourAt(WIND_SATURATE_MS) !== colourAt(0));
            check(`a dead calm gets the palest ${name} step, not nothing`,
              colourAt(0) === rgbOf(ramp[0]), colourAt(0));
          }

          // The released air is the plume's own red, taken from the plume ramp
          // rather than invented, so retuning one retunes the other. The cut is
          // what keeps only the part that works at hairline weight.
          check('the released air is drawn from the plume ramp',
            RAMPS.parcel[6] === RAMPS.footprint[6], `${RAMPS.parcel[6]} vs ${RAMPS.footprint[6]}`);
          check('and only from its darker end',
            PARCEL_CUT > 0.5 && PARCEL_CUT < 0.8 && !RAMPS.parcel.includes(RAMPS.footprint[0]),
            `cut at ${PARCEL_CUT}`);
          // The cut is sharp, and this is what pins it: one step shallower and the
          // palest colour fails on the bottom of the ocean gradient.
          check('a shallower cut really would fail the hairline rule', (() => {
            const shallow = RAMPS.footprint;
            const t = 0.55;
            const x = Math.max(0, Math.min(1, t)) * (shallow.length - 1);
            const i = Math.min(shallow.length - 2, Math.floor(x));
            const f = x - i;
            const a = [1, 3, 5].map((k) => parseInt(shallow[i].slice(k, k + 2), 16));
            const b = [1, 3, 5].map((k) => parseInt(shallow[i + 1].slice(k, k + 2), 16));
            const mix = `#${a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, '0')).join('')}`;
            return contrast(lum(mix), lum('#dde6ef')) < 3;
          })());

          // The whole point of the second ramp: the two populations must never be
          // mistaken for each other. Luminance alone cannot separate them -- they
          // sit on matched ladders on purpose -- so this checks the channel that
          // does, which is hue.
          {
            const hueOf = (h) => {
              const [r, g, b] = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
              const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
              if (mx === mn) return 0;
              const d = mx - mn;
              const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
              return ((x * 60) + 360) % 360;
            };
            const gap = RAMPS.wind.map((w, k) => {
              const d = Math.abs(hueOf(w) - hueOf(RAMPS.parcel[k]));
              return Math.min(d, 360 - d);
            });
            check('the air and the air we follow are far apart in hue',
              Math.min(...gap) > 120, `worst ${Math.min(...gap).toFixed(0)} deg`);
            check('the two ramps sit on matched lightness ladders',
              RAMPS.wind.every((w, k) => Math.abs(lum(w) - lum(RAMPS.parcel[k])) < 0.06),
              RAMPS.wind.map((w, k) => (lum(w) - lum(RAMPS.parcel[k])).toFixed(3)).join(' '));
          }
        }
      }
    }
  }

  // ---- the deck actually runs ----------------------------------------------
  // There is no browser automation here, so "the modules parse" is a much weaker
  // claim than it sounds. This mounts the real deck against stubs and walks every
  // slide, which is what catches a typo'd element id or a layer assignment that
  // throws -- failures that otherwise show up as a blank screen mid-talk.
  console.log('\nheadless mount');
  {
    const gradient = { addColorStop() {} };
    const makeCtx = () => new Proxy({}, {
      get(t, k) {
        if (k in t) return t[k];
        switch (k) {
          case 'createImageData': return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
          case 'getImageData': return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
          case 'measureText': return () => ({ width: 24 });
          case 'createLinearGradient':
          case 'createRadialGradient': return () => gradient;
          default: return () => {};
        }
      },
      set(t, k, v) { t[k] = v; return true; },
    });

    /**
     * A real class list, not a no-op.
     *
     * It was four empty functions and a `contains` that answered false, which was
     * fine while no class carried meaning. The meter's **third state** is a class
     * the stylesheet acts on -- `.meter.no-reading` -- so a stub that swallowed it
     * would leave the one state 307 of this deck's frames depend on unassertable
     * here, which is the same as untested.
     *
     * `toggle(name, force)` takes the DOM's two-argument form, which is what both
     * `paintMeter` and `enter` call it with; a one-argument stub would have made
     * `toggle(c, false)` *add* the class.
     */
    const makeClassList = () => {
      const set = new Set();
      return {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        toggle: (c, force) => {
          const on = force === undefined ? !set.has(c) : !!force;
          if (on) set.add(c); else set.delete(c);
          return on;
        },
        contains: (c) => set.has(c),
      };
    };

    const el = (id) => ({
      id,
      textContent: '', innerHTML: '', hidden: false, value: '0', max: '0', title: '',
      style: new Proxy({}, { get: (t, k) => (k === 'setProperty' ? () => {} : t[k]), set: (t, k, v) => { t[k] = v; return true; } }),
      classList: makeClassList(),
      addEventListener() {}, setAttribute() {}, appendChild() {}, remove() {},
      querySelector: () => el('q'), querySelectorAll: () => [],
      getContext: makeCtx,
      getBoundingClientRect: () => ({ width: 1280, height: 620, left: 0, top: 0 }),
    });

    const nodes = new Map();
    const byId = (id) => {
      if (!nodes.has(id)) nodes.set(id, el(id));
      return nodes.get(id);
    };

    // Listeners are captured rather than dropped, so the keys can actually be
    // pressed. The deck is driven entirely from the keyboard and none of it was
    // reachable from a test before -- a binding that silently stopped working
    // would only show up in front of an audience, which is the exact failure this
    // suite exists to prevent.
    const listeners = new Map();
    const press = (key, opts = {}) => {
      for (const fn of listeners.get('keydown') || []) {
        fn({ key, target: { tagName: 'BODY' }, preventDefault() {}, ...opts });
      }
    };

    globalThis.window = {
      devicePixelRatio: 2, innerWidth: 1600, innerHeight: 900,
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
    };
    globalThis.document = {
      getElementById: byId,
      createElement: () => el('created'),
      body: { classList: makeClassList() },
      documentElement: { requestFullscreen: () => Promise.resolve() },
    };
    globalThis.location = { search: '', protocol: 'http:' };
    globalThis.localStorage = {
      _v: {},
      getItem(k) { return this._v[k] ?? null; },
      setItem(k, v) { this._v[k] = v; },
      removeItem(k) { delete this._v[k]; },
    };
    globalThis.performance = globalThis.performance || { now: () => 0 };
    // Non-recursing, so mounting does not spin a render loop forever.
    let frames = 0;
    globalThis.requestAnimationFrame = () => { frames++; };
    // node exposes navigator as a getter-only global, so it has to be redefined
    // rather than assigned.
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: () => Promise.resolve() } },
      configurable: true,
    });

    // The atlas decodes to zeros, which is fine: this is checking the wiring, not
    // the pixels. verify_export.py is what checks the pixels, and the plants
    // section above decodes the real ones where the picture is the claim.
    //
    // Sized from this site's own meta rather than from Ridge Hill's literal
    // 3429x3120 -- nothing reads it today, but a stub that lies about the shape
    // of the data is a trap laid for whoever next asks it a question.
    const atlasPx = {
      w: meta.footprint.atlas.cols * meta.footprint.atlas.tileW,
      h: meta.footprint.atlas.rows * meta.footprint.atlas.tileH,
    };
    globalThis.Image = class {
      set src(_v) { this.width = atlasPx.w; this.height = atlasPx.h; queueMicrotask(() => this.onload && this.onload()); }
    };
    // This site's data, not Ridge Hill's. Mounting Gosan against `data-rgl/`
    // fails in the most confusing way available -- everything loads, every
    // check runs, and the numbers are quietly the other deck's.
    globalThis.fetch = async (url) => {
      const path = `${site.dir}/${String(url).split('/').pop()}`;
      if (!existsSync(path)) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(path, 'utf8')) };
    };

    const { mountDeck } = await import('./deck.js');
    // `site.deck` rather than the outer `deck`, which the mounted deck shadows
    // three lines down.
    const DECK = site.deck;
    let deck = null;
    let mountErr = null;
    try {
      deck = await mountDeck({ deck: DECK });
    } catch (e) {
      mountErr = e;
    }
    check('the deck mounts', !!deck && !mountErr, mountErr ? mountErr.message : '');

    if (deck) {
      check('a render frame was scheduled', frames > 0);
      check('it opens on the first slide', deck.state.t === deck.slides[0].t);

      // Every slide, in order, the way the right-arrow key walks them.
      let walkErr = null;
      try {
        for (let k = 0; k < deck.slides.length; k++) deck.go(k);
      } catch (e) {
        walkErr = e;
      }
      check('every slide can be entered', !walkErr, walkErr ? `${walkErr.message}` : `${deck.slides.length} slides`);

      // The pictures, through the real `enter` rather than the beats file. The
      // static section above checks what the deck *says*; this checks that
      // entering the stop actually mounts it, and -- the half that is a real bug
      // class -- that leaving takes it away again. A figure left behind is the
      // layer-left-on bug in a channel the layer table does not cover.
      if (!site.expectImages) {
        skip('mounting a picture', 'no stop on this deck puts a picture on the stage');
      } else {
        const withPic = deck.slides.findIndex((s) => (s.images || []).length > 0);
        check('a stop with a picture is reachable', withPic >= 0);
        if (withPic >= 0) {
          deck.go(withPic);
          check('entering it mounts the picture', deck.figures.length === deck.slides[withPic].images.length,
            `${deck.figures.length} on screen`);
          check('and the slot survived the defaulting',
            FIGURE_SLOTS.includes(deck.figures[0].at), deck.figures[0].at);
          const without = deck.slides.findIndex((s) => !(s.images || []).length);
          if (without >= 0) {
            deck.go(without);
            check('leaving takes it away again', deck.figures.length === 0,
              `${deck.figures.length} left behind`);
          }
        }
      }

      // Retiming is the feature most likely to be wrong in a way nobody notices:
      // the number moves but the slide does not follow it.
      const before = deck.frames.dirty;
      const dirtySlide = deck.slides.findIndex((s) => s.anchor === 'dirty');
      deck.go(dirtySlide);
      deck.retime(before + 5);
      check('retiming moves the stored moment', deck.frames.dirty === before + 5,
        `${before} -> ${deck.frames.dirty}`);
      check('retiming moves the slide with it', deck.state.t === before + 5, String(deck.state.t));
      // Under the deck's *own* key. Unscoped, this slot was shared with every
      // other deck, and a frame index means a different hour at each of them.
      const stored = globalThis.localStorage.getItem(`ghg.story.frames.${DECK.id}`);
      check('retiming persists', !!stored && JSON.parse(stored).dirty === before + 5);
      check('and not under the shared key', globalThis.localStorage.getItem('ghg.story.frames') === null);

      // Keys. Emissions cells are drawn as cells, not smoothed into a field, and
      // `G` flips that on the night. Asserting the flag rather than the pixels,
      // since the stubbed context cannot be looked at -- but the flag is what
      // draw() reads, so a broken binding fails here.
      check('the sources card draws square cells by default', deck.map.crispSources === true);
      press('g');
      check('G switches to a smoothed field', deck.map.crispSources === false);
      press('G');
      check('G switches back', deck.map.crispSources === true);

      // H puts the presenter panel away. Half of this binding lives in the
      // stylesheet -- see the [hidden] trap above, which is what made the same key
      // do nothing under its old name for months. This half checks the attribute
      // moves at all, and that it starts where the page starts it: up.
      {
        const panel = byId('scrubber');
        check('the panel is up to begin with', panel.hidden === false);
        press('h');
        check('H puts it away', panel.hidden === true);
        press('H');
        check('and brings it back', panel.hidden === false);
        press('t');
        check('T is the same switch', panel.hidden === true);
        press('t');
      }

      // The bindings the deck is actually driven by, exercised through the same
      // handler a keyboard reaches.
      deck.go(0);
      press('ArrowRight');
      check('the right arrow advances a slide', deck.index === 1, String(deck.index));
      press('ArrowLeft');
      check('the left arrow goes back', deck.index === 0, String(deck.index));
      press('x', { target: { tagName: 'INPUT' } });
      check('keys are ignored while typing in a field', deck.index === 0);

      // A slide with no moment of its own must scrub without rewriting anything.
      const free = deck.slides.findIndex((s) => !s.anchor);
      if (free >= 0) {
        deck.go(free);
        const kept = deck.frames.dirty;
        deck.retime(400);
        check('scrubbing a slide with no moment does not move the others', deck.frames.dirty === kept);
      }

      // Wind. The deck is the only page that asks for the atlases, and it must
      // keep saying so on the two stops that need them until something can paint
      // them. This was the regression the Python half introduced: `meta.wind`
      // appeared, the placeholder went away, and the stops became a camera move
      // over an empty map with nothing throwing and no caption looking wrong.
      if (!site.expectWind) {
        skip('the wind wiring', 'this deck has no wind-gated stops');
      } else {
      // The two that need the file to exist. Everything below them is about
      // what the deck does when it does *not*, which is the state Gosan is
      // actually in -- so those run for both decks and this pair does not.
      if (site.expectWindData) {
        check('the deck asked for the wind and got a sampler', !!deck.data.wind,
          deck.data.wind ? `${deck.data.wind.nTime} steps at ${deck.data.wind.levelLabel}` : 'null');
        check('a sampler means a layer', !!deck.windLayer);
      } else {
        skip('the sampler and the layer', 'no East Asia met in this export yet — Brief C');
      }
      check('the placeholder is gated on the layer, not on the export',
        deck.hasWind === !!deck.windLayer);

      // The invariant, written so it survives the layer landing: the placeholder
      // is showing exactly when the deck cannot draw wind.
      const windSlide = deck.slides.findIndex((s) => s.needs.includes('wind'));
      check('the deck has wind stops to gate', windSlide >= 0);
      if (windSlide >= 0) {
        deck.go(windSlide);
        check('a wind stop shows the placeholder while the layer is missing',
          nodes.get('pill').hidden === deck.hasWind,
          `pill hidden: ${nodes.get('pill').hidden}`);
        const plain = deck.slides.findIndex((s) => !s.needs.includes('wind'));
        deck.go(plain);
        check('a stop that needs no wind never shows the placeholder',
          nodes.get('pill').hidden === true);
      }
      }

      // The bar, through the real paintMeter rather than the arithmetic above.
      // Both halves of it have been wrong at once: `[hidden]` did nothing, because
      // an author `display: flex` beats the user-agent rule, so it showed on every
      // slide including the ones that hide it -- and it was scaled across the
      // month's range, so the clean day sat a third of the way up a bar whose
      // caption says there is nothing to smell.
      const meter = nodes.get('meter');
      const bar = nodes.get('meterFill');
      const goAct = (id) => {
        const k = deck.slides.findIndex((s) => s.actId === id);
        if (k >= 0) deck.go(k);
        return k;
      };

      // These read from Ridge Hill's six named acts. A deck whose acts are not
      // written yet has none of them, so each is gated on its own rather than
      // the section as a whole: §4's Gosan acts mirror this shape, so they light
      // up one at a time as they land instead of all at the end.
      const hasAct = (id) => deck.slides.some((s) => s.actId === id);
      const NAMED = ['where', 'sources', 'clean-smell', 'record'];
      if (!NAMED.some(hasAct)) {
        skip('the bar, act by act', `none of ${NAMED.join('/')} exist in this deck yet — §4`);
      }

      if (hasAct('where')) {
        goAct('where');
        check('the bar is hidden before there is any air on screen', meter.hidden === true);
      }
      if (hasAct('sources')) {
        goAct('sources');
        check('the bar is hidden on the guessed emissions', meter.hidden === true);
      }
      if (hasAct('clean-smell')) {
        goAct('clean-smell');
        check('the bar shows once the red patch is up', meter.hidden === false);
      }

      // `record` has no anchor of its own, so retiming it moves the frame without
      // rewriting any of the deck's moments -- which is how the month plays.
      if (goAct('record') >= 0) {
        check('the bar carries the last act', meter.hidden === false);
        // Every moment is retimed and read first, then all of it asserted -- so
        // the order the checks print in is the table's order and not the order
        // the DOM happened to be poked in. A row naming a moment this deck does
        // not have is skipped out loud; see the note on `mount` in SITES for why
        // letting it run would have passed rather than failed.
        const read = [];
        for (const m of site.bar.mount) {
          if (!(m.at in FRAMES)) continue;
          deck.retime(FRAMES[m.at]);
          read.push({ ...m, pct: Number.parseFloat(bar.style.height) });
        }
        check('it fills upward, not sideways', bar.style.width === undefined,
          String(bar.style.width));
        for (const m of read) {
          check(m.says, m.pct >= m.band[0] && m.pct <= m.band[1], `${m.pct}%`);
        }
        for (const m of site.bar.mount) {
          if (!(m.at in FRAMES)) skip(m.says, `this deck has no "${m.at}" moment`);
        }
        check('the chart stays down while the bar has the month',
          nodes.get('chartShell').hidden === true);

        // ---- the third state, on the deck as it actually paints it ----------
        //
        // The stylesheet's half is checked further up and this is the deck's,
        // because the two fail independently: a class nothing styles and a rule
        // nothing sets look identical from the audience's seat.
        //
        // Done on `record` because it has no anchor, so retiming it moves the
        // frame without rewriting any of the deck's moments -- and it is the act
        // that plays the month across the gaps in the first place.
        const blanks = [];
        for (let t = 0; t < obs.length; t++) if (obs[t] == null) blanks.push(t);
        if (!blanks.length) {
          skip('the bar says when there is no reading',
            `${obs.length} of ${obs.length} frames observed — the state cannot fire here`);
        } else {
          const note = nodes.get('meterNote');
          deck.retime(blanks[0]);
          check('a blank hour keeps the bar on screen rather than hiding it',
            meter.hidden === false);
          check('and marks it as an hour with no reading',
            meter.classList.contains('no-reading') === true, `frame ${blanks[0]}`);
          check('with no level left standing under the hatch',
            bar.style.height === '0%', String(bar.style.height));
          check('and says so in words, not only in the drawing',
            note.textContent === 'no reading', `"${note.textContent}"`);

          // ⚠ **The pair the state exists to keep apart**, and the reason an
          // empty bar was never enough on its own: Gosan's quiet day draws a flat
          // 0% because the air genuinely reads below the background, and a blank
          // hour draws a flat 0% because there is nothing to draw. Identical
          // height, opposite meanings -- so the hatch and the words are the only
          // things telling them apart, and the clean day must not carry either.
          deck.retime(FRAMES.clean);
          check('an hour that truly reads background is not marked as missing',
            meter.classList.contains('no-reading') === false,
            `clean day at ${bar.style.height}`);

          deck.retime(FRAMES.dirty);
          check('the mark clears on an hour that has a reading',
            meter.classList.contains('no-reading') === false);
          check('and the level comes back with it',
            Number.parseFloat(bar.style.height) > 0, String(bar.style.height));
        }
      }

      // ---- the beacons, as the map actually paints them --------------------
      //
      // The five named regions the CFC-11 deck asks its audience to choose
      // between. Everything here is gated on `meta.beacons`, so the other two
      // decks skip it by arithmetic rather than by being told to -- which is
      // also what holds Ridge Hill at 464.
      //
      // ⚠ **The mounted context swallows every call**, which is fine for
      // checking that a slide can be entered and useless for checking what got
      // drawn. So the map's context is swapped for a recorder that keeps the
      // ordered call log with the graphics state at each call, and
      // `_drawBeacons` is invoked directly against it. What is asserted is the
      // arcs, widths, opacities and letters a projector would receive.
      //
      // The claim being defended is narrow and load-bearing: **the three states
      // differ by more than their colour.** Three shades of one hue would read
      // as one blob from the back of a room and as nothing at all to a reader
      // with a colour-vision deficiency, and it is the easiest thing in this
      // file to regress into, because it would still look fine on the machine
      // it was written on.
      if (!meta.beacons) {
        skip('the beacons', 'no beacons in this export');
      } else {
        const map = deck.map;
        const boxes = meta.beacons.boxes;

        /**
         * A canvas context that remembers. Tracks the state a real context
         * carries -- fill, stroke, width, alpha, font, and the save/restore
         * stack -- and stamps it onto every drawing call, since the state at the
         * moment of the call is the whole question here.
         */
        const recorder = () => {
          const log = [];
          let st = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '' };
          const stack = [];
          const push = (op, extra) => log.push({ op, ...st, ...extra });
          const target = {
            save: () => { stack.push({ ...st }); },
            restore: () => { st = stack.pop() || st; },
            beginPath: () => {},
            arc: (x, y, r) => push('arc', { x, y, r }),
            stroke: () => push('stroke', {}),
            fill: () => push('fill', {}),
            strokeRect: (x, y, w, h) => push('strokeRect', { x, y, w, h }),
            fillText: (text, x, y) => push('fillText', { text, x, y }),
            measureText: () => ({ width: 10 }),
            setLineDash: (d) => push('dash', { dash: [...d] }),
            // Enough of the rest of the 2D context for a whole `draw()` to run
            // through this recorder rather than only `_drawBeacons` -- the ocean
            // gradient and the raster blits are on that path, and a stub that
            // returns undefined where a gradient belongs throws two lines in.
            createLinearGradient: () => ({ addColorStop() {} }),
            createRadialGradient: () => ({ addColorStop() {} }),
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            log,
          };
          return new Proxy(target, {
            get(t, k) {
              if (k in t) return t[k];
              if (k in st) return st[k];
              return () => {};
            },
            set(t, k, v) {
              if (k in st) st[k] = v; else t[k] = v;
              return true;
            },
          });
        };

        // ⚠ **Nothing below may name a frame.** `cutPercentiles` on the site
        // config is a tuning knob meant to be turned with the deck on screen,
        // and turning it moves which beacon is in which state on which hour. A
        // suite that hardcoded "C is high at 301" would fail on the next honest
        // retune and teach whoever hit it that the checks are noise.
        //
        // So the frames are *found*: for each state, an hour where some beacon
        // actually reads it. That is threshold-independent -- it asks only that
        // the three states exist somewhere, which `verify_export.py` already
        // requires -- and a state the cuts have tuned out of existence skips out
        // loud rather than failing.
        const rows = JSON.parse(readFileSync(`${site.dir}/series.json`, 'utf8')).beacons;
        // A beacon that reaches all three states, and one frame of each.
        let subject = -1;
        let atState = [];
        for (let k = 0; k < rows.length; k++) {
          const found = [0, 1, 2].map((s) => rows[k].indexOf(s));
          if (found.every((t) => t >= 0)) { subject = k; atState = found; break; }
        }

        // Draw one frame's beacons and hand back the log.
        const paintAt = (t) => {
          const rec = recorder();
          const was = map.ctx;
          map.ctx = rec;
          map.t = t;
          try { map._drawBeacons(1); } finally { map.ctx = was; }
          return rec.log;
        };

        check('the map picked the beacons up', map.beacons.length === boxes.length,
          `${map.beacons.length} of ${boxes.length}`);

        // The levels the map reads must be the levels the export shipped. This
        // is the join between `series.beacons` and what is on screen, and it is
        // an off-by-one away from lighting the right letter on the wrong hour.
        {
          const t = Math.min(meta.beacons.nTime - 1, 287);
          const got = map.beaconLevel(t);
          const want = boxes.map((_, k) => rows[k][t]);
          check('the levels it reads are the levels the export wrote',
            got.join('') === want.join(''), `${got.join('')} vs ${want.join('')}`);
        }

        const letters = (log) => log.filter((e) => e.op === 'fillText').map((e) => e.text);
        const markOf = (log, k) => {
          const arcs = log.filter((e) => e.op === 'arc');
          const at = arcs[k];
          const i = log.indexOf(at);
          const after = log.slice(i + 1, i + 5);
          return {
            r: at.r,
            ring: Math.min(...after.filter((e) => e.op === 'stroke').map((e) => e.lineWidth)),
            fill: (after.find((e) => e.op === 'fill') || {}).globalAlpha,
          };
        };
        if (subject < 0) {
          skip('the three states differ by more than colour',
            'no beacon reaches all three states at the current cuts');
        } else {
          const id = boxes[subject].id;
          const [tDark, tLit, tHigh] = atState;
          const at = atState.map((t) => markOf(paintAt(t), subject));
          const [mDark, mLit, mHigh] = at;

          // The three channels the states ride on, walked one beacon at a time
          // so nothing but its own state changes between the readings.
          check(`${id} grows as it lights`, mHigh.r > mDark.r,
            `r ${mDark.r} -> ${mLit.r} -> ${mHigh.r} at frames ${tDark}/${tLit}/${tHigh}`);
          check('and is ringed more heavily', mHigh.ring > mLit.ring && mLit.ring > mDark.ring,
            `${mDark.ring} -> ${mLit.ring} -> ${mHigh.ring}`);
          check('and filled more solidly', mHigh.fill > mLit.fill && mLit.fill > mDark.fill,
            `${mDark.fill} -> ${mLit.fill} -> ${mHigh.fill}`);
          // The one that matters most, stated as the deck's own rule: take the
          // colour away entirely and the three states still read as three.
          check('so all three states survive with the colour taken away',
            new Set(at.map((m) => `${m.r}/${m.ring}`)).size === 3,
            at.map((m) => `${m.r}/${m.ring}`).join(' '));
        }

        // A handful of frames spread across the record, so the checks below see
        // whatever mix of states the cuts happen to produce.
        const spread = [0, 1, 2, 3].map((i) => Math.floor((i * (rows[0].length - 1)) / 3));
        const logs = spread.map(paintAt);

        for (const [i, log] of logs.entries()) {
          check(`every beacon is named on screen at frame ${spread[i]}`,
            letters(log).join('') === boxes.map((b) => b.id).join(''),
            letters(log).join(''));
        }

        // ⚠ **Identity is not the state channel.** The letters are drawn at full
        // strength whatever a beacon is doing, so a reader who separates none of
        // the five hues still reads which letters are lit.
        check('the letters never fade with the state',
          logs.flat().filter((e) => e.op === 'fillText').every((e) => e.globalAlpha === 1));

        // Each beacon draws its region, not only its city. A dot alone would
        // claim a point source on the one deck that has none.
        check('each beacon draws the region it stands for',
          logs.every((log) => log.filter((e) => e.op === 'strokeRect').length === boxes.length));

        // ⚠ **`meta.beacons` carries `r` and `sepPpx` -- the answer to the
        // question act 5 asks the audience.** Nothing drawn may leak them, and
        // nothing drawn may name the regions either: "Shandong" on screen during
        // the game is the reveal, three acts early.
        const drawn = logs.flat().filter((e) => e.op === 'fillText').map((e) => String(e.text));
        check('nothing on the map gives the answer away',
          drawn.every((s) => /^[A-E]$/.test(s)), [...new Set(drawn)].join(''));

        // The letter has to stay readable on all fifteen hue-and-state pairs.
        // One colour for every fill is wrong for at least one of them, and which
        // one is not predictable from the hex -- hence `_beaconInk`.
        //
        // ⚠ **The floor is 4:1, deliberately below the 4.5:1 these actually
        // reach.** The beacon hues are meant to be swapped by eye, and a check
        // pinned to what today's five happen to measure would turn every colour
        // change into a test failure. What it is here to catch is a hue landing
        // in the mid-luminance band where *neither* ink works -- a letter nobody
        // can read -- and not a hue that is merely a little worse than the last
        // one. The measured worst is printed so the drift is visible either way.
        {
          const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
          const relL = (hex) => {
            const n = parseInt(hex.slice(1), 16);
            return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
          };
          const blend = (hex, a) => {
            const n = parseInt(hex.slice(1), 16);
            const s = [252, 252, 251];
            const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v, i) => Math.round(v * a + s[i] * (1 - a)));
            return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          };
          const ratio = (x, y) => {
            const [hi, lo] = relL(x) > relL(y) ? [relL(x), relL(y)] : [relL(y), relL(x)];
            return (hi + 0.05) / (lo + 0.05);
          };
          const { BEACON_COLOURS } = await import('../palette.js');
          const worst = [];
          for (const hue of BEACON_COLOURS) {
            for (const a of [0.10, 0.55, 0.92]) {
              const bg = blend(hue, a);
              worst.push(ratio(map._beaconInk(hue, a), bg));
            }
          }
          check('the letter stays legible on every hue in every state',
            Math.min(...worst) >= 4.0, `worst ${Math.min(...worst).toFixed(1)}:1`);
        }

        // Wiring: the layer switch is what the beats file actually sets, so a
        // `_drawBeacons` nothing calls would pass every check above.
        {
          const rec = recorder();
          const was = map.ctx;
          const had = map.layers.beacons;
          map.ctx = rec;
          map.layers.beacons = 0;
          try { map.draw(); } finally { map.layers.beacons = had; map.ctx = was; }
          check('the layer switch turns them off',
            !rec.log.some((e) => e.op === 'fillText' && /^[A-E]$/.test(String(e.text))));
        }

        // ⚠ **A layer no stop draws ships dead**, and nothing else on screen
        // would look wrong. This is the check that stops that happening.
        const beaconStops = slides.filter((s) => s.layers.beacons > 0);
        check('some stop actually draws them', beaconStops.length > 0,
          `${beaconStops.length} stops`);
        // ⚠ B's box reaches lon 136.0, outside both wind framings. A stop that
        // asks "which of these five" while one of them is off the edge of the
        // screen is asking about four.
        for (const s of beaconStops) {
          const west = s.camera.lon - s.camera.span / 2;
          const east = s.camera.lon + s.camera.span / 2;
          const out = boxes.filter((b) => b.lon[0] < west || b.lon[1] > east);
          check(`${s.actId}/${s.stopIndex}: all five regions are on screen`,
            out.length === 0, out.map((b) => b.id).join(','));
        }

        // ---- the picks -----------------------------------------------------
        //
        // Five buttons that jump straight to a region's hour, so the presenter
        // can ask the room which one to look at first and click it. The camera
        // does not move across them -- only the frame -- so the beacons relight
        // and the bar answers, and the difference between the letters is the
        // whole argument of the act.
        //
        // ⚠ **Everything below is inside the `meta.beacons` gate**, including
        // the two checks that are really about the stylesheet and the page. They
        // belong in the site-agnostic sections further up this file, and they
        // are here anyway: those run for Ridge Hill, whose count is the tripwire
        // that says the engine split and the beacon work left it untouched. A
        // check about a row of buttons that exist on one page of one deck is not
        // worth moving that number for.
        const pickAct = acts.find((a) => a.picks);
        if (!site.expectPicks) {
          skip('the picks', 'this deck has no act that can be run out of order');
        } else if (!pickAct) {
          check('the deck still declares its picks', false,
            'expectPicks is set and no act has a `picks` list');
        } else {
          const targets = pickTargets(slides, pickAct.picks);
          const labels = targets.map((k) => String(slides[k].id).replace(/^pick-/, ''));

          // The pure half, and the reason `pickTargets` is in engine.js: a
          // button that lands nowhere looks perfectly fine until it is pressed,
          // which on this deck means in front of an audience.
          check('every pick resolves to a slide that exists',
            targets.length === pickAct.picks.length && targets.every((k) => slides[k]),
            `${targets.length} of ${pickAct.picks.length}`);
          check('a pick that names no stop fails loudly rather than dropping out',
            (() => {
              try { pickTargets(slides, ['pick-nowhere']); return false; } catch { return true; }
            })(),
            'a silently dropped pick would shift every letter after it along the row');

          // ⚠ **A button that lands on a blank hour wastes the pick.** 46% of
          // this record has no reading, so an hour chosen for its beacons alone
          // is a coin flip on whether the bar can answer at all -- and the bar
          // answering is the entire point of pressing the button.
          //
          // `DECK`, not `deck`: three lines above the mount, the spec is
          // shadowed by the mounted deck.
          const pickObs = series.species[DECK.species].obs;
          for (const [j, k] of targets.entries()) {
            check(`pick ${labels[j]} lands on an hour with a reading`,
              pickObs[slides[k].t] != null,
              `frame ${slides[k].t}${pickObs[slides[k].t] == null ? '' : ` reads ${pickObs[slides[k].t].toFixed(1)}`}`);
          }

          // ⚠ **Fixed letter order, and never sorted by anything measured.**
          // `meta.beacons.boxes` carries each region's `r` and `sepPpx` -- the
          // answer to the question this act asks the audience -- and a row put
          // in strength order would be that answer, printed in the one place
          // nobody would think to check. The letters on the boxes are the order.
          check('the row reads in letter order, not in strength order',
            labels.join('') === boxes.map((b) => b.id).join(''),
            `${labels.join('')} vs ${boxes.map((b) => b.id).join('')}`);

          // ⚠ **The same rule as `nothing on the map gives the answer away`**,
          // extended off the canvas. A place name is text on screen whether it
          // was drawn with `fillText` or set as a button's label, and
          // "Shandong" on a button during the game is the reveal.
          const names = boxes.map((b) => String(b.name).toLowerCase());
          check('no button is labelled anything but its letter',
            labels.every((s) => /^[A-E]$/.test(s)), labels.join(' '));
          check('and no button names a region',
            !labels.some((s) => names.includes(s.toLowerCase())), names.join(', '));

          // ---- and as the deck actually paints it ---------------------------
          //
          // ⚠ **Order matters below.** Entering a pick marks it, so the two
          // `done` checks have to happen while exactly one region has been
          // shown. Walking the whole act comes after them.
          const actSlides = slides
            .map((s, k) => ({ s, k }))
            .filter(({ s }) => s.actId === pickAct.id);
          const chooser = actSlides[0].k;

          deck.go(chooser);
          check('the chooser carries the whole row',
            deck.picks.length === pickAct.picks.length, `${deck.picks.length} buttons`);
          // ⚠ **The chooser is not one of the five.** It declares the row
          // without being on it, so nothing is current while the question is
          // still open -- and `visited` must not have picked it up either.
          check('and marks none of them current, since it is not one of them',
            deck.picks.every((p) => !p.on),
            deck.picks.filter((p) => p.on).map((p) => p.label).join('') || 'none current');

          // The out-of-order jump itself, by key. Clicking is the primary path
          // and its handler is the same `go(target)`; a presentation clicker
          // sends arrows only, so the keys are for whoever is at the keyboard.
          press('3');
          check('a number key on the chooser jumps straight to that region',
            slides[deck.index].id === 'pick-C', slides[deck.index].id || '(no id)');
          check('and it lands on an hour that region is being smelled on',
            map.beaconLevel(deck.slides[deck.index].t)[2] === 2,
            map.beaconLevel(deck.slides[deck.index].t).join(''));

          // ⚠ **Marked, and not by colour alone** -- the deck's own rule. This
          // is the flag; the stylesheet's half is checked at the end.
          //
          // Only the positive direction, and deliberately: `visited` is a record
          // of the whole session, and by the time this section runs the walk
          // through every slide near the top of this file has been past all five.
          // A check that asserted "E is not marked" would be asserting that the
          // deck forgets, which is the opposite of what the row is for.
          check('the region just shown is marked as done',
            deck.picks.find((p) => p.label === 'C').done === true);
          check('and it is the one marked current', deck.picks.filter((p) => p.on)
            .map((p) => p.label).join('') === 'C',
            deck.picks.filter((p) => p.on).map((p) => p.label).join('') || 'none current');

          // ⚠ **The date is off on the picks.** They are five different days --
          // 4 June to 17 July, one per region, which is the act working as
          // designed -- and a stamp jumping between them reads as the deck
          // losing its place rather than as the point.
          check('the date stamp is off while a pick is showing', byId('stamp').hidden === true);

          // The row shows on **every stop of the act**, not only the chooser:
          // after region A you click B directly rather than walking back to a
          // menu, and the row doubles as the record of which have been done.
          for (const { k } of actSlides) {
            deck.go(k);
            check(`${slides[k].id || 'the chooser'} carries the whole row`,
              deck.picks.length === pickAct.picks.length, `${deck.picks.length} buttons`);
          }

          // And nowhere else in the deck -- 1 to 5 shadow the act jumps on these
          // six slides and must go back to being act jumps on every other one.
          const elsewhere = slides.findIndex((s) => s.actId !== pickAct.id);
          deck.go(elsewhere);
          check('no other slide in the deck shows a row', deck.picks.length === 0,
            `${deck.picks.length} on ${slides[elsewhere].actId}`);
          check('and the date is back on', byId('stamp').hidden === false);
          press('3');
          check('and 1-9 are still the act jumps there',
            slides[deck.index].actIndex === 2, `landed on ${slides[deck.index].actId}`);

          // Trap 1, and the only check in this file that can catch it: the DOM
          // stub above conjures an element for any id it is asked for, so
          // `paintPicks` runs happily against a page with no `#picks` in it.
          {
            const html = readFileSync(new URL(`../../${site.page}`, import.meta.url), 'utf8');
            check(`${site.page} actually has the element the row is built into`,
              /id="picks"/.test(html), site.page);
          }

          // The `[hidden]` trap, for a fourth element. `.picks` declares
          // `display: flex`, which is an author rule and beats the browser's
          // `[hidden] { display: none }` outright -- so without its own guard
          // the row would show on every slide of every deck, and the symptom
          // would be five buttons over the Ridge Hill map rather than an error.
          {
            const css = readFileSync(new URL('../../css/story.css', import.meta.url), 'utf8')
              .replace(/\/\*[\s\S]*?\*\//g, '');
            const subjects = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
              subjects: sel.split(',').map((s) => s.trim().split(/\s+/).pop()),
              body,
            }));
            const declares = subjects.some((b) => b.subjects.includes('.picks') && /display\s*:/.test(b.body));
            const guarded = subjects.some((b) => b.subjects.includes('.picks[hidden]')
              && /display\s*:\s*none/.test(b.body));
            check('#picks: hiding the row actually hides it', !declares || guarded,
              declares ? (guarded ? 'declares display, and guards it' : 'declares display with NO [hidden] rule')
                : 'no author display, the browser rule applies');
            // The other half of the deck's colour rule, in the stylesheet where
            // it lives: `done` may tint, but it may not *only* tint.
            const done = subjects.filter((b) => b.subjects.includes('.pick.done'));
            check('a visited region is marked by more than a tint',
              done.some((b) => /box-shadow|border-bottom|text-decoration|content\s*:/.test(b.body)),
              done.map((b) => b.body.trim().split('\n')[0]).join(' / ') || 'no .pick.done rule');
          }
        }
      }
    }
  }
}

for (const site of SITES) {
  const before = count;
  const failedBefore = failures;
  // eslint-disable-next-line no-await-in-loop -- the passes install globals, so
  // they have to be serial: two mounts sharing one fake `document` would race.
  await runSite(site);
  const ran = count - before;
  const failed = failures - failedBefore;
  console.log(`\n${site.deck.id}: ${ran} checks, ${failed ? `${failed} FAILED` : 'all green'}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall story self-tests passed');
process.exit(failures ? 1 : 0);
