"""
Slice the wind out of the UM met store into one small netCDF.

The store `data/met/EUROPE_RGL_Met_2020.zarr` is 363 MB and holds twenty fields
on five model levels. The deck needs two of them on one level. This writes that
slice to a ~20 MB netCDF so re-exporting never touches the big store, so
`export_web_data.py` needs no zarr dependency, and so the original drop can be
archived or deleted.

It is optional: `export_wind()` reads the zarr store directly if you point the
site config at it instead. What this buys is speed and one less dependency.

**Which level.** The store's winds were de-staggered onto theta levels at
extraction, so `level_height` applies to them directly. Rather than trusting the
nearest-to-inlet level blindly, this prints every level against the station's own
measured wind -- the same `wind_speed` / `wind_direction` already in the
footprint file -- and records the chosen level's agreement in the output attrs.
At Ridge Hill the bias crosses zero exactly at the level nearest the 90 m inlet,
which is the confirmation that the de-staggering was done right.

The grid is left alone: native resolution, native extent, all 232 timesteps. The
crop to what the deck actually shows is a display decision and belongs to
`export_wind()`, not to the archive.

Usage:
    python scripts/slice_met.py
    python scripts/slice_met.py --level 3        # override the automatic choice
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_web_data import (  # noqa: E402
    SITES, _pearson, _station, angular_error, open_footprints, open_observations,
    wind_from_direction,
)

REPO = Path(__file__).resolve().parents[1]

DEFAULT_STORE = "data/met/EUROPE_RGL_Met_2020.zarr"

# UM names for eastward/northward wind on a regular lat/lon grid. Written out
# under CF standard names so the slice is self-describing and the exporter's
# alias table has an obvious entry to match.
SRC_U, SRC_V = "x_wind", "y_wind"


def level_table(ds, fp_ds, st_lat, st_lon):
    """Every level against the station's measured wind, on the met time axis.

    Returns (rows, times_index) where `times_index` maps each met step onto its
    footprint hour -- which doubles as the assertion that the two axes line up
    at all.
    """
    lat = np.asarray(ds.lat.values, "f8")
    lon = np.asarray(ds.lon.values, "f8")
    iy = int(np.argmin(np.abs(lat - st_lat)))
    ix = int(np.argmin(np.abs(lon - st_lon)))
    print(f"  station cell: lat {lat[iy]:.4f} (i={iy}), lon {lon[ix]:.4f} (j={ix})")

    fp_ms = np.asarray([pd.Timestamp(t).value for t in fp_ds.time.values])
    met_ms = np.asarray([pd.Timestamp(t).value for t in ds.time.values])
    idx = np.searchsorted(fp_ms, met_ms)
    on_axis = (idx < len(fp_ms)) & (fp_ms[np.clip(idx, 0, len(fp_ms) - 1)] == met_ms)
    if not on_axis.all():
        raise SystemExit(
            f"{int((~on_axis).sum())} of {len(met_ms)} met steps do not land on a "
            "footprint hour -- the two time axes are not compatible"
        )
    print(f"  all {len(met_ms)} met steps land on a footprint hour "
          f"(footprint indices {idx[0]}, {idx[1]}, {idx[2]} ...)")

    sp_obs = np.asarray(fp_ds.wind_speed.values, "f8")[idx]
    di_obs = np.asarray(fp_ds.wind_direction.values, "f8")[idx]

    u_col = ds[SRC_U].isel(lat=iy, lon=ix).values
    v_col = ds[SRC_V].isel(lat=iy, lon=ix).values
    heights = np.asarray(ds.level_height.values, "f8")

    rows = []
    for k in range(ds.sizes["levels"]):
        u, v = np.asarray(u_col[k], "f8"), np.asarray(v_col[k], "f8")
        sp = np.hypot(u, v)
        di = wind_from_direction(u, v)
        m = np.isfinite(sp_obs) & np.isfinite(sp)
        err = angular_error(di[m], di_obs[m])
        rows.append({
            "level": k,
            "height": float(heights[k]),
            "r_speed": _pearson(sp, sp_obs),
            "bias": float(np.mean(sp[m] - sp_obs[m])),
            "rmse": float(np.sqrt(np.mean((sp[m] - sp_obs[m]) ** 2))),
            "dir_mean": float(err.mean()),
            "dir_median": float(np.median(err)),
        })
    return rows, idx


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default="RGL", help="site whose footprint supplies the station wind")
    ap.add_argument("--store", default=DEFAULT_STORE)
    ap.add_argument("--out", default=None,
                    help="output path; default names itself after the level's height")
    ap.add_argument("--level", type=int, default=None,
                    help="model level index; default is the one nearest the inlet")
    ap.add_argument("--inlet", type=float, default=None,
                    help="inlet height in m AGL; default comes from the observation file")
    args = ap.parse_args()

    store = REPO / args.store
    if not store.exists():
        raise SystemExit(f"no met store at {store}")

    cfg = SITES[args.site]
    print(f"=== slice {args.store} ===")
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

    print("\n=== level agreement with the station's own wind ===")
    rows, _ = level_table(ds, fp_ds, st_lat, st_lon)
    heights = np.asarray([r["height"] for r in rows])
    nearest = int(np.argmin(np.abs(heights - inlet)))
    chosen = nearest if args.level is None else args.level
    if not 0 <= chosen < len(rows):
        raise SystemExit(f"--level {chosen} is outside 0..{len(rows) - 1}")

    print("  lvl  height    r(speed)   bias   RMSE    |dir err| mean/med")
    for r in rows:
        mark = "  <-- chosen" if r["level"] == chosen else ("  (nearest inlet)" if r["level"] == nearest else "")
        print(f"   {r['level']}   {r['height']:6.1f} m   {r['r_speed']:+.3f}  {r['bias']:+6.2f}  "
              f"{r['rmse']:5.2f}   {r['dir_mean']:5.1f} / {r['dir_median']:5.1f}{mark}")

    best_rmse = min(rows, key=lambda r: r["rmse"])["level"]
    if best_rmse != chosen:
        print(f"  ! level {best_rmse} fits the station better than the chosen {chosen}. "
              "That is worth understanding before shipping it.")

    pick = rows[chosen]
    print(f"\n=== writing level {chosen} ({pick['height']:.1f} m) ===")
    u = ds[SRC_U].isel(levels=chosen).transpose("time", "lat", "lon")
    v = ds[SRC_V].isel(levels=chosen).transpose("time", "lat", "lon")
    uu = u.values.astype("float32")
    vv = v.values.astype("float32")
    if not (np.isfinite(uu).all() and np.isfinite(vv).all()):
        raise SystemExit("the wind field has missing values; the writer assumes it does not")
    print(f"  {uu.shape}, max |component| {max(abs(uu).max(), abs(vv).max()):.2f} m/s, "
          f"max speed {np.hypot(uu, vv).max():.2f} m/s")

    out_ds = xr.Dataset(
        {
            "eastward_wind": (("time", "lat", "lon"), uu,
                              {"units": "m s-1", "standard_name": "eastward_wind",
                               "long_name": f"eastward wind at {pick['height']:.1f} m"}),
            "northward_wind": (("time", "lat", "lon"), vv,
                               {"units": "m s-1", "standard_name": "northward_wind",
                                "long_name": f"northward wind at {pick['height']:.1f} m"}),
        },
        coords={"time": ds.time.values,
                "lat": ("lat", np.asarray(ds.lat.values, "float32"), dict(ds.lat.attrs)),
                "lon": ("lon", np.asarray(ds.lon.values, "float32"), dict(ds.lon.attrs))},
    )
    # Provenance lives in the file, not in a README: this slice becomes what
    # verify_export.py calls "the source", so what it is and how it was chosen
    # has to travel with it.
    out_ds.attrs = {
        "title": f"UM wind at {pick['height']:.1f} m, sliced for the Ridge Hill story deck",
        "source_store": args.store,
        "source_variables": f"{SRC_U}, {SRC_V}",
        "source_title": str(ds.attrs.get("title", "")),
        "source_history": str(ds.attrs.get("history", "")),
        "level_index": chosen,
        "level_height_m": pick["height"],
        "level_sigma": float(np.asarray(ds.sigma.values, "f8")[chosen]),
        "level_selection": ("nearest to the inlet, confirmed against the station's measured wind"
                            if args.level is None else "set by hand with --level"),
        "inlet_magl": inlet,
        "station_lat": st_lat,
        "station_lon": st_lon,
        "station_r_speed": round(pick["r_speed"], 4),
        "station_bias_ms": round(pick["bias"], 4),
        "station_rmse_ms": round(pick["rmse"], 4),
        "station_dir_err_mean_deg": round(pick["dir_mean"], 3),
        "station_dir_err_median_deg": round(pick["dir_median"], 3),
        "time_step_hours": step_h,
        "instantaneous": "yes -- neither source variable carries cell_methods",
        "created_by": "scripts/slice_met.py",
        "created_at": dt.datetime.now().isoformat(timespec="seconds"),
    }

    # The filename carries the height, so a re-slice at another level cannot
    # quietly overwrite a file whose name still claims the old one.
    rel = args.out or f"data/met/{args.site}_wind_{pick['height']:.0f}m_202002.nc"
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
