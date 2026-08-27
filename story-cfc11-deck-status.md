# The repo — what each part does, and where it stands

A reference to the code as it is, not a plan. Written against the working tree of
`interactive_GHG_plots-gsn` (branch `story-gsn`, `data/` junctioned to the main
checkout), and every number in it was read off the shipped data or a command run
rather than remembered.

Three sibling docs own their own ground and are not repeated here:

| doc | covers |
|---|---|
| `WEB_PIPELINE.md` | the explorer, the atlas encoding, the dispersion model, the design rules |
| `story-deck-status.md` | the Ridge Hill deck, slide by slide, and its to-do list |
| `story-cfc11-brief-deck.md` | the brief the CFC-11 scaffold was built to |

**Everything checked, as of this writing:**

```
node web/js/story/selftest.mjs      rgl: 464 · gsn: 238 · cfc11: 332 · all green
node web/js/selftest.mjs            all self-tests passed
python scripts/verify_export.py     all four sites -> all checks passed
```

---

## 1. What the repo is

One dataset — NAME footprints, instrument observations, emissions maps — read
four ways.

1. **The original notebook.** `outreach_plots.ipynb` on `plotting_tools/`: a
   matplotlib slider figure. Still the reference implementation of what the
   pictures mean, and the reason everything else exists — it ran a second or two
   per frame.
2. **The explorer.** `web/explore.html`: the same figure rebuilt in canvas, a
   month of hourly data at 60 fps. A working tool, driven by the user.
3. **Three presenter decks.** `web/story*.html`: the same map on rails, one
   caption at a time, for talking over in front of a room.
4. **The sonification.** `web/listen.html` and `web/sound-lab.html`: the same
   archive as a score — measurement as pitch, footprint geometry as percussion.

The Python side never runs in the browser and the browser never opens a netCDF.
`scripts/export_web_data.py` is the only bridge, and `web/data-*/` is the only
thing it produces.

---

## 2. Running it

```bash
node scripts/serve.mjs                          # or double-click serve.cmd
```

then `explore.html`, `listen.html`, `story.html`, `story-gsn.html`,
`story-cfc11.html`.

⚠ **No page here can be opened over `file://`.** Browsers block ES modules and
`fetch`, so the module script never runs and the page hangs with nothing in the
console. Every page carries a **classic, non-module** script that detects `file:`
and says so on screen; keep it non-module or the warning is blocked too.

Rebuilding the data, and checking it:

```bash
python scripts/export_web_data.py --site all     # or --site GSN-CFC11
python scripts/verify_export.py                  # re-derives everything from source
node web/js/selftest.mjs                         # explorer logic, headless
node web/js/story/selftest.mjs                   # all three decks, headless
```

---

## 3. Layout

| path | what it is |
|---|---|
| `plotting_tools/` | the matplotlib originals: `load_data.py` (`load_fp`, `load_obs`, `load_flux`), `interactive_plots.py` (`plot_timeseries`, `plot_footprint`, `make_figure`) |
| `outreach_plots.ipynb` | the notebook those drive |
| `scripts/` | the export pipeline and its measuring tools — see §4 |
| `web/js/` | the shared browser modules — see §5 |
| `web/js/story/` | the deck fork: engine, deck, a forked mapview, one beats file per deck |
| `web/data-*/` | the exports. Generated; never hand-edited |
| `data/` | inputs, junctioned to the main checkout. 1.6 GB of footprints, obs, fluxes and met |
| `figs/` | notebook output, and the README's illustrations |

---

## 4. The Python pipeline

### `scripts/export_web_data.py` — 1,956 lines, the only way data reaches the browser

`SITES` at the top is the whole configuration: four entries, each naming a
footprint glob, a species list, a view box, a frame step, and optional blocks for
`flux`, `flux_hires`, `factories`, `wind` and `beacons`. **Every optional block is
optional in the same way** — absent means the corresponding `meta` key is `null`
and every consumer draws nothing, rather than failing.

What it writes into `web/data-<site>/`:

| output | function | what it holds |
|---|---|---|
| `fp_atlas.png` | `export_footprint` | the whole footprint tensor as one greyscale sprite atlas, log₁₀ to 8 bits, one tile per timestep |
| `series.json` | `export_series` | per-frame observations, the forward model, `landFrac`, beacon levels, the baseline |
| `meta.json` | `export_site` | grids, ranges, station, and one block per optional layer |
| `basemap.json` | `export_basemap` | coastlines, simplified to 0.02° and rounded to 3 dp |
| `flux.png` | `export_flux` | the emissions map on the footprint grid |
| `flux_hi.png`, `src_*.png` | `export_flux_hires` | finer emissions rasters, and Ridge Hill's three source families |
| `wind_u.png` / `wind_v.png` | `export_wind` | eastward and northward m/s, packed like the footprint atlas |

Functions worth knowing by name:

- **`forward_model(fp_ds, flux_ds, time_step, units)`** — footprint × emissions,
  cell for cell. `units` is **required**, not defaulted: it keys into
  `PPX_PER_MOL_MOL` (`ppb: 1e9`, `ppt: 1e12`), and the one thing this function
  must never do is guess the scale.
- **`export_beacons`** — the CFC-11 deck's five regions (§8). Land-only footprint
  sum inside each box, divided by the box's land-cell count, cut at one shared
  pair of absolute thresholds. **Raises rather than exporting overlapping boxes**,
  naming both letters and the shared cell.
- **`_land_mask_on`** — shared with `land_fraction`, so a beacon and the series
  under it cannot disagree about which cells are land.
- **`anemometer_is_real(fp_ds)`** — a record that is missing, too short, or
  *present but constant* is not an anemometer. Gosan's `wind_speed` is 1,344
  finite values, every one exactly `0.0`; without this predicate `stationCorr`
  came out `NaN` and `json.dumps` wrote the bare token `NaN`, which Python
  re-reads happily and **`JSON.parse` refuses** — the page would have died before
  drawing anything.
- **`_pearson`** — every correlation in the pipeline. `np.corrcoef` is not used;
  see §11.
- **`_encode_flux`** reserves byte 0 for "nothing here" and treats anything ≤ 0 as
  such, which is how regridder ringing draws as empty rather than as a sink.

### `scripts/verify_export.py` — re-derives, does not trust

Opens the source netCDFs again and **re-encodes the rasters, demanding the bytes
match**. Also checks centroid drift, the station cell's rank, the beacon boxes'
disjointness, that a letter lights sometimes and not always, and that the shipped
levels match the `litFrac` in `meta.json`. It prints the beacon answer key on
every run, so a re-export cannot move the deck's argument quietly.

### `scripts/slice_met.py` — the wind slice

Cuts a zarr met store down to one level and one time axis. `--store` and `--site`
are both required; the output filename's period comes from the store's own time
axis.

⚠ **It reads `wind_vertical_regrid` to decide which height table applies**, and
this is not cosmetic. The two stores were extracted differently:

| store | mode | u/v heights |
|---|---|---|
| `EUROPE_RGL_Met_2020` | `interpolate` | de-staggered onto theta levels — `level_height` applies |
| `EASTASIA_GSN_Met_2016` | `snap` | **native rho-level values with theta labels** — true heights are in `wind_level_height_rho` |

So on the East Asia store the five levels are physically at **10.0 · 36.7 · 76.7 ·
130.0 · 196.7 m**, not the 20/53.3/100/160/233.3 m that `level_height` advertises.
Anything reading `level_height` off that store blindly is out by roughly a factor
of two.

Two level-choosing tables: the anemometer correlation (**refuses to run on a
constant record**, and says why) and a transport diagnostic that needs no
instrument — the bearing of the footprint's centre of mass within *R* km against
each level's wind direction. `--frame-step N` pre-aligns the time axis to the
deck's frames, which is the only place that decision can live.

### `scripts/coarsen_flux.py`

Block-sums a fine raster onto a coarser round graticule, exactly conservatively —
ten 1/120° cells tile one 1/12° cell, so no overlap arithmetic and no
interpolation. `blocked_edges()` offsets the blocks to the first whole multiple of
the output step; starting them at fine index 0 put the first coarse edge *inside*
the view and left a strip with no map.

### `scripts/measure_beacons.py`

The CFC-11 answer key, measured against the shipped `series.json`. No code ships
from it; the numbers do, and the exporter reproduces them independently.

### Node helpers

| script | what |
|---|---|
| `serve.mjs` | static server for `web/`, steps to the next free port. Node rather than Python because `node` is reliably on PATH here |
| `frame_at.mjs` | which frame is a given moment — the lookup a new beat is written from. `node scripts/frame_at.mjs cfc11 "5 Jul 2016 23:00"` |
| `measure_seeding.mjs` | what the drifting parcels actually land on, decoded from the real atlases with node's own zlib |

---

## 5. The browser

### Shared modules — `web/js/`

| module | what it owns |
|---|---|
| `data.js` | decodes the atlases **one tile-row at a time** (the whole atlas through `getImageData` would spike ~43 MB); exposes `data.beacons`, `data.has.*` |
| `mapview.js` | canvas map, plate carrée, camera. A frame is one `putImageData` plus one scaled `drawImage` |
| `timeseries.js` | observed and modelled on **one** axis, because they are the same quantity in the same units |
| `palette.js` | roles not hexes; two sequential ramps for magnitude, two categorical slots for series identity, CVD-validated. `fluxLUT()`, `SOURCE_DISPLAY_BY_SPECIES` |
| `wind.js` | turns `wind_u/v.png` back into a field you can sample at any lon/lat and any moment. Reads everything from `meta.wind` and re-derives nothing |
| `advect.js` | air parcels carried by that field. Parcels rather than arrows: an arrow states a direction, a parcel shows it |
| `particles.js` | the backward dispersion — particles drawn from the real footprint field, weighted by sensitivity |
| `explorer.js` | the explorer page's wiring |
| `sonify.js` / `audio.js` | the score and the instrument, split so the mapping is testable in Node where no `AudioContext` exists |
| `pianoroll.js`, `listen.js`, `sound-lab.js`, `tuning.js` | the listen page, the workbench, and the one-way live retuning channel between them |

### The story fork — `web/js/story/`

| module | what it owns |
|---|---|
| `engine.js` | the deck machinery with no story in it: caption rules, frame overrides, play windows, act flattening. **No DOM, no canvas, no imports**, so the suite can assert on every caption without a browser |
| `deck.js` | the presenter runtime — fullscreen map, one caption, one meter, one date; live-editable moments |
| `mapview.js` | a **deliberate fork** of `../mapview.js`, additive only: graticule, beacons, the hi-res emissions rasters. Keeps the explorer's copy byte-identical |
| `beats-rgl.js`, `beats-gsn.js`, `beats-cfc11.js` | one deck's story each: frames, cameras, acts, captions |
| `beats.js` | ⚠ **a shim, marked for deletion.** One caller left: `scripts/measure_seeding.mjs`, which imports `FRAMES` and `RELEASES` from it |
| `selftest.mjs` | 3,081 lines, all three decks, headless. Stubs a canvas and exercises the drawing code |

---

## 6. The four exports

All four verify green. Sizes are the directory on disk.

| dir | station | species | period | frames | size | layers |
|---|---|---|---|---|---|---|
| `data-rgl` | Ridge Hill, UK | CH₄ | Feb 2020 | 696 hourly, **696 observed** | 4.3 MB | flux, hi-res + 3 source families, wind (100 m) |
| `data-gsn` | Gosan, Jeju | HFC-23, CFC-11 | Jun–Aug 2016 | 1,044 two-hourly | 5.5 MB | hi-res EDGAR v8 HFC-23, 42 plant sites |
| `data-gsn-cfc11` | Gosan, Jeju | CFC-11 | Jun–Jul 2016 | 672 two-hourly, **365 observed** | 5.0 MB | flux + ~10 km hi-res, wind (77 m), **beacons** |
| `data-gsn-2021` | Gosan, Jeju | HFC-23 | Feb–May 2021 | 1,440 two-hourly | 5.0 MB | plant sites. Explorer only |

The explorer's switcher links the first, second and fourth. `data-gsn-cfc11` is
the CFC-11 deck's, and is not in that list.

---

## 7. The three decks

| page | deck | suite | state |
|---|---|---|---|
| `story.html` | *Can I smell it?* · Ridge Hill · CH₄ | 464 | **the finished one.** 6 acts, 19 slides — `story-deck-status.md` |
| `story-gsn.html` | *What should we smell?* · Gosan · HFC-23 | 238 | ships. Inventory and plant list against the air |
| `story-cfc11.html` | *Which one can we smell?* · Gosan · CFC-11 | 332 | **scaffold with a working beacon layer.** §8 |

**Ridge Hill's 464 is a fixture.** It has held through the engine split, the meter's
third state and the beacon work; every check added since is behind a gate that
deck does not pass through. A change that moves it has reached further than it
meant to.

---

## 8. The Gosan CFC-11 deck

### What it argues

Same island and the same footprints as the HFC-23 deck, but CFC-11 over June and
July 2016 — and **no inventory and no factory list**, because for this gas in this
region there is none. What it has instead is a game: five named regions, each lit
on the hours the station can smell that direction, and a bar saying how much is
arriving. Watch long enough and one region is lit on *every* smelly hour.

The answer is **Shandong**, and it is measured.

### The answer key — printed by `verify_export.py` on every run

Beacon value is the footprint summed over **land cells only** inside the box,
divided by the box's land-cell count. Land only because emissions come off land,
and per land cell because the five boxes hold very different amounts of sea (B is
43% land, D is 99%) and were otherwise incomparable for a reason that had nothing
to do with the air.

| | region | box | dot | land | lit | **r vs. reading** | lit − dark |
|---|---|---|---|---|---|---|---|
| **A** | South Korea | 34.5–38.2 N, 126.0–129.6 E | Seoul | 72% | 43% | **−0.056** | −4.9 |
| **B** | Western Japan | 32.5–36.0 N, 129.6–136.0 E | Fukuoka | 43% | 50% | **−0.179** | −7.1 |
| **C** | **Shandong** | 34.5–38.2 N, 115.0–122.5 E | Jinan | 69% | 23% | **+0.873** | **+16.5** |
| **D** | Anhui and Jiangsu | 31.5–34.5 N, 116.0–120.5 E | Nanjing | 99% | 25% | **+0.522** | +10.1 |
| **E** | South of Shanghai | 28.3–31.2 N, 118.8–122.5 E | Hangzhou | 73% | 34% | **+0.085** | +5.7 |

Why this table is the deck:

- **C is the answer and it is not close.** For scale, the HFC-23 deck's central
  claim runs on r = +0.50.
- **A and B are honest negatives.** Korea is flat; Japan is *anti*-correlated —
  when the station is looking at Japan the reading is below average. So "yes we
  can smell them, no they aren't smelly" is data, not staging.
- **D keeps it a game.** At +0.52 the two western beacons light together and the
  room has to choose.

⚠ **`r` and `sepPpx` ride in `meta.beacons.boxes[]` so the suite can assert the
argument has not inverted. Nothing on screen may read them** — they are the answer
to the question the deck asks the audience, and the suite checks that no caption
gives it away.

Boxes are `[lo, hi)` on both axes. The cuts are the pooled **65th / 90th
percentiles** (`cutPercentiles` on the site config) — a tuning knob for how busy
the map looks, and nothing else: **correlation does not care where a threshold
sits**, so no setting of it can change the answer.

⚠ **B's dot is Fukuoka, not Osaka.** Osaka (135.5 °E) is outside the met store.

### The beacon layer

Drawn by `_drawBeacons` in `web/js/story/mapview.js`: the box, a dot on the city,
and the letter, always visible. Three states — dark, lit, lit hard — carried by
**fill, ring weight and radius together**, never by tone alone. The letters are
identity and never change with the state. `_beaconInk` measures both candidate ink
colours against the fill and picks the better one; the suite holds the worst case
at 5.5:1.

### The acts as built

| act | stops | state |
|---|---|---|
| `where` | Gosan, wide, the neighbours | inherited shape |
| `clean-wind` | the quiet day, wind live | still pictures — 378 and 380 are blank |
| `clean-smell` | the plume, bar near empty | " |
| `sources` | the question on an empty map, then the population guess | ships |
| `dirty` | 26 Jun, the reading high | anchor 301, window 301..306 |
| `beacons` | five dark, then B, A+B, C, D, E | **the beacon layer, exercised in every state** |
| `record` | three weeks hour by hour, 180..379 at 9/s | crosses the 74 h join, knowingly |

The `game` act the deck is *for* — guess-then-reveal, built out of stops — is not
built. **Every caption in the file is a placeholder**: inside the ten-word cap and
clear of the banned list, which the suite enforces, but that is a floor.

### The anchors, the bar and the wind

| | frame | UTC | KST | reading | over 232.3 | bar |
|---|---|---|---|---|---|---|
| **dirty** | **301** | 26 Jun 02:00 | Sun 26 Jun 11:00 | 275.5 | +43.2 | 64% |
| **clean** | **379** | 5 Jul 14:00 | Tue 5 Jul 23:00 | 234.5 | +2.2 | 3% |
| record max | 287 | 24 Jun 22:00 | 25 Jun 07:00 | — | **+64.3** | 94.6% |

301 is preferred over the frame it replaced (180, within 0.9 ppt) **for the run
behind it, not the reading on it**: 298..300 are blank, so the anchor opens a
six-frame observed run instead of sitting inside a five-frame one. Frame 287 sits
inside a 12-frame observed run, so it is not the isolated spike that bit the
HFC-23 deck.

`SMELL = { base: 232.3, span: 68 }`.

⚠ **The base is the observations' own 10th percentile (232.387) rounded down, and
must not be read off `series.json`'s `baseline`.** That field changes meaning
depending on whether the site has an emissions map — with none it is the 10th
percentile of the readings, with one it is the 10th percentile of *reading minus
modelled*, currently **230.926**. The bar draws the **raw reading**, so its floor
is a statement about what clean air at Gosan measures. Letting a guessed emissions
map slide it would move the audience's bar because we changed our minds, on a deck
about measurement. Rounded *down* because a 10th percentile puts a tenth of the
readings at or below it by construction.

Wind: level 2, **true height 76.7 m**, 224 steps on a uniform 3-frame stride
covering frames 0..669 of 672, `uvMax` 37.0 (true maximum in view 36.52 m/s, 0%
clipped, 0.291 m/s step). `RELEASES.hours` is **12, not Ridge Hill's 36** — 36 h
would run the back-trajectory fan off the eastern edge.

⚠ **`DOMAIN` can never carry wind.** It reaches lon 140.09 and the wind stops at
134.95, so it would draw a hard vertical edge 29 columns in. Every wind stop uses
`OCEAN` or `CHINA`, and the suite checks this per stop against the *wind* grid.
The `beacons` act uses `DOMAIN` and carries no wind, which is fine and deliberate:
B's box reaches lon 136.0, and `DOMAIN` is the only camera that holds all five
boxes whole.

### The emissions map is a guess, and the deck says so

`cfc-11-population_EASTASIA_2016.nc` — 40 Gg of CFC-11 spread by WorldPop R2025A
2016 population, scaled so the view holds **15.055 Gg/yr**, about 10.6 g per
person per year. It ships at two resolutions on **one shared −18…−10 encoding
window**, because the two files are the same field and a byte must mean the same
emission on both.

⚠ **r = +0.693 between the model and the reading must never be quoted as the map
being right.** `landFrac` — the share of the footprint over land, carrying no
emissions information at all — scores **+0.633** on the same series. Knowing
nothing but "is the sensor looking at land" gets almost all of it. What the
correlation measures is that the wind comes off the continent on the smelly days,
which is the deck's own point. This is an argument *for* the deck: the guess
everyone starts from is barely better than knowing nothing, which is why the
beacon game is worth playing.

`flux.png` ships but is **drawn by no stop** — it stays because `meta.flux` drives
the tuning panel's reset and the per-species display window, at a cost of 6 KB.

---

## 9. Measured once — do not re-derive

- **The footprint time axis is not contiguous, and concatenation hides it.**
  `open_footprints` uses `combine="by_coords"` and joins the files silently, so
  frame index → time is non-linear. On the CFC-11 axis the joins are at frame
  **324** (27 Jun 22:00 → 1 Jul 00:00, a **74-hour** step), **504** and **588**.
  A play window crossing one jumps days mid-animation with nothing on screen
  saying so. `record` crosses 324 knowingly; **the shipped HFC-23 deck has the
  same bug at the same join**.
- **46% of the CFC-11 record has no reading** — 365 of 672 frames observed. Ridge
  Hill is 696 of 696 and can never reach the meter's third state; Gosan reaches it
  on 341 frames, this deck on 307.
- **The met store stops at lon 134.77**, 29 of the view's 114 columns short of the
  eastern edge. That crop is made by the data, so `lonMax` would be a no-op and is
  omitted. It also bounds the cameras eastward and picks B's dot.
- **No met lead-in before 1 June**, and frames 670–671 run past the store's end and
  clamp. Both ends are free only while the deck's frames stay clear of them.
- **Gosan has no usable anemometer**: 1,344 finite values, all exactly 0.0. The
  level was chosen by the transport diagnostic instead, calibrated at Ridge Hill
  where the answer is known — there the 200 km mean picks the level the anemometer
  picks, and the statistic drifts upward with radius, which is the physics.
- **The 3-hourly met cadence is impossible here**, not merely unwanted:
  `export_wind` requires every wind step to land on an exported frame at a uniform
  stride, and the frame axis is even hours only. 3-hourly and 6-hourly converge on
  the same 224 steps.
- **The population prior's grid is bit-identical to the footprint grid** — 340 ×
  391, both coordinate arrays equal element for element — so nothing in this deck
  needs regridding anywhere.
- ⚠ **The retired `cfc-11-population_EASTASIA_2002.nc` was misregistered** by about
  1.5 cells north and 0.5 east (≈39 km / 16 km), measured against mosaicked 1 km
  WorldPop tiles over four independent regions that agreed to the quarter-cell.
  It also had 52% negative cells. The 2016 rebuild is correctly registered by
  construction and has none. **Do not "fix" a registration offset by shifting a
  raster.**
- **The 1 km raster was an aliasing machine at this deck's cameras.** A 0.00833°
  cell draws at 0.39 px on `DOMAIN`; about 8% of cells survived the downscale and
  *which* 8% moved with the camera. Coarsened to 1/12°, `flux_hi.png` went 4.48 MB
  → 60 KB and the whole site 9.6 → 5.0 MB.

---

## 10. Rules the suites enforce

- **Ten words a caption**, and no jargon on screen ever — `ppt` and `ppb` are both
  in `BANNED_WORDS`. Caption ≥ 28 px. One number at a time.
- **Colour is never the only channel.** Beacon states carry ring weight and radius
  as well as fill; the meter's "no reading" state carries diagonal hatching *and*
  the words, neither of them a hue, because grey is already the empty track.
- **Playback must come to rest on a reading.** `from`, every `holdAt` and `to` are
  frames the deck stops on and talks over. Crossing blank hours mid-window is
  allowed — the meter can say "no reading" — and whether an anchored window
  *should* cross a gap is a story decision, not a rule.
- **A window must actually play through blank hours somewhere**, or the meter's
  third state could ship dead and nothing on screen would look wrong.
- **The stylesheet's half and the deck's half are asserted separately** for the
  same reason, and `no rule gives the note a display` is a layout-stability claim:
  `record` steps nine frames a second across a record a third empty, so a note that
  took its space as it appeared would make the meter jump for twenty seconds.
- **Wind stops must use a camera the wind field covers**, checked against the wind
  grid rather than the footprint grid.
- **A hi-res raster's stop must fly in far enough for its cells to read.**
- **Beacon boxes are disjoint**, every letter is on screen in every state, and no
  caption names the answer.

---

## 11. Traps

- ⚠ **`np.corrcoef` and `np.linalg.inv` crash this interpreter** — BLAS delay-load,
  exit `0xC06D007E`, no traceback. Use `_pearson()`. Every correlation in the
  pipeline is computed from sums for this reason.
- ⚠ **Piping the exporter's stdout** drops Python to cp1252 and a species label
  raises `UnicodeEncodeError` before any work is done. `PYTHONIOENCODING=utf-8`.
- ⚠ **zarr must stay 2.x** — the met stores were written for it. numpy is pinned at
  1.26.4 so the fragile BLAS is untouched.
- ⚠ **Python's `glob` has no brace expansion.** `2016{06,07}.nc` silently matches
  nothing; the character class `20160[67].nc` is what the config uses.
- ⚠ **`git clean -fdx` in this worktree would delete through the `data` junction**
  and take 1.6 GB of inputs with it. Never run it here.
- ⚠ **PowerShell mangles these docs.** `Get-Content -Raw` on a UTF-8 file with no
  BOM reads it as the ANSI codepage, so piping into `Add-Content -Encoding utf8`
  double-encodes every non-ASCII character — each `—` becomes `â€”`, each `⚠`
  becomes `âš `. Append with `cat a >> b` from bash, which is byte-exact.
- ⚠ **PowerShell also mangles inline Python.** Write a script to a file and run it.
- **A re-export of an older site can materialise drift that is not yours** —
  rasters re-compress (pixels identical; `verify_export` compares decoded arrays),
  and old `meta.json` files gain keys the current code writes.

---

## 12. Environment

- **Python is** `C:\Users\ef17148\AppData\Local\miniconda3\envs\gates_basic2\python.exe`.
  `conda` is not on `PATH`, `conda activate` fails in this shell, and bare `python`
  is the Windows Store stub. Call the interpreter by its full path.
- `node` is on `PATH`. `node scripts/serve.mjs` steps to a free port on its own;
  check which root it printed, since a second server is indistinguishable from the
  first by URL.
- **No browser automation exists.** The headless suites stub a canvas and exercise
  the drawing code — extend them rather than assuming a change works. A bug that
  only shows in the browser costs a round trip.
- The environment is in `env.yml`.

---

## 13. Open work

**The CFC-11 deck**

- **The `game` act.** The seven acts above run; the guess-then-reveal the deck
  exists for is not built, and every caption in the file is a placeholder.
- ⚠ **The chronology.** The clean day (5 Jul) is *after* the dirty one (26 Jun) and
  the acts still run clean-first, so the date stamp on screen goes backwards
  between `clean-smell` and `dirty`. Survivable in a scaffold, not shippable.
  Fixing it means reordering the acts or picking a clean day before 16 June — not
  editing captions.
- ⚠ **`record` still crosses the 74-hour join at frame 324**, as does the HFC-23
  deck. The suite has no discontinuity check; adding one would cover all three
  decks at once.
- **`record`'s comment is stale.** It says "180..379 runs from the dirty day to the
  clean one"; with `dirty` at 301 the window starts 121 frames before the dirty day
  and passes through it mid-flight. The playback is correct — `holdAt` resolves by
  name — but 180 is now an orphan number with nothing naming it.
- **There is no continuous sweep to be had.** The longest fully-observed gap-free
  run is 12 frames and none crosses from lit-but-clean to C-high, so act 5 is stops
  rather than playback. If motion is wanted at the reveal, `156..162` is the one
  honest 14-hour run where C is lit and the bar climbs.
- **The flat prior is unused.** `cfc-11_EASTASIA_2000.nc` holds two values in the
  entire field — a two-tone rectangle. As one contrast slide it says *the other
  guess was a rectangle*, which is a strong line about how little was known.
- **`RELEASES` past `hours: 12` is still Ridge Hill's shape and unmeasured.**
  `measure_seeding.mjs` against this wind field is the outstanding job.

**The pipeline**

- **`SITES` has no time-window option.** Every site takes its whole footprint glob;
  the CFC-11 window is cut by which files the glob matches.
- **`beats.js` is a shim waiting on one caller.** Give `measure_seeding.mjs` a
  `--site` argument pointing at `beats-<site>.js`, then delete it.
- **The `copy frames` button and the `moment:` readout are gone** from `deck.js`.
  `?tune=1` and the `[` `]` nudges still work and frames are still written to
  `localStorage` per deck, but there is no one-click way to get them back out for
  pasting into a beats file.
- **`data.js` decodes every raster at page load** — the CFC-11 site is 5.0 MB of
  PNG. It has not been timed on the presentation machine.
