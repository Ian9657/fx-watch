const $ = id => document.getElementById(id);
const PAIRS = ['GBP', 'USD'];

const store = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
  remove: key => { try { localStorage.removeItem(key); } catch {} },
};

let pair = store.get('pair') || 'GBP';
let range = store.get('range') || '1mo';
let rates = {};
let floors = { GBP: null, USD: null };

async function getJSON(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}

function showError(message) {
  $('error').hidden = !message;
  $('error').textContent = message || '';
}

function renderCards() {
  for (const p of PAIRS) {
    const card = document.querySelector(`[data-pair="${p}"]`);
    card.setAttribute('aria-pressed', String(p === pair));
    const r = rates[p];
    const floor = floors[p];
    $(`rate-${p}`).textContent = r ? r.price.toFixed(4) : '—';
    if (r?.previousClose) {
      const diff = r.price - r.previousClose;
      const pct = (diff / r.previousClose) * 100;
      $(`change-${p}`).textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(4)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      $(`change-${p}`).className = `change ${diff >= 0 ? 'up' : 'down'}`;
    }
    const below = r && floor != null && r.price < floor;
    $(`floor-${p}`).textContent = floor == null ? 'No floor' : `Floor ${floor.toFixed(4)}${below ? ' · below' : ''}`;
    card.classList.toggle('below', !!below);
  }
}

function renderChart(points) {
  const box = $('chart');
  box.replaceChildren();
  if (!points.length) {
    box.textContent = 'No data for this range.';
    return;
  }
  const W = 360, H = 190, L = 4, R = 44, T = 10, B = 22;
  const floor = floors[pair];
  const values = points.map(p => p.rate);
  if (floor != null) values.push(floor);
  let min = Math.min(...values), max = Math.max(...values);
  const pad = Math.max((max - min) * 0.1, 0.002);
  min -= pad; max += pad;
  const x = i => L + (i / Math.max(points.length - 1, 1)) * (W - L - R);
  const y = v => T + ((max - v) / (max - min)) * (H - T - B);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${pair} to CNY chart`);
  const add = (tag, attrs, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text) el.textContent = text;
    svg.append(el);
    return el;
  };

  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    add('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' });
    add('text', { x: W - R + 5, y: y(v) + 4, class: 'axis' }, v.toFixed(3));
  }
  if (floor != null) add('line', { x1: L, x2: W - R, y1: y(floor), y2: y(floor), class: 'floor-line' });
  const line = points.map((p, i) => `${x(i)},${y(p.rate)}`).join(' ');
  add('polyline', { points: line, class: 'line' });

  const fmt = t => new Date(t * 1000).toLocaleDateString('en-GB', range === '1d'
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short' });
  add('text', { x: L, y: H - 6, class: 'axis' }, fmt(points[0].t));
  add('text', { x: W - R, y: H - 6, class: 'axis', 'text-anchor': 'end' }, fmt(points.at(-1).t));
  box.append(svg);
}

async function loadRates() {
  try {
    rates = await getJSON('/api/rates');
    showError('');
    const latest = Math.max(...PAIRS.map(p => rates[p].time));
    $('updated').textContent = `Updated ${new Date(latest * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (err) {
    showError(`Couldn't load rates: ${err.message}`);
  }
  renderCards();
}

async function loadChart() {
  document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
  try {
    renderChart(await getJSON(`/api/history?pair=${pair}&range=${range}`));
  } catch (err) {
    $('chart').textContent = `Couldn't load chart: ${err.message}`;
  }
}

async function loadSettings() {
  try {
    ({ floors } = await getJSON('/api/settings'));
    for (const p of PAIRS) $(`input-${p}`).value = floors[p] ?? '';
  } catch {}
  renderCards();
}

function needPassword() {
  $('password-row').hidden = false;
  $('password').focus();
}

async function authed(url, options) {
  const password = $('password').value || store.get('password');
  if (!password) {
    needPassword();
    throw new Error('Enter your password');
  }
  try {
    const result = await getJSON(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${password}` } });
    store.set('password', password);
    $('password-row').hidden = true;
    $('password').value = '';
    return result;
  } catch (err) {
    if (err.status === 401) {
      store.remove('password');
      needPassword();
    }
    throw err;
  }
}

$('floors').addEventListener('submit', async e => {
  e.preventDefault();
  const next = {};
  for (const p of PAIRS) {
    const raw = $(`input-${p}`).value.trim();
    next[p] = raw === '' ? null : Number(raw);
  }
  $('form-status').textContent = 'Saving…';
  try {
    ({ floors } = await authed('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ floors: next }),
    }));
    $('form-status').textContent = 'Saved.';
    renderCards();
    loadChart();
  } catch (err) {
    $('form-status').textContent = err.message;
  }
});

$('test').addEventListener('click', async () => {
  $('form-status').textContent = 'Sending…';
  try {
    await authed('/api/test', { method: 'POST', headers: {} });
    $('form-status').textContent = 'Sent. Check Telegram.';
  } catch (err) {
    $('form-status').textContent = err.message;
  }
});

document.querySelectorAll('[data-pair]').forEach(b => b.addEventListener('click', () => {
  pair = b.dataset.pair;
  store.set('pair', pair);
  renderCards();
  loadChart();
}));

document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
  range = b.dataset.range;
  store.set('range', range);
  loadChart();
}));

// Refresh every minute while the app is open, and on return from background.
setInterval(() => { if (!document.hidden) loadRates(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRates(); });

loadSettings();
loadRates();
loadChart();
