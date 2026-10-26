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
let tape = [];         // quotes the alert check has recorded, newest first
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
  $('crown-hint').hidden = !!store.get('wound');
}

// Pressing the crown winds the watch: refresh now. The hint shows until it's
// been pressed once on this device.
let woundAt = 0;
$('crown').addEventListener('click', async () => {
  store.set('wound', '1');
  $('crown-hint').hidden = true;
  await refreshAll();
  woundAt = Date.now();
  renderStatus();
});

const minutesAgo = ms => (Date.now() - ms) / 60000;

// One line that says whether the prices and the alert check can be trusted.
function renderStatus() {
  const quoteTime = Math.max(0, ...Object.values(rates).map(r => r.time * 1000));
  let level = 'ok';
  let text = woundAt && Date.now() - woundAt < 20_000 ? 'LIVE · REFRESHED JUST NOW' : 'LIVE';
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
  } else if (text === 'LIVE') {
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

// Split-flap digits. A changed digit flips like a real Solari board: the old
// top half falls away, then the new bottom half drops into place. Digits
// flip one after another, left to right.
function drawFlaps(text) {
  const before = shown;
  const half = (side, ch, extra = '') => {
    const el = document.createElement('span');
    el.className = `half ${side} ${extra}`.trim();
    const inner = document.createElement('span');
    inner.className = 'ch';
    inner.textContent = ch;
    el.append(inner);
    return el;
  };
  let order = 0;
  $('flaps').replaceChildren(...[...text].map((ch, i) => {
    if (ch === '.') {
      const dot = document.createElement('span');
      dot.className = 'flap-dot';
      return dot;
    }
    const tile = document.createElement('span');
    tile.className = 'tile';
    const prev = before ? before[i] : ch;
    if (prev === ch) {
      tile.append(half('top', ch), half('bottom', ch));
    } else {
      const delay = order++ * 90;
      const fall = half('top', prev, 'fall');
      const rise = half('bottom', ch, 'rise');
      fall.style.animationDelay = `${delay}ms`;
      rise.style.animationDelay = `${delay + 200}ms`;
      tile.append(half('top', ch), half('bottom', prev), fall, rise);
    }
    return tile;
  }));
  $('flaps').setAttribute('aria-label', text);
  shown = text;
}

function render() {
  for (const p of PAIRS) {
    // Lamps track every currency, so the one not on the dial still shows its zone.
    const zone = rates[p] && !feedError ? zoneOf(rates[p].price, limitsFor(p)) : '';
    $(`lamp-${p}`).className = `lamp-dot ${zone}`;
    document.querySelector(`.pick[data-pair="${p}"]`).setAttribute('aria-pressed', String(p === pair));
    document.querySelector(`.pick[data-pair="${p}"]`).setAttribute('aria-label', `${p}${zone ? `, ${zone === 'high' ? 'too high' : zone}` : ''}`);
  }
  $('knob').classList.toggle('usd', pair === 'USD');
  $('pair-label').textContent = `${pair} → CNY`;

  const r = rates[pair];
  const l = limitsFor(pair);
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
    $('zone').textContent = feedError ? '· STALE ·'
      : { buy: '· BUY ·', high: '· TOO HIGH ·', hold: '· HOLD ·' }[zone] || '· ALERTS OFF ·';
    $('zone').className = `zone ${feedError ? '' : zone}`;

    const parts = [distance(r.price, l)];
    if (r.previousClose) {
      const pct = ((r.price - r.previousClose) / r.previousClose) * 100;
      parts.push(`${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}% today`);
    }
    parts.push(`quoted ${time(new Date(r.time * 1000))}`);
    $('note').textContent = parts.join(' · ');
    $('gauge').setAttribute('aria-label', `${pair} to CNY ${r.price.toFixed(4)}, ${$('zone').textContent.replaceAll('·', '').trim()}`);
  }
  renderStatus();
  drawTape();
}

// The tape leads with the live quote when it's newer than the last recorded
// one, then the recorded quotes, for the currency on the dial. Arrows
// compare each line with the one after.
let tapeKey = '';
function drawTape() {
  const live = PAIRS.every(p => rates[p])
    ? { t: Math.max(...PAIRS.map(p => rates[p].time)), ...Object.fromEntries(PAIRS.map(p => [p, rates[p].price])) }
    : null;
  const lines = live && (!tape[0] || live.t > tape[0].t) ? [live, ...tape] : tape;
  const arrow = (now, before) => before == null ? '' : now > before ? ' ▲' : now < before ? ' ▼' : ' =';
  const texts = lines.map((q, i) => `${time(new Date(q.t * 1000))}  ${pair} ${q[pair].toFixed(4)}${arrow(q[pair], lines[i + 1]?.[pair])}   ·`);
  if (lines.length < 4) texts.push('RECORDING A QUOTE EVERY 10 MINUTES   ·');
  // Each half of the loop must be wider than the screen, or a gap shows.
  while (texts.length < 4) texts.push(...texts);
  const key = texts.join('|');
  if (key === tapeKey) return; // don't restart the scroll unless something changed
  const fresh = tapeKey && !tapeKey.startsWith(texts[0]);
  tapeKey = key;
  const make = (text, i) => Object.assign(document.createElement('span'), { textContent: text, className: i === 0 && fresh ? 'fresh' : '' });
  const run = $('tape-run');
  run.replaceChildren(...texts.map(make), ...texts.map(t => make(t, -1)));
  // Keep a steady reading speed whatever the length: about 28px a second.
  requestAnimationFrame(() => { run.style.animationDuration = `${Math.max(20, run.scrollWidth / 2 / 28)}s`; });
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

async function loadSettings() {
  let check;
  ({ limits, lastCheck: check, tape = [] } = await getJSON('/api/settings'));
  lastCheck = check?.time ?? null;
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

// ---- Settings sheet: number wheels -------------------------------------
// While the sheet is open the dial previews the draft, so you can see where
// a new floor or ceiling would sit before saving.
let draft = null; // { floor: { on, text }, ceiling: { on, text } } for `pair`
const wheelCols = { floor: [], ceiling: [] };

function draftLimits() {
  return Object.fromEntries(SIDES.map(side => [side, draft[side].on ? Number(draft[side].text) : null]));
}
const crossed = ({ floor, ceiling }) => floor != null && ceiling != null && floor >= ceiling;

// The dial previews the draft, unless the draft has floor above ceiling.
function limitsFor(p) {
  if (!draft || p !== pair || crossed(draftLimits())) return limits[p];
  return draftLimits();
}

const DIGIT_H = 32;
const colOffset = d => `translateY(${12 - d * DIGIT_H}px)`;

function setDigit(side, i, delta) {
  const chars = [...draft[side].text];
  chars[i] = String((Number(chars[i]) + delta + 10) % 10);
  draft[side].text = chars.join('');
  const wheel = wheelCols[side][i];
  wheel.col.style.transform = colOffset(Number(chars[i]));
  wheel.el.setAttribute('aria-valuenow', chars[i]);
  if (!draft[side].on) toggleSide(side);
  sheetChanged();
}

// Drag up to turn a wheel forward, down to turn it back; a tap on the top
// half adds one, on the bottom half takes one away.
function makeWheel(side, i, digit) {
  const el = document.createElement('div');
  el.className = 'wheel';
  el.tabIndex = 0;
  el.setAttribute('role', 'spinbutton');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '9');
  el.setAttribute('aria-valuenow', digit);
  el.setAttribute('aria-label', `${side} digit ${i + 1}`);
  const col = document.createElement('div');
  col.className = 'wheel-col';
  col.append(...Array.from({ length: 10 }, (_, n) => Object.assign(document.createElement('span'), { textContent: n })));
  col.style.transform = colOffset(Number(digit));
  el.append(col);
  wheelCols[side][i] = { el, col };

  let startY = 0, lastY = 0, moved = false;
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    startY = lastY = e.clientY;
    moved = false;
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientY - startY) > 6) moved = true;
    while (lastY - e.clientY >= 24) { setDigit(side, i, 1); lastY -= 24; }
    while (e.clientY - lastY >= 24) { setDigit(side, i, -1); lastY += 24; }
  });
  el.addEventListener('pointerup', e => {
    if (moved) return;
    const box = el.getBoundingClientRect();
    setDigit(side, i, e.clientY < box.top + box.height / 2 ? 1 : -1);
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { e.preventDefault(); setDigit(side, i, 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setDigit(side, i, -1); }
  });
  return el;
}

function toggleSide(side) {
  draft[side].on = !draft[side].on;
  $(`toggle-${side}`).setAttribute('aria-pressed', String(draft[side].on));
  $(`toggle-${side}`).textContent = draft[side].on ? 'ON' : 'OFF';
  $(`row-${side}`).classList.toggle('off', !draft[side].on);
  sheetChanged();
}

function sheetChanged() {
  const bad = crossed(draftLimits());
  $('sheet-note').textContent = bad
    ? 'Floor must be lower than ceiling.'
    : 'A Telegram message when the price drops below the floor or rises above the ceiling.';
  $('sheet-note').classList.toggle('bad', bad);
  $('form-status').textContent = '';
  render();
}

function openSheet() {
  // A limit that's off starts from the current price, ready to dial in.
  const start = (rates[pair]?.price ?? 1).toFixed(4);
  draft = Object.fromEntries(SIDES.map(side => {
    const v = limits[pair][side];
    return [side, { on: v != null, text: v != null ? v.toFixed(4) : start }];
  }));
  $('sheet-title').textContent = `SET ${pair} LIMITS`;
  for (const side of SIDES) {
    $(`wheels-${side}`).replaceChildren(...[...draft[side].text].map((ch, i) => {
      if (ch === '.') return Object.assign(document.createElement('span'), { className: 'wheel-dot' });
      return makeWheel(side, i, ch);
    }));
    draft[side].on = !draft[side].on; // toggleSide flips it back and syncs the button
    toggleSide(side);
  }
  $('sheet-backdrop').hidden = false;
  $('settings').hidden = false;
  $('wheels-floor').querySelector('.wheel').focus({ preventScroll: true });
}

function closeSheet() {
  draft = null;
  $('settings').hidden = true;
  $('sheet-backdrop').hidden = true;
  render();
  $('toggle-settings').focus({ preventScroll: true });
}

$('toggle-settings').addEventListener('click', openSheet);
$('sheet-close').addEventListener('click', closeSheet);
$('sheet-backdrop').addEventListener('click', closeSheet);
$('toggle-floor').addEventListener('click', () => toggleSide('floor'));
$('toggle-ceiling').addEventListener('click', () => toggleSide('ceiling'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && draft) closeSheet(); });

$('settings').addEventListener('submit', async e => {
  e.preventDefault();
  if (crossed(draftLimits())) return;
  const next = { ...limits, [pair]: draftLimits() };
  $('form-status').textContent = 'Saving…';
  try {
    ({ limits } = await getJSON('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limits: next }),
    }));
    closeSheet();
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
