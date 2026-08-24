/**
 * The score around the playhead, as a piano roll.
 *
 * Lifted out of sound-lab.js so listen.html can show it under the timeseries.
 * It reads a Sonifier and nothing else -- it does not know about the audio
 * engine, and it never moves the playhead itself. A click reports a step through
 * `onSeek` and the page decides what that means, because the two pages that draw
 * it disagree: the lab seeks its transport, while listen.html has to translate
 * the step back into a row index for the map.
 *
 * Vertical position is pitch and the axis is labelled by region, so region
 * identity survives greyscale and colour blindness -- colour here carries
 * magnitude only.
 */

import { C, RAMPS, sampleRamp } from './palette.js';

const WINDOW = 120; // steps on screen: ten bars, ten days
const MIDI_LO = 22;
const MIDI_HI = 92;
const PAD_L = 62;
const PAD_B = 26;
const PAD_T = 8;

const rgb = (ramp, t) => `rgb(${sampleRamp(ramp, t).join(',')})`;

export class PianoRoll {
  /**
   * @param canvas  the <canvas> to draw into
   * @param score   a Sonifier
   * @param data    the loaded dataset (for `units` in the tooltip)
   * @param onSeek  called with an absolute step when the roll is clicked
   */
  constructor(canvas, score, data, { onSeek = null } = {}) {
    this.canvas = canvas;
    this.cx = canvas.getContext('2d');
    this.score = score;
    this.data = data;
    this.onSeek = onSeek;
    this.cur = 0;
    this.hover = null;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const s = this._stepAtPx(e.clientX - r.left);
      this.hover = s >= 0 && s < score.nSteps && e.clientX - r.left > PAD_L ? s : null;
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const s = this._stepAtPx(e.clientX - r.left);
      if (s < 0 || s >= score.nSteps || !this.onSeek) return;
      this.onSeek(s);
    });

    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    return this;
  }

  /** Move the playhead. Redraws. */
  setStep(step) {
    this.cur = Math.max(0, Math.min(this.score.nSteps - 1, step | 0));
    this.draw();
    return this;
  }

  // ---- geometry ---------------------------------------------------------
  _stepX() { return (this.w - PAD_L - 8) / WINDOW; }

  _midiY(m) {
    return PAD_T + (1 - (m - MIDI_LO) / (MIDI_HI - MIDI_LO)) * (this.h - PAD_T - PAD_B);
  }

  _windowStart() {
    return Math.max(0, Math.min(this.score.nSteps - WINDOW, this.cur - Math.floor(WINDOW / 2)));
  }

  _stepAtPx(px) {
    return Math.round(this._windowStart() + (px - PAD_L) / this._stepX() - 0.5);
  }

  // ---- drawing ----------------------------------------------------------
  draw() {
    if (!this.w) this.resize();
    const { cx: rx, score } = this;
    const s0 = this._windowStart();
    const sw = this._stepX();
    const x = (s) => PAD_L + (s - s0) * sw;
    const last = Math.min(score.nSteps, s0 + WINDOW);

    rx.clearRect(0, 0, this.w, this.h);
    rx.fillStyle = C.surface;
    rx.fillRect(0, 0, this.w, this.h);

    // Region bands, labelled on the axis. This is what carries region identity
    // -- not colour -- so it survives a greyscale print and colour blindness.
    rx.font = '10px system-ui, sans-serif';
    rx.textBaseline = 'middle';
    let shade = false;
    for (const r of score.regionSummary()) {
      if (!r.voice) continue;
      const lo = this._midiY(r.midi[0] - 1.2);
      const hi = this._midiY(r.midi[r.midi.length - 1] + 1.2);
      shade = !shade;
      if (shade) {
        rx.fillStyle = C.page;
        rx.fillRect(PAD_L, hi, this.w - PAD_L - 8, lo - hi);
      }
      rx.fillStyle = C.muted;
      rx.textAlign = 'right';
      rx.fillText(r.id, PAD_L - 8, (lo + hi) / 2);
    }

    // Day lines. Every bar is a day; the label is the date it starts.
    rx.textAlign = 'left';
    const bar = score.opts.stepsPerBar;
    for (let s = s0 - (s0 % bar); s < s0 + WINDOW; s += bar) {
      if (s < 0) continue;
      const px = x(s);
      if (px < PAD_L - 1) continue;
      const ev = score.eventsAt(s);
      // A day the archive is missing gets hatched rather than left blank, so a
      // rest that is a real hole reads differently from a quiet passage.
      if (ev && ev.missing) {
        rx.fillStyle = C.page;
        rx.fillRect(px, PAD_T, sw * bar, this.h - PAD_T - PAD_B);
        rx.strokeStyle = C.grid;
        rx.lineWidth = 1;
        for (let k = -this.h; k < sw * bar; k += 7) {
          rx.beginPath();
          rx.moveTo(px + k, this.h - PAD_B);
          rx.lineTo(px + k + (this.h - PAD_T - PAD_B), PAD_T);
          rx.stroke();
        }
      }
      rx.strokeStyle = C.grid;
      rx.lineWidth = 1;
      rx.beginPath();
      rx.moveTo(Math.round(px) + 0.5, PAD_T);
      rx.lineTo(Math.round(px) + 0.5, this.h - PAD_B);
      rx.stroke();
      rx.fillStyle = C.muted;
      rx.fillText(score.timeAt(s).toUTCString().slice(5, 11), px + 3, this.h - PAD_B + 10);
    }

    // Lanes: the hat/land strip along the bottom, under the notes.
    const hatY = this.h - PAD_B - 5;
    for (let s = s0; s < last; s++) {
      const ev = score.eventsAt(s);
      if (!ev || !ev.hat) continue;
      rx.fillStyle = C.axis;
      const hgt = 2 + ev.hat.norm * 7;
      rx.fillRect(x(s) + sw * 0.25, hatY - hgt, Math.max(1.5, sw * 0.5), hgt);
    }

    // The measurement, in the blue it wears on the chart. Drawn as a stepped
    // line and broken across gaps, because the reading is a series and its
    // nulls are gaps in the record, not zeros.
    rx.strokeStyle = C.obs;
    rx.lineWidth = 2;
    rx.beginPath();
    let open = false;
    for (let s = s0; s < last; s++) {
      const ev = score.eventsAt(s);
      if (!ev || !ev.pad) { open = false; continue; }
      const px = x(s);
      const py = this._midiY(ev.pad.midi);
      if (!open) { rx.moveTo(px, py); open = true; } else { rx.lineTo(px, py); }
      rx.lineTo(px + sw, py);
    }
    rx.stroke();

    // Day tone on the bar line.
    for (let s = s0; s < last; s++) {
      const ev = score.eventsAt(s);
      if (!ev || !ev.bass) continue;
      rx.fillStyle = C.ink2;
      rx.fillRect(x(s), this._midiY(ev.bass.midi) - 1.5, Math.max(3, sw * 2), 3);
    }

    // Plant arrivals. Velocity is a magnitude, so it takes the emissions ramp
    // light to dark -- the same violet family the markers use on the map.
    for (let s = s0; s < last; s++) {
      const ev = score.eventsAt(s);
      if (!ev) continue;
      for (const p of ev.plants) {
        const px = x(s) + sw / 2;
        const py = this._midiY(p.midi);
        const r = 3 + p.velocity * 4;
        rx.fillStyle = rgb(RAMPS.flux, 0.25 + p.velocity * 0.75);
        // A 2px surface ring, so overlapping notes stay countable.
        rx.strokeStyle = C.surface;
        rx.lineWidth = 2;
        rx.beginPath();
        rx.arc(px, py, r, 0, Math.PI * 2);
        rx.fill();
        rx.stroke();
      }
    }

    // Playhead.
    const pxh = x(this.cur);
    rx.strokeStyle = C.ink;
    rx.lineWidth = 1.5;
    rx.beginPath();
    rx.moveTo(Math.round(pxh) + 0.5, PAD_T);
    rx.lineTo(Math.round(pxh) + 0.5, this.h - PAD_B);
    rx.stroke();

    if (this.hover != null) this._drawTip(this.hover, x);
    return this;
  }

  _drawTip(step, x) {
    const { cx: rx, score } = this;
    const ev = score.eventsAt(step);
    if (!ev) return;
    const units = this.data && this.data.units ? this.data.units : '';
    const lines = [`${score.timeAt(step).toUTCString().slice(5, 22)} UTC`];
    if (ev.missing) lines.push('not in the archive');
    else {
      lines.push(ev.pad
        ? `reading ${ev.pad.enh >= 0 ? '+' : ''}${ev.pad.enh.toFixed(2)} ${units} (p${Math.round(ev.pad.rank * 100)})`
        : 'no measurement');
      if (ev.hat) lines.push(`${Math.round(ev.hat.land * 100)}% of footprint over land`);
      if (ev.glow) lines.push(`${ev.glow.count} plant${ev.glow.count > 1 ? 's' : ''} lit`);
      for (const p of ev.plants) {
        lines.push(`• ${p.region} arrives — ${p.voice}, vel ${p.velocity.toFixed(2)}`);
      }
      if (ev.plantsDropped) lines.push(`(${ev.plantsDropped} more capped)`);
    }

    rx.font = '11px system-ui, sans-serif';
    const w = Math.max(...lines.map((l) => rx.measureText(l).width)) + 16;
    const h = lines.length * 14 + 10;
    let bx = x(step) + 10;
    if (bx + w > this.w - 6) bx = x(step) - w - 10;
    const by = Math.min(this.h - PAD_B - h, PAD_T + 6);

    rx.fillStyle = C.surface;
    rx.strokeStyle = C.axis;
    rx.lineWidth = 1;
    rx.beginPath();
    rx.roundRect(bx, by, w, h, 6);
    rx.fill();
    rx.stroke();
    rx.textAlign = 'left';
    rx.textBaseline = 'top';
    lines.forEach((l, i) => {
      rx.fillStyle = i === 0 ? C.ink : C.ink2;
      rx.fillText(l, bx + 8, by + 6 + i * 14);
    });
    rx.textBaseline = 'middle';
  }
}
