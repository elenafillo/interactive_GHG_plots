/**
 * What the red air actually lands on, measured against the shipped export.
 *
 *   node scripts/measure_seeding.mjs
 *
 * `web/js/story/selftest.mjs` checks the seeding against synthetic fields,
 * which can only ever confirm the code agrees with itself. This decodes the
 * real atlases -- with node's own zlib, so there is no dependency to install --
 * and asks the questions the design actually rests on. Every number quoted in
 * `RELEASES` (beats.js) and `PLUME_GATE` (wind.js) comes from a run of this.
 *
 * What it prints, in order:
 *
 *   1. how much of a back-track lies inside the *drawn* plume, at several
 *      thresholds, and how much of the drawn plume the tracks come near;
 *   2. where along a track the red runs out, in two-hour bins;
 *   3. whether a journey starting in the red stays in it all the way home,
 *      which is what decides whether air can be culled for leaving;
 *   4. a sweep of the two fan knobs -- the arrival spread and the jitter disc
 *      -- against both of those, which is what set them;
 *   5. the receptor's own neighbourhood, which is where the surprise was: on
 *      the clean day the drawn plume is **one grid cell tall** at the mast;
 *   6. which way each day's tracks run, and how far back they must go to reach
 *      the continent;
 *   7. the real `WindLayer`, driven exactly as the deck drives it, reporting
 *      the bearing of its seeds and its parcels. This is what caught the dirty
 *      day drawing the clean day's fan.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The anchors come from the deck, not from literals. They were hard-coded as
// 36 and 152 until the dirty day moved to 153, at which point this measured an
// hour the deck no longer shows -- while still printing "dirty".
import { FRAMES } from '../web/js/story/beats.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'web/data-rgl');

// ---- a minimal PNG reader: 8-bit grey or RGB/RGBA, no interlace ----------
function readPNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let w = 0; let h = 0; let depth = 0; let colour = 0;
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
  const out = new Uint8Array(w * h);          // first channel only
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

/** Atlas tiles back into one linear array per frame, as data.js does. */
function unpack(img, atlas, nTime) {
  const { cols, tileW: tw, tileH: th } = atlas;
  const cells = tw * th;
  const out = new Uint8Array(nTime * cells);
  for (let t = 0; t < nTime; t++) {
    const cx = (t % cols) * tw;
    const cy = Math.floor(t / cols) * th;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        out[t * cells + y * tw + x] = img.data[(cy + y) * img.width + cx + x];
      }
    }
  }
  return out;
}

const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
const { WindField } = await import('file:///' + path.join(ROOT, 'web/js/wind.js'));
const { buildFan, kmBetween } = await import('file:///' + path.join(ROOT, 'web/js/advect.js'));
const { footprintLUT } = await import('file:///' + path.join(ROOT, 'web/js/palette.js'));

const fp = unpack(readPNG(path.join(DATA, 'fp_atlas.png')), meta.footprint.atlas, meta.footprint.nTime);
const wu = unpack(readPNG(path.join(DATA, 'wind_u.png')), meta.wind.atlas, meta.wind.nTime);
const wv = unpack(readPNG(path.join(DATA, 'wind_v.png')), meta.wind.atlas, meta.wind.nTime);
const field = new WindField(meta.wind, wu, wv);
const lut = footprintLUT(meta);

const g = meta.footprint.grid;
const NX = meta.footprint.atlas.tileW;
const NY = meta.footprint.atlas.tileH;
const cells = NX * NY;

const codeAt = (t, lon, lat) => {
  const j = Math.floor(((lon - g.lonMin) / (g.lonMax - g.lonMin)) * NX);
  const i = Math.floor(((g.latMax - lat) / (g.latMax - g.latMin)) * NY);
  if (i < 0 || i >= NY || j < 0 || j >= NX) return 0;
  return fp[t * cells + i * NX + j];
};
const alphaAt = (t, lon, lat) => lut[codeAt(t, lon, lat) * 4 + 3] / 255;

const st = meta.station;
const pct = (xs, q) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

for (const [name, anchor, hours] of [['clean', FRAMES.clean, 12], ['dirty', FRAMES.dirty, 12], ['clean-24h', FRAMES.clean, 24]]) {
  const fan = buildFan(field, {
    lon: st.lon, lat: st.lat, anchor, hours, arrivals: hours, count: 24, jitterKm: 15,
  });
  const alphas = [];
  const codes = [];
  let len = 0;
  const lenAbove = {};
  const gates = [0.15, 0.25, 0.35, 0.45, 0.55];
  for (const gate of gates) lenAbove[gate] = 0;
  for (const { track } of fan) {
    for (let k = 1; k < track.length; k++) {
      const p = track[k];
      const a = alphaAt(anchor, p.lon, p.lat);
      const d = kmBetween(track[k - 1].lon, track[k - 1].lat, p.lon, p.lat);
      alphas.push(a);
      codes.push(codeAt(anchor, p.lon, p.lat));
      len += d;
      for (const gate of gates) if (a >= gate) lenAbove[gate] += d;
    }
  }

  // What the audience sees: cells drawn with any real opacity.
  const drawn = [];
  for (let i = 0; i < NY; i++) {
    for (let j = 0; j < NX; j++) {
      const c = fp[anchor * cells + i * NX + j];
      if (lut[c * 4 + 3] / 255 < 0.35) continue;
      drawn.push([
        g.lonMin + ((j + 0.5) / NX) * (g.lonMax - g.lonMin),
        g.latMax - ((i + 0.5) / NY) * (g.latMax - g.latMin),
      ]);
    }
  }
  let near = 0;
  for (const [lon, lat] of drawn) {
    let best = 1e9;
    for (const { track } of fan) {
      for (const p of track) {
        const d = kmBetween(lon, lat, p.lon, p.lat);
        if (d < best) best = d;
        if (best < 60) break;
      }
      if (best < 60) break;
    }
    if (best < 60) near++;
  }

  console.log(`\n=== ${name}  (t=${anchor}, ${hours} h back, ${fan.length} tracks) ===`);
  console.log(`  track length          ${len.toFixed(0)} km over ${alphas.length} points`);
  console.log(`  drawn alpha on track  p10 ${pct(alphas, 0.1).toFixed(2)}  median ${pct(alphas, 0.5).toFixed(2)}  p90 ${pct(alphas, 0.9).toFixed(2)}`);
  console.log(`  uint8 code on track   p10 ${pct(codes, 0.1)}  median ${pct(codes, 0.5)}  p90 ${pct(codes, 0.9)}`);
  for (const gate of gates) {
    console.log(`  track inside alpha>=${gate}   ${(100 * lenAbove[gate] / len).toFixed(1)}%  (spill ${(100 - 100 * lenAbove[gate] / len).toFixed(1)}%)`);
  }
  console.log(`  drawn plume (alpha>=0.35) ${drawn.length} cells; within 60 km of a track: ${(100 * near / drawn.length).toFixed(1)}%`);
}

// Where along a track the red runs out -- which decides `hours`, because a gate
// that leaves seeds only in the last two hours is not "throughout the plume".
for (const [name, anchor] of [['clean', FRAMES.clean], ['dirty', FRAMES.dirty]]) {
  const fan = buildFan(field, {
    lon: st.lon, lat: st.lat, anchor, hours: 24, arrivals: 12, count: 24, jitterKm: 15,
  });
  const bins = new Array(12).fill(0);
  const tot = new Array(12).fill(0);
  for (const { track } of fan) {
    for (let k = 1; k < track.length; k++) {
      const b = Math.min(11, Math.floor(track[k].hours / 2));
      tot[b]++;
      if (alphaAt(anchor, track[k].lon, track[k].lat) >= 0.35) bins[b]++;
    }
  }
  console.log(`\n${name}: share of track inside the red, by hours back from the mast`);
  console.log('  ' + bins.map((v, i) => `${i * 2}-${i * 2 + 2}h ${tot[i] ? Math.round(100 * v / tot[i]) : 0}%`).join('  '));
}

// Does a forward journey from a red seed stay red to the mast, or weave in and
// out? If it weaves, culling forward parcels would kill them mid-journey and
// the arrival -- the payoff of the slide -- would stop happening.
for (const [name, anchor, hours] of [['clean', FRAMES.clean, 12], ['dirty', FRAMES.dirty, 12]]) {
  const fan = buildFan(field, {
    lon: st.lon, lat: st.lat, anchor, hours, arrivals: hours, count: 24, jitterKm: 15,
  });
  let seeds = 0; let clean = 0; const firstBreak = [];
  for (const { track } of fan) {
    for (let k = 1; k < track.length; k++) {
      if (alphaAt(anchor, track[k].lon, track[k].lat) < 0.35) continue;
      seeds++;
      // Fly home: indices k-1 .. 0 are the rest of the journey.
      let broke = -1;
      for (let j = k - 1; j >= 0; j--) {
        if (alphaAt(anchor, track[j].lon, track[j].lat) < 0.35) { broke = track[k].hours - track[j].hours; break; }
      }
      if (broke < 0) clean++; else firstBreak.push(broke / Math.max(1e-6, track[k].hours));
    }
  }
  const med = firstBreak.length ? firstBreak.slice().sort((a, b) => a - b)[firstBreak.length >> 1] : 1;
  console.log(`\n${name}: of ${seeds} red seeds, ${(100 * clean / seeds).toFixed(1)}% fly home without leaving the red`);
  console.log(`  the rest break a median ${(100 * med).toFixed(0)}% of the way along their journey`);
}

// One track, printed, because "breaks 83% of the way home" is surprising: the
// footprint should be brightest at the receptor.
{
  const fan = buildFan(field, {
    lon: st.lon, lat: st.lat, anchor: FRAMES.clean, hours: 12, arrivals: 12, count: 24, jitterKm: 15,
  });
  for (const idx of [0, 12, 23]) {
    const { track } = fan[idx];
    console.log(`\ntrack ${idx}: alpha from the mast outwards`);
    console.log('  ' + track.filter((_, k) => k % 4 === 0).map((p) => `${p.hours.toFixed(0)}h:${alphaAt(36, p.lon, p.lat).toFixed(2)}`).join(' '));
  }
}

// Sanity: the receptor cell and its neighbours at the clean hour.
{
  const dLon = (g.lonMax - g.lonMin) / NX;
  const dLat = (g.latMax - g.latMin) / NY;
  console.log(`\ncell size ${dLon.toFixed(3)} x ${dLat.toFixed(3)} deg; mast ${st.lon.toFixed(2)}, ${st.lat.toFixed(2)}`);
  for (let di = -2; di <= 2; di++) {
    const row = [];
    for (let dj = -2; dj <= 2; dj++) {
      row.push(codeAt(36, st.lon + dj * dLon, st.lat - di * dLat).toString().padStart(4));
    }
    console.log('  ' + row.join(''));
  }
  console.log(`  alpha at the mast itself: ${alphaAt(36, st.lon, st.lat).toFixed(2)}`);
}

// The clean day's patch is one cell tall near the mast, so how tightly the fan
// is drawn decides everything. Sweep the two knobs that set its width.
console.log('\n  jit  arr | inside  home-clean  seeds  reach(60km)');
for (const anchor of [FRAMES.clean]) {
  for (const jitterKm of [3, 6, 10, 15]) {
    for (const arrivals of [2, 4, 8, 12]) {
      const fan = buildFan(field, {
        lon: st.lon, lat: st.lat, anchor, hours: 12, arrivals, count: 24, jitterKm,
      });
      let len = 0; let inside = 0; let seeds = 0; let clean = 0;
      for (const { track } of fan) {
        for (let k = 1; k < track.length; k++) {
          const d = kmBetween(track[k - 1].lon, track[k - 1].lat, track[k].lon, track[k].lat);
          len += d;
          const red = alphaAt(anchor, track[k].lon, track[k].lat) >= 0.35;
          if (red) {
            inside += d; seeds++;
            let ok = true;
            for (let j = k - 1; j >= 0; j--) {
              if (alphaAt(anchor, track[j].lon, track[j].lat) < 0.35) { ok = false; break; }
            }
            if (ok) clean++;
          }
        }
      }
      const drawn = [];
      for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
        if (lut[fp[anchor * cells + i * NX + j] * 4 + 3] / 255 >= 0.35) {
          drawn.push([g.lonMin + ((j + 0.5) / NX) * (g.lonMax - g.lonMin),
            g.latMax - ((i + 0.5) / NY) * (g.latMax - g.latMin)]);
        }
      }
      let near = 0;
      for (const [lo, la] of drawn) {
        let hit = false;
        for (const { track } of fan) { for (const p of track) { if (kmBetween(lo, la, p.lon, p.lat) < 60) { hit = true; break; } } if (hit) break; }
        if (hit) near++;
      }
      console.log(`  ${String(jitterKm).padStart(3)} ${String(arrivals).padStart(4)} | ${(100 * inside / len).toFixed(0).padStart(5)}% ${(100 * clean / Math.max(1, seeds)).toFixed(0).padStart(10)}% ${String(seeds).padStart(6)} ${(100 * near / drawn.length).toFixed(0).padStart(9)}%`);
    }
  }
}

// Which way do the dirty day's tracks actually go, and how far back must they
// run to reach the continent?
for (const [name, anchor] of [['clean', FRAMES.clean], ['dirty', FRAMES.dirty]]) {
  for (const hours of [12, 24, 36]) {
    const fan = buildFan(field, {
      lon: st.lon, lat: st.lat, anchor, hours, arrivals: 4, count: 24, jitterKm: 3,
    });
    const bear = [];
    let maxLon = -99; let maxDist = 0; let reach = 0;
    for (const { track } of fan) {
      const far = track[track.length - 1];
      const dy = far.lat - st.lat;
      const dx = (far.lon - st.lon) * Math.cos(st.lat * Math.PI / 180);
      bear.push((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360);
      maxLon = Math.max(maxLon, ...track.map((p) => p.lon));
      maxDist = Math.max(maxDist, kmBetween(st.lon, st.lat, far.lon, far.lat));
      if (track.some((p) => p.lon > 2)) reach++;
    }
    bear.sort((a, b) => a - b);
    console.log(`${name} ${String(hours).padStart(2)}h: bearing to far end ${bear[0].toFixed(0)}-${bear[bear.length - 1].toFixed(0)} deg (median ${bear[bear.length >> 1].toFixed(0)}), max lon ${maxLon.toFixed(1)}, furthest ${maxDist.toFixed(0)} km, ${reach}/${fan.length} tracks reach lon>2`);
  }
}

// The layer itself, on the real data, driven exactly as the deck drives it.
{
  const { WindLayer } = await import('file:///' + path.join(ROOT, 'web/js/wind.js'));
  const { RELEASES } = await import('file:///' + path.join(ROOT, 'web/js/story/beats.js'));
  const bearing = (lon, lat) => (Math.atan2((lon - st.lon) * Math.cos(st.lat * Math.PI / 180), lat - st.lat) * 180 / Math.PI + 360) % 360;

  const l = new WindLayer(field, { plume: { grid: meta.footprint.grid, station: st, alphaAt } });
  for (const [label, anchor, rel, mode] of [
    ['clean fwd', FRAMES.clean, RELEASES.ocean, 'forward'],
    ['dirty fwd', FRAMES.dirty, RELEASES.sources, 'forward'],
    ['dirty back', FRAMES.dirty, RELEASES.sources, 'back'],
  ]) {
    l.setStop({ anchor, release: rel, mode });
    const seeds = l._seedTable().pts;
    const b = seeds.map((s) => bearing(s.lon, s.lat)).sort((x, y) => x - y);
    const ps = l.journey.parcels.map((p) => bearing(p.lon, p.lat)).sort((x, y) => x - y);
    console.log(`${label}: fanKey ${l.fanKey} | ${seeds.length} seeds bearing ${b.length ? `${b[0].toFixed(0)}-${b[b.length - 1].toFixed(0)}` : 'none'} | parcels ${ps.length ? `${ps[0].toFixed(0)}-${ps[ps.length - 1].toFixed(0)}` : 'none'}`);
  }
}

// How long the dirty day's rewind has to run to reach the continent, and
// whether the frame still holds it. Frame at 16:9: lon -10..11, lat 46.1..57.9.
for (const hours of [18, 24, 30, 36, 42]) {
  const fan = buildFan(field, {
    lon: st.lon, lat: st.lat, anchor: FRAMES.dirty, hours, arrivals: 4, count: 24, jitterKm: 3,
  });
  let maxLon = -99; let minLat = 99; let reach = 0; let inside = 0; let len = 0;
  for (const { track } of fan) {
    for (let k = 1; k < track.length; k++) {
      const d = kmBetween(track[k - 1].lon, track[k - 1].lat, track[k].lon, track[k].lat);
      len += d;
      if (alphaAt(FRAMES.dirty, track[k].lon, track[k].lat) >= 0.35) inside += d;
    }
    maxLon = Math.max(maxLon, ...track.map((p) => p.lon));
    minLat = Math.min(minLat, ...track.map((p) => p.lat));
    if (track.some((p) => p.lon > 2.5)) reach++;
  }
  console.log(`dirty back ${String(hours).padStart(2)}h: max lon ${maxLon.toFixed(1)}, min lat ${minLat.toFixed(1)}, ${reach}/24 reach lon>2.5, ${(100 * inside / len).toFixed(0)}% of track in the red`);
}
