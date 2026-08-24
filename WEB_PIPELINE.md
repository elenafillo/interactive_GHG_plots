# The interactive footprint explorer

A browser rebuild of the matplotlib slider figure: a map showing the transport
footprint for a given hour, a timeseries of what the instrument actually
measured, and the link between them. It runs a month of hourly data at 60 fps
where the matplotlib version took a second or two per frame.

There are three datasets so far — Ridge Hill methane, and two Gosan windows
either side of the HFC-23 abatement claims.

---

## Running it

**Double-click `serve.cmd`.** It starts a local server and opens the page.

Equivalently, from a terminal:

```bash
node scripts/serve.mjs           # or: python -m http.server 8765 --directory web
```

**You cannot open `explore.html` from the filesystem.** Browsers block ES modules
and `fetch` over `file://`, so `explore.js` never executes and the page sits on
"starting up" forever — with nothing in the console, because the script that
would have reported the error is itself what got blocked. The page now detects
`file:` and says so on screen instead of hanging, but it still cannot run that
way; it has to be *served*.

`serve.mjs` uses Node rather than Python on purpose: `node` is reliably on PATH,
whereas `python` on PATH here is the Windows Store alias and the real interpreter
lives in a conda env that `conda activate` cannot reach from this shell. It steps
to the next free port if 8765 is taken, so an old server from a previous session
is not a problem.

Switch datasets from the links at the top, or directly:

| URL | Station | Species | Period |
|---|---|---|---|
| `explore.html?data=data-rgl/` | Ridge Hill, UK | CH₄ | Feb 2020 |
| `explore.html?data=data-gsn/` | Gosan, Jeju | HFC-23, CFC-11 | Jun–Aug 2016 |
| `explore.html?data=data-gsn-2021/` | Gosan, Jeju | HFC-23 | Feb–May 2021 |

To rebuild the web assets from the netCDF files:

```bash
python scripts/export_web_data.py --site all      # or --site GSN-2021
python scripts/verify_export.py                   # checks them against source
node web/js/selftest.mjs                          # checks the browser logic
```

---

## Why it is fast

The matplotlib version is slow for a structural reason: every timestep
re-renders a 15,000-cell `pcolormesh` through a projection. Drawing the same
grid as SVG in D3 would be no better — one DOM node per grid cell is the same
problem wearing a different hat.

So the rule here is **pre-render the data, not the pixels**.

`scripts/export_web_data.py` packs the whole footprint tensor into a single
greyscale PNG: one tile per timestep, laid out in a grid. The browser decodes it
*once* into a flat `Uint8Array`, and from then on any timestep is a subarray
away. Painting a frame is one `putImageData` into a small offscreen canvas plus
one scaled `drawImage` — about a millisecond, regardless of how long the month
is. Scrubbing the slider costs a memcpy.

The projection is plate carrée, which is not a compromise but the reason the
above works: because screen position is a linear function of longitude and
latitude, the footprint can be blitted as an axis-aligned rectangle with no
reprojection and no per-cell work.

The alternative — pre-rendering PNG frames in cartopy — would have baked in the
colormap, the zoom level and the projection. Restyling, changing the colour
scale, or flying the camera from region to station would all mean re-rendering
everything. Here they are all live, and swapping in a new site is a config entry.

### What it costs

The footprint spans about five orders of magnitude, so values are stored
log₁₀-scaled to 8 bits. That quantises to roughly 4.3% per level, which is far
below the uncertainty in the footprints themselves, and `verify_export.py`
measures it every run.

Two encoding decisions are worth knowing about:

- **The floor is set by mass, not by a percentile.** The export discards the
  smallest cells that together hold 1% of the footprint's total mass. At Ridge
  Hill that removes *half the cells* in exchange for 1% of the signal, because
  the far field is a vast number of individually negligible values — and those
  cells are what a PNG spends most of its bytes on. This is what took the Ridge
  Hill atlas from 2.7 MB to 1.5 MB.
- **Display contrast is separate from the stored range.** The atlas encodes all
  the way to the field's true maximum; the colour ramp saturates at the 99.9th
  percentile. Doing this in one step, as the first version did, clipped the
  cells nearest the inlet by a factor of about seven — invisible in the picture,
  but it corrupted anything computed from the decoded array, and it moved the
  field's centre of mass by 1.2°. Encoding faithfully and saturating only in the
  colour lookup keeps the picture punchy and the numbers honest.

---

## The backward particle dispersion

This is the part that is worth getting right, because it is the actual mechanism
behind a footprint rather than a metaphor for one.

**What a footprint is.** A Lagrangian dispersion model — NAME here, FLEXPART
elsewhere — releases thousands of notional air parcels at the inlet and runs the
meteorology *backwards* in time. Each parcel wanders upwind, buffeted by
turbulence. Where those parcels spend their time near the ground, the station is
sensitive to emissions: if there is a source there, the station will smell it.
Add up the parcel time-near-surface over every grid cell and you have the
footprint. It is a map of *where the air came from*, weighted by how much
attention the instrument was paying to each place.

That is why the picture works as a story. When the footprint lies over the
Atlantic, the air arriving at Ridge Hill last touched the ground days ago and
thousands of miles away, so it is clean. When it lies over the Low Countries,
the air has just crossed some of the densest methane emissions in Europe, and
the reading climbs.

**How the animation stays honest.** We have the time-integrated footprint, not
the individual trajectories — those are not in the output files. So the
animation reconstructs parcels that agree with the data everywhere it can:

- every parcel leaves the **real station coordinates**;
- its destination is **drawn from the real footprint field** for that timestep,
  sampled with probability proportional to the physical sensitivity value, so
  the cloud that accumulates converges on exactly the footprint the map paints;
- its opening heading follows the **measured wind direction** at the station for
  that hour (meteorological convention: `wind_direction` is the bearing the air
  comes *from*, which is precisely where a backward parcel heads first).

What is illustrative is the path in between. Each parcel takes a smooth curve
from station to destination rather than a re-simulated trajectory, with a little
sideways scatter so the bundle has width. Everything the viewer is asked to
conclude from the picture — where the air came from, how it fans out, which way
it leaves, how the cloud builds into the footprint — comes from the data. The
intermediate wiggle does not.

The sampler is tested rather than assumed: `web/js/selftest.mjs` builds a
synthetic footprint with all its mass in one known block and checks that
essentially every sampled destination lands inside it.

---

## The datasets, and their quirks

Real records are patchy, and the pipeline is built to show that rather than hide
it. Gaps arrive as `null` and stay `null` all the way to the canvas, where they
**break the line** instead of being interpolated across. A record with 38%
coverage has to look like one.

### Ridge Hill · CH₄ · February 2020

The complete case: hourly observations with no gaps, plus an EDGAR v7 emissions
inventory, which means the **forward model** is available. Multiplying the
footprint by the emissions map gives the mole fraction the station *should* have
seen — this is exactly the calculation an inversion inverts. It correlates with
the observations at **r = +0.78**, which is the strongest single argument in the
whole piece that the method works.

**Two emissions resolutions, on purpose.** `flux.png` is EDGAR already regridded
onto the footprint's own 0.234° × 0.352° grid, and it is the one the forward
model uses. `flux_hi.png` and the three `src_*.png` are raw EDGAR at **0.1°** —
8.3× the cells over the same box, 126,000 against 15,240 — and are for looking at
only. The deck's sources card shows them on their own and never multiplies them
by a footprint, which is the whole justification: a product is limited by its
coarser factor, so a finer emissions map inside the forward model would buy
detail the transport cannot support. Precision dressed up as accuracy. All four
rasters share `flux.png`'s log scale, so "brighter means more" holds across the
card and the families can be read against each other.

Two traps in the raw files, both silent if you get them wrong. They are in
**kg/m²/s**, not the mol/m²/s everything else here uses (a factor of 62), and on
a **0–360** longitude axis rather than −180…180. Both conversions happen in one
place, `_read_edgar_01`.

A third is worse, because it is a defect in the data rather than a difference in
convention: **EDGAR's published `TOTALS` grid is not the sum of its sector
grids.** It has seven cells in this view that are flatly zero while every sector
file has emissions there — four of them over Leeds, Sheffield, Birmingham and
Lincoln, which at 0.1° render as visible holes punched in English cities. The
exporter therefore *builds* the total by summing the 18 sector grids instead. It
agrees with the published TOTALS to **0.9998** and prints that ratio on every
run, so a sector file going missing would show up immediately. It also makes the
card's claim true by construction: what the reader is shown as "all of it" is
exactly the three families plus the uncoloured transport remainder.

The families, and their share of the view: **cows and farming 49.5%**, **rubbish
and sewage 27.9%**, **oil and gas 22.3%** — 99.7% between them, the remaining
0.3% being road, rail and shipping, which get no colour because a fourth colour
for 0.3% costs the reader more than it tells them. "Oil and gas" deliberately
merges gas that *leaks* (PRO, FFF, REF_TRF) with gas that survives *burning*
(ENE, RCO, IND, IRO, CHE): two mechanisms, one substance, and the difference is
said out loud rather than drawn.

Worth knowing: the sector split at 0.1° is **2021**, while the footprints are
February **2020**. The years differ by 0.2% domain-wide and the frame-by-frame
modelled enhancements move by under 0.3 ppb, so it changes nothing the deck
says — but the card is labelled from `meta.fluxHires.year` rather than assuming.

### Gosan · HFC-23 and CFC-11 · June–August 2016

Two gases sharing one footprint archive: same air, same instrument, different
channels. The atlas is 5.5 MB and depends only on transport; the second species
costs 8 KB of mole fractions. They spike together (r = +0.63) because it is the
same air.

There is no emissions inventory for the East Asia domain, so there is no
modelled line. Instead the readout uses the **fraction of footprint mass over
land**, computed from a Met Office land mask — which answers the same question
("is the sensor looking at a continent or at open ocean?") using only the
footprint.

#### The plant overlay

Both Gosan builds carry a toggleable layer of **45 reported HFC-23 production
sites**, at 42 distinct coordinates — three plants share one point in Zhejiang
and two share another, and stacking markers there would darken a pixel while
misreporting the geography, so they collapse to one marker each.

This is deliberately **not** a flux raster. The file has coordinates and nothing
else: no capacities, no rates. Rendering unweighted points as a field would imply
an emission magnitude the data does not contain, so a marker says *a plant is
here* and stops there. It is the closest thing this domain has to the Ridge Hill
emissions map, and the honest version of it — enough to let a reader check
whether a spike arrives when the footprint is lying over a cluster, without
dressing a point list up as an inventory.

The layer defaults to hidden, matching the other overlays. Four sites in Sichuan
(lon 104.73–104.97) fall just west of the view crop, so 38 of the 42 draw; all
45 are exported regardless, because the camera decides what is on screen and the
export should not pre-empt it.

**A marker turns yellow when the plume is overhead** — when footprint sensitivity
in that plant's own grid cell reaches **10⁻²·⁵**. That is a fixed physical value,
not a fraction of each site's range, so "lit" means the same thing in 2016 as in
2021 and the two builds stay comparable. The exporter converts it to that site's
uint8 code (86 for 2016, 90 for 2021) and the browser compares against the frame
it is already holding — 42 typed-array reads against an 11,628-cell raster paint,
so the state is recomputed every frame rather than cached.

The obvious alternative is a trap worth recording. Tying the threshold to
`logDisplayMax`, where the colour ramp saturates, sounds right — "lit when the
map looks bright there" — and produces a feature that **never fires at all**. The
display cut is the 99.9th percentile of the whole field, which is set by cells a
few kilometres from the inlet on Jeju; over four months no cell above a Chinese
plant gets past u=161 against a saturation point of u=170. `verify_export.py` now
measures the firing rate on the shipped atlas every run and fails if a threshold
never fires or fires on more than 90% of frames, because both look like working
code and neither is visible in a screenshot.

At 10⁻²·⁵ the layer fires on **45.2% of frames in 2016 and 34.3% in 2021**, 1.4
and 1.2 plants per frame, and **37 of the 38** on-grid plants light up at some
point. The threshold was tried a half-decade higher first, at 10⁻², which fired
on 15.1% and 8.6% and lit 25 and 27 plants — sharper, but rare enough that a
reader scrubbing the timeline could miss it entirely. 10⁻²·⁵ trades some of that
specificity for a layer that visibly responds to the slider, which for a general
audience is the better bargain. There is headroom above the cut either way: the
strongest plant-hour reaches u=167 against a cut of 86.

What the highlight claims is narrow and worth keeping narrow: it says *the
station was well placed to smell that plant during those hours*. It does not say
the plant emitted. That is the whole point — a lit marker with no enhancement in
the chart is as informative as a lit marker with one, and in the post-abatement
window it is arguably the more interesting of the two.

Note the months are not equal quality. June is clean (worst gap 13 h) and holds
the biggest events; August is the best-covered month of the whole 2014–2017
window (worst gap 27 h); **July is the rough one** — a 121–189 hour instrument
outage depending on species. July is kept only because it holds one large
mid-month event.

*A month that did not make it:* the first Gosan footprints were May 2015, which
turned out to have **zero** CFC-11 observations — the Medusa instrument was down
from 2015-04-16 to 2015-06-22, a 66-day gap. Footprints and observations have to
be checked against each other before anything else.

### Gosan · HFC-23 · February–May 2021

The post-abatement comparison: after China's claimed HFC-23 reductions and the
Kigali destruction obligation. Four contiguous hourly footprint months —
**1062 samples** — carrying the largest relative enhancement anywhere in the
19-year record, **+376%** in mid-March, against a 35.5 ppt baseline.

Framed **two-hourly**, which is a coverage decision rather than a size one.
Medusa reports every two to three hours, so on an hourly axis only 37% of frames
carry a measurement and the chart is mostly holes; window-averaging onto a
two-hourly axis keeps every one of the 1062 samples and lifts frame coverage to
**74%**. Per-month coverage is 79 / 68 / 71 / 77%. It halves the atlas as well:
1440 frames, 5.09 MB.

The four months are not one regime. February is continental — the
northwesterly monsoon parks the footprint over China — and by May the flow has
turned maritime; mean land fraction over the window is 0.34, between February
2021's 0.46 and summer 2016's 0.22. The peaks follow the transport: March tops
out at 168.8 ppt and February at 146.0, while April manages only +40%. That
makes the window a seasonal transition as much as a post-abatement snapshot, and
worth reading as one.

**Why HFC-23 rather than CFC-11 leads.** It is not coverage — that is only
marginally better. It is dynamic range. Over Jun–Aug 2016, CFC-11 runs 229.6 to
296.6 ppt on a 232 ppt baseline: a 28% peak, a nearly flat line whose spikes
only read because the axis is zoomed hard into a narrow band. HFC-23 runs 28.6
to 72.2 ppt on a 29.6 baseline — it **more than doubles**. For an audience of
children, "the number went up a lot" should be literally true rather than an
artefact of scaling.

**One caution when comparing 2016 against 2021.** Mean land fraction is 0.34
over February–May 2021 against 0.22 in summer 2016, and February 2021 alone runs
0.46. Winter and spring flow at Gosan is far more continental — the
northwesterly monsoon parks the footprint over China much more of the time. The
two windows are different transport regimes as well as different years, so
enhancement statistics are not like-for-like between them. The 2021 window now
spans enough of the year to show the regime turning over inside itself, which
makes the seasonal effect visible rather than something the reader has to be
told about.

---

## Fitting one screen

The explorer is meant to be taken in at a glance, so map, chart and controls have
to share a single viewport rather than a scroll. The map is the only element with
give in it — the chart, the controls, the toggles and the legend all have floors
set by legible text and tappable buttons — so it absorbs whatever is left.

It stays **one column**, deliberately, so the same structure reflows for mobile
later rather than needing a second layout. What changes is that only the *map*
shrinks: the column holds a fixed 920px, and the map is centred inside it,
narrower than the chart beneath it. Letting the timeseries be wider than the map
is the point — it is the element that most rewards width, and it stays legible
even on a short viewport that has squeezed the map hard.

`--map-w` in the stylesheet is a viewport-derived default; `explore.js` measures
the stage's real offset and the real height of the rows under the map, then calls
`fitMapWidth()` and overwrites it. It re-runs on every resize, because the window
is not a fixed thing — an embedded editor preview gets dragged around constantly.

Decoupling the column from the map also removed a feedback loop. When the column
was as wide as the map, shrinking the map rewrapped the standfirst, which grew the
header, which shrank the map again; the fit needed two passes to settle. Now the
header is invariant under the map's width, and `rows` is a difference that cancels
the map's own height out, so **one pass is exact**.

The aspect is **8:5**, not the 4:3 it used to be. The camera fits the view box to
the canvas *width*, so a canvas proportionally shorter than the domain crops
latitude off it — at Gosan that would cut the northern plants and part of the
plume. The binding site is Ridge Hill, 28° of latitude over 45° of longitude
(0.622); 8:5 shows 0.625, so both sites fit with nothing lost.

Resulting map sizes, and the total against the browser's inner height:

| screen | map | total |
|---|---|---|
| 1366 × 768 | 341 × 213 | 615 / 633 |
| 1600 × 900 | 536 × 335 | 747 / 765 |
| 1920 × 1080 | 679 × 424 | 927 / 945 |
| 1920 × 1200 | 853 × 533 | 1047 / 1065 |
| 2560 × 1440 | 880 × 550 (capped at the column) | 1064 / 1305 |
| editor pane, 620 tall | 320 × 200 | 602 / 620 |

A second stylesheet regime kicks in below 820px of viewport: the eyebrow goes,
the title drops a few points and the paddings tighten. Between that and dropping
the prose readout from under the map, every screen in the table now fits — 1366 ×
768 included, which the previous layout missed by 66px.

Note the sizes above are computed from a *model* of the stylesheet in
`selftest.mjs`, not measured in a browser — there is no browser automation here.
The model's constants mirror the CSS and are asserted every run, so a padding
change that breaks the fit shows up as a test failure; but they are a mirror, and
they have to be updated alongside the CSS rather than derived from it.

---

## Design notes

Light background throughout, with the data layers carrying all the colour.

- **Two categorical series** — observed (blue `#2a78d6`) and modelled (orange
  `#eb6834`), sharing **one** y-axis, because they are the same quantity in the
  same units. There is no dual-axis chart anywhere.
- **Two sequential ramps** — footprint sensitivity in orange, emissions in
  violet, each single-hue and monotone in lightness, so the "multiply" idea
  reads as two distinguishable layers.
- **A third categorical slot for point sources** — the HFC-23 plant markers take
  step 5 of the emissions ramp (`#4a3aa7`) rather than a new hue. That is the
  point: violet already means "emissions" on this map, so drawing emission
  *sources* in it reads as the same idea in a different mark type instead of a
  fourth colour to learn. Re-validated as a categorical triple against observed
  and modelled on the `#fcfcfb` surface — worst pair plants↔observed, CVD ΔE 13.0
  (deutan), normal-vision ΔE 16.3, all three above 3:1 contrast. Identity is not
  colour-alone either way: the station is a circle, a plant is a diamond.
- **Three sequential ramps for the source families** — green `#54ad4e` (cows and
  farming), magenta `#cc61a0` (rubbish and sewage), charcoal `#6d727b` (oil and
  gas), used by the deck's "where it comes from" card. These are the only ramps
  in the codebase that have to be told apart from **each other** rather than just
  from the surface, so they were picked by measurement. All-pairs CIEDE2000 at
  *matched* steps 3–6 — matched because a reader separates two families at equal
  magnitude, and steps 0–2 are meant to recede into the surface anyway — under
  normal vision and simulated deutan, protan and tritan: **worst pair
  waste↔fossil at step 3, CVD ΔE 12.1 (protan), normal-vision 25.8**. Contrast on
  `#fcfcfb`: 2.7 / 3.5 / 4.7:1 at mid, 9.5 / 11.4 / 16.4:1 at the dark end.

  The obvious triple failed and it is worth recording why. Green/magenta/**slate
  blue** collapses for deutans — magenta↔slate measures ΔE 2.9 at step 2 and 7.1
  at step 3 — because both sit on the red-green confusion line. Swapping the blue
  for a near-neutral charcoal moves that separation onto **lightness**, which no
  dichromacy touches, and doubles the worst pair. Colour is not the only channel
  even so: the card introduces the three one at a time, each named by its own
  caption, before any two share a frame, and a self-test asserts that the violet
  total is never on screen beside a family.
- **One sequential ramp for wind speed** — teal `#026167`, used by the deck's
  wind arrows, and the one ramp here that **deliberately breaks the sequential
  rule** below. The other ramps let their light end fade into the surface because
  near-zero should disappear; that rule is for *area fills*. An arrow is a
  hairline, and a hairline that fades does not read as "light wind", it reads as
  a hole in the field. So the lightness ladder was fixed first — CIE L\* 54 down
  to 20, evenly spaced, every step clearing 3:1 on everything it lands on — and
  the hue and chroma found inside it. At the palest step, which is the binding
  one: **3.33:1 on ocean, 3.08:1 on the deep end of the ocean gradient, 3.23:1 on
  land**. L\* 56 measured 2.87:1 against the bottom of that gradient, which is
  what fixes the ladder's top at 54.

  Separation, worst step under normal vision and simulated deutan, protan and
  tritan: **coastline ΔE 12.3, station 12.4, plants 13.3, modelled 31.0**, and
  ΔE 27.9 across the ramp itself so "faster" is legible as well as ordered. The
  one close pair is **observed at ΔE 7.5 (tritan)**, where teal and blue
  converge — recorded rather than fixed, because it is not a co-presence (no wind
  stop shows the chart, and a self-test asserts it) while the coastline pair is
  on screen every wind frame. Hue 185° collapses the coastline pair to ΔE 3.5;
  215° reaches 14.9 but stops reading as teal.

  Speed is carried **twice, by length and by colour, on one scale** saturating at
  **22 m/s** — measured, not chosen: whole-domain median 10.7 m/s and p95 23.3,
  with the two framings the wind acts use running medians of 13.2 and 7.6. That
  redundancy is what lets the colour stay in a narrow, always-legible band
  instead of having to span light to dark on its own.
- **One state colour, `#f5d000`** — the same marker with the plume overhead. It
  separates cleanly from the orange it sits on (CVD ΔE 19.5 deutan, 23.2 tritan,
  normal-vision 25.3), which was the risk worth checking, since yellow against
  orange is the classic red-green confusion.
- **One grey for all linework, `#84827a`** — coastlines, borders and marker edges.
  Its value is fixed by having two jobs. As a marker edge it is load-bearing:
  yellow measures **1.03:1** against the pale end of the plume ramp, so an
  unoutlined highlight vanishes exactly where the footprint is faint. As a
  hairline it has to stay recessive. Measured against every background it lands
  on, it reaches 3.2:1 on land, 3.3:1 on ocean and 3.2:1 on the palest plume step
  while holding 2.8:1 on the dark plume core. Coast and borders share the colour
  and are separated by weight instead (1.2 px against 0.8 px), so the coastline
  still reads as the primary boundary. Every marker also keeps a surface-coloured
  outer ring outside the grey one, which is what stops the dense Zhejiang cluster
  merging into a single blob at wide zoom.
- The palette was validated rather than eyeballed: worst all-pairs colour-vision
  separation ΔE 24.7, normal-vision ΔE 33.6, both series above 3:1 contrast on
  the `#fcfcfb` surface. The ramps' light ends deliberately fade into the
  surface — that is the sequential rule, since near-zero should disappear.
- Opacity climbs with magnitude as well as colour, so a faint footprint edge
  dissolves into the map rather than stopping at a hard line.
- The chart ships a hover crosshair and tooltip, a legend whenever two series
  are shown, one direct label on the cursor only, and a data table as the
  non-visual fallback.

---

## What is not built yet

The **scrollytelling essay** — region map → station photo → timeseries →
backward dispersion → plume — is scaffolded in intent only. `explore.html` is
the analytical tool; the narrative piece is the next thing. See `HANDOFF.md`.
