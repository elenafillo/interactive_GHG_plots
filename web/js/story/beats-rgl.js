/**
 * Ridge Hill, as data. One deck spec, exported as `DECK`.
 *
 * The machinery this used to carry -- the caption rules, the frame override
 * resolution, the act-to-slide flattening -- moved to `engine.js` when the
 * second deck arrived. What is left is this site's story and nothing else.
 *
 * The heavily-annotated values below stay as named constants rather than being
 * inlined into `DECK`: their comments are the record of how each number was
 * measured, and they read better beside the value than nested three deep inside
 * an object literal. `DECK`, at the foot of the file, is the manifest.
 *
 * No DOM, no canvas -- so the headless suite can assert on every caption,
 * camera and frame without a browser. That matters more here than usual: the
 * thing most likely to rot in a talk deck is the writing, and a test is the only
 * thing that will hold the line on caption length once slides start getting
 * edited ten minutes before a session.
 *
 * ---
 *
 * The story, in one paragraph. A sensor on a mast in Herefordshire measures
 * methane. Which way the wind blows decides what patch of ground the air last
 * touched -- and that patch is what the sensor can "smell". On 2 February 2020
 * the air came off the Atlantic and there was nothing in it. On 7 February the
 * wind swung to the south-east, the patch landed on London and the Low
 * Countries, and the reading jumped. Comparing the two is how we check whether
 * our guess at where methane comes from is any good. That is inverse modelling,
 * without the words.
 *
 * Every frame index below is verified against the real data -- see the plan file
 * for the per-region contribution analysis that picked them.
 */

/**
 * Every moment the deck can stop at. Nothing else hard-codes a frame number.
 *
 * Hourly frames from 2020-02-01 00:00 UTC, so t = day*24 + hour - 24.
 *   clean      2 Feb 12:00 -- wind due west at 10 m/s, air off the Atlantic,
 *                             +13 ppb above background. The quiet day.
 *   dirty      7 Feb 09:00 -- wind south-east at 6.0 m/s, 2108 ppb on a +83 ppb
 *                             enhancement. Belgium and London are both lit; by
 *                             midday London has fallen away. See the act.
 *   peak       7 Feb 10:00 -- 2124 ppb, the strongest single frame of the event.
 *   recordLow 15 Feb 13:00 -- 1919 ppb, the lowest reading of the month, during
 *                             Storm Dennis. Optional; see SHOW_RECORD_LOW.
 */
const FRAMES = { clean: 36, dirty: 153, peak: 154, recordLow: 349 };

/**
 * The smell bar's scale, in ppb above a fixed floor.
 *
 * The bar used to run across the month's whole range, 1919 to 2176, which put
 * the clean day a third of the way up a bar whose caption says there is nothing
 * to smell. It shows an *enhancement* instead: how far above clean air this
 * hour is, clamped at zero.
 *
 * `base` is the export's own background (1928.6) rounded, so the clean day
 * reads as a genuine sliver rather than as a flat zero -- which is the honest
 * picture, since the model puts +13 ppb on it. `span` was chosen against the
 * record: the dirty day lands at 89% of the bar and the peak hour at 97%, so
 * the strongest frame of the event is still the fullest thing on screen. A
 * narrower top saturates -- at +150 the dirty day and the peak are both hard
 * against the ceiling and the month's playback sits pinned there. Five hours of
 * 696 clip, all of them in the storm.
 *
 * Not `series.modelled`: that is the *modelled* enhancement, 5-86 ppb, a
 * different quantity on a different scale -- and a modelled number is the one
 * thing this deck refuses to put on screen as if it were a measurement.
 */
const SMELL = { base: 1930, span: 200 };

/** A third pause in the month's playback. Off: two contrasting days is the point. */
const SHOW_RECORD_LOW = false;

/**
 * Where a named body of air is released from, and how long before the anchor.
 *
 * A stop says `release: { from: 'ocean' }`; this is what that resolves to. Kept
 * here with the rest of the story's numbers rather than in `advect.js`, because
 * a release box is a claim about February 2020, not a fact about integration.
 *
 * ---
 *
 * **These were measured, and the measurement overturned the plan.** The design
 * called for the Atlantic release at 48-52 N, 14-18 W, thirty hours back,
 * reasoning from the anchor hour's own wind: 10.2 m/s from 257 deg for thirty
 * hours is ~1,100 km, which at 52 N is ~16 deg of longitude, so a release near
 * 18 W arrives near 2 W and the mast.
 *
 * That is true of a steady wind and false of this one. Integrated through the
 * real field, parcels from that box miss Ridge Hill by a mean of **940 km**:
 * the flow is cyclonic and curls them back to the north-west, ending near
 * (-18.5, 56.7) having never come close. The steady-wind estimate is exactly
 * the error the deck exists to argue against -- assuming the weather instead of
 * looking at it.
 *
 * So each release below is a **fan of back-trajectories from the mast**:
 * integrate backward from Ridge Hill at the anchor hour, and let where the air
 * actually was be where the air starts. The fan opens because the *arrival
 * hour* is spread -- the air reaching the mast at 09:00 was somewhere different
 * from the air reaching it at 12:00, which is what a footprint is an integral
 * over.
 *
 * ---
 *
 * **The marks are a stream along those tracks, not a cohort at the ends of
 * them.** Parcels start anywhere on a track, weighted by how red the map is
 * there, and fly the rest of it home; on the backwards stops they leave the
 * mast and run out. So there are always a few in the near field and a few in
 * the far, every one of them on a line the air really travelled, and every one
 * of them ending at the tower. See `_seedTable` in `wind.js`.
 *
 * ---
 *
 * ⚠ **The clean day's plume is one grid cell tall near the mast**, and that
 * fact set every number below. Decoded from the shipped export, the receptor
 * row reads 173, 190, 188 and the rows immediately north and south of it read
 * **0** -- so the red the audience sees is a band about 26 km wide, and a
 * trajectory that wanders off it is off it completely. Two knobs decide how
 * much of the fan stays on the band, and they turn out to do different jobs:
 *
 *   - **`arrivals` decides how much of the fan is on the drawn patch at all.**
 *     The deck shows *one* hour's footprint, and air arriving at a different
 *     hour has a different footprint -- so a fan drawn from twelve hours of
 *     arrivals is mostly air belonging to patches the slide never draws. At
 *     12 h, **50% of the fan's track length is outside the red**; at 4 h, 83%;
 *     at 2 h, 100%. This is what the parcels being "really off in the clean
 *     footprint" actually was.
 *   - **`jitterKm` decides whether a journey *stays* on it.** Of the seeds that
 *     start in the red, the share that fly all the way home without leaving it
 *     is 99% at 3 km of jitter and 47-75% at 10-15 km. The disc is meant to
 *     stand in for the sampling volume, and at 15 km it was half the width of
 *     the band it is sampling.
 *
 * So: **3 km and 4 hours**, which measures 83% of track length inside the red
 * and 99% of red seeds flying home without leaving it. The gate in `wind.js`
 * takes care of the other 17% by never seeding it.
 *
 * ---
 *
 * Five numbers, and what each is for:
 *
 *   - **`hours`** -- how far back the fan reaches, and so how long the longest
 *     journey is. The one to change if the air feels like it comes from too far
 *     away or not far enough. Twelve rather than the twenty-four this shipped
 *     with first: at 24 h the fan's far end was off the side of the frame, and
 *     with a stream the far end is where the *slowest* marks live, so it also
 *     set how long a parcel could be on screen without arriving.
 *   - **`arrivals`** -- the spread of arrival times, in hours, and the whole
 *     reason there is more than one trajectory. At 0 the fan collapses to a
 *     single thread. See above for why it is not larger.
 *   - **`jitterKm`** -- the disc around the mast the trajectories are traced
 *     from, standing in for the fact that the mast is a point and the air it
 *     measures is not. See above for why it is not larger.
 *   - **`count`** -- how many trajectories the fan holds.
 *   - **`parcels`** -- how many marks are alive at once. Small, and the number
 *     the audience actually sees. `E` cycles it live.
 */
const RELEASES = {
  // Measured on the clean day: forward from the far ends of this fan lands a
  // 9.9 km median and a 14.5 km maximum from the mast, against the 532 km worst
  // case of the corridor design that preceded it.
  ocean: { seed: 'backTrack', hours: 12, arrivals: 4, jitterKm: 3, count: 24, parcels: 12 },
  // The dirty day. One fan, and now only one stop reading it -- backwards. The
  // forwards stop it used to share with released from an ellipse over London
  // and the Low Countries; folding both onto this fan is what let that stop be
  // dropped without the backwards one losing anything to converge on.
  //
  // ⚠ That day's air *stalls* -- 6.45 m/s at the mast falling to 0.99 m/s
  // eighteen hours back -- so **36 hours, not 12**. Measured on the shipped
  // export, the rewind reaches lon 2.0 at 18 h, 2.5 at 24 h, and **3.3 at 36 h,
  // where all twenty-four tracks cross onto the continent**; 42 h buys another
  // 0.3 deg and nothing else. Twelve would leave the air in the North Sea while
  // the caption names Belgium. The far end sits at lat 49.5, well inside this
  // act's frame, and 100% of the track is inside the drawn plume the whole way,
  // so nothing is culled short.
  //
  // The bend in that day's plume is still out of reach at any window: it is
  // almost certainly air arriving below the 100 m level this deck ships, and
  // one level is all there is. The stream follows the part of the plume the
  // tracks cross and leaves the bend alone, which is the honest picture.
  sources: { seed: 'backTrack', hours: 36, arrivals: 4, jitterKm: 3, count: 24, parcels: 12 },
};

/**
 * The dirty day's backwards stop, which is on trial.
 *
 * The clean day earns its reveal: its plume is a corridor, the median bright
 * cell sits 214 km off the back-track, and a seeded cohort paints 41% of what
 * the audience sees. **The dirty day does not.** Its plume is 7,642 drawn cells
 * and the median one is 1,000 km off any track the air actually took, because
 * the flow stalls -- 6.45 m/s at the mast falling to 0.99 m/s eighteen hours
 * back, going nowhere. No corridor setting reaches both: 200 km covers 7.8% of
 * the plume, and by the time coverage reaches 15% the median parcel misses the
 * mast by 544 km.
 *
 * The likeliest reading, and the user's, is that the bend in that day's plume is
 * air arriving on a *different level* -- nearer the surface than the 100 m field
 * this deck ships. One level is all we have, so it cannot be followed.
 *
 * So this stop exists to be looked at and probably deleted. It runs the same
 * backwards replay over the `sources` ellipse, which does converge; what it will
 * not do is fill the bend.
 *
 * ⚠ **The price of `false` went up.** This stop used to sit after a forwards
 * one that followed the same air *in* and named Belgium and London. That stop
 * has been dropped, so switching this off now leaves the dirty day with no
 * stop that follows its air at all, and no sentence naming the two patches the
 * sources card just showed -- which is the claim "the red patch lands right on
 * top" two slides later is supposed to be checking. Delete this and that
 * sentence has to move onto another stop first.
 */
const SHOW_DIRTY_BACKTRACK = true;

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

/**
 * Everything `deck.js` needs to mount Ridge Hill, and the only export here.
 *
 * The three strings at the top were hardcoded in `deck.js` until the second
 * deck arrived -- the data directory, the word for the gas, and the timezone
 * `friendly()` renders dates in. Ridge Hill's `tzOffsetH` is 0 because British
 * time *is* UTC in February, which is why the assumption survived this long.
 */
export const DECK = {
  id: 'rgl',
  data: 'data-rgl/',
  species: 'ch4',
  title: 'Can I smell it?',
  /** The plain word for the gas. Never "CH₄", never "methane (CH₄)". */
  gasWord: 'methane',
  /** Hours to add to UTC before a date is spoken aloud. */
  tzOffsetH: 0,
  frames: FRAMES,
  smell: SMELL,
  releases: RELEASES,
  flags: { showRecordLow: SHOW_RECORD_LOW, showDirtyBacktrack: SHOW_DIRTY_BACKTRACK },
  // Where `→` goes off the last slide. Still null: `story-gsn.html` does not
  // exist yet, and a deck that navigates to a 404 on its final keypress is a
  // worse failure than one that clamps. Set to
  // `{ href: 'story-gsn.html', prefetch: 'data-gsn/' }` when that page ships.
  next: null,
  acts,
};

/** The nineteen stops, in order. */
function acts(f, {
  showRecordLow = SHOW_RECORD_LOW,
  showDirtyBacktrack = SHOW_DIRTY_BACKTRACK,
} = {}) {
  return [
    {
      id: 'where',
      title: 'Where are we?',
      anchor: 'clean',
      stops: [
        {
          caption: 'This is Bristol.',
          camera: { lon: -2.59, lat: 51.45, span: 1.4 },
          layers: { station: 0, graticule: 1, cities: 1 },
        },
        {
          // Out from 15, then out again to 25 -- and *down*, which is the half
          // that matters. Widening alone would have spent most of the new room
          // on the Norwegian Sea, so the centre drops with it: at 15 the frame
          // stopped at 48.4 N on a widescreen, cutting through Paris.
          //
          // The two moves together are close to a pure southward extension. The
          // top edge barely stirs -- 59.63 -> 59.03 at 16:9, 61.50 -> 61.38 at
          // 4:3 -- while the bottom drops 3.4 and 3.9 degrees respectively, to
          // 44.97 and 42.63. That reaches the Alps, the Bay of Biscay and the
          // top of Iberia: ground the air genuinely comes over, rather than
          // more empty North Atlantic.
          //
          // 1,708 km across at this latitude, so the *radius* is around 530
          // miles. The caption is a claim about reach from the mast, not about
          // the width of the frame, so "hundreds of miles" still holds -- it
          // held at 15 too, at 405 miles, but only just.
          //
          // The mast sits at (-2.54, 52.00) and the camera at (-3, 52), so it
          // is now within half a degree of the centre of the frame. For a beat
          // about how far something can smell, having it in the middle of its
          // own radius is worth more than the tidier round latitude.
          //
          // ⚠ The ceiling is the *north* edge of the data at 4:3: 31.9 from
          // this centre, against 42.5 at 16:9. So a span tuned on a widescreen
          // laptop can still run off the top of the map in a 4:3 hall, and the
          // gap between the two aspects is wide enough to hide it. The suite
          // checks both, so it fails there rather than on the night.
          caption: 'Forty kilometres north, there is a sensor.',
          camera: { lon: -3.0, lat: 52.0, span: 25 },
          layers: { cities: 1 },
          images: [
            {
              src: 'img/rgl/ridge_hill_mast_angelina.jpg',
              at: 'left-of-centre',
              size: 'lg',
              alt: 'The Ridge Hill TV station, where the measurement is',
            },
          ],
        },
        {
          caption: '',
          camera: { lon: -3.0, lat: 52.0, span: 25 },
          layers: { cities: 1 },
          images: [
            {
              src: 'img/rgl/ridge_hill_mast_angelina.jpg',
              at: 'left-of-centre',
              size: 'lg',
              alt: 'The Ridge Hill TV station, where the measurement is',
            },
            {
              src: 'img/rgl/ridge_hill_cows.jpg',
              at: 'right',
              size: 'lg',
              alt: 'Cows near the Ridge Hill TV station',
            },
          ],
        },
        {
          caption: 'Researchers set up the towers',
          camera: { lon: -3.0, lat: 52.0, span: 25 },
          layers: { cities: 1 },
          images: [
            {
              src: 'img/rgl/angelina_setup.jpg',
              size: 'card',
              alt: 'Two people inspecting a sensor',
            },
          ],
        },
        {
          caption: 'And they interpret the data',
          camera: { lon: -3.0, lat: 52.0, span: 25 },
          layers: { cities: 1 },
          images: [
            {
              src: 'img/rgl/sam_analysis.jpg',
              size: 'card',
              alt: 'Person looks at a computer next to a blue machine',
            },
          ],
        },
        {
          camera: { lon: -3.0, lat: 52.0, span: 25 },
          layers: { cities: 1 },
        },
      ],
    },

    {
      id: 'clean-wind',
      title: 'A quiet day',
      anchor: 'clean',
      needs: ['wind'],
      // Framed identically to `clean-smell`, which buys two things. The
      // footprint then fades in over a camera that is not moving, which is what
      // "the smelling area appears over the parcels" is supposed to look like.
      // And the old span 30 at lon -11 reached lon -26, past the western edge of
      // the data at -24.86, so the wind field would have stopped in a hard
      // vertical line about 4% in from the left of the screen. At span 27 the
      // frame ends 1.36 deg short of the data on every aspect ratio a fullscreen
      // deck realistically meets.
      //
      // Both stops draw the same moving air. The first is the field on its own
      // -- tracers everywhere, drifting -- and the second picks one body of air
      // out of it and runs it *backwards*, out to where it came from. Stepping
      // between them is a caption change over a picture that never restarts,
      // which is the whole reason the wind is drawn as parcels rather than as
      // arrows: an audience shown a moving dot here must not have to unlearn it
      // one slide later.
      //
      // There used to be a forwards stop between the two -- the same body of
      // air followed *in* to the mast, captioned "This air has crossed nothing
      // but sea." It was dropped: two beats of the same air in two directions
      // is one beat too many for a caption to carry, and the backwards run is
      // the one the next act's reveal needs. Its consequence is that the
      // backwards stop is now the audience's *first* sight of a single body of
      // air, so its caption cannot lean on a forwards beat that no longer
      // exists -- it has to introduce the idea itself.
      // lat 52 -> 50, on the user's call, so the frame holds the lower
      // latitudes the seeded cohort reaches. At 16:9 the bottom edge moves from
      // 44.41 to 42.41, and the 24 h seeds reach 43.25 -- 0.84 deg of margin.
      // Everything in `clean-smell` moves with it: the two acts have to stay
      // framed identically or the plume stops fading in over a still camera.
      stops: [
        {
          caption: 'Today the wind comes off the Atlantic.',
          camera: { lon: -10, lat: 50, span: 27 },
          layers: { wind: 1 },
        },
        {
          // The second beat, and the one the whole rework is for. The same air,
          // leaving the mast and running back out to where it came from -- so
          // the next slide's red patch arrives over a shape the audience has
          // just watched being traced out.
          //
          // ⚠ **Nothing is painted.** An earlier build accumulated the tracks
          // onto a buffer under the plume; on screen it read as a second map
          // competing with the real one, and the moving parcels were already
          // saying it. The parcels alone, on the user's call.
          //
          // The ambient air drops to a whisper rather than switching off: the
          // step from the previous slide has to stay a caption change over a
          // continuous picture, and killing the teal outright would restart it.
          // ✏️ PLACEHOLDER -- rewrite me. The old line was "Now run it
          // backwards. Where was this air?", which only parsed as an answer to
          // the forwards stop that used to sit above it. With that stop gone
          // this is the first time the audience sees one body of air, so the
          // caption has to do two jobs at once: say we are winding the clock
          // *back*, and say what the marks leaving the mast are. Ten words.
          caption: 'Follow the air backwards. Where has it just been?',
          camera: { lon: -10, lat: 50, span: 27 },
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
          // The reveal: the real plume comes up over the air still running back
          // out along it, so the claim "this is what the mast can smell" lands
          // on a shape the audience watched being traced rather than on a
          // raster that just appeared. The backwards air keeps running -- it is
          // what carries the shape now that nothing is painted -- with the
          // ambient teal off, so the red has the frame to itself.
          //
          // ⚠ The parcels *illustrate* the plume; they do not compute it.
          // Measured against the shipped export, the tracks come within 60 km
          // of 11% of the drawn patch on the clean day, and the real thing is
          // thirty days of mixing through a boundary layer. The caption says
          // what the red means, never "this is how we work it out".
          caption: 'Red is everything the mast can smell.',
          camera: { lon: -10, lat: 50, span: 27 },
          layers: { footprint: 1, wind: 1 },
          release: { from: 'ocean' },
          mode: 'back',
          ambient: 0,
          needs: ['wind'],
        },
        {
          caption: 'It is all empty sea. Nothing there.',
          camera: { lon: -10, lat: 50, span: 27 },
          layers: { footprint: 1 },
        },
      ],
    },

    {
      id: 'sources',
      title: 'Where we think it comes from',
      anchor: 'clean',
      // The whole map, then the same map taken apart into the three things
      // making it. Each family gets a slide to itself before any two share a
      // frame, which is what lets colour carry the difference at the end: by the
      // stacked stop the reader has met all three one at a time.
      //
      // Purple opens because purple already means "where methane comes from"
      // from the explorer, and it is switched off the moment the families
      // arrive, so it never has to be told apart from them.
      //
      // Percentages are of the whole map, from the export -- 49.5 / 27.9 / 22.3,
      // covering 99.7%. They are for you to say, not for the slide to print.
      //
      // The framing was lon -0.5, lat 54, span 21, which at 16:9 stopped at
      // 48.09 N -- a hard cut through northern France that left the map looking
      // like it ended at the Channel. Widened to span 24 and dropped to lat
      // 52.5, the bottom edge reaches 45.75 N (43.50 at 4:3): all of France,
      // the Alps and the top of the Po valley, so "where methane comes from"
      // is a continent rather than a strip. Longitude runs -12.50..11.50,
      // inside both the footprint grid and the hi-res rasters, and still short
      // of Silesia -- the eastern limit this card was framed to exclude.
      stops: [
        {
          caption: 'Purple is where methane comes from.',
          camera: { lon: -0.5, lat: 52.5, span: 24 },
          layers: { fluxHi: 0.92, cities: 1 },
        },
        {
          // The load-bearing line of the whole deck.
          caption: 'But nobody counted it. This is a guess.',
          camera: { lon: -0.5, lat: 52.5, span: 24 },
          layers: { fluxHi: 0.92, cities: 1 },
        },
        {
          caption: 'Most of it is cows and farms.',
          camera: { lon: -0.5, lat: 52.5, span: 24 },
          layers: { srcFarming: 0.95, cities: 1 },
        },
        {
          caption: 'Then rubbish dumps and sewage works.',
          camera: { lon: -0.5, lat: 52.5, span: 24 },
          layers: { srcWaste: 0.95, cities: 1 },
        },
        {
          // Leaking and burning are one colour and two sentences: gas escaping
          // from pipes and wells, and gas surviving a flame. Saying it beats
          // drawing it -- a fourth colour would split the picture without
          // making the difference any more visible.
          caption: 'And gas that leaks, or gets burnt.',
          camera: { lon: -0.5, lat: 52.5, span: 24 },
          layers: { srcFossil: 0.95, cities: 1 },
        },
        {
          // The three back together. Swap these three alphas for one and this
          // becomes a fourth single-family stop instead; nothing else changes.
          caption: 'Cows, rubbish, and gas. All of it guessed.',
          camera: { lon: -0.5, lat: 52.5, span: 24 },
          layers: { srcFarming: 0.9, srcWaste: 0.9, srcFossil: 0.9, cities: 1 },
        },
      ],
    },

    {
      id: 'dirty',
      title: 'A dirty day',
      anchor: 'dirty',
      // 09:00 rather than the 08:00 this shipped with. Measured on the export,
      // the two hours cost nothing against each other -- the enhancement is
      // +82.8 ppb against +82.3, and the observed reading is 2108 against 2080
      // -- while the split tilts from London toward Belgium: 21.7/31.0 percent
      // at 08:00 becomes 16.6/36.4 at 09:00 (boxes -1.0..1.6 E / 50.6..52.4 N
      // and 2.5..7.2 E / 49.4..53.6 N). Both are still lit, which is what the
      // caption claims. The hour after that is where it stops being true:
      // London falls 12.6 -> 9.2 -> 4.5 percent through 10:00, 11:00 and 12:00
      // as northern France comes up behind it.
      //
      // A free one: at frameStride 3, frame 153 is wind step 51 exactly, so the
      // dirty day is now drawn from a sampled field rather than an interpolated
      // one, as the clean day at frame 36 already was. Not a reason to choose
      // the hour, but worth knowing it costs nothing.
      stops: [
        {
          caption: 'Five days later, the wind has turned.',
          camera: { lon: 0.5, lat: 52, span: 21 },
          layers: { wind: 1, cities: 1 },
          needs: ['wind'],
        },
        {
          // The emissions map comes back before the air is followed, so "over
          // Belgium and London" lands on a picture the audience has already
          // read rather than on empty ground. It is `fluxHi`, not `flux`: the
          // same raster, the same display window and the same square cells as
          // the sources card, so it is recognisably *that* map returning and
          // not a second one. The wind stays on top of it -- the turn is the
          // thing this act just established and dropping it here would make
          // the next stop restart rather than continue.
          caption: 'Now it blows from cities and farms.',
          camera: { lon: 0.5, lat: 52, span: 21 },
          layers: { fluxHi: 0.92, wind: 1, cities: 1 },
          needs: ['wind'],
        },
        // The same two-beat move the Atlantic act makes, and for the same
        // reason: the field first, then one body of air picked out of it. The
        // turn is easier to *see arriving* than to state.
        //
        // The forwards half of it is gone -- air followed *in* from the
        // south-east, captioned "This air came over Belgium and London." --
        // dropped with its opposite number in `clean-wind` so the deck makes
        // this move one way only, and the same way both times.
        //
        // ⚠ That leaves the naming of Belgium and London to the backwards stop
        // below, which is gated. Both places are honestly inside the release:
        // the fan spans London and the Thames through to Brussels and Antwerp,
        // and the centre track runs (+1.9,51.0) -> (+0.1,51.7) just north of
        // London -> (-1.5,52.5). One colour for both, since the caption does
        // not rank them.
        //
        // Gated on SHOW_DIRTY_BACKTRACK -- see the note there, and read it
        // again now: with the forwards stop gone, setting that flag to `false`
        // no longer trims a trial stop, it removes the *only* place the dirty
        // day follows its air at all, and with it the sentence that names the
        // two patches the sources card just showed.
        ...(showDirtyBacktrack ? [{
          // ✏️ PLACEHOLDER -- rewrite me. The old line was "Run it backwards.
          // Where was this air?", which answered the forwards stop that used to
          // sit above it. That stop is gone, so this caption now has to carry
          // the place names as well: it is the deck's only claim that the air
          // came over Belgium and London, and the payoff two slides later
          // ("the red patch lands right on top") is checking *this* sentence
          // against the guess. Ten words.
          caption: 'Wind the clock back. This air crossed Belgium and London.',
          camera: { lon: 0.5, lat: 52, span: 21 },
          layers: { wind: 1, cities: 1 },
          release: { from: 'sources' },
          mode: 'back',
          ambient: 0.25,
          needs: ['wind'],
        }] : []),
        {
          // See-through plume over the sources: both readable at once.
          //
          // `fluxHi`, matching the second stop and Card 3. "Lands right on top"
          // is a claim about *that* map, and it was being made over a different
          // one -- coarser cells, a different display window, smoothed where the
          // other two are square. The alphas are carried over unchanged and are
          // the thing to check by eye: the hi-res raster hides 64% of its cells
          // below the floor but draws what is left harder, so the same number
          // is a quieter map with brighter sources rather than the same weight.
          caption: 'The red patch lands right on top.',
          camera: { lon: 0.5, lat: 52, span: 21 },
          layers: { fluxHi: 0.35, footprint: 1, cities: 1 },
        },
        {
          caption: 'And we can smell it.',
          camera: { lon: 0.5, lat: 52, span: 21 },
          layers: { fluxHi: 0.12, footprint: 1, cities: 1 },
          play: { from: 0, to: 4, stepsPerSec: 1.2, holdAt: ['peak'] },
        },
      ],
    },

    {
      id: 'record',
      title: 'How much can we smell?',
      anchor: null,
      // The month used to run as a line chart along the bottom. It does not any
      // more: the bar on the left already says how much the mast is smelling,
      // and a chart drawing the same quantity a second way -- with an axis, a
      // cursor and a shape to read -- competes with the map for the one thing
      // the audience is meant to watch. So the two swapped. The chart machinery
      // is still wired up behind `chart: true` if an act ever wants it back.
      chart: false,
      stops: [
        {
          caption: 'A little on Sunday. A lot on Friday.',
          // span 34 ran off the northern edge of the data on a 4:3 screen -- a
          // thin empty band along the top of the month's playback. 30 clears it
          // at both 16:9 and 4:3 and still holds the Atlantic and Europe.
          camera: { lon: -6, lat: 52, span: 30 },
          layers: { footprint: 1 },
          play: {
            from: 0, to: 'end', stepsPerSec: 9,
            holdAt: showRecordLow ? ['clean', 'dirty', 'recordLow'] : ['clean', 'dirty'],
          },
        },
      ],
    },
  ];
}
