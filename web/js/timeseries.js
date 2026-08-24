/**
 * CH4 timeseries on canvas.
 *
 * Two series share one axis because they are the same quantity in the same
 * units: what the instrument measured, and what the footprint-times-emissions
 * forward model says it should have measured. That is the point of the chart,
 * and it is also why there is no second y-axis anywhere in this file.
 */

import { C } from './palette.js';
import { formatTime, formatDay } from './data.js';

const PAD = { l: 56, r: 92, t: 26, b: 32 };

export class TimeSeries {
  constructor(canvas, data, { onScrub = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = data;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.n = data.series.timeMs.length;
    this.window = [0, this.n - 1];
    this.cursor = 0;
    this.alpha = { obs: 1, model: 0 };
    this.readSpecies();
    this.bands = [];
    this.hover = null;
    this.onScrub = onScrub;

    this._bindPointer();
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  get iw() { return this.w - PAD.l - PAD.r; }
  get ih() { return this.h - PAD.t - PAD.b; }

  _yRange() {
    const [a, b] = this.window;
    let lo = Infinity;
    let hi = -Infinity;
    const seen = (v) => {
      if (v == null || !Number.isFinite(v)) return;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    for (let i = a; i <= b; i++) {
      seen(this.obs[i]);
      if (this.model && this.alpha.model > 0.01) seen(this.model[i]);
    }
    if (!Number.isFinite(lo)) return [0, 1];
    const pad = (hi - lo) * 0.12 || Math.max(1, Math.abs(hi) * 0.05);
    return [lo - pad, hi + pad];
  }

  X(i) {
    const [a, b] = this.window;
    return PAD.l + ((i - a) / Math.max(1, b - a)) * this.iw;
  }
  Y(v) {
    const [lo, hi] = this._yr;
    return PAD.t + (1 - (v - lo) / (hi - lo)) * this.ih;
  }
  iAt(px) {
    const [a, b] = this.window;
    const f = (px - PAD.l) / this.iw;
    return Math.max(a, Math.min(b, Math.round(a + f * (b - a))));
  }

  _bindPointer() {
    const move = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const py = ev.clientY - r.top;
      if (px < PAD.l - 12 || px > this.w - PAD.r + 12 || py < 0 || py > this.h) {
        if (this.hover !== null) { this.hover = null; this.draw(); }
        return;
      }
      this.hover = this.iAt(px);
      this.draw();
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    this.canvas.addEventListener('pointerdown', (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const i = this.iAt(ev.clientX - r.left);
      if (this.onScrub) this.onScrub(i);
    });
  }

  /**
   * Pull the active species' arrays off the dataset.
   *
   * Gaps arrive as null (the instrument was not reporting) and stay null all
   * the way to the canvas, where they break the line rather than being
   * interpolated across. A record with 38% coverage must look like one.
   */
  readSpecies() {
    const c = this.data.current;
    this.obs = c.obs || [];
    this.baseline = c.baseline ?? 0;
    this.model = c.modelled
      ? c.modelled.map((m) => (m == null ? null : m + this.baseline))
      : null;
    this.hasModel = !!this.model;
    if (!this.hasModel) this.alpha.model = 0;
    return this;
  }

  setSpecies(key) {
    this.data.setSpecies(key);
    return this.readSpecies();
  }

  setWindow(a, b) { this.window = [Math.max(0, a), Math.min(this.n - 1, b)]; return this; }
  setCursor(t) { this.cursor = t; return this; }
  setAlpha(a) { Object.assign(this.alpha, a); return this; }
  setBands(bands) { this.bands = bands || []; return this; }

  draw() {
    const cx = this.ctx;
    this._yr = this._yRange();
    cx.clearRect(0, 0, this.w, this.h);

    this._drawBands();
    this._drawGrid();
    if (this.alpha.model > 0.01) this._drawLine(this.model, C.model, this.alpha.model);
    this._drawLine(this.obs, C.obs, this.alpha.obs);
    this._drawCursor();
    this._drawLegend();
    this._drawHover();
  }

  _drawBands() {
    const cx = this.ctx;
    for (const b of this.bands) {
      const x0 = this.X(b.from);
      const x1 = this.X(b.to);
      cx.fillStyle = b.fill || 'rgba(11,11,11,0.035)';
      cx.fillRect(x0, PAD.t, x1 - x0, this.ih);
      if (b.label) {
        cx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
        cx.fillStyle = C.ink2;
        cx.textAlign = 'center';
        cx.fillText(b.label, (x0 + x1) / 2, PAD.t + 14);
        cx.textAlign = 'left';
      }
    }
  }

  _drawGrid() {
    const cx = this.ctx;
    const [lo, hi] = this._yr;
    cx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    cx.strokeStyle = C.grid;
    cx.fillStyle = C.muted;
    cx.lineWidth = 1;

    const span = hi - lo;
    const raw = span / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;

    cx.textAlign = 'right';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const py = Math.round(this.Y(v)) + 0.5;
      cx.beginPath();
      cx.moveTo(PAD.l, py);
      cx.lineTo(this.w - PAD.r, py);
      cx.stroke();
      cx.fillText(Math.round(v), PAD.l - 10, py + 4);
    }
    cx.textAlign = 'left';
    cx.fillText(this.data.units, PAD.l - 46, PAD.t - 10);

    // Date ticks roughly every four days, whatever the window or time step.
    const [a, b] = this.window;
    const hours = this.data.meta.timeStepHours || 1;
    const hoursShown = (b - a) * hours;
    const dayStep = [1, 2, 4, 7, 14].find((d) => hoursShown / (24 * d) <= 9) ?? 30;
    const stride = Math.max(1, Math.round((24 * dayStep) / hours));
    cx.strokeStyle = C.axis;
    cx.beginPath();
    cx.moveTo(PAD.l, PAD.t + this.ih + 0.5);
    cx.lineTo(this.w - PAD.r, PAD.t + this.ih + 0.5);
    cx.stroke();
    cx.fillStyle = C.muted;
    cx.textAlign = 'center';
    for (let i = a; i <= b; i += stride) {
      cx.fillText(formatDay(this.data.time(i)), this.X(i), this.h - 12);
    }
    cx.textAlign = 'left';
  }

  _drawLine(arr, colour, alpha) {
    if (alpha <= 0.01 || !arr) return;
    const cx = this.ctx;
    const [a, b] = this.window;
    cx.save();
    cx.globalAlpha = alpha;
    cx.strokeStyle = colour;
    cx.lineWidth = 2;
    cx.lineJoin = 'round';
    cx.lineCap = 'round';

    // Split into runs of consecutive present values: each run strokes as its
    // own polyline, so a gap in the record shows as a gap rather than a
    // straight line drawn across it.
    const runs = [];
    let run = null;
    for (let i = a; i <= b; i++) {
      const v = arr[i];
      if (v == null || !Number.isFinite(v)) {
        run = null;
        continue;
      }
      if (!run) runs.push((run = []));
      run.push([this.X(i), this.Y(v)]);
    }

    cx.beginPath();
    for (const r of runs) {
      if (r.length < 2) continue;
      cx.moveTo(r[0][0], r[0][1]);
      for (let k = 1; k < r.length; k++) cx.lineTo(r[k][0], r[k][1]);
    }
    cx.stroke();

    // An isolated sample has no segment to stroke, so mark it with a dot.
    cx.fillStyle = colour;
    for (const r of runs) {
      if (r.length !== 1) continue;
      cx.beginPath();
      cx.arc(r[0][0], r[0][1], 1.6, 0, Math.PI * 2);
      cx.fill();
    }
    cx.restore();
  }

  _drawCursor() {
    const cx = this.ctx;
    const [a, b] = this.window;
    const t = this.cursor;
    if (t < a || t > b) return;

    const px = this.X(t);
    cx.save();
    cx.strokeStyle = 'rgba(11,11,11,0.22)';
    cx.setLineDash([3, 4]);
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(px, PAD.t);
    cx.lineTo(px, PAD.t + this.ih);
    cx.stroke();
    cx.setLineDash([]);

    const ok = (v) => v != null && Number.isFinite(v);
    const marks = [[this.obs[t], C.obs, this.alpha.obs]];
    if (this.model && this.alpha.model > 0.01) marks.push([this.model[t], C.model, this.alpha.model]);
    for (const [v, colour, alpha] of marks) {
      if (!ok(v)) continue;
      cx.globalAlpha = alpha;
      cx.beginPath();
      cx.arc(px, this.Y(v), 5, 0, Math.PI * 2);
      cx.fillStyle = colour;
      cx.fill();
      // 2px surface ring keeps the dot legible where the lines cross.
      cx.lineWidth = 2;
      cx.strokeStyle = C.surface;
      cx.stroke();
    }
    cx.globalAlpha = 1;

    // One direct label, on the cursor only -- never a number on every point.
    cx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    cx.textAlign = 'center';
    if (ok(this.obs[t])) {
      cx.fillStyle = C.ink;
      cx.fillText(`${Math.round(this.obs[t])}`, px, Math.max(PAD.t + 12, this.Y(this.obs[t]) - 14));
    } else {
      cx.fillStyle = C.muted;
      cx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      cx.fillText('no measurement', px, PAD.t + 12);
    }
    cx.textAlign = 'left';
    cx.restore();
  }

  /** Y of the last present value in the window, for placing an end label. */
  _lastY(arr, fallback) {
    for (let i = this.window[1]; i >= this.window[0]; i--) {
      const v = arr && arr[i];
      if (v != null && Number.isFinite(v)) return this.Y(v);
    }
    return fallback;
  }

  _drawLegend() {
    const cx = this.ctx;
    const label = `${this.data.speciesLabel} observed`;
    const showModel = this.model && this.alpha.model > 0.01;

    cx.save();
    cx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    if (!showModel) {
      // A single series needs no legend box; the direct label names it.
      if (this.alpha.obs > 0.01) {
        cx.globalAlpha = this.alpha.obs;
        cx.fillStyle = C.obs;
        cx.fillText(label, this.w - PAD.r + 10, this._lastY(this.obs, PAD.t + this.ih / 2) + 4);
      }
      cx.restore();
      return;
    }

    cx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    let oy = this._lastY(this.obs, PAD.t + this.ih * 0.4);
    let my = this._lastY(this.model, PAD.t + this.ih * 0.6);
    // Nudge apart if the two line ends land on top of each other.
    if (Math.abs(oy - my) < 16) {
      const mid = (oy + my) / 2;
      oy = mid - 9;
      my = mid + 9;
    }
    for (const [text, colour, alpha, ly] of [
      [label, C.obs, this.alpha.obs, oy],
      ['modelled', C.model, this.alpha.model, my],
    ]) {
      cx.globalAlpha = alpha;
      cx.fillStyle = colour;
      cx.fillRect(this.w - PAD.r + 10, ly - 8, 9, 3);
      cx.fillStyle = C.ink2;
      cx.fillText(text, this.w - PAD.r + 24, ly - 3);
    }
    cx.restore();
  }

  _drawHover() {
    const i = this.hover;
    if (i == null) return;
    const cx = this.ctx;
    const px = this.X(i);
    cx.save();
    cx.strokeStyle = 'rgba(11,11,11,0.32)';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(px, PAD.t);
    cx.lineTo(px, PAD.t + this.ih);
    cx.stroke();

    const u = this.data.units;
    const fmt = (v) => (v == null || !Number.isFinite(v) ? 'no measurement' : `${v.toFixed(1)} ${u}`);
    const lines = [formatTime(this.data.time(i)), `observed  ${fmt(this.obs[i])}`];
    if (this.model && this.alpha.model > 0.01) lines.push(`modelled  ${fmt(this.model[i])}`);

    cx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const wBox = Math.max(...lines.map((l) => cx.measureText(l).width)) + 20;
    const hBox = lines.length * 17 + 12;
    let bx = px + 12;
    if (bx + wBox > this.w - 4) bx = px - wBox - 12;
    const by = PAD.t + 6;

    cx.fillStyle = 'rgba(252,252,251,0.97)';
    cx.strokeStyle = C.hairline;
    cx.lineWidth = 1;
    cx.beginPath();
    cx.roundRect(bx, by, wBox, hBox, 6);
    cx.fill();
    cx.stroke();

    cx.fillStyle = C.ink;
    lines.forEach((l, k) => {
      cx.fillStyle = k === 0 ? C.ink : k === 1 ? C.obs : C.model;
      cx.fillText(l, bx + 10, by + 20 + k * 17);
    });
    cx.restore();
  }
}
