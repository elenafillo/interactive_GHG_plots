/**
 * Compatibility shim. **Temporary — delete me.**
 *
 * `beats.js` was Ridge Hill's story *and* the deck machinery. The machinery is
 * `engine.js` now and the story is `beats-rgl.js`.
 *
 * Keeping this file was deliberate, and it is worth being clear about why. The
 * 464 checks in the story suite are the entire regression guarantee for this
 * refactor, and they are only a *guarantee* while the suite is untouched: a
 * green run after editing the suite's own imports proves rather less. So the
 * import surface was held still here, and the suite converted afterwards as its
 * own change, against a deck already known good. It worked — Ridge Hill's half
 * came out of the parameterisation at the same 464 checks, same names, same
 * order.
 *
 * ⚠ **One caller left: `scripts/measure_seeding.mjs`.** `deck.js` and
 * `selftest.mjs` are both off it. Brief D gives that script a `--site` argument
 * and points its two imports — `FRAMES` at the top and the dynamic `RELEASES`
 * near the end — at `beats-<site>.js`, reading `DECK.frames` and `DECK.releases`
 * directly. **When that lands, delete this file.**
 *
 * Nothing new should import from it.
 */

import { buildDeck, resolveFrames as engineResolveFrames } from './engine.js';
import { DECK } from './beats-rgl.js';

export {
  BANNED_WORDS, MAX_CAPTION_WORDS, countWords, bannedIn,
  DEFAULT_LAYERS, resolvePlay, toSlides,
} from './engine.js';

export const FRAMES = DECK.frames;
export const SMELL = DECK.smell;
export const RELEASES = DECK.releases;
export const SHOW_RECORD_LOW = DECK.flags.showRecordLow;
export const SHOW_DIRTY_BACKTRACK = DECK.flags.showDirtyBacktrack;

export const resolveFrames = (opts = {}) => engineResolveFrames({ ...opts, defaults: DECK.frames });

export const buildBeats = (frames = DECK.frames, opts = {}) => buildDeck(DECK, frames, opts);
