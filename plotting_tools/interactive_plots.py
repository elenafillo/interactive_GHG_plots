import numpy as np
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from matplotlib.widgets import Slider
import matplotlib.colors as mcolors
import cartopy.crs as ccrs
 

# ── Colour palette ─────────────────────────────────────────────────────────────
_BLUE   = "#2C7BB6"
_RED    = "#D7191C"
_BG     = "#1C1C2E"      # deep navy background
_PANEL  = "#252540"      # slightly lighter panel fill
_TEXT   = "#252540"
_MUTED  = "#545464"
_ACCENT = "#5BE8C8"      # teal accent for the slider

def plot_timeseries(ax, hourly_means, time_idx=None, subset=None,site=None):
    """
    Draw (or redraw) the CH₄ timeseries on *ax* with a marker at *time_idx*.
 
    Parameters
    ----------
    ax           : matplotlib Axes
    hourly_means : xarray Dataset with 'time' and 'ch4' variables
    time_idx     : int  – highlighted point
    subset       : (start_idx, end_idx) tuple controlling the visible window
    site         : str, optional – site name for the plot title
    """
    ax.cla()
    #ax.set_facecolor(_PANEL)
    if subset is not None and isinstance(subset[0], (int, np.integer)):
        subset = (hourly_means.time.values[subset[0]], hourly_means.time.values[subset[1]])
    if subset is not None:
        ts = hourly_means.sel(time=slice(subset[0], subset[1]))
    else:
        ts = hourly_means

    ts.ch4.plot(
        ax=ax,
        color=_BLUE,
        linewidth=1.4,
        label="CH₄",
    )
    if time_idx is not None:
        # if its an int, extract the corresponding time value for the title
        if isinstance(time_idx, int):
                timestamp = str(hourly_means.time.values[time_idx])
        else:
                timestamp = str(time_idx)
        print(timestamp)
        # check that timestamp is within plotted, if not, skip the marker
        try:
            ax.scatter(
                ts.time.sel(time=timestamp),
                ts.ch4.sel(time=timestamp),
                color=_RED,
                zorder=5,
                s=70,
                label="Selected timestep",
                edgecolors="white",
                linewidths=0.6,
            )
        except KeyError:
            pass
    
    ax.set_xlabel("Date/Time (UTC)", fontsize=9, color=_PANEL)
    ax.set_ylabel("CH₄ (ppb)",  fontsize=9, color=_PANEL)
    ax.set_title(f"Observed CH₄ Timeseries" if site is None else f"Observed CH₄ Timeseries at {site}", fontsize=10, fontweight="bold", color=_PANEL)
    ax.legend(fontsize=8, framealpha=0.3, facecolor=_BG, edgecolor=_PANEL,
              labelcolor=_PANEL)
    ax.grid(True, alpha=0.15, linestyle="--", color=_PANEL)
 
    for spine in ax.spines.values():
        spine.set_edgecolor(_PANEL)
        spine.set_alpha(0.4)
 
    ax.tick_params(colors=_PANEL, labelsize=8)
 
 

def plot_footprint(ax, fps, hourly_means, time_idx, slice_dict=None, release_coords=None, cmap="Reds", site=None):
    """
    Draw (or redraw) a log₁₀ footprint on *ax*.
 
    Parameters
    ----------
    ax           : cartopy GeoAxes with PlateCarree projection
    fps          : xarray Dataset containing an 'fp' DataArray
    hourly_means : xarray Dataset containing a 'time' coordinate (used for title)
    time_idx     : int  – index along the time dimension
    slice_dict   : dict passed to ``.sel()`` for spatial subsetting, e.g.
                   {"lat": slice_uk["lat"], "lon": slice_uk["lon"]}
                   Pass ``None`` for the full domain.
    release_coords : dict with 'lat' and 'lon' keys for marking the release location
    cmap         : str or matplotlib Colormap for the footprint
        site         : str, optional – site name for the plot title
    """
    ax.cla()
    #ax.set_facecolor(_PANEL)
 
    fp = fps.fp.isel(time=time_idx)
    if slice_dict is not None:
        fp = fp.sel(**slice_dict)
    
    cmap = plt.get_cmap(cmap)
    colors = cmap(np.linspace(0, 1, 256))
    # colors[:50, 3] = 0.6
    # colors[50:100, 3] = 0.8
    # #colors[100:150, 3] = 0.7
    # colors[100:, 3] = 1.0

    
    alpha_cmap = mcolors.ListedColormap(colors)
    
    np.log10(fp).plot(
        ax=ax,
        transform=ccrs.PlateCarree(),
        cmap=alpha_cmap,
        add_colorbar=False,
    )

    if release_coords is not None:
        ax.scatter(
            release_coords["lon"],
            release_coords["lat"],
            color=_RED,
            s=30,
            edgecolors="white",
            linewidths=0.8,
            transform=ccrs.PlateCarree(),
            zorder=5,
            label=f"{site}" if site is not None else "Release Location",
        )
        ax.legend(fontsize=8, framealpha=0.3, facecolor=_BG, edgecolor=_PANEL,
                  labelcolor=_PANEL, loc="upper right")
 
    ax.coastlines(linewidth=0.8, color=_MUTED)
 
    time_str = str(hourly_means.time.values[time_idx])[:13]
    label    = "Zoomed" if slice_dict is not None else "Full Domain"
 
    ax.set_title(
        f"{label}  ·  {time_str} UTC",
        fontsize=9,
        fontweight="bold",
        color=_TEXT,
        pad=5,
    )


# ── Main figure ────────────────────────────────────────────────────────────────
 
def make_figure(fps, hourly_means, slice_uk, subset=None, time_idx=0, interactive=True, figsize=(10, 8), release_coords=None, site=None):
    """
    Build a three-panel footprint figure, optionally with a timestep slider.
 
    Layout
    ------
    ┌──────────────┬──────────────┐
    │  Zoomed FP   │  Full FP     │   ← row 0 : cartopy map axes
    ├──────────────┴──────────────┤
    │       CH₄ timeseries        │   ← row 1 : standard axes
    └─────────────────────────────┘
          [ slider ]  ← interactive=True only
 
    Parameters
    ----------
    fps         : xarray Dataset  – must contain an 'fp' DataArray (time, lat, lon)
    hourly_means: xarray Dataset  – must contain 'time' and 'ch4'
    slice_uk    : dict            – {"lat": slice(...), "lon": slice(...)}
    subset      : (int, int)      – (start_idx, end_idx) for the timeseries window
    time_idx    : int             – timestep to display (or slider starting position)
    interactive : bool            – if True, attach a Slider widget
    release_coords : dict          – coordinates for the release location
    site        : str             – site name for the title

    Returns
    -------
    fig    : matplotlib Figure
    slider : matplotlib Slider, or None if interactive=False
 
    Notes
    -----
    Interactive mode requires the widget backend in Jupyter:
        %matplotlib widget   # pip install ipympl
    Keep the returned *slider* reference alive — if it gets garbage-collected
    the widget stops responding.
    """
    n_times = fps.fp.sizes["time"]
 
    # ── Canvas ──────────────────────────────────────────────────────────────
    fig = plt.figure(figsize=figsize)
    #fig.patch.set_facecolor(_BG)
 
    # Reserve extra bottom margin only when the slider is present
    bottom_margin = 0.16 if interactive else 0.08
    fig.subplots_adjust(
        left=0.05, right=0.97,
        top=0.92,  bottom=bottom_margin,
        hspace=0.55, wspace=0.22,
    )
 
    # ── Grid ────────────────────────────────────────────────────────────────
    gs = gridspec.GridSpec(2, 2, figure=fig, height_ratios=[1.4, 1], width_ratios=[1.1, 1])
 
    ax_zoom = fig.add_subplot(gs[0, 0], projection=ccrs.PlateCarree())
    ax_full = fig.add_subplot(gs[0, 1], projection=ccrs.PlateCarree())
    ax_ts   = fig.add_subplot(gs[1, :])
 
    # ── Initial draw ────────────────────────────────────────────────────────
    plot_footprint(
        ax_zoom, fps, hourly_means, time_idx,
        slice_dict={"lat": slice_uk["lat"], "lon": slice_uk["lon"]},
        release_coords=release_coords, site=site
    )
    plot_footprint(ax_full, fps, hourly_means, time_idx, release_coords=release_coords, site=site)
    plot_timeseries(ax_ts, hourly_means, time_idx, subset, site=site)
 
    # ── Title ───────────────────────────────────────────────────────────────
    # fig.suptitle(
    #     "Atmospheric Footprint Explorer",
    #     fontsize=14, fontweight="bold",
    #     color=_TEXT, y=0.97,
    # )
 
    # ── Slider (optional) ───────────────────────────────────────────────────
    if not interactive:
        return fig, None
 
    ax_slider = fig.add_axes([0.15, 0.055, 0.70, 0.022])
    ax_slider.set_facecolor(_PANEL)
 
    slider = Slider(
        ax=ax_slider,
        label="Timestep",
        valmin=0,
        valmax=n_times - 1,
        valinit=time_idx,
        valstep=1,
        color=_ACCENT,
    )
    slider.label.set_color(_TEXT)
    slider.label.set_fontsize(9)
    slider.valtext.set_color(_TEXT)
    slider.valtext.set_fontsize(9)
 
    def update(val):
        t = int(slider.val)
        plot_footprint(
            ax_zoom, fps, hourly_means, t,
            slice_dict={"lat": slice_uk["lat"], "lon": slice_uk["lon"]},
            release_coords=release_coords
        )
        plot_footprint(ax_full, fps, hourly_means, t, release_coords=release_coords, site=site)
        plot_timeseries(ax_ts, hourly_means, t, subset, site=site)
        fig.canvas.draw_idle()
 
    slider.on_changed(update)
 
    return fig, slider

