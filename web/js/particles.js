/**
 * Backward particle dispersion.
 *
 * This is the mechanism behind the footprint, not a metaphor for it. A
 * Lagrangian model (NAME, FLEXPART) releases air parcels at the inlet and runs
 * the wind backwards; where those parcels spend their time upwind *is* the
 * footprint. So the honest way to animate it is to make the particles agree
 * with the data:
 *
 *   - every particle leaves the real station coordinates;
 *   - its destination is drawn from the real footprint field for that timestep,
 *     weighted by the physical sensitivity value, so the cloud that builds up
 *     converges on exactly the footprint the map then paints;
 *   - its opening heading follows the measured wind direction at the station.
 *
 * What is illustrative is the path in between: we have the time-integrated
 * footprint, not the trajectories, so each parcel takes a smooth curve rather
 * than a re-simulated one. Everything the reader is asked to conclude from the
 * picture -- where the air came from, how it fans out, which way it leaves --
 * comes from the data.
 */

export class ParticleField {
  constructor(data, { max = 700, colour = [222, 96, 40] } = {}) {
    this.data = data;
    this.max = max;
    this.colour = colour;
    this.ps = [];
    this._cdfT = -1;
    this._cdf = null;
    this._total = 0;
    this.rate = 22; // particles spawned per second
    this._carry = 0;
  }

  /** Cumulative distribution over footprint cells for timestep t (cached). */
  _ensureCDF(t) {
    if (this._cdfT === t) return;
    const src = this.data.frame(t);
    const n = src.length;
    if (!this._cdf || this._cdf.length !== n) this._cdf = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += this.data.toPhysical(src[i]);
      this._cdf[i] = acc;
    }
    this._total = acc;
    this._cdfT = t;
  }

  _sampleCell() {
    if (!this._total) return null;
    const r = Math.random() * this._total;
    const cdf = this._cdf;
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const g = this.data.grid;
    const W = this.data.width;
    const H = this.data.height;
    const col = lo % W;
    const row = (lo / W) | 0;
    // Jitter within the cell so parcels do not stack on grid centres.
    return {
      lon: g.lonMin + ((col + Math.random()) / W) * (g.lonMax - g.lonMin),
      lat: g.latMax - ((row + Math.random()) / H) * (g.latMax - g.latMin),
    };
  }

  _spawn(t) {
    const dest = this._sampleCell();
    if (!dest) return;
    const s = this.data.meta.station;

    // Meteorological convention: wind_direction is the bearing the air comes
    // FROM, which is exactly where a backward parcel heads first.
    const wd = this.data.series.windDir ? this.data.series.windDir[t] : null;
    const dLon = dest.lon - s.lon;
    const dLat = dest.lat - s.lat;
    const dist = Math.hypot(dLon, dLat) || 1e-6;

    let cx;
    let cy;
    if (wd != null && Number.isFinite(wd)) {
      const rad = (wd * Math.PI) / 180;
      const lead = dist * (0.3 + Math.random() * 0.2);
      cx = s.lon + Math.sin(rad) * lead;
      cy = s.lat + Math.cos(rad) * lead;
    } else {
      cx = s.lon + dLon * 0.5;
      cy = s.lat + dLat * 0.5;
    }
    // A little sideways scatter on the control point gives the bundle width.
    const spread = dist * 0.18 * (Math.random() - 0.5);
    cx += (-dLat / dist) * spread;
    cy += (dLon / dist) * spread;

    this.ps.push({
      x0: s.lon, y0: s.lat, cx, cy, x1: dest.lon, y1: dest.lat,
      age: 0,
      life: 2.0 + Math.random() * 2.2,
      size: 1.4 + Math.random() * 1.4,
    });
  }

  /** Advance by dt seconds at timestep t. */
  update(dt, t) {
    this._ensureCDF(t);
    this._carry += this.rate * dt;
    while (this._carry >= 1 && this.ps.length < this.max) {
      this._carry -= 1;
      this._spawn(t);
    }
    if (this._carry > 1) this._carry = 1;

    for (let i = this.ps.length - 1; i >= 0; i--) {
      this.ps[i].age += dt;
      if (this.ps[i].age >= this.ps[i].life) this.ps.splice(i, 1);
    }
  }

  clear() {
    this.ps.length = 0;
    this._carry = 0;
  }

  /** Position along the parcel's curve at normalised age s. */
  _at(p, s) {
    const u = 1 - s;
    return [
      u * u * p.x0 + 2 * u * s * p.cx + s * s * p.x1,
      u * u * p.y0 + 2 * u * s * p.cy + s * s * p.y1,
    ];
  }

  /** Draw into a MapView's context. */
  draw(cx, map, alpha = 1) {
    if (alpha <= 0 || !this.ps.length) return;
    const [r, g, b] = this.colour;
    cx.save();
    cx.lineCap = 'round';

    for (const p of this.ps) {
      const s = p.age / p.life;
      // Ease out along the path, and fade in at birth / out at death.
      const e = 1 - Math.pow(1 - s, 1.7);
      const fade = Math.min(1, s / 0.12) * Math.min(1, (1 - s) / 0.3);
      const a = fade * alpha;
      if (a <= 0.01) continue;

      const [lon, lat] = this._at(p, e);
      const px = map.x(lon);
      const py = map.y(lat);

      const tailS = Math.max(0, e - 0.07);
      const [tlon, tlat] = this._at(p, tailS);
      cx.strokeStyle = `rgba(${r},${g},${b},${a * 0.42})`;
      cx.lineWidth = p.size * 0.9;
      cx.beginPath();
      cx.moveTo(map.x(tlon), map.y(tlat));
      cx.lineTo(px, py);
      cx.stroke();

      cx.fillStyle = `rgba(${r},${g},${b},${a * 0.85})`;
      cx.beginPath();
      cx.arc(px, py, p.size, 0, Math.PI * 2);
      cx.fill();
    }
    cx.restore();
  }
}
