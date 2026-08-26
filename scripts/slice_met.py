"""
Slice the wind out of a UM met store into one small netCDF.

A store like `data/met/EUROPE_RGL_Met_2020.zarr` is hundreds of megabytes and
holds twenty fields on five model levels. A deck needs two of them on one level.
This writes that slice to a small netCDF so re-exporting never touches the big
store, so `export_web_data.py` needs no zarr dependency, and so the original drop
can be archived or deleted.

It is optional: `export_wind()` reads the zarr store directly if you point the
site config at it instead. What this buys is speed, one less dependency, and the
two decisions below -- which level, and which timesteps -- taken once and
recorded in the file rather than re-derived on every export.

**Which height the wind is actually at.** Not what `level_height` says. The
extractor writes `wind_vertical_regrid` to say what it did, and the two stores in
this repo did different things:

    interpolate -- u/v were de-staggered onto the theta (mass) levels, so
                   `level_height` applies to them directly. Europe/Ridge Hill.
    snap        -- u/v keep their native *rho* level values and only the labels
                   were replaced, so `level_height` overstates their height. The
                   true heights are in the `wind_level_height_rho` attribute.
                   East Asia/Gosan.

Reading `level_height` blindly on a snapped store shifts every level by about a
factor of two. Ridge Hill's shipped 100 m really is 100 m; the same level index
in the East Asia store is at 76.7 m.

**Which level.** Two independent diagnostics, printed side by side, because at
one of the two sites the first one does not exist:

1. *Against the station's own anemometer* -- the `wind_speed` / `wind_direction`
   already in the footprint file. At Ridge Hill the bias crosses zero exactly at
   the level nearest the 90 m inlet, which is the confirmation that the
   de-staggering was done right.

   ⚠ Gosan has no anemometer. Its `wind_speed` and `wind_direction` are present,
   finite and **every value is exactly 0.0**. A correlation against that column
   is not weak evidence, it is no evidence, and it will still print a number. So
   the table refuses to run when the record has no variance, rather than
   reporting agreement with a constant.

2. *Against the footprint's own transport* -- always available, because it needs
   no instrument. For each hour, take the bearing of the footprint's centre of
   mass within R km of the station and compare it with the level's wind
   direction. Both say where the air came from, so the level whose wind best
   predicts where the model actually sent the plume is the level that matches the
   transport the deck is drawing. Reported at several radii: a level that wins
   only at one radius has not won anything.

**Which timesteps.** By default all of them, at the store's native cadence. But a
deck's frame axis is `fp_ds.time[::time_step]`, and `export_wind()` insists every
wind step land on one of those frames at a uniform stride. Two things break that,
and both bite at Gosan:

  * a met cadence that is odd against the frame step -- 3-hourly wind puts
    03:00 and 09:00 on a 2-hourly frame axis that only has even hours;
  * holes in the footprint record -- the East Asia footprints are missing
    28-30 June, 16 July and 24 July, and the met store is not.

`--frame-step N` drops the wind steps that no frame can hold, which is the only
place that decision can be taken: `export_wind()` has a longitude crop but no
time knob, and it raises rather than dropping. `--stride N` thins the cadence
outright. Neither is on by default, so a store that already fits is untouched.

The grid is left alone: native resolution, native extent. The crop to what the
deck actually shows is a display decision and belongs to `export_wind()`, not to
the archive.

Usage:
    python scripts/slice_met.py --site RGL --store data/met/EUROPE_RGL_Met_2020.zarr

    python scripts/slice_met.py --site GSN \
        --store data/met/EASTASIA_GSN_Met_2016/EASTASIA_GSN_Met_2016.zarr \
        --inlet 10 --level 2 --frame-step 2

    ... --level 3         # override the automatic choice
    ... --radius 400      # headline transport radius, km
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_web_data import (  # noqa: E402
    _VERT_DIMS, SITES, _pearson, _station, anemometer_is_real, angular_error,
    open_footprints, open_observations, wind_from_direction,
)

REPO = Path(__file__).resolve().parents[1]

# UM names for eastward/northward wind on a regular lat/lon grid. Written out
# under CF standard names so the slice is self-describing and the exporter's
# alias table has an obvious entry to match.
SRC_U, SRC_V = "x_wind", "y_wind"

# Radii for the transport table. The wind at the station governs the first few
# hours of travel, so the near radii are the ones that carry the argument: at
# 5 m/s, 100 km is about six hours. The whole domain is included as the control
# -- a 30-day footprint's global centre of mass is set by transport weeks old,
# and no surface wind should predict it. If a level wins there and nowhere else,
# the table is measuring noise.
TRANSPORT_RADII_KM = (100.0, 200.0, 400.0, 800.0, None)
DEFAULT_RADIUS_KM = 200.0

EARTH_R_KM = 6371.0088


def _period_tag(times) -> str:
    """`202002` for a store inside one month, `201606-201607` when it spans two."""
    t0, t1 = pd.Timestamp(times[0]), pd.Timestamp(times[-1])
    a, b = f"{t0:%Y%m}", f"{t1:%Y%m}"
    return a if a == b else f"{a}-{b}"


def wind_heights(ds, nlev: int):
    """The heights u/v are really at, and the labels the store carries.

    Returns (heights, theta_heights, basis) where `basis` is a sentence fit to be
    written into the output attrs -- the reader of the slice has to be able to
    tell which convention the number in the filename came from.
    """
    theta = np.asarray(ds.level_height.values, "f8") if "level_height" in ds.variables else None
    regrid = str(ds.attrs.get("wind_vertical_regrid", "")).strip().lower()

    rho = ds.attrs.get("wind_level_height_rho")
    if isinstance(rho, str):
        rho = json.loads(rho)
    rho = None if rho is None else np.asarray(rho, "f8")

    if regrid == "snap":
        if rho is None or len(rho) != nlev:
            raise SystemExit(
                "the store says wind_vertical_regrid='snap', which means level_height "
                "does not describe u/v, but it carries no usable wind_level_height_rho. "
                "Refusing to guess the height of the wind."
            )
        basis = ("rho (native). The store was snapped, not de-staggered, so level_height "
                 "describes the mass fields and overstates u/v -- these are the heights "
                 "from wind_level_height_rho")
        return rho, theta, basis

    if theta is None:
        raise SystemExit("the store has no level_height and no wind_level_height_rho")
    if regrid != "interpolate":
        print(f"  ! wind_vertical_regrid is {regrid or 'absent'!r}, not 'interpolate' or "
              "'snap'; assuming level_height applies to u/v")
    basis = ("theta (mass). The store's winds were de-staggered onto the theta levels "
             "at extraction, so level_height applies to them directly")
    return theta, theta, basis


def station_wind(fp_ds):
    """The station's measured wind, or None with the reason printed.

    A record that is present but constant is the failure this guards against.
    Gosan's `wind_speed` and `wind_direction` are finite for every hour and every
    one of them is exactly 0.0 -- the exporter that wrote the file had nothing to
    put there and wrote zeros rather than dropping the variables. Correlating
    against that produces a number, and the number is meaningless.

    The judgement itself is `anemometer_is_real` in the exporter, so the level
    this script picks and the `stationCorr` the export writes cannot disagree
    about whether the site has a wind record. Only the explaining is done here.
    """
    for name in ("wind_speed", "wind_direction"):
        if name not in fp_ds.variables:
            print(f"  ! the footprint file has no {name}; the anemometer table cannot run")
            return None
    sp = np.asarray(fp_ds.wind_speed.values, "f8").ravel()
    di = np.asarray(fp_ds.wind_direction.values, "f8").ravel()
    if anemometer_is_real(fp_ds):
        return sp, di

    fin = np.isfinite(sp) & np.isfinite(di)
    if fin.sum() < 24:
        print(f"  ! only {int(fin.sum())} hours of station wind; the anemometer table "
              "cannot run")
        return None
    print(f"  ! the station wind is present but constant: {int(fin.sum())} finite "
          f"hours, speed all exactly {sp[fin][0]:g}, direction all exactly "
          f"{di[fin][0]:g}.")
    print("    That is an absent record written as a placeholder, not a measurement. "
          "Skipping the anemometer table rather than correlating against a constant.")
    return None


def met_on_footprint_axis(ds, fp_ds):
    """Map every met step onto its footprint hour, or say which ones have none."""
    fp_ms = np.asarray([pd.Timestamp(t).value for t in fp_ds.time.values])
    met_ms = np.asarray([pd.Timestamp(t).value for t in ds.time.values])
    idx = np.searchsorted(fp_ms, met_ms)
    on = (idx < len(fp_ms)) & (fp_ms[np.clip(idx, 0, len(fp_ms) - 1)] == met_ms)
    return idx, on


def station_table(ds, vert, iy, ix, heights, sp_obs, di_obs, fp_idx, on):
    """Every level against the station's measured wind, on the met time axis."""
    u_col = ds[SRC_U].isel(lat=iy, lon=ix).transpose(vert, "time").values
    v_col = ds[SRC_V].isel(lat=iy, lon=ix).transpose(vert, "time").values
    sp_o = sp_obs[fp_idx[on]]
    di_o = di_obs[fp_idx[on]]

    rows = []
    for k in range(len(heights)):
        u = np.asarray(u_col[k], "f8")[on]
        v = np.asarray(v_col[k], "f8")[on]
        sp = np.hypot(u, v)
        m = np.isfinite(sp_o) & np.isfinite(sp)
        err = angular_error(wind_from_direction(u, v)[m], di_o[m])
        rows.append({
            "level": k,
            "height": float(heights[k]),
            "r_speed": _pearson(sp, sp_o),
            "bias": float(np.mean(sp[m] - sp_o[m])),
            "rmse": float(np.sqrt(np.mean((sp[m] - sp_o[m]) ** 2))),
            "dir_mean": float(err.mean()),
            "dir_median": float(np.median(err)),
        })
    return rows


def footprint_bearings(fp_ds, st_lat, st_lon, fp_idx, radii):
    """Bearing of the footprint's centre of mass, per hour, per radius.

    The centre of mass is a *circular* mean of the direction to each cell,
    weighted by that cell's sensitivity -- not the bearing of an averaged lat/lon
    point, which would bend towards the meridian for a wide footprint and would
    be plain wrong for one straddling the antimeridian, as the East Asia domain
    does at its eastern edge.
    """
    lat = np.asarray(fp_ds.lat.values, "f8")
    lon = np.asarray(fp_ds.lon.values, "f8")
    la = np.deg2rad(lat)[:, None] * np.ones(len(lon))[None, :]
    dlon = np.deg2rad(lon)[None, :] - math.radians(st_lon)
    dlon = dlon * np.ones(len(lat))[:, None]
    sla = math.radians(st_lat)

    dist = EARTH_R_KM * np.arccos(np.clip(
        math.sin(sla) * np.sin(la) + math.cos(sla) * np.cos(la) * np.cos(dlon), -1.0, 1.0))
    east = np.cos(la) * np.sin(dlon)
    north = math.cos(sla) * np.sin(la) - math.sin(sla) * np.cos(la) * np.cos(dlon)
    nrm = np.hypot(east, north)
    nrm[nrm == 0] = 1.0
    east, north = east / nrm, north / nrm

    masks = {r: (np.ones_like(dist, bool) if r is None else dist <= r) for r in radii}
    brg = {r: np.full(len(fp_idx), np.nan) for r in radii}
    mass = {r: np.zeros(len(fp_idx)) for r in radii}

    for i0 in range(0, len(fp_idx), 48):
        ii = fp_idx[i0:i0 + 48]
        blk = fp_ds.fp.isel(time=xr.DataArray(ii, dims="k")) \
                     .transpose("k", "lat", "lon").values.astype("f8")
        for r in radii:
            w = blk * masks[r][None]
            tot = w.sum(axis=(1, 2))
            b = np.degrees(np.arctan2((w * east[None]).sum(axis=(1, 2)),
                                      (w * north[None]).sum(axis=(1, 2)))) % 360.0
            b[tot <= 0] = np.nan
            brg[r][i0:i0 + len(ii)] = b
            mass[r][i0:i0 + len(ii)] = tot
    return brg, mass, {r: int(masks[r].sum()) for r in radii}


def transport_table(ds, vert, iy, ix, heights, brg, on, radii):
    """Every level against the bearing of the footprint's centre of mass."""
    u_col = ds[SRC_U].isel(lat=iy, lon=ix).transpose(vert, "time").values
    v_col = ds[SRC_V].isel(lat=iy, lon=ix).transpose(vert, "time").values

    rows = []
    for k in range(len(heights)):
        u = np.asarray(u_col[k], "f8")[on]
        v = np.asarray(v_col[k], "f8")[on]
        di = wind_from_direction(u, v)
        per_r = {}
        for r in radii:
            e = angular_error(di, brg[r])
            e = e[np.isfinite(e)]
            per_r[r] = {"mean": float(e.mean()), "median": float(np.median(e)),
                        "within45": float((e <= 45.0).mean()), "n": int(e.size)}
        rows.append({"level": k, "height": float(heights[k]),
                     "speed": float(np.hypot(u, v).mean()), "per_r": per_r})
    return rows


def choose_times(ds, fp_ds, stride: int, frame_step: int | None):
    """Which met steps to write out, and what that does to the frame stride.

    Returns (keep, note) with `keep` an index array into the met time axis.
    """
    keep = np.arange(0, ds.sizes["time"], stride)
    note = f"every {stride} step(s) of the store" if stride > 1 else "every step of the store"
    if frame_step is None:
        return keep, note

    frame_ms = np.asarray([pd.Timestamp(t).value for t in fp_ds.time.values[::frame_step]])
    met_ms = np.asarray([pd.Timestamp(t).value for t in ds.time.values])[keep]
    pos = np.searchsorted(frame_ms, met_ms)
    hit = (pos < len(frame_ms)) & (frame_ms[np.clip(pos, 0, len(frame_ms) - 1)] == met_ms)
    dropped = int((~hit).sum())
    keep = keep[hit]
    if len(keep) == 0:
        raise SystemExit(
            f"no met step lands on the frame axis fp_ds.time[::{frame_step}]. The two "
            "records do not overlap on the hour -- check --frame-step against the "
            "site's time_step."
        )

    idx = pos[hit]
    strides = np.unique(np.diff(idx))
    print(f"  --frame-step {frame_step}: {len(keep)} of {len(hit)} steps land on a frame, "
          f"{dropped} dropped")
    if len(strides) != 1:
        raise SystemExit(
            f"the surviving steps are not evenly spaced on the frame axis (strides "
            f"{strides}). export_wind() requires one stride, so this slice would be "
            "rejected. Try a different --stride."
        )
    print(f"  they sit on frames 0..{idx[-1]} every {strides[0]}, of "
          f"{len(frame_ms)} frames")
    if idx[-1] + 1 < len(frame_ms):
        print(f"  ! the last {len(frame_ms) - idx[-1] - 1} frame(s) run past the wind "
              "record; the browser clamps to the final wind step")
    note += f", then dropped to the frames of fp_ds.time[::{frame_step}] (stride {strides[0]})"
    return keep, note


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", required=True,
                    help=f"site whose footprints this wind belongs to: {', '.join(SITES)}")
    ap.add_argument("--store", required=True,
                    help="path to the UM met store, relative to the repo root")
    ap.add_argument("--out", default=None,
                    help="output path; default names itself after the level's height "
                         "and the store's period")
    ap.add_argument("--level", type=int, default=None,
                    help="model level index; default is the one nearest the inlet")
    ap.add_argument("--inlet", type=float, default=None,
                    help="inlet height in m AGL; default comes from the observation file")
    ap.add_argument("--stride", type=int, default=1,
                    help="keep every Nth met step (default 1, the native cadence)")
    ap.add_argument("--frame-step", type=int, default=None,
                    help="the deck's time_step: drop met steps that land on no frame of "
                         "fp_ds.time[::N]. Off by default")
    ap.add_argument("--radius", type=float, default=DEFAULT_RADIUS_KM,
                    help=f"headline radius for the transport table, km (default {DEFAULT_RADIUS_KM:g})")
    args = ap.parse_args()

    store = REPO / args.store
    if not store.exists():
        found = sorted(p.relative_to(REPO).as_posix()
                       for p in (REPO / "data" / "met").glob("**/*.zarr"))
        raise SystemExit(f"no met store at {store}"
                         + (f"\nstores on disk:\n  " + "\n  ".join(found) if found else ""))
    if args.site not in SITES:
        raise SystemExit(f"unknown site {args.site!r}; known: {', '.join(SITES)}")

    cfg = SITES[args.site]
    print(f"=== slice {args.store} for {args.site} ===")
    ds = xr.open_zarr(store, consolidated=True, decode_timedelta=False)
    print(f"  {dict(ds.sizes)}")
    print(f"  {pd.Timestamp(ds.time.values[0])} .. {pd.Timestamp(ds.time.values[-1])}")
    steps = np.unique(np.diff(np.asarray([pd.Timestamp(t).value for t in ds.time.values])))
    if len(steps) != 1:
        raise SystemExit(f"met time axis is not evenly spaced: {steps / 3.6e12} h")
    step_h = float(steps[0] / 3.6e12)
    print(f"  {step_h:g}-hourly")

    for name in (SRC_U, SRC_V):
        if name not in ds.data_vars:
            raise SystemExit(f"{args.store} has no {name!r}; found {sorted(ds.data_vars)}")
        if "cell_methods" in ds[name].attrs:
            print(f"  ! {name} carries cell_methods {ds[name].attrs['cell_methods']!r} -- "
                  "it may be a time mean rather than instantaneous")

    vert = next((d for d in _VERT_DIMS if d in ds[SRC_U].dims), None)
    if vert is None:
        raise SystemExit(f"{SRC_U} has no vertical dimension among {_VERT_DIMS}; "
                         f"dims are {ds[SRC_U].dims}")
    nlev = ds.sizes[vert]
    heights, theta_heights, height_basis = wind_heights(ds, nlev)
    print(f"  {nlev} levels on dim {vert!r}; wind heights are {height_basis.split('.')[0]}")
    print(f"    u/v at   {np.array2string(heights, precision=1)}")
    if theta_heights is not None and not np.allclose(heights, theta_heights):
        print(f"    labelled {np.array2string(theta_heights, precision=1)}  <-- level_height, "
              "which does NOT describe u/v here")

    # Station identity through the exporter's own `_station`, so the slice and
    # the export cannot disagree about where the inlet is. Note `fp_ds.height` is
    # NOT the inlet -- it is NAME's release height, 500 m at Ridge Hill against a
    # 90 m inlet, and reading it here picks the wrong model level by two.
    fp_ds = open_footprints(cfg["fp"])
    obs_attrs = {}
    for spec in cfg["species"]:
        _, attrs = open_observations(spec.get("obs"), spec["key"], fp_ds.time.values)
        if attrs:
            obs_attrs = attrs
            break
    st = _station(cfg, args.site, fp_ds, obs_attrs)
    st_lat, st_lon = st["lat"], st["lon"]
    inlet = args.inlet if args.inlet is not None else st["inletMagl"]
    if inlet is None:
        raise SystemExit(
            "no inlet height: the observation file has no `inlet_height_magl` and "
            "--inlet was not given. Refusing to guess -- the level choice depends on it."
        )
    print(f"  station {st_lat:.4f} N {st_lon:.4f} E, inlet {inlet:.0f} m AGL")

    lat = np.asarray(ds.lat.values, "f8")
    lon = np.asarray(ds.lon.values, "f8")
    iy = int(np.argmin(np.abs(lat - st_lat)))
    ix = int(np.argmin(np.abs(lon - st_lon)))
    print(f"  station cell: lat {lat[iy]:.4f} (i={iy}), lon {lon[ix]:.4f} (j={ix})")

    fp_idx, on = met_on_footprint_axis(ds, fp_ds)
    print(f"  {int(on.sum())} of {len(on)} met steps land on a footprint hour"
          + (f"; {int((~on).sum())} fall in the footprint record's gaps" if not on.all() else ""))
    if not on.any():
        raise SystemExit("no met step lands on a footprint hour -- the two time axes are "
                         "not compatible")

    # --- level, diagnostic 1: the station's own anemometer -------------------
    print("\n=== level agreement with the station's own wind ===")
    sw = station_wind(fp_ds)
    st_rows = None
    if sw is not None:
        st_rows = station_table(ds, vert, iy, ix, heights, sw[0], sw[1], fp_idx, on)

    # --- level, diagnostic 2: the footprint's own transport ------------------
    print("\n=== level agreement with the footprint's own transport ===")
    print("  bearing of the footprint's centre of mass within R km of the station,")
    print("  against each level's wind direction. Both say where the air came from.")
    # `--radius` is the one written into the attrs, so it has to be in the table
    # even when it is not one of the standard rungs.
    radii = tuple(sorted((r for r in set(TRANSPORT_RADII_KM) | {args.radius} if r is not None))) + (None,)
    brg, mass, ncells = footprint_bearings(fp_ds, st_lat, st_lon, fp_idx[on], radii)
    for r in radii:
        share = 100.0 * float(np.mean(mass[r] / np.where(mass[None] > 0, mass[None], np.nan)))
        print(f"    within {('%g' % r) if r else 'all':>5} km: {ncells[r]:6d} cells, "
              f"{share:5.1f}% of the footprint's mass on average")
    tr_rows = transport_table(ds, vert, iy, ix, heights, brg, on, radii)

    head = "  lvl  height " + "".join(f"  {('%g km' % r) if r else 'domain':>11}" for r in radii)
    print("\n  mean / median angular error, degrees")
    print(head)
    for row in tr_rows:
        cells = "".join(f"  {row['per_r'][r]['mean']:5.1f}/{row['per_r'][r]['median']:5.1f}"
                        for r in radii)
        print(f"   {row['level']}   {row['height']:6.1f} m{cells}")
    print("\n  share of hours agreeing within 45 degrees")
    print(head)
    for row in tr_rows:
        cells = "".join(f"  {100 * row['per_r'][r]['within45']:10.1f}%" for r in radii)
        print(f"   {row['level']}   {row['height']:6.1f} m{cells}")

    # How different the levels are from each other decides how much any of this
    # matters. If they agree to a few degrees the choice is cosmetic; the speed
    # ratio is usually the part a viewer would actually see.
    print("\n  and how different are the levels from each other, at the station?")
    u_col = ds[SRC_U].isel(lat=iy, lon=ix).transpose(vert, "time").values
    v_col = ds[SRC_V].isel(lat=iy, lon=ix).transpose(vert, "time").values
    u0 = np.asarray(u_col[0], "f8")[on]
    v0 = np.asarray(v_col[0], "f8")[on]
    d0, s0 = wind_from_direction(u0, v0), np.hypot(u0, v0)
    for k in range(nlev):
        u = np.asarray(u_col[k], "f8")[on]
        v = np.asarray(v_col[k], "f8")[on]
        s = np.hypot(u, v)
        print(f"   {k}  {heights[k]:6.1f} m   mean |dir - dir(level 0)| "
              f"{angular_error(wind_from_direction(u, v), d0).mean():5.1f} deg, "
              f"speed {s.mean():5.2f} m/s ({s.mean() / s0.mean():.2f}x level 0)")

    # --- the choice ----------------------------------------------------------
    nearest = int(np.argmin(np.abs(np.asarray(heights) - inlet)))
    chosen = nearest if args.level is None else args.level
    if not 0 <= chosen < nlev:
        raise SystemExit(f"--level {chosen} is outside 0..{nlev - 1}")

    if st_rows is not None:
        print("\n  lvl  height    r(speed)   bias   RMSE    |dir err| mean/med")
        for r in st_rows:
            mark = ("  <-- chosen" if r["level"] == chosen
                    else ("  (nearest inlet)" if r["level"] == nearest else ""))
            print(f"   {r['level']}   {r['height']:6.1f} m   {r['r_speed']:+.3f}  "
                  f"{r['bias']:+6.2f}  {r['rmse']:5.2f}   {r['dir_mean']:5.1f} / "
                  f"{r['dir_median']:5.1f}{mark}")
        best_rmse = min(st_rows, key=lambda r: r["rmse"])["level"]
        if best_rmse != chosen:
            print(f"  ! level {best_rmse} fits the station better than the chosen {chosen}. "
                  "That is worth understanding before shipping it.")

    best_tr = min(tr_rows, key=lambda r: r["per_r"][args.radius]["median"])["level"]
    print(f"\n  nearest the {inlet:.0f} m inlet: level {nearest} ({heights[nearest]:.1f} m)")
    print(f"  best transport agreement at {args.radius:g} km: level {best_tr} "
          f"({heights[best_tr]:.1f} m)")
    if best_tr != chosen:
        print(f"  ! level {best_tr} predicts the footprint's transport better than the "
              f"chosen {chosen}. That is worth understanding before shipping it.")

    pick_tr = tr_rows[chosen]["per_r"][args.radius]
    print(f"\n=== writing level {chosen} ({heights[chosen]:.1f} m) ===")

    keep, time_note = choose_times(ds, fp_ds, args.stride, args.frame_step)
    out_times = ds.time.values[keep]
    out_steps = np.unique(np.diff(np.asarray([pd.Timestamp(t).value for t in out_times]))) / 3.6e12
    print(f"  {len(keep)} of {ds.sizes['time']} steps: {time_note}")
    print(f"  output cadence {np.array2string(out_steps, precision=0)} h"
          + ("" if len(out_steps) == 1 else "  (gaps, from the footprint record)"))

    u = ds[SRC_U].isel({vert: chosen}).isel(time=keep).transpose("time", "lat", "lon")
    v = ds[SRC_V].isel({vert: chosen}).isel(time=keep).transpose("time", "lat", "lon")
    uu = u.values.astype("float32")
    vv = v.values.astype("float32")
    if not (np.isfinite(uu).all() and np.isfinite(vv).all()):
        raise SystemExit("the wind field has missing values; the writer assumes it does not")
    comp_max = max(abs(uu).max(), abs(vv).max())
    print(f"  {uu.shape}, max |component| {comp_max:.2f} m/s, "
          f"max speed {np.hypot(uu, vv).max():.2f} m/s")

    # The number the site config needs, and it is *not* the one above.
    # `export_wind()` takes its maximum after cropping to the view, so the value
    # to configure is the maximum inside the camera's box -- which is smaller,
    # and every m/s of headroom is quantisation thrown away. Printed at full grid
    # too, since that is the ceiling if the view is ever widened.
    ky = (np.asarray(ds.lat.values, "f8") >= cfg["view"]["lat"][0]) & \
         (np.asarray(ds.lat.values, "f8") <= cfg["view"]["lat"][1])
    kx = (np.asarray(ds.lon.values, "f8") >= cfg["view"]["lon"][0]) & \
         (np.asarray(ds.lon.values, "f8") <= cfg["view"]["lon"][1])
    view_max = float(max(np.abs(uu[:, ky][:, :, kx]).max(), np.abs(vv[:, ky][:, :, kx]).max()))
    print(f"  inside {args.site}'s view ({int(kx.sum())} lon x {int(ky.sum())} lat): "
          f"max |component| {view_max:.2f} m/s")
    print(f"  -> uvMax {math.ceil(view_max):g} for the config "
          f"({2 * math.ceil(view_max) / 254:.3f} m/s step); "
          f"{math.ceil(comp_max):g} would cover the whole grid")

    sigma = None
    if "sigma" in ds.variables:
        sigma = float(np.asarray(ds.sigma.values, "f8").ravel()[chosen])

    out_ds = xr.Dataset(
        {
            "eastward_wind": (("time", "lat", "lon"), uu,
                              {"units": "m s-1", "standard_name": "eastward_wind",
                               "long_name": f"eastward wind at {heights[chosen]:.1f} m"}),
            "northward_wind": (("time", "lat", "lon"), vv,
                               {"units": "m s-1", "standard_name": "northward_wind",
                                "long_name": f"northward wind at {heights[chosen]:.1f} m"}),
        },
        coords={"time": out_times,
                "lat": ("lat", np.asarray(ds.lat.values, "float32"), dict(ds.lat.attrs)),
                "lon": ("lon", np.asarray(ds.lon.values, "float32"), dict(ds.lon.attrs))},
    )
    # Provenance lives in the file, not in a README: this slice becomes what
    # verify_export.py calls "the source", so what it is and how it was chosen
    # has to travel with it.
    short_name = str(st["name"]).split(",")[0].strip()
    attrs = {
        "title": f"UM wind at {heights[chosen]:.1f} m, sliced for the {short_name} story deck",
        "source_store": args.store,
        "source_variables": f"{SRC_U}, {SRC_V}",
        "source_title": str(ds.attrs.get("title", "")),
        "source_history": str(ds.attrs.get("history", "")),
        "level_index": chosen,
        "level_height_m": float(heights[chosen]),
        "level_height_basis": height_basis,
        "level_selection": ("nearest to the inlet, confirmed against the diagnostics above"
                            if args.level is None else "set by hand with --level"),
        "inlet_magl": inlet,
        "station_lat": st_lat,
        "station_lon": st_lon,
        # The transport diagnostic, which needs no instrument and so exists at
        # every site. Recorded for the chosen level at the headline radius.
        "transport_radius_km": args.radius,
        "transport_dir_err_mean_deg": round(pick_tr["mean"], 3),
        "transport_dir_err_median_deg": round(pick_tr["median"], 3),
        "transport_within_45deg": round(pick_tr["within45"], 4),
        "transport_hours": pick_tr["n"],
        "time_selection": time_note,
        "time_step_hours": float(out_steps[0]) if len(out_steps) == 1 else float(np.min(out_steps)),
        "source_time_step_hours": step_h,
        "instantaneous": "yes -- neither source variable carries cell_methods",
        "created_by": "scripts/slice_met.py",
        "created_at": dt.datetime.now().isoformat(timespec="seconds"),
    }
    if theta_heights is not None:
        attrs["level_height_theta_m"] = float(theta_heights[chosen])
    if sigma is not None:
        attrs["level_sigma"] = sigma
    if st_rows is not None:
        pick = st_rows[chosen]
        attrs.update({
            "station_r_speed": round(pick["r_speed"], 4),
            "station_bias_ms": round(pick["bias"], 4),
            "station_rmse_ms": round(pick["rmse"], 4),
            "station_dir_err_mean_deg": round(pick["dir_mean"], 3),
            "station_dir_err_median_deg": round(pick["dir_median"], 3),
        })
    else:
        # Said out loud in the file, because its absence is a fact about the site
        # and not an oversight in the slice.
        attrs["station_wind"] = ("absent -- the footprint file's wind_speed and "
                                 "wind_direction are a constant placeholder, so no "
                                 "anemometer comparison was possible")
    out_ds.attrs = attrs

    # The filename carries the height and the period, so a re-slice at another
    # level, or of another month, cannot quietly overwrite a file whose name
    # still claims the old one.
    rel = args.out or (f"data/met/{args.site}_wind_{heights[chosen]:.0f}m_"
                       f"{_period_tag(out_times)}.nc")
    path = REPO / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    enc = {v_: {"zlib": True, "complevel": 4, "dtype": "float32", "_FillValue": None}
           for v_ in ("eastward_wind", "northward_wind")}
    out_ds.to_netcdf(path, encoding=enc)
    ds.close()
    print(f"  wrote {rel}  {path.stat().st_size / 1e6:.1f} MB "
          f"(store is {sum(f.stat().st_size for f in store.rglob('*') if f.is_file()) / 1e6:.0f} MB)")
    print(f"  point SITES[{args.site!r}]['wind']['path'] at it, then re-export")


if __name__ == "__main__":
    main()
