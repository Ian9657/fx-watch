// The settings sheet: number wheels for the floor and ceiling. While it's
// open the dial previews the draft, so you can see where a new floor or
// ceiling would sit before saving.
import { $, SIDES, state, getJSON, Locked, lock, draftLimits, crossed, pressable } from './shared.js';
import { render } from './dial.js';

const wheelCols = { floor: [], ceiling: [] };
const DIGIT_H = 32;
const colOffset = d => `translateY(${12 - d * DIGIT_H}px)`;

function setDigit(side, i, delta) {
  const { draft } = state;
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

  // Each 24px of travel is one click of the wheel. A quick flick carries on
  // with momentum, slowing as it goes (at most one turn); a new touch stops it.
  let startY = 0, lastY = 0, moved = false, spin = 0, track = [];
  const click = delta => { setDigit(side, i, delta); navigator.vibrate?.(4); };
  el.addEventListener('pointerdown', e => {
    cancelAnimationFrame(spin);
    el.setPointerCapture(e.pointerId);
    startY = lastY = e.clientY;
    moved = false;
    track = [{ y: e.clientY, t: e.timeStamp }];
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientY - startY) > 6) moved = true;
    track.push({ y: e.clientY, t: e.timeStamp });
    while (lastY - e.clientY >= 24) { click(1); lastY -= 24; }
    while (e.clientY - lastY >= 24) { click(-1); lastY += 24; }
  });
  el.addEventListener('pointerup', e => {
    if (!moved) {
      const box = el.getBoundingClientRect();
      return click(e.clientY < box.top + box.height / 2 ? 1 : -1);
    }
    // Speed over the last 80ms, upward positive, in px per ms.
    const recent = track.filter(p => e.timeStamp - p.t < 80);
    if (recent.length < 2) return;
    let v = (recent[0].y - recent.at(-1).y) / Math.max(1, recent.at(-1).t - recent[0].t);
    if (Math.abs(v) < 0.3) return;
    let carried = 0, clicks = 0, then = performance.now();
    const step = now => {
      const dt = now - then;
      then = now;
      carried += v * dt;
      v *= Math.exp(-dt / 220); // friction
      while (Math.abs(carried) >= 24 && clicks < 10) { click(Math.sign(carried)); carried -= 24 * Math.sign(carried); clicks++; }
      if (Math.abs(v) > 0.05 && clicks < 10) spin = requestAnimationFrame(step);
    };
    spin = requestAnimationFrame(step);
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { e.preventDefault(); setDigit(side, i, 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setDigit(side, i, -1); }
  });
  return el;
}

// Set a side's wheels to a whole value (e.g. the current price), turning
// that side on if it was off.
function setSide(side, text) {
  const { draft } = state;
  draft[side].text = text;
  [...text].forEach((ch, i) => {
    const wheel = wheelCols[side][i];
    if (!wheel || ch === '.') return;
    wheel.col.style.transform = colOffset(Number(ch));
    wheel.el.setAttribute('aria-valuenow', ch);
  });
  if (!draft[side].on) toggleSide(side);
  else sheetChanged();
}

function toggleSide(side) {
  const { draft } = state;
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
  const { pair, rates, limits } = state;
  // A limit that's off starts from the current price, ready to dial in.
  const start = (rates[pair]?.price ?? 1).toFixed(4);
  const draft = state.draft = Object.fromEntries(SIDES.map(side => {
    const v = limits[pair][side];
    return [side, { on: v != null, text: v != null ? v.toFixed(4) : start }];
  }));
  $('sheet-title').textContent = `SET ${pair} LIMITS`;
  $('sheet-now').textContent = rates[pair] ? `NOW ${rates[pair].price.toFixed(4)}` : '';
  for (const side of SIDES) {
    $(`wheels-${side}`).replaceChildren(...[...draft[side].text].map((ch, i) => {
      if (ch === '.') return Object.assign(document.createElement('span'), { className: 'wheel-dot' });
      return makeWheel(side, i, ch);
    }));
    draft[side].on = !draft[side].on; // toggleSide flips it back and syncs the button
    toggleSide(side);
  }
  clearTimeout(closing);
  $('sheet-backdrop').classList.remove('closing');
  $('settings').classList.remove('closing', 'dragging', 'settling');
  $('settings').style.transform = '';
  $('sheet-backdrop').hidden = false;
  $('settings').hidden = false;
  liftWatch();
  $('wheels-floor').querySelector('.wheel').focus({ preventScroll: true });
}

// While the sheet is open the watch rises (and shrinks if it must) to sit
// whole in the space above it, bright over the dimmed page, so the dial's
// live preview of the draft is in full view. It eases back as the sheet goes.
function liftWatch() {
  const gauge = $('gauge');
  // Where the sheet will come to rest (it's still sliding in), and the
  // space above it, clear of the status bar.
  const sheetTop = innerHeight - $('settings').offsetHeight;
  const statusBar = Math.max(0, parseFloat(getComputedStyle(document.querySelector('main')).paddingTop) - 26);
  const margin = 14, above = statusBar + margin, below = sheetTop - margin;
  // The watch from the top of its bow to the bottom of its case.
  const top = gauge.querySelector('.crown').getBoundingClientRect().top;
  const height = $('case').getBoundingClientRect().bottom - top;
  const scale = Math.min(1, (below - above) / height);
  // Scaling is about the top of the gauge, so the bow's offset scales too;
  // then move it to sit centred in the space.
  const gaugeTop = gauge.getBoundingClientRect().top;
  const scaledTop = gaugeTop + (top - gaugeTop) * scale;
  const wantTop = above + (below - above - height * scale) / 2;
  gauge.classList.remove('lowering');
  gauge.classList.add('lifted');
  gauge.style.setProperty('--lift-y', `${(wantTop - scaledTop).toFixed(1)}px`);
  gauge.style.setProperty('--lift-s', scale.toFixed(3));
}
function lowerWatch() {
  const gauge = $('gauge');
  gauge.classList.add('lowering');
  gauge.style.removeProperty('--lift-y');
  gauge.style.removeProperty('--lift-s');
}

// Out: the sheet slides down (from wherever a pull left it) as the
// backdrop fades, then both hide, ready to slide up afresh next time.
const quiet = matchMedia('(prefers-reduced-motion: reduce)');
let closing = 0;
function closeSheet() {
  if (!state.draft) return;
  state.draft = null;
  render(); // the dial drops the draft at once
  lowerWatch();
  const sheet = $('settings'), backdrop = $('sheet-backdrop');
  const done = () => {
    sheet.hidden = backdrop.hidden = true;
    $('gauge').classList.remove('lifted', 'lowering');
    sheet.classList.remove('dragging', 'settling', 'closing');
    backdrop.classList.remove('closing');
    sheet.style.transform = '';
    $('toggle-settings').focus({ preventScroll: true });
  };
  if (quiet.matches) return done();
  sheet.classList.remove('settling');
  sheet.classList.add('closing');
  backdrop.classList.add('closing');
  void sheet.offsetHeight; // start the slide from where the sheet is now
  sheet.style.transform = `translate(-50%, ${sheet.offsetHeight + 20}px)`;
  clearTimeout(closing);
  closing = setTimeout(done, 280);
}

// Pull down by the top of the sheet to close it, as phone sheets do: it
// follows the finger, closes past 80px or on a quick flick, and springs
// back otherwise. The wheels keep their own up-and-down drags.
let pull = null;
const sheet = $('settings');
const moveSheet = y => { sheet.style.transform = `translate(-50%, ${Math.max(0, y)}px)`; };
for (const handle of [sheet.querySelector('.sheet-grip'), sheet.querySelector('.sheet-head')]) {
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return; // the × is a button, not a handle
    pull = { y: e.clientY, t: Date.now() };
    handle.setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
    sheet.classList.remove('settling');
  });
  handle.addEventListener('pointermove', e => { if (pull) moveSheet(e.clientY - pull.y); });
  const release = e => {
    if (!pull) return;
    const dy = e.clientY - pull.y, fast = dy > 30 && dy / (Date.now() - pull.t) > 0.3;
    pull = null;
    sheet.classList.add('settling');
    if (dy > 80 || fast) {
      closeSheet();
    } else {
      // Spring back; .dragging stays on so the opening slide doesn't replay.
      moveSheet(0);
      setTimeout(() => { sheet.classList.remove('settling'); sheet.style.transform = ''; }, 220);
    }
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
}

$('toggle-settings').addEventListener('click', openSheet);
// "Set to now": dial a side straight to the current price.
for (const side of SIDES) {
  const button = $(`now-${side}`);
  pressable(button);
  button.addEventListener('click', () => {
    const price = state.rates[state.pair]?.price;
    if (price) setSide(side, price.toFixed(4));
  });
}

pressable($('sheet-close'));
pressable($('test'));
$('sheet-close').addEventListener('click', closeSheet);
$('sheet-backdrop').addEventListener('click', closeSheet);
$('toggle-floor').addEventListener('click', () => toggleSide('floor'));
$('toggle-ceiling').addEventListener('click', () => toggleSide('ceiling'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.draft) closeSheet(); });

$('settings').addEventListener('submit', async e => {
  e.preventDefault();
  if (crossed(draftLimits())) return;
  const next = { ...state.limits, [state.pair]: draftLimits() };
  $('form-status').textContent = 'Saving…';
  try {
    ({ limits: state.limits } = await getJSON('/api/settings', {
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
