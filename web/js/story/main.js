/**
 * Entry point for story.html. Thin on purpose, matching explore.js -- the deck
 * itself is in deck.js so the headless suite can import the parts it needs
 * without dragging in a page.
 */

import { mountDeck } from './deck.js';

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

mountDeck({ defaultData: 'data-rgl/' });
