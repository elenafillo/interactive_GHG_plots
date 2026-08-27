# Brief — the CFC-11 deck page (Brief 4, scaffold pass)

Build the three files that put `web/data-gsn-cfc11/` on screen. **Reuse the
HFC-23 deck's beats for now** — this pass is scaffolding, not the final story.
`story-cfc11-deck-status.md` is authoritative for everything else; the "Met —
done" section at its end is the wind and must not be re-derived.

## What already exists — do not redo any of it

- `SITES["GSN-CFC11"]` in `scripts/export_web_data.py`, exported and verified.
- `web/data-gsn-cfc11/` — `fp_atlas.png` (3.34 MB), `wind_u.png` + `wind_v.png`
  (1.65 MB), `meta.json`, `series.json`, `basemap.json`.
- **The wind is live.** `meta.wind` is populated (level 2, 76.7 m, `nTime` 224,
  `frameStride` 3, `uvMax` 37). `deck.js:166` builds the `WindLayer` from it
  automatically — you do not wire anything up.
- `python scripts/verify_export.py --site GSN-CFC11` → all checks passed.

## The three files

| file | how |
|---|---|
| `web/story-cfc11.html` | copy `web/story-gsn.html`, change the module `src` to `js/story/main-cfc11.js`. Keep the classic non-module script that warns about `file://` — it must stay non-module. |
| `web/js/story/main-cfc11.js` | copy `main-gsn.js`, import `DECK` from `./beats-cfc11.js`. ~23 lines, no other change. |
| `web/js/story/beats-cfc11.js` | copy `beats-gsn.js`, then the changes below. |

### `beats-cfc11.js` — the DECK header

```js
id: 'cfc11',
data: 'data-gsn-cfc11/',
species: 'cfc-11',
next: null,
```

Keep `tzOffsetH: 9` (same island). Retitle as you see fit — the status doc's
working title is *"Which one can we smell?"*.

## ⚠ The axis is 672 frames, not 1044 — check every frame index

This is the one thing that will silently produce a wrong deck.

`data-gsn` is June–**August** (1044 frames). `data-gsn-cfc11` is June–**July**
(672 frames). Both are `time_step: 2` and **the first 672 frames are the same
UTC hours**, so:

- a frame index **< 672** in `beats-gsn.js` means the same moment in both decks
  and can be copied unchanged;
- a frame index **≥ 672** is August, which does not exist here — it will index
  past the end.

Go through `FRAMES`, `SMELL`, `RELEASES` and every `holdAt` / play-window in the
copied file and check each index against 672. I have not read `beats-gsn.js`, so
I am not telling you which ones break — check them all.

**The time axis is also not contiguous.** The footprint record is missing
**28–30 June, 16 July and 24 July**, so frame index → time is non-linear and a
play window can jump days mid-animation. Do not assume `frame = hour / 2` across
a gap.

## The two anchors

Chosen by the user for this pass. Both verified to sit on the frame axis and
both inside the wind record:

| | UTC | hourly idx | **frame** | wind |
|---|---|---|---|---|
| dirty | **2016-06-16 00:00** | 360 | **180** | exactly wind step 60 |
| clean | **2016-07-05 14:00** | 758 | **379** | uses wind step 126 (5 Jul 12:00) |

Derivation, so you can re-check: June is contiguous from hourly 0 (1 Jun 00:00)
to 647 (27 Jun 23:00); July starts at hourly 648. `frame = hourly / 2`.

⚠ **Neither anchor has been checked for observations.** 365 of 672 frames carry
CFC-11 (54%), so there is a real chance one of these is a gap. Check before
building a caption that reads a number off the bar, and say so if it is empty.

⚠ These are **placeholders the user picked to get something on screen**, not
Brief 1's answer. The record extremes are elsewhere: smelliest 2016-06-24 22:00
(+64.3 ppt), cleanest 2016-07-06 08:00 (−2.8 ppt).

## No factories

Drop every factory beat, layer and caption from the copy. `meta.factories` is
`null` for this site **on purpose** — `factory_locations_EASTASIA.csv` is an
HFC-23 plant list, and drawing it on a CFC-11 map would caption the wrong gas.
Do not add it back.

## Placeholder blank flux

The site ships no emissions raster: `meta.flux` and `meta.fluxHires` are both
`null`. Fill the slot with a **blank** so any copied flux beat renders empty
rather than crashing:

- write an all-zero `flux.png` on the footprint view grid, **114 lon × 102 lat**,
  same orientation as `fp_atlas.png` (row 0 = north, i.e. `u[::-1, :]`);
- add a `meta.flux` block matching `export_flux`'s shape —
  `{"logMin", "logMax", "file": "flux.png", "species": "cfc-11"}`.

`0` already encodes as "nothing here" and renders fully transparent, so blank
looks blank by construction.

⚠ **Do not point it at the real CFC-11 prior yet.** `forward_model()` multiplies
by `1e9` (ppb) and CFC-11 is ppt, needing `1e12` — the modelled series would come
out 1000× low. That fix belongs to Brief 2, and the beacon weighting is the same
arithmetic. The population prior at
`data/fluxes/cfc-11/cfc-11-population_EASTASIA_2002.nc` is already on the
footprint grid and drops straight in **once the unit lookup lands**.

## Turning the wind on

The layer builds itself, but only paints where a stop asks. On each stop that
should show it:

```js
needs: ['wind'],
layers: { wind: 1 },
```

`beats-rgl.js:305` (`clean-wind`) is the working template. `needs` gates whether
the stop is skipped when wind is absent; `layers.wind` is what actually paints
(`deck.js:301`).

Two limits to respect:

- **Wind covers frames 0..669 of 672.** The last two frames (31 Jul 20:00 and
  22:00) clamp to the final wind step. Keep anchors clear of the end.
- **There is no lead-in before 1 June.** The record starts exactly at the window
  start, so a backward fan anchored in the first hours of June has nothing to
  walk into.
- The mean wind at the chosen level is **5.33 m/s**, so a 12 h rewind covers
  ~230 km. The store's eastern edge is 8.6° (~800 km) from Gosan. Ridge Hill's
  36 h rewind would run off the edge here — measure, do not copy.

## Checking it

- Serve it: `node scripts/serve.mjs`. **`story-*.html` cannot be opened over
  `file://`** — modules and `fetch` are blocked. Check which root and port it
  printed; a second server is indistinguishable from the first by URL.
- Extend `web/js/story/selftest.mjs` with a third row in its `SITES` table rather
  than assuming a change works — there is no browser automation here, and a bug
  that only shows in the browser costs a round trip.
- **Ridge Hill must stay at 464.** That rule has held through two refactors.

## Environment

- Python is `C:\Users\ef17148\AppData\Local\miniconda3\envs\gates_basic2\python.exe`.
  `conda` is not on `PATH`; bare `python` is the Windows Store stub.
- PowerShell mangles inline `python -c` — write a script to a file and run it.
- `PYTHONIOENCODING=utf-8` whenever piping or redirecting.
- `np.corrcoef` and `np.linalg.inv` crash this interpreter (BLAS delay-load,
  exit `0xC06D007E`, no traceback). Use `_pearson()` in the exporter.
- ⚠ **Never run `git clean -fdx` here** — `data/` is a junction to the main
  checkout and it would take 1.6 GB of inputs with it.

## Noted for later, not part of this pass

The user may want **`story-gsn.html` re-cut to the met's span**. The met store is
June–July 2016 only, so `SITES["GSN"]` (June–**August**, 1044 frames) can never
carry wind for its last third. Narrowing it to June–July would let the HFC-23
deck have wind too, at the cost of August's event — and would renumber every
frame index in `beats-gsn.js`. A decision, not a chore.
