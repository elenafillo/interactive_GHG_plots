/**
 * Gosan again, and CFC-11 over June and July 2016. **Scaffolding, not the
 * story.**
 *
 * This file exists so `web/data-gsn-cfc11/` is on screen and the wind can be
 * looked at. Its shape is `beats-gsn.js`'s, act for act, because Brief 4 asked
 * for the HFC-23 beats reused for now. The deck the status doc plans -- five
 * beacons, the audience running the inversion by hand, Shandong as the answer --
 * is not here and is not attempted. `story-cfc11-deck-status.md` is authoritative
 * for all of it.
 *
 * What *is* real:
 *
 *   - **The wind is live.** `meta.wind` is populated (level 2, true height
 *     76.7 m, 224 steps on a 3-frame stride) and `deck.js` builds the layer from
 *     it with nothing to wire up. Six stops below ask for it.
 *   - The two anchors, and their readings, were checked against the shipped
 *     `series.json` rather than copied.
 *
 * ---
 *
 * ## ⚠ Three things a reader of this file has to know
 *
 * **1. The axis is 672 frames, not 1044.** `data-gsn` is June–August;
 * this export stops at 31 July. The first 672 frames are the same UTC hours in
 * both, so an index below 672 copied from `beats-gsn.js` means the same moment
 * -- and an index at or above it is August and does not exist here. Every index
 * in this file was checked against 672.
 *
 * **2. The time axis is not contiguous.** The footprint record is missing
 * **28–30 June, 16 July and 24 July**, so `frame = hour / 2` breaks across a
 * gap and a play window can jump days mid-animation. The three joins sit at
 * frames **324** (27 Jun 22:00 → 1 Jul 00:00, a 74-hour step), **504** and
 * **588**. `record` below crosses the first of them, knowingly -- see its note.
 *
 * **3. The clean day is *after* the dirty one.** This is the big break with
 * `beats-gsn.js`, where the quiet day falls six days before the episode and the
 * deck says so out loud. Here dirty is 16 June and clean is 5 July, nineteen
 * days later, so **no caption in this file may claim a chronology** -- and the
 * acts still run clean-first, which means the date stamp on screen goes
 * *backwards* between `clean-smell` and `dirty`. It is survivable in a scaffold
 * and it is not shippable. Whoever writes the real deck either reorders the acts
 * or picks a clean day before 16 June.
 *
 * There are **no factories**. `meta.factories` is `null` for this site on
 * purpose: `factory_locations_EASTASIA.csv` is an HFC-23 plant list, and drawing
 * it on a CFC-11 map would caption the wrong gas. Do not add it back.
 */

/**
 * The two moments, as frame indices into this export's 672.
 *
 * **Chosen by the user to get something on screen**, not by Brief 1's analysis.
 * Both were re-derived and then read off the shipped data:
 *
 *   dirty  180 -- 2016-06-16 00:00 UTC, 16 Jun 09:00 KST. Reads 276.4, which is
 *                 **+45.3 above the background** -- two thirds of the bar, and
 *                 well inside a run of observed frames (178..182).
 *   clean  379 -- 2016-07-05 14:00 UTC, 5 Jul 23:00 KST. Reads 234.5, **+3.4**:
 *                 a sliver rather than empty, so the bar is visibly alive and
 *                 visibly near the floor. **Observed at 379 and nowhere either
 *                 side of it** -- 378 and 380 are both blank, which is why no
 *                 play window here is anchored on the clean day.
 *
 * Both carry a reading, which was worth checking: only 365 of the 672 frames
 * do, so a 46% chance of anchoring a caption on an empty bar.
 *
 * ⚠ **Neither is the record.** The smelliest frame is 2016-06-24 22:00 at
 * +65.5, the cleanest 2016-07-06 08:00 at −1.5. Brief 1 owns the real choice,
 * including whether the smelliest frame is an episode or a two-hour spike --
 * the HFC-23 deck was bitten by exactly that.
 *
 * There is deliberately **no `peak`**. `beats-gsn.js` has one because its
 * episode plateaus over 22 hours and the playback wants somewhere to pause;
 * nothing here has been measured well enough to name a peak, and inventing one
 * would put a pause on a frame no one has looked at.
 */
const FRAMES = { clean: 379, dirty: 180 };

/**
 * The smell bar's scale, above a fixed floor.
 *
 * `base` is the export's own background (231.106) rounded down to 231.1, the
 * same rule Ridge Hill's 1930 and Gosan's 29.6 follow. Rounded *down* rather
 * than to nearest: the background is a 10th percentile, so a tenth of the
 * readings sit at or below it by construction, and rounding up would push more
 * of them onto a floor that reads as "nothing here".
 *
 * ⚠ **It was 232.3, and the emissions map is what moved it.** With no map the
 * export had nothing to model with, so the background was the 10th percentile
 * of the readings themselves; with one it is the 10th percentile of *reading
 * minus modelled*, which is the same convention Ridge Hill has always used. The
 * prior explains about 1.3 of the reading, so the floor drops by that much and
 * every frame reads correspondingly fuller. The bar itself is unchanged -- it
 * still draws the raw reading above this floor, and does not subtract the
 * model.
 *
 * `span` 69 comes from the record rather than from the story -- it puts the
 * strongest frame (296.64, or +65.5 over the new floor) at **exactly 95%** of
 * the bar with **nothing clipping**, which is how both other decks settled
 * theirs.
 *
 * What that leaves the two anchors: the dirty day reads about **66%** and the
 * clean day about **5%** -- a sliver, not the flat empty the HFC-23 deck's quiet
 * day gives. That is the honest picture of a day that is nearly, but not quite,
 * background.
 */
const SMELL = { base: 231.1, span: 69 };

/**
 * Where the two back-trajectory fans start from.
 *
 * ⚠ **`hours: 12` is a measured ceiling, not Ridge Hill's number.** Ridge Hill's
 * dirty day needs 36 h because its flow stalls; 36 h here would run the fan off
 * the **eastern edge of the wind**, which stops at lon 134.95 -- 8.6° and about
 * 800 km from Gosan. At the chosen level the mean wind is 5.33 m/s, so 12 h
 * covers roughly 230 km and stays comfortably inside the field. Anything longer
 * has to be measured before it is written.
 *
 * The rest of each entry is still Ridge Hill's shape, unmeasured, and wants
 * `measure_seeding.mjs` run against this wind field before the real deck.
 *
 * ⚠ There is also **no lead-in before 1 June** -- the wind record starts exactly
 * at the window start -- and frames 670–671 run past its end and clamp. Both
 * anchors are far from both ends, so neither bites here.
 */
const RELEASES = {
  ocean: { seed: 'backTrack', hours: 12, arrivals: 4, jitterKm: 3, count: 24, parcels: 12 },
  sources: { seed: 'backTrack', hours: 12, arrivals: 4, jitterKm: 3, count: 24, parcels: 12 },
};

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

/**
 * The five framings, inherited from `beats-gsn.js` -- same island, same
 * footprint grid, so they hold the same things and are as untuned here as they
 * are there. Expect to move all of them.
 *
 * ⚠ **One new constraint, and it is the data's:** the wind stops at lon
 * **134.95**, 29 of the view's 114 columns short of the eastern edge. So a
 * camera carrying `wind` is bounded by the *wind* grid, not the footprint's --
 * which `DOMAIN` fails, reaching lon 140.09. The suite checks this per stop.
 *
 *   DOMAIN  the whole grid. **Footprint only, never wind.**
 *   JEJU    the island.
 *   CLIFF   the station, close enough that it is a place and not a dot.
 *   OCEAN   the clean day. 113.5..131.5 -- inside the wind.
 *   CHINA   the dirty day. 111.0..131.0 -- inside the wind.
 *   DELTA   the Yangtze mouth, for the 1 km map. See below.
 *
 * ⚠ **`DELTA` exists because the hi-res emissions layer is invisible at any of
 * the others.** Its cells are 0.00833 deg, so on a ~1400 px canvas `DOMAIN`
 * (span 30) draws them at 0.4 px and `CHINA` (span 20) at 0.6 px -- under a
 * pixel each, which is a 4.5 MB download rendering as exactly the same picture
 * `flux.png` gives for 5 KB. At span 6 a cell is about 2 px and the map starts
 * to read as cells, which is the whole reason for shipping it.
 *
 * ⚠ It is **Shanghai and the Yangtze delta, deliberately not Shandong.** The
 * answer to act 5 is Shandong, and pushing in on it during the `people` act
 * would hand the audience the reveal two acts early. The delta is the largest
 * population mass in the view and gives away nothing.
 */
const DOMAIN = { lon: 125.09, lat: 34.01, span: 30 };
const JEJU = { lon: 126.16, lat: 33.29, span: 3 };
const CLIFF = { lon: 126.16, lat: 33.29, span: 1.2 };
const OCEAN = { lon: 122.5, lat: 29.5, span: 18 };
const CHINA = { lon: 121.0, lat: 34.25, span: 20 };
const DELTA = { lon: 121.0, lat: 31.4, span: 6 };

/** Everything `deck.js` needs to mount the CFC-11 deck. */
export const DECK = {
  id: 'cfc11',
  data: 'data-gsn-cfc11/',
  species: 'cfc-11',
  /** The status doc's working title. §4 owns the final one. */
  title: 'Which one can we smell?',
  /**
   * "CFC-11" is jargon by the deck's own rule, the same way "HFC-23" is. Unlike
   * that gas this one has a plain name the public already knows -- it is the
   * fridge and aerosol gas that was banned to save the ozone layer -- but that
   * is a sentence, not a word, and it belongs in a caption rather than in every
   * caption. "This gas" throughout, introduced once.
   */
  gasWord: 'this gas',
  /** Gosan is UTC+9. Every date the deck speaks aloud is KST. */
  tzOffsetH: 9,
  frames: FRAMES,
  smell: SMELL,
  releases: RELEASES,
  flags: {},
  /** The last deck in the talk, so `→` clamps on its final slide. */
  next: null,
  acts,
};

/**
 * The fifteen stops, in order.
 *
 * `beats-gsn.js`'s six acts minus its plant beats, which this gas has no list
 * for. ✏️ **Every caption is a placeholder** -- inside the ten-word cap and
 * clear of the banned list, which the suite checks, but that is a floor rather
 * than a standard. None of them makes the argument the status doc is for.
 */
function acts() {
  return [
    {
      id: 'where',
      title: 'Where are we?',
      anchor: 'clean',
      // Wide, in, in, wide -- the last stop returns to exactly the opening
      // frame, so "it can smell all of this" lands on a map already read once.
      stops: [
        {
          caption: 'We travel to a different part of the world.',
          camera: DOMAIN,
          layers: { station: 0, graticule: 1 },
        },
        {
          caption: 'An island south of Korea, in the sea.',
          camera: JEJU,
          layers: { station: 0, graticule: 1 },
        },
        {
          caption: 'Same idea. One sniffer on a clifftop.',
          camera: CLIFF,
          layers: { station: 1, graticule: 1 },
        },
        {
          caption: 'It can smell eastern China, Japan and Korea.',
          camera: DOMAIN,
          layers: { graticule: 1 },
        },
      ],
    },

    {
      id: 'clean-wind',
      title: 'A quiet day',
      anchor: 'clean',
      needs: ['wind'],
      // **The first wind this site has ever drawn.** `needs` gates whether the
      // act is skipped when the field is absent; `layers.wind` is what actually
      // paints. Both are set, and the export carries the atlases, so unlike
      // `beats-gsn.js` these stops are live rather than showing the placeholder.
      //
      // Framed identically to `clean-smell`, which is Ridge Hill's rule and
      // worth keeping: the red then fades in over a camera that is not moving.
      stops: [
        {
          caption: 'Today the wind comes off the Pacific.',
          camera: OCEAN,
          layers: { wind: 1 },
        },
        {
          caption: 'Follow the air backwards. Where has it just been?',
          camera: OCEAN,
          layers: { wind: 1 },
          release: { from: 'ocean' },
          mode: 'back',
          ambient: 0.25,
        },
      ],
    },

    {
      id: 'clean-smell',
      title: 'Nothing to smell',
      anchor: 'clean',
      stops: [
        {
          caption: 'Red is everything the station can smell.',
          camera: OCEAN,
          layers: { footprint: 1 },
        },
        {
          caption: 'Mostly open sea. Almost nothing arrives.',
          camera: OCEAN,
          layers: { footprint: 1 },
        },
      ],
    },

    {
      id: 'sources',
      title: 'Where it comes from',
      anchor: 'clean',
      // The status doc's `people` beat, in embryo: *we don't know where it comes
      // from · here is where people live, as a stand-in.* The act keeps its old
      // id because §4 owns the run of play and renaming it here would move a
      // decision that is not this change's to take.
      //
      // ⚠ **The map is a prior, not an inventory, and no caption may imply it
      // is one.** `beats-gsn.js` opens its equivalent on the purple EDGAR field,
      // which is a measured account of where HFC-23 is made. There is no such
      // thing for CFC-11 and that absence *is* the deck's argument. What draws
      // here is 40 Gg/yr spread by where people live -- the assumption an
      // inversion starts from when it knows nothing -- so the honest shape is
      // two stops: the question first, on an empty map, and the guess second.
      //
      // ⚠ The empty stop is empty because `layers.flux` is **0**, not because
      // the raster is blank. It used to be the other way round: the slot held an
      // all-zero PNG from `scripts/make_blank_flux.py`, which is gone now that
      // the real field ships. A stop that wants nothing on the map says so.
      stops: [
        {
          caption: 'So where does it come from? Nobody knows.',
          camera: DOMAIN,
        },
        {
          // ✏️ Placeholder like every other caption here, and load-bearing in
          // one respect: it must read as a *guess*. "Where people live" is the
          // whole of what this map knows.
          caption: 'So we guess. It comes from where people live.',
          camera: DOMAIN,
          layers: { fluxHi: 1 },
        },
        
          // ✏️ Placeholder. The one job: say that the guess has *detail*
          // without implying the detail makes it right. A 1 km map of a
          // hypothesis is still a hypothesis.
          //
          // The same field as the stop above at 30x the resolution -- WorldPop's
          // own 30 arc-second cells, never resampled. `fluxHi` and `flux` share
          // the site's -18..-10 window, so a colour means the same emission on
          // both and pushing in genuinely adds detail rather than rescaling.
          //
          // ⚠ Drawn as **cells, not a smooth field** -- `crispSources` is true
          // by default and `G` toggles it. That is not a stylistic choice here:
          // bilinear upscaling would invent gradients between census cells and
          // make a guess look like a measurement, which is the one thing this
          // act must not do.
        // {
        //   caption: 'Closer in, that guess has streets in it.',
        //   camera: DELTA,
        //   layers: { fluxHi: 1 },
        // },
      ],
    },

    {
      id: 'dirty',
      title: 'A dirty day',
      anchor: 'dirty',
      // The payoff, such as it is in a scaffold. ⚠ Its caption cannot say "six
      // days later" -- this day is nineteen days *before* the quiet one. See the
      // header.
      stops: [
        {
          caption: 'Another day. The wind has turned.',
          camera: CHINA,
          layers: {fluxHi: 0.5, wind: 1 },
          needs: ['wind'],
        },
        {
          caption: 'Now it blows straight off China.',
          camera: CHINA,
          layers: { wind: 1 },
          needs: ['wind'],
        },
        {
          caption: 'Wind the clock back. This air crossed eastern China.',
          camera: CHINA,
          layers: { wind: 1 },
          release: { from: 'sources' },
          mode: 'back',
          ambient: 0.25,
          needs: ['wind'],
        },
        {
          caption: 'The red patch reaches right across the sea.',
          camera: CHINA,
          layers: { footprint: 1 },
        },
        {
          // ⚠ **Four hours, where `beats-gsn.js` plays twelve.** Not a feel
          // decision: 180..182 is the whole run of consecutive *observed* frames
          // from the dirty hour -- 183 is blank, and a blank frame draws an
          // empty bar, which on this deck means clean air. Twelve hours would
          // play three lies at the end of a slide captioned about an episode.
          //
          // No `holdAt`: this deck names no peak, and a pause has to land on a
          // frame someone has looked at.
          caption: 'And the reading climbs. Something out there is leaking.',
          camera: CHINA,
          layers: { footprint: 1 },
          play: { from: 0, to: 4, stepsPerSec: 6 },
        },
      ],
    },

    {
      id: 'record',
      title: 'How much can we smell?',
      anchor: null,
      chart: false,
      stops: [
        {
          caption: 'Three weeks of air, hour by hour.',
          camera: DOMAIN,
          layers: { footprint: 1 },
          /**
           * Absolute frame indices -- an act with no anchor reads them as
           * frames, not hours. 180..379 runs from the dirty day to the clean
           * one, so the playback holds both of the deck's moments and comes to
           * rest on each, and both of those frames carry a reading.
           *
           * 200 frames at 9 a second is about twenty-two seconds, in the same
           * range as the other two decks' month acts.
           *
           * ⚠ **This window crosses the 27 Jun → 1 Jul discontinuity at frame
           * 324** -- a 74-hour step that plays as a single frame advance, so the
           * animation jumps three days mid-flight with nothing on screen saying
           * it did. It is knowingly shipped in a scaffold and it is the first
           * thing to fix in the real deck. There is no way to avoid it while
           * holding both of these anchors, because they sit on opposite sides of
           * the gap: fixing it means moving an anchor, not moving the window.
           * The shipped HFC-23 deck has the same bug at the same join, and Brief
           * 5 is where the suite learns to catch it for all three decks.
           *
           * ⚠ **About a third of these frames have no reading**, which the bar
           * draws as empty -- meaning, on this deck, clean air. Same hazard as
           * the HFC-23 deck's `record` act, same fix (§3's third meter state).
           * The stops it comes to rest on are all observed, which is what the
           * suite asserts and the most that can be promised today.
           */
          play: { from: 180, to: 379, stepsPerSec: 9, holdAt: ['dirty', 'clean'] },
        },
      ],
    },
  ];
}
