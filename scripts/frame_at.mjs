/**
 * Which frame is a given moment? -- the lookup a new beat is written from.
 *
 *   node scripts/frame_at.mjs cfc11 "5 Jul 2016 23:00"
 *   node scripts/frame_at.mjs cfc11 2016-07-05T14:00Z 379
 *   node scripts/frame_at.mjs cfc11                     # the deck's own moments
 *
 * `deck.js` translates one way only -- `data.time(t)` turns a frame into a date
 * -- and `selftest.mjs` pins the answer after the fact, asserting that each
 * entry in `FRAMES` still renders the stamp its caption claims. Nothing went the
 * other way, so every anchor in every `beats-*.js` was found by hand. This is
 * that direction, and it exists because the obvious shortcut is wrong:
 *
 * ⚠ **A frame index is a position in `series.json`'s `timeMs`, not an offset
 * from the start of the record.** `beats-rgl.js` documents its anchors as
 * `t = day*24 + hour - 24`, which holds only because February 2020 at Ridge Hill
 * is hourly and complete. The Gosan exports are not complete: `data-gsn-cfc11`
 * drops 28-30 June, 16 July and 24 July, five days in all. Ask that formula for
 * 5 July 2016 14:00 and it answers **415**; the frame is **379**. Three days
 * out, on a slide whose caption names the date, and nothing downstream would
 * have said so -- the index is inside the record, it decodes, it draws.
 *
 * So the axis is read rather than computed, and the gaps are printed at the top
 * of every run whether they are asked about or not.
 *
 * Two other things decided what this prints, both learned from the comment
 * blocks above `FRAMES` in `beats-cfc11.js`, which are a transcript of the
 * measurements someone had to make by hand before they could write six lines:
 *
 *   - **A moment is only a moment if it carries a reading.** 365 of 672 frames
 *     do at CFC-11, so a date picked off a calendar has a 46% chance of putting
 *     an empty bar on screen. Blank or observed comes first, and where it is
 *     observed, whether it stands alone between blanks or sits inside a run --
 *     which is what decides whether a playback can be anchored there.
 *   - **The station's clock, not the file's.** Gosan is UTC+9 and the deck says
 *     every date out loud in KST. A date typed here is read as station-local
 *     unless it says otherwise, and both stamps are printed, in the same words
 *     `friendly()` puts on the screen.
 *
 * Paste the index into `FRAMES` with the stamp in the comment, then add the row
 * to `site.times` in `selftest.mjs` so a re-export cannot move it quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The decks, for their data directory, species, timezone and bar -- so a lookup
// is asked in the same terms the deck is written in. Same reason
// `measure_seeding.mjs` imports `FRAMES` rather than repeating 36 and 153.
import { DECK as RGL } from '../web/js/story/beats-rgl.js';
import { DECK as GSN } from '../web/js/story/beats-gsn.js';
import { DECK as CFC11 } from '../web/js/story/beats-cfc11.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DECKS = { rgl: RGL, gsn: GSN, cfc11: CFC11 };

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// Mirrored from `deck.js`, deliberately and not imported: that module touches
// `document` at load. If its wording changes, change it here too -- the point of
// printing the friendly stamp is that it is the one the presenter will read.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** "Tuesday 5 July, 11pm" -- `friendly()` from deck.js, on a millisecond. */
function friendly(ms, tzOffsetH = 0) {
  const d = new Date(ms + tzOffsetH * 3600e3);
  const h = d.getUTCHours();
  const hour = h === 0 ? 'midnight' : h === 12 ? 'midday'
    : h < 12 ? `${h}am` : `${h - 12}pm`;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hour}`;
}

/** "2016-07-05 14:00" -- the sortable half, for pasting into a comment. */
function stamp(ms, tzOffsetH = 0) {
  return new Date(ms + tzOffsetH * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Hours, to one decimal but without a trailing `.0`. Gaps and offsets are read
 * as quantities here, not as durations to be formatted prettily.
 */
const hrs = (ms) => `${Number((ms / 3600e3).toFixed(1))} h`;

/**
 * The clock half of a date: `14`, `14:30`, `11pm`, `midday`.
 *
 * `midday` and `midnight` are in because the deck prints them, so a stamp read
 * off the screen can be typed straight back in.
 */
function parseClock(str) {
  if (!str) return { hh: 0, mm: 0 };
  const t = str.trim().toLowerCase();
  if (t === 'midnight') return { hh: 0, mm: 0 };
  if (t === 'midday' || t === 'noon') return { hh: 12, mm: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  return hh > 23 || mm > 59 ? null : { hh, mm };
}

/** A month name or its prefix -> 0-11, or -1. Unambiguous prefixes only. */
function parseMonth(name) {
  const n = name.toLowerCase().replace(/\.$/, '');
  const hits = MONTHS.map((m, i) => [m.toLowerCase(), i]).filter(([m]) => m.startsWith(n));
  return hits.length === 1 ? hits[0][1] : -1;
}

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(.+))?$/;
const DMY = /^(\d{1,2})\s+([A-Za-z]+\.?)\s+(\d{4})(?:[ ,]+(.+))?$/;

/**
 * A date string -> milliseconds, or `null`.
 *
 * **Never `Date.parse`.** It reads a bare `2016-07-05 14:00` in the *machine's*
 * zone, so the same command would answer differently on a laptop in London and
 * one in Seoul -- which is the exact class of error this script is for. Every
 * field is parsed out and rebuilt through `Date.UTC`.
 *
 * The default zone is the station's, because every date these decks speak is
 * local. A trailing `UTC`, `GMT` or `Z` overrides it; so does `--utc`.
 */
function parseWhen(raw, tzOffsetH, defaultZone) {
  let s = String(raw).trim();
  let zone = defaultZone;

  const zm = s.match(/[\s,]*(utc|gmt|z|kst|local)$/i);
  if (zm) {
    const z = zm[1].toLowerCase();
    zone = z === 'utc' || z === 'gmt' || z === 'z' ? 'utc' : 'local';
    s = s.slice(0, zm.index).trim();
  }

  let y; let mo; let d; let rest;
  const iso = s.match(ISO);
  const dmy = iso ? null : s.match(DMY);
  if (iso) {
    [, y, mo, d, rest] = iso;
    y = Number(y); mo = Number(mo) - 1; d = Number(d);
  } else if (dmy) {
    d = Number(dmy[1]); mo = parseMonth(dmy[2]); y = Number(dmy[3]); rest = dmy[4];
    if (mo < 0) return null;
  } else {
    return null;
  }

  const clock = parseClock(rest);
  if (!clock || mo < 0 || mo > 11 || d < 1 || d > 31) return null;

  const ms = Date.UTC(y, mo, d, clock.hh, clock.mm);
  // Date.UTC rolls 31 June into 1 July rather than complaining. A date that does
  // not exist is a typo, and a typo must not become a silently wrong slide --
  // the same rule `resolveFrames` follows when it rejects an override.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo || back.getUTCDate() !== d) return null;

  return { ms: ms - (zone === 'local' ? tzOffsetH * 3600e3 : 0), zone };
}

// ---------------------------------------------------------------------------
// The axis
// ---------------------------------------------------------------------------

/**
 * The frame nearest `target`, and the pair it falls between.
 *
 * `lo`/`hi` come back so a time landing inside one of the record's holes can be
 * reported as such rather than as a confident nearest frame -- the difference
 * between "that is frame 323" and "that is 26 hours off the end of a gap".
 */
function nearest(timeMs, target) {
  const last = timeMs.length - 1;
  if (target <= timeMs[0]) return { i: 0, lo: 0, hi: 0 };
  if (target >= timeMs[last]) return { i: last, lo: last, hi: last };
  let lo = 0; let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timeMs[mid] <= target) lo = mid; else hi = mid;
  }
  const i = target - timeMs[lo] <= timeMs[hi] - target ? lo : hi;
  return { i, lo, hi };
}

/** Every step in the axis longer than one frame: where the record has holes. */
function findGaps(timeMs, stepMs) {
  const out = [];
  for (let i = 1; i < timeMs.length; i += 1) {
    const d = timeMs[i] - timeMs[i - 1];
    if (d !== stepMs) out.push({ after: i - 1, from: timeMs[i - 1], to: timeMs[i], ms: d });
  }
  return out;
}

/** The maximal run of consecutive observed frames containing `i`, or null. */
function runAround(obs, timeMs, stepMs, i) {
  if (obs[i] == null) return null;
  let a = i; let b = i;
  while (a > 0 && obs[a - 1] != null) a -= 1;
  while (b < obs.length - 1 && obs[b + 1] != null) b += 1;
  let gapFree = true;
  for (let k = a + 1; k <= b; k += 1) if (timeMs[k] - timeMs[k - 1] !== stepMs) gapFree = false;
  return { a, b, n: b - a + 1, ms: timeMs[b] - timeMs[a] + stepMs, gapFree };
}

/** The nearest frame either side of `i` that carries a reading. */
function nearestObserved(obs, i) {
  for (let d = 1; d < obs.length; d += 1) {
    if (obs[i - d] != null) return i - d;
    if (obs[i + d] != null) return i + d;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * One frame, in the terms a beat is written in.
 *
 * `asked` is the millisecond that was requested, where a date was; it is what
 * turns "frame 323" into "frame 323, 26 hours before the time you asked for",
 * which is the line that stops a gap being mistaken for a hit.
 */
function report(ctx, i, asked = null) {
  const { timeMs, obs, deck, units, stepMs } = ctx;
  const tz = deck.tzOffsetH || 0;
  const out = [];

  const off = asked == null ? 0 : timeMs[i] - asked;
  const exact = off === 0;
  out.push(`  → frame ${i}${asked == null ? '' : exact ? '   exact' : `   nearest — ${hrs(Math.abs(off))} ${off > 0 ? 'after' : 'before'} the time asked for`}`);
  out.push(`     ${friendly(timeMs[i], tz)}`);
  out.push(`     ${stamp(timeMs[i])} UTC${tz ? `  ·  ${stamp(timeMs[i], tz)} local (UTC${tz > 0 ? '+' : ''}${tz})` : ''}`);

  // Inside a hole in the record rather than merely off-grid. Both `lo` and `hi`
  // are real frames; what is missing is everything between them.
  if (asked != null && !exact) {
    const { lo, hi } = nearest(timeMs, asked);
    if (hi > lo && timeMs[hi] - timeMs[lo] !== stepMs
        && asked > timeMs[lo] && asked < timeMs[hi]) {
      out.push(`     ⚠ that time is inside the ${hrs(timeMs[hi] - timeMs[lo])} gap between frames ${lo} and ${hi}`);
    }
  }

  const v = obs[i];
  if (v == null) {
    const j = nearestObserved(obs, i);
    out.push('     no reading here — the bar would be empty on this frame');
    if (j >= 0) {
      out.push(`     nearest reading is frame ${j}, ${hrs(Math.abs(timeMs[j] - timeMs[i]))} ${j > i ? 'later' : 'earlier'}`);
    }
  } else {
    const { base, span } = deck.smell;
    const pct = ((v - base) / span) * 100;
    const height = pct < 0 ? 'below the bar’s floor'
      : pct > 100 ? `${Math.round(pct)}% — CLIPS the top of the bar`
        : `${Math.round(pct)}% of the bar`;
    const rel = v >= base
      ? `+${(v - base).toFixed(1)} above ${base}`
      : `${(base - v).toFixed(1)} below ${base}`;
    out.push(`     reads ${v.toFixed(1)} ${units}   ${rel}   ${height}`);

    const run = runAround(obs, timeMs, stepMs, i);
    if (run.n === 1) {
      out.push(`     observed, but alone — ${i - 1} and ${i + 1} are both blank`);
    } else {
      const cover = run.gapFree ? `, ${hrs(run.ms)}` : ', straddling a gap';
      out.push(`     observed, inside a run of ${run.n} (${run.a}..${run.b}${cover})`);
    }
  }

  const named = Object.entries(deck.frames).filter(([, f]) => f === i).map(([k]) => k);
  if (named.length) out.push(`     already named: ${named.map((k) => `FRAMES.${k}`).join(', ')}`);

  return out.join('\n');
}

function header(ctx) {
  const { timeMs, obs, meta, deck, stepMs, gaps } = ctx;
  const tz = deck.tzOffsetH || 0;
  const step = stepMs / 3600e3;
  const nObs = obs.filter((v) => v != null).length;

  const lines = [
    '',
    `${deck.id} — ${meta.station.name}, ${deck.data} · ${deck.species}`,
    `${timeMs.length} frames ${step} h apart, ${stamp(timeMs[0])} .. ${stamp(timeMs[timeMs.length - 1])} UTC`
      + `${tz ? `  (local = UTC${tz > 0 ? '+' : ''}${tz})` : ''}`,
    `${nObs} of ${timeMs.length} carry a reading (${Math.round((nObs / timeMs.length) * 100)}%)`,
  ];

  if (!gaps.length) {
    lines.push('no gaps — the axis is continuous');
  } else {
    const missing = gaps.reduce((a, g) => a + g.ms - stepMs, 0);
    lines.push(`${gaps.length} gap${gaps.length > 1 ? 's' : ''}, ${hrs(missing)} missing — so the frame index is NOT (date − start) / ${step} h:`);
    for (const g of gaps.slice(0, 12)) {
      lines.push(`  after ${String(g.after).padStart(4)}   ${stamp(g.from)} → ${stamp(g.to)}   ${hrs(g.ms)}`);
    }
    if (gaps.length > 12) lines.push(`  ... and ${gaps.length - 12} more`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/frame_at.mjs <${Object.keys(DECKS).join('|')}> [date|frame ...] [--utc]

  node scripts/frame_at.mjs cfc11 "5 Jul 2016 23:00"     # station-local by default
  node scripts/frame_at.mjs cfc11 2016-07-05T14:00Z 379  # a UTC date, and a frame
  node scripts/frame_at.mjs cfc11                        # the deck's own moments

dates    2016-07-05 14:00 · 2016-07-05 · 5 Jul 2016 11pm · 5 July 2016, midday
         read in the station's local time unless they end UTC / GMT / Z, or --utc
frames   a bare whole number is read back the other way, as an index`;

function main(argv) {
  const args = argv.filter((a) => a !== '--utc');
  const defaultZone = argv.includes('--utc') ? 'utc' : 'local';
  const id = (args[0] || '').toLowerCase();
  const deck = DECKS[id];
  if (!deck) {
    console.error(`${id ? `unknown deck "${args[0]}"\n\n` : ''}${USAGE}`);
    process.exit(1);
  }

  const dir = path.join(ROOT, 'web', deck.data);
  for (const f of ['meta.json', 'series.json']) {
    if (!fs.existsSync(path.join(dir, f))) {
      console.error(`missing ${path.join(deck.data, f)} — run scripts/export_web_data.py first`);
      process.exit(1);
    }
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const series = JSON.parse(fs.readFileSync(path.join(dir, 'series.json'), 'utf8'));
  const block = series.species[deck.species];
  if (!block) {
    console.error(`${deck.data} has no "${deck.species}" — it carries ${Object.keys(series.species).join(', ')}`);
    process.exit(1);
  }

  const timeMs = series.timeMs;
  const stepMs = (meta.timeStepHours || 1) * 3600e3;
  const ctx = {
    timeMs,
    obs: block.obs || timeMs.map(() => null),
    meta,
    deck,
    units: block.units || '',
    stepMs,
    gaps: findGaps(timeMs, stepMs),
  };

  console.log(header(ctx));

  // Nothing asked for: the deck's own moments, which is both a sanity check on
  // the anchors in force and the card to paste into a `FRAMES` comment.
  const asks = args.slice(1);
  if (!asks.length) {
    console.log(`\nthis deck's moments\n`);
    for (const [k, f] of Object.entries(deck.frames)) {
      console.log(`  ${k}`);
      console.log(report(ctx, Math.max(0, Math.min(timeMs.length - 1, f))));
      console.log('');
    }
    return;
  }

  console.log('');
  let bad = 0;
  for (const ask of asks) {
    if (/^\d+$/.test(ask)) {
      const i = Number(ask);
      if (i >= timeMs.length) {
        console.log(`  "${ask}"  ⚠ outside the record — ${timeMs.length} frames, 0..${timeMs.length - 1}\n`);
        bad += 1;
        continue;
      }
      console.log(`  frame ${i}`);
      console.log(report(ctx, i));
      console.log('');
      continue;
    }

    const when = parseWhen(ask, deck.tzOffsetH || 0, defaultZone);
    if (!when) {
      console.log(`  "${ask}"  ⚠ not a date I can read — see the forms in --help\n`);
      bad += 1;
      continue;
    }
    const tz = deck.tzOffsetH || 0;
    const asZone = when.zone === 'local' && tz
      ? `read as local (UTC${tz > 0 ? '+' : ''}${tz}) = ${stamp(when.ms)} UTC`
      : `read as ${stamp(when.ms)} UTC`;
    console.log(`  "${ask}"  ${asZone}`);
    console.log(report(ctx, nearest(timeMs, when.ms).i, when.ms));
    console.log('');
  }
  if (bad) process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
} else {
  main(argv);
}
