/**
 * Air parcels carried by the wind field.
 *
 * This is the whole of the deck's physics, and it is four lines of it: a vector
 * in m/s becomes a vector in degrees per second, and a parcel is stepped along
 * it. Everything else in here is bookkeeping -- lifetimes, trails, and the
 * recycling that keeps a population alive while a presenter talks over it.
 *
 * ---
 *
 * **Why parcels and not arrows.** The first build of the wind layer drew an
 * arrow lattice. It was legible, correct, and dead: an arrow *states* a
 * direction, and a still picture of stated directions gives the eye nothing to
 * catch. Air that moves shows direction and speed at once, without a single
 * arrowhead, and it looks like weather rather than like a diagram. So the same
 * mark now does both jobs -- ambient tracers are "the air, everywhere", and a
 * released cohort is "*this* air, the bit we are following" -- which is what
 * stops the deck saying two things with one mark on consecutive slides.
 *
 * **Three clocks, and keeping them straight is the whole trick.**
 *
 *   - *Wall clock* -- real seconds, from the render loop.
 *   - *Simulated time* -- hours of weather. One wall second buys several
 *     simulated hours; the rate lives in `wind.js` because it is a presentation
 *     decision, not a physical one.
 *   - *Field time* (`tau`) -- the footprint frame the wind is sampled at, which
 *     during a released journey ramps from the release hour up to the anchor
 *     hour, and otherwise sits still.
 *
 * The second and third are the same length of time during a journey and are
 * *not* the same during a hold, which is why `advance()` takes both. Sampling
 * the field at each substep's own field time rather than holding one frame is
 * not optional: the wind is 3-hourly, a parcel covers ~110 km between steps, and
 * holding a frame kinks every trajectory at each 3 h boundary in a way that
 * reads as a rendering fault rather than as weather.
 *
 * **Measured, not assumed.** The plan's Atlantic release box (48-52 N, 14-18 W,
 * 30 h) was derived from a steady 257 deg at 10.2 m/s. Integrated through the
 * real field it misses Ridge Hill by a mean of 940 km -- the February flow is
 * cyclonic and curls the parcel back to the north-west. The boxes that ship are
 * back-trajectories from the mast instead: see RELEASES in `story/beats.js`.
 */

/**
 * Metres per second to degrees per second.
 *
 * The only physics in the module. Longitude degrees shrink with latitude, which
 * matters at 52 N where a degree of longitude is 61% of a degree of latitude --
 * ignore it and every trajectory drifts east.
 */
export function degPerSec(u, v, lat) {
  return {
    dLon: u / (111320 * Math.cos((lat * Math.PI) / 180)),
    dLat: v / 110540,
  };
}

/** Great-circle-ish distance in km. Good to a fraction of a percent at these scales. */
export function kmBetween(lon1, lat1, lon2, lat2) {
  const mLat = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const dx = (lon2 - lon1) * 111.32 * Math.cos(mLat);
  const dy = (lat2 - lat1) * 110.54;
  return Math.hypot(dx, dy);
}

/**
 * The substep cap, derived rather than picked.
 *
 * A parcel must not cross more than a quarter of a cell in one step or bilinear
 * sampling stops tracking the field it is meant to be following. At the grid's
 * own cell size and the encoded maximum wind that comes out around 160 s -- so a
 * 3 h wind interval is ~70 substeps, which is cheap.
 */
export function substepCap(field) {
  const midLat = (field.latMin + field.latMax) / 2;
  const cellM = Math.min(
    field.dLat * 110540,
    field.dLon * 111320 * Math.cos((midLat * Math.PI) / 180),
  );
  return (cellM * 0.25) / field.uvMax / 3600;
}

/**
 * Integrate one parcel backwards from a point, and keep the track.
 *
 * This is the spine the plume seeding hangs off, and it is the only place in the
 * deck that runs time backwards. Worth being clear about why it can be trusted:
 * backward and forward integration through the same field are exact inverses,
 * and the Python harness measures the round trip from Ridge Hill at 14, 18 and
 * 30 h as returning to **0.0 km**. So a point on this track is, by construction,
 * a point that flows forward to the mast.
 *
 * @returns {{lon:number,lat:number,hours:number}[]} newest first: element 0 is
 *   the release point itself at `hours: 0`, and `hours` counts *backwards*.
 */
export function backTrack(field, { lon, lat, anchor, hours, recordHours = 0.25 }) {
  const out = [{ lon, lat, hours: 0 }];
  const steps = Math.max(1, Math.ceil(hours / substepCap(field)));
  const dt = hours / steps;
  const sec = dt * 3600;
  const uv1 = { u: 0, v: 0 };
  const uv2 = { u: 0, v: 0 };

  let clon = lon;
  let clat = lat;
  let since = 0;

  for (let s = 0; s < steps; s++) {
    const tau = anchor - dt * s;
    const a = field.sample(tau, clon, clat, uv1);
    if (!a) break;
    const k1 = degPerSec(a.u, a.v, clat);
    const mLon = clon - k1.dLon * (sec / 2);
    const mLat = clat - k1.dLat * (sec / 2);
    const b = field.sample(tau - dt / 2, mLon, mLat, uv2);
    if (!b) break;
    const k2 = degPerSec(b.u, b.v, mLat);
    const nLon = clon - k2.dLon * sec;
    const nLat = clat - k2.dLat * sec;
    if (!field.inside(nLon, nLat)) break;

    clon = nLon;
    clat = nLat;
    since += dt;
    if (since >= recordHours) {
      since = 0;
      out.push({ lon: clon, lat: clat, hours: dt * (s + 1) });
    }
  }
  return out;
}

/**
 * A fan of trajectories, every one of which ends at the mast.
 *
 * ---
 *
 * **Two designs were built and measured before this one, and both failed on
 * screen.** Worth recording, because each looks reasonable written down.
 *
 * *One box, one hour* -- the deck's original. It converges (the old `ocean`
 * ellipse lands a 57 km median miss) but it is a single thread: rasterised
 * against the patch the audience actually sees, it covers 12-25% of the clean
 * day's plume and 0.5-1.5% of the dirty day's.
 *
 * *A corridor around the back-track*, seeded from the drawn plume and weighted
 * by the physical field. This bought coverage -- 38% of the clean day's plume --
 * and it was **wrong**, in a way the summary statistic hid. A cross-track offset
 * is carried straight through to the arrival, so a cohort seeded across a 300 km
 * corridor lands spread across 300 km of a line *perpendicular to the flow*. The
 * median miss stayed a respectable 30 km while the **maximum reached 532 km**,
 * and on screen that is a scatter of parcels on a diagonal through the mast --
 * air the deck claims the sensor smelled, arriving nowhere near it.
 *
 * **So the fan comes from arrival time instead.** A back-trajectory ends at the
 * mast by construction, and distinct trajectories come from asking a different
 * question: the air reaching the mast at 12:00 was somewhere different from the
 * air reaching it at 09:00. That is what a footprint is an integral over, so
 * the spread is physically meaningful rather than a rendering device -- and it
 * is what a footprint's own shape comes from, which means the fan follows the
 * plume's bright areas without ever being told about them.
 *
 * Measured on the clean day at the shipped 24 h / 12 h / 24 parcels: forward
 * integration from the far ends lands a **9.9 km median and a 14.5 km maximum**
 * from the mast, against the corridor's 532 km worst case. Plume coverage falls
 * to ~15%, which is the trade, and it is the right one: the painted tracks
 * illustrate what the red area means and were never going to derive it.
 *
 * The funnel the deck wants falls out for free -- every track converges on one
 * point, so density is highest at the tower and the fan opens with distance.
 *
 * **The whole track is kept, not just its far end.** That is what lets the deck
 * seed air *along* the path rather than only at the rim: every point on a
 * back-trajectory is, by construction, a point that flows forward to the mast,
 * so a parcel dropped anywhere on one arrives just as exactly as a parcel
 * dropped at the end of it -- it simply has less far to come. Seeding off the
 * track is what the 300 km corridor did, and its cross-track error went
 * straight through to the arrival.
 *
 * @param {object} field  a `WindField`
 * @param {object} opts
 * @param {number} opts.lon        the mast
 * @param {number} opts.lat
 * @param {number} opts.anchor     footprint frame the last parcel arrives on
 * @param {number} opts.hours      how far back each trajectory runs
 * @param {number} opts.arrivals   spread arrivals over this many hours
 * @param {number} opts.count      how many trajectories
 * @param {number} [opts.jitterKm] disc around the mast, for the sampling volume
 * @param {number} [opts.recordHours] how finely each track is recorded
 * @param {()=>number} [opts.random]
 * @returns {{track: {lon:number,lat:number,hours:number}[], arrival:number}[]}
 *   one entry per trajectory. `track[0]` is the mast and `hours` counts back
 *   from it, so a point's own `hours` is how long it takes to fly home.
 */
export function buildFan(field, {
  lon, lat, anchor, hours, arrivals = 12, count = 24,
  jitterKm = 15, random = Math.random, recordHours = 0.25,
}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    // Arrivals evenly spaced rather than random, so a small cohort cannot draw
    // them all from the same hour and collapse the fan back to one thread.
    const arrival = count > 1 ? (i / (count - 1)) * arrivals : 0;

    // A few km of jitter stands in for the sampling volume: the mast is a point
    // and the air it measures is not. Without it every track at the same
    // arrival hour is identical.
    const a = random() * Math.PI * 2;
    const g = Math.sqrt(random());
    const jLat = (jitterKm / 110.54) * g * Math.sin(a);
    const jLon = (jitterKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * g * Math.cos(a);

    const track = backTrack(field, {
      lon: lon + jLon, lat: lat + jLat, anchor: anchor - arrival, hours, recordHours,
    });
    const far = track[track.length - 1];
    // A track that ran off the grid is shorter than the window, and its own
    // `hours` is what says so -- flying it home for the full window would put
    // the parcel somewhere the air never was.
    if (!far || !(far.hours > 0.25)) continue;
    out.push({ track, arrival });
  }
  return out;
}

/**
 * The far end of each track in the fan -- one release point per trajectory.
 *
 * What the deck released from before the stream: a cohort that all set off from
 * the outer rim together. Kept because it is the honest way to ask "where was
 * this air a day ago", and because the checks that measure convergence measure
 * it here, at the worst case.
 */
export function seedFromBackTracks(field, opts) {
  return buildFan(field, opts).map(({ track, arrival }) => {
    const far = track[track.length - 1];
    return { lon: far.lon, lat: far.lat, hours: far.hours, arrival };
  });
}

/**
 * Read one trail point, oldest first.
 *
 * A module function rather than a method, and the ring's capacity lives on the
 * parcel rather than on the population, because the drawer holds two
 * populations with different trail lengths -- an ambient tracer keeps a couple
 * of hours, a released cohort keeps its whole journey. Reading one through the
 * other's capacity silently returns the wrong points.
 *
 * @param {object} p
 * @param {number} k  0 is the oldest point still held, `p.n - 1` the newest
 * @param {{lon:number,lat:number}} out
 */
export function trailPoint(p, k, out = { lon: 0, lat: 0 }) {
  const idx = (p.head - p.n + k + p.cap * 2) % p.cap;
  out.lon = p.trail[idx * 2];
  out.lat = p.trail[idx * 2 + 1];
  return out;
}

/**
 * A population of parcels drifting through a `WindField`.
 *
 * Two roles, one class, because they differ only in bookkeeping:
 *
 *   - **ambient** (`recycle: true`) -- seeded across whatever is on screen,
 *     staggered so they never die in unison, respawned on death. Alive for as
 *     long as the slide is up.
 *   - **a journey** (`recycle: false`) -- one cohort released together from a
 *     box, run forward to the anchor hour, then frozen with its trail still
 *     drawn. The trail is the evidence for "this air has crossed nothing but
 *     sea", so it must survive arrival rather than fade on it.
 */
export class AdvectedParcels {
  /**
   * @param {import('./wind.js').WindField} field
   * @param {object} [opts]
   * @param {number} [opts.count]           how many parcels
   * @param {number} [opts.lifeHours]       simulated hours before recycling
   * @param {number} [opts.trailHours]      how much history the tail shows
   * @param {number} [opts.trailStepHours]  how often a trail point is recorded
   * @param {number} [opts.sign]            +1 forward in time, -1 backward
   * @param {boolean} [opts.recycle]        respawn on death, or freeze
   * @param {boolean} [opts.stagger]        spread initial ages over a lifetime
   * @param {number|null} [opts.anchorTau]  give every parcel its own field clock
   * @param {(i:number)=>{lon:number,lat:number}} [opts.spawn]  where they start
   */
  constructor(field, {
    count = 200,
    lifeHours = 3,
    trailHours = 1.5,
    trailStepHours = 0.15,
    sign = 1,
    recycle = true,
    stagger = true,
    anchorTau = null,
    spawn = null,
  } = {}) {
    this.field = field;
    this.lifeHours = lifeHours;
    // ---------------------------------------------------------------------
    // One clock or many.
    // ---------------------------------------------------------------------
    // A cohort released together shares a clock: `advance()` is told the field
    // time at each end of the step and every parcel reads the same weather,
    // which is right when they all set off at the same moment.
    //
    // A *stream* does not. Its parcels are scattered along the tracks, so at any
    // instant one is six hours from the mast and another is one hour away, and
    // the six-hour one has to be flying through the weather of six hours ago.
    // `anchorTau` is the field time they are all converging on -- the slide's
    // own hour -- and each parcel's clock is that, less how far it still has to
    // come. Set it and `advance()`'s `tauFrom`/`tauTo` are ignored for the
    // population; leave it null and nothing changes.
    this.anchorTau = anchorTau;
    this.trailHours = trailHours;
    this.trailStepHours = trailStepHours;
    this.sign = sign;
    this.recycle = recycle;
    this.stagger = stagger;
    this.spawn = spawn || (() => ({
      lon: field.lonMin + Math.random() * (field.lonMax - field.lonMin),
      lat: field.latMin + Math.random() * (field.latMax - field.latMin),
    }));

    this.maxStepHours = substepCap(field);

    this.trailCap = Math.max(2, Math.ceil(trailHours / trailStepHours) + 1);
    this.parcels = [];
    this.setCount(count);
  }

  /** Grow or shrink the population -- the deck resizes and density follows. */
  setCount(n) {
    const target = Math.max(0, Math.round(n));
    while (this.parcels.length > target) this.parcels.pop();
    while (this.parcels.length < target) {
      const p = {
        lon: 0, lat: 0, age: 0, life: this.lifeHours, alive: false, frozen: false,
        speed: 0, sinceTrail: 0, tauOffset: 0,
        trail: new Float32Array(this.trailCap * 2), head: 0, n: 0, cap: this.trailCap,
      };
      this._respawn(p, this.parcels.length);
      this.parcels.push(p);
    }
    return this;
  }

  get count() { return this.parcels.length; }

  /** Every parcel back to a fresh start. Called when a slide (re)opens. */
  reset() {
    this.parcels.forEach((p, i) => this._respawn(p, i));
    return this;
  }

  /**
   * Send one parcel back to the start.
   *
   * Public because the drawing layer has a reason of its own to end a parcel
   * that this class cannot know about: the deck culls air that has drifted out
   * of the drawn plume, which is a claim about the footprint and not about the
   * wind.
   */
  respawn(i) {
    const p = this.parcels[i];
    if (p) this._respawn(p, i);
    return this;
  }

  /** True once no parcel is still moving. Only meaningful for a cohort. */
  get settled() {
    return this.parcels.every((p) => !p.alive || p.frozen);
  }

  /**
   * Run the whole journey now, rather than over the next few wall seconds.
   *
   * The backwards stop replays the cohort's own tracks in reverse, so it needs
   * them complete the moment the slide opens -- it cannot depend on how long the
   * presenter left the previous slide up, or on whether they arrived by pressing
   * left. Cheap enough to do synchronously: a few dozen parcels over a day of
   * weather is a few thousand substeps.
   */
  runToEnd(totalHours, tauFrom, tauTo, chunkHours = 0.5) {
    const n = Math.max(1, Math.ceil(totalHours / chunkHours));
    const dTau = (tauTo - tauFrom) / n;
    const dh = totalHours / n;
    for (let i = 0; i < n; i++) {
      this.advance(dh, tauFrom + dTau * i, tauFrom + dTau * (i + 1));
    }
    return this;
  }

  _respawn(p, i) {
    const s = this.spawn(i);
    p.lon = s.lon;
    p.lat = s.lat;
    // Staggered birthdays are what stop an ambient population blinking in
    // unison every `lifeHours`. A cohort is released together on purpose, so it
    // opts out and reads as one body of air.
    //
    // A plume-seeded cohort is the third case, and it is why `spawn` may set
    // the age itself: each parcel has its own release hour, so it waits, dormant
    // at a negative age, until the field clock reaches the moment the air was
    // actually there. That is what makes the stream start as a trickle from the
    // far end and thicken as the near seeds join.
    p.age = s.age !== undefined ? s.age
      : (this.stagger ? -Math.random() * this.lifeHours : 0);
    // A drawing hint, not a rule: the drawer fades a parcel out as it
    // approaches this. Infinite for a cohort released as one body, because such
    // a parcel does not die at the end of its journey -- it arrives, and the
    // arrival is the whole payoff of the slide. A plume-seeded parcel sets its
    // own, equal to its journey, so it freezes exactly on the anchor hour
    // instead of sailing past the mast.
    p.life = s.life !== undefined ? s.life
      : (this.recycle ? this.lifeHours : Infinity);
    // How much earlier than `anchorTau` this parcel's journey ends. The fan's
    // whole point is that the air arriving at 09:00 is not the air arriving at
    // 12:00, so a parcel bound for the earlier arrival has to fly through the
    // earlier weather. Zero for everything else.
    p.tauOffset = s.tauOffset || 0;
    p.alive = true;
    p.frozen = false;
    p.speed = 0;
    p.sinceTrail = 0;
    p.head = 0;
    p.n = 0;
    // The origin is a trail point. Without it a parcel that leaves the grid on
    // its first step has no trail at all and cannot be drawn -- so the marks
    // nearest the edge, which are the ones the eye is following out, are the
    // ones that vanish.
    this._pushTrail(p);
  }

  _pushTrail(p) {
    p.trail[p.head * 2] = p.lon;
    p.trail[p.head * 2 + 1] = p.lat;
    p.head = (p.head + 1) % p.cap;
    if (p.n < p.cap) p.n++;
  }

  /**
   * Move the whole population.
   *
   * @param {number} dtHours   simulated hours to advance (always positive)
   * @param {number} tauFrom   field time at the start, in footprint frames
   * @param {number} tauTo     field time at the end. Equal to `tauFrom` means a
   *                           held field -- honest as "the wind at this hour",
   *                           and what the ambient layer runs on between
   *                           journeys.
   */
  advance(dtHours, tauFrom, tauTo = tauFrom) {
    if (!(dtHours > 0)) return this;
    const steps = Math.max(1, Math.ceil(dtHours / this.maxStepHours));
    const dt = dtHours / steps;
    const dTau = (tauTo - tauFrom) / steps;

    for (let s = 0; s < steps; s++) {
      const tau = tauFrom + dTau * s;
      for (let i = 0; i < this.parcels.length; i++) {
        this._step(this.parcels[i], i, dt, tau, dTau);
      }
    }
    return this;
  }

  /** One RK2 midpoint step for one parcel. */
  _step(p, i, dt, tau, dTau) {
    if (!p.alive || p.frozen) return;

    p.age += dt;
    if (p.age <= 0) return;                   // not born yet (staggered)

    // How much of this step the parcel is actually airborne for, clipped at
    // both ends. A parcel released part-way through a step must not fly for the
    // part of it before its release, and one that *arrives* part-way through
    // must not sail on past the mast for the remainder.
    //
    // `p.life`, not `this.lifeHours`: a fan of back-trajectories has a
    // different journey length per parcel, and reading the population's value
    // here would carry the short ones straight through the receptor.
    //
    // Worth the arithmetic: the overshoot is a whole substep of travel, which
    // on the shipped grid is ~1.6 km and on a coarse one is nearly 20. It is
    // the difference between a cohort that lands on the mast and one that
    // scatters around it.
    let step = Math.min(dt, p.age);
    if (p.age > p.life) step -= p.age - p.life;

    if (!(step > 0)) {
      if (this.recycle) { this._respawn(p, i); return; }
      p.frozen = true;
      return;
    }

    const sec = step * 3600;
    const sign = this.sign;
    // The field time advances with the clipped step, not the whole one, or a
    // parcel taking a short final step would read the weather at the wrong hour.
    let dTauStep = dTau * (step / dt);
    let fieldTau = tau;

    // A parcel with its own clock reads the weather of the hour it is really
    // in: `anchorTau` less the time it still has to travel (forward) or the time
    // it has already spent (backward), both measured from the *start* of this
    // step. Its clock and the field's then run at the same rate by definition,
    // which is what `dTauStep = step` says -- and the midpoint sample below
    // multiplies it by `sign`, so backwards air reads backwards weather.
    if (this.anchorTau != null && Number.isFinite(p.life)) {
      const endAge = Math.min(p.age, p.life);
      const startAge = endAge - step;
      const away = sign > 0 ? p.life - startAge : startAge;
      fieldTau = this.anchorTau - p.tauOffset - away;
      dTauStep = step;
    }

    const a = this.field.sample(fieldTau, p.lon, p.lat, this._uv1 || (this._uv1 = { u: 0, v: 0 }));
    if (!a) { this._leave(p, i); return; }
    const k1 = degPerSec(a.u, a.v, p.lat);

    const mLon = p.lon + sign * k1.dLon * (sec / 2);
    const mLat = p.lat + sign * k1.dLat * (sec / 2);

    // The midpoint is sampled at the midpoint *in time* as well as in space.
    // Skipping that is the 3-hourly trap: it makes the second half of every
    // wind interval use the first half's weather.
    const b = this.field.sample(fieldTau + sign * dTauStep * 0.5, mLon, mLat,
      this._uv2 || (this._uv2 = { u: 0, v: 0 }));
    if (!b) { this._leave(p, i); return; }
    const k2 = degPerSec(b.u, b.v, mLat);

    const lon = p.lon + sign * k2.dLon * sec;
    const lat = p.lat + sign * k2.dLat * sec;

    // A step that would land off the grid is not taken. Committing it and then
    // freezing leaves the mark sitting over ocean the export knows nothing
    // about, which is a quiet lie: the honest last word is the last place the
    // data actually put it.
    if (!this.field.inside(lon, lat)) { this._leave(p, i); return; }

    p.lon = lon;
    p.lat = lat;
    p.speed = Math.hypot(b.u, b.v);

    p.sinceTrail += step;
    if (p.sinceTrail >= this.trailStepHours) {
      p.sinceTrail = 0;
      this._pushTrail(p);
    }

    // Arrived. The last trail point is pushed unconditionally so the track ends
    // where the parcel does -- without it the drawn journey stops up to one
    // trail step short of the mast, which is exactly where the eye is looking.
    if (p.age >= p.life) {
      if (this.recycle) { this._respawn(p, i); return; }
      if (p.sinceTrail > 0) this._pushTrail(p);
      p.frozen = true;
    }
  }

  /**
   * A parcel that has run off the grid.
   *
   * Ambient parcels respawn -- they are scenery. A cohort parcel *freezes*
   * rather than vanishing, because a parcel that disappears at the edge tells
   * the audience the air stopped there, which is a lie about the data. It keeps
   * its trail and the drawing fades it.
   */
  _leave(p, i) {
    if (this.recycle) { this._respawn(p, i); return; }
    // Record where it stopped before freezing it. Without this a parcel whose
    // very first step would have left the grid holds a single trail point, and
    // a single point cannot be drawn as a trail -- so the marks nearest the
    // edge, which are exactly the ones the eye is following out of frame, are
    // the ones that disappear.
    this._pushTrail(p);
    p.frozen = true;
  }
}
