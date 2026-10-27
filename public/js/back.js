// The back of the watch: a round chart of the recorded price, the bezel
// that sets its time span, and turning the watch over.
import { $, PAIRS, store, state, getJSON, Locked, limitsFor, position } from './shared.js';

// ---- Chart ---------------------------------------------------------------
// A circular chart recorder: the paper turns once per span, the pen sits at
// the top on the latest quote, and the trace runs clockwise from just past
// the top round to it. Further out is a higher price. The floor and ceiling
// are rings in the dial's band colours. A gap of over two hours with no
// quote breaks the trace.
let history = [];  // [t, GBP, USD] rows the Worker has recorded, oldest first
let historyAt = 0; // when history was last loaded (epoch ms)
const SPANS = [1, 7, 30, 90]; // days, shown one at a time in the bezel's window
let days = SPANS.includes(Number(store.get('chartDays'))) ? Number(store.get('chartDays')) : 7;
const HOUR = 3600, DAY = 86400, GAP = 2 * HOUR;
const local = t => new Date(t * 1000); // days and hours are this device's, like every time on the page
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const spanWords = d => d === 1 ? '24 hours' : `${d} days`;

export async function loadHistory() {
  if (Date.now() - historyAt < 10 * 60_000) return; // it only grows every 10 minutes
  try {
    ({ history } = await getJSON('/api/history'));
    historyAt = Date.now();
  } catch (err) {
    if (err instanceof Locked) throw err; // otherwise keep the last chart
  }
}

// Ruling for each span: a candidate spoke every `hours` from local
// midnight, kept if `minor` or `major` says so; majors are darker and
// labelled. Stepping by the clock, not by seconds, keeps spokes on the hour
// across a change to or from summer time.
const RULING = {
  1: { hours: 1, minor: () => true, major: d => d.getHours() % 6 === 0, label: d => String(d.getHours()).padStart(2, '0') },
  7: { hours: 6, minor: () => true, major: d => d.getHours() === 0, label: d => WEEKDAYS[d.getDay()], centred: true },
  30: { hours: 24, minor: () => true, major: d => d.getDay() === 1, label: d => `${d.getDate()} ${MONTHS[d.getMonth()]}` },
  90: { hours: 24, minor: d => d.getDay() === 1, major: d => d.getDate() === 1, label: d => MONTHS[d.getMonth()] },
};

const C = 170, R_IN = 44, R_OUT = 114, R_LABEL = 124, R_TRACK = 135; // centre and radii, back-face units

const polar = (r, deg) => {
  const a = deg * Math.PI / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};
// An annulus between two radii, to catch the pointer on the bezel.
const annulus = (r0, r1) => `M${C},${C - r1}a${r1},${r1} 0 1 0 0.01,0ZM${C},${C - r0}a${r0},${r0} 0 1 1 -0.01,0Z`;

export function drawChart() {
  const { pair } = state;
  const col = PAIRS.indexOf(pair) + 1;
  const t1 = Date.now() / 1000, t0 = t1 - days * DAY;
  // Time runs clockwise from 10° past the top round to the pen at the top.
  const A = t => 10 + 350 * (t - t0) / (t1 - t0);
  let rows = history.filter(r => r[0] >= t0 && r[col] != null);
  // At most about one point per 0.4°; 90 days holds ~13,000 quotes.
  const every = Math.ceil(rows.length / 900);
  if (every > 1) rows = rows.filter((r, i) => i % every === 0 || i === rows.length - 1);
  const out = [];

  // A track of ticks round the paper's edge, like the front's: one per step
  // of the span, the majors longer and heavier, with a faint spoke inward.
  const rule = RULING[days];
  const majors = [];
  out.push(`<circle class="track" cx="${C}" cy="${C}" r="${R_TRACK}"/>`);
  const d = local(t0);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() / 1000 <= t1; d.setHours(d.getHours() + rule.hours)) {
    const t = d.getTime() / 1000;
    if (t < t0) continue;
    const major = rule.major(d), deg = A(t);
    const [x0, y0] = polar(R_TRACK, deg), [x1, y1] = polar(R_TRACK + (major ? 7 : 3.5), deg);
    out.push(`<line class="tick${major ? ' major' : ''}" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`);
    if (major) {
      majors.push(t);
      const [sx, sy] = polar(R_IN + 4, deg), [ex, ey] = polar(R_OUT, deg);
      out.push(`<line class="spoke" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"/>`);
    }
  }
  for (const t of majors) {
    const deg = rule.centred ? A(Math.min(t + DAY / 2, t1)) : A(t);
    if (deg < 22 || deg > 340) continue; // leave the top to START and NOW
    const [x, y] = polar(R_LABEL, deg);
    out.push(`<text class="tick-label" x="${x}" y="${y}">${rule.label(local(t))}</text>`);
  }
  // Price runs outward on the same scale as the front: the floor ring always
  // at 0.3 and the ceiling ring at 0.7, so the chart looks the same for
  // either currency; a price past the scale runs along its edge. A side with
  // no limit keeps its ring, faint and marked OFF, like the front's band.
  const { floor, ceiling } = limitsFor(pair);
  const R = pos => R_IN + pos * (R_OUT - R_IN);
  out.push(`<circle class="ring" cx="${C}" cy="${C}" r="${R(0.5)}"/>`);
  for (const [side, v, pos] of [['floor', floor, 0.3], ['ceiling', ceiling, 0.7]]) {
    // Each ring is named at its foot, so it doesn't rely on colour alone.
    const name = (side === 'floor' ? 'FLOOR' : 'CEILING') + (v == null ? ' OFF' : '');
    out.push(`<circle class="limit ${side}${v == null ? ' unset' : ''}" cx="${C}" cy="${C}" r="${R(pos)}"/>`);
    out.push(`<text class="limit-name ${side}${v == null ? ' unset' : ''}" x="${C}" y="${C + R(pos) + 2}">${name}</text>`);
  }
  // The seam at the top: the trace starts just right of it and ends at the
  // pen just left of it.
  out.push(`<line class="seam" x1="${C}" y1="${C - R_IN - 6}" x2="${C}" y2="${C - R_TRACK}"/>`);
  out.push(`<text class="seam-label" x="${C - 5}" y="${C - R_LABEL + 3}" text-anchor="end">NOW</text>`);
  out.push(`<text class="seam-label" x="${C + 5}" y="${C - R_LABEL + 3}" text-anchor="start">START ▸</text>`);

  const spanName = days === 1 ? '24 HOURS' : `${days} DAYS`;
  let change = '—', since = '';
  if (rows.length) {
    const prices = rows.map(r => r[col]);
    const ref = prices.at(-1); // centres the scale when no limit is set
    const Rv = v => R(position(v, floor, ceiling, ref));
    // Thinned rows sit `every` quotes apart, so only a longer pause is a gap.
    const gapAfter = Math.max(GAP, every * 600 * 2);
    let d = '';
    rows.forEach((r, i) => {
      const gap = i === 0 || r[0] - rows[i - 1][0] > gapAfter;
      const [x, y] = polar(Rv(r[col]), A(r[0]));
      d += `${gap ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    out.push(`<path class="ink" d="${d}"/>`);
    const pct = (prices.at(-1) - prices[0]) / prices[0] * 100;
    change = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%`;
    // Recording began after the span's start: say when, as the change is
    // only over that part.
    if (rows[0][0] - t0 > GAP) since = `SINCE ${local(rows[0][0]).getDate()} ${MONTHS[local(rows[0][0]).getMonth()]}`;
    // The pen: a brass pointer, like the markers on the front, on the
    // latest point.
    const pr = Rv(prices.at(-1)), pd = A(rows.at(-1)[0]);
    const [px, py] = polar(pr, pd), [ax, ay] = polar(pr + 9, pd - 3.2), [bx, by] = polar(pr + 9, pd + 3.2);
    out.push(`<circle class="nib" cx="${px}" cy="${py}" r="2.2"/>`);
    out.push(`<path class="pen" d="M${px},${py - 2.5}L${ax},${ay}L${bx},${by}Z"/>`);
    const reading = `${pair} over the last ${spanWords(days)}: ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(2)}%.`;
    $('case').setAttribute('aria-label', `${reading} Arrow keys change the span.`);
    $('back-live').textContent = turned() ? reading : '';
  }
  // The hub: the span and the change across it, the key reading.
  out.push(`<circle class="hub" cx="${C}" cy="${C}" r="${R_IN - 5}"/>`);
  out.push(`<text class="hub-span" x="${C}" y="${C - 6}">${spanName}</text>`);
  out.push(`<text class="hub-change" x="${C}" y="${C + 13}">${change}</text>`);
  if (since) out.push(`<text class="hub-since" x="${C}" y="${C + 25}">${since}</text>`);
  $('polar').innerHTML = out.join('');
}

// ---- Span selector: a turning bezel --------------------------------------
// Under the bezel is a disc printed 24H, 7D, 30D and 90D a quarter apart,
// shown one at a time through a window at twelve, like a date window. The
// bezel turns anticlockwise only, like a diving bezel, in 120 clicks a turn.
// Tap the bezel to turn it on a quarter, or drag it round and let go to snap.
const R_BEZEL_IN = 147.5, R_BEZEL_OUT = 162, CLICK = 3; // degrees per click
let bezelDeg = -SPANS.indexOf(days) * 90;

function drawSelector() {
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const deg = i * 6, long = i % 5 === 0;
    const [x0, y0] = polar(R_BEZEL_OUT - 2.5, deg), [x1, y1] = polar(R_BEZEL_OUT - (long ? 8 : 5), deg);
    return `<line class="bezel-tick" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
  }).join('');
  // The spans are printed on a disc under the bezel, like a date disc; only
  // the one under the window at twelve shows.
  const R_DISC = (R_BEZEL_IN + R_BEZEL_OUT) / 2;
  const marks = SPANS.map((s, i) => {
    const [x, y] = polar(R_DISC, i * 90);
    return `<text class="bezel-mark" x="${x}" y="${y + .5}" transform="rotate(${i * 90} ${x} ${y})">${s === 1 ? '24H' : `${s}D`}</text>`;
  }).join('');
  const w = 30, h = 13, wx = C - w / 2, wy = C - R_DISC - h / 2;
  $('bezel').innerHTML =
    `<circle class="bezel-edge" cx="${C}" cy="${C}" r="${R_BEZEL_IN}"/>` +
    `<g id="bezel-turn" class="bezel-grip">` +
      // An invisible ring to catch the pointer anywhere on the bezel.
      `<path fill="transparent" fill-rule="evenodd" d="${annulus(R_BEZEL_IN, R_BEZEL_OUT)}"/>` +
      ticks +
    `</g>` +
    // The window: a rim like the digit window's, cream behind, and the
    // disc's lettering passing through it as the bezel turns.
    `<clipPath id="span-window"><rect x="${wx}" y="${wy}" width="${w}" height="${h}" rx="1.5"/></clipPath>` +
    `<rect class="span-window" x="${wx}" y="${wy}" width="${w}" height="${h}" rx="1.5"/>` +
    `<g clip-path="url(#span-window)"><g id="bezel-disc">${marks}</g></g>` +
    `<rect class="span-window-shade" x="${wx}" y="${wy}" width="${w}" height="${h}" rx="1.5"/>` +
    `<rect class="span-window-rim" x="${wx - 1.6}" y="${wy - 1.6}" width="${w + 3.2}" height="${h + 3.2}" rx="2.4"/>`;
  turnBezel(bezelDeg);
}
function turnBezel(deg) {
  for (const id of ['bezel-turn', 'bezel-disc']) $(id).setAttribute('transform', `rotate(${deg.toFixed(2)} ${C} ${C})`);
}
// Bezel angle (clockwise from the top) and distance from the centre of a
// pointer, in back-face units; the back faces us when turned over.
function onBack(e) {
  const box = $('case').getBoundingClientRect();
  const x = (e.clientX - box.left) / box.width * 340 - C, y = (e.clientY - box.top) / box.height * 340 - C;
  return { deg: (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360, r: Math.hypot(x, y), x: x / C, y: y / C };
}
const quiet = matchMedia('(prefers-reduced-motion: reduce)');
const clickOf = deg => Math.round(deg / CLICK) * CLICK;
let turning = 0;
// Turn the bezel to `target` (a whole quarter), click by click, and show
// the span that lands in the window.
function settleBezel(target) {
  const from = bezelDeg, delta = target - from;
  const span = SPANS[((-target / 90) % 4 + 4) % 4];
  if (span !== days) {
    days = span;
    store.set('chartDays', days);
    drawChart();
    navigator.vibrate?.(6);
  }
  cancelAnimationFrame(turning);
  if (quiet.matches || !delta) { bezelDeg = target; return turnBezel(bezelDeg); }
  const start = performance.now(), ms = 120 + Math.abs(delta) * 3.2;
  const step = now => {
    const k = Math.min(1, (now - start) / ms);
    bezelDeg = from + delta * (1 - (1 - k) ** 3);
    turnBezel(k < 1 ? clickOf(bezelDeg) : target);
    if (k < 1) turning = requestAnimationFrame(step);
    else bezelDeg = target;
  };
  turning = requestAnimationFrame(step);
}
// The glass's light follows the pointer a little, as if the watch were
// tipped towards it (after pokemon-cards-css).
function tilt(e) {
  const { x, y } = onBack(e), glass = document.querySelector('#b-glass');
  glass.setAttribute('cx', (.28 + x * .12).toFixed(3));
  glass.setAttribute('cy', (.2 + y * .12).toFixed(3));
}

// ---- Turning the watch over -----------------------------------------------
// Tap or swipe the case to turn it over; on the back, the bezel turns. The
// crown still winds (refreshes) on either side.
let swiped = false, swipeX = null, dragging = false;
// The hint under the watch shows until you've turned it once, and always
// on the back, so the way back is never a guess.
function turnOver() {
  const over = $('case').classList.toggle('over');
  if (over) {
    drawChart();
    loadHistory().then(drawChart, () => {}); // a lock shows on the next refresh
  }
  store.set('turned', '1');
  $('turn-hint').textContent = over ? 'TAP THE CHART TO TURN BACK' : 'TAP THE WATCH TO TURN IT OVER';
  $('turn-hint').classList.toggle('still', over);
  $('turn-hint').hidden = !over;
}
export const turned = () => $('case').classList.contains('over');
let grabDeg = 0, grabBezel = 0, moved = false;
$('case').addEventListener('pointerdown', e => {
  swiped = false;
  if (turned() && onBack(e).r > 145) {
    // On the bezel: it follows the pointer, but only anticlockwise.
    dragging = true;
    moved = false;
    grabDeg = onBack(e).deg;
    grabBezel = bezelDeg;
    $('case').setPointerCapture(e.pointerId);
    cancelAnimationFrame(turning);
    return;
  }
  swipeX = e.clientX;
});
$('case').addEventListener('pointermove', e => {
  if (!turned()) return;
  if (!quiet.matches) tilt(e);
  if (!dragging) return;
  const turn = ((onBack(e).deg - grabDeg + 540) % 360) - 180;
  if (Math.abs(turn) > 2) moved = true;
  bezelDeg = grabBezel + Math.min(0, turn);
  turnBezel(clickOf(bezelDeg));
});
$('case').addEventListener('pointerup', e => {
  if (dragging) {
    dragging = false;
    swiped = true; // not a tap to turn over
    // A tap turns on a quarter; a drag snaps to the nearest quarter behind it.
    settleBezel(moved ? Math.round(bezelDeg / 90) * 90 : Math.round(bezelDeg / 90) * 90 - 90);
    return;
  }
  if (swipeX != null && Math.abs(e.clientX - swipeX) > 40) { swiped = true; turnOver(); }
  swipeX = null;
});
$('case').addEventListener('click', () => {
  if (!swiped) turnOver();
});
// Keys: Enter or Space turns the watch over; on the back, the arrows turn
// the bezel on to the next span, or round to the previous one (it only
// turns one way, like the real thing).
$('case').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); turnOver(); return; }
  if (!turned()) return;
  const quarters = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: 3, ArrowUp: 3 }[e.key];
  if (!quarters) return;
  e.preventDefault();
  settleBezel(Math.round(bezelDeg / 90) * 90 - 90 * quarters);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && turned() && !state.draft) turnOver(); });
$('turn-hint').hidden = !!store.get('turned');
drawSelector();
