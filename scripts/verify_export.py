"""
Verify exported web assets against the source netCDF.

Re-implements exactly what web/js/data.js does when it decodes the atlas -- tile
indexing, the north-up row flip, and the uint8 -> physical inverse -- then
compares against the original footprint field. If this passes, the browser is
looking at the same numbers the notebook is.

    python scripts/verify_export.py            # all configured sites
    python scripts/verify_export.py --site GSN
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_web_data import (  # noqa: E402
    SITES, SOURCE_GROUPS, _encode_flux, _encode_wind, _slice_view, open_footprints,
    open_wind,
)

REPO = Path(__file__).resolve().parents[1]


def verify(site: str) -> list[str]:
    cfg = SITES[site]
    out = REPO / cfg["out"]
    print(f"\n=== {site}  ({cfg['out']}) ===")
    if not (out / "meta.json").exists():
        return [f"{site}: no export at {cfg['out']}"]

    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    series = json.loads((out / "series.json").read_text(encoding="utf-8"))
    at = meta["footprint"]["atlas"]
    grid = meta["footprint"]["grid"]
    log_min, log_max = meta["footprint"]["logMin"], meta["footprint"]["logMax"]
    tw, th, cols = at["tileW"], at["tileH"], at["cols"]
    step = meta["timeStepHours"]
    n_time = meta["footprint"]["nTime"]

    atlas = np.asarray(Image.open(out / at["file"]).convert("L"))
    fp_ds = open_footprints(cfg["fp"])
    sub = _slice_view(fp_ds.fp, cfg["view"]).transpose("lat", "lon", "time")
    sub = sub.isel(time=slice(None, None, step))

    fails: list[str] = []
    span = log_max - log_min

    def tile(t):
        r, c = divmod(t, cols)
        return atlas[r * th : (r + 1) * th, c * tw : (c + 1) * tw]

    def encode(frame):
        with np.errstate(divide="ignore", invalid="ignore"):
            lg = np.log10(np.where(frame > 0, frame, np.nan))
        u = np.round(1 + 254 * (lg - log_min) / span)
        return np.where(np.isfinite(u) & (u >= 1), np.minimum(u, 255), 0).astype(np.uint8)

    def to_physical(u):
        o = np.zeros(u.shape, dtype="float64")
        m = u > 0
        o[m] = 10.0 ** (log_min + (u[m].astype("float64") - 1) / 254 * span)
        return o

    print(f"grid {tw} x {th}, {n_time} frames (every {step} h), atlas {atlas.shape[1]} x {atlas.shape[0]}")

    if (sub.sizes["lon"], sub.sizes["lat"], sub.sizes["time"]) != (tw, th, n_time):
        fails.append(
            f"shape mismatch: netCDF {sub.sizes['lon']}x{sub.sizes['lat']}x{sub.sizes['time']} "
            f"vs meta {tw}x{th}x{n_time}"
        )
        return fails

    # --- tile bytes, exact ------------------------------------------------
    rng = np.random.default_rng(0)
    checks = sorted({0, 1, n_time // 2, n_time - 1, *(int(x) for x in rng.integers(0, n_time, 8))})
    for t in checks:
        want = encode(sub.isel(time=t).values[::-1, :])  # row 0 = north
        if not np.array_equal(tile(t), want):
            bad = int((tile(t) != want).sum())
            fails.append(f"t={t}: atlas tile differs from a re-encode in {bad} cells")
    print(f"tile bytes identical to a re-encode across {len(checks)} frames")

    # --- quantisation cost ------------------------------------------------
    floor = 10.0**log_min
    worst = 0.0
    for t in checks:
        truth = sub.isel(time=t).values[::-1, :]
        got = to_physical(tile(t))
        m = (truth > floor) & (got > 0)
        if m.sum():
            worst = max(worst, float(np.percentile(np.abs(got[m] - truth[m]) / truth[m], 99)))
    tol = (10 ** (span / 254) - 1) * 1.6
    print(f"worst 99th-pct relative error {worst:.2%} (tolerance {tol:.1%})")
    if worst > tol:
        fails.append(f"round-trip error {worst:.3f} exceeds {tol:.3f}")

    # --- registration -----------------------------------------------------
    # Centre of mass and the station's rank, not argmax: several cells saturate
    # at 255 in the plume core, so argmax picks arbitrarily among them.
    st = meta["station"]
    t = min(100, n_time - 1)
    got = to_physical(tile(t))
    truth = sub.isel(time=t).values[::-1, :]
    cell_lon = grid["lonMin"] + (np.arange(tw) + 0.5) / tw * (grid["lonMax"] - grid["lonMin"])
    cell_lat = grid["latMax"] - (np.arange(th) + 0.5) / th * (grid["latMax"] - grid["latMin"])

    def centroid(a):
        w = a / a.sum()
        return float((w.sum(1) * cell_lat).sum()), float((w.sum(0) * cell_lon).sum())

    cg, ct = centroid(got), centroid(truth)
    drift = float(np.hypot(cg[0] - ct[0], cg[1] - ct[1]))
    print(f"t={t} centroid: atlas ({cg[0]:.2f}, {cg[1]:.2f})  netCDF ({ct[0]:.2f}, {ct[1]:.2f})  drift {drift:.3f} deg")
    if drift > 0.35:
        fails.append(f"centroid drift {drift:.3f} deg exceeds what quantisation explains")

    srow = int(round((grid["latMax"] - st["lat"]) / (grid["latMax"] - grid["latMin"]) * th - 0.5))
    scol = int(round((st["lon"] - grid["lonMin"]) / (grid["lonMax"] - grid["lonMin"]) * tw - 0.5))
    if not (0 <= srow < th and 0 <= scol < tw):
        fails.append(f"station falls outside the exported view (row {srow}, col {scol})")
    else:
        rg = int((got > got[srow, scol]).sum())
        rt = int((truth > truth[srow, scol]).sum())
        print(f"t={t} station cell rank: atlas {rg}, netCDF {rt} (of {got.size})")
        if abs(rg - rt) > 5:
            fails.append(f"station-cell rank {rg} vs {rt} - grid registration is off")
        if rg > got.size * 0.01:
            fails.append(f"station outside the top 1% of footprint cells (rank {rg})")

    # --- series -----------------------------------------------------------
    if len(series["timeMs"]) != n_time:
        fails.append(f"series length {len(series['timeMs'])} != nTime {n_time}")
    want_ms = [int(pd.Timestamp(t_).value // 1_000_000) for t_ in sub.time.values]
    if series["timeMs"][: len(want_ms)] != want_ms:
        fails.append("series time axis does not match the footprint time axis")
    blocks = series.get("species") or {}
    if not blocks:
        fails.append("series.json has no species blocks")
    if series.get("defaultSpecies") not in blocks:
        fails.append(f"defaultSpecies {series.get('defaultSpecies')!r} is not among {list(blocks)}")

    meta_keys = sorted(s["key"] for s in meta.get("species", []))
    if meta_keys != sorted(blocks):
        fails.append(f"meta species {meta_keys} disagree with series species {sorted(blocks)}")

    print(f"series: {len(series['timeMs'])} frames, landFrac={'yes' if series['landFrac'] else 'no'}")
    for key, b in blocks.items():
        n_obs = 0 if not b["obs"] else sum(v is not None for v in b["obs"])
        for field in ("obs", "modelled"):
            arr = b.get(field)
            if arr is not None and len(arr) != n_time:
                fails.append(f"{key}.{field} has {len(arr)} values, expected {n_time}")
        if not b.get("units") or not b.get("label"):
            fails.append(f"{key} is missing a label or units")
        print(f"  {b['label']:8s} {n_obs:5d} observations, "
              f"model={'yes' if b['modelled'] else 'no'}, baseline={b['baseline']}")
    if series["landFrac"]:
        lf = np.array(series["landFrac"])
        if lf.min() < -1e-6 or lf.max() > 1 + 1e-6:
            fails.append(f"landFrac out of [0,1]: {lf.min()} .. {lf.max()}")

    # --- factory highlight ------------------------------------------------
    # A threshold is only useful if it fires sometimes and not always, and that
    # is a property of the data, not of the code -- so it is checked against the
    # shipped atlas rather than asserted. This is the guard against the failure
    # the design was chosen to avoid: tying "lit" to the display saturation point
    # would put it above every inland cell and the feature would be dead on
    # arrival, silently.
    fac = meta.get("factories")
    if fac:
        code = fac["litCode"]
        want = log_min + (code - 1) / 254 * span
        if not (0 <= want - fac["litLog10"] < span / 254):
            fails.append(f"litCode {code} decodes to log10 {want:.3f}, not {fac['litLog10']}")

        cells = []
        for lon, lat, _ in fac["points"]:
            c = int(np.floor((lon - grid["lonMin"]) / (grid["lonMax"] - grid["lonMin"]) * tw))
            r = int(np.floor((grid["latMax"] - lat) / (grid["latMax"] - grid["latMin"]) * th))
            if 0 <= c < tw and 0 <= r < th:
                cells.append((r, c))
        if len(cells) != fac["nOnGrid"]:
            fails.append(f"nOnGrid says {fac['nOnGrid']} but {len(cells)} plants resolve to a cell")

        rows = np.array([r for r, _ in cells])
        colz = np.array([c for _, c in cells])
        codes = np.zeros((n_time, len(cells)), dtype=np.uint8)
        for t in range(n_time):
            codes[t] = tile(t)[rows, colz]
        lit = codes >= code
        frames_lit = float(lit.any(axis=1).mean())
        print(f"plant highlight: log10 >= {fac['litLog10']} (u >= {code}) lights up on "
              f"{frames_lit:.1%} of frames, {lit.sum(axis=1).mean():.2f} plants per frame")
        print(f"  {int((lit.any(axis=0)).sum())} of {len(cells)} plants light up at some point; "
              f"headroom: strongest plant-hour anywhere is u={int(codes.max())}")
        if frames_lit == 0:
            fails.append(f"litCode {code} never fires -- the highlight would be dead on the page")
        if frames_lit > 0.9:
            fails.append(f"litCode {code} fires on {frames_lit:.0%} of frames -- not a highlight")

    # Every layer meta.json advertises must actually be on disk.
    for f in [at["file"], "series.json", "basemap.json", "meta.json"]:
        if not (out / f).exists():
            fails.append(f"missing file {f}")
    if meta.get("flux") and not (out / meta["flux"]["file"]).exists():
        fails.append("meta advertises flux.png but it is missing")

    fails += _verify_beacons(meta, series)
    fails += _verify_flux(meta, out, cfg)
    fails += _verify_flux_hires(meta, out)
    fails += _verify_wind(meta, out, cfg, fp_ds)
    return fails


def _verify_beacons(meta: dict, series: dict) -> list[str]:
    """The beacon boxes and their per-frame levels.

    Three properties the exporter cannot assert about itself.

    **The boxes are disjoint.** A cell counted into two beacons makes them not
    independent, which is the one thing the guessing game asks of them. Checked
    on the intervals rather than on cells, with the same half-open rule the
    export aggregates by.

    **A letter lights sometimes and not always**, the same guard the factory
    threshold gets: a beacon lit on every frame or on none is a dead control,
    and nothing else on the page would look wrong.

    **The answer key still points where it did.** Printed rather than asserted
    -- the suite in web/js/story/selftest.mjs owns that assertion -- but this is
    the table to read when a re-export moves something, and the shipped levels
    are re-checked against the `litFrac` meta.json advertises, so the two halves
    of the export cannot drift apart.
    """
    b = meta.get("beacons")
    lv = series.get("beacons")
    fails: list[str] = []
    if not b:
        if lv:
            fails.append("series.json carries beacon levels but meta.json has no beacons")
        return fails
    if not lv:
        fails.append("meta.json advertises beacons but series.json carries no levels")
        return fails

    boxes = b["boxes"]
    n_time = len(series["timeMs"])
    if len(lv) != len(boxes):
        fails.append(f"{len(lv)} rows of beacon levels for {len(boxes)} boxes")
        return fails

    for box, other in ((boxes[i], boxes[j])
                       for i in range(len(boxes)) for j in range(i + 1, len(boxes))):
        lat_hit = box["lat"][0] < other["lat"][1] and other["lat"][0] < box["lat"][1]
        lon_hit = box["lon"][0] < other["lon"][1] and other["lon"][0] < box["lon"][1]
        if lat_hit and lon_hit:
            fails.append(f"beacon boxes {box['id']} and {other['id']} overlap")

    lo_cut, hi_cut = b["cuts"]
    if not lo_cut < hi_cut:
        fails.append(f"beacon cuts are not ordered: medium {lo_cut}, high {hi_cut}")

    print(f"beacons: {len(boxes)} boxes, cuts {lo_cut:.3e} / {hi_cut:.3e} "
          f"({b['cutPercentiles'][0]:g}th / {b['cutPercentiles'][1]:g}th percentile, "
          f"{b['value']})")
    obs = series["species"][series["defaultSpecies"]]["obs"]
    for box, row in zip(boxes, lv):
        if len(row) != n_time:
            fails.append(f"beacon {box['id']} has {len(row)} levels, expected {n_time}")
            continue
        if set(row) - {0, 1, 2}:
            fails.append(f"beacon {box['id']} carries levels outside 0/1/2")
            continue
        lit = [v > 0 for v in row]
        frac = sum(lit) / len(lit)
        if abs(frac - box["litFrac"]) > 5e-4:
            fails.append(f"beacon {box['id']} is lit on {frac:.1%} of frames but "
                         f"meta says {box['litFrac']:.1%}")
        if frac == 0 or frac == 1:
            fails.append(f"beacon {box['id']} is lit on {frac:.0%} of frames -- "
                         "a beacon that never changes is a dead control")
        if not (box["lat"][0] <= box["dot"][1] < box["lat"][1]
                and box["lon"][0] <= box["dot"][0] < box["lon"][1]):
            fails.append(f"beacon {box['id']}'s dot sits outside its own box")

        seen = [(o, l) for o, l in zip(obs or [], lit) if o is not None]
        sep = ""
        if seen and any(l for _, l in seen) and any(not l for _, l in seen):
            on = [o for o, l in seen if l]
            off = [o for o, l in seen if not l]
            sep = f"  lit-minus-dark {sum(on) / len(on) - sum(off) / len(off):>+5.1f}"
        r = "" if box["r"] is None else f"  r {box['r']:>+6.3f}"
        print(f"  {box['id']} {box['name']:<20s} {box['landCells']:4d} land cells "
              f"({box['landFrac']:.0%})  lit {frac:>4.0%}{r}{sep}")
    return fails


def _verify_wind(meta: dict, out, cfg: dict, fp_ds) -> list[str]:
    """The wind atlases: re-encoded from source and demanded byte-identical.

    Same contract as the footprint atlas, and for the same reason -- the browser
    advects parcels through these numbers, so a silent encoding drift would move
    air the wrong way with nothing on screen looking broken.

    The station-agreement figures are *reported*, not asserted. They are a
    diagnostic about which model level was sliced, not a property of the export,
    and a threshold on them would fail for reasons that have nothing to do with
    whether the bytes are right.
    """
    w = meta.get("wind")
    if not w:
        return []

    fails = []
    at, grid = w["atlas"], w["grid"]
    uv_max = w["uvMax"]
    tw, th, cols = at["tileW"], at["tileH"], at["cols"]

    src = REPO / w["source"]
    if not src.exists():
        return [f"meta.wind names {w['source']} but it is not on disk"]

    ds = open_wind(w["source"], meta["station"].get("inletMagl"))
    sub = _slice_view(ds, cfg["view"])
    lon_max = (cfg.get("wind") or {}).get("lonMax")
    if lon_max is not None:
        sub = sub.sel(lon=slice(None, lon_max))

    if (sub.sizes["lon"], sub.sizes["lat"], sub.sizes["time"]) != (tw, th, w["nTime"]):
        return [f"wind shape {sub.sizes['lon']}x{sub.sizes['lat']}x{sub.sizes['time']} "
                f"disagrees with meta {tw}x{th}x{w['nTime']}"]

    # The crop is at the eastern end, so the wind grid must still start exactly
    # where the footprint grid does -- that shared origin is what lets the
    # renderer treat wind column j as footprint column j.
    if abs(grid["lonMin"] - meta["footprint"]["grid"]["lonMin"]) > 1e-6:
        fails.append(f"wind lonMin {grid['lonMin']} != footprint lonMin "
                     f"{meta['footprint']['grid']['lonMin']}; the grids no longer share an origin")

    rng = np.random.default_rng(1)
    checks = sorted({0, 1, w["nTime"] // 2, w["nTime"] - 1,
                     *(int(x) for x in rng.integers(0, w["nTime"], 6))})
    arrays = {"u": sub.u.values, "v": sub.v.values}
    worst = 0.0
    for name in ("u", "v"):
        atlas = np.asarray(Image.open(out / at[name]).convert("L"))
        for t in checks:
            r, c = divmod(t, cols)
            got = atlas[r * th : (r + 1) * th, c * tw : (c + 1) * tw]
            want = _encode_wind(arrays[name][t][::-1, :], uv_max)  # row 0 = north
            if not np.array_equal(got, want):
                fails.append(f"wind_{name} t={t}: differs from a re-encode in "
                             f"{int((got != want).sum())} cells")
            # The inverse the browser will implement, checked against the source.
            back = -uv_max + (got.astype("float64") - 1) / 254 * (2 * uv_max)
            worst = max(worst, float(np.abs(back - arrays[name][t][::-1, :]).max()))
            # Per tile, not per image: the atlas is zero-padded to fill its last
            # tile row, exactly as the footprint atlas is, so the image as a
            # whole is expected to contain zeros.
            if int(got.min()) == 0:
                fails.append(f"wind_{name} t={t}: contains code 0, which decodes as "
                             "missing, but the source has no gaps here")

    half_step = uv_max / 254
    print(f"wind: {tw} x {th}, {w['nTime']} frames every {w['frameStride']}, "
          f"{at['u']} + {at['v']} = {w['sizeMB']} MB, level {w['levelLabel']}")
    print(f"  tile bytes identical to a re-encode across {len(checks)} frames x 2 components")
    print(f"  worst round-trip error {worst:.4f} m/s (half a step is {half_step:.4f})")
    if worst > half_step * 1.001:
        fails.append(f"wind round-trip error {worst:.4f} exceeds half a step {half_step:.4f}")

    # Time: wind frame k must be footprint frame k * frameStride.
    step = meta["timeStepHours"]
    frame_ms = [int(pd.Timestamp(t_).value // 1_000_000) for t_ in fp_ds.time.values[::step]]
    wind_ms = [int(pd.Timestamp(t_).value // 1_000_000) for t_ in sub.time.values]
    stride = w["frameStride"]
    want_ms = frame_ms[: stride * w["nTime"] : stride]
    if wind_ms != want_ms:
        fails.append("wind time axis is not the footprint axis every "
                     f"{stride} frames")
    if w["framesCovered"] != (w["nTime"] - 1) * stride + 1:
        fails.append(f"framesCovered {w['framesCovered']} disagrees with "
                     f"nTime {w['nTime']} and stride {stride}")
    tail = meta["footprint"]["nTime"] - w["framesCovered"]
    print(f"  covers footprint frames 0..{w['framesCovered'] - 1}"
          + (f", last {tail} frames clamp to the final wind step" if tail > 0 else ""))

    # Reported, not asserted: which level got sliced, judged against the
    # station's own anemometer.
    corr = w.get("stationCorr")
    if corr:
        print(f"  vs the station's measured wind: r={corr['speed']:+.3f}, "
              f"bias {corr['biasMs']:+.2f} m/s, RMSE {corr['rmseMs']:.2f}, "
              f"direction {corr['dirDeg']:.1f} deg mean / {corr['dirMedianDeg']:.1f} median")
    return fails


def _verify_flux(meta: dict, out, cfg: dict) -> list[str]:
    """The coarse emissions map: re-encoded from source, and actually a map.

    Same contract as the footprint and wind atlases -- the bytes are demanded
    identical to a re-encode, so an encoder drift cannot ship quietly.

    The second check is the one this gas needed. `logRange` is per species now,
    and the failure it exists to prevent is **not** a crash: a window that sits
    off the field encodes every cell to the same byte, and a single-valued
    raster still draws. It draws as a flat rectangle, or as nothing at all, on
    the one slide whose whole job is to show *where* something comes from. So a
    flux map that carries fewer than a handful of distinct levels is a failure
    here rather than a discovery on stage.
    """
    fl = meta.get("flux")
    if not fl:
        return []

    spec = next((s for s in cfg["species"] if s["key"] == fl["species"]), None)
    if spec is None or not spec.get("flux"):
        return [f"meta.flux says species {fl['species']}, which has no flux in SITES"]

    matches = sorted(glob.glob(spec["flux"]))
    if not matches:
        return [f"meta.flux names species {fl['species']} but {spec['flux']} is not on disk"]

    fails = []
    ds = xr.open_dataset(matches[0])
    src = _slice_view(ds.flux.squeeze(), cfg["view"]).transpose("lat", "lon")
    want = _encode_flux(src.values, (fl["logMin"], fl["logMax"]))[::-1, :]  # row 0 = north
    got = np.asarray(Image.open(out / fl["file"]).convert("L"))

    if got.shape != want.shape:
        return [f"flux.png is {got.shape[1]}x{got.shape[0]}, "
                f"but the view is {want.shape[1]}x{want.shape[0]}"]
    if not np.array_equal(got, want):
        fails.append(f"flux.png differs from a re-encode in {int((got != want).sum())} cells")

    levels = int(np.unique(got).size)
    drawn = float((got > 0).mean())
    print(f"flux: {got.shape[1]} x {got.shape[0]} on 10^{fl['logMin']} .. 10^{fl['logMax']}, "
          f"{levels} distinct levels, {drawn:.0%} of the view non-zero")
    print(f"  bytes identical to a re-encode of {Path(matches[0]).name}")
    if levels < 8:
        fails.append(f"flux.png holds {levels} distinct levels -- the window "
                     f"10^{fl['logMin']}..10^{fl['logMax']} does not fit this field")
    if drawn == 0:
        fails.append("flux.png is empty; every cell encodes as 'nothing here'")
    return fails


def _verify_flux_hires(meta: dict, out) -> list[str]:
    """The sources card's rasters: right shape, and an actual decomposition.

    The shape check catches the failure that is invisible on screen -- a PNG
    whose pixel dimensions disagree with the grid meta.json advertises still
    draws, just stretched, and nothing else would notice.

    The decomposition check is the one that matters. Three families are claimed
    to be what the total is made of; if a sector were assigned to two groups, or
    to none, every percentage on the card would be wrong while every image still
    looked plausible. Compared in encoded space rather than physical, because
    that is what actually ships -- so this also catches the encoder drifting
    between the total and the parts.
    """
    hi = meta.get("fluxHires")
    if not hi:
        return []

    fails = []
    grid = hi["grid"]
    decoded = {}
    for key, layer in hi["layers"].items():
        p = out / layer["file"]
        if not p.exists():
            fails.append(f"meta advertises {layer['file']} but it is missing")
            continue
        a = np.asarray(Image.open(p))
        if a.shape != (grid["nLat"], grid["nLon"]):
            fails.append(
                f"{layer['file']} is {a.shape[1]}x{a.shape[0]} but meta says "
                f"{grid['nLon']}x{grid['nLat']}"
            )
            continue
        decoded[key] = a

    # Is the grouping a partition? Pure set logic on the config, and the sharpest
    # check available: a sector in two families inflates both, a sector in none
    # silently vanishes, and neither shows up as a wrong-looking map.
    seen = {}
    for key, group in SOURCE_GROUPS.items():
        for code in group["sectors"]:
            if code in seen:
                fails.append(f"sector {code} is in both {seen[code]} and {key}")
            seen[code] = key

    # Do the shares still add up to what the card claims? Physical Tg/yr from the
    # export, not decoded pixels: the uint8 floor lifts every near-zero cell to
    # 10^logMin, so summing three decoded rasters over-counts the empty ocean by
    # more than the thing being measured.
    #
    # ⚠ Only where there is a decomposition to check. A deck whose gas has one
    # source -- Gosan's HFC-23, and the CFC-11 population prior -- ships
    # `layers` as `total` alone, and summing an empty selection gave 0.0%, which
    # this then reported as families covering none of the view. That is the
    # check misfiring on a deck that never made the claim, not a real failure:
    # `verify_export.py --site GSN` failed on it for as long as that deck has
    # shipped a single-layer card.
    if any(k in hi["layers"] for k in SOURCE_GROUPS):
        named = sum(hi["layers"][k]["shareOfView"] for k in SOURCE_GROUPS if k in hi["layers"])
        if not (99.0 <= named <= 100.01):
            fails.append(f"source families cover {named:.1f}% of the view, expected ~99.7%")

    # A family cannot exist where there is no methane at all. This is the check
    # that catches the two rasters being misaligned -- same shape, shifted
    # content -- which nothing above would notice.
    groups = [k for k in SOURCE_GROUPS if k in decoded]
    if "total" in decoded and groups:
        tot = decoded["total"]
        for key in groups:
            orphan = int(((decoded[key] > 1) & (tot == 0)).sum())
            if orphan:
                fails.append(f"{key} has {orphan} cells where the total is empty -- grids misaligned?")

    if not fails:
        # Report the grid's real step rather than the literal "0.1 deg" this
        # line used to print: the CFC-11 prior is 1 km, and a verifier that
        # states the wrong resolution is worse than one that states none.
        step = (grid["lonMax"] - grid["lonMin"]) / grid["nLon"]
        if groups:
            print(f"hi-res sources: {grid['nLon']}x{grid['nLat']} at {step:.3f} deg, "
                  f"{len(seen)} sectors in {len(SOURCE_GROUPS)} families, "
                  f"{named:.1f}% of the view")
            for key in groups:
                print(f"  {key:8s} {hi['layers'][key]['shareOfView']:5.1f}% of the view  "
                      f"({hi['layers'][key]['tgPerYear']:.3f} Tg/yr)")
        else:
            lyr = hi["layers"]["total"]
            print(f"hi-res emissions: {grid['nLon']}x{grid['nLat']} at {step:.5f} deg "
                  f"({grid['nLon'] * grid['nLat'] / 1e6:.1f} M cells), single layer "
                  f"{lyr['label']!r}, {lyr['tgPerYear'] * 1e3:.3f} Gg/yr over the view")
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="all")
    args = ap.parse_args()
    sites = list(SITES) if args.site == "all" else [args.site]

    all_fails = []
    for s in sites:
        all_fails += [f"[{s}] {f}" for f in verify(s)]

    print()
    if all_fails:
        print("FAILED")
        for f in all_fails:
            print("  -", f)
        raise SystemExit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
