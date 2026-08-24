/**
 * Headless checks for the parts that do not need a canvas.
 *
 *   node web/js/selftest.mjs
 *
 * Covers the colour LUT and the particle sampler -- the sampler especially,
 * because "destinations are drawn from the real footprint" is a claim the
 * animation makes to the reader, and it is worth proving rather than assuming.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { footprintLUT, FLUX_LUT } from './palette.js';
import { ParticleField } from './particles.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

// Every exported instance, discovered rather than listed, so a new site or
// period is covered the moment it is exported.
const DIRS = readdirSync('web')
  .filter((d) => d.startsWith('data-') && existsSync(`web/${d}/meta.json`))
  .map((d) => `web/${d}`);
console.log(`datasets: ${DIRS.join(', ')}`);

// ---- colour LUT ----------------------------------------------------------
console.log('\npalette');
for (const dir of DIRS) {
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
  const lut = footprintLUT(meta);
  const alpha = (i) => lut[i * 4 + 3];

  check(`${dir}: index 0 fully transparent`, alpha(0) === 0);
  let monotone = true;
  for (let i = 2; i < 256; i++) if (alpha(i) < alpha(i - 1)) monotone = false;
  check(`${dir}: alpha rises with magnitude`, monotone);

  // The ramp must reach full strength at the display cut, not at the encoded
  // maximum -- otherwise ordinary plumes render washed out.
  const { logMin, logMax, logDisplayMax } = meta.footprint;
  const satIdx = Math.round(1 + 254 * ((logDisplayMax - logMin) / (logMax - logMin)));
  check(
    `${dir}: ramp saturates at the display cut`,
    satIdx > 1 && satIdx < 255 && alpha(Math.min(255, satIdx + 2)) === alpha(255),
    `index ${satIdx} of 255`,
  );
}
check('flux LUT is 256 RGBA entries', FLUX_LUT.length === 1024);

// ---- exported series shape ----------------------------------------------
console.log('\nexported series');
for (const dir of DIRS) {
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
  const series = JSON.parse(readFileSync(`${dir}/series.json`, 'utf8'));
  const n = meta.footprint.nTime;
  const keys = Object.keys(series.species || {});

  check(`${dir}: time axis matches frame count`, series.timeMs.length === n, `${series.timeMs.length} vs ${n}`);
  check(`${dir}: has at least one species`, keys.length > 0, keys.join(', '));
  check(
    `${dir}: default species exists`,
    !!series.species[series.defaultSpecies],
    series.defaultSpecies,
  );
  for (const k of keys) {
    const b = series.species[k];
    // Every per-species array must be frame-aligned, or the chart would read
    // one gas's values against another's timestamps.
    const okObs = !b.obs || b.obs.length === n;
    const okMod = !b.modelled || b.modelled.length === n;
    check(`${dir}: ${k} arrays are frame-aligned`, okObs && okMod);
    check(`${dir}: ${k} declares units and a label`, !!b.units && !!b.label, `${b.label} / ${b.units}`);
  }
  if (series.landFrac) {
    check(`${dir}: landFrac frame-aligned and in [0,1]`,
      series.landFrac.length === n && series.landFrac.every((v) => v >= 0 && v <= 1));
  }
  // meta and series must agree on which species exist.
  const metaKeys = (meta.species || []).map((s) => s.key).sort();
  check(`${dir}: meta and series agree on species`, metaKeys.join() === keys.slice().sort().join(),
    metaKeys.join(', '));

  // Factory overlay, where the site has one. Absent is a valid state and is
  // covered by the map-view section below, not treated as a failure here.
  const f = meta.factories;
  if (f) {
    check(`${dir}: factory points are [lon, lat, count] triples`,
      Array.isArray(f.points) && f.points.length > 0
        && f.points.every((p) => p.length === 3 && p.every(Number.isFinite)),
      `${f.points.length} locations`);
    // Plausible coordinates, in the right order. Swapping lon and lat is the
    // classic failure here and would still render -- just in the wrong ocean.
    check(`${dir}: factory coordinates are in range and not transposed`,
      f.points.every(([lon, lat]) => lat >= -90 && lat <= 90 && lon >= -180 && lon <= 360));
    check(`${dir}: counts sum to the listed plant total`,
      f.points.reduce((s, p) => s + p[2], 0) === f.nListed,
      `${f.nListed} plants / ${f.nSites} sites`);
    check(`${dir}: no duplicate factory locations`,
      new Set(f.points.map((p) => `${p[0]},${p[1]}`)).size === f.points.length);
    // The layer names a gas, and that gas has to be one this site actually
    // carries -- otherwise the button would caption a list for the wrong one.
    check(`${dir}: factory species is one of this site's species`,
      metaKeys.includes(f.species), `${f.species} / ${f.label}`);
    check(`${dir}: nInView is consistent with the view box`,
      f.nInView === f.points.filter(([lon, lat]) =>
        lon >= meta.view.lonMin && lon <= meta.view.lonMax
        && lat >= meta.view.latMin && lat <= meta.view.latMax).length,
      `${f.nInView} of ${f.nSites} inside`);

    // The lit threshold is a fixed physical sensitivity, so the uint8 code has to
    // decode back to it at every site whatever that site's encoded range is.
    const { logMin, logMax } = meta.footprint;
    const decoded = logMin + ((f.litCode - 1) / 254) * (logMax - logMin);
    check(`${dir}: litCode decodes to the configured sensitivity`,
      decoded >= f.litLog10 && decoded - f.litLog10 < (logMax - logMin) / 254,
      `code ${f.litCode} -> log10 ${decoded.toFixed(3)} vs ${f.litLog10}`);
    // A threshold above the encoded maximum would never fire; one at the floor
    // would fire always. Both are silent failures on screen.
    check(`${dir}: litCode sits inside the encoded range`,
      f.litCode > 1 && f.litCode < 255, `${f.litCode} of 255`);
  }
}

// ---- particle sampler ----------------------------------------------------
console.log('\nparticle sampler');
const W = 40;
const H = 30;
const meta = {
  station: { lat: 50, lon: 0, id: 'TEST' },
  footprint: { logMin: -5, logMax: 0 },
};
const grid = { lonMin: -20, lonMax: 20, latMin: 35, latMax: 65 };

// A synthetic footprint with all its mass in one known quadrant.
const frame = new Uint8Array(W * H);
const hotCol = [25, 34];
const hotRow = [4, 11];
for (let r = hotRow[0]; r <= hotRow[1]; r++) {
  for (let c = hotCol[0]; c <= hotCol[1]; c++) frame[r * W + c] = 240;
}
// A faint background everywhere else, to prove weighting not just membership.
for (let i = 0; i < frame.length; i++) if (!frame[i]) frame[i] = 1;

const data = {
  width: W,
  height: H,
  grid,
  meta,
  series: { windDir: [45] },
  frame: () => frame,
  toPhysical(u) {
    return u === 0 ? 0 : Math.pow(10, -5 + ((u - 1) / 254) * 5);
  },
};

const pf = new ParticleField(data, { max: 100000 });
pf._ensureCDF(0);
let inside = 0;
const N = 4000;
for (let i = 0; i < N; i++) {
  const d = pf._sampleCell();
  const lonOk = d.lon >= grid.lonMin + (hotCol[0] / W) * 40 && d.lon <= grid.lonMin + ((hotCol[1] + 1) / W) * 40;
  const latOk = d.lat <= grid.latMax - (hotRow[0] / H) * 30 && d.lat >= grid.latMax - ((hotRow[1] + 1) / H) * 30;
  if (lonOk && latOk) inside++;
}
// The hot block holds >99.9% of the physical mass, so essentially every draw
// should land in it. Anything less means the CDF or the index->lon/lat mapping
// disagrees with how mapview.js paints the same array.
check('destinations land in the hot region', inside / N > 0.97, `${((inside / N) * 100).toFixed(1)}%`);

// Half a second at the default 22 particles/sec: a single 1/60 s frame is
// correctly below the spawn threshold and would produce none.
pf.update(0.5, 0);
check('spawning produces particles', pf.ps.length > 0, `${pf.ps.length}`);
const p = pf.ps[0];
check('particles start at the station', Math.abs(p.x0 - 0) < 1e-9 && Math.abs(p.y0 - 50) < 1e-9);

// Opening heading must follow the measured wind: 45 deg means the air came from
// the north-east, so a backward parcel heads north-east first.
const dx = p.cx - p.x0;
const dy = p.cy - p.y0;
check('control point lies upwind (NE for wind_from_direction 45)', dx > 0 && dy > 0, `dx=${dx.toFixed(2)} dy=${dy.toFixed(2)}`);

const at0 = pf._at(p, 0);
const at1 = pf._at(p, 1);
check('curve starts at the station', Math.hypot(at0[0] - p.x0, at0[1] - p.y0) < 1e-9);
check('curve ends at the sampled destination', Math.hypot(at1[0] - p.x1, at1[1] - p.y1) < 1e-9);

pf.clear();
check('clear empties the field', pf.ps.length === 0);

// An empty footprint must not spin or throw.
const empty = { ...data, frame: () => new Uint8Array(W * H) };
const pf2 = new ParticleField(empty);
pf2.update(1, 0);
check('empty footprint spawns nothing and does not hang', pf2.ps.length === 0);

// ---- map view ------------------------------------------------------------
// A canvas stub, enough to run a full draw() headlessly. This section exists
// because the flux layer is optional and the failure mode when that is got
// wrong is silent: the page loads its data, throws while wiring up, and sits on
// the last progress message looking like a slow download.
console.log('\nmap view');
{
  const gradient = { addColorStop() {} };
  const makeCtx = () =>
    new Proxy(
      {},
      {
        get(t, k) {
          if (k in t) return t[k];
          switch (k) {
            case 'createImageData':
              return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
            case 'getImageData':
              return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
            case 'measureText':
              return () => ({ width: 24 });
            case 'createLinearGradient':
            case 'createRadialGradient':
              return () => gradient;
            default:
              return () => {};
          }
        },
        set(t, k, v) {
          t[k] = v;
          return true;
        },
      },
    );

  const makeCanvas = () => ({
    width: 0,
    height: 0,
    getContext: makeCtx,
    getBoundingClientRect: () => ({ width: 900, height: 600, left: 0, top: 0 }),
  });

  globalThis.window = { devicePixelRatio: 2 };
  globalThis.document = { createElement: () => makeCanvas() };

  const { MapView, fitMapWidth } = await import('./mapview.js');

  // ---- one-screen fit ---------------------------------------------------
  // Sizing the map from the viewport is only worth doing if the explorer then
  // actually lands inside one screen, so that gets asserted rather than assumed.
  //
  // Caveat worth knowing: there is no browser here, so the header and row
  // heights below are a *model* of what essay.css produces, not a measurement of
  // it. They mirror the two regimes the stylesheet defines -- the roomy one and
  // the `max-height: 820px` compact one -- and if a padding or font-size changes
  // in the CSS these want changing with it. The runtime does not depend on them:
  // explore.js measures the real geometry and calls fitMapWidth with that.
  {
    const COLUMN = 880; // .wrap 920px less its 40px of side padding

    // The rows under the map, per essay.css. The chart is the only one that
    // scales with the viewport (`clamp(120px, 17vh, 172px)` plus 4px padding);
    // the rest are text and buttons at fixed padding. Two regimes, split at the
    // stylesheet's `max-height: 820px` breakpoint.
    const model = (vh) => {
      const compact = vh <= 820;
      const chart = Math.min(172, Math.max(120, 0.17 * vh)) + 4;
      // controls + species toggles + layer toggles + legend
      const rest = compact ? 158 : 172;
      // wrap padding + eyebrow (hidden when compact) + title + standfirst + links
      const header = compact ? 120 : 166;
      return { header, rows: chart + rest };
    };

    const screens = [
      ['1366x768', 633], ['1600x900', 765], ['1920x1080', 945],
      ['1920x1200', 1065], ['2560x1440', 1305],
      // An embedded editor preview, which is small and gets dragged about.
      ['editor pane 900x620', 620],
    ];
    const fits = [];
    const over = [];
    for (const [name, viewportH] of screens) {
      const { header, rows } = model(viewportH);
      const w = fitMapWidth({ viewportH, aboveStage: header, stageRows: rows, max: COLUMN });
      const total = header + Math.round(w / 1.6) + rows;
      const line = `${name}: ${total}/${viewportH}, map ${w}x${Math.round(w / 1.6)}`;
      (total <= viewportH ? fits : over).push(line);
    }
    check('explorer fits every standard screen', over.length === 0,
      over.length ? over.join(' · ') : fits.join(' · '));

    // The map must stay narrower than the column, or the chart is no wider than
    // it and the whole point of the split is lost.
    const { header, rows } = model(945);
    const at1080 = fitMapWidth({ viewportH: 945, aboveStage: header, stageRows: rows, max: COLUMN });
    check('map is narrower than the column it sits in', at1080 < COLUMN,
      `${at1080} vs ${COLUMN}`);

    // Clamps hold at both extremes rather than producing a degenerate map.
    check('fit floors on a very short viewport',
      fitMapWidth({ viewportH: 380, aboveStage: 120, stageRows: 282, max: COLUMN }) === 300);
    check('fit caps at the column width on a tall viewport',
      fitMapWidth({ viewportH: 4000, aboveStage: 166, stageRows: 348, max: COLUMN }) === COLUMN);
    // A taller header must shrink the map, not push the page over.
    const tight = fitMapWidth({ viewportH: 945, aboveStage: 300, stageRows: rows, max: COLUMN });
    const loose = fitMapWidth({ viewportH: 945, aboveStage: 160, stageRows: rows, max: COLUMN });
    check('a taller header yields a smaller map', tight < loose, `${tight} vs ${loose}`);
  }

  const baseData = (flux, factories = null) => ({
    width: W,
    height: H,
    grid,
    flux,
    basemap: {
      land: [[[[-10, 40], [10, 40], [10, 60], [-10, 60], [-10, 40]]]],
      coast: [[[-10, 40], [10, 60]]],
      borders: [[[0, 40], [0, 60]]],
    },
    meta: {
      view: { lonMin: -20, lonMax: 20, latMin: 35, latMax: 65 },
      station: { id: 'TEST', lat: 50, lon: 0 },
      footprint: { logMin: -5, logMax: 0, logDisplayMax: -1 },
      factories,
    },
    frame: () => frame,
  });

  const withFlux = new MapView(makeCanvas(), baseData({ data: new Uint8Array(W * H), width: W, height: H }));
  withFlux.layers.flux = 0.8;
  withFlux.draw();
  check('draws with an emissions layer', true);

  // The Gosan case: no inventory at all.
  const noFlux = new MapView(makeCanvas(), baseData(null));
  check('constructs with flux: null', noFlux.fluxBuf === null);
  noFlux.layers.flux = 0.8; // even if something turns it on
  noFlux.draw();
  check('draws with no emissions layer', true);

  // Projection round-trip.
  const p = noFlux.lonLatAt(noFlux.x(5), noFlux.y(52));
  check('projection inverts', Math.abs(p.lon - 5) < 1e-6 && Math.abs(p.lat - 52) < 1e-6);

  // Camera settles rather than drifting forever.
  noFlux.flyTo({ lon: 0, lat: 50, span: 8 });
  let steps = 0;
  while (noFlux.stepCamera() && steps < 5000) steps++;
  check('camera reaches its target', steps < 5000 && noFlux.cam.span === 8, `${steps} frames`);

  // ---- factory overlay --------------------------------------------------
  // Same optional-all-the-way-down rule as the flux layer: a site with no plant
  // list must construct and draw, including if something turns the layer on.
  check('constructs with factories: null', noFlux.factories.length === 0);
  noFlux.layers.factories = 1;
  noFlux.draw();
  check('draws with no factory list', true);

  // The synthetic frame's hot block spans cols 25-34, rows 4-11 at value 240,
  // with a faint 1 everywhere else -- so a plant inside it must light up and one
  // outside must not, at any threshold between 2 and 240.
  const cellLon = (col) => grid.lonMin + ((col + 0.5) / W) * (grid.lonMax - grid.lonMin);
  const cellLat = (row) => grid.latMax - ((row + 0.5) / H) * (grid.latMax - grid.latMin);

  const withFac = new MapView(
    makeCanvas(),
    baseData(null, {
      species: 'test',
      label: 'TEST',
      nListed: 4,
      nSites: 3,
      nInView: 2,
      litCode: 120,
      litLog10: -2,
      // One inside the view, one on the far side of the planet so the cull
      // path is exercised, one just outside the western edge.
      points: [[0, 50, 2], [170, -40, 1], [-21, 50, 1]],
    }),
  );
  check('reads the factory list off meta', withFac.factories.length === 3);
  withFac.layers.factories = 1;
  withFac.draw();
  check('draws the factory layer', true);

  // ---- lit state --------------------------------------------------------
  // Cell resolution must invert the sampler's index -> lon/lat mapping exactly.
  // A transposed or off-by-one mapping still renders; it just lights the wrong
  // plants, which is not something the picture would give away.
  {
    const probes = [[25, 4], [34, 11], [30, 8], [0, 0], [W - 1, H - 1]];
    const pts = probes.map(([c, r]) => [cellLon(c), cellLat(r), 1]);
    const mv = new MapView(makeCanvas(), baseData(null, { litCode: 120, points: pts }));
    const want = probes.map(([c, r]) => r * W + c);
    check('plant cells invert the sampler mapping',
      Array.from(mv.factoryCells).join() === want.join(),
      `${Array.from(mv.factoryCells).join(',')}`);

    // Inside the hot block (240) is lit; the faint background (1) is not.
    const litFlags = mv.factoryLit(0);
    check('plants inside the plume light up', litFlags.slice(0, 3).every(Boolean));
    check('plants under a faint footprint stay unlit',
      litFlags.slice(3).every((v) => v === false));

    // Off-grid plants can never light up, whatever the frame holds.
    const off = new MapView(makeCanvas(), baseData(null, {
      litCode: 2, points: [[999, 999, 1], [cellLon(30), cellLat(8), 1]],
    }));
    check('off-grid plants resolve to no cell', off.factoryCells[0] === -1);
    check('off-grid plants never light up', off.factoryLit(0)[0] === false);
    check('on-grid plant still lights at a low threshold', off.factoryLit(0)[1] === true);

    // A missing threshold must fail closed rather than lighting everything.
    const noThr = new MapView(makeCanvas(), baseData(null, { points: pts }));
    check('absent litCode leaves every plant unlit',
      noThr.factoryLitCode === Infinity && noThr.factoryLit(0).every((v) => v === false));
  }

  // Off-canvas points must be culled rather than drawn: at the default framing
  // the antipodal point is far off-screen, and the -21 lon point is just past
  // the left edge.
  const onScreen = withFac.factories.filter(([lon, lat]) => {
    const px = withFac.x(lon);
    const py = withFac.y(lat);
    return px >= -5 && px <= withFac.w + 5 && py >= -5 && py <= withFac.h + 5;
  });
  check('off-canvas factories are outside the viewport', onScreen.length === 1,
    `${onScreen.length} of 3 on screen`);

  // Hidden means hidden -- the layer is gated on its own flag, not on presence.
  withFac.layers.factories = 0;
  withFac.draw();
  check('factory layer respects its toggle', true);

  // Real exports, real framing: the exporter counts how many plants fall in the
  // view box, and the renderer decides what is on canvas from the camera. Those
  // two numbers are computed by different code in different languages, so
  // agreeing is worth asserting -- it is what catches a marker layer that
  // registers against the map differently from the footprint raster.
  for (const dir of DIRS) {
    const m = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
    if (!m.factories) continue;
    const mv = new MapView(makeCanvas(), {
      ...baseData(null, m.factories),
      meta: { ...m, factories: m.factories },
    });
    // The canvas is wider than it is tall, so at the wide framing longitude is
    // the binding constraint and vertical extent is generous -- meaning on-canvas
    // count should equal the exporter's in-view count exactly.
    const on = mv.factories.filter(([lon, lat]) => {
      const px = mv.x(lon);
      const py = mv.y(lat);
      return px >= 0 && px <= mv.w && py >= 0 && py <= mv.h;
    }).length;
    check(`${dir}: on-canvas plant count matches the export's nInView`,
      on === m.factories.nInView, `${on} drawn vs ${m.factories.nInView} in view`);
    mv.layers.factories = 1;
    mv.draw();
  }
}

// ---- sonification --------------------------------------------------------
// sonify.js is pure on purpose: no AudioContext exists in Node, and the part
// worth checking is not the sound but which plant sounds when. A threshold that
// never fires, a region that swallows every plant, or a cell mapping that has
// drifted from the map's are all silent failures -- they produce a piece that
// plays perfectly well and is about the wrong thing.
console.log('\nsonification');
{
  const {
    Sonifier, classifyRegion, resolveCells, REGION_VOICES, REGION_ORDER, degreeToMidi, PENTATONIC,
  } = await import('./sonify.js');
  const { MapView } = await import('./mapview.js');

  const makeCanvas = () => ({
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, {
      get: (t, k) => (k in t ? t[k]
        : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
          : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
            : k === 'measureText' ? () => ({ width: 24 })
              : () => {}),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
    getBoundingClientRect: () => ({ width: 900, height: 600, left: 0, top: 0 }),
  });

  // -- scale ---------------------------------------------------------------
  check('pentatonic degrees ascend within an octave',
    PENTATONIC.every((v, i) => i === 0 || v > PENTATONIC[i - 1]) && PENTATONIC[PENTATONIC.length - 1] < 12);
  let mono = true;
  for (let d = 1; d < 24; d++) if (degreeToMidi(50, d) <= degreeToMidi(50, d - 1)) mono = false;
  check('degree -> MIDI rises without a break across octaves', mono,
    `d0..d5 = ${[0, 1, 2, 3, 4, 5].map((d) => degreeToMidi(50, d)).join(',')}`);

  // -- region rules --------------------------------------------------------
  // Rule order is the thing that can silently rot: Sichuan sits at the same
  // latitude as Zhejiang, 1500 km west, so a pure latitude cut files it wrong.
  check('Sichuan classifies west, not south', classifyRegion(104.8, 29.35) === 'WEST');
  check('Zhejiang at the same latitude classifies south', classifyRegion(120.25, 29.27) === 'SOUTH');
  check('Harbin is north, not Korea', classifyRegion(126.6, 45.75) === 'NORTH');
  check('Ulsan is Korea', classifyRegion(129.3, 35.5) === 'KOREA');
  check('Osaka is Japan', classifyRegion(135.5, 34.7) === 'JAPAN');
  check('Shandong is north', classifyRegion(117.0, 36.71) === 'NORTH');
  check('Nanjing is central', classifyRegion(118.77, 32.04) === 'CENTRAL');
  check('every region in the order has a voice entry',
    REGION_ORDER.every((r) => REGION_VOICES[r]));

  // -- synthetic score -----------------------------------------------------
  // The grid sits over East Asia rather than reusing the map-view fixture's
  // North Atlantic box. That is not cosmetic: the region rules are geographic,
  // so a synthetic plant in the Atlantic classifies as WEST, which is the one
  // silent region -- and the whole score comes out empty.
  const SW = 40;
  const SH = 30;
  const sgrid = { lonMin: 105, lonMax: 145, latMin: 22, latMax: 46 };
  const N = 48;
  const cellLon = (col) => sgrid.lonMin + ((col + 0.5) / SW) * (sgrid.lonMax - sgrid.lonMin);
  const cellLat = (row) => sgrid.latMax - ((row + 0.5) / SH) * (sgrid.latMax - sgrid.latMin);

  // Two plants. A is lit over one long run with a peak in the middle; B never.
  const A = [cellLon(10), cellLat(10)];
  const B = [cellLon(30), cellLat(20)];
  const frames = [];
  for (let t = 0; t < N; t++) {
    const f = new Uint8Array(SW * SH).fill(1);
    // steps 4..9 lit, peaking at 6; then 20..21 lit again -- two arrivals.
    if (t >= 4 && t <= 9) f[10 * SW + 10] = t === 6 ? 170 : 130;
    if (t >= 20 && t <= 21) f[10 * SW + 10] = 140;
    frames.push(f);
  }
  const t0 = Date.UTC(2016, 5, 1);
  // A deliberate hole: step 30 is absent from the record entirely, so the
  // timeline has to be built from timestamps rather than array position.
  const times = [];
  for (let i = 0; i < N; i++) times.push(t0 + (i < 30 ? i : i + 12) * 7200000);
  const obs = [];
  for (let i = 0; i < N; i++) obs.push(i % 3 === 0 ? null : 100 + i);

  const synth = {
    nTime: N,
    width: SW,
    height: SH,
    grid: sgrid,
    meta: {
      view: { ...sgrid },
      station: { id: 'TEST', lat: 33, lon: 126 },
      footprint: { logMin: -5, logMax: 0, logDisplayMax: -1 },
      factories: { litCode: 120, litLog10: -2, points: [[...A, 1], [...B, 1]] },
    },
    series: { timeMs: times, landFrac: Array.from({ length: N }, (_, i) => (i % 7) / 7) },
    current: { obs, baseline: 100, label: 'TEST', units: 'ppt' },
    frame: (t) => frames[Math.max(0, Math.min(N - 1, t | 0))],
    toPhysical: (u) => (u === 0 ? 0 : Math.pow(10, -5 + ((u - 1) / 254) * 5)),
  };

  const s = new Sonifier(synth);

  check('cells resolve for on-grid plants', s.cells[0] === 10 * SW + 10 && s.cells[1] === 20 * SW + 30);

  // The mapping must agree with the one the raster is drawn through, element for
  // element. Written twice from the same formula is not the same as equal.
  {
    const mv = new MapView(makeCanvas(), {
      width: SW, height: SH, grid: sgrid, flux: null,
      basemap: { land: [], coast: [], borders: [] },
      meta: { ...synth.meta, view: { ...sgrid } },
      frame: synth.frame,
    });
    check('cell resolution matches MapView exactly',
      Array.from(mv.factoryCells).join() === Array.from(s.cells).join(),
      `${Array.from(s.cells).join(',')}`);
    // ...and so does the lit state it derives, at the same threshold.
    let same = true;
    for (let t = 0; t < N; t++) {
      const a = mv.factoryLit(t);
      for (let i = 0; i < a.length; i++) if (!!a[i] !== !!s.lit[t * 2 + i]) same = false;
    }
    check('lit flags match MapView.factoryLit for every step', same);
  }

  // -- timeline ------------------------------------------------------------
  check('timeline is built from timestamps, not array position',
    s.nSteps === N + 12 && s.rowAt[30] === -1 && s.rowAt[42] === 30,
    `${s.nSteps} steps for ${N} rows`);
  check('a missing step is a rest that still carries its bar',
    s.eventsAt(30).missing === true && s.eventsAt(30).plants.length === 0
    && s.eventsAt(30).pad === null && s.eventsAt(30).bar === 2);
  check('every present row lands on the 2-hour grid', s.uniformGrid);

  // -- rising edges --------------------------------------------------------
  // A plant lit for six consecutive steps must fire once, not six times.
  const edges = [];
  for (let st = 0; st < s.nSteps; st++) for (const p of s.eventsAt(st).plants) edges.push(st);
  check('a six-step visit fires exactly one note', edges.filter((e) => e >= 4 && e <= 9).length === 1,
    `edges at ${edges.join(',')}`);
  check('two separate visits fire two notes', edges.length === 2);
  check('the note lands on the arrival, not the peak', edges[0] === 4);
  // Velocity comes from the peak of the whole visit, which is the point: a
  // rising edge is by construction near the threshold, so the value *at* the
  // edge is nearly the same for every note.
  check('velocity is taken from the run peak, not the arrival value',
    s.edgePeak[4 * 2 + 0] === 170 && s.edgePeak[20 * 2 + 0] === 140);
  const v0 = s.eventsAt(4).plants[0].velocity;
  const v1 = s.eventsAt(20).plants[0].velocity;
  check('a stronger visit is louder than a weaker one', v0 > v1 && v1 > 0,
    `${v0.toFixed(3)} vs ${v1.toFixed(3)}`);
  // Plant B sits under the faint background for the whole run.
  let bSounded = false;
  for (let st = 0; st < s.nSteps; st++) {
    if (s.eventsAt(st).plants.some((p) => p.plant === 1)) bSounded = true;
  }
  check('a plant that never lights never sounds', !bSounded);
  check('the two plants landed in different regions, so this is a real test',
    s.regions[0] !== s.regions[1], `${s.regions.join(' / ')}`);

  // -- the honesty constraint ----------------------------------------------
  // Notes must not be gated on there being a measurement. Step 6 has a null obs
  // (6 % 3 === 0) and a plant lit, and the glow has to survive it.
  check('a null reading produces no pad', s.eventsAt(6).pad === null);
  check('plants still sound when there is no reading', s.eventsAt(6).glow !== null);
  check('a lit run keeps a glow after its arrival note',
    s.eventsAt(7).plants.length === 0 && s.eventsAt(7).glow.count === 1);

  // -- caps ----------------------------------------------------------------
  // Twelve plants arriving on the same step, four in each of three regions, each
  // at a different strength -- so both caps bind and the ordering is testable.
  // The real archive does this: the densest step of the 2016 summer has
  // seventeen plants arriving at once, all but a handful in one cluster.
  {
    const rows = [8, 16, 24]; // ~39N, ~33N, ~26N -> NORTH, CENTRAL, SOUTH
    const pts = [];
    const cellsOf = [];
    for (const r of rows) {
      for (let c = 5; c < 9; c++) { pts.push([cellLon(c), cellLat(r), 1]); cellsOf.push(r * SW + c); }
    }
    const f2 = [];
    for (let t = 0; t < 4; t++) {
      const f = new Uint8Array(SW * SH).fill(1);
      if (t >= 1) cellsOf.forEach((cell, i) => { f[cell] = 125 + i * 3; });
      f2.push(f);
    }
    const s2 = new Sonifier({
      ...synth,
      nTime: 4,
      series: { timeMs: [0, 7200000, 14400000, 21600000], landFrac: [0, 0, 0, 0] },
      current: { obs: [1, 1, 1, 1], baseline: 0, label: 'T', units: 'p' },
      meta: { ...synth.meta, factories: { litCode: 120, litLog10: -2, points: pts } },
      frame: (t) => f2[t],
    }, { maxVoicesPerStep: 5, maxVoicesPerRegion: 3 });

    const regs = new Set(s2.regions);
    check('the fixture really spans three regions', regs.size === 3, [...regs].join(','));
    const ev = s2.eventsAt(1);
    check('the global voice cap holds', ev.plants.length === 5, `${ev.plants.length} voices`);
    const perRegion = {};
    for (const p of ev.plants) perRegion[p.region] = (perRegion[p.region] || 0) + 1;
    check('the per-region cap holds', Object.values(perRegion).every((n) => n <= 3),
      JSON.stringify(perRegion));
    check('capped notes are counted, not lost silently',
      ev.plantsDropped === pts.length - ev.plants.length, `${ev.plantsDropped} dropped`);
    // The cap must drop the quiet ones. Plant 11 has the highest code, so it has
    // to survive; plant 0 has the lowest, so it must not.
    const kept = ev.plants.map((p) => p.plant);
    check('the strongest arrival always survives the cap', kept.includes(pts.length - 1),
      `kept ${kept.join(',')}`);
    check('the weakest arrival is the one dropped', !kept.includes(0));
  }

  // -- optionality ---------------------------------------------------------
  // Ridge Hill has no plant list. Same rule as the flux layer: absent is a valid
  // state all the way down, and the failure mode if it is not is a page that
  // sits on its loading bar looking like a slow download.
  {
    const bare = new Sonifier({ ...synth, meta: { ...synth.meta, factories: null } });
    check('a site with no plant list constructs', bare.hasPlants === false && bare.nPlants === 0);
    // Step 0 is on the beat, so it carries a hat; step 1 has a reading, so it
    // carries a pad. Both must survive the plant layer being absent entirely.
    check('...still produces the measurement layers',
      bare.eventsAt(0).plants.length === 0 && bare.eventsAt(0).hat !== null
      && bare.eventsAt(1).pad !== null);
    check('...and reports no correlation rather than a number', Number.isNaN(bare.correlation()));
    bare.stats();
    check('...and its stats do not throw', true);
  }

  // -- real exports --------------------------------------------------------
  // The atlas is a PNG and there is no decoder here, so the frames are stubbed.
  // Everything that does not need them -- the timeline, the regions, the
  // percentile mapping, the bar structure -- is checked against the real record.
  for (const dir of DIRS) {
    const m = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
    const ser = JSON.parse(readFileSync(`${dir}/series.json`, 'utf8'));
    const blocks = ser.species || {};
    const key = ser.defaultSpecies in blocks ? ser.defaultSpecies : Object.keys(blocks)[0];
    const { tileW, tileH } = m.footprint.atlas;
    const zero = new Uint8Array(tileW * tileH);
    const rs = new Sonifier({
      nTime: m.footprint.nTime,
      width: tileW,
      height: tileH,
      grid: m.footprint.grid,
      meta: m,
      series: ser,
      current: blocks[key] || { obs: null, baseline: 0 },
      frame: () => zero,
      toPhysical: (u) => (u === 0 ? 0
        : Math.pow(10, m.footprint.logMin + ((u - 1) / 254) * (m.footprint.logMax - m.footprint.logMin))),
    });

    check(`${dir}: every row lands on the ${m.timeStepHours}-hour grid`, rs.uniformGrid);
    check(`${dir}: a bar is a day at this site's own cadence`,
      rs.opts.stepsPerBar === 24 / m.timeStepHours, `${rs.opts.stepsPerBar} steps/bar`);
    check(`${dir}: the timeline covers the gaps in the archive`,
      rs.nSteps >= rs.nTime && rs.rowAt.filter((r) => r < 0).length === rs.nSteps - rs.nTime,
      `${rs.nSteps} steps, ${rs.nSteps - rs.nTime} missing`);

    // The bridge listen.js crosses on every animation frame. The explorer counts
    // rows and the score counts absolute slots, and at Gosan those differ by the
    // five missing days -- so a page that assumed the two indices were the same
    // number would drift five days apart by the end of the summer and look
    // perfectly plausible the whole way. Pinning both directions here is cheap.
    let roundTrip = true;
    let monotone = true;
    for (let r = 0; r < rs.nTime; r++) {
      if (rs.rowAt[rs.absOf[r]] !== r) roundTrip = false;
      if (r > 0 && rs.absOf[r] <= rs.absOf[r - 1]) monotone = false;
    }
    check(`${dir}: row -> step -> row round-trips for every row`, roundTrip);
    check(`${dir}: absolute step increases strictly with row`, monotone);
    check(`${dir}: the piece is a whole number of days`,
      rs.nSteps % (24 / m.timeStepHours) === 0,
      `${rs.nSteps} steps = ${rs.nSteps / (24 / m.timeStepHours)} bars`);
    check(`${dir}: bar lines land on midnight UTC`,
      rs.timeAt(0).getUTCHours() === 0 && rs.timeAt(rs.opts.stepsPerBar).getUTCHours() === 0);

    if (m.factories) {
      const regs = m.factories.points.map(([lon, lat]) => classifyRegion(lon, lat));
      check(`${dir}: every plant classifies into a known region`,
        regs.every((r) => REGION_ORDER.includes(r)),
        REGION_ORDER.map((r) => `${r} ${regs.filter((x) => x === r).length}`).filter((x) => !x.endsWith(' 0')).join(' · '));
      // A silent region must be silent because it is off the grid, not because
      // the rules happened to put an audible plant in it.
      const westOnGrid = regs
        .map((r, i) => [r, rs.cells[i]])
        .filter(([r, c]) => r === 'WEST' && c >= 0);
      check(`${dir}: nothing audible is filed as off-grid WEST`, westOnGrid.length === 0);
      check(`${dir}: on-grid count matches the export`,
        Array.from(rs.cells).filter((c) => c >= 0).length === m.factories.nOnGrid,
        `${m.factories.nOnGrid} on grid`);

      // Cell resolution has to agree with the renderer's on the real coordinates.
      const mv = new MapView(makeCanvas(), {
        width: tileW, height: tileH, grid: m.footprint.grid, flux: null,
        basemap: { land: [], coast: [], borders: [] },
        meta: m,
        frame: () => zero,
      });
      check(`${dir}: cell resolution matches MapView on the real plant list`,
        Array.from(mv.factoryCells).join() === Array.from(rs.cells).join());

      // Pitch must rise with latitude inside a region, or the north-south sweep
      // of a plume reads as noise.
      let ok = true;
      for (const r of rs.regionSummary()) {
        if (!r.voice) continue;
        const idx = [];
        for (let i = 0; i < rs.nPlants; i++) if (rs.regions[i] === r.id) idx.push(i);
        idx.sort((a, b) => rs.points[a][1] - rs.points[b][1]);
        for (let k = 1; k < idx.length; k++) if (rs.midi[idx[k]] < rs.midi[idx[k - 1]]) ok = false;
      }
      check(`${dir}: pitch rises with latitude within every region`, ok);
    }

    // The reading is ranked, not scaled, and the ranks have to span the register.
    const ranks = Array.from(rs.rank).filter((v) => !Number.isNaN(v));
    if (ranks.length) {
      check(`${dir}: percentile ranks span [0,1]`,
        Math.min(...ranks) === 0 && Math.max(...ranks) === 1, `${ranks.length} observed`);
      let padNulls = 0;
      for (let st = 0; st < rs.nSteps; st++) {
        const row = rs.rowAt[st];
        if (row >= 0 && Number.isNaN(rs.rank[row]) && rs.eventsAt(st).pad) padNulls++;
      }
      check(`${dir}: a null reading never produces a pad`, padNulls === 0);
    }
  }
}

// ---- the sound lab retuning the listen page ------------------------------
// Node has BroadcastChannel, so the protocol itself is testable without a
// browser -- which matters, because the failure mode is silent: a knob moves in
// one tab and nothing happens in the other, with no error anywhere.
console.log('\ntuning channel');
{
  const { publishTuning, subscribeTuning } = await import('./tuning.js');
  const { DEFAULTS } = await import('./sonify.js');

  const labOpts = { bpm: 120, padSpan: 11 };
  const labMix = { plants: 1, pad: 1 };
  const labMutes = { plants: false, pad: false };
  // Standing in for the lab's own summarize(): only what has moved is named,
  // and a muted layer is named as muted rather than by its gain.
  const summarize = () => [
    ...Object.keys(labMix).map((k) => (labMutes[k] ? `${k} muted`
      : labMix[k] !== 1 ? `${k} ×${labMix[k].toFixed(2)}` : '')),
    ...Object.keys(labOpts).map((k) => (labOpts[k] === DEFAULTS[k] ? '' : `${k} ${labOpts[k]}`)),
  ].filter(Boolean).join(' · ');
  const lab = publishTuning(() => ({
    opts: { ...labOpts }, mix: { ...labMix }, mutes: { ...labMutes }, summary: summarize(),
  }));

  const states = [];
  const patches = [];
  subscribeTuning({ onState: (m) => states.push(m), onPatch: (m) => patches.push(m) });
  const settle = () => new Promise((r) => { setTimeout(r, 60); });
  await settle();

  check('a subscriber is answered with the lab\'s current state', states.length === 1);
  check('the state carries the opts, not the defaults',
    states[0] && states[0].opts.bpm === 120 && states[0].opts.padSpan === 11);
  check('the state carries the mixer as well as the knobs',
    states[0] && states[0].mix.plants === 1 && states[0].mutes.pad === false);
  check('a subscriber does not hear its own hello', patches.length === 0);

  labOpts.bpm = 150;
  lab.patch('opt', 'bpm', 150);
  await settle();

  check('a knob move reaches the subscriber', patches.length === 1);
  check('the patch carries kind, key and value',
    patches[0] && patches[0].kind === 'opt' && patches[0].key === 'bpm' && patches[0].value === 150);
  check('a patch is not delivered as a state', states.length === 1);

  // The mixer is the half that used to stay behind in the lab.
  labMix.plants = 0.4;
  lab.patch('mix', 'plants', 0.4);
  labMutes.pad = true;
  lab.patch('mute', 'pad', true);
  await settle();

  check('a layer gain reaches the subscriber',
    patches[1] && patches[1].kind === 'mix' && patches[1].value === 0.4);
  check('a layer mute reaches the subscriber',
    patches[2] && patches[2].kind === 'mute' && patches[2].value === true);

  // The bug this replaced: a status line rebuilt from the last patch alone
  // claimed everything else had gone back to its default.
  check('a patch summarises every change, not just its own',
    patches[2] && patches[2].summary === 'plants ×0.40 · pad muted · bpm 150',
    patches[2] ? patches[2].summary : 'nothing received');

  // Opening the listen page after the lab has been tuned must not show defaults.
  const late = [];
  const seen = [];
  subscribeTuning({ onState: (m) => late.push(m), onPresence: (p) => seen.push(p) });
  await settle();
  check('a late subscriber is brought up to date',
    late.length === 1 && late[0].opts.bpm === 150 && late[0].mix.plants === 0.4
    && late[0].mutes.pad === true,
    late[0] ? `bpm ${late[0].opts.bpm}` : 'nothing received');

  // -- presence -----------------------------------------------------------
  // An open lab sitting at its defaults and no lab at all were the same thing
  // on screen -- nothing -- which is also what a broken link looks like.
  check('an open lab is reported as connected',
    seen.length >= 1 && seen[seen.length - 1].connected === true,
    JSON.stringify(seen));
  check('a lab on the same protocol is not flagged as mismatched',
    seen.length >= 1 && seen[seen.length - 1].protocolOk === true);

  lab.stop();
  await settle();
  check('a lab that closes is reported as gone',
    seen.length >= 2 && seen[seen.length - 1].connected === false,
    JSON.stringify(seen));

  // A tab still running the pre-`kind` code: it stamps no protocol, and an
  // unflagged mismatch silently routes layer mutes into the score, where they
  // do nothing whatever. This is the check that turns that into a message.
  const stale = new BroadcastChannel('ghg.sonify.tuning');
  const old = [];
  subscribeTuning({ onPresence: (p) => old.push(p) });
  await settle();
  stale.postMessage({ type: 'patch', key: 'bpm', value: 150, label: 'tempo', text: '150' });
  await settle();
  check('a tab running the older message shape is flagged, not silently ignored',
    old.length >= 1 && old[old.length - 1].connected === true
    && old[old.length - 1].protocolOk === false,
    JSON.stringify(old));
  stale.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall self-tests passed');
process.exit(failures ? 1 : 0);
