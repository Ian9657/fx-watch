const $ = id => document.getElementById(id);
const PAIRS = ['GBP', 'USD'];

const store = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
  remove: key => { try { localStorage.removeItem(key); } catch {} },
};

let rates = {};
const SIDES = ['floor', 'ceiling'];
let limits = { GBP: { floor: null, ceiling: null }, USD: { floor: null, ceiling: null } };

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
    const r = rates[p];
    const { floor, ceiling } = limits[p];
    $(`rate-${p}`).textContent = r ? r.price.toFixed(4) : '—';
    $(`quoted-${p}`).textContent = r ? `Quoted ${new Date(r.time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
    if (r?.previousClose) {
      const diff = r.price - r.previousClose;
      const pct = (diff / r.previousClose) * 100;
      $(`change-${p}`).textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(4)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      $(`change-${p}`).className = `change ${diff >= 0 ? 'up' : 'down'}`;
    }
    const below = r && floor != null && r.price < floor;
    const above = r && ceiling != null && r.price > ceiling;
    $(`limits-${p}`).textContent =
      floor != null && ceiling != null ? `${floor.toFixed(4)} – ${ceiling.toFixed(4)}`
      : floor != null ? `Floor ${floor.toFixed(4)}`
      : ceiling != null ? `Ceiling ${ceiling.toFixed(4)}`
      : 'No alerts';
    $(`state-${p}`).textContent = below ? 'Below floor' : above ? 'Above ceiling' : '';
    card.classList.toggle('below', !!below);
    card.classList.toggle('above', !!above);
  }
}

async function loadRates() {
  try {
    rates = await getJSON('/api/rates', { cache: 'no-store' });
    showError('');
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (err) {
    showError(`Couldn't load rates: ${err.message}`);
  }
  renderCards();
}

async function loadSettings() {
  try {
    ({ limits } = await getJSON('/api/settings', { cache: 'no-store' }));
    for (const p of PAIRS) for (const side of SIDES) $(`${side}-${p}`).value = limits[p][side] ?? '';
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

$('limits').addEventListener('submit', async e => {
  e.preventDefault();
  const next = {};
  for (const p of PAIRS) {
    next[p] = {};
    for (const side of SIDES) {
      const raw = $(`${side}-${p}`).value.trim();
      next[p][side] = raw === '' ? null : Number(raw);
    }
  }
  $('form-status').textContent = 'Saving…';
  try {
    ({ limits } = await authed('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limits: next }),
    }));
    $('form-status').textContent = 'Saved.';
    renderCards();
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

let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  $('refresh').disabled = true;
  await Promise.all([loadSettings(), loadRates()]);
  $('refresh').disabled = false;
  refreshing = false;
}

$('refresh').addEventListener('click', refreshAll);

// Home-screen apps have no reload button and iOS freezes them in the
// background, so refresh on a timer and whenever the app comes back.
setInterval(() => { if (!document.hidden) loadRates(); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
window.addEventListener('pageshow', e => { if (e.persisted) refreshAll(); });
window.addEventListener('focus', refreshAll);

refreshAll();
