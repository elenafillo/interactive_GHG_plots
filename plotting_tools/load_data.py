import glob
import xarray as xr


def load_fp(site, date, height):
    """Load footprint data for a given site, date, and height."""
    fp_path = f"data/fps/{site}*{height}_*{date}.nc"
    fp_files = glob.glob(fp_path)
    if not fp_files:
        raise FileNotFoundError(f"No footprint files found for at {fp_path}")
    fp_ds = xr.open_mfdataset(fp_files, combine="by_coords")
    return fp_ds

def load_obs(site, date, height, mode="full"):
    if mode == "hourly":
        prefix = "obs_hourly"
    else:
        prefix = "obs"

    """Load observation data for a given site, date, and height."""
    obs_path = f"data/obs/{prefix}_{site}_{height}_{date}.nc"
    obs_files = glob.glob(obs_path)
    if not obs_files:
        raise FileNotFoundError(f"No observation files found for {obs_path}")
    obs_ds = xr.open_mfdataset(obs_files, combine="by_coords")
    return obs_ds


def load_flux(_DOMAIN, _DATE, species="ch4"):
    """Load flux data for a given site and date."""
    flux_path = f"data/fluxes/{species}*_{_DOMAIN}_{_DATE}.nc"
    flux_files = glob.glob(flux_path)
    if len(flux_files) > 1:
        print(f"Warning: multiple flux files found for {flux_path}. Using the first one: {flux_files[0]}")
        flux_files = [flux_files[0]]
    if not flux_files:
        raise FileNotFoundError(f"No flux files found for {flux_path}")
    flux_ds = xr.open_mfdataset(flux_files, combine="by_coords")
    return flux_ds