// The front of the watch: the dial, the digit window, the status line and
// the currency knob.
import { $, PAIRS, store, state, time, limitsFor, span, position, pressable } from './shared.js';
import { drawTape } from './tape.js';
import { drawChart, turned } from './back.js';

const QUOTE_STALE_MIN = 60;  // CITIC normally re-quotes every few minutes
const CHECK_STALE_MIN = 25;  // the alert check runs every 10 minutes
const minutesAgo = ms => (Date.now() - ms) / 60000;

// One line that says whether the prices and the alert check can be trusted.
export function renderStatus() {
  const { rates, feedError, lastGood, lastCheck, woundAt } = state;
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
  // Alerts that can't fire matter more than anything above; with no
  // connection, the saved prices are all there is to go on.
  const { failing, alertError, offlineAt } = state;
  if (offlineAt) {
    level = 'warn';
    text = `OFFLINE · PRICES FROM ${time(new Date(offlineAt))}`;
  } else if (failing) {
    level = 'error';
    text = `ALERT CHECK FAILING · ${failing.count} IN A ROW`;
  } else if (alertError && minutesAgo(alertError.time) < 24 * 60) {
    level = 'error';
    text = `TELEGRAM FAILED AT ${time(new Date(alertError.time))}`;
  }
  if (state.winding) text = 'WINDING…';
  $('refresh').className = `status ${level}${state.winding ? ' winding' : ''}`;
  $('status-text').textContent = text;
  $('refresh').title = failing?.error || alertError?.error || feedError || '';
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
export function buildFace() {
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
// On a change of currency the numbers flip in left to right, like the
// digit window; otherwise they change in place.
let scaleFor = '';
function drawScale(price, { floor, ceiling }) {
  const [lo, hi] = span(price, floor, ceiling);
  const flip = scaleFor && scaleFor !== state.pair;
  scaleFor = state.pair;
  $('scale').replaceChildren(...Array.from({ length: 7 }, (_, k) => {
    const pos = k / 6;
    const [x, y] = point(pos, 98);
    const text = svgEl('text', { x: x.toFixed(1), y: (y + 3).toFixed(1) }, (lo + ((pos - 0.3) / 0.4) * (hi - lo)).toFixed(3));
    if (flip) {
      text.classList.add('flip-in');
      text.style.animationDelay = `${k * 45}ms`;
    }
    return text;
  }));
}

// A side that has alerted stays quiet until the price is back inside its
// limit by the re-arm margin; say so, with the price that re-arms it. Not
// while the sheet is open, since the draft limits are what's on show.
function alertNotes(p) {
  const sent = state.alerted?.[p], { floor, ceiling } = state.limits[p], k = state.rearm;
  if (!sent || state.draft) return [];
  const notes = [];
  if (floor != null && (sent.floor === floor || sent.floor === true)) notes.push(`floor alerted · re-arms above ${(floor * (1 + k)).toFixed(4)}`);
  if (ceiling != null && (sent.ceiling === ceiling || sent.ceiling === true)) notes.push(`ceiling alerted · re-arms below ${(ceiling * (1 - k)).toFixed(4)}`);
  return notes;
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
let shown = ''; // digits currently on the flaps, so only changed ones flip
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

export function render() {
  const { rates, feedError, pair } = state;
  for (const p of PAIRS) {
    // Lamps track every currency, so the one not on the dial still shows its zone.
    const zone = rates[p] && !feedError ? zoneOf(rates[p].price, limitsFor(p)) : '';
    $(`lamp-${p}`).className = `lamp-dot ${zone}`;
    document.querySelector(`.pick[data-pair="${p}"]`).setAttribute('aria-pressed', String(p === pair));
    document.querySelector(`.pick[data-pair="${p}"]`).setAttribute('aria-label', `${p}${zone ? `, ${zone === 'high' ? 'too high' : zone}` : ''}`);
  }
  $('knob').classList.toggle('usd', pair === 'USD');
  $('pair-label').textContent = `CNY PER ${pair}`;

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

    const parts = [...alertNotes(pair), distance(r.price, l)];
    if (r.previousClose) {
      const pct = ((r.price - r.previousClose) / r.previousClose) * 100;
      parts.push(`${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}% today`);
    }
    parts.push(`CITIC quoted ${time(new Date(r.time * 1000))}`);
    $('note').textContent = parts.join(' · ');
    $('gauge').setAttribute('aria-label', `${r.price.toFixed(4)} CNY per ${pair}, ${$('zone').textContent.replaceAll('·', '').trim()}`);
  }
  renderStatus();
  drawTape();
  if (turned()) drawChart(); // the back is redrawn when it's turned to
}

function selectPair(next) {
  if (next === state.pair) return;
  state.pair = next;
  store.set('pair', next);
  render();
}

document.querySelectorAll('.pick').forEach(b => {
  pressable(b);
  b.addEventListener('click', () => selectPair(b.dataset.pair));
});
pressable($('knob'), () => navigator.vibrate?.(6));
$('knob').addEventListener('click', () => selectPair(state.pair === 'GBP' ? 'USD' : 'GBP'));
