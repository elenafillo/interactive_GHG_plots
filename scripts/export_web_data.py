"""
Export footprint / observation / flux data into compact web assets.

The design decision behind this file: we pre-render the *data*, not the *pixels*.
Cartopy PNG frames would bake in the colormap, the zoom level and the projection,
and swapping site (RGL -> GSN) or restyling would mean re-rendering everything.
Instead we ship the footprint field itself as a log-scaled uint8 sprite atlas that
the browser decodes once into a typed array. From there any timestep blits to a
<canvas> in ~1 ms, the colormap and zoom stay live, and the same pipeline works
unchanged for another site.

Outputs (into the site's output directory):
    fp_atlas.png      footprint tensor, one tile per timestep, log10-scaled uint8
    meta.json         grid, time axis, scaling constants, station, atlas layout
    series.json       observations + forward-modelled enhancement + met + land
                      fraction + beacon levels (when the site has beacons)
    flux.png          emissions on the same grid, log10-scaled uint8 (when available)
    flux_hi.png       the same emissions at 0.1 deg, for the deck's sources card
    src_*.png         one raster per source family, same grid and scale as flux_hi
    basemap.json      Natural Earth land, coastlines and borders, clipped

Both observations and emissions are optional. Gosan currently has footprints but
no matching observations and no emissions inventory, and the export degrades to
whatever the data supports rather than failing.

Usage:
    python scripts/export_web_data.py --site RGL
    python scripts/export_web_data.py --site GSN
    python scripts/export_web_data.py --site all
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr
from PIL import Image

REPO = Path(__file__).resolve().parents[1]

# Emissions colour scale, matching the notebook's flux plot.
#
# These are CH4's, and they stay the default so Ridge Hill's export is byte for
# byte what it was. A site whose gas lives somewhere else on the scale overrides
# them in its `flux_hires` spec -- see `logRange` there. The window is wide on
# purpose: it decides what the PNG can *encode*, and re-cutting it costs a full
# re-export, while which part of it the eye gets is `SOURCE_DISPLAY` in
# palette.js and is tunable live in the browser.
FLUX_LOG_MIN, FLUX_LOG_MAX = -11.5, -7.0

# The raw 0.1 deg EDGAR files are kg/m2/s; everything else in this pipeline is
# mol/m2/s, which is what the ACRG-regridded files carry. So every raw file has
# to be divided by the molar mass of *its own* gas, and getting that wrong is
# silent -- the map still draws, just wrong by the ratio of the two masses.
M_KG_PER_MOL = {
    "ch4": 0.016043,
    "hfc-23": 0.070014,   # CHF3
    "cfc-11": 0.137368,   # CCl3F
}

# mole fraction -> the unit the observations are reported in.
#
# `forward_model` returns footprint x flux, which is mol/mol, and it has to land
# on the same axis as the measurements it is compared against. Methane is
# reported in parts per *billion* and the halocarbons in parts per *trillion* --
# a factor of 1000, and the most dangerous kind of wrong, because a modelled
# series 1000x too small still draws: it is a flat line along the bottom of the
# chart, which reads as "the inventory says there is nothing here" rather than
# as a bug. The baseline is derived from obs - modelled, so it would be wrong
# too, and the smell bar sits on the baseline.
#
# Keyed off `spec["units"]`, the same string the chart labels its axis with, so
# a species cannot be labelled ppt and modelled as ppb.
PPX_PER_MOL_MOL = {"ppb": 1e9, "ppt": 1e12}

# The source families Card 3 steps through, as EDGAR v7 sector codes.
#
# Grouped for a family audience rather than for IPCC reporting: the slide answers
# "what is making it", not "which inventory line is it on". The three cover 99.7%
# of the RGL view. Transport (TNR_Other, TNR_Ship, TRO_noRES) is deliberately
# left unassigned -- it is the remaining 0.3%, and a fourth colour for 0.3% would
# cost the reader more than it tells them.
SOURCE_GROUPS = {
    "farming": {
        "label": "Cows and farming",
        "sectors": ["ENF", "MNM", "AGS", "AWB"],
    },
    "waste": {
        "label": "Rubbish and sewage",
        "sectors": ["SWD_LDF", "SWD_INC", "WWT"],
    },
    "fossil": {
        # Leaking and burning in one colour. PRO/FFF/REF_TRF is gas escaping
        # uncombusted; ENE/RCO/IND/IRO/CHE is what survives a flame. Two
        # mechanisms, one substance -- the difference gets said out loud rather
        # than drawn, because splitting it would need a fourth colour to make a
        # distinction the map itself cannot show.
        "label": "Oil and gas",
        "sectors": ["PRO", "FFF", "REF_TRF", "ENE", "RCO", "IND", "IRO", "CHE"],
    },
}

# In the 0.1 deg set but in no family: 0.3% of the view, and deliberately given
# no colour of its own. Still summed into the total, so "all methane" is all of
# it and the families are a genuine subset rather than a rounding of one.
UNGROUPED_SECTORS = ["TRO_noRES", "TNR_Ship", "TNR_Other"]

# Footprint sensitivity, log10, at or above which a plant marker counts as having
# the plume overhead. A fixed *physical* value rather than a fraction of each
# site's encoded range, so "lit" means the same sensitivity in 2016 as in 2021 and
# the two builds stay comparable. Tying it to the display range instead would be
# worse than arbitrary: `logDisplayMax` is the 99.9th percentile of the whole
# field, which is set by cells a few km from the inlet on Jeju, and no cell over a
# Chinese plant ever gets near it -- a threshold there would never fire at all.
FACTORY_LIT_LOG10 = -2.5

# Per-site configuration. `view` is the region the camera flies through: wide
# enough to show clean marine air arriving from one side and the continental
# source region on the other, which is the comparison the whole piece rests on.
# A site carries one footprint archive and any number of measured species on
# top of it. That split matters: the atlas is megabytes and depends only on the
# transport, while each extra species is a few tens of kilobytes of mole
# fractions. Gosan's CFC-11 and HFC-23 are the same air sampled by the same
# instrument, so they share one atlas rather than duplicating it.
SITES = {
    "RGL": {
        "fp": "data/fps/RGL-UKV_90magl_EUROPE_202002.nc",
        "species": [
            {
                "key": "ch4",
                "label": "CH₄",
                "units": "ppb",
                "obs": "data/obs/obs_hourly_RGL_90magl_202002.nc",
                "flux": "data/fluxes/ch4-edgar-annual-total_EUROPE_2021.nc",
            },
        ],
        # Raw 0.1 deg EDGAR, for Card 3's emissions maps only. Optional in
        # exactly the way `flux` and `factories` are: absent directory means
        # meta.fluxHires is null and every consumer draws nothing.
        "flux_hires": {
            "dir": "data/fluxes/edgar_v7_0.1deg",
            "totals": "totals/v7.0_FT2021_CH4_2021_TOTALS.0.1x0.1.nc",
            "sectors": "sectors_2021/v7.0_FT2021_CH4_2021_{code}.0.1x0.1.nc",
            "year": 2021,
        },
        # Wind for the story deck's arrows and drifting parcels. Optional like
        # everything else here: no file means meta.wind is null and the two wind
        # acts show their framing with a placeholder instead of being dropped.
        #
        # `path` takes the slice written by scripts/slice_met.py, or the raw
        # zarr store directly -- open_wind() reads either, and picks the level
        # nearest the inlet when the file still has a vertical dimension.
        #
        # lonMax crops the east: no camera in the deck looks past lon 11, so the
        # columns beyond it are ~0.6 MB nobody ever sees. Cropping the *eastern*
        # end leaves lonMin alone, so wind column j is still footprint column j.
        # uvMax 40 covers the true component maximum (39.86 m/s) so nothing
        # clips, at a 0.315 m/s quantisation step.
        "wind": {
            "path": "data/met/RGL_wind_100m_202002.nc",
            "lonMax": 12.0,
            "uvMax": 40.0,
        },
        "view": {"lat": (36.0, 64.0), "lon": (-25.0, 20.0)},
        "time_step": 1,
        "mass_tol": 0.01,
        "out": "web/data-rgl",
        "blurb": "Ridge Hill, a transmitter mast in Herefordshire, watching UK and European methane.",
    },
    "GSN": {
        # June-August 2016. June is the strongest month in the 2014-2017 window
        # the CFC-11 study flags: five episodes above +25 ppt, four above +35,
        # and the largest event of the period (+64 ppt, sustained 39 hours).
        # July is the gappy one -- a 121-189 h instrument outage, depending on
        # species -- and is kept only because it holds one large mid-month
        # event. The May 2015 file is deliberately unused: Medusa was down
        # 2015-04-16 to 2015-06-22, so it has no observations at all.
        "fp": "data/fps/GSN-10magl_EASTASIA_2016*.nc",
        "species": [
            # HFC-23 leads: same events as CFC-11 (r = +0.63) but it more than
            # doubles above baseline during them, against CFC-11's 28%, so the
            # chart reads without having to zoom the axis into a narrow band.
            {"key": "hfc-23", "label": "HFC-23", "units": "ppt", "obs": "data/obs/*_hfc-23_*"},
            {"key": "cfc-11", "label": "CFC-11", "units": "ppt", "obs": "data/obs/*_cfc-11_*"},
        ],
        # Cropped to eastern China, the Koreas and Japan -- the region the
        # camera actually visits. Two-hourly because the record is 92 days long
        # and Medusa reports every two to three hours anyway, so hourly frames
        # would double the download for no extra observational detail.
        "view": {"lat": (22.0, 46.0), "lon": (105.0, 145.0)},
        "time_step": 2,
        "mass_tol": 0.01,
        # EDGAR v8.0, 2016 -- the same year as the footprints, so the deck never
        # has to explain a mismatch between where the gas came from and when the
        # air was sampled.
        #
        # `sectors: None` is the whole point: EDGAR publishes HFC-23 under one
        # code (PRU_SOL, "solvents and products use"), and its grid is identical
        # to TOTALS, so there is no breakdown to draw and one raster ships. The
        # sources act gets one purple beat rather than Ridge Hill's three.
        #
        # `logRange` is *not* CH4's. This gas sits four orders of magnitude
        # lower -- the field runs 10^-21.4 to 10^-10.1 mol/m2/s inside this view
        # -- so on the -11.5..-7.0 window every cell would clip to the darkest
        # step and the map would encode as solid black. -18..-10 covers the
        # field; which slice of it the eye actually gets is SOURCE_DISPLAY in
        # palette.js, and that one is tunable live with `T`.
        "flux_hires": {
            "dir": "data/fluxes/hfc-23/EDGAR_v8.0",
            "totals": "yearly/v8.0_FT2022_GHG_HFC-23_2016_TOTALS_flx.nc",
            "sectors": None,
            "species": "hfc-23",
            "logRange": (-18.0, -10.0),
            "label": "Where it is made",
            "year": 2016,
            "source": "EDGAR v8.0_FT2022, 0.1 x 0.1 deg, published TOTALS",
        },
        # Reported HFC-23 plant locations. Domain-wide rather than period-
        # specific, so both Gosan instances point at the same file.
        "factories": {
            "path": "data/ancillary/factory_locations_EASTASIA.csv",
            "species": "hfc-23",
        },
        "out": "web/data-gsn",
        "blurb": "Gosan on Jeju Island, in the outflow from eastern China.",
    },
    "GSN-CFC11": {
        # June and July 2016 -- the same island and the same footprints as
        # "GSN", but CFC-11 rather than HFC-23, and two months rather than
        # three. August is dropped because the met store stops at 31 July, and
        # a third of the record with no wind would be a third of the deck with
        # a frozen wind field.
        #
        # ⚠ Brace globs do not work: Python's `glob` has no brace expansion, so
        # `2016{06,07}.nc` silently matches nothing. The character class does.
        "fp": "data/fps/GSN-10magl_EASTASIA_20160[67].nc",
        "species": [
            {
                "key": "cfc-11",
                "label": "CFC-11",
                "units": "ppt",
                "obs": "data/obs/*_cfc-11_*",
                # ⚠ **A prior, not an inventory, and the deck must never call it
                # one.** There is no CFC-11 inventory for this region -- that
                # absence is the deck's whole argument. This file is emission
                # spread over East Asia *by where people live*, which is the
                # assumption an inversion starts from when it knows nothing:
                # "it probably comes from wherever the people are".
                #
                # ⚠ **This is the 2016 rebuild, and the swap from the 2002 file
                # was deliberate.** `cfc-11-population_EASTASIA_2002.nc` (SEDAC
                # GPWv4) was measured to be **misregistered by about 1.5 cells
                # north and 0.5 east** -- ~39 km of latitude -- against four
                # independent regions of a 1 km WorldPop truth, and 52% of its
                # cells were negative from regridder ringing. Both symptoms were
                # the same code. Do not go back to it, and do not try to "fix"
                # it by shifting the raster.
                #
                # This file is an area-conservative overlap sum of the 1 km
                # raster in `flux_hires` below (population preserved to
                # 0.0001%), so the coarse map and the hi-res one cannot disagree
                # about where the people are -- which matters because `G` flips
                # between them on screen. Corner-referenced GeoTIFF tiepoints,
                # so it is correctly registered by construction, and it has
                # **zero negative cells**.
                #
                # Scaled so the emission inside this view is 15.037 Gg/yr --
                # exactly what the 2002 map put there -- so the forward model
                # keeps its old scale and only the *placement* changes.
                #
                # It sits on **exactly the NAME footprint grid** -- 340 x 391,
                # coordinates bit-identical to the footprint files, checked --
                # so nothing is regridded and the coarse `flux` key is a
                # drop-in. That is the opposite of the HFC-23 case, which had to
                # take `flux_hires` to avoid a regrid.
                #
                # The other file in that directory, `cfc-11_EASTASIA_2000.nc`,
                # is the flat prior: two distinct values in the entire field,
                # "20 Gg over East Asia, 20 Gg over everywhere else". A
                # two-tone rectangle, and a strong slide about how little was
                # known -- but not this key, which the map draws as geography.
                "flux": "data/fluxes/cfc-11/cfc-11-population_EASTASIA_2016.nc",
                # Not methane's -11.5..-7.0: inside this view the field runs
                # 10^-17.58 to 10^-10.72, which is below CH4's floor everywhere,
                # so on that window every cell pins to the darkest step and the
                # map encodes as a solid rectangle. -18..-10 clips nothing at
                # either end, and is the same window `data-gsn`'s HFC-23 raster
                # uses -- so a byte means the same thing across both Gosan decks.
                "flux_log_range": (-18.0, -10.0),
            },
        ],
        "view": {"lat": (22.0, 46.0), "lon": (105.0, 145.0)},
        "time_step": 2,
        "mass_tol": 0.01,
        # The finer population prior, drawn as its own layer rather than
        # replacing the coarse one. Both ship: `flux` above stays on the
        # footprint grid because `forward_model` multiplies it by the footprint
        # cell for cell, and a finer emissions map cannot make the transport any
        # finer. This raster is never multiplied by anything -- it is only ever
        # looked at -- which is exactly the case where the extra detail is real.
        #
        # `path` rather than `dir` is what routes it to
        # _export_flux_hires_raster: the file is already the map, in mol/m2/s,
        # so the only steps are crop and encode.
        #
        # ⚠ **~10 km, not the 1 km file, and the deck's cameras are the reason.**
        # This layer used to be `..._2016_1km.nc` at 1/120 deg with a `DELTA`
        # stop at span 6 to make it visible. That stop is gone -- the deck does
        # not want a zoom into the Yangtze -- and at the framings that remain the
        # 1 km raster was not a hi-res map but an aliasing machine: at `DOMAIN`'s
        # span of 30 a 0.00833 deg cell draws at **0.39 px**, and the source
        # layers use `imageSmoothingEnabled = !crispSources`, which is
        # nearest-neighbour by default. About 8% of the cells survived the
        # downscale and *which* 8% moved with the camera, so towns blinked in
        # and out -- for 4.5 MB. At 1/12 deg a cell is **3.9 px** at `DOMAIN` and
        # 5.8 px at `CHINA`, which is what "reads as cells" actually requires.
        #
        # Built by `scripts/coarsen_flux.py` as an exact 10x10 block sum of the
        # 1 km file: ten 1/120 deg cells tile one 1/12 deg cell, so there is no
        # overlap arithmetic and no interpolation, and it cannot reintroduce the
        # registration offset that made the 2002 SEDAC prior unusable. Verified
        # conservative -- population to +0.0001%, the view's emission to -0.01%,
        # and zero negative cells.
        #
        # logRange is the site's own -18..-10, shared with flux.png so a byte
        # means the same emission on both. Unlike the 1 km file, which clipped
        # 164 city-centre cells at the top, **nothing clips here**: block-summing
        # averages the peaks down to a maximum of 10^-10.15.
        #
        # ⚠ Coverage is CHN, TWN, JPN, KOR and PRK. Vietnam, Laos, Myanmar,
        # Mongolia and the Russian Far East clip the view box and are blank --
        # do not write a caption that reads the map as a complete accounting of
        # where people live.
        "flux_hires": {
            "path": "data/fluxes/cfc-11/cfc-11-population_EASTASIA_2016_10km.nc",
            "species": "cfc-11",
            "logRange": (-18.0, -10.0),
            "label": "Where people live",
            "year": 2016,
            "source": ("WorldPop R2025A constrained, UN-adjusted, 1 km, 2016 "
                       "(CHN, TWN, JPN, KOR, PRK), block-summed to ~10 km and "
                       "scaled to the view's own emission total"),
        },
        # Deliberately no `factories`: factory_locations_EASTASIA.csv is an
        # HFC-23 plant list and captioning it as CFC-11 would be a lie the map
        # cannot correct.
        #
        # Five named regions, one letter each, and the mechanic the whole deck
        # runs on: on any hour some are lit -- the station can smell that
        # direction today -- and the bar says how much is arriving. One of them
        # is lit on *every* smelly hour, and that one is the source. It is C,
        # Shandong, and that is measured rather than staged:
        # `scripts/measure_beacons.py` holds the reference implementation and
        # the answer key, which the export re-derives and prints on every run.
        #
        #   C Shandong +0.873 | D +0.522 | E +0.085 | A -0.056 | B -0.179
        #
        # ⚠ **A and B are honest negatives and must stay negatives.** Korea is
        # flat and Japan is *anti*-correlated -- when the sensor is looking at
        # Japan the reading is below average -- which is what makes the beat
        # "yes we can smell them, no they aren't smelly" real data. If a
        # re-export ever moves those signs, the deck is arguing something else.
        #
        # ⚠ **Land only.** A beacon's value is the footprint summed over the
        # land cells inside its box and nothing over water. Emissions come off
        # land, so sensitivity to the Yellow Sea is not sensitivity to Shandong
        # -- and the boxes hold very different amounts of sea (B is 43% land, D
        # is 99%), which made them incomparable for a reason that had nothing to
        # do with the air. It also makes the answer stronger: C goes from
        # r = +0.828 counting everything to +0.873 counting land.
        #
        # ⚠ **One shared pair of absolute cuts, on the land-only sum divided by
        # the box's land-cell count** -- deliberately *not* the per-beacon
        # normalisation the plan called for. That plan rested on the claim that
        # on one shared scale A and B would never light at all, and the claim is
        # false: measured lit rates are A 58%, B 57%, C 42%, D 40%, E 53%, so
        # nothing goes dark. The 1.94-against-0.06 figure behind the claim was
        # one smelly frame, not a distribution. Shared cuts are also *stronger*
        # -- C separates lit from dark by +11.0 ppt against the per-beacon
        # scheme's +9.2 -- and they mean the same physical thing for every
        # letter, which per-beacon cuts never did.
        #
        # ⚠ Half-open [lo, hi) on both axes, which is why C starts where D ends
        # rather than at the 34.5 they originally shared. The export refuses to
        # run if two boxes claim a cell.
        "beacons": {
            # How selective "lit" is. ⚠ A TUNING KNOB, not a finding -- it sets
            # how many letters glow at once, which is a decision to take with
            # the deck on screen and not from a table. The pooled 50th/80th
            # here light about 2.5 of the 5 on the average frame; 75/90 light
            # 1.2. Changing it cannot change the answer -- correlation does not
            # care where a threshold sits -- only how busy the map looks.
            "cutPercentiles": (65.0, 90.0),
            # The aggregation box is large and the drawn dot is small and sits
            # on the city. `dot` is [lon, lat], as basemap.json orders points.
            #
            # ⚠ B's dot is Fukuoka, not Osaka: Osaka at 135.5 E sits outside the
            # met store's eastern edge at 134.77, and Fukuoka is inside it.
            "boxes": [
                {"id": "A", "name": "South Korea",
                 "lat": (34.5, 38.2), "lon": (126.0, 129.6), "dot": (126.98, 37.57)},
                {"id": "B", "name": "Western Japan",
                 "lat": (32.5, 36.0), "lon": (129.6, 136.0), "dot": (130.40, 33.59)},
                {"id": "C", "name": "Shandong",
                 "lat": (34.5, 38.2), "lon": (115.0, 122.5), "dot": (116.99, 36.67)},
                {"id": "D", "name": "Anhui and Jiangsu",
                 "lat": (31.5, 34.5), "lon": (116.0, 120.5), "dot": (118.80, 32.06)},
                {"id": "E", "name": "South of Shanghai",
                 "lat": (28.3, 31.2), "lon": (118.8, 122.5), "dot": (120.16, 30.27)},
            ],
        },
        # Wind for the arrows and drifting parcels, sliced from
        # data/met/EASTASIA_GSN_Met_2016/EASTASIA_GSN_Met_2016.zarr by
        # scripts/slice_met.py. Model level 2, whose *true* height is 76.7 m:
        # that store was snapped rather than de-staggered, so its `level_height`
        # of 100 m describes the mass fields and overstates u/v. The level was
        # chosen against the footprint's own transport, Gosan's anemometer
        # record being a column of exact zeros.
        #
        # No lonMax. The store stops at lon 134.77, twenty-nine columns short of
        # the view's eastern edge, so the eastern crop is already made by the
        # data and there is nothing left for a config to trim.
        #
        # The slice is pre-aligned to fp_ds.time[::2] -- 224 steps on a uniform
        # three-frame stride, covering frames 0..669 of 672. That binds it to
        # `time_step: 2`; change the frame step and the slice must be re-cut, or
        # export_wind() will reject it.
        #
        # uvMax 37 covers the true component maximum inside the view
        # (36.52 m/s) with no clipping, at a 0.291 m/s quantisation step. It is
        # deliberately not Ridge Hill's 40: three m/s of unused headroom is
        # quantisation thrown away.
        "wind": {
            "path": "data/met/GSN_wind_77m_201606-201607.nc",
            "uvMax": 37.0,
        },
        "out": "web/data-gsn-cfc11",
        # What the map writes beside the station dot. Without this the label is
        # the SITES key, and "GSN-CFC11" is a *dataset* name showing up where a
        # sensor name belongs -- the deck already says which gas it is about in
        # every caption, so the marker repeating it is noise, and it reads as a
        # different instrument from the "GSN" on the HFC-23 deck's map when it
        # is the same one on the same clifftop.
        #
        # The key, the output directory and the pages all stay "GSN-CFC11":
        # they distinguish two exports of one station, which is a real
        # distinction and not one to make the label carry.
        "station_id": "GSN",
        "blurb": "Gosan on Jeju Island, watching CFC-11 over June and July 2016.",
    },
    "GSN-2021": {
        # February to May 2021, the post-abatement window: after China's claimed
        # HFC-23 reductions and the Kigali destruction obligation. Four
        # contiguous hourly months, 1062 samples, and the largest relative
        # enhancement anywhere in the 19-year record (+376%, mid-March). The
        # season matters as much as the year -- February is continental
        # northwesterly flow, May is maritime -- so the four months walk the
        # reader from one transport regime into the other.
        "fp": "data/fps/GSN-10magl_EASTASIA_2021*.nc",
        "species": [
            {"key": "hfc-23", "label": "HFC-23", "units": "ppt", "obs": "data/obs/*_hfc-23_*"},
        ],
        "view": {"lat": (22.0, 46.0), "lon": (105.0, 145.0)},
        # Two-hourly. Medusa reports every two to three hours, so hourly frames
        # leave 63% of the chart empty and the line is mostly holes; window
        # averaging onto a two-hourly axis keeps every one of the 1062 samples
        # and lifts coverage to 74%. It also halves the atlas.
        "time_step": 2,
        "mass_tol": 0.01,
        "factories": {
            "path": "data/ancillary/factory_locations_EASTASIA.csv",
            "species": "hfc-23",
        },
        "out": "web/data-gsn-2021",
        "blurb": "Gosan, February to May 2021 — after China's claimed HFC-23 abatement.",
    },
}


# ---------------------------------------------------------------------------
# Schema adapters
#
# The two footprint files come from different processing generations: RGL uses
# fp/lat/lon with time last, Gosan uses srr/latitude/longitude with time first,
# and the met variables are named differently in each. Everything downstream is
# written against one normalised shape.
# ---------------------------------------------------------------------------

_FP_VARS = ("fp", "srr")
_MET_ALIASES = {
    "wind_from_direction": "wind_direction",
    "atmosphere_boundary_layer_thickness": "PBLH",
    "air_temperature": "temperature",
    "air_pressure": "pressure",
}


def open_footprints(path: str) -> xr.Dataset:
    """Open one or more footprint files and normalise names to fp / lat / lon."""
    matches = sorted(glob.glob(path))
    if not matches:
        raise FileNotFoundError(f"no footprint file at {path}")
    if len(matches) == 1:
        ds = xr.open_dataset(matches[0])
    else:
        print(f"  concatenating {len(matches)} footprint files")
        ds = xr.open_mfdataset(matches, combine="by_coords")

    rename = {}
    if "latitude" in ds.coords:
        rename["latitude"] = "lat"
    if "longitude" in ds.coords:
        rename["longitude"] = "lon"
    for old, new in _MET_ALIASES.items():
        if old in ds.variables and new not in ds.variables:
            rename[old] = new
    fp_var = next((v for v in _FP_VARS if v in ds.data_vars), None)
    if fp_var is None:
        raise KeyError(f"{path}: no footprint variable, looked for {_FP_VARS}")
    if fp_var != "fp":
        rename[fp_var] = "fp"
    return ds.rename(rename)


def open_observations(path: str | None, species: str, times) -> tuple[np.ndarray | None, dict]:
    """Return observations aligned onto the footprint hourly axis, plus attrs.

    Returns (None, attrs) when the record does not overlap the footprint month --
    which is the situation at Gosan, where the Medusa instrument was down for the
    whole of May 2015.
    """
    if not path:
        return None, {}
    matches = sorted(glob.glob(path))
    if not matches:
        print(f"  ! no observation file at {path}")
        return None, {}
    ds = xr.open_dataset(matches[0])

    var = next((v for v in (species.replace("-", ""), species, "mf") if v in ds.data_vars), None)
    if var is None:
        print(f"  ! no mole-fraction variable in {matches[0]}")
        return None, dict(ds.attrs)

    t0 = pd.Timestamp(times[0])
    t1 = pd.Timestamp(times[-1])
    sub = ds[var].sel(time=slice(t0 - pd.Timedelta("1h"), t1 + pd.Timedelta("1h")))
    if sub.sizes.get("time", 0) == 0:
        print(f"  ! {matches[0]}: no {species} samples between {t0.date()} and {t1.date()}")
        return None, dict(ds.attrs)

    # AGAGE records are event-sampled at a few points per hour; the ACRG hourly
    # files are already on the hour. Resampling covers both, and reindexing onto
    # the footprint axis leaves NaN wherever the instrument was not reporting.
    hourly = sub.resample(time="1h").mean()
    aligned = hourly.reindex(time=pd.DatetimeIndex(times))
    vals = aligned.values.astype("float64")
    n_ok = int(np.isfinite(vals).sum())
    print(f"  observations: {n_ok} of {len(vals)} hours have data")
    if n_ok == 0:
        return None, dict(ds.attrs)
    return vals, dict(ds.attrs)


def _slice_view(da: xr.DataArray, view: dict) -> xr.DataArray:
    """Crop a (lat, lon, ...) DataArray to the view box, honouring axis order."""
    lat_asc = bool(da.lat.values[0] < da.lat.values[-1])
    lon_asc = bool(da.lon.values[0] < da.lon.values[-1])
    lat = slice(*(view["lat"] if lat_asc else view["lat"][::-1]))
    lon = slice(*(view["lon"] if lon_asc else view["lon"][::-1]))
    return da.sel(lat=lat, lon=lon)


def export_footprint(fp_ds, view, time_step, out_dir, mass_tol=0.01, display_pct=99.9):
    """Pack the footprint tensor into a uint8 sprite atlas.

    Encoding: 0 means "no footprint here" (rendered fully transparent). 1..255
    maps linearly over [log_min, log_max] in log10 space -- footprints span ~5
    orders of magnitude, so a linear scale would show almost nothing.

    The encoded range runs to the field's true maximum, deliberately *not* to a
    display percentile. Saturating the plume core would look fine but would strip
    a factor of ~7 off the cells nearest the inlet, and the decoded array is used
    quantitatively downstream (the particle animation samples destinations
    weighted by it). Display contrast is a separate number, `logDisplayMax`,
    which the colour ramp saturates at in the browser -- so the picture stays
    punchy while the array stays faithful.
    """
    fp = _slice_view(fp_ds.fp, view).transpose("lat", "lon", "time")
    fp = fp.isel(time=slice(None, None, time_step))

    ny, nx, nt = fp.sizes["lat"], fp.sizes["lon"], fp.sizes["time"]
    print(f"  footprint grid {nx} lon x {ny} lat x {nt} timesteps")

    # Two passes: first find the range, then quantise. The floor and the display
    # cut come off a subsample; the true max is taken over every timestep, since
    # missing it would silently clip whichever hour has the strongest plume.
    sample = fp.isel(time=slice(None, None, 8)).values
    pos = sample[sample > 0]

    # The floor is set by how much footprint *mass* we are willing to throw away,
    # not by a cell-count percentile. Faint far-field cells are individually
    # invisible (they render at alpha ~0.05) but there are a great many of them,
    # and they dominate the PNG's entropy: at Gosan 67% of cells are non-zero
    # against 39% at Ridge Hill, which is the whole reason its atlas is heavier.
    # Discarding the smallest cells holding `mass_tol` of the total is a knob
    # that means the same thing at every site.
    srt = np.sort(np.asarray(pos, dtype="float64"))
    cum = np.cumsum(srt)
    idx = int(np.searchsorted(cum, cum[-1] * mass_tol))
    log_min = float(np.log10(srt[min(idx, len(srt) - 1)]))
    kept = 1 - idx / len(srt)
    print(f"  floor drops {1 - kept:.0%} of cells holding {mass_tol:.1%} of the mass")
    log_display = float(np.percentile(np.log10(pos), display_pct))
    del sample, pos, srt, cum

    true_max = 0.0
    for i in range(0, nt, 48):
        true_max = max(true_max, float(fp.isel(time=slice(i, i + 48)).max()))
    log_max = float(np.log10(true_max))
    print(f"  log10 encode [{log_min:.2f}, {log_max:.2f}], display saturates at {log_display:.2f}")
    print(f"  quantisation step {(10 ** ((log_max - log_min) / 254) - 1) * 100:.1f}% per level")

    # Square-ish atlas so neither dimension blows past texture limits.
    cols = max(1, int(math.ceil(math.sqrt(nt))))
    rows = int(math.ceil(nt / cols))
    atlas = np.zeros((rows * ny, cols * nx), dtype=np.uint8)
    print(f"  atlas {cols * nx} x {rows * ny} px ({cols} x {rows} tiles)")

    span = log_max - log_min
    for i in range(0, nt, 24):
        block = fp.isel(time=slice(i, i + 24)).values  # (ny, nx, chunk)
        for k in range(block.shape[2]):
            t = i + k
            frame = block[:, :, k]
            with np.errstate(divide="ignore", invalid="ignore"):
                lg = np.log10(np.where(frame > 0, frame, np.nan))
            u = np.round(1 + 254 * (lg - log_min) / span)
            # Below the floor the cell becomes 0 = invisible, rather than being
            # clipped up to 1. Clipping would render identically (alpha 0.05) but
            # would inflate every far-field cell to the floor value, which shifts
            # the field's centre of mass and quietly corrupts anything computed
            # from the decoded array.
            u = np.where(np.isfinite(u) & (u >= 1), np.minimum(u, 255), 0).astype(np.uint8)
            # Flip lat so row 0 of the image is the northernmost row, matching
            # screen coordinates and saving a flip in the renderer.
            r, c = divmod(t, cols)
            atlas[r * ny : (r + 1) * ny, c * nx : (c + 1) * nx] = u[::-1, :]

    path = out_dir / "fp_atlas.png"
    Image.fromarray(atlas, mode="L").save(path, optimize=True)
    size_mb = path.stat().st_size / 1e6
    print(f"  wrote {path.name}  {size_mb:.2f} MB")

    lats = fp.lat.values
    lons = fp.lon.values
    return {
        "atlas": {"file": "fp_atlas.png", "cols": cols, "rows": rows, "tileW": nx, "tileH": ny},
        "grid": {
            "nx": nx,
            "ny": ny,
            # Cell-edge bounds, so the renderer can map pixel -> lon/lat exactly.
            "lonMin": float(lons[0] - (lons[1] - lons[0]) / 2),
            "lonMax": float(lons[-1] + (lons[1] - lons[0]) / 2),
            "latMin": float(lats.min() - abs(lats[1] - lats[0]) / 2),
            "latMax": float(lats.max() + abs(lats[1] - lats[0]) / 2),
        },
        "logMin": log_min,
        "logMax": log_max,
        "logDisplayMax": log_display,
        "nTime": nt,
        "sizeMB": round(size_mb, 2),
    }


def export_factories(spec: dict | None, view: dict, species: list, fp_meta: dict) -> dict | None:
    """Point locations of plants that may vent one species, for a map overlay.

    Coordinates only -- no names, no capacities -- so this is a "where are the
    candidate sources" layer, not an inventory. It is deliberately *not* a flux
    raster: unlike EDGAR these are unweighted points, and rendering them as a
    field would imply an emission rate the file does not contain.

    The list belongs to *one* gas, which is why `species` is configured rather
    than inferred. Gosan 2016 also carries CFC-11, and labelling this layer from
    whichever species happens to be active would caption a list of HFC-23 plants
    as CFC-11 ones.

    Small enough (a few hundred bytes) to ride inside meta.json rather than
    costing another fetch. Duplicate coordinates are collapsed to one marker
    carrying a count, since several listed plants can share a site to the 0.01
    degree the file is rounded to -- drawing them stacked would just darken one
    pixel and misreport the geography.

    Points outside the view are kept, not clipped: the camera decides what is on
    screen, and keeping them means widening `view` later needs no re-export.
    """
    if not spec:
        return None
    path = spec["path"]
    key = spec["species"]
    label = next((s["label"] for s in species if s["key"] == key), key)
    matches = sorted(glob.glob(path))
    if not matches:
        print(f"  ! no factory file at {path}")
        return None

    df = pd.read_csv(matches[0])
    cols = {c.lower().strip(): c for c in df.columns}
    lat_c = next((cols[k] for k in ("lat", "latitude") if k in cols), None)
    lon_c = next((cols[k] for k in ("lon", "longitude", "long") if k in cols), None)
    if lat_c is None or lon_c is None:
        print(f"  ! {matches[0]}: need lat/lon columns, found {list(df.columns)}")
        return None

    ll = df[[lat_c, lon_c]].apply(pd.to_numeric, errors="coerce").dropna()
    dropped = len(df) - len(ll)
    if dropped:
        print(f"  ! dropped {dropped} rows with unparseable coordinates")

    # Round before grouping so coordinates that differ only in float noise land
    # on the same marker.
    ll = ll.round(4)
    grouped = ll.groupby([lon_c, lat_c]).size().reset_index(name="n")
    grouped = grouped.sort_values([lat_c, lon_c], ascending=[False, True])

    n_listed = int(len(ll))
    n_sites = int(len(grouped))
    inside = (
        grouped[lat_c].between(*view["lat"]) & grouped[lon_c].between(*view["lon"])
    )
    print(f"  factories: {n_listed} listed {label} plants at {n_sites} distinct locations")
    if n_sites != n_listed:
        multi = grouped[grouped["n"] > 1]
        print(f"    {len(multi)} location(s) shared by more than one plant: "
              + ", ".join(f"({r[lat_c]:.2f}, {r[lon_c]:.2f})x{int(r['n'])}" for _, r in multi.iterrows()))
    if not inside.all():
        out = grouped[~inside]
        print(f"    ! {len(out)} outside the view box -- exported but off-frame:")
        for _, r in out.iterrows():
            print(f"      ({r[lat_c]:.2f}, {r[lon_c]:.2f})")

    # The uint8 code the browser compares a plant's footprint cell against. Ceil
    # rather than round so "lit" always means sensitivity >= 10**FACTORY_LIT_LOG10
    # and never a hair under it.
    g = fp_meta["grid"]
    lo, hi = fp_meta["logMin"], fp_meta["logMax"]
    lit_code = int(math.ceil(1 + 254 * (FACTORY_LIT_LOG10 - lo) / (hi - lo)))
    lit_code = max(1, min(255, lit_code))

    # A plant outside the *grid* can never light up, however the camera is framed,
    # so it is worth counting separately from the off-frame ones.
    in_grid = (
        grouped[lat_c].between(g["latMin"], g["latMax"])
        & grouped[lon_c].between(g["lonMin"], g["lonMax"])
    )
    print(f"    lit at log10 >= {FACTORY_LIT_LOG10} -> uint8 code {lit_code} "
          f"(encoded range [{lo:.2f}, {hi:.2f}])")
    print(f"    {int(in_grid.sum())} of {n_sites} sit on a footprint cell and can light up")

    return {
        "source": Path(matches[0]).name,
        "species": key,
        "label": label,
        "nListed": n_listed,
        "nSites": n_sites,
        "nInView": int(inside.sum()),
        "nOnGrid": int(in_grid.sum()),
        "litLog10": FACTORY_LIT_LOG10,
        "litCode": lit_code,
        # [lon, lat, count], matching basemap.json's [x, y] ordering.
        "points": [
            [round(float(r[lon_c]), 4), round(float(r[lat_c]), 4), int(r["n"])]
            for _, r in grouped.iterrows()
        ],
    }


def _encode_flux(vals: np.ndarray, log_range: tuple[float, float] | None = None) -> np.ndarray:
    """Emissions (mol/m2/s) -> uint8 on a log scale. 0 means nothing here.

    Extracted so `export_flux` and `export_flux_hires` cannot drift apart: the
    hi-res source maps are only comparable to flux.png, and to each other, while
    all of them share one scale.

    `log_range` is per *site*, not per raster, for exactly that reason -- every
    caller within one export passes the same pair, and the default is CH4's. A
    gas four orders of magnitude weaker needs its own window or it encodes to
    solid black, but two rasters in one export must never disagree about what a
    byte means.
    """
    lo, hi = log_range or (FLUX_LOG_MIN, FLUX_LOG_MAX)
    with np.errstate(divide="ignore", invalid="ignore"):
        lg = np.log10(np.where(vals > 0, vals, np.nan))
    u = np.clip(np.round(1 + 254 * (lg - lo) / (hi - lo)), 1, 255)
    return np.where(np.isfinite(u), u, 0).astype(np.uint8)


def export_flux(flux_ds, view, out_dir, log_range=None):
    """Emissions map on the same grid, same encoding idea as the footprint.

    `log_range` is the species' own encoding window, from `flux_log_range` on
    the species spec, and defaults to methane's. It is the same knob
    `flux_hires` already has as `logRange` and it exists for the same reason: a
    gas whose field sits orders of magnitude below CH4's window encodes to one
    flat byte on it, and a flat raster is a blank slide.

    ⚠ Unlike the hi-res rasters, this one has **no separate display window in
    the browser by default** -- `FLUX_LUT` spreads its ramp over the whole
    encoded range -- so for methane this window is what the eye gets as well as
    what the PNG stores. A species that wants the two separated says so in
    `SOURCE_DISPLAY_BY_SPECIES` in palette.js, which is tunable live with `T`.
    """
    fl = _slice_view(flux_ds.flux.squeeze(), view).transpose("lat", "lon")
    lo, hi = tuple(log_range) if log_range else (FLUX_LOG_MIN, FLUX_LOG_MAX)
    u = _encode_flux(fl.values, (lo, hi))
    Image.fromarray(u[::-1, :], mode="L").save(out_dir / "flux.png", optimize=True)
    # The clipped share is the number that says whether the window fits: cells
    # pinned at 1 or 255 have lost their value, and on a map of "where it comes
    # from" that is the difference between a city and its suburbs.
    vals = fl.values
    pos = vals[vals > 0]
    if pos.size:
        lg = np.log10(pos)
        under = int((lg < lo).sum())
        over = int((lg > hi).sum())
        print(f"  flux window 10^{lo} .. 10^{hi}: field runs "
              f"10^{lg.min():.2f} .. 10^{lg.max():.2f}, "
              f"{under} cells under, {over} over ({100 * (under + over) / pos.size:.2f}%)")
    print(f"  wrote flux.png  {(out_dir / 'flux.png').stat().st_size / 1e3:.0f} KB")
    return {"logMin": lo, "logMax": hi, "file": "flux.png"}


def _read_edgar_01(path: Path, view: dict, species: str = "ch4"):
    """One raw 0.1 deg EDGAR file, cropped to `view`, as (mol/m2/s, lat, lon).

    Two conversions the ACRG-regridded files have already had done to them and
    these have not: kg/m2/s -> mol/m2/s, and a 0..360 longitude axis -> -180..180.
    Getting either wrong is silent -- the map still draws, just wrong by a factor
    of 62 or shifted half a world -- so both happen in one place.

    Two EDGAR generations land here and they disagree about both. v7 names its
    variable `emi_ch4` and runs longitude 0..360; v8 names it `fluxes` and is
    already -180..180. So the variable is taken as "the one data variable in the
    file" rather than by name -- these files have exactly one, and a name test
    would have to grow a case per gas -- and the wrap below is left to no-op on
    an axis that is already signed.
    """
    ds = xr.open_dataset(path)
    names = list(ds.data_vars)
    if len(names) != 1:
        raise SystemExit(f"{path.name}: expected one data variable, found {names}")
    if species not in M_KG_PER_MOL:
        raise SystemExit(f"no molar mass for {species!r}; add it to M_KG_PER_MOL")
    vals = ds[names[0]].values.astype("float64").squeeze() / M_KG_PER_MOL[species]
    lat = ds.lat.values.astype("float64")
    lon = ds.lon.values.astype("float64")
    ds.close()

    lon = np.where(lon > 180.0, lon - 360.0, lon)
    order = np.argsort(lon)
    lon, vals = lon[order], vals[:, order]

    ky = (lat >= view["lat"][0]) & (lat <= view["lat"][1])
    kx = (lon >= view["lon"][0]) & (lon <= view["lon"][1])
    return vals[np.ix_(ky, kx)], lat[ky], lon[kx]


def _cell_area(lat: np.ndarray, dlat: float, dlon: float) -> np.ndarray:
    """Spherical cell area in m2, per latitude row."""
    r = 6.371e6
    h = np.deg2rad(dlat) / 2.0
    return r ** 2 * np.deg2rad(dlon) * (np.sin(np.deg2rad(lat) + h) - np.sin(np.deg2rad(lat) - h))


def _export_flux_hires_raster(spec: dict, view: dict, out_dir) -> dict | None:
    """A hi-res emissions map that is already a finished field on its own grid.

    The EDGAR path below *builds* its map -- reads sector files, converts
    kg/m2/s to mol/m2/s, sums the families. This one has nothing to build: the
    file is already the map and already in mol/m2/s, so the only steps are crop
    and encode. That is what the CFC-11 population prior is -- WorldPop's own
    30 arc-second cells, never resampled, so between the published head-count
    and the screen there is a single scalar multiply and no interpolation.

    Taken by `flux_hires` carrying a `path` instead of a `dir`, which is also
    what makes the two paths tell themselves apart.

    ⚠ It shares `_encode_flux` and the site's window with `flux.png` on purpose.
    The two rasters are *the same field at two resolutions*, so a byte has to
    mean the same emission on both -- otherwise `G`, which flips between them,
    would be comparing two different scales and calling it a resolution.
    """
    path = REPO / spec["path"]
    if not path.exists():
        print(f"  ! no hi-res emissions at {path}, skipping")
        return None

    species = spec.get("species", "ch4")
    if species not in M_KG_PER_MOL:
        raise SystemExit(f"no molar mass for {species!r}; add it to M_KG_PER_MOL")
    log_range = tuple(spec.get("logRange", (FLUX_LOG_MIN, FLUX_LOG_MAX)))

    ds = xr.open_dataset(path)
    da = _slice_view(ds[spec.get("var", "flux")].squeeze(), view).transpose("lat", "lon")
    vals = np.asarray(da.values, dtype="float64")
    lat = np.asarray(da.lat.values, dtype="float64")
    lon = np.asarray(da.lon.values, dtype="float64")
    ds.close()

    ny, nx = vals.shape
    dlat = float(np.diff(lat).mean())
    dlon = float(np.diff(lon).mean())
    print(f"  hi-res emissions grid {nx} lon x {ny} lat  "
          f"({dlon:.5f} x {dlat:.5f} deg, {nx * ny / 1e6:.1f} M cells)")

    area = _cell_area(lat, dlat, dlon)[:, None] * np.ones(nx)[None, :]
    to_tg = area * M_KG_PER_MOL[species] * 365.0 * 24 * 3600 / 1e9
    total_tg = float((vals * to_tg).sum())

    u = _encode_flux(vals, log_range)
    Image.fromarray(u[::-1, :], mode="L").save(out_dir / "flux_hi.png", optimize=True)

    # Same reporting as export_flux: a window that clips is the difference
    # between a city and its suburbs, and at 1 km it is the city centres that
    # go first, so the number has to be printed on every re-export.
    lo, hi = log_range
    pos = vals[vals > 0]
    if pos.size:
        lg = np.log10(pos)
        under, over = int((lg < lo).sum()), int((lg > hi).sum())
        clipped = 100 * float(pos[lg > hi].sum()) / float(pos.sum()) if over else 0.0
        print(f"  flux_hi window 10^{lo} .. 10^{hi}: field runs "
              f"10^{lg.min():.2f} .. 10^{lg.max():.2f}, {under} cells under, "
              f"{over} over ({clipped:.3f}% of the emission clipped)")
    mb = (out_dir / "flux_hi.png").stat().st_size / 1e6
    print(f"  wrote flux_hi.png  {mb:.2f} MB   "
          f"{total_tg * 1e3:.3f} Gg/yr over the view")

    return {
        "logMin": lo,
        "logMax": hi,
        "species": species,
        "year": spec.get("year"),
        "source": spec.get("source", str(path.name)),
        # No sector decomposition exists for this kind of map, and "none were
        # left over" would be a different claim from "the question does not
        # apply". Same convention the single-sector EDGAR path uses.
        "ungroupedSectors": None,
        "publishedTotalsRatio": None,
        "grid": {"latMin": float(lat[0] - dlat / 2), "latMax": float(lat[-1] + dlat / 2),
                 "lonMin": float(lon[0] - dlon / 2), "lonMax": float(lon[-1] + dlon / 2),
                 "nLat": ny, "nLon": nx},
        "totalTgPerYear": round(total_tg, 6),
        "layers": {
            "total": {
                "file": "flux_hi.png",
                "label": spec.get("label", "All of it"),
                "sectors": None,
                "tgPerYear": round(total_tg, 6),
                "shareOfView": 100.0,
            }
        },
    }


def export_flux_hires(spec: dict | None, view: dict, out_dir) -> dict | None:
    """Card 3's emissions maps: the total, then three source groups, at 0.1 deg.

    Eight times the cells of flux.png over the same box (126,000 against 15,240),
    and worth having *only* here. This layer is looked at on its own and never
    multiplied by a footprint, so the extra detail is all visible. The forward
    model stays on the footprint grid, because a product is limited by its
    coarser factor and a finer emissions map would buy detail the transport
    cannot support -- precision dressed up as accuracy.

    All four rasters share the one log scale flux.png already uses, so "brighter
    means more methane" holds across every step of the card and the three groups
    can be read against each other. Per-group scaling would make the smallest
    source look as strong as the largest, which is the one thing this card must
    not do.

    ---

    **A gas with one source takes the short path.** `sectors: None` in the spec
    means there is no breakdown to draw: the published TOTALS grid *is* the whole
    story, it ships as the single `total` raster, and no family files are written.
    That is not a degraded version of the card -- for HFC-23 the one sector file
    EDGAR publishes (`PRU_SOL`) is bit-for-bit identical to TOTALS, so summing
    parts would produce the same array by a longer route. It also sidesteps the
    reason the CH4 path sums rather than reads: the zeroed cells over English
    cities are an artefact of *combining* sectors, and a single-sector gas has no
    such disagreement to reconcile.
    """
    if not spec:
        return None
    # A spec that names one finished file has nothing to sum -- see
    # _export_flux_hires_raster, which is where the CFC-11 1 km prior goes.
    if spec.get("path"):
        return _export_flux_hires_raster(spec, view, out_dir)
    root = REPO / spec["dir"]
    totals_path = root / spec["totals"]
    if not totals_path.exists():
        print(f"  ! no hi-res emissions at {totals_path}, skipping")
        return None

    species = spec.get("species", "ch4")
    log_range = tuple(spec.get("logRange", (FLUX_LOG_MIN, FLUX_LOG_MAX)))
    single = not spec.get("sectors")

    published, lat, lon = _read_edgar_01(totals_path, view, species)
    ny, nx = published.shape
    dlat = float(np.diff(lat).mean())
    dlon = float(np.diff(lon).mean())
    print(f"  hi-res emissions grid {nx} lon x {ny} lat  ({dlon:.2f} x {dlat:.2f} deg)")

    area = _cell_area(lat, dlat, dlon)[:, None] * np.ones(nx)[None, :]
    to_tg = area * M_KG_PER_MOL[species] * 365.0 * 24 * 3600 / 1e9

    missing = []

    def read_sectors(codes):
        acc = np.zeros_like(published)
        for code in codes:
            p = root / spec["sectors"].format(code=code)
            if not p.exists():
                missing.append(code)
                continue
            acc += _read_edgar_01(p, view, species)[0]
        return acc

    if single:
        total = published
        layers = {"total": {"label": spec.get("label", "All of it"),
                            "vals": total, "file": "flux_hi.png"}}
        total_tg = float((total * to_tg).sum())
        ratio = 1.0
        print(f"  single source, published TOTALS used directly "
              f"({int((total > 0).sum())} cells carry emissions)")
    else:
        layers = {}
        for key, group in SOURCE_GROUPS.items():
            layers[key] = {"label": group["label"], "vals": read_sectors(group["sectors"]),
                           "file": f"src_{key}.png"}
        ungrouped = read_sectors(UNGROUPED_SECTORS)

        # The total is *built* from the sectors rather than read from the published
        # TOTALS grid, which EDGAR generates separately. Those two disagree, and not
        # only in the last decimal: the published grid has a handful of cells that
        # are flatly zero while every sector file has emissions there, four of them
        # over Leeds, Sheffield, Birmingham and Lincoln. At 0.1 deg on the card's
        # framing each one is a visible hole punched in an English city. Summing the
        # parts removes them, and makes the card's claim true by construction --
        # what the reader is shown as "all of it" is exactly the three families plus
        # the transport slack.
        total = sum(l["vals"] for l in layers.values()) + ungrouped
        layers = {"total": {"label": "All methane", "vals": total, "file": "flux_hi.png"}, **layers}
        total_tg = float((total * to_tg).sum())

        if missing:
            print(f"  ! missing sector files, treated as zero: {', '.join(missing)}")

        # Report the disagreement rather than hiding it: a large gap would mean a
        # sector file had gone missing, which is worth seeing on every re-export.
        holes = int(((total > 0) & (published <= 0)).sum())
        ratio = float((published * to_tg).sum() / total_tg) if total_tg else float("nan")
        print(f"  summed sectors vs published TOTALS: {ratio:.4f}  "
              f"({holes} cells the published grid leaves empty)")

    out = {}
    for key, layer in layers.items():
        u = _encode_flux(layer["vals"], log_range)
        Image.fromarray(u[::-1, :], mode="L").save(out_dir / layer["file"], optimize=True)
        kb = (out_dir / layer["file"]).stat().st_size / 1e3
        tg = float((layer["vals"] * to_tg).sum())
        share = 100 * tg / total_tg if total_tg else 0.0
        out[key] = {
            "file": layer["file"],
            "label": layer["label"],
            "sectors": SOURCE_GROUPS[key]["sectors"] if key in SOURCE_GROUPS else None,
            "tgPerYear": round(tg, 4),
            "shareOfView": round(share, 2),
        }
        # Printed, not just stored: these are the percentages the captions rest
        # on, so a re-export reports it the moment one of them moves.
        print(f"  wrote {layer['file']:<18} {kb:5.0f} KB   "
              f"{tg:6.3f} Tg/yr  {share:5.1f}% of the view")

    if not single:
        named = sum(out[k]["tgPerYear"] for k in SOURCE_GROUPS)
        print(f"  three families cover {100 * named / total_tg:.1f}% of the view total; "
              f"the rest is transport, uncoloured")

    return {
        "logMin": log_range[0],
        "logMax": log_range[1],
        "species": species,
        "year": spec.get("year"),
        "source": spec.get("source", "EDGAR v7.0_FT2021, 0.1 x 0.1 deg, summed from sector grids"),
        # A single-source gas has no unassigned remainder and nothing to
        # reconcile: null rather than an empty list, so a consumer that asks
        # "which sectors went uncoloured" gets "the question does not apply"
        # rather than "none did", which are different answers.
        "ungroupedSectors": None if single else UNGROUPED_SECTORS,
        "publishedTotalsRatio": round(ratio, 4),
        "grid": {"latMin": float(lat[0] - dlat / 2), "latMax": float(lat[-1] + dlat / 2),
                 "lonMin": float(lon[0] - dlon / 2), "lonMax": float(lon[-1] + dlon / 2),
                 "nLat": ny, "nLon": nx},
        "totalTgPerYear": round(total_tg, 4),
        "layers": out,
    }


# ---------------------------------------------------------------------------
# Wind
#
# Same idea as the footprint atlas -- ship the field, not the picture -- but two
# channels instead of one, and on a coarser time axis than the footprint. The
# browser advects parcels through it live.
# ---------------------------------------------------------------------------

# Eastward/northward under whatever name the producer used. `x_wind`/`y_wind` are
# the UM's, and are eastward/northward here because the store was regridded onto
# the footprint's regular lat/lon grid -- there is no rotated pole to undo.
_WIND_ALIASES = (
    ("eastward_wind", "northward_wind"),
    ("x_wind", "y_wind"),
    ("u10", "v10"),
    ("u_component_of_wind", "v_component_of_wind"),
    ("u", "v"),
)
_VERT_DIMS = ("levels", "level", "model_level_number", "height", "z")


def wind_from_direction(u, v):
    """Compass bearing the wind blows *from*, which is what stations report."""
    return (270.0 - np.degrees(np.arctan2(v, u))) % 360.0


def angular_error(a, b):
    """Absolute difference between two bearings, taking the short way round."""
    return np.abs(((a - b + 180.0) % 360.0) - 180.0)


def anemometer_is_real(fp_ds) -> bool:
    """Whether the footprint file's station wind is a measurement or a placeholder.

    Present-but-constant is the case this exists for. Gosan's `wind_speed` and
    `wind_direction` are finite for all 1344 hours of June-July 2016 and every
    single value is exactly 0.0 -- the producer had nothing to put there and
    wrote zeros rather than dropping the variables.

    Correlating against that is not weak evidence, it is none, and it is not
    harmless: `_pearson` against a zero-variance column returns NaN, `json.dumps`
    writes NaN as a bare token, and `JSON.parse` rejects the whole of meta.json.
    A missing anemometer would silently take the page down with it.

    Shared with scripts/slice_met.py, which makes the same judgement when it
    chooses a model level, so the two cannot disagree about whether this site has
    a usable wind record.
    """
    for name in ("wind_speed", "wind_direction"):
        if name not in fp_ds.variables:
            return False
    sp = np.asarray(fp_ds.wind_speed.values, "float64").ravel()
    di = np.asarray(fp_ds.wind_direction.values, "float64").ravel()
    ok = np.isfinite(sp) & np.isfinite(di)
    if ok.sum() < 24:
        return False
    return float(np.std(sp[ok])) > 0.0 and float(np.std(di[ok])) > 0.0


def open_wind(path: str, inlet_magl: float | None = None) -> xr.Dataset:
    """Open a wind field as `u`/`v` on (time, lat, lon), from netCDF or zarr.

    Deliberately separate from `open_footprints`: `_MET_ALIASES` renames
    `air_temperature` and `air_pressure`, and the met store has variables of both
    names, so routing this through the footprint opener would rename fields out
    from under themselves.

    A vertical dimension is collapsed to the level nearest the inlet. The slice
    written by `scripts/slice_met.py` has already done that and carries no
    vertical dim, in which case its recorded level travels through in the attrs.
    """
    p = REPO / path
    if p.is_dir():
        ds = xr.open_zarr(p, consolidated=True, decode_timedelta=False)
    else:
        ds = xr.open_dataset(p)

    rename = {}
    if "latitude" in ds.coords:
        rename["latitude"] = "lat"
    if "longitude" in ds.coords:
        rename["longitude"] = "lon"
    if rename:
        ds = ds.rename(rename)

    pair = next(((a, b) for a, b in _WIND_ALIASES if a in ds.data_vars and b in ds.data_vars), None)
    if pair is None:
        raise KeyError(f"{path}: no wind pair among {[a for a, _ in _WIND_ALIASES]}; "
                       f"found {sorted(ds.data_vars)}")
    u, v = ds[pair[0]], ds[pair[1]]

    level_index = ds.attrs.get("level_index")
    level_height = ds.attrs.get("level_height_m")
    vert = next((d for d in _VERT_DIMS if d in u.dims), None)
    if vert is not None:
        heights = None
        for cand in ("level_height", vert):
            if cand in ds.coords or cand in ds.variables:
                heights = np.asarray(ds[cand].values, "float64")
                break
        if heights is None or inlet_magl is None:
            level_index = 0
            print(f"  ! no level heights or no inlet height; taking {vert}=0")
        else:
            level_index = int(np.argmin(np.abs(heights - inlet_magl)))
            level_height = float(heights[level_index])
            print(f"  {vert}={level_index} at {level_height:.1f} m, nearest the "
                  f"{inlet_magl:.0f} m inlet")
        u = u.isel({vert: level_index})
        v = v.isel({vert: level_index})

    out = xr.Dataset({"u": u.transpose("time", "lat", "lon"),
                      "v": v.transpose("time", "lat", "lon")})
    out.attrs = dict(ds.attrs)
    out.attrs["level_index"] = level_index
    out.attrs["level_height_m"] = level_height
    out.attrs["source_vars"] = f"{pair[0]}, {pair[1]}"
    return out


def _encode_wind(vals: np.ndarray, uv_max: float) -> np.ndarray:
    """m/s -> uint8, linear over [-uvMax, +uvMax]. 0 is reserved for missing.

    Shared with verify_export.py so the shipped bytes and the check that
    re-derives them cannot drift. Decode is
    `-uvMax + (u - 1) / 254 * 2 * uvMax` for u >= 1.
    """
    a = np.asarray(vals, dtype="float64")
    q = np.clip(np.round((a + uv_max) / (2.0 * uv_max) * 254.0) + 1.0, 1, 255)
    return np.where(np.isfinite(a), q, 0).astype(np.uint8)


def export_wind(spec: dict | None, view: dict, out_dir, fp_ds, time_step: int,
                inlet_magl: float | None, station: dict) -> dict | None:
    """Wind as two uint8 sprite atlases, one per component.

    Optional in exactly the way `flux` and `factories` are: no config or no file
    means `meta.wind` is null and every consumer degrades to drawing nothing.

    Two atlases rather than one RGB image because it measured smaller -- 3.16 MB
    against 3.83 on the full grid. The east crop is the real lever: no camera in
    the deck looks past lon 11, so the eastern fifth of the domain is weight
    nobody ever sees.
    """
    if not spec:
        return None
    path = spec["path"]
    if not (REPO / path).exists():
        print(f"  ! no wind file at {path}; meta.wind stays null")
        return None

    ds = open_wind(path, inlet_magl)
    sub = _slice_view(ds, view)
    lon_max = spec.get("lonMax")
    if lon_max is not None:
        sub = sub.sel(lon=slice(None, lon_max))
        print(f"  cropped east to lon <= {lon_max}: {sub.sizes['lon']} of "
              f"{ds.sizes['lon']} columns")

    nt, ny, nx = sub.sizes["time"], sub.sizes["lat"], sub.sizes["lon"]

    # --- time: every wind step must land on an exported frame ---------------
    frame_ms = np.asarray([pd.Timestamp(t).value for t in fp_ds.time.values[::time_step]])
    wind_ms = np.asarray([pd.Timestamp(t).value for t in sub.time.values])
    idx = np.searchsorted(frame_ms, wind_ms)
    hit = (idx < len(frame_ms)) & (frame_ms[np.clip(idx, 0, len(frame_ms) - 1)] == wind_ms)
    if not hit.all():
        raise SystemExit(f"{path}: {int((~hit).sum())} wind steps do not land on an "
                         "exported frame -- the time axes are incompatible")
    strides = np.unique(np.diff(idx))
    if len(strides) != 1:
        raise SystemExit(f"{path}: wind steps are not evenly spaced on the frame axis "
                         f"(strides {strides})")
    stride = int(strides[0])
    covered = int(idx[-1]) + 1
    print(f"  {nt} wind steps, one every {stride} frames, covering frames "
          f"0..{idx[-1]} of {len(frame_ms)}")
    if covered < len(frame_ms):
        print(f"  ! the last {len(frame_ms) - covered} frames run past the wind "
              "record; the browser must clamp to the final wind step")

    uu = sub.u.values.astype("float64")
    vv = sub.v.values.astype("float64")
    comp_max = float(max(np.nanmax(np.abs(uu)), np.nanmax(np.abs(vv))))
    uv_max = float(spec.get("uvMax") or math.ceil(comp_max))
    clipped = float(((np.abs(uu) > uv_max) | (np.abs(vv) > uv_max)).mean())
    print(f"  max |component| {comp_max:.2f} m/s, uvMax {uv_max:g}, "
          f"step {2 * uv_max / 254:.3f} m/s")
    if clipped:
        print(f"  ! uvMax {uv_max:g} clips {clipped:.3%} of cells")

    # --- atlases ------------------------------------------------------------
    cols = max(1, int(math.ceil(math.sqrt(nt))))
    rows = int(math.ceil(nt / cols))
    print(f"  atlas {cols * nx} x {rows * ny} px ({cols} x {rows} tiles)")

    files = {}
    size_mb = 0.0
    for name, arr in (("u", uu), ("v", vv)):
        q = _encode_wind(arr, uv_max)
        atlas = np.zeros((rows * ny, cols * nx), dtype=np.uint8)
        for t in range(nt):
            r, c = divmod(t, cols)
            # Row 0 is north, matching the footprint atlas and the renderer.
            atlas[r * ny : (r + 1) * ny, c * nx : (c + 1) * nx] = q[t][::-1, :]
        f = f"wind_{name}.png"
        p = out_dir / f
        Image.fromarray(atlas, mode="L").save(p, optimize=True)
        mb = p.stat().st_size / 1e6
        size_mb += mb
        files[name] = f
        print(f"  wrote {f}  {mb:.2f} MB")

    # --- does it agree with the station's own anemometer? -------------------
    # `stationCorr` stays null where there is no anemometer to compare against,
    # which is already the supported "not measured" value. See
    # `anemometer_is_real` for why a placeholder record must not reach _pearson.
    corr = None
    if not anemometer_is_real(fp_ds):
        print("  no usable station wind in the footprint file; stationCorr stays null")
    else:
        lat = np.asarray(sub.lat.values, "float64")
        lon = np.asarray(sub.lon.values, "float64")
        iy = int(np.argmin(np.abs(lat - station["lat"])))
        ix = int(np.argmin(np.abs(lon - station["lon"])))
        u_st, v_st = uu[:, iy, ix], vv[:, iy, ix]
        full_ms = np.asarray([pd.Timestamp(t).value for t in fp_ds.time.values])
        at = np.searchsorted(full_ms, wind_ms)
        sp_obs = np.asarray(fp_ds.wind_speed.values, "float64")[at]
        di_obs = np.asarray(fp_ds.wind_direction.values, "float64")[at]
        sp = np.hypot(u_st, v_st)
        m = np.isfinite(sp_obs) & np.isfinite(sp)
        err = angular_error(wind_from_direction(u_st, v_st)[m], di_obs[m])
        corr = {
            "speed": round(_pearson(sp, sp_obs), 4),
            "biasMs": round(float(np.mean(sp[m] - sp_obs[m])), 3),
            "rmseMs": round(float(np.sqrt(np.mean((sp[m] - sp_obs[m]) ** 2))), 3),
            "dirDeg": round(float(err.mean()), 2),
            "dirMedianDeg": round(float(np.median(err)), 2),
        }
        print(f"  vs the station's own wind: r={corr['speed']:+.3f}, "
              f"bias {corr['biasMs']:+.2f} m/s, direction {corr['dirDeg']:.1f} deg mean")

    lats = sub.lat.values
    lons = sub.lon.values
    height = ds.attrs.get("level_height_m")
    # netCDF attrs come back as numpy scalars, which json.dumps refuses.
    level_index = ds.attrs.get("level_index")
    level_index = None if level_index is None else int(level_index)
    return {
        "atlas": {"u": files["u"], "v": files["v"], "cols": cols, "rows": rows,
                  "tileW": nx, "tileH": ny},
        # Recorded rather than assumed: two single-channel atlases measured
        # smaller than one RGB one, and the reader has to know which it got.
        "layout": "two-l8",
        "grid": {
            "nx": nx,
            "ny": ny,
            "lonMin": float(lons[0] - (lons[1] - lons[0]) / 2),
            "lonMax": float(lons[-1] + (lons[1] - lons[0]) / 2),
            "latMin": float(lats.min() - abs(lats[1] - lats[0]) / 2),
            "latMax": float(lats.max() + abs(lats[1] - lats[0]) / 2),
        },
        "uvMax": uv_max,
        "nTime": nt,
        # Wind frame k covers footprint frames [k*stride, (k+1)*stride). Nothing
        # downstream should recompute this from timestamps.
        "frameStride": stride,
        "framesCovered": covered,
        "levelIndex": level_index,
        "levelLabel": None if height is None else f"{float(height):.0f} m",
        "source": path,
        "sourceVars": ds.attrs.get("source_vars"),
        "sizeMB": round(size_mb, 2),
        "stationCorr": corr,
    }


def forward_model(fp_ds, flux_ds, time_step, units):
    """Modelled enhancement: sum(footprint * flux) over the full domain.

    This is the actual forward model an inversion inverts -- the sensitivity
    footprint dotted with an emissions map gives the mole-fraction enhancement
    the station should have seen above baseline. Computed over the *whole*
    domain (not the cropped view) so it stays physically correct.

    `units` is the species' own -- ppb for methane, ppt for the halocarbons --
    and is required rather than defaulted, because the one thing this function
    must never do is guess the scale. See `PPX_PER_MOL_MOL`.
    """
    scale = PPX_PER_MOL_MOL[units]
    q = flux_ds.flux.squeeze().transpose("lat", "lon").values.astype("float64")
    nt_full = fp_ds.sizes["time"]
    out = []
    for i in range(0, nt_full, 48):
        block = fp_ds.fp.isel(time=slice(i, i + 48)).transpose("time", "lat", "lon").values
        out.append((block.astype("float64") * q[None]).sum(axis=(1, 2)) * scale)
    return np.concatenate(out)[::time_step]


def _pearson(a, b):
    """Correlation without BLAS -- np.corrcoef segfaults in this environment."""
    a = np.asarray(a, dtype="float64")
    b = np.asarray(b, dtype="float64")
    m = np.isfinite(a) & np.isfinite(b)
    a, b = a[m] - a[m].mean(), b[m] - b[m].mean()
    return float((a * b).sum() / math.sqrt((a * a).sum() * (b * b).sum()))


def _land_mask_on(lats: np.ndarray, lons: np.ndarray) -> np.ndarray | None:
    """The land mask sampled onto an arbitrary lat/lon grid, or None if absent.

    Nearest-neighbour, and the mask is written on a 0-360 longitude convention
    while footprint domains may be on either -- so the lookup normalises before
    it searches. Shared so that `land_fraction` and `export_beacons` cannot
    drift into disagreeing about which cells are land; a beacon that counted a
    different coastline from the series under it would be wrong in a way nobody
    would see.
    """
    mask_path = REPO / "data" / "ancillary" / "land_cover.nc"
    if not mask_path.exists():
        return None
    lc = xr.open_dataset(mask_path)
    ml = lc.lon.values
    ci = np.abs(ml[None, :] - np.mod(lons, 360.0)[:, None]).argmin(axis=1)
    ri = np.abs(lc.lat.values[None, :] - lats[:, None]).argmin(axis=1)
    return lc.land_binary_mask.values[np.ix_(ri, ci)].astype("float64")  # (lat, lon)


def land_fraction(fp_ds, view, time_step):
    """Share of each timestep's footprint mass sitting over land.

    The stand-in for the forward model when there is no emissions inventory.
    It answers the same question the essay asks -- is the sensor looking at a
    continent or at open ocean -- using only the footprint and a land mask, so
    it works for any site whether or not fluxes exist.
    """
    fp = _slice_view(fp_ds.fp, view)
    mask = _land_mask_on(fp.lat.values, fp.lon.values)
    if mask is None:
        print("  ! no land_cover.nc, skipping land fraction")
        return None

    nt = fp.sizes["time"]
    out = np.zeros(nt)
    for i in range(0, nt, 48):
        block = fp.isel(time=slice(i, i + 48)).transpose("time", "lat", "lon").values.astype("float64")
        tot = block.sum(axis=(1, 2))
        land = (block * mask[None]).sum(axis=(1, 2))
        out[i : i + block.shape[0]] = np.divide(land, tot, out=np.zeros_like(tot), where=tot > 0)
    out = out[::time_step]
    print(f"  land fraction: min {out.min():.2f} max {out.max():.2f} mean {out.mean():.2f}")
    return out


def export_beacons(spec: dict | None, fp_ds, view: dict, time_step: int, obs=None):
    """Named regions the audience is asked to choose between, lit per frame.

    A beacon is a box of ground with a letter and a dot on a city. Its value on
    a given hour is the footprint summed over the **land** cells inside the box
    and nothing over water: emissions come off land, so sensitivity to the
    Yellow Sea is not sensitivity to Shandong -- and the boxes hold very
    different amounts of sea (43% to 99%), which made the raw sums incomparable
    for a reason that had nothing to do with the air.

    That value is divided by the box's land-cell count and compared against
    **one shared pair of absolute cuts** for all five, giving 0 dark, 1 medium,
    2 high. Dividing by area is still a normalisation, but a physical one --
    sensitivity per unit of ground that could be emitting -- and it is the same
    operation for every letter, which is exactly what per-beacon cuts were not.
    See the `beacons` block in `SITES` for why that replaced the per-beacon
    scheme the plan proposed.

    Computed here rather than in the browser: this is the footprint at full
    precision, and the page would otherwise have to re-aggregate a quantised
    atlas over five boxes on every frame to arrive at a worse answer.

    Returns `(meta_block, levels)`, `levels` being one row of small ints per
    beacon for series.json. Both are None at a site with no beacons.
    """
    if not spec:
        return None, None

    lats = fp_ds.lat.values
    lons = fp_ds.lon.values
    mask = _land_mask_on(lats, lons)
    if mask is None:
        print("  ! no land_cover.nc, skipping beacons")
        return None, None

    boxes = spec["boxes"]
    cells = []
    claimed: dict[tuple[int, int], str] = {}
    for b in boxes:
        # Half-open [lo, hi) on both axes. As first written C and D both
        # contained lat 34.5; a cell counted into two beacons would make them
        # not independent, which is the one thing act 5 asks of them.
        rows = np.where((lats >= b["lat"][0]) & (lats < b["lat"][1]))[0]
        cols = np.where((lons >= b["lon"][0]) & (lons < b["lon"][1]))[0]
        for r in rows:
            for c in cols:
                owner = claimed.setdefault((int(r), int(c)), b["id"])
                if owner != b["id"]:
                    raise SystemExit(
                        f"beacons {owner} and {b['id']} both contain the cell at "
                        f"lat {lats[r]:.3f}, lon {lons[c]:.3f} -- the intervals "
                        "must be half-open and the boxes disjoint"
                    )
        cells.append((rows, cols, mask[np.ix_(rows, cols)]))

    nt_full = fp_ds.sizes["time"]
    vals = np.zeros((len(boxes), nt_full))
    for i in range(0, nt_full, 48):
        block = fp_ds.fp.isel(time=slice(i, i + 48)).transpose("time", "lat", "lon").values.astype("float64")
        for k, (rows, cols, sub) in enumerate(cells):
            vals[k, i : i + block.shape[0]] = (block[:, rows][:, :, cols] * sub[None]).sum(axis=(1, 2))
    # Footprint-derived, so subsampled and not window-averaged: frame i *is*
    # hour i*step, the same rule the atlas and the land fraction follow.
    vals = vals[:, ::time_step]
    n = vals.shape[1]

    land_cells = np.array([c[2].sum() for c in cells])
    dead = [b["id"] for b, lc in zip(boxes, land_cells) if lc <= 0]
    if dead:
        raise SystemExit(f"beacon box(es) {', '.join(dead)} contain no land cells")
    dens = vals / land_cells[:, None]

    lo_pct, hi_pct = spec["cutPercentiles"]
    pool = dens.ravel()
    cuts = (float(np.percentile(pool, lo_pct)), float(np.percentile(pool, hi_pct)))
    levels = (dens >= cuts[0]).astype(int) + (dens >= cuts[1]).astype(int)

    print(f"  {len(boxes)} beacons over {n} frames, land cells only")
    print(f"    shared cuts at the pooled {lo_pct:g}th / {hi_pct:g}th percentile of "
          f"footprint per land cell: {cuts[0]:.3e} / {cuts[1]:.3e}")
    print(f"    {(levels > 0).sum(axis=0).mean():.1f} of {len(boxes)} lit on the average frame")

    # The answer key: the correlation between a beacon's value and the reading.
    # It is what the deck rests on, and it is invariant both to the cuts above
    # and to any constant background, so it measures the data and not the
    # tuning. Exported per box so the suite can assert a re-export has not
    # quietly inverted the argument -- nothing on screen may read it, since it
    # is the answer to the question act 5 asks the audience.
    obs_v = None if obs is None else _to_frames(obs, n, time_step)
    seen = None if obs_v is None else np.isfinite(obs_v)
    if seen is not None and seen.any():
        print(f"    answer key against {int(seen.sum())} observed frames "
              f"(r is invariant to the cuts; the separation is a difference of "
              f"means and so free of the background):")

    out_boxes = []
    for k, b in enumerate(boxes):
        rows, cols, sub = cells[k]
        lit_frac = float((levels[k] > 0).mean())
        high_frac = float((levels[k] == 2).mean())
        r = sep = None
        if seen is not None and seen.any():
            r = _pearson(dens[k][seen], obs_v[seen])
            lit, dark = seen & (levels[k] > 0), seen & (levels[k] == 0)
            if lit.any() and dark.any():
                sep = float(obs_v[lit].mean() - obs_v[dark].mean())
        inside = (view["lat"][0] <= b["lat"][0] and b["lat"][1] <= view["lat"][1]
                  and view["lon"][0] <= b["lon"][0] and b["lon"][1] <= view["lon"][1])
        if not inside:
            print(f"    ! {b['id']} reaches outside the view box -- it is still "
                  "aggregated, but the camera can never show the whole of it")
        print(f"    {b['id']} {b['name']:<20s} {len(rows):3d} x {len(cols):3d} cells, "
              f"{int(sub.sum()):4d} land ({sub.mean():.0%})  lit {lit_frac:>4.0%} "
              f"high {high_frac:>4.0%}"
              + ("" if r is None else f"   r {r:>+6.3f}"
                 + ("" if sep is None else f"  lit-minus-dark {sep:>+5.1f}")))
        out_boxes.append({
            "id": b["id"],
            "name": b["name"],
            "lat": [float(b["lat"][0]), float(b["lat"][1])],
            "lon": [float(b["lon"][0]), float(b["lon"][1])],
            # [lon, lat], matching basemap.json's [x, y] and the factory points.
            "dot": [float(b["dot"][0]), float(b["dot"][1])],
            "cells": int(sub.size),
            "landCells": int(sub.sum()),
            "landFrac": round(float(sub.mean()), 4),
            "litFrac": round(lit_frac, 4),
            "highFrac": round(high_frac, 4),
            "r": None if r is None else round(r, 3),
            "sepPpx": None if sep is None else round(sep, 2),
        })

    meta_block = {
        "mask": "land_cover.nc",
        # What the cuts are cut from, spelled out: the browser gets levels, not
        # values, and this is the only record of what a level means.
        "value": "footprint summed over land cells in the box, per land cell",
        "cutPercentiles": [float(lo_pct), float(hi_pct)],
        "cuts": [cuts[0], cuts[1]],
        "nTime": n,
        # series.beacons[i] belongs to boxes[i]. Kept parallel rather than keyed
        # by letter so the per-frame rows stay 5 x 672 small ints.
        "boxes": out_boxes,
    }
    return meta_block, [[int(v) for v in row] for row in levels]


def _to_frames(raw, n, time_step, label=None):
    """Put an hourly observation array onto the frame axis.

    Footprint-derived quantities are subsampled -- frame i *is* hour i*step --
    but observations are averaged over each window instead. Sparse instruments
    report every few hours, so plain subsampling would silently discard about
    half the Gosan samples purely because they landed on odd hours.

    `label` is what the count is reported under; pass none to stay quiet, which
    is what a second caller wanting the same array is for.
    """
    raw = np.asarray(raw, dtype="float64")
    if time_step == 1:
        return raw[:n]
    pad = n * time_step - len(raw)
    if pad > 0:
        raw = np.concatenate([raw, np.full(pad, np.nan)])
    win = raw[: n * time_step].reshape(n, time_step)
    with warnings.catch_warnings():  # all-NaN windows are expected gaps
        warnings.simplefilter("ignore", RuntimeWarning)
        out = np.nanmean(win, axis=1)
    if label:
        print(f"    {int(np.isfinite(out).sum())} of {n} frames carry {label} "
              f"after {time_step}-step averaging")
    return out


def export_series(fp_ds, species_data, time_step, out_dir, cfg, beacon_levels=None):
    """One time axis and one land-fraction series, plus a block per species.

    Observations and emissions are optional per species; whatever is present
    gets written and the page adapts to what it finds.
    """
    fpm = fp_ds.isel(time=slice(None, None, time_step))
    times = fpm.time.values
    n = len(times)

    landfrac = land_fraction(fp_ds, cfg["view"], time_step)

    def col(name, digits):
        if name not in fpm:
            return None
        return [round(float(v), digits) for v in fpm[name].values[:n]]

    def num(v, digits):
        # NaN is not valid JSON; gaps become null and the chart breaks its line.
        return None if not np.isfinite(v) else round(float(v), digits)

    blocks = {}
    summary = []
    for spec in cfg["species"]:
        key = spec["key"]
        obs, flux_ds = species_data[key]
        print(f"  {spec['label']}:")

        obs_v = None if obs is None else _to_frames(obs, n, time_step, spec["label"])
        modelled = None
        baseline = None

        if flux_ds is not None:
            modelled = forward_model(fp_ds, flux_ds, time_step, spec["units"])[:n]
            if obs_v is not None:
                baseline = float(np.nanpercentile(obs_v - modelled, 10))
                print(f"    baseline {baseline:.1f} {spec['units']}, "
                      f"corr(model, obs) = {_pearson(modelled, obs_v):+.3f}")
        elif obs_v is not None:
            # No inventory: still give the chart something to sit above.
            baseline = float(np.nanpercentile(obs_v, 10))
            print(f"    baseline {baseline:.1f} {spec['units']} (10th percentile; no inventory)")

        blocks[key] = {
            "label": spec["label"],
            "units": spec["units"],
            "obs": None if obs_v is None else [num(v, 3) for v in obs_v],
            "modelled": None if modelled is None else [num(v, 3) for v in modelled],
            "baseline": None if baseline is None else round(baseline, 3),
        }
        s = {
            "key": key,
            "label": spec["label"],
            "units": spec["units"],
            "hasObs": obs_v is not None,
            "hasModel": modelled is not None,
            "nObs": 0 if obs_v is None else int(np.isfinite(obs_v).sum()),
        }
        if obs_v is not None and np.isfinite(obs_v).any():
            s["obsMin"] = round(float(np.nanmin(obs_v)), 3)
            s["obsMax"] = round(float(np.nanmax(obs_v)), 3)
        summary.append(s)

    # Default to the first configured species that actually has measurements.
    default = next((s["key"] for s in summary if s["hasObs"]), cfg["species"][0]["key"])

    series = {
        "timeMs": [int(pd.Timestamp(t).value // 1_000_000) for t in times],
        "species": blocks,
        "defaultSpecies": default,
        "landFrac": None if landfrac is None else [round(float(v), 4) for v in landfrac],
        "windDir": col("wind_direction", 1),
        "windSpeed": col("wind_speed", 2),
        "pblh": col("PBLH", 1),
        # 0 dark / 1 medium / 2 high per frame, one row per beacon in the same
        # order as meta.beacons.boxes. Null at every site without beacons, which
        # is every site but the CFC-11 deck -- see `export_beacons`.
        "beacons": beacon_levels,
    }
    (out_dir / "series.json").write_text(json.dumps(series, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote series.json  {(out_dir / 'series.json').stat().st_size / 1e3:.0f} KB")

    return {
        "species": summary,
        "defaultSpecies": default,
        "hasLandFrac": landfrac is not None,
        "hasBeacons": beacon_levels is not None,
        "nTime": n,
    }


def export_basemap(view, out_dir, simplify=0.02):
    """Natural Earth land polygons, coastlines and borders, clipped to the view.

    Vector geography drawn on canvas beats a raster basemap here: a few tens of
    KB, no tile server, no attribution overlay, and it stays crisp through the
    region -> station zoom. Land arrives as filled polygons rather than just
    coastline strokes because the whole story rests on the reader telling ocean
    from land at a glance -- clean Atlantic air versus European emissions.
    """
    import cartopy.io.shapereader as shpreader
    from shapely import affinity
    from shapely.geometry import box

    # Natural Earth lives on -180..180. A domain that runs past the antimeridian
    # (the East Asia grid reaches 191 degrees east) needs the western geometries
    # shifted by +360 before they will clip against it, so we intersect against
    # both the in-range box and a shifted copy.
    lon0, lon1 = view["lon"]
    boxes = [(box(lon0, view["lat"][0], min(lon1, 180.0), view["lat"][1]), 0.0)]
    if lon1 > 180.0:
        boxes.append((box(-180.0, view["lat"][0], lon1 - 360.0, view["lat"][1]), 360.0))
    if lon0 < -180.0:
        boxes.append((box(lon0 + 360.0, view["lat"][0], 180.0, view["lat"][1]), -360.0))

    def clip_geom(geom):
        """Yield (geometry, lon shift) pieces of geom inside the view."""
        for clip_box, shift in boxes:
            if clip_box.is_empty:
                continue
            g = geom.intersection(clip_box)
            if not g.is_empty:
                yield (affinity.translate(g, xoff=shift) if shift else g)

    layers = {}

    # Filled land first, so the renderer can lay down ocean then stamp land.
    try:
        land_path = shpreader.natural_earth(resolution="50m", category="physical", name="land")
        polys = []
        for geom in shpreader.Reader(land_path).geometries():
            for clipped in clip_geom(geom):
                g = clipped.simplify(simplify, preserve_topology=True)
                for part in getattr(g, "geoms", [g]):
                    if part.geom_type != "Polygon" or part.is_empty:
                        continue
                    # Exterior ring plus holes (inland seas), each as a ring array.
                    rings = [[[round(x, 3), round(y, 3)] for x, y in part.exterior.coords]]
                    rings += [
                        [[round(x, 3), round(y, 3)] for x, y in interior.coords]
                        for interior in part.interiors
                    ]
                    polys.append(rings)
        layers["land"] = polys
        print(f"  land: {len(polys)} polygons")
    except Exception as exc:
        print(f"  ! skipping land: {exc}")
        layers["land"] = []

    for key, (category, name) in {
        "coast": ("physical", "coastline"),
        "borders": ("cultural", "admin_0_boundary_lines_land"),
    }.items():
        try:
            path = shpreader.natural_earth(resolution="50m", category=category, name=name)
        except Exception as exc:  # offline and not cached -- degrade, don't fail
            print(f"  ! skipping {key}: {exc}")
            layers[key] = []
            continue

        lines = []
        for geom in shpreader.Reader(path).geometries():
            for clipped in clip_geom(geom):
                g = clipped.simplify(simplify, preserve_topology=False)
                for part in getattr(g, "geoms", [g]):
                    if part.geom_type != "LineString" or part.is_empty:
                        continue
                    coords = [[round(x, 3), round(y, 3)] for x, y in part.coords]
                    if len(coords) > 1:
                        lines.append(coords)
        layers[key] = lines
        print(f"  {key}: {len(lines)} segments")

    (out_dir / "basemap.json").write_text(
        json.dumps(layers, separators=(",", ":")), encoding="utf-8"
    )
    print(f"  wrote basemap.json  {(out_dir / 'basemap.json').stat().st_size / 1e3:.0f} KB")


def _station(cfg, site, fp_ds, obs_attrs):
    """Station identity, taking whichever key set the observation file uses.

    ``id`` is the SITES key unless the site overrides it with ``station_id``.
    The two are the same thing for three of the four sites, and are not for
    "GSN-CFC11": the key names one *export* of Gosan and the label names the
    *sensor*, which is the same sensor the "GSN" export watches. The map writes
    this id beside the station dot, so it is the one field here that the
    audience reads.
    """
    a = obs_attrs
    lat = a.get("station_latitude", a.get("inlet_latitude"))
    lon = a.get("station_longitude", a.get("inlet_longitude"))
    if lat is None or lon is None:
        lat = float(fp_ds.release_lat.isel(time=0))
        lon = float(fp_ds.release_lon.isel(time=0))
    inlet = a.get("inlet_height_magl")
    return {
        "id": cfg.get("station_id", site),
        "name": str(a.get("station_long_name", site)),
        "lat": float(lat),
        "lon": float(lon),
        "inletMagl": None if inlet is None else float(inlet),
        "blurb": cfg["blurb"],
    }


def export_site(site: str, time_step: int | None = None, simplify: float = 0.02):
    cfg = SITES[site]
    time_step = cfg.get("time_step", 1) if time_step is None else time_step
    out = REPO / cfg["out"]
    out.mkdir(parents=True, exist_ok=True)
    print(f"\n=== {site} -> {cfg['out']} ===")

    fp_ds = open_footprints(cfg["fp"])
    times = fp_ds.time.values
    print(f"  {len(times)} timesteps, {pd.Timestamp(times[0]):%Y-%m-%d} .. {pd.Timestamp(times[-1]):%Y-%m-%d}")

    # Observations and any inventory, per species. Station identity comes from
    # whichever observation file first supplies it -- they all describe the same
    # inlet, so the first one that answers is as good as any.
    species_data = {}
    obs_attrs = {}
    for spec in cfg["species"]:
        obs, attrs = open_observations(spec.get("obs"), spec["key"], times)
        flux_ds = None
        if spec.get("flux"):
            matches = sorted(glob.glob(spec["flux"]))
            if matches:
                flux_ds = xr.open_dataset(matches[0])
            else:
                print(f"  ! no flux file at {spec['flux']}")
        species_data[spec["key"]] = (obs, flux_ds)
        if not obs_attrs and attrs:
            obs_attrs = attrs

    print("footprint atlas ...")
    fp_meta = export_footprint(fp_ds, cfg["view"], time_step, out, mass_tol=cfg.get("mass_tol", 0.01))

    # One emissions raster per site: the map can only show one at a time, so it
    # comes from the first species that has an inventory.
    flux_meta = None
    for spec in cfg["species"]:
        _, flux_ds = species_data[spec["key"]]
        if flux_ds is not None:
            print(f"flux ({spec['label']}) ...")
            flux_meta = export_flux(flux_ds, cfg["view"], out, spec.get("flux_log_range"))
            flux_meta["species"] = spec["key"]
            break

    # Before the series, because the levels ride inside series.json. The
    # observations are handed over only so the answer key can be measured and
    # reported; the beacons themselves are footprint and land mask alone.
    print("beacons ...")
    beacon_obs = next(
        (species_data[s["key"]][0] for s in cfg["species"]
         if species_data[s["key"]][0] is not None),
        None,
    )
    beacons, beacon_levels = export_beacons(
        cfg.get("beacons"), fp_ds, cfg["view"], time_step, beacon_obs)

    print("series ...")
    series_meta = export_series(fp_ds, species_data, time_step, out, cfg, beacon_levels)

    print("hi-res emissions ...")
    flux_hires = export_flux_hires(cfg.get("flux_hires"), cfg["view"], out)

    print("factories ...")
    factories = export_factories(cfg.get("factories"), cfg["view"], cfg["species"], fp_meta)

    print("basemap ...")
    export_basemap(cfg["view"], out, simplify=simplify)

    station = _station(cfg, site, fp_ds, obs_attrs)

    print("wind ...")
    wind_meta = export_wind(cfg.get("wind"), cfg["view"], out, fp_ds, time_step,
                            station.get("inletMagl"), station)

    view = cfg["view"]
    meta = {
        "station": station,
        "species": series_meta["species"],
        "defaultSpecies": series_meta["defaultSpecies"],
        "view": {"latMin": view["lat"][0], "latMax": view["lat"][1],
                 "lonMin": view["lon"][0], "lonMax": view["lon"][1]},
        "footprint": fp_meta,
        "flux": flux_meta,
        "fluxHires": flux_hires,
        "factories": factories,
        # Null at every site but the CFC-11 deck. Optional the whole way down,
        # like `factories`: a consumer gates on this being present rather than
        # assuming the boxes are there.
        "beacons": beacons,
        "wind": wind_meta,
        "series": series_meta,
        "timeStepHours": time_step,
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"done -> {out}")
    print(f"  {station['name']}  ({station['lat']:.3f}, {station['lon']:.3f})")
    for s in series_meta["species"]:
        print(f"    {s['label']:8s} obs={s['nObs']:5d}  model={'yes' if s['hasModel'] else 'no'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--site", default="RGL", help=f"one of {', '.join(SITES)}, or 'all'")
    ap.add_argument(
        "--time-step",
        type=int,
        default=None,
        help="keep every Nth timestep; defaults to the site's configured value",
    )
    ap.add_argument("--simplify", type=float, default=0.02, help="coastline simplification, degrees")
    args = ap.parse_args()

    sites = list(SITES) if args.site == "all" else [args.site]
    for s in sites:
        if s not in SITES:
            raise SystemExit(f"unknown site {s!r}; known: {', '.join(SITES)}")
        export_site(s, args.time_step, args.simplify)


if __name__ == "__main__":
    main()
