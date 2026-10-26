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
let lastCheck = null;  // when the 10-minute alert check last ran (epoch ms)
let lastGood = null;   // when this page last loaded prices successfully
let feedError = null;  // message if the latest price load failed

const QUOTE_STALE_MIN = 60;  // CITIC normally re-quotes every few minutes
const CHECK_STALE_MIN = 25;  // the alert check runs every 10 minutes
let pair = store.get('pair') === 'USD' ? 'USD' : 'GBP'; // which currency the dial reads
let shown = ''; // digits currently on the flaps, so only changed ones flip

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

const minutesAgo = ms => (Date.now() - ms) / 60000;

// One line that says whether the prices and the alert check can be trusted.
function renderStatus() {
  const quoteTime = Math.max(0, ...Object.values(rates).map(r => r.time * 1000));
  let level = 'ok';
  let text = 'LIVE';
  if (feedError) {
    level = 'error';
    text = lastGood ? `CITIC FEED ERROR · PRICES FROM ${time(new Date(lastGood))}` : 'CITIC FEED ERROR';
  } else if (quoteTime && minutesAgo(quoteTime) > QUOTE_STALE_MIN) {
    level = 'warn';
    text = `NO NEW QUOTE SINCE ${time(new Date(quoteTime))}`;
  }
  if (!lastCheck) {
    if (level === 'ok') level = 'warn';
    text += ' · ALERTS NOT CHECKED YET';
  } else if (minutesAgo(lastCheck) > CHECK_STALE_MIN) {
    if (level === 'ok') level = 'warn';
    text += ` · ALERTS LAST CHECKED ${time(new Date(lastCheck))}`;
  } else {
    text += ` · ALERTS CHECKED ${time(new Date(lastCheck))}`;
  }
  $('refresh').className = `status ${level}`;
  $('status-text').textContent = text;
  $('refresh').title = feedError || '';
}

// The dial maps a price range onto a half circle, 0 (far left) to 1 (far
// right). The floor sits at 0.3 and the ceiling at 0.7, so the HOLD band is
// the range you set. With one side off, a 1% span stands in for the missing
// limit only to scale the dial; that side's band reads OFF and never alerts.
function span(price, floor, ceiling) {
  if (floor == null && ceiling == null) return [price * 0.995, price * 1.005];
  return [floor ?? ceiling * 0.99, ceiling ?? floor * 1.01];
}

function position(price, floor, ceiling) {
  const [lo, hi] = span(price, floor, ceiling);
  const pos = 0.3 + (0.4 * (price - lo)) / (hi - lo);
  return Math.min(0.98, Math.max(0.02, pos));
}

const SVG = 'http://www.w3.org/2000/svg';
const point = (pos, r) => {
  const a = Math.PI * (1 - pos);
  return [170 + r * Math.cos(a), 170 - r * Math.sin(a)];
};
const arc = (a, b, r) => {
  const [x1, y1] = point(a, r);
  const [x2, y2] = point(b, r);
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 0 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
};
function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text) el.textContent = text;
  return el;
}

// Parts of the face that never change: bands, 61 ticks, floor/ceiling markers.
function buildFace() {
  const bands = { buy: [0.003, 0.3], hold: [0.3, 0.7], high: [0.7, 0.997] };
  for (const [name, [a, b]] of Object.entries(bands)) {
    $(`band-${name}`).setAttribute('d', arc(a, b, 117));
    $(`path-${name}`).setAttribute('d', arc(a, b, 114.5));
  }
  $('ticks').replaceChildren(...Array.from({ length: 61 }, (_, i) => {
    const major = i % 5 === 0;
    const [x1, y1] = point(i / 60, 140);
    const [x2, y2] = point(i / 60, major ? 129 : 134);
    return svgEl('line', { x1, y1, x2, y2, 'stroke-width': major ? 1.6 : 0.7 });
  }));
  $('markers').replaceChildren(...[0.3, 0.7].map(pos => {
    const pts = [point(pos, 128), point(pos - 0.013, 120), point(pos + 0.013, 120)];
    return svgEl('polygon', { points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') });
  }));
}

// Printed prices around the scale, every other major tick.
function drawScale(price, { floor, ceiling }) {
  const [lo, hi] = span(price, floor, ceiling);
  $('scale').replaceChildren(...Array.from({ length: 7 }, (_, k) => {
    const pos = k / 6;
    const [x, y] = point(pos, 98);
    return svgEl('text', { x: x.toFixed(1), y: (y + 3).toFixed(1) }, (lo + ((pos - 0.3) / 0.4) * (hi - lo)).toFixed(3));
  }));
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

function drawFlaps(text) {
  const box = $('flaps');
  const before = shown;
  box.replaceChildren(...[...text].map((ch, i) => {
    const el = document.createElement('span');
    el.className = ch === '.' ? 'flap dot' : 'flap';
    el.textContent = ch;
    if (before && before[i] !== ch) el.classList.add('flip');
    return el;
  }));
  box.setAttribute('aria-label', text);
  shown = text;
}

function render() {
  for (const p of PAIRS) {
    // Lamps track every currency, so the one not on the dial still shows its zone.
    const zone = rates[p] && !feedError ? zoneOf(rates[p].price, limits[p]) : '';
    $(`lamp-${p}`).className = `lamp-dot ${zone}`;
    document.querySelector(`.pick[data-pair="${p}"]`).setAttribute('aria-pressed', String(p === pair));
    document.querySelector(`.pick[data-pair="${p}"]`).setAttribute('aria-label', `${p}${zone ? `, ${zone === 'high' ? 'too high' : zone}` : ''}`);
  }
  $('knob').classList.toggle('usd', pair === 'USD');
  $('pair-label').textContent = `${pair} → CNY`;

  const r = rates[pair];
  const l = limits[pair];
  const noFloor = l.floor == null;
  const noCeiling = l.ceiling == null;
  const gauge = $('gauge');
  gauge.classList.toggle('no-floor', noFloor);
  gauge.classList.toggle('no-ceiling', noCeiling);
  gauge.classList.toggle('stale', !!feedError);
  $('floor').textContent = noFloor ? 'Floor off' : `Floor ${l.floor.toFixed(4)}`;
  $('ceiling').textContent = noCeiling ? 'Ceiling off' : `Ceiling ${l.ceiling.toFixed(4)}`;
  $('label-floor').textContent = noFloor ? 'OFF' : 'BUY';
  $('label-ceiling').textContent = noCeiling ? 'OFF' : 'TOO HIGH';
  $('label-hold').textContent = noFloor && noCeiling ? 'ALERTS OFF' : 'HOLD';

  if (r) {
    const deg = position(r.price, l.floor, l.ceiling) * 180 - 90;
    $('needle').style.transform = `rotate(${deg}deg)`;
    drawScale(r.price, l);
    drawFlaps(r.price.toFixed(4));

    const zone = zoneOf(r.price, l);
    // An old price must not read as a current BUY/HOLD call.
    $('zone').textContent = feedError ? '· STALE'
      : { buy: '· BUY', high: '· TOO HIGH', hold: '· HOLD' }[zone] || '· ALERTS OFF';
    $('zone').className = `zone ${feedError ? '' : zone}`;

    const parts = [distance(r.price, l)];
    if (r.previousClose) {
      const pct = ((r.price - r.previousClose) / r.previousClose) * 100;
      parts.push(`${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}% today`);
    }
    parts.push(`quoted ${time(new Date(r.time * 1000))}`);
    $('note').textContent = parts.join(' · ');
  }
  renderStatus();
}

function selectPair(next) {
  if (next === pair) return;
  pair = next;
  store.set('pair', pair);
  render();
}

document.querySelectorAll('.pick').forEach(b => b.addEventListener('click', () => selectPair(b.dataset.pair)));
$('knob').addEventListener('click', () => selectPair(pair === 'GBP' ? 'USD' : 'GBP'));

async function loadRates() {
  try {
    rates = await getJSON('/api/rates');
    lastGood = Date.now();
    feedError = null;
  } catch (err) {
    if (err instanceof Locked) throw err;
    feedError = err.message; // keep the last prices on screen, marked as old
  }
}

let editing = false; // don't overwrite inputs while the settings panel is open
async function loadSettings() {
  let check;
  ({ limits, lastCheck: check } = await getJSON('/api/settings'));
  lastCheck = check?.time ?? null;
  if (!editing) for (const p of PAIRS) for (const side of SIDES) $(`${side}-input-${p}`).value = limits[p][side] ?? '';
}

let refreshing = false;
async function refreshAll() {
  if (refreshing || !store.get('password')) return;
  refreshing = true;
  $('refresh').disabled = true;
  try {
    await Promise.all([loadSettings(), loadRates()]);
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
  editing = open;
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
setInterval(() => { if (!document.hidden) refreshAll(); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
window.addEventListener('pageshow', e => { if (e.persisted) refreshAll(); });
window.addEventListener('focus', () => refreshAll());

buildFace();
if (store.get('password')) refreshAll();
else lock();
