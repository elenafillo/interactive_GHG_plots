/**
 * Gosan, as data. **A first cut — the shape is right, the numbers are not tuned.**
 *
 * The six acts below mirror Ridge Hill's, so the two read as one talk. What is
 * settled is what has been *measured*: the three moments, the bar's scale, the
 * timezone, and the play window. What is not settled is everything you can only
 * judge by looking at it — the cameras, and the captions.
 *
 * ⚠ **The cameras are computed, not composed.** Each one was chosen to hold a
 * measured thing — the plants, the red patch on the dirty day, the ocean
 * approach on the quiet one — and checked to stay on data at both 16:9 and 4:3.
 * That is enough for the deck to walk end to end without running off the edge of
 * the map. It is not the same as framing, which Ridge Hill's cameras got by
 * being looked at on a screen and nudged. Expect to move all of them.
 *
 * **Two things are wired but dark**, and say so on screen via the placeholder
 * pill rather than being dropped from the running order:
 *
 *   - the two wind acts, `needs: ['wind']` — no East Asia met exists (Brief C)
 *   - "what we should smell" against "what we do" — the second bar is §3, and
 *     it is the deck's actual argument
 *
 * **The purple emissions map (Brief A) has landed** — EDGAR v8.0 HFC-23, 2016,
 * 0.1 deg, and it opens the `sources` act. One raster rather than Ridge Hill's
 * four: this gas has a single source. ⚠ Its contrast window is a measured
 * starting point and not a tuned look — `SOURCE_DISPLAY_BY_SPECIES['hfc-23']`
 * in `palette.js`, and `T` moves it.
 *
 * ---
 *
 * The story, in one paragraph, for whoever writes §4. A sensor on a clifftop on
 * Jeju Island, in the outflow from eastern China, measures the waste gas from
 * making cooling gas. Three quarters of the world's *reported* production of it
 * sits inside this map. On 20 June 2016 the wind came off the Pacific and there
 * was nothing in the air. Six days later it swung round, the smelling area
 * landed on the plants, and the reading went up nearly thirty times the noise.
 * The argument is not Ridge Hill's "here is our guess" but the sharper one: here
 * is what we should smell, and here is what we actually smell.
 */

/**
 * The three moments, as frame indices.
 *
 * ⚠ **These are indices into the export that is shipped today** — 1 Jun to
 * 31 Aug 2016, 1044 frames, 2-hourly. The plan quotes 120 / 193 / 197, which are
 * indices into the *re-export* Brief B has not done yet (10 Jun start). The two
 * differ by a constant 108 frames, which is the nine days between the starts,
 * and all three were re-verified against the shipped atlas at the indices below.
 * **If Brief B re-exports, subtract 108.**
 *
 *   clean  228 -- Mon 20 Jun 09:00 KST. -0.6 ppt, so genuinely *below* the
 *                 background. 0 of the 42 plants under the plume, landFrac
 *                 0.113 -- cleaner than Ridge Hill's quiet day at 0.142.
 *   dirty  301 -- Sun 26 Jun 11:00 KST. +27.7 ppt, 12 plants lit, landFrac
 *                 0.553. The start of a 22-hour plateau.
 *   peak   305 -- Sun 26 Jun 19:00 KST. +30.4 ppt, 11 plants lit. The strongest
 *                 frame of the episode.
 *
 * The clean day falls *before* the dirty one, six days earlier, so the deck can
 * keep Ridge Hill's "six days later, the wind turned" move intact.
 *
 * ⚠ **Not the record maximum**, which is +42.6 ppt at frame 292 (25 Jun 17:00
 * KST). Its neighbours are +1.6 and +6.8 — a two-hour spike rather than an
 * episode, and on the bar it reads as a glitch.
 */
const FRAMES = { clean: 228, dirty: 301, peak: 305 };

/**
 * The smell bar's scale, in ppt above a fixed floor.
 *
 * `base` is the export's own background (29.626) rounded, the same rule Ridge
 * Hill's 1930 follows. `span` 45 was chosen against the record rather than
 * against the story: it puts the record maximum (+42.6) at 95% of the bar with
 * **zero frames clipping**, which is how Ridge Hill's 200 was settled.
 *
 * What that leaves for the story's own frames is worth knowing before writing
 * captions against it: the clean day reads **empty** — it is below background,
 * so it clamps to zero, where Ridge Hill's quiet day is a visible sliver — the
 * dirty day 62%, and the peak 68%. The bar is deliberately not scaled to make
 * the episode fill it, because the one frame that would fill it is the spike
 * this deck does not show.
 */
const SMELL = { base: 29.6, span: 45 };

/**
 * Where the two back-trajectory fans start from.
 *
 * ⚠ **Every number here is a placeholder copied from Ridge Hill.** Nothing about
 * them is measured, and they cannot be: each of Ridge Hill's came out of
 * `measure_seeding.mjs` run against a real wind field, and no East Asia met
 * exists anywhere in the repo (Brief C). They are here so the two `mode: 'back'`
 * stops resolve to *something* rather than logging "no release box named ..."
 * every time the deck is walked.
 *
 * When the met lands, both entries are re-measured, not adjusted. In particular
 * `hours` will not be 12: Ridge Hill's dirty day needed 36 because its flow
 * stalls, and whether Gosan's does is an empirical question about a different
 * ocean.
 */
const RELEASES = {
  ocean: { seed: 'backTrack', hours: 12, arrivals: 4, jitterKm: 3, count: 24, parcels: 12 },
  sources: { seed: 'backTrack', hours: 12, arrivals: 4, jitterKm: 3, count: 24, parcels: 12 },
};

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

/**
 * The five framings the deck flies between.
 *
 * `span` is degrees of longitude across the canvas *width*, so the horizontal
 * extent is fixed and the vertical follows the window's aspect. Every one below
 * was checked to stay inside the footprint grid — lon 105.03..145.16, lat
 * 22.08..45.95 — at both 16:9 and 4:3, which is what the suite re-checks. A
 * camera tuned on a widescreen laptop can still run off the top of the map in a
 * 4:3 hall, and 4:3 is the binding constraint on all five.
 *
 * What each was chosen to hold:
 *
 *   DOMAIN  the whole grid, centred on it. 37 of the 42 plants and the whole of
 *           the dirty day's red patch. Max at this centre is 31.8, so 30 leaves
 *           a degree of margin. Used for the opening, the plants, and the month.
 *   JEJU    the island, no marker yet.
 *   CLIFF   the station, close enough that it is a place and not a dot.
 *   OCEAN   the quiet day. Its red runs *south* from the station, lat 22.2..33.4
 *           — so this frame is dropped and tightened to hold the approach rather
 *           than the continent. ⚠ It clips the last two degrees of that patch at
 *           16:9. Holding all of it needs the frame's bottom edge within 0.1 deg
 *           of the grid's, which reads as the map ending mid-screen; this is the
 *           compromise and it is the first thing to try moving.
 *   CHINA   the dirty day. Its red is north-west — lon 115.8..126.3, lat
 *           30.9..37.6 — all of which is in frame, with the station and 28 of
 *           the plants.
 */
const DOMAIN = { lon: 125.09, lat: 34.01, span: 30 };
const JEJU = { lon: 126.16, lat: 33.29, span: 3 };
const CLIFF = { lon: 126.16, lat: 33.29, span: 1.2 };
const OCEAN = { lon: 122.5, lat: 29.5, span: 18 };
const CHINA = { lon: 121.0, lat: 34.25, span: 20 };

/** Everything `deck.js` needs to mount Gosan. */
export const DECK = {
  id: 'gsn',
  data: 'data-gsn/',
  species: 'hfc-23',
  title: 'What should we smell?',
  /**
   * The plain word for the gas.
   *
   * "HFC-23" is jargon by the deck's own rule — Ridge Hill says "methane" and
   * never "CH₄" — and this gas has no plain name to fall back on. The plan's
   * recommendation is to never name it: call it "this gas" throughout and
   * introduce it once, in the sources act, as *"the waste gas from making
   * cooling gas"*. That is a §4 writing decision; this is the placeholder that
   * follows the recommendation.
   */
  gasWord: 'this gas',
  /** Gosan is UTC+9. Every date the deck speaks aloud is KST. */
  tzOffsetH: 9,
  frames: FRAMES,
  smell: SMELL,
  releases: RELEASES,
  flags: {},
  /** Gosan is the last deck in the talk, so `→` clamps on its final slide. */
  next: null,
  acts,
};

/**
 * The sixteen stops, in order.
 *
 * Ridge Hill's six acts, beat for beat, so that a talk running both decks makes
 * the same move twice in the same order: here we are, here is a quiet day, here
 * is what the air touched, here is where the gas comes from, here is a dirty
 * day, here is the whole record. What differs is the payoff. Ridge Hill ends on
 * *"the red patch lands on our guess"*; Gosan ends on *"and we smell far more
 * than the guess allows"*, which is a sharper claim and the reason for the
 * second deck.
 *
 * ✏️ **The captions are drafted, not finished.** All sixteen are inside the
 * ten-word cap and clear of the banned list — the suite checks both — but that
 * is a floor, not a standard. Read them out loud before the talk.
 */
function acts() {
  return [
    {
      id: 'where',
      title: 'Where are we?',
      anchor: 'clean',
      // Wide, in, in, wide. The last stop returns to exactly the opening frame,
      // so "it can smell all of this" lands on a map the audience has already
      // read once -- the reach is the only new claim, and it should not have to
      // compete with a new picture.
      stops: [
        {
          // The hinge between the two decks, if both are being shown. No marker
          // yet: this beat is the region, and a dot on it invites the question
          // one slide early.
          caption: 'Now the other side of the world.',
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
          caption: 'It can smell all of eastern China.',
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
      // Dark until Brief C. Both stops still fly their framing and show the
      // placeholder pill, which is the point of gating rather than deleting:
      // the act keeps its place in the running order and its dot on the strip,
      // so the shape of the talk does not change when the met arrives.
      //
      // Framed identically to `clean-smell`, which is Ridge Hill's rule and
      // worth keeping: the red then fades in over a camera that is not moving,
      // which is what "the smelling area appears over the air" looks like.
      stops: [
        {
          caption: 'Today the wind comes off the Pacific.',
          camera: OCEAN,
          layers: { wind: 1 },
        },
        {
          // The same air, leaving the station and running back out to where it
          // came from, so the next act's red patch arrives over a shape the
          // audience has just watched being traced.
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
      // ⚠ Two stops on one still picture, for now. When the met lands, the first
      // gains `wind: 1` with the `ocean` release and `ambient: 0` -- Ridge Hill's
      // reveal, where the plume comes up over air still running back out along
      // it. Until then the reveal is the caption alone.
      stops: [
        {
          caption: 'Red is everything the station can smell.',
          camera: OCEAN,
          layers: { footprint: 1 },
        },
        {
          caption: 'Nothing but open ocean. Nothing there.',
          camera: OCEAN,
          layers: { footprint: 1 },
        },
      ],
    },

    {
      id: 'sources',
      title: 'Where it comes from',
      anchor: 'clean',
      // The purple map now exists (EDGAR v8.0, 2016, the same year as the
      // footprints), so this act runs the right way round: the field first, then
      // the plants on top of it.
      //
      // **One purple beat, not Ridge Hill's three.** Ridge Hill breaks its violet
      // total into three source families because methane has them; EDGAR
      // publishes HFC-23 under a single code, and its sector grid is identical to
      // the total. There is no breakdown to step through, so stepping through one
      // would be theatre. One stop, one caption.
      //
      // ⚠ The 77% claim on the third stop is inherited and **not re-verified
      // against this export** -- it wants checking against `flux_hi.png`'s own
      // total (the exporter prints it) before anyone says it out loud.
      stops: [
        {
          // The field before the points on it. `fluxHi` rather than `flux`: the
          // raster ships at its native 0.1 deg on its own grid, where the coarse
          // `flux` layer would have had to be regridded onto the footprint's
          // 114x102 and thrown away most of what makes it worth showing.
          caption: 'Purple is where this gas is made.',
          camera: DOMAIN,
          layers: { fluxHi: 1 },
        },
        {
          caption: 'These are the plants that make it.',
          camera: DOMAIN,
          layers: { fluxHi: 1, factories: 1 },
        },
        // {
          // Measured, and worth keeping honest when it is said out loud: 77% of
          // the world's *reported* production is in this frame. What is actually
          // released is the very thing the deck goes on to question.
          // caption: 'Three quarters of the world\'s, right here.',
          // camera: DOMAIN,
          // layers: { factories: 1 },
        // },
      ],
    },

    {
      id: 'dirty',
      title: 'A dirty day',
      anchor: 'dirty',
      // The payoff. Its first three stops are dark until the met arrives; the
      // last two work today and are the deck's whole argument in two slides --
      // twelve of the plants light up under the plume, and the bar goes from
      // empty to two-thirds.
      stops: [
        {
          caption: 'Six days later, the wind has turned.',
          camera: CHINA,
          layers: { wind: 1 },
          needs: ['wind'],
        },
        {
          caption: 'Now it blows straight off China.',
          camera: CHINA,
          layers: { fluxHi: 1, wind: 1 },
          needs: ['wind'],
        },
        {
          // The deck's only claim about where this air has been. Ridge Hill's
          // equivalent names Belgium and London; this one names the coast the
          // plants are on, and the payoff two slides later is checking that
          // sentence against the map.
          caption: 'Wind the clock back. This air crossed eastern China.',
          camera: CHINA,
          layers: { wind: 1 },
          release: { from: 'sources' },
          mode: 'back',
          ambient: 0.25,
          needs: ['wind'],
        },
        {
          // Twelve of the thirty-eight on-grid plants turn yellow here. That is
          // measured against the shipped atlas, not asserted -- and the suite
          // re-measures it, along with the quiet day's zero.
          caption: 'The red patch lands right on top.',
          camera: CHINA,
          layers: { footprint: 1, factories: 1 },
        },
        {
          // ⚠ The caption is a promise the deck cannot yet keep. "Far more than
          // we should" is a comparison against the modelled reading, and there
          // is only one bar on screen -- §3 is what puts the expected level
          // beside the measured one. Until then the presenter is saying it and
          // the screen is not showing it.
          caption: 'We smell far more than we should.',
          camera: CHINA,
          layers: { footprint: 1, factories: 1 },
          /**
           * Twelve hours from the anchor, which at this export's 2-hourly step
           * is six frames: 301 to 307.
           *
           * Not a round number picked for feel. 301..307 is exactly the run of
           * consecutive *observed* frames starting at the dirty hour — 308 is a
           * gap. A window running to 14 h would play one frame with no reading
           * behind it, and on this deck an empty bar means clean air. The suite
           * asserts the whole window is observed, which is what makes this
           * number safe for anyone to change.
           */
          play: { from: 0, to: 12, stepsPerSec: 6, holdAt: ['peak'] },
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
          caption: 'Quiet all week. Then Sunday.',
          camera: DOMAIN,
          layers: { footprint: 1 },
          /**
           * ⚠ **A fortnight, not the whole run — a deliberate break with the
           * plan,** which says "the whole run".
           *
           * With no anchor these are absolute frame indices, and the record is
           * 1044 frames of 2 hours: at 9 steps a second that is a hundred and
           * sixteen seconds of playback under a caption that says "all week".
           * Ridge Hill's month is 696 frames and seventy-seven seconds, already
           * the longest thing in that deck.
           *
           * 180..360 is fifteen days, 20 Jun either side, ending about twenty
           * seconds later. It holds both moments the playback pauses at — clean
           * at 228 and dirty at 301 — with five days of quiet in front to make
           * "quiet all week" true and two days behind to let the episode fall
           * away. `to: 'end'` is still the way to play the summer.
           *
           * ⚠ **And a third of these frames have no reading**, which the bar
           * currently draws as empty — meaning, on this deck, clean air. That is
           * the one thing it must not say, and it is §3.
           */
          play: { from: 180, to: 360, stepsPerSec: 9, holdAt: ['clean', 'dirty'] },
        },
      ],
    },
  ];
}
