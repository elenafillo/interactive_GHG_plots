/**
 * Canvas map: basemap, raster data layers, station marker, and a camera that
 * can fly between framings.
 *
 * Projection is plate carree (linear in lon and lat), matching the grid the
 * footprints live on. That is not a compromise -- it is the reason a timestep
 * costs ~1 ms: because screen space is an affine function of lon/lat, painting a
 * footprint is one putImageData into a small offscreen canvas followed by one
 * scaled drawImage. No reprojection, no per-cell work, no DOM nodes. This is the
 * whole argument against drawing the raster as SVG cells.
 */

import { C, footprintLUT, FLUX_LUT } from './palette.js';

/**
 * Map width that leaves the whole explorer inside the viewport.
 *
 * The map is the only element with give in it: the chart, the controls, the
 * toggles and the legend all have floors set by legible text and tappable
 * buttons. So it absorbs whatever is left over, and ends up narrower than the
 * column it sits in -- which is why the chart beneath it can be wider.
 *
 * Kept as pure arithmetic, separate from the DOM measuring in explore.js, for
 * one reason: the CSS budget this replaces was guesswork about how a paragraph
 * wraps, and guesswork is what wants a test around it.
 *
 * @param {number} viewportH   window.innerHeight
 * @param {number} aboveStage  page offset of the stage -- header plus padding
 * @param {number} stageRows   height of everything in the stage except the map
 * @param {number} aspect      map width / height
 * @param {number} max         usually the column's inner width
 */
export function fitMapWidth({
  viewportH,
  aboveStage,
  stageRows,
  aspect = 1.6,
  min = 300,
  max = 880,
  gap = 18,
}) {
  const avail = viewportH - aboveStage - stageRows - gap;
  return Math.round(Math.max(min, Math.min(max, avail * aspect)));
}

export class MapView {
  constructor(canvas, data) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = data;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Camera: centre plus how many degrees of longitude span the canvas width.
    const v = data.meta.view;
    this.cam = { lon: (v.lonMin + v.lonMax) / 2, lat: (v.latMin + v.latMax) / 2, span: v.lonMax - v.lonMin };
    this.target = { ...this.cam };
    this.ease = 0.085;

    this.layers = { flux: 0, footprint: 1, graticule: 1, station: 1, factories: 0 };
    this.t = 0;
    this.fpLUT = footprintLUT(data.meta);

    // Optional point layer, absent at sites with no plant list. Read once here
    // so draw() never has to walk the meta chain, and so a site without it
    // costs an empty array rather than a null check per frame.
    const f = data.meta.factories;
    this.factories = f && f.points ? f.points : [];

    // Which footprint cell each plant sits in, resolved once. Highlighting a
    // plant with the plume overhead is then 42 typed-array reads per frame,
    // against the 11,628-cell raster paint already happening -- so the state can
    // be recomputed every draw rather than cached and invalidated.
    this.factoryLitCode = f && f.litCode ? f.litCode : Infinity;
    this.factoryCells = this._resolveCells(this.factories);

    // Offscreen buffers sized to the native data grids. Emissions are optional
    // -- Gosan has footprints but no inventory -- so that buffer only exists
    // when there is something to put in it.
    this.fpBuf = this._buffer(data.width, data.height);
    this.fluxBuf = data.flux ? this._buffer(data.flux.width, data.flux.height) : null;
    this._fluxPainted = false;

    this.resize();
  }

  /**
   * Footprint cell index for each [lon, lat], or -1 for points off the grid.
   *
   * Inverts exactly the mapping particles.js uses to turn a cell index back into
   * lon/lat, against the same cell-edge bounds the raster is blitted with. If
   * these two disagree the markers light up over the wrong ground, which is the
   * kind of bug that looks plausible on screen -- hence the round-trip check in
   * selftest.mjs.
   */
  _resolveCells(points) {
    const g = this.data.grid;
    const W = this.data.width;
    const H = this.data.height;
    const out = new Int32Array(points.length).fill(-1);
    for (let i = 0; i < points.length; i++) {
      const [lon, lat] = points[i];
      const col = Math.floor(((lon - g.lonMin) / (g.lonMax - g.lonMin)) * W);
      const row = Math.floor(((g.latMax - lat) / (g.latMax - g.latMin)) * H);
      if (col >= 0 && col < W && row >= 0 && row < H) out[i] = row * W + col;
    }
    return out;
  }

  /**
   * Per-plant "is the plume overhead" flags for timestep t.
   *
   * Public because it is the same answer the readout and the essay will want,
   * and because a threshold that silently never fires is the main risk here --
   * worth being able to assert on.
   */
  factoryLit(t) {
    const frame = this.data.frame(t);
    const code = this.factoryLitCode;
    const out = new Array(this.factoryCells.length).fill(false);
    for (let i = 0; i < this.factoryCells.length; i++) {
      const cell = this.factoryCells[i];
      if (cell >= 0 && frame[cell] >= code) out[i] = true;
    }
    return out;
  }

  _buffer(w, h) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext('2d');
    return { cv, cx, img: cx.createImageData(w, h) };
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // ---- projection -------------------------------------------------------
  get pxPerDeg() {
    return this.w / this.cam.span;
  }
  x(lon) {
    return this.w / 2 + (lon - this.cam.lon) * this.pxPerDeg;
  }
  y(lat) {
    return this.h / 2 - (lat - this.cam.lat) * this.pxPerDeg;
  }
  /** Inverse projection, for hit-testing the map under the pointer. */
  lonLatAt(px, py) {
    return {
      lon: this.cam.lon + (px - this.w / 2) / this.pxPerDeg,
      lat: this.cam.lat - (py - this.h / 2) / this.pxPerDeg,
    };
  }

  // ---- camera -----------------------------------------------------------
  flyTo(view, { instant = false } = {}) {
    Object.assign(this.target, view);
    if (instant) Object.assign(this.cam, this.target);
  }

  /** Advance the camera one frame. Returns true while still moving. */
  stepCamera() {
    let moving = false;
    for (const k of ['lon', 'lat', 'span']) {
      const d = this.target[k] - this.cam[k];
      // Scale-relative threshold, so a 0.01 deg drift at high zoom still settles.
      if (Math.abs(d) > (k === 'span' ? this.cam.span : this.cam.span) * 1e-4) {
        this.cam[k] += d * this.ease;
        moving = true;
      } else {
        this.cam[k] = this.target[k];
      }
    }
    return moving;
  }

  // ---- raster layers ----------------------------------------------------
  _paintRaster(buf, src, lut) {
    const px = buf.img.data;
    for (let i = 0, j = 0; i < src.length; i++, j += 4) {
      const k = src[i] * 4;
      px[j] = lut[k];
      px[j + 1] = lut[k + 1];
      px[j + 2] = lut[k + 2];
      px[j + 3] = lut[k + 3];
    }
    buf.cx.putImageData(buf.img, 0, 0);
  }

  _gridRect(g) {
    const x0 = this.x(g.lonMin);
    const x1 = this.x(g.lonMax);
    const y0 = this.y(g.latMax);
    const y1 = this.y(g.latMin);
    return [x0, y0, x1 - x0, y1 - y0];
  }

  // ---- drawing ----------------------------------------------------------
  draw(extra) {
    const cx = this.ctx;
    const { w, h } = this;

    cx.clearRect(0, 0, w, h);

    // Ocean, with a whisper of depth so the eye reads water before land.
    const g = cx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, C.ocean);
    g.addColorStop(1, C.oceanDeep);
    cx.fillStyle = g;
    cx.fillRect(0, 0, w, h);

    if (this.layers.graticule) this._drawGraticule();
    this._drawLand();

    if (this.layers.flux > 0 && this.fluxBuf) {
      if (!this._fluxPainted) {
        this._paintRaster(this.fluxBuf, this.data.flux.data, FLUX_LUT);
        this._fluxPainted = true;
      }
      cx.save();
      cx.globalAlpha = this.layers.flux;
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(this.fluxBuf.cv, ...this._gridRect(this.data.grid));
      cx.restore();
    }

    if (this.layers.footprint > 0) {
      this._paintRaster(this.fpBuf, this.data.frame(this.t), this.fpLUT);
      cx.save();
      cx.globalAlpha = this.layers.footprint;
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(this.fpBuf.cv, ...this._gridRect(this.data.grid));
      cx.restore();
    }

    this._drawCoast();
    if (this.layers.factories > 0) this._drawFactories(this.layers.factories);
    if (extra) extra(cx, this);
    if (this.layers.station > 0) this._drawStation(this.layers.station);
  }

  _drawGraticule() {
    const cx = this.ctx;
    // Choose a spacing that keeps roughly 5-9 lines on screen at any zoom.
    const steps = [30, 20, 10, 5, 2, 1, 0.5];
    const step = steps.find((s) => this.cam.span / s < 10) ?? 0.5;
    cx.save();
    cx.strokeStyle = 'rgba(11,11,11,0.045)';
    cx.lineWidth = 1;
    cx.beginPath();
    const v = this.data.meta.view;
    for (let lon = Math.ceil(v.lonMin / step) * step; lon <= v.lonMax; lon += step) {
      const px = Math.round(this.x(lon)) + 0.5;
      cx.moveTo(px, 0);
      cx.lineTo(px, this.h);
    }
    for (let lat = Math.ceil(v.latMin / step) * step; lat <= v.latMax; lat += step) {
      const py = Math.round(this.y(lat)) + 0.5;
      cx.moveTo(0, py);
      cx.lineTo(this.w, py);
    }
    cx.stroke();
    cx.restore();
  }

  _drawLand() {
    const cx = this.ctx;
    const polys = this.data.basemap.land || [];
    if (!polys.length) return;
    cx.save();
    cx.fillStyle = C.land;
    for (const rings of polys) {
      cx.beginPath();
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const px = this.x(ring[i][0]);
          const py = this.y(ring[i][1]);
          if (i === 0) cx.moveTo(px, py);
          else cx.lineTo(px, py);
        }
        cx.closePath();
      }
      cx.fill('evenodd');
    }
    cx.restore();
  }

  _strokeLines(lines, style, width) {
    if (!lines || !lines.length) return;
    const cx = this.ctx;
    cx.save();
    cx.strokeStyle = style;
    cx.lineWidth = width;
    cx.lineJoin = 'round';
    cx.lineCap = 'round';
    cx.beginPath();
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const px = this.x(line[i][0]);
        const py = this.y(line[i][1]);
        if (i === 0) cx.moveTo(px, py);
        else cx.lineTo(px, py);
      }
    }
    cx.stroke();
    cx.restore();
  }

  _drawCoast() {
    // Coast and borders share one grey with the marker edges. The hierarchy
    // between them is carried by line weight rather than by colour, so the
    // coastline still reads as the primary boundary.
    this._strokeLines(this.data.basemap.borders, C.mapEdge, 0.8);
    this._strokeLines(this.data.basemap.coast, C.mapEdge, 1.2);
  }

  /**
   * Plants that may vent the species, as point markers, highlighted where the
   * plume is overhead.
   *
   * A diamond rather than a circle so the mark is distinguishable from the
   * station at a glance and without relying on hue -- these sit on top of a
   * saturated orange plume, and several readers will not separate violet from
   * orange by colour alone.
   *
   * Three passes per marker, and each one is doing a job:
   *   1. a surface-coloured outer ring, so the dense Zhejiang cluster separates
   *      into individual plants instead of merging into one blob;
   *   2. a dark grey edge, because the lit yellow is 1.03:1 against the pale end
   *      of the plume ramp -- without an outline a highlighted marker disappears
   *      precisely where the footprint is faint;
   *   3. the fill, violet normally and yellow with the plume overhead.
   * Stroking widest-first and filling last leaves each ring showing as a band,
   * since every pass paints over the inner half of the one before it.
   *
   * Constant pixel size across zoom levels: these are point symbols marking a
   * location, not areas, so growing them with the camera would imply an extent
   * the data does not have.
   */
  _drawFactories(alpha) {
    if (!this.factories.length) return;
    const cx = this.ctx;
    const r = 4.5;
    const lit = this.factoryLit(this.t);
    cx.save();
    cx.globalAlpha = alpha;
    cx.lineJoin = 'round';

    for (let i = 0; i < this.factories.length; i++) {
      const [lon, lat] = this.factories[i];
      const px = this.x(lon);
      const py = this.y(lat);
      // Skip anything off-canvas -- the western Sichuan sites sit just outside
      // the Gosan view box, and the zoomed framing culls most of the list.
      if (px < -r - 3 || px > this.w + r + 3 || py < -r - 3 || py > this.h + r + 3) continue;

      cx.beginPath();
      cx.moveTo(px, py - r);
      cx.lineTo(px + r, py);
      cx.lineTo(px, py + r);
      cx.lineTo(px - r, py);
      cx.closePath();

      cx.strokeStyle = C.surface;
      cx.lineWidth = 4;
      cx.stroke();
      cx.strokeStyle = C.mapEdge;
      cx.lineWidth = 2;
      cx.stroke();
      cx.fillStyle = lit[i] ? C.factoryLit : C.factory;
      cx.fill();
    }
    cx.restore();
  }

  _drawStation(alpha) {
    const cx = this.ctx;
    const s = this.data.meta.station;
    const px = this.x(s.lon);
    const py = this.y(s.lat);
    cx.save();
    cx.globalAlpha = alpha;

    // White halo so the marker survives sitting on a saturated plume core.
    cx.beginPath();
    cx.arc(px, py, 8, 0, Math.PI * 2);
    cx.fillStyle = 'rgba(252,252,251,0.9)';
    cx.fill();

    cx.beginPath();
    cx.arc(px, py, 4.5, 0, Math.PI * 2);
    cx.fillStyle = C.station;
    cx.fill();
    cx.lineWidth = 1.5;
    cx.strokeStyle = C.surface;
    cx.stroke();

    cx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const label = s.id;
    const tw = cx.measureText(label).width;
    cx.fillStyle = 'rgba(252,252,251,0.88)';
    cx.fillRect(px + 9, py - 8, tw + 8, 16);
    cx.fillStyle = C.ink;
    cx.fillText(label, px + 13, py + 4);
    cx.restore();
  }
}
