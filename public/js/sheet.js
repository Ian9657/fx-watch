// The settings sheet: number wheels for the floor and ceiling. While it's
// open the dial previews the draft, so you can see where a new floor or
// ceiling would sit before saving.
import { $, SIDES, state, getJSON, Locked, lock, draftLimits, crossed, pressable, sound, haptic } from './shared.js';
import { render } from './dial.js';

// Each wheel is a drum with the ten digits round its rim. Its position is
// counted in notches and never wraps, so 9 → 0 keeps turning forward; the
// digit showing is that count mod 10.
const wheels = { floor: [], ceiling: [] };
const NOTCH = 24;                                          // px of drag per notch
const STEP = 36;                                           // degrees per digit
const RADIUS = 16 / Math.tan((STEP / 2) * Math.PI / 180); // a 32px face per digit
const mod10 = n => ((n % 10) + 10) % 10;

// Turn the drum to a position, either at once (following a finger) or
// settling onto it with a small overshoot, like a detent dropping home.
function place(wheel, pos, settle) {
  wheel.pos = pos;
  wheel.drum.style.transitionDelay = '';
  wheel.drum.classList.toggle('settle', settle);
  wheel.drum.style.transform = `translateZ(${-RADIUS}px) rotateX(${pos * STEP}deg)`;
}

// The digit showing changed: update the draft (and the dial's preview).
function commit(side, i, wheel) {
  const { draft } = state;
  const digit = String(mod10(Math.round(wheel.pos)));
  const chars = [...draft[side].text];
  if (chars[i] === digit) return;
  chars[i] = digit;
  draft[side].text = chars.join('');
  wheel.el.setAttribute('aria-valuenow', digit);
  if (!draft[side].on) toggleSide(side);
  sheetChanged();
}

function nudge(side, i, delta) {
  const wheel = wheels[side][i];
  cancelAnimationFrame(wheel.spin);
  place(wheel, Math.round(wheel.pos) + delta, true);
  sound('tick');
  haptic(4);
  commit(side, i, wheel);
}

// Drag up to turn a wheel forward, down to turn it back; it follows the
// finger and ticks at each notch. A quick flick carries on with momentum,
// slowing as it goes (at most one turn); a new touch stops it. A tap on the
// top half adds one, on the bottom half takes one away.
function makeWheel(side, i, digit) {
  const el = document.createElement('div');
  el.className = 'wheel';
  el.tabIndex = 0;
  el.setAttribute('role', 'spinbutton');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '9');
  el.setAttribute('aria-valuenow', digit);
  el.setAttribute('aria-label', `${side} digit ${i + 1}`);
  const drum = document.createElement('div');
  drum.className = 'drum';
  drum.append(...Array.from({ length: 10 }, (_, n) => {
    const face = Object.assign(document.createElement('span'), { textContent: n });
    face.style.transform = `rotateX(${-n * STEP}deg) translateZ(${RADIUS}px)`;
    return face;
  }));
  el.append(drum);
  const wheel = wheels[side][i] = { el, drum, pos: 0, spin: 0 };
  place(wheel, Number(digit), false);

  let startY = 0, startPos = 0, moved = false, track = [], notch = 0;
  // Follow to a new position, ticking for each notch crossed.
  const follow = (pos, speed = 0) => {
    place(wheel, pos, false);
    const n = Math.round(pos);
    if (n === notch) return;
    notch = n;
    sound('tick', speed > 1.5 ? 0.6 : 1);
    haptic(4);
    commit(side, i, wheel);
  };
  el.addEventListener('pointerdown', e => {
    cancelAnimationFrame(wheel.spin);
    el.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startPos = wheel.pos;
    notch = Math.round(wheel.pos);
    moved = false;
    track = [{ y: e.clientY, t: e.timeStamp }];
    place(wheel, wheel.pos, false); // stop any settling where it is
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientY - startY) > 6) moved = true;
    track.push({ y: e.clientY, t: e.timeStamp });
    if (moved) follow(startPos + (startY - e.clientY) / NOTCH);
  });
  el.addEventListener('pointerup', e => {
    if (!moved) {
      const box = el.getBoundingClientRect();
      return nudge(side, i, e.clientY < box.top + box.height / 2 ? 1 : -1);
    }
    // Speed over the last 80ms, upward positive, in notches per ms.
    const recent = track.filter(p => e.timeStamp - p.t < 80);
    let v = recent.length < 2 ? 0
      : (recent[0].y - recent.at(-1).y) / Math.max(1, recent.at(-1).t - recent[0].t) / NOTCH;
    if (Math.abs(v) < 0.3 / NOTCH) return place(wheel, Math.round(wheel.pos), true);
    const limit = wheel.pos + Math.sign(v) * 10;
    let then = performance.now();
    const step = now => {
      const dt = now - then;
      then = now;
      let pos = wheel.pos + v * dt;
      v *= Math.exp(-dt / 220); // friction
      const done = Math.abs(v) < 0.05 / NOTCH || Math.sign(v) * (pos - limit) >= 0;
      if (done) pos = Math.sign(v) > 0 ? Math.min(pos, limit) : Math.max(pos, limit);
      follow(pos, Math.abs(v) * 1000);
      if (done) place(wheel, Math.round(pos), true);
      else wheel.spin = requestAnimationFrame(step);
    };
    wheel.spin = requestAnimationFrame(step);
  });
  el.addEventListener('pointercancel', () => place(wheel, Math.round(wheel.pos), true));
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { e.preventDefault(); nudge(side, i, 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); nudge(side, i, -1); }
  });
  return el;
}

// Set a side's wheels to a whole value (e.g. the current price), turning
// that side on if it was off.
function setSide(side, text) {
  const { draft } = state;
  draft[side].text = text;
  // Each drum rolls forward to its new digit, the right-hand ones a beat
  // later, like a counter being reset.
  [...text].forEach((ch, i) => {
    const wheel = wheels[side][i];
    if (!wheel || ch === '.') return;
    cancelAnimationFrame(wheel.spin);
    const ahead = mod10(Number(ch) - Math.round(wheel.pos));
    place(wheel, Math.round(wheel.pos) + ahead, true);
    wheel.drum.style.transitionDelay = `${i * 40}ms`;
    wheel.el.setAttribute('aria-valuenow', ch);
  });
  sound('tick');
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
for (const side of SIDES) {
  pressable($(`toggle-${side}`), () => haptic(8));
  $(`toggle-${side}`).addEventListener('click', () => { sound('clack'); toggleSide(side); });
}
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
