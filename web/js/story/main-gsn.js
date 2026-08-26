/**
 * Entry point for story-gsn.html. Mirrors main.js exactly but for the spec it
 * hands over -- the deck is one argument, and everything that differs between
 * the two sites is inside it.
 */

import { mountDeck } from './deck.js';
import { DECK } from './beats-gsn.js';

const fatal = (err) => {
  console.error(err);
  const loader = document.getElementById('loader');
  loader.classList.remove('done');
  document.getElementById('loadMsg').innerHTML =
    `<strong>Could not start.</strong><br>${err && err.message ? err.message : err}` +
    '<br><span style="font-size:12px">See the browser console for the full trace.</span>';
  document.getElementById('loadBar').style.background = '#eb6834';
};

window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

mountDeck({ deck: DECK });
