"""Coarsen the 1 km population prior to ~10 km, conservatively.

Why this exists: at the deck's actual cameras the 1 km raster is not a hi-res
map, it is an aliasing machine. `DOMAIN` spans 30 degrees across ~1400 px, so a
0.00833 deg cell draws at **0.39 px** -- and the source layers draw with
`imageSmoothingEnabled = !crispSources`, which is nearest-neighbour by default.
Squeezing 4800 px into 1400 keeps about one source pixel in 3.4 per axis, so
roughly 8% of the cells survive and *which* 8% depends on the exact camera. On a
population field concentrated in cities that means towns blinking in and out as
the camera moves, for 4.5 MB.

At 1/12 degree a cell draws at **3.9 px** at `DOMAIN` and 5.8 px at `CHINA`, so
it reads as cells at the framings the deck actually uses -- which is the whole
point of the layer -- and the raster costs a few tens of KB.

**Exactly conservative, and exactly registered.** The 1 km grid is 1/120 deg, so
ten fine cells tile one coarse cell with no overlap arithmetic and no
interpolation: emission is summed as mol/s per cell and divided by the new cell
area at the end. Population is summed directly. Nothing is resampled, so this
cannot reintroduce the registration offset that made the 2002 SEDAC prior
unusable.

Run:  python scripts/coarsen_flux.py
"""

import sys
from pathlib import Path

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_web_data import REPO, _cell_area  # noqa: E402

SRC = REPO / "data/fluxes/cfc-11/cfc-11-population_EASTASIA_2016_1km.nc"
DST = REPO / "data/fluxes/cfc-11/cfc-11-population_EASTASIA_2016_10km.nc"
FACTOR = 10                      # 1/120 deg -> 1/12 deg
M_KG_PER_MOL = 0.137368
SEC_PER_YEAR = 365.25 * 24 * 3600
VIEW = {"lat": (22.0, 46.0), "lon": (105.0, 145.0)}


def blocked_edges(centres, factor):
    """Output cell centres for a `factor`-wide block sum, plus the fine-cell
    offset the blocks start at.

    ⚠ **The blocks are aligned to a round graticule, and that is not cosmetic.**
    Starting them at fine index 0 puts the coarse edges wherever the source
    happens to begin: the 1 km file starts at lat edge 15.775, so 1/12 deg
    blocks from there land at 22.025 -- 0.025 deg *inside* the view's southern
    edge of 22.0, leaving a strip of the view with no map on it. The exporter's
    `it covers the view` check catches exactly this.

    So the first block is offset to the first fine edge that is a whole multiple
    of the output step. Longitude here is already aligned (73.5 x 12 = 882);
    latitude costs 7 fine rows at 15.78 deg, far south of any view.
    """
    step = float(np.diff(centres).mean())
    edge0 = float(centres[0]) - step / 2.0
    out_step = step * factor

    # Smallest whole number of fine cells that puts the first edge on the grid.
    target = np.ceil(edge0 / out_step - 1e-9) * out_step
    offset = int(round((target - edge0) / step))
    if not 0 <= offset < factor:
        offset = 0

    n_out = int(np.ceil((len(centres) - offset) / factor))
    return target + (np.arange(n_out) + 0.5) * out_step, out_step, offset


def main():
    ds = xr.open_dataset(SRC)
    lat = ds.lat.values.astype("float64")
    lon = ds.lon.values.astype("float64")
    dlat = float(np.diff(lat).mean())
    dlon = float(np.diff(lon).mean())
    ny, nx = len(lat), len(lon)
    print(f"source  {nx} lon x {ny} lat at {dlon:.6f} deg  ({SRC.name})")

    lat_out, out_dlat, off_y = blocked_edges(lat, FACTOR)
    lon_out, out_dlon, off_x = blocked_edges(lon, FACTOR)
    ny_out, nx_out = len(lat_out), len(lon_out)
    print(f"target  {nx_out} lon x {ny_out} lat at {out_dlon:.6f} deg "
          f"({out_dlat * 111.0:.1f} km lat)")
    print(f"        block offset: {off_y} fine rows, {off_x} fine cols "
          f"(first edge {lat_out[0] - out_dlat / 2:.6f}, "
          f"{lon_out[0] - out_dlon / 2:.6f})")

    # Pad out to a whole number of blocks; the tails sit at lat 53.5 / lon 154,
    # far outside any view, and pad with zero people rather than with data.
    pad_x = nx_out * FACTOR - (nx - off_x)
    area_fine = _cell_area(lat, dlat, dlon)        # m2 per row

    emis_out = np.zeros((ny_out, nx_out), dtype="float64")   # mol/s per coarse cell
    pop_out = np.zeros((ny_out, nx_out), dtype="float64")

    for i_out in range(ny_out):
        lo = off_y + i_out * FACTOR
        hi = min(lo + FACTOR, ny)
        flux = ds.flux.isel(lat=slice(lo, hi)).values.astype("float64")
        pop = ds.population.isel(lat=slice(lo, hi)).values.astype("float64")
        flux = np.nan_to_num(flux)
        pop = np.nan_to_num(pop)

        # mol/m2/s -> mol/s per cell, so the sum is a physical quantity.
        emis = flux * area_fine[lo:hi, None]

        if off_x:
            emis = emis[:, off_x:]
            pop = pop[:, off_x:]
        if pad_x:
            emis = np.pad(emis, ((0, 0), (0, pad_x)))
            pop = np.pad(pop, ((0, 0), (0, pad_x)))
        emis_out[i_out] = emis.reshape(hi - lo, nx_out, FACTOR).sum(axis=(0, 2))
        pop_out[i_out] = pop.reshape(hi - lo, nx_out, FACTOR).sum(axis=(0, 2))

        if i_out % 100 == 0:
            print(f"  row {i_out}/{ny_out}")

    area_out = _cell_area(lat_out, out_dlat, out_dlon)
    flux_out = emis_out / area_out[:, None]

    # --- conservation checks ------------------------------------------------
    src_pop = float(ds.attrs.get("total_population", np.nan))
    print(f"\npopulation  source attr {src_pop:,.0f}  coarse {pop_out.sum():,.0f}  "
          f"({pop_out.sum() / src_pop - 1:+.6%})")

    def view_gg(f, la, lo_, dla, dlo):
        ky = (la >= VIEW["lat"][0]) & (la <= VIEW["lat"][1])
        kx = (lo_ >= VIEW["lon"][0]) & (lo_ <= VIEW["lon"][1])
        a = _cell_area(la[ky], dla, dlo)
        return (f[np.ix_(ky, kx)] * a[:, None]).sum() * M_KG_PER_MOL * SEC_PER_YEAR / 1e6

    # Re-read the source in blocks for the view total rather than holding it all.
    ky = np.where((lat >= VIEW["lat"][0]) & (lat <= VIEW["lat"][1]))[0]
    kx = np.where((lon >= VIEW["lon"][0]) & (lon <= VIEW["lon"][1]))[0]
    src_view = 0.0
    for i in range(ky[0], ky[-1] + 1, 200):
        j = min(i + 200, ky[-1] + 1)
        f = np.nan_to_num(ds.flux.isel(lat=slice(i, j)).values.astype("float64"))
        src_view += (f[:, kx] * area_fine[i:j, None]).sum()
    src_view *= M_KG_PER_MOL * SEC_PER_YEAR / 1e6
    dst_view = view_gg(flux_out, lat_out, lon_out, out_dlat, out_dlon)
    print(f"view total  source {src_view:.4f} Gg/yr  coarse {dst_view:.4f} Gg/yr  "
          f"({dst_view / src_view - 1:+.6%})")
    print(f"negatives   {int((flux_out < 0).sum())} cells")
    nz = flux_out > 0
    print(f"non-zero    {int(nz.sum()):,} of {flux_out.size:,} cells "
          f"({nz.mean():.1%}); range 10^{np.log10(flux_out[nz].min()):.2f} .. "
          f"10^{np.log10(flux_out.max()):.2f}")

    out = xr.Dataset(
        {
            "flux": (("lat", "lon"), flux_out.astype("float32")),
            "population": (("lat", "lon"), pop_out.astype("float32")),
        },
        coords={"lat": lat_out, "lon": lon_out},
        attrs={
            **ds.attrs,
            "title": "CFC-11 spread by 2016 population over EASTASIA, ~10 km",
            "resolution": f"1/12 degree ({out_dlat * 111.0:.1f} km lat), "
                          f"a {FACTOR}x{FACTOR} conservative block sum of the 1 km file",
            "regridder_used": f"none -- exact {FACTOR}x{FACTOR} block sum of "
                              f"{SRC.name}; ten 1/120 deg cells tile one 1/12 deg "
                              f"cell with no overlap arithmetic and no interpolation",
            "derived_from": SRC.name,
            "total_population": float(pop_out.sum()),
        },
    )
    out.flux.attrs = {"units": "mol/m2/s", "long_name": "CFC-11 emission flux"}
    out.population.attrs = {"units": "people per cell", "long_name": "population"}
    DST.parent.mkdir(parents=True, exist_ok=True)
    out.to_netcdf(DST)
    print(f"\nwrote {DST.name}  {DST.stat().st_size / 1e6:.1f} MB")

    # What it will actually look like on the deck.
    print("\npixels per cell at ~1400 px canvas:")
    for name, span in (("DOMAIN", 30), ("CHINA", 20), ("OCEAN", 18), ("DELTA", 6)):
        print(f"  {name:7s} span {span:2d} -> {(1400 / span) * out_dlon:.2f} px")


if __name__ == "__main__":
    main()
