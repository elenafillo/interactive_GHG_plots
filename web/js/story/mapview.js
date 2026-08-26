/**
 * Canvas map for the story deck.
 *
 * A FORK of ../mapview.js, deliberately. The explorer is a working tool and the
 * deck needs changes inside draw() -- new layers at specific points in the paint
 * order -- so subclassing would mean overriding draw() and copying its body
 * anyway. Forking keeps ../mapview.js byte-identical and explore.html provably
 * unaffected.
 *
 * Divergences from the original, all of them additive:
 *   - _drawGraticule() picks a spacing that actually yields lines when the
 *     camera is zoomed in past a degree or two (the deck opens on Bristol).
 *   - layers.cities / layers.contribution, both Part 2, stubbed here so the
 *     paint order is settled and the deck can switch them on without a rewrite.
 *   - layers.fluxHi / srcFarming / srcWaste / srcFossil -- the sources card's
 *     0.1 deg emissions rasters. These are the one place the deck draws data on
 *     a grid other than the footprint's, which _gridRect already supports since
 *     it takes the grid as an argument.
 *
 * Everything below this banner is the original file's behaviour.
 *
 * ---
 *
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

// One directory down from the original, so these reach back up. palette.js is
// imported read-only and unmodified -- the explorer and the deck share it.
import { C, footprintLUT, FLUX_LUT, fluxLUT, sourceDisplayFor, buildSourceLUTs } from '../palette.js';

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

    // `cities` and `contribution` are Part 2. They are declared here so the
    // paint order in draw() is settled now and switching them on later is a data
    // change rather than a restructure -- and so a stop that names them does not
    // silently do nothing.
    this.layers = {
      flux: 0, footprint: 1, graticule: 1, station: 1, factories: 0,
      cities: 0, contribution: 0,
      // The sources card: the 0.1 deg total, then one per family. Independent
      // alphas rather than a single "which group" selector, so stepping through
      // them one at a time and cross-fading or stacking them are the same
      // mechanism -- the choice lives in beats.js, not here.
      fluxHi: 0, srcFarming: 0, srcWaste: 0, srcFossil: 0,
    };
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

    // The coarse map's ramp. `fluxLUT` hands back the shared `FLUX_LUT` itself
    // for a gas with no window of its own, which is both the right default and
    // the test below: identity, not equality.
    this.fluxLUT = fluxLUT(data.meta.flux);
    this.fluxTunable = this.fluxLUT !== FLUX_LUT;

    // Hi-res source rasters. Static for the whole deck, so each is painted into
    // its buffer once on first use and then is a drawImage per frame -- the same
    // bargain flux.png already makes, which is what lets four of them coexist at
    // eight times the cell count without costing anything per frame.
    // Draw the 0.1 deg cells as cells, not as a smooth field.
    //
    // Bilinear upscaling is right for the footprint, which really is a
    // continuous sensitivity field sampled onto a grid. It is wrong here.
    // Emissions are not continuous: a landfill is in one 11 km box and not the
    // one beside it, and smoothing invents a gradient across a boundary the
    // inventory is actually asserting. It also quietly oversells the data, which
    // on the one card whose whole line is "this is a guess" is the wrong way to
    // be wrong. At the card's span of 24 deg a cell lands at roughly 8 px, so
    // the squares read as squares.
    //
    // Applies to every emissions raster -- these four and the coarse `flux.png`
    // below, which is the same kind of claim on a coarser grid. The **footprint**
    // keeps its smoothing: that one really is a continuous sensitivity field
    // sampled onto a grid, so interpolating between cells is honest there and
    // nowhere else. `G` toggles it live, which is the quickest way to compare
    // the two on a real screen.
    this.crispSources = true;
    this.srcLayers = { fluxHi: 'total', srcFarming: 'farming', srcWaste: 'waste', srcFossil: 'fossil' };
    this.srcBufs = {};
    this.srcGrid = data.fluxHiresGrid || null;
    for (const [layer, key] of Object.entries(this.srcLayers)) {
      const img = data.fluxHires && data.fluxHires[key];
      this.srcBufs[layer] = img ? { buf: this._buffer(img.width, img.height), img, key, painted: false } : null;
    }
    // Which raster the contrast panel is for: the sources card where there is
    // one, and otherwise the coarse map, which on the CFC-11 deck is the only
    // emissions raster there is. Both other decks keep the card and are
    // untouched by the fallback.
    this.sourceDisplay = sourceDisplayFor(data.meta.fluxHires || data.meta.flux);
    this.srcLUTs = data.meta.fluxHires
      ? buildSourceLUTs(data.meta.fluxHires, this.sourceDisplay) : {};

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

  /**
   * Retune the emissions contrast, and repaint.
   *
   * The buffers are painted once and cached, so changing the window has to
   * invalidate them -- otherwise the numbers move and the map does not, which
   * looks exactly like the control being broken.
   *
   * Two rasters can be on the other end of this: the sources card where a deck
   * has one, and the coarse map where the gas has a window of its own. Never
   * both -- a deck with a card tunes the card, and Ridge Hill's coarse methane
   * map keeps the fixed ramp it has always had.
   *
   * @param {object} d  partial {floor, ceil, gamma}
   */
  setSourceDisplay(d) {
    this.sourceDisplay = { ...this.sourceDisplay, ...d };
    if (this.fluxTunable) {
      this.fluxLUT = fluxLUT(this.data.meta.flux, this.sourceDisplay);
      this._fluxPainted = false;
    }
    if (!this.data.meta.fluxHires) return this.sourceDisplay;
    this.srcLUTs = buildSourceLUTs(this.data.meta.fluxHires, this.sourceDisplay);
    for (const slot of Object.values(this.srcBufs)) if (slot) slot.painted = false;
    return this.sourceDisplay;
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
    // Cities sit on the land and under every data layer: they are geography the
    // reader uses to locate a plume, not a quantity competing with one.
    if (this.layers.cities > 0) this._drawCities(this.layers.cities);

    // Hi-res emissions, under the coarse flux and the footprint. Drawn in a
    // fixed order rather than the order the beat happens to list them, so
    // stacked families composite the same way every time.
    for (const layer of ['fluxHi', 'srcFarming', 'srcWaste', 'srcFossil']) {
      const alpha = this.layers[layer];
      const slot = this.srcBufs[layer];
      if (!(alpha > 0) || !slot || !this.srcGrid) continue;
      if (!slot.painted) {
        this._paintRaster(slot.buf, slot.img.data, this.srcLUTs[slot.key]);
        slot.painted = true;
      }
      cx.save();
      cx.globalAlpha = alpha;
      cx.imageSmoothingEnabled = !this.crispSources;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(slot.buf.cv, ...this._gridRect(this.srcGrid));
      cx.restore();
    }

    if (this.layers.flux > 0 && this.fluxBuf) {
      if (!this._fluxPainted) {
        this._paintRaster(this.fluxBuf, this.data.flux.data, this.fluxLUT);
        this._fluxPainted = true;
      }
      cx.save();
      cx.globalAlpha = this.layers.flux;
      // Cells, not a smooth field -- `crispSources`, the same switch the hi-res
      // rasters take, so `G` means one thing for every emissions layer on the
      // deck. Smoothing a guess is the wrong way to be wrong: bilinear
      // upscaling invents a gradient across a boundary the map is asserting,
      // and it makes an 11 km guess look like a measurement. This layer is the
      // only place a coarse emissions map is drawn in any deck, so nothing else
      // moves with it.
      cx.imageSmoothingEnabled = !this.crispSources;
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

  /**
   * Built-up areas, as filled polygons. Part 2.
   *
   * A no-op until `export_basemap()` writes a `cities` layer, and deliberately
   * not a throw: the deck must run today against the basemap.json that is
   * already on disk, which has no such key. Same contract as the optional flux
   * and factory layers -- absent data means the layer draws nothing, never that
   * the page stops.
   */
  _drawCities(alpha) {
    const polys = (this.data.basemap && this.data.basemap.cities) || [];
    if (!polys.length) return;
    const cx = this.ctx;
    cx.save();
    cx.globalAlpha = alpha;
    cx.fillStyle = C.city || 'rgba(11,11,11,0.10)';
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

  _drawGraticule() {
    const cx = this.ctx;
    // Choose a spacing that keeps roughly 4-10 lines on screen at any zoom.
    //
    // The question is "how many lines does this spacing give me", so the test has
    // to be span/step >= 4. The original's span/step < 10 is satisfied by the
    // first entry at every zoom level, so it always returned 30 degrees -- fine
    // at the explorer's fixed wide framing, invisible at the deck's Bristol
    // opener (span 1.2). The list runs coarse-to-fine, so the first entry giving
    // four lines is also the coarsest one that does.
    const steps = [30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05];
    const step = steps.find((s) => this.cam.span / s >= 4) ?? 0.05;
    cx.save();
    cx.strokeStyle = 'rgba(11,11,11,0.045)';
    cx.lineWidth = 1;
    cx.beginPath();
    // Bound the loop to what is actually on screen, intersected with the domain.
    // The original walks the whole view box, which is free at a fixed wide
    // framing but would draw ~900 mostly-offscreen lines once the step drops to
    // 0.05 degrees at the deck's closest zoom.
    const v = this.data.meta.view;
    const tl = this.lonLatAt(0, 0);
    const br = this.lonLatAt(this.w, this.h);
    const lon0 = Math.max(v.lonMin, tl.lon);
    const lon1 = Math.min(v.lonMax, br.lon);
    const lat0 = Math.max(v.latMin, br.lat);
    const lat1 = Math.min(v.latMax, tl.lat);

    for (let lon = Math.ceil(lon0 / step) * step; lon <= lon1; lon += step) {
      const px = Math.round(this.x(lon)) + 0.5;
      cx.moveTo(px, 0);
      cx.lineTo(px, this.h);
    }
    for (let lat = Math.ceil(lat0 / step) * step; lat <= lat1; lat += step) {
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
