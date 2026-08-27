# "Can I smell it?" — Ridge Hill presenter deck

Current state and what is left. The long plan
(`i-want-to-create-immutable-quasar.md`) stays as the archaeology — every number
below was measured there, and this file does not repeat the working.

**Last updated 26 Aug 2026.** Both suites green: `web/js/story/selftest.mjs` now
runs three decks — **`rgl: 464 · gsn: 238 · cfc11: 253`**, 955 in total — and
`web/js/selftest.mjs` is untouched and still green. (Counted, not remembered —
this file has carried two different stale numbers.)

⚠ **Ridge Hill's 464 is the regression guarantee for the engine extraction and
must not move.** Every check the other two decks have gained since sits behind a
gate this deck does not pass through. The Gosan decks are
`story-cfc11-deck-status.md`'s.

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
node web/js/story/selftest.mjs     # 955 checks over three decks — there is no browser automation here
node web/js/selftest.mjs           # the explorer's own
node scripts/measure_seeding.mjs   # measures the seeding against the shipped atlases
node scripts/frame_at.mjs cfc11 "5 Jul 2016 23:00"   # which frame is that moment?
```

**Never work a frame index out by hand.** It is a position in `series.json`'s
`timeMs`, not an offset from the start of the record, and the two Gosan exports
are full of holes — `data-gsn-cfc11` drops 28–30 June, 16 July and 24 July. The
`t = day*24 + hour - 24` in `beats-rgl.js` holds only at Ridge Hill, where
February 2020 is hourly and complete; ask it for 5 July 2016 14:00 and it says
415 where the frame is 379. `frame_at.mjs` reads the axis instead, and also says
whether the frame carries a reading at all — 46% of CFC-11's do not, so a date
picked off a calendar can put an empty bar on screen.

Re-export only when the data changes:

```
python scripts/slice_met.py                    # only when the met store changes
python scripts/export_web_data.py --site RGL   # PYTHONIOENCODING=utf-8 if you pipe it
python scripts/verify_export.py --site RGL
```

## Keys

| | |
|---|---|
| presenting | `→` `←` `Space` · `.` play/pause · `H` hide the panel · `1`–`6` act · `F` fullscreen · `R` restart act |
| on the night | `T` same switch as `H` · `[` `]` nudge ±1 h (shift ±6) · `N` show the number · `G` square/smooth cells · `W` ambient density · `E` stream density |

The panel is **up when the deck opens** and `H` puts it away. That is the
behaviour the deck has always had — `hidden` was on the tag and did nothing —
so the attribute has been dropped from `story.html` rather than the opening
state changed. Add `hidden` back to that tag to make it presenter-only for real.
| tuning | `?tune=1` — the sources-contrast knobs, and stored frame overrides. Without it the deck always opens on `beats.js` |

---

## The deck as it runs — 6 acts, 19 slides

| act | camera | stops |
|---|---|---|
| `where` | Bristol → mast → −3, 52, span 25 | This is Bristol. · Forty kilometres north, a mast sniffs the air. · It can smell for hundreds of miles. |
| `clean-wind` | −10, 50, span 27 | Today the wind comes off the Atlantic. · ✏️ *Follow the air backwards. Where has it just been?* *(fan, backwards)* |
| `clean-smell` | same framing | Red is everything the mast can smell. · It is all empty sea. Nothing there. |
| `sources` | −0.5, 52.5, span 24 | Purple is where methane comes from. · **But nobody counted it. This is a guess.** · cows and farms · rubbish and sewage · gas that leaks or burns · all three together |
| `dirty` | 0.5, 52, span 21 | Five days later, the wind has turned. · Now it blows from cities and farms. *(fluxHi + wind)* · ✏️ *Wind the clock back. This air crossed Belgium and London.* *(red stream, backwards)* · The red patch lands right on top. · And we can smell it. *(plays)* |
| `record` | −6, 52, span 30 | A little on Sunday. A lot on Friday. *(month playback, fullscreen, the bar carries it)* |

✏️ = **placeholder wording, written to be replaced.** Both are in
`web/js/story/beats.js`, each under a comment block that says what the line has
to do; search the file for `PLACEHOLDER`. Ten words maximum, no jargon — the
suite enforces both.

**The air is only ever followed backwards now.** The two forwards stops —
`clean-wind`'s *"This air has crossed nothing but sea."* and `dirty`'s *"This
air came over Belgium and London."* — are gone. Nothing else changed: the same
fans, read one way instead of two.

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

⚠ **The `copy frames` button and the `moment:` readout were removed from the
panel on 26 Aug 2026**, on all three pages. The scrubber, `[` `]`, `?tune=1` and
the per-deck `localStorage` write all still work, so a moment tuned on the night
still survives a refresh — but there is no longer a one-click way to get the
numbers back out for pasting into a beats file. Read them out of
`ghg.story.frames.<deck>`, or put the button back.

## The bar

Upright, in the top-left corner and in its own box — deliberately not inside the
HUD, so the caption never moves when the bar comes or goes. It shows **how far
above clean air this hour is** — `SMELL` in `beats.js`, base 1930 ppb (the
export's own background,
rounded) over a span of 200. The clean day fills 11% of it, the dirty day 89%,
the peak hour 97%; 5 hours of 696 clip at the top, all in Storm Dennis. A
narrower span saturates and the peak stops being the fullest thing on screen.

It is on screen exactly when there is a footprint to be smelling — so it is
absent through `where` and the whole sources card, where there is no hour
attached to the map. The last act is fullscreen and lets the bar carry the
month; no act draws the chart any more, though `chart: true` still works.

**Three states, not two, since 26 Aug 2026.** An hour the instrument does not
have draws struck out — diagonal hatching across the track — and captioned "no
reading", which is neither a hidden bar nor a low one. It used to draw a flat
empty bar, i.e. *clean air*, which is the one thing it must never say about an
hour nobody measured. Two channels and neither is colour: grey alone would not
do, because on this bar grey *is* the empty track.

⚠ **Ridge Hill never reaches it** — 696 of 696 frames here are observed, so the
state is invisible on this deck and every check for it skips. It exists for the
two Gosan decks, which are 341 and 307 frames short of a full record. The chrome
is shared, so a change to `paintMeter` or to `.meter*` in `story.css` lands on all
three pages. Full account in `story-cfc11-deck-status.md`, 26 Aug 2026.

## Files

| file | role |
|---|---|
| `web/story.html`, `web/css/story.css` | the page. Standalone; `essay.css` untouched |
| `web/js/story/beats.js` | `FRAMES`, `RELEASES`, every act and caption. No DOM, no imports |
| `web/js/story/deck.js` | render loop, camera, keys, caption, meter, scrubber |
| `web/js/story/mapview.js` | **fork** of `../mapview.js` — graticule fix, `cities`, source rasters |
| `web/js/story/selftest.mjs` | 955 checks over three decks, 464 of them this one, including a headless mount that walks all 19 slides |
| `web/js/wind.js` | `WindField` (sampler), `WindLayer` (ambient air + the red stream) |
| `web/js/advect.js` | RK2 midpoint, back-tracks, the fan, trails |
| `web/js/palette.js` | the ramps and `SOURCE_DISPLAY`. All CVD-measured |
| `scripts/export_web_data.py` | the exporter. `slice_met.py` feeds it the wind |
| `scripts/verify_export.py` | re-encodes from source and demands byte-equality |
| `scripts/measure_seeding.mjs` | decodes the shipped atlases with node's own zlib |
| `scripts/frame_at.mjs` | date → frame index, the direction nothing else goes |

Shipping in `web/data-rgl/` (4.3 MB): footprint atlas 1.51 MB, wind 2.56 MB,
emissions total + three families, basemap, series.

---

## To do

### From the screen — next up

- [x] **Drop the forwards beat; keep only the backwards.** Done — 19 slides,
      both suites still green. The two forwards stops are deleted; the
      backwards ones are `clean-wind`/1, `clean-smell`/0 and `dirty`/2. Both
      backwards captions were rewritten rather than promoted, since *"Now run
      it backwards"* only parsed after a forwards beat. **The two rewrites are
      placeholders** — see the ✏️ rows above and the `PLACEHOLDER` comments in
      `beats.js`.
- [ ] **Read the two placeholder captions on screen.** The `dirty` one is the
      harder of the two: it now has to name Belgium and London *and* say the
      clock is winding back, because the forwards stop that used to name them
      is gone, and *"the red patch lands right on top"* two slides later is
      checking that sentence against the guess.
- [ ] **A visible pause button.** `.` is currently the only way to stop the
      playback. `.nav` already holds prev/next and is where it belongs.
- [ ] **Cut the tuning keys.** `G` (square vs smooth cells) goes — settled. Then
      audit the rest: `W` and `E` cycle tracer densities and only report to the
      console, `[` `]` and `T` are frame tuning, `N` reveals the number, `R`
      restarts the act, `F` fullscreens, `1`–`9` jump. The presenting set is
      `→ ← Space . H 1`–`6 F R`; everything outside it is a candidate for
      deletion or for `?tune=1`. ⚠ **`H` and `T` are now the same switch** —
      `H` was added because it is what "hide" is called everywhere else, and
      `T` kept because it is the documented one. Pick one when you do this
      audit; dropping the other is one line in `deck.js`.

### Decide — story questions, not code

- [ ] **`SOURCE_DISPLAY` is not provably what is on screen.** The constant says
      `floor −9.75, ceil −7.0, γ 1.35`; a stored `ghg.story.look` still
      overrides it silently, and that read is *not* behind `?tune=1` the way the
      frame overrides now are. The plan once proposed `−9 … −7.25`. Open
      `?tune=1`, read the three numbers actually in force, paste them into
      `palette.js` — then either gate that read too or drop the store.
- [ ] **`SHOW_DIRTY_BACKTRACK`** is `true` and on trial — but ⚠ **the price of
      deleting it went up.** It used to gate a spare stop sitting after the
      forwards one; now it gates the dirty day's *only* look at where its air
      came from, and the only sentence naming Belgium and London. Setting it
      `false` today drops the claim the payoff slide is checking. To delete it,
      that sentence has to move onto another stop first.
- [ ] **The two see-through stops** now draw `fluxHi` at 0.35 / 0.12, alphas
      carried straight over from the coarse layer. The hi-res raster hides 64%
      of its cells and draws the rest harder, so the same number is a quieter
      map with brighter sources. Judge by eye.

### Gosan — the purple map (Brief A)

- [x] **EDGAR v8.0 HFC-23 2016 is wired in and on screen.** One raster, not
      four: EDGAR publishes this gas under a single sector (`PRU_SOL`) whose
      grid is bit-identical to TOTALS, so `export_flux_hires` grew a
      `sectors: None` branch that reads the published total directly. Three
      other things had to stop being CH₄-only — `_read_edgar_01` now takes a
      species (molar mass, **and** the variable name, since v7 is `emi_ch4` and
      v8 is `fluxes`), and the encode range moved onto the site spec. The
      hi-res path was chosen over the coarse `flux` layer precisely to avoid a
      regrid: it ships 400×240 at native 0.1° on its own grid, where `flux`
      draws at the footprint's 114×102. 235 GSN checks green.
- [ ] **Tune the contrast by eye.** `SOURCE_DISPLAY_BY_SPECIES['hfc-23']` is
      `floor −12.25, ceil −10.25, γ 1.35` — the floor is where the top 95% of
      the view's mass sits, the ceiling is the field maximum. Unlike CH₄ this
      field has no valley to anchor a floor in, so those numbers are defensible
      rather than principled. `T` to move them, `C` to copy back.
- [ ] **Teach the suite what a single-source deck is.** `expectSources` is still
      `false` for GSN, so the sources-card block is *skipped* rather than
      asserting the new raster — it passes today by not looking. Wants a mode
      that checks `layers.total`, grid finer than the footprint, grid inside the
      view, and skips the three-family and `meta.flux.logMin` checks (GSN's
      `meta.flux` is null).
- [ ] **Only 2016 is wired.** 2020 is in `data/fluxes/hfc-23.zip`, unextracted;
      `GSN-2021` has no 2021 inventory at all, nearest is 2020.

### Build

- [ ] **`dirty` camera** — the other half of the zoom-out. Proposed lon −1.0,
      lat 51, span 24; bottom edge 46.09 → 44.25. The centre has to move *west*:
      the wind crop ends at lon 12.10 and that frame already reaches lon 11.
- [x] **`[hidden]` on `.scrubber`** — fixed, and the panel moved. Two separate
      things had to change before it could be put away:

      - It declared `display: flex`, an author rule, which beats the browser's
        `[hidden] { display: none }` — so `T` had been setting the attribute
        with no effect for months. `.scrubber[hidden]` now guards it.
      - It was centred and about 1100 px wide, so it lay across the caption's
        half of the bottom row. It is anchored right of `--panel-left` in
        `story.css`, the caption's `max-width` is computed from the same
        variable, and the slider is flex-sized so the panel wraps inside its
        half instead of spilling.

      **This trap has now cost three elements** — `.meter`, `.scrub-look`,
      `.scrubber` — so the suite checks it directly. It reads `story.css` as
      text, finds every element the deck sets `hidden` on, and fails any that
      declares its own `display` without a matching `[hidden]` rule. Verified
      by removing the rule and watching it fail.

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

## Environment

This is the part that will waste your time if you do not read it.

- **Python lives at** `C:\Users\ef17148\AppData\Local\miniconda3\envs\gates_basic2\python.exe`.
  `conda` is **not** on `PATH`, and `conda activate` fails in this shell. Call
  the interpreter by its full path. The env in `env.yml`
  (`interactive_plots_env`) does not exist on this machine.
- **`np.corrcoef` crashes the interpreter** — a BLAS delay-load failure, exit
  code `0xC06D007F`, no traceback, no output. Anything routing through
  `np.dot`/matmul does the same. `_pearson()` in the exporter computes
  correlation from sums for this reason. If a script dies silently with no
  message, suspect BLAS first.
- **PowerShell mangles inline Python** passed via `python -c "..."` in
  non-obvious ways. Write a file and run it instead.
- **Redirecting the exporter's stdout crashes it** before it does any work:
  piping drops Python to cp1252 and the `CH₄` species label raises
  `UnicodeEncodeError`. Prefix with `PYTHONIOENCODING=utf-8` whenever you pipe or
  redirect. Straight to a terminal it is fine.
- **`zarr 2.18.7` and `numcodecs 0.15.1`** are installed in `gates_basic2`
  (numpy pinned at 1.26.4 so the BLAS above is left alone). The met stores are
  zarr v2 — do not let anything pull zarr 3 in.
- **`Remove-Item "$env:TEMP\..."` with a wildcard is blocked** by the harness as
  a protected path. Use a named subdirectory.
- **No browser automation is available.** You cannot screenshot or drive the
  page. This is why `web/js/selftest.mjs` exists — it stubs a canvas and
  exercises the drawing code headlessly. Extend it rather than assuming a change
  works; a bug that only shows in the browser costs the user a round trip.
- `node` is on `PATH`. A static server is likely already running on **8765**;
  check before starting another. `serve.cmd` / `scripts/serve.mjs` is the
  supported launcher and steps to a free port on its own.
- **`python` on `PATH` is the Windows Store alias**, not a working interpreter —
  which is why the committed launcher uses Node. The real interpreter is the full
  conda path above.
- **The page cannot be opened as a file.** `file://` blocks ES modules and
  `fetch`, so `explore.js` never runs and the loader hangs on "starting up" with
  an empty console — the error handler is inside the script that got blocked.
  There is now a classic (non-module) script in `explore.html` that detects this
  and explains it on screen; keep it non-module or it will be blocked too.
