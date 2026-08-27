/**
 * Asset loading.
 *
 * The footprint arrives as a single PNG sprite atlas: one tile per timestep,
 * log10-scaled to uint8 by scripts/export_web_data.py. We decode it once into a
 * flat Uint8Array so any timestep is a subarray away, then never touch the image
 * again. That is what makes scrubbing a month feel instant -- there is no
 * per-frame fetch, decode or reprojection, just a memcpy into an ImageData.
 *
 * Decoding runs one tile-row at a time. Pulling the whole 3429x3120 atlas
 * through getImageData at once would spike ~43 MB of RGBA; a single band is
 * ~1.6 MB and the peak stays flat regardless of how long the month is.
 */

import { WindField } from './wind.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

async function decodeAtlas(url, atlas, nTime) {
  const img = await loadImage(url);
  const { cols, rows, tileW: tw, tileH: th } = atlas;
  const out = new Uint8Array(nTime * tw * th);

  const band = document.createElement('canvas');
  band.width = cols * tw;
  band.height = th;
  const bx = band.getContext('2d', { willReadFrequently: true });

  for (let r = 0; r < rows; r++) {
    bx.clearRect(0, 0, band.width, th);
    bx.drawImage(img, 0, r * th, band.width, th, 0, 0, band.width, th);
    const px = bx.getImageData(0, 0, band.width, th).data;
    for (let c = 0; c < cols; c++) {
      const t = r * cols + c;
      if (t >= nTime) break;
      const base = t * tw * th;
      for (let y = 0; y < th; y++) {
        let src = (y * band.width + c * tw) * 4;
        let dst = base + y * tw;
        for (let x = 0; x < tw; x++, src += 4, dst++) out[dst] = px[src];
      }
    }
  }
  return out;
}

async function decodeGray(url) {
  const img = await loadImage(url);
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const px = cx.getImageData(0, 0, img.width, img.height).data;
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j];
  return { data: out, width: img.width, height: img.height };
}

/**
 * Load everything the essay needs.
 *
 * Wind is the one asset that is opt-in rather than load-if-present. The other
 * optional layers are small and every page that can show them wants them; the
 * two wind atlases are 2.56 MB on the wire and ~5.8 MB of `Uint8Array` once
 * decoded, and only the story deck draws them. `explore.html` and the sound lab
 * would pay that on every load for something they never read, so they simply do
 * not ask. Absent `meta.wind` still means `data.wind === null` either way.
 *
 * @param {string} base  directory holding the exported assets
 * @param {(msg:string, frac:number)=>void} [onProgress]
 * @param {{wind?: boolean}} [want]  optional assets to fetch
 */
export async function loadData(base = 'data-rgl/', onProgress = () => {}, want = {}) {
  onProgress('reading metadata', 0.05);
  const [meta, series, basemap] = await Promise.all(
    ['meta.json', 'series.json', 'basemap.json'].map((f) =>
      fetch(base + f).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      }),
    ),
  );

  // Emissions are optional: Gosan has footprints but no inventory yet.
  onProgress('drawing the coastline', 0.2);
  const flux = meta.flux ? await decodeGray(base + meta.flux.file) : null;

  // The hi-res source maps are optional in the same way, and doubly so: they
  // only exist for the deck's sources card, and `explore.html` never asks for
  // them. Absent `meta.fluxHires` means an empty object, not a missing key, so
  // callers can index it without guarding twice.
  const fluxHires = {};
  if (meta.fluxHires && meta.fluxHires.layers) {
    const entries = Object.entries(meta.fluxHires.layers);
    const decoded = await Promise.all(entries.map(([, l]) => decodeGray(base + l.file)));
    entries.forEach(([key], i) => { fluxHires[key] = decoded[i]; });
  }

  onProgress('unpacking the footprints', 0.35);
  const fpData = await decodeAtlas(
    base + meta.footprint.atlas.file,
    meta.footprint.atlas,
    meta.footprint.nTime,
  );

  // Two single-channel atlases rather than one RGB one, so each goes through
  // `decodeAtlas` unchanged: an L-mode PNG reads back with R = G = B, and the
  // decoder already keeps the R byte.
  let wind = null;
  if (want.wind && meta.wind) {
    onProgress('unpacking the wind', 0.75);
    const [wu, wv] = await Promise.all([
      decodeAtlas(base + meta.wind.atlas.u, meta.wind.atlas, meta.wind.nTime),
      decodeAtlas(base + meta.wind.atlas.v, meta.wind.atlas, meta.wind.nTime),
    ]);
    wind = new WindField(meta.wind, wu, wv);
  }

  onProgress('ready', 1);

  const { tileW, tileH } = meta.footprint.atlas;
  const cells = tileW * tileH;

  // A site holds one footprint archive and any number of measured species on
  // top of it -- same air, same transport, different instruments' channels.
  // The active species swaps which mole-fraction block the chart reads; nothing
  // about the map changes.
  const blocks = series.species || {};
  const keys = Object.keys(blocks);
  let active = series.defaultSpecies && blocks[series.defaultSpecies] ? series.defaultSpecies : keys[0];

  return {
    meta,
    series,
    basemap,
    nTime: meta.footprint.nTime,
    grid: meta.footprint.grid,
    width: tileW,
    height: tileH,
    flux,
    fluxHires,
    // The hi-res rasters carry their own grid: 0.1 deg over the view box, not
    // the footprint grid. Kept beside the pixels so a caller cannot draw one
    // against the wrong extent.
    fluxHiresGrid: (meta.fluxHires && meta.fluxHires.grid) || null,

    // A `WindField`, or null when the export has no wind or the caller did not
    // ask for it. Consumers gate on this rather than on `meta.wind`: the export
    // shipping an atlas and this page being able to sample it are two different
    // questions, and they were true at different times.
    wind,

    // The named regions the CFC-11 deck asks its audience to choose between,
    // and their 0/1/2 level per frame -- or null at every other site, which is
    // every other site. Optional the whole way down like `factories`: the two
    // halves live in different files and either could be absent, so they are
    // surfaced as one thing that is there or is not, and a caller that wants
    // them checks `has.beacons` rather than assuming the key exists.
    beacons: meta.beacons || null,
    beaconLevels: series.beacons || null,

    speciesKeys: keys,
    speciesList: meta.species || keys.map((k) => ({ key: k, ...blocks[k] })),

    get activeSpecies() {
      return active;
    },
    setSpecies(key) {
      if (blocks[key]) active = key;
      return active;
    },
    /** The mole-fraction block for the active species. */
    get current() {
      return blocks[active] || { obs: null, modelled: null, baseline: null, label: '', units: '' };
    },
    get speciesLabel() {
      return this.current.label || active;
    },
    get units() {
      return this.current.units || '';
    },

    // What this export supports right now, so the UI can hide what it cannot
    // show. Recomputed per species, since one gas may have an inventory and
    // another may not.
    get has() {
      const c = this.current;
      return {
        obs: !!c.obs,
        model: !!c.modelled,
        flux: !!flux,
        fluxHires: Object.keys(fluxHires).length > 0,
        landFrac: !!series.landFrac,
        wind: !!wind,
        manySpecies: keys.length > 1,
        factories: !!(meta.factories && meta.factories.points && meta.factories.points.length),
        beacons: !!(meta.beacons && meta.beacons.boxes && meta.beacons.boxes.length
                    && series.beacons && series.beacons.length === meta.beacons.boxes.length),
      };
    },

    /** Raw uint8 footprint frame for timestep t (row 0 = north). */
    frame(t) {
      const i = Math.max(0, Math.min(this.nTime - 1, t | 0));
      return fpData.subarray(i * cells, (i + 1) * cells);
    },

    /** Decode a uint8 footprint code back to its physical value. */
    toPhysical(u) {
      if (u === 0) return 0;
      const { logMin, logMax } = meta.footprint;
      return Math.pow(10, logMin + ((u - 1) / 254) * (logMax - logMin));
    },

    /** Date object for timestep t. */
    time(t) {
      return new Date(series.timeMs[Math.max(0, Math.min(series.timeMs.length - 1, t | 0))]);
    },
  };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTime(d) {
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${hh}:00 UTC`;
}

export function formatDay(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
