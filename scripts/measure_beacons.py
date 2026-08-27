"""Brief 1 -- the CFC-11 deck's five beacons, measured against the shipped data.

Produces the numbers the exporter, the drawing code and the suite all consume:
which regions the station can smell on which hours, and which of them is lit on
every smelly hour. No code ships from here; the answer key does.

Two things differ from the plan in `story-cfc11-deck-status.md`, both at the
user's direction:

  1. **Land only.** A beacon's value counts footprint over *land* cells inside
     its box and nothing over water. Emissions come from land, so sensitivity to
     the Yellow Sea is not sensitivity to Shandong -- and the five boxes hold
     very different amounts of sea, so counting it made them incomparable in a
     way that had nothing to do with the air.
  2. **Shared thresholds are on trial.** The plan normalises each beacon against
     its own distribution. That is a real cost -- "lit" then means something
     different for each letter -- so this script measures both and reports what
     each one costs, rather than assuming the answer.

Run:  python scripts/measure_beacons.py
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_web_data import REPO, open_footprints, _pearson  # noqa: E402

SITE_FP = "data/fps/GSN-10magl_EASTASIA_20160[67].nc"
OUT_DIR = REPO / "web" / "data-gsn-cfc11"
TIME_STEP = 2

# The bar's floor: the 10th percentile of the OBSERVATIONS alone. Deliberately
# not series.json's `baseline`, which is the 10th percentile of obs - modelled
# once a flux exists and therefore moves whenever the emissions guess changes.
BACKGROUND = 232.387

# The five beacons. Half-open [lo, hi) in both axes -- as originally written C
# and D both contained lat 34.5, and a cell counted into two beacons would make
# them not independent.
BEACONS = [
    # letter, name,               lat0, lat1,  lon0,  lon1,   dot (city)
    ("A", "South Korea",          34.5, 38.2, 126.0, 129.6, (126.98, 37.57)),
    ("B", "Western Japan",        32.5, 36.0, 129.6, 136.0, (130.40, 33.59)),
    ("C", "Shandong",             34.5, 38.2, 115.0, 122.5, (116.99, 36.67)),
    ("D", "Anhui + Jiangsu",      31.5, 34.5, 116.0, 120.5, (118.80, 32.06)),
    ("E", "South of Shanghai",    28.3, 31.2, 118.8, 122.5, (120.16, 30.27)),
]


def land_mask_on(lats, lons):
    """The exporter's own land mask, sampled onto the footprint grid."""
    lc = xr.open_dataset(REPO / "data" / "ancillary" / "land_cover.nc")
    ml = lc.lon.values
    ci = np.abs(ml[None, :] - np.mod(lons, 360.0)[:, None]).argmin(axis=1)
    ri = np.abs(lc.lat.values[None, :] - lats[:, None]).argmin(axis=1)
    return lc.land_binary_mask.values[np.ix_(ri, ci)].astype("float64")


def beacon_series(fp_ds, mask):
    """Land-only footprint sum inside each box, per frame. Shape (5, nFrames)."""
    lats = fp_ds.lat.values
    lons = fp_ds.lon.values

    cells = []
    for letter, name, lat0, lat1, lon0, lon1, _dot in BEACONS:
        # Half-open on both axes.
        rows = np.where((lats >= lat0) & (lats < lat1))[0]
        cols = np.where((lons >= lon0) & (lons < lon1))[0]
        sub = mask[np.ix_(rows, cols)]
        cells.append((rows, cols, sub))
        print(f"  {letter} {name:<20s} {len(rows):3d} x {len(cols):3d} cells, "
              f"{int(sub.sum()):4d} of {sub.size:5d} over land ({sub.mean():.0%})")

    nt_full = fp_ds.sizes["time"]
    out = np.zeros((len(BEACONS), nt_full))
    for i in range(0, nt_full, 48):
        block = fp_ds.fp.isel(time=slice(i, i + 48)).transpose("time", "lat", "lon").values.astype("float64")
        for b, (rows, cols, sub) in enumerate(cells):
            out[b, i:i + block.shape[0]] = (block[:, rows][:, :, cols] * sub[None]).sum(axis=(1, 2))
    # Footprint-derived quantities subsample: frame i IS hour i*step.
    return out[:, ::TIME_STEP], np.array([c[2].sum() for c in cells])


def lit_states(vals, cuts):
    """0 dark / 1 medium / 2 high, against a (medium, high) pair of cuts."""
    return (vals >= cuts[0]).astype(int) + (vals >= cuts[1]).astype(int)


def main():
    print("footprints ...")
    fp_ds = open_footprints(SITE_FP)
    mask = land_mask_on(fp_ds.lat.values, fp_ds.lon.values)

    print("\nbeacon boxes (land only) ...")
    vals, land_cells = beacon_series(fp_ds, mask)
    n = vals.shape[1]

    ser = json.loads((OUT_DIR / "series.json").read_text(encoding="utf-8"))
    obs = np.array([np.nan if v is None else v for v in ser["species"]["cfc-11"]["obs"]])[:n]
    enh = obs - BACKGROUND
    seen = np.isfinite(enh)
    print(f"\n{n} frames, {int(seen.sum())} observed, background {BACKGROUND} ppt")

    letters = [b[0] for b in BEACONS]
    names = {b[0]: b[1] for b in BEACONS}

    # --- the answer key ----------------------------------------------------
    # r, and the sensitivity ratio, are invariant to any per-beacon rescaling,
    # so they are the same under every threshold scheme below. They are the
    # answer; the schemes only change how the answer is *shown*.
    order = np.argsort(enh[seen])
    idx = np.where(seen)[0]
    cleanest, smelliest = idx[order[:25]], idx[order[-25:]]

    print("\n=== ANSWER KEY (land-only, invariant to threshold scheme) ===")
    print(f"{'':2s} {'region':<20s} {'r vs reading':>12s} {'25 smelliest / 25 cleanest':>28s}")
    key = {}
    for b, L in enumerate(letters):
        r = _pearson(vals[b][seen], enh[seen])
        hi, lo = vals[b][smelliest].mean(), vals[b][cleanest].mean()
        ratio = hi / lo if lo > 0 else float("inf")
        key[L] = {"r": r, "ratio": ratio}
        print(f"{L:2s} {names[L]:<20s} {r:>+12.3f} {ratio:>27.1f}x")

    # --- per-beacon vs shared thresholds -----------------------------------
    # Per-beacon: each letter's cuts come from its own distribution, so "lit"
    # means "the sensor is looking this way today" and every beacon lights 25%
    # of the time by construction.
    #
    # Shared: one absolute pair of cuts for all five, so "lit" means the same
    # physical sensitivity everywhere -- honest, but only useful if it does not
    # leave whole beacons permanently dark.
    #
    # Both are measured on the land-only sum and on that sum divided by the
    # box's land area. The second is the interesting one: most of the spread the
    # plan attributes to geography is actually box size.
    print("\n=== how often each beacon lights, by scheme ===")
    print("(medium cut = 50th pct, high cut = 80th pct; 'lit' = medium or above)\n")

    schemes = {}
    for norm_name, series in (("raw land sum", vals),
                              ("per land cell", vals / land_cells[:, None])):
        pool = series.ravel()
        shared_cuts = (np.percentile(pool, 50), np.percentile(pool, 80))
        for scheme in ("per-beacon", "shared"):
            states = np.zeros_like(series, dtype=int)
            for b in range(len(letters)):
                cuts = ((np.percentile(series[b], 50), np.percentile(series[b], 80))
                        if scheme == "per-beacon" else shared_cuts)
                states[b] = lit_states(series[b], cuts)
            schemes[(norm_name, scheme)] = (series, states, shared_cuts)

    for (norm_name, scheme), (series, states, _c) in schemes.items():
        rates = [(states[b] > 0).mean() for b in range(len(letters))]
        highs = [(states[b] == 2).mean() for b in range(len(letters))]
        cells = "  ".join(f"{L}:{r:>4.0%}/{h:>3.0%}" for L, r, h in zip(letters, rates, highs))
        dead = [L for L, r in zip(letters, rates) if r < 0.02]
        note = f"  <- {','.join(dead)} never light" if dead else ""
        print(f"  {norm_name:<14s} {scheme:<11s}  {cells}{note}")

    print("\n  (lit% / high% per beacon)")

    # --- what "lit" buys you: does the bar agree? --------------------------
    print("\n=== mean enhancement when lit vs dark, ppt ===")
    for (norm_name, scheme), (series, states, _c) in schemes.items():
        print(f"\n  {norm_name}, {scheme}:")
        for b, L in enumerate(letters):
            lit = seen & (states[b] > 0)
            dark = seen & (states[b] == 0)
            ml = enh[lit].mean() if lit.any() else float("nan")
            md = enh[dark].mean() if dark.any() else float("nan")
            print(f"    {L}  lit {ml:>+6.1f}   dark {md:>+6.1f}   "
                  f"separation {ml - md:>+6.1f}")

    # --- how selective should "lit" be? ------------------------------------
    # The cut percentiles are a tuning knob, not a finding: they set how many
    # letters glow at once, which is a look-at-it decision. Reported across a
    # range so the choice is made on screen rather than here.
    print("\n=== how many beacons are lit at once, by cut ===")
    dens = vals / land_cells[:, None]
    pool = dens.ravel()
    for lo, hi in ((50, 80), (60, 85), (70, 88), (75, 90)):
        cuts = (np.percentile(pool, lo), np.percentile(pool, hi))
        st = np.stack([lit_states(dens[b], cuts) for b in range(len(letters))])
        per_frame = (st > 0).sum(axis=0)
        rates = "  ".join(f"{L}:{(st[b] > 0).mean():>4.0%}" for b, L in enumerate(letters))
        print(f"  cuts {lo}/{hi}:  mean {per_frame.mean():.1f} of 5 lit per frame   {rates}")

    # --- the three frames the deck needs -----------------------------------
    PICK_SCHEME = ("per land cell", "shared")
    series, states, _c = schemes[PICK_SCHEME]
    print(f"\n=== frame picks, under {PICK_SCHEME[0]} + {PICK_SCHEME[1]} ===")

    t = np.array(ser["timeMs"], dtype="int64")
    import pandas as pd

    def stamp(fr):
        u = pd.Timestamp(t[fr], unit="ms")
        return f"{u:%d %b %H:%M} UTC / {u + pd.Timedelta(hours=9):%d %b %H:%M} KST"

    def st_str(fr):
        return "".join(f"{L}{'.-#'[states[b, fr]]}" for b, L in enumerate(letters))

    def row(fr):
        return (f"    frame {fr:3d}  {stamp(fr)}  reading {enh[fr]:>+6.1f}  "
                f"{st_str(fr)}  ({(enh[fr]) / 68 * 100:.0f}% of bar)")

    cand = [f for f in np.where(seen)[0] if states[2, f] == 2]
    cand.sort(key=lambda f: -enh[f])
    print("\n  ANSWER candidates (C high, smelliest first):")
    for f in cand[:6]:
        print(row(f))

    cand = [f for f in np.where(seen)[0]
            if (states[0, f] > 0 or states[1, f] > 0) and states[2, f] == 0 and enh[f] < 6]
    cand.sort(key=lambda f: -max(states[0, f], states[1, f]) * 100 + enh[f])
    print("\n  LIT-BUT-CLEAN candidates (A and/or B lit, C dark, bar under +6):")
    for f in cand[:8]:
        print(row(f))

    # --- sweep windows -----------------------------------------------------
    # The hard constraint is honesty, not story: every frame the sweep plays
    # must carry a reading (an empty bar means clean air on this deck) and the
    # window must not straddle a footprint time discontinuity (which would jump
    # days mid-animation). Everything else is ranked, not filtered -- the first
    # pass filtered on the story too and returned nothing.
    gaps = set(np.where(np.diff(t) > TIME_STEP * 3600 * 1000)[0])
    print(f"\n  time discontinuities after frames: {sorted(gaps)}")

    runs = []
    f = 0
    while f < n:
        if not seen[f]:
            f += 1
            continue
        end = f
        while end + 1 < n and seen[end + 1] and end not in gaps:
            end += 1
        runs.append((f, end))
        f = end + 1

    print(f"\n  {len(runs)} fully-observed gap-free runs; "
          f"longest {max(e - s + 1 for s, e in runs)} frames")
    print("\n  SWEEP candidates (run of >=4 observed frames, ranked by bar climb):")
    scored = []
    for s, e in runs:
        if e - s + 1 < 4:
            continue
        span = np.arange(s, e + 1)
        lo_i = int(span[np.argmin(enh[span])])
        hi_i = int(span[np.argmax(enh[span])])
        if hi_i <= lo_i:          # must climb forward in time
            continue
        scored.append((enh[hi_i] - enh[lo_i], s, e, lo_i, hi_i))
    scored.sort(reverse=True)
    for climb, s, e, lo_i, hi_i in scored[:8]:
        print(f"\n    run {s}..{e} ({e - s + 1} frames, {(e - s + 1) * 2} h)   "
              f"climb {climb:+.1f} ppt")
        print(f"      start {lo_i}: {stamp(lo_i)}  {enh[lo_i]:>+6.1f}  {st_str(lo_i)}")
        print(f"      end   {hi_i}: {stamp(hi_i)}  {enh[hi_i]:>+6.1f}  {st_str(hi_i)}")
        print(f"      C across the run: "
              + "".join('.-#'[states[2, i]] for i in range(s, e + 1)))
        print(f"      bar across the run: "
              + " ".join(f"{enh[i]:.0f}" for i in range(s, e + 1)))


if __name__ == "__main__":
    main()
