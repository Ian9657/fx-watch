// The ticker tape across the top.
import { $, DEMO, REPO, state, time, per } from './shared.js';

// The tape leads with the live quote when it's newer than the last recorded
// one, then the recorded quotes, for the currency on the dial. Arrows
// compare each line with the one after.
let tapeKey = '';
export function drawTape() {
  if (DEMO) return drawText(Array(6).fill('VIEW ON GITHUB   ·'));
  const { rates, tape, pair } = state;
  const live = rates[pair] ? { t: rates[pair].time, [pair]: rates[pair].price } : null;
  // A quote the feed left this currency out of has no line.
  const recorded = tape.filter(q => q[pair] != null);
  const lines = live && (!recorded[0] || live.t > recorded[0].t) ? [live, ...recorded] : recorded;
  const arrow = (now, before) => before == null ? '' : now > before ? ' ▲' : now < before ? ' ▼' : ' =';
  const texts = lines.map((q, i) => `${time(new Date(q.t * 1000))}  ${per(pair)} ${q[pair].toFixed(4)}${arrow(q[pair], lines[i + 1]?.[pair])}   ·`);
  if (lines.length < 4) texts.push('RECORDING A QUOTE EVERY 10 MINUTES   ·');
  // Each half of the loop must be wider than the screen, or a gap shows.
  while (texts.length < 4) texts.push(...texts);
  drawText(texts);
}

function drawText(texts) {
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

// In the demo the tape is a link to the code.
if (DEMO) {
  const tape = document.querySelector('.tape');
  tape.classList.add('linked');
  tape.setAttribute('role', 'link');
  tape.setAttribute('tabindex', '0');
  tape.setAttribute('aria-label', 'View on GitHub');
  const go = () => { location.href = REPO; };
  tape.addEventListener('click', go);
  tape.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}
