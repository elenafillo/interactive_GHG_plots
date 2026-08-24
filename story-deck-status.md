# "Can I smell it?" — Ridge Hill presenter deck

Current state and what is left. The long plan
(`i-want-to-create-immutable-quasar.md`) stays as the archaeology — every number
below was measured there, and this file does not repeat the working.

**Last updated 24 Aug 2026.** Both suites green: 459 checks in
`web/js/story/selftest.mjs`, and `web/js/selftest.mjs` untouched and still green.

---

## What it is

`web/story.html` — a fullscreen deck driven with the arrow keys, talked over,
built on the February 2020 Ridge Hill export. One idea carries it: **the
footprint is the area the mast can smell.** Red over empty sea, nothing to
smell; red over cities and farms, we can smell it.

Rules for the build, not suggestions: **ten words a caption**, no jargon on
screen ever (not "footprint", "flux", "ppb"), caption ≥28 px, one number at a
time, colour never the only channel.

## Run it

```
node scripts/serve.mjs             # then open /story.html
node web/js/story/selftest.mjs     # 459 checks, the harness — there is no browser automation here
node web/js/selftest.mjs           # the explorer's own
node scripts/measure_seeding.mjs   # measures the seeding against the shipped atlases
```

Re-export only when the data changes:

```
python scripts/slice_met.py                    # only when the met store changes
python scripts/export_web_data.py --site RGL   # PYTHONIOENCODING=utf-8 if you pipe it
python scripts/verify_export.py --site RGL
```

## Keys

| | |
|---|---|
| presenting | `→` `←` `Space` · `.` play/pause · `1`–`6` act · `F` fullscreen · `R` restart act |
| on the night | `T` scrubber · `[` `]` nudge ±1 h (shift ±6) · `N` show the number · `G` square/smooth cells · `W` ambient density · `E` stream density |
| tuning | `?tune=1` — the sources-contrast knobs, and stored frame overrides. Without it the deck always opens on `beats.js` |

---

## The deck as it runs — 6 acts, 21 slides

| act | camera | stops |
|---|---|---|
| `where` | Bristol → mast → UK | This is Bristol. · Forty kilometres north, a mast sniffs the air. · It can smell for hundreds of miles. |
| `clean-wind` | −10, 50, span 27 | Today the wind comes off the Atlantic. · This air has crossed nothing but sea. *(fan)* · Now run it backwards. Where was this air? |
| `clean-smell` | same framing | Red is everything the mast can smell. · It is all empty sea. Nothing there. |
| `sources` | −0.5, 52.5, span 24 | Purple is where methane comes from. · **But nobody counted it. This is a guess.** · cows and farms · rubbish and sewage · gas that leaks or burns · all three together |
| `dirty` | 0.5, 52, span 21 | Five days later, the wind has turned. · Now it blows from cities and farms. *(fluxHi + wind)* · This air came over Belgium and London. *(red stream)* · Run it backwards. · The red patch lands right on top. · And we can smell it. *(plays)* |
| `record` | −6, 52, span 30 | A little on Sunday. A lot on Friday. *(month playback, chart up)* |

`clean-wind` and `clean-smell` must stay framed **identically** or the plume
stops fading in over a still camera.

The load-bearing line is the sources card's second stop. It sets up the dirty
day as the check: the guess said Belgium and London, the wind brought that air
over, the sensor smelled what the guess predicted. That is the verification
argument with no number in sight — which is why the modelled-vs-observed
correlation payoff was never built and probably never should be.

## The moments

`FRAMES` in `beats.js` is the only place a frame number is written.

| | frame | time | reading |
|---|---|---|---|
| `clean` | 36 | 2 Feb 12:00 | 1953 ppb, +13 above background |
| `dirty` | 153 | 7 Feb 09:00 | 2108 ppb, +83 |
| `peak` | 154 | 7 Feb 10:00 | 2124 ppb — the strongest frame of the event |
| `recordLow` | 349 | 15 Feb 13:00 | 1919 ppb, Storm Dennis. Off by default (`SHOW_RECORD_LOW`) |

Play windows are stored as **offsets** from the anchor, so retiming an act moves
its animation with it.

## Files

| file | role |
|---|---|
| `web/story.html`, `web/css/story.css` | the page. Standalone; `essay.css` untouched |
| `web/js/story/beats.js` | `FRAMES`, `RELEASES`, every act and caption. No DOM, no imports |
| `web/js/story/deck.js` | render loop, camera, keys, caption, meter, scrubber |
| `web/js/story/mapview.js` | **fork** of `../mapview.js` — graticule fix, `cities`, source rasters |
| `web/js/story/selftest.mjs` | 459 checks, including a headless mount that walks all 21 slides |
| `web/js/wind.js` | `WindField` (sampler), `WindLayer` (ambient air + the red stream) |
| `web/js/advect.js` | RK2 midpoint, back-tracks, the fan, trails |
| `web/js/palette.js` | the ramps and `SOURCE_DISPLAY`. All CVD-measured |
| `scripts/export_web_data.py` | the exporter. `slice_met.py` feeds it the wind |
| `scripts/verify_export.py` | re-encodes from source and demands byte-equality |
| `scripts/measure_seeding.mjs` | decodes the shipped atlases with node's own zlib |

Shipping in `web/data-rgl/` (4.3 MB): footprint atlas 1.51 MB, wind 2.56 MB,
emissions total + three families, basemap, series.

---

## To do

### From the screen — next up

- [ ] **Drop the forwards beat; keep only the backwards.** The forward release
      stops are `clean-wind`/1 *"This air has crossed nothing but sea."* and
      `dirty`/2 *"This air came over Belgium and London."*. The backwards ones
      that stay are `clean-wind`/2, `clean-smell`/0 and `dirty`/3. ⚠ Both
      backwards captions read *"Now run it backwards"* / *"Run it backwards"*,
      which only parses **after** a forwards beat — they have to be rewritten,
      not just promoted. Takes the deck to 19 slides.
- [ ] **Turn the smell bar vertical.** `.meter` in `story.css` is a flex row
      with a 10 px `.meter-track` filled left → right. Vertical means a column,
      a fill anchored to the bottom, and *a little* / *a lot* swapping ends.
- [ ] **Make the bar the enhancement, not the raw reading.** `paintMeter`
      (`deck.js:184`) scales `obs` between `obsMin` 1919 and `obsMax` 2176 — so
      the clean day already sits a third of the way up a bar that is supposed to
      say "nothing to smell". It should show **obs − 1950 ppb**, the clean-air
      average, clamped at zero and topping out near +226. Not `series.modelled`:
      that is the *modelled* enhancement, 5–86 ppb, a different quantity on a
      different scale.
- [ ] **Hide the timeseries on the last act** and let the bar carry the month.
      `record` sets `chart: true`, which raises `#chartShell` — and the meter's
      own condition (`stop.layers.footprint > 0 && !stop.chart`) is exactly what
      suppresses the bar there today. The two swap.
- [ ] **A visible pause button.** `.` is currently the only way to stop the
      playback. `.nav` already holds prev/next and is where it belongs.
- [ ] **Cut the tuning keys.** `G` (square vs smooth cells) goes — settled. Then
      audit the rest: `W` and `E` cycle tracer densities and only report to the
      console, `[` `]` and `T` are frame tuning, `N` reveals the number, `R`
      restarts the act, `F` fullscreens, `1`–`9` jump. The presenting set is
      `→ ← Space . 1`–`6 F R`; everything outside it is a candidate for deletion
      or for `?tune=1`.

The three meter items land on the same element, and it is worth knowing before
touching it that **the meter is on screen permanently** — `.meter` declares
`display: flex`, so `paintMeter`'s `hidden` toggle does nothing (see the
`[hidden]` item under Build). Fix that first or the "hide the timeseries" swap
will look like it has not worked.

### Decide — story questions, not code

- [ ] **`SOURCE_DISPLAY` is not provably what is on screen.** The constant says
      `floor −9.75, ceil −7.0, γ 1.35`; a stored `ghg.story.look` still
      overrides it silently, and that read is *not* behind `?tune=1` the way the
      frame overrides now are. The plan once proposed `−9 … −7.25`. Open
      `?tune=1`, read the three numbers actually in force, paste them into
      `palette.js` — then either gate that read too or drop the store.
- [ ] **`SHOW_DIRTY_BACKTRACK`** is `true` and on trial. Keep or delete.
- [ ] **The two see-through stops** now draw `fluxHi` at 0.35 / 0.12, alphas
      carried straight over from the coarse layer. The hi-res raster hides 64%
      of its cells and draws the rest harder, so the same number is a quieter
      map with brighter sources. Judge by eye.

### Build

- [ ] **`dirty` camera** — the other half of the zoom-out. Proposed lon −1.0,
      lat 51, span 24; bottom edge 46.09 → 44.25. The centre has to move *west*:
      the wind crop ends at lon 12.10 and that frame already reaches lon 11.
- [ ] **`[hidden]` does nothing on `.meter` and `.scrubber`.** Both declare
      `display: flex`, an author rule, which beats the browser's
      `[hidden] { display: none }`. So the presenter panel is on screen
      permanently, `T` does nothing visible, and the meter shows on slides that
      hide it. One rule fixes all of it — but it changes what the deck looks
      like, so it is a decision as much as a fix.

- [ ] **`WEB_PIPELINE.md`** — the wind asset is still undocumented beside the
      footprint atlas.
- [ ] **Export for PowerPoint (optional, untouched).** `ffmpeg` is not
      available, so the safe path is a PNG-per-frame render route in
      `serve.mjs` plus `render_slides.py` → GIF, reusing the PIL idiom in
      `plotting_tools/interactive_plots.py:make_gif`. Screen recording remains a
      perfectly good fallback.

### Housekeeping

- [ ] `.gitignore` covers `data/met/*` but **not** `data/ancillary/` (100 MB),
      `data.zip` (36 MB), `__pycache__/` or `.ipynb_checkpoints/`. Any
      `git add -A` commits all of it.

---

## Known limits — not bugs, don't chase them

- **One wind level, 100 m.** Chosen by measurement: bias crosses zero exactly at
  the level nearest the 90 m inlet. The dirty day's bend is air *below* it and
  is simply unreachable.
- **Wind is 3-hourly and cropped to lon ≤ 12.10.** The crop is invisible today
  and binds only the `dirty` camera eastward.
- **The Atlantic framing keeps a thin upwind band.** Seeding is extended upwind
  by one ambient lifetime, but the data edge sits 1.36° off-screen west against
  the ~7° a 12 h lifetime wants. Remaining levers: a shorter ambient life, or
  seeding a share on the inflow edge.
- ⚠ **The painted air illustrates the red patch; it does not derive it** (~15%
  coverage). Captions must never claim otherwise — "where this air has been",
  never "this is how we work it out", in a deck whose whole argument is about
  not assuming.

## Settled — don't re-derive

- **Every anchor, release box and ramp came from measurement** against the
  shipped atlases. `measure_seeding.mjs` reproduces the seeding numbers on
  demand; the ramps were validated all-pairs CIEDE2000 under normal, deutan,
  protan and tritan vision.
- **The arrow lattice was built and killed.** An arrow states a direction; it
  does not show air *travelling*. Tracers on their own clock do.
- **Painted tracks were built and dropped** — the accumulation buffer read as a
  second map competing with the real one. `PlumeCanvas` survives, inert.
- **`arrivals: 4`, `jitterKm: 3`.** At 12 and 15 half the fan fell outside the
  drawn red, which is what "the parcels are really off" turned out to be.
- **The dirty day needs 36 h of rewind, the clean day 12.** The dirty flow
  stalls; at 12 h the air never leaves the North Sea while the caption says
  Belgium.
- **The parcel ramp is the plume ramp's darker end, not a new colour**
  (`PARCEL_CUT = 0.6`). A hairline that recedes reads as a hole in the field,
  which is why the teal and the red both start dark.
- **Two L-mode wind atlases, `uvMax 40`.** Wider range packs into fewer codes
  and shrinks the PNG, so this runs backwards from intuition.

## Traps that have bitten

- **`np.corrcoef` and `np.linalg.inv` crash this interpreter** — DLL error, no
  traceback, exit `0xC06D007E`. Use `_pearson()`; hardcode any colour matrix.
- **Piping the exporter's stdout** drops Python to cp1252 and the `CH₄` label
  raises `UnicodeEncodeError` before any work is done. `PYTHONIOENCODING=utf-8`.
- **zarr must stay 2.x** — the stores were written for it, and numpy is held at
  1.26.4 so the fragile BLAS is untouched.
- **A stale `localStorage` entry silently outranking the source.** Fixed for
  frames, still live for the sources look (see the first to-do).
- **`story.html` cannot be opened over `file://`** — modules and `fetch` are
  blocked. The page says so rather than hanging.
