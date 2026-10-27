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
  $('wheels-floor').querySelector('.wheel').focus({ preventScroll: true });
}

// Out: the sheet slides down (from wherever a pull left it) as the
// backdrop fades, then both hide, ready to slide up afresh next time.
const quiet = matchMedia('(prefers-reduced-motion: reduce)');
let closing = 0;
function closeSheet() {
  if (!state.draft) return;
  state.draft = null;
  render(); // the dial drops the draft at once
  const sheet = $('settings'), backdrop = $('sheet-backdrop');
  const done = () => {
    sheet.hidden = backdrop.hidden = true;
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
