// Start-up: load prices and settings, keep them fresh, and handle the
// password lock. The parts of the page live in their own modules.
import { $, DEMO, store, state, getJSON, Locked, showError, lock, unlock, pressable, feel, sound, haptic } from './shared.js';
import { sampleData } from './demo.js';
import { buildLock, openLid, refuse } from './lock.js';
import { buildFace, render, renderStatus, wakeNeedle } from './dial.js';
import { loadHistory, turned } from './back.js';
import './sheet.js';

function loadDemo() {
  const { rates, limits, knob } = sampleData();
  Object.assign(state, { rates, limits, knob, lastCheck: Date.now(), lastGood: Date.now(), feedError: null });
  if (!knob.includes(state.pair)) state.pair = knob[0];
}

async function loadRates() {
  try {
    // "Today" starts at this device's midnight, like every time on the page.
    const midnight = new Date().setHours(0, 0, 0, 0) / 1000;
    state.rates = await getJSON(`/api/rates?since=${midnight}`);
    if (!state.offlineAt) state.lastGood = Date.now();
    state.feedError = null;
  } catch (err) {
    if (err instanceof Locked) throw err;
    state.feedError = err.message; // keep the last prices on screen, marked as old
  }
}

async function loadSettings() {
  // The time zone goes along so the check knows when it's night here (quiet hours).
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { limits, knob = ['GBP', 'USD'], lastCheck, tape = [], alerted = null, steps = {}, rearm = 0.001, step = 0.002, failing = null, alertError = null } = await getJSON(`/api/settings?tz=${encodeURIComponent(tz)}`);
  Object.assign(state, { limits, knob, tape, lastCheck: lastCheck?.time ?? null, alerted, steps, rearm, step, failing, alertError });
  // Outside the sheet the dial reads a currency on the knob.
  if (!state.draft && !knob.includes(state.pair)) state.pair = knob[0];
}

let refreshing = false;
async function refreshAll() {
  if (refreshing || (!DEMO && !store.get('password'))) return;
  refreshing = true;
  $('refresh').disabled = true;
  try {
    // History (up to ~90 KB) is only fetched while the back is showing.
    await Promise.all([...(DEMO ? [loadDemo()] : [loadSettings(), loadRates()]), turned() ? loadHistory() : null]);
    const wasLocked = !$('lock').hidden;
    state.lidShut = wasLocked;
    unlock();
    showError('');
    render();
    if (wasLocked) {
      fit(); // the readout has its real lines now
      // The form fades as the rest of the page comes in.
      const form = $('lock');
      form.hidden = false;
      form.classList.add('leaving');
      $('app').classList.add('arriving');
      setTimeout(() => {
        form.hidden = true;
        form.classList.remove('leaving');
        $('app').classList.remove('arriving');
      }, 300);
      openLid(wakeNeedle);
    }
  } catch (err) {
    if (err instanceof Locked) {
      const tried = !$('lock').hidden;
      store.remove('password');
      lock('Wrong password.');
      fit();
      if (tried) refuse();
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
// While it runs, the status line says WINDING… and its lamp pulses, for at
// least 0.6s so a fast refresh still reads as winding, not a flicker.
async function wind() {
  state.winding = true;
  renderStatus();
  await Promise.all([refreshAll(), new Promise(r => setTimeout(r, 600))]);
  state.winding = false;
  state.woundAt = Date.now();
  renderStatus();
}
pressable($('crown'), () => { haptic(8); sound('ratchet'); });
feel($('crown'));
$('crown').addEventListener('click', () => {
  store.set('wound', '1');
  $('crown-hint').hidden = true;
  wind();
});

pressable($('refresh'));
$('refresh').addEventListener('click', wind);
document.querySelectorAll('.btn').forEach(b => pressable(b));

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
  gauge.style.removeProperty('--fit');
  gauge.style.marginBottom = '';
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
  if (Math.abs(k - 1) < 0.005) return placeLock();
  gauge.style.setProperty('--fit', k.toFixed(3));
  gauge.style.marginBottom = `${((k - 1) * h).toFixed(1)}px`; // match the space to the new size
  root.classList.toggle('tall', main.scrollHeight > innerHeight + 1);
  placeLock();
}
// While locked, the form sits halfway down the space below the watch.
function placeLock() {
  const form = $('lock');
  if (form.hidden) return;
  const top = $('case').getBoundingClientRect().bottom, bottom = document.querySelector('footer').getBoundingClientRect().top;
  const origin = document.querySelector('main').getBoundingClientRect().top;
  form.style.top = `${Math.round(top - origin + Math.max(8, (bottom - top - form.offsetHeight) / 2))}px`;
}
addEventListener('resize', fit);
document.fonts?.ready.then(fit);

// Keep an offline copy, so the app opens without a connection (sw.js).
// When a new version of it takes over an open page, reload once, so the
// page doesn't carry on with files the old one served.
if (navigator.serviceWorker) {
  const hadOne = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadOne) location.reload(); });
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

buildFace();
if (!DEMO) buildLock();
if (DEMO) {
  document.title = 'FX Watch demo';
  document.querySelector('.masthead .small').textContent = 'DEMO · SAMPLE DATA';
  document.querySelector('footer').textContent = 'SAMPLE PRICES · NOT A QUOTE';
  $('toggle-settings').textContent = 'View on GitHub';
  $('toggle-settings').removeAttribute('aria-haspopup');
}
if (DEMO || store.get('password')) refreshAll().then(fit);
else lock();
fit();
