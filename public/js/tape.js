// The ticker tape across the top.
import { $, PAIRS, state, time } from './shared.js';

// The tape leads with the live quote when it's newer than the last recorded
// one, then the recorded quotes, for the currency on the dial. Arrows
// compare each line with the one after.
let tapeKey = '';
export function drawTape() {
  const { rates, tape, pair } = state;
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
