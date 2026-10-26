const $ = id => document.getElementById(id);
const PAIRS = ['GBP', 'USD'];
const SIDES = ['floor', 'ceiling'];

const store = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
  remove: key => { try { localStorage.removeItem(key); } catch {} },
};

let rates = {};
let limits = { GBP: { floor: null, ceiling: null }, USD: { floor: null, ceiling: null } };
const shown = {}; // last digits drawn per pair, so only changed flaps flip

const time = (date, seconds = false) => date.toLocaleTimeString('en-GB', {
  hour: '2-digit', minute: '2-digit', ...(seconds && { second: '2-digit' }),
});

class Locked extends Error {}

async function getJSON(url, options = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${store.get('password') || ''}` },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Locked();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showError(message) {
  $('error').hidden = !message;
  $('error').textContent = message || '';
}

function lock(message = '') {
  $('app').hidden = true;
  $('refresh').hidden = true;
  $('lock').hidden = false;
  $('lock-status').textContent = message;
  $('password').focus();
}

function unlock() {
  $('lock').hidden = true;
  $('app').hidden = false;
  $('refresh').hidden = false;
}

// Where the needle sits, 0 (far left) to 1 (far right). The floor is drawn
// at 0.3 and the ceiling at 0.7, so the HOLD band is the range you set.
function position(price, floor, ceiling) {
  if (floor == null && ceiling == null) return 0.5;
  const lo = floor ?? ceiling * 0.98;
  const hi = ceiling ?? floor * 1.02;
  const pos = 0.3 + (0.4 * (price - lo)) / (hi - lo);
  return Math.min(0.97, Math.max(0.03, pos));
}

function zoneOf(price, { floor, ceiling }) {
  if (floor != null && price < floor) return 'buy';
  if (ceiling != null && price > ceiling) return 'high';
  return floor == null && ceiling == null ? '' : 'hold';
}

function distance(price, { floor, ceiling }) {
  const d = n => Math.abs(n).toFixed(4);
  if (floor != null && price < floor) return `${d(floor - price)} below floor`;
  if (ceiling != null && price > ceiling) return `${d(price - ceiling)} above ceiling`;
  if (floor != null) return `${d(price - floor)} above floor`;
  if (ceiling != null) return `${d(ceiling - price)} below ceiling`;
  return 'No limits set';
}

function drawFlaps(pair, text) {
  const box = $(`flaps-${pair}`);
  const before = shown[pair] || '';
  box.replaceChildren(...[...text].map((ch, i) => {
    const el = document.createElement('span');
    el.className = ch === '.' ? 'flap dot' : 'flap';
    el.textContent = ch;
    if (before && before[i] !== ch) el.classList.add('flip');
    return el;
  }));
  box.setAttribute('aria-label', text);
  shown[pair] = text;
}

function render() {
  for (const p of PAIRS) {
    const r = rates[p];
    const l = limits[p];
    const gauge = document.querySelector(`.gauge[data-pair="${p}"]`);
    gauge.classList.toggle('unset', l.floor == null && l.ceiling == null);
    if ($(`floor-${p}`)) {
      $(`floor-${p}`).textContent = `Floor ${l.floor?.toFixed(4) ?? '—'}`;
      $(`ceiling-${p}`).textContent = `Ceiling ${l.ceiling?.toFixed(4) ?? '—'}`;
    }
    if (!r) continue;

    const deg = position(r.price, l.floor, l.ceiling) * 180 - 90;
    $(`needle-${p}`).style.transform = `rotate(${deg}deg)`;
    drawFlaps(p, r.price.toFixed(4));

    const zone = zoneOf(r.price, l);
    $(`zone-${p}`).textContent = { buy: '· BUY', high: '· TOO HIGH', hold: '· HOLD' }[zone] || '';
    $(`zone-${p}`).className = `zone ${zone}`;

    const parts = [distance(r.price, l)];
    if (r.previousClose) {
      const pct = ((r.price - r.previousClose) / r.previousClose) * 100;
      parts.push(`${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}% today`);
    }
    parts.push(`quoted ${time(new Date(r.time * 1000))}`);
    $(`note-${p}`).textContent = parts.join(' · ');
  }
}

async function loadRates() {
  rates = await getJSON('/api/rates');
  $('updated').textContent = time(new Date(), true);
}

async function loadSettings() {
  ({ limits } = await getJSON('/api/settings'));
  for (const p of PAIRS) for (const side of SIDES) $(`${side}-input-${p}`).value = limits[p][side] ?? '';
}

let refreshing = false;
async function refreshAll(onlyRates = false) {
  if (refreshing || !store.get('password')) return;
  refreshing = true;
  $('refresh').disabled = true;
  try {
    await Promise.all(onlyRates ? [loadRates()] : [loadSettings(), loadRates()]);
    unlock();
    showError('');
    render();
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

$('toggle-settings').addEventListener('click', () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('toggle-settings').setAttribute('aria-expanded', String(open));
  $('toggle-settings').textContent = open ? 'CLOSE' : 'SET FLOOR & CEILING';
});

$('settings').addEventListener('submit', async e => {
  e.preventDefault();
  const next = {};
  for (const p of PAIRS) {
    next[p] = {};
    for (const side of SIDES) {
      const raw = $(`${side}-input-${p}`).value.trim();
      next[p][side] = raw === '' ? null : Number(raw);
    }
  }
  $('form-status').textContent = 'Saving…';
  try {
    ({ limits } = await getJSON('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limits: next }),
    }));
    $('form-status').textContent = 'Saved.';
    render();
  } catch (err) {
    if (err instanceof Locked) return lock('Enter your password again.');
    $('form-status').textContent = err.message;
  }
});

$('test').addEventListener('click', async () => {
  $('form-status').textContent = 'Sending…';
  try {
    await getJSON('/api/test', { method: 'POST' });
    $('form-status').textContent = 'Sent. Check Telegram.';
  } catch (err) {
    if (err instanceof Locked) return lock('Enter your password again.');
    $('form-status').textContent = err.message;
  }
});

$('refresh').addEventListener('click', () => refreshAll());

// Home-screen apps have no reload button and iOS freezes them in the
// background, so refresh on a timer and whenever the app comes back.
setInterval(() => { if (!document.hidden) refreshAll(true); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
window.addEventListener('pageshow', e => { if (e.persisted) refreshAll(); });
window.addEventListener('focus', () => refreshAll());

if (store.get('password')) refreshAll();
else lock();
