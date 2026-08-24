/**
 * The sound lab retuning the listen page, live, while both tabs are open.
 *
 * One-directional on purpose: the lab is the workbench and publishes, the
 * listen page subscribes. Nothing is persisted -- close the lab and the listen
 * page keeps whatever it was last told until it reloads, at which point it is
 * back to the defaults in sonify.js. That is the honest behaviour for a channel
 * with no storage behind it, and it means there is no hidden state to explain
 * when a knob "does nothing" on a fresh load.
 *
 * A subscriber says hello when it starts, because the lab may already be open
 * with knobs moved; without that, opening the listen page second would silently
 * show defaults while the lab's dial reads something else.
 *
 * Messages, every one of them stamped with PROTOCOL:
 *   { type: 'hello' }                                  subscriber -> lab
 *   { type: 'state', opts, mix, mutes, summary }       lab -> subscriber
 *   { type: 'patch', kind, key, value, summary }       lab -> subscriber
 *   { type: 'alive' }                                  lab -> subscriber, on a beat
 *   { type: 'bye' }                                    lab -> subscriber, on unload
 *
 * `kind` says which of the three the key belongs to: 'opt' is a score option
 * and is rebuilt by the Sonifier, 'mix' is a layer gain and 'mute' a layer
 * mute, both of which live on the AudioEngine and never touch the score.
 *
 * `summary` is the lab's wording for everything currently away from its
 * default, and rides along on every message rather than being accumulated by
 * the subscriber. A patch has to be able to say what the *other* knobs are
 * still set to -- a status line naming only the last thing to move would claim
 * the rest had gone back to normal.
 *
 * The heartbeat exists because a channel has no disconnect event: a closed tab
 * simply stops talking, and "a lab is open and sitting at its defaults" is
 * otherwise indistinguishable from "no lab is open" -- both are silence. That
 * ambiguity is expensive, because it is also what a genuinely broken link looks
 * like, so presence is inferred from the beat and reported.
 *
 * PROTOCOL is stamped on every message for the same reason. Two tabs of a page
 * that is edited while it is open will happily disagree about the message
 * shape, and the failure is silent -- an older listen page routes a layer mute
 * into the score, where it does nothing at all. A mismatch is worth saying out
 * loud. Bump it whenever the fields above change meaning.
 */

const CHANNEL = 'ghg.sonify.tuning';
const PROTOCOL = 2;
const BEAT_MS = 1500;
// Two missed beats. One is too tight -- a busy main thread can delay a beat.
const STALE_MS = 4000;

const open = () => ('BroadcastChannel' in globalThis ? new BroadcastChannel(CHANNEL) : null);

// Node has no `addEventListener` on the global, and its timers keep the process
// alive; both matter because the self-tests exercise this file outside a browser.
const onWindow = (type, fn) => {
  if (typeof addEventListener === 'function') addEventListener(type, fn);
};
const loose = (timer) => { timer.unref?.(); return timer; };

/** The lab side: answers hello, beats, and publishes each knob move. */
export function publishTuning(getState) {
  const ch = open();
  if (!ch) return { patch: () => {}, stop: () => {} };
  const say = (msg) => ch.postMessage({ ...msg, protocol: PROTOCOL });

  ch.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'hello') say({ type: 'state', ...getState() });
  });

  const beat = loose(setInterval(() => say({ type: 'alive' }), BEAT_MS));
  say({ type: 'alive' });
  const stop = () => { clearInterval(beat); say({ type: 'bye' }); };
  // `pagehide` rather than `beforeunload`: it still fires for a tab restored
  // from the back/forward cache, and it does not suppress that cache.
  onWindow('pagehide', stop);

  return {
    // The summary is re-read from `getState` rather than passed in, so a caller
    // cannot ship a value and a description of it that disagree.
    patch(kind, key, value) {
      say({ type: 'patch', kind, key, value, summary: getState().summary });
    },
    stop,
  };
}

/**
 * The listen side: applies whatever the lab sends, and reports whether there is
 * a lab there at all.
 *
 * `onPresence({ connected, protocolOk })` fires only when the answer changes,
 * so it can drive a status line directly without the caller de-duplicating.
 */
export function subscribeTuning({ onState, onPatch, onPresence }) {
  const ch = open();
  if (!ch) return false;

  let seenAt = 0;
  // A message with no stamp is a tab running the code from before stamping.
  let theirs = PROTOCOL;
  let last = '';

  const report = () => {
    const connected = seenAt > 0 && Date.now() - seenAt < STALE_MS;
    const key = `${connected}:${theirs}`;
    if (key === last) return;
    last = key;
    if (onPresence) onPresence({ connected, protocolOk: theirs === PROTOCOL });
  };

  ch.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type === 'hello') return;
    theirs = m.protocol || 1;
    seenAt = m.type === 'bye' ? 0 : Date.now();
    report();
    if (m.type === 'state' && onState) onState(m);
    else if (m.type === 'patch' && onPatch) onPatch(m);
  });

  // Catches the lab going away, which by definition sends nothing.
  loose(setInterval(report, 1000));
  ch.postMessage({ type: 'hello' });
  return true;
}
