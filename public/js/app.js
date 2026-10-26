// Start-up: load prices and settings, keep them fresh, and handle the
// password lock. The parts of the page live in their own modules.
import { $, store, state, getJSON, Locked, showError, lock, unlock } from './shared.js';
import { buildFace, render, renderStatus } from './dial.js';
import { loadHistory, turned } from './back.js';
import './sheet.js';

async function loadRates() {
  try {
    state.rates = await getJSON('/api/rates');
    state.lastGood = Date.now();
    state.feedError = null;
  } catch (err) {
    if (err instanceof Locked) throw err;
    state.feedError = err.message; // keep the last prices on screen, marked as old
  }
}

async function loadSettings() {
  const { limits, lastCheck, tape = [] } = await getJSON('/api/settings');
  Object.assign(state, { limits, tape, lastCheck: lastCheck?.time ?? null });
}

let refreshing = false;
async function refreshAll() {
  if (refreshing || !store.get('password')) return;
  refreshing = true;
  $('refresh').disabled = true;
  try {
    // History (up to ~90 KB) is only fetched while the back is showing.
    await Promise.all([loadSettings(), loadRates(), turned() ? loadHistory() : null]);
    const wasLocked = !$('lock').hidden;
    unlock();
    showError('');
    render();
    if (wasLocked) fit();
  } catch (err) {
    if (err instanceof Locked) {
      store.remove('password');
      lock('Wrong password.');
    } else {
      showError(`Couldn't load: ${err.message}`);
    }
  }
  $('refresh').disabled = false;
  refreshing = false;
}

$('lock').addEventListener('submit', async e => {
  e.preventDefault();
  store.set('password', $('password').value);
  $('password').value = '';
  $('lock-status').textContent = 'Checking…';
  await refreshAll();
});

// Pressing the crown winds the watch: refresh now. The hint shows until it's
// been pressed once on this device.
$('crown').addEventListener('click', async () => {
  store.set('wound', '1');
  $('crown-hint').hidden = true;
  await refreshAll();
  state.woundAt = Date.now();
  renderStatus();
});

$('refresh').addEventListener('click', () => refreshAll());

// Home-screen apps have no reload button and iOS freezes them in the
// background, so refresh on a timer and whenever the app comes back.
setInterval(() => { if (!document.hidden) refreshAll(); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
window.addEventListener('pageshow', e => { if (e.persisted) refreshAll(); });
window.addEventListener('focus', () => refreshAll());

// Size the watch to the screen, as clock and compass apps do: it fills the
// same share of the width on every phone, as far as the height allows,
// while text and controls keep their size and the spare height is shared
// out between the parts (#app). It grows by at most 20% and shrinks to 60%;
// if even that won't fit, the page scrolls (html.tall) rather than cut
// anything off.
function fit() {
  const gauge = $('gauge'), main = document.querySelector('main'), root = document.documentElement;
  gauge.style.transform = gauge.style.marginBottom = '';
  root.classList.remove('tall');
  if ($('app').hidden) return;
  main.style.minHeight = '0'; // measure the content's own height
  const over = main.scrollHeight - innerHeight;
  main.style.minHeight = '';
  const h = gauge.offsetHeight;
  const byWidth = gauge.clientWidth / $('case').offsetWidth;
  // Give the watch half of any spare height; take all of any shortfall.
  const byHeight = (h - (over > 0 ? over : over / 2)) / h;
  const k = Math.max(0.6, Math.min(1.2, byWidth, byHeight));
  if (Math.abs(k - 1) < 0.005) return;
  gauge.style.transform = `scale(${k.toFixed(3)})`;
  gauge.style.marginBottom = `${((k - 1) * h).toFixed(1)}px`; // match the space to the new size
  root.classList.toggle('tall', main.scrollHeight > innerHeight + 1);
}
addEventListener('resize', fit);
document.fonts?.ready.then(fit);

buildFace();
if (store.get('password')) refreshAll().then(fit);
else lock();
fit();
