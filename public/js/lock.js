// The lock screen: the real watch, in its place on the page, with a plain
// spun plate shut inside its rim, a padlock and two words cut into it in the
// same style as the dial's own engraving. Only the plate moves, so the rim
// is the watch's own from first to last.
import { $, sound } from './shared.js';
import { springSamples } from './spring.js';

const quiet = matchMedia('(prefers-reduced-motion: reduce)');
const SPRING_S = 0.24, FALL_S = 1, EDGE = 7;

// Turned lines, far enough apart not to shimmer on a screen. CSS rings this
// fine make a moiré cross across a plate this wide.
const spun = Array.from({ length: 46 }, (_, i) => `<circle cx="170" cy="170" r="${4 + i * 3}"/>`).join('');

// Cut, not printed: solid in the dial's engraving colour, with a lit edge
// just below it. The keyhole shows the plate through.
const padlock = `
  <path class="lid-shackle" d="M-10,-2 V-11 A10,10 0 0 1 10,-11 V-2"/>
  <rect class="lid-body" x="-16" y="-3" width="32" height="25" rx="3"/>`;
const keyhole = `<path class="lid-hole" d="M0,3.6 a3.4,3.4 0 0 1 2,6.15 L3,16 H-3 L-2,9.75 A3.4,3.4 0 0 1 0,3.6 Z"/>`;

const box = 'viewBox="27 27 286 286" aria-hidden="true"'; // the plate, centred on the dial's 170,170
const LID = `<svg ${box}><g class="lid-spun">${spun}</g>
  <circle cx="170" cy="170" r="137.1" class="lid-chamfer-line"/>
</svg>
<svg class="lid-face" ${box}>
  <g class="lid-mark lit" transform="translate(170 149.6)">${padlock}</g>
  <g class="lid-mark" transform="translate(170 149)">${padlock}${keyhole}</g>
  <text class="lid-words lit" x="170" y="196.6">PRIVATE</text>
  <text class="lid-words" x="170" y="196">PRIVATE</text>
  <text class="lid-words lit" x="170" y="213.6">INSTRUMENT</text>
  <text class="lid-words" x="170" y="213">INSTRUMENT</text>
</svg>`;

export function buildLock() {
  // Under the turned lines: the spun metal's highlights, and a catch of light.
  $('lid').innerHTML = `<div class="lid-sheen"></div><div class="lid-flash"></div><div class="lid-bevel"></div>${LID}`;
}

export function refuse() {
  sound('clack', 0.6);
  const gauge = $('gauge');
  gauge.classList.remove('refused');
  void gauge.offsetWidth; // so it can shake again
  gauge.classList.add('refused');
}

// The crown dips and the mark on the plate turns 30° to the right, the light
// staying where it is, as on the knob; it clicks home with a small overshoot.
// That frees the catch: the plate jumps out of its seat, settles back a touch
// on its spring, and falls off the screen, about 1.5 s in all. The hand wakes
// as it goes (js/dial.js), when `wake` is called.
export function openLid(wake) {
  const lid = $('lid');
  if (quiet.matches) { lid.hidden = true; return wake(); }
  // Two frames first, so what the page has just drawn doesn't eat the start.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const crown = $('crown');
    sound('ratchet', 0.8);
    crown.classList.add('pressed');
    setTimeout(() => crown.classList.remove('pressed'), 160);
    const turn = lid.querySelector('.lid-face').animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(33deg)', offset: .75 }, { transform: 'rotate(30deg)' }],
      { duration: 230, easing: 'cubic-bezier(.35, 0, .3, 1)', fill: 'both' },
    );
    turn.onfinish = () => {
      sound('clack');
      // The catch lets go and a real spring throws the plate up to where it
      // would rest, past it, and back. Then it falls: gravity downwards, steady
      // drift to the right and a steady tumble, as a thing does once let go.
      // Solid metal all the way: nothing here fades through to the dial.
      const fall = { x: innerWidth * 0.2, y: innerHeight * 0.95 };
      // Flat for now: tilted in the case's own 3D, half the plate would pass behind the dial.
      const watch = $('case');
      watch.style.transformStyle = 'flat';
      // And above the rest of the page, which the plate crosses on its way out.
      const gauge = $('gauge');
      gauge.style.position = 'relative';
      gauge.style.zIndex = '10';
      const spin = t => 75 * t;
      const placed = (t, drop = 0) => `translate(${(fall.x * t).toFixed(1)}px, ${(fall.y * t * t + drop).toFixed(1)}px)`;
      const flung = (x, t, extra = '') => `perspective(1400px) ${placed(t)} rotate(${spin(t).toFixed(2)}deg) rotateX(${(-5 * x + 30 * t).toFixed(3)}deg) rotateY(${(16 * t).toFixed(2)}deg) scale(${(1 + 0.04 * x).toFixed(4)})${extra}`;
      const at = (x, t = 0) => ({ transform: flung(x, t) });
      // The metal's side, showing under the plate, just behind it in its plane.
      const side = (x, t = 0) => ({ transform: flung(x, t, ` translateY(${(EDGE * Math.max(0, x)).toFixed(2)}px)`) });
      // Its shadow falls behind it and gives out as it gets further from the watch.
      const cast = (x, t = 0) => ({ transform: `${placed(t, 5 + 14 * x + 30 * t)} scale(${(1 + 0.03 * x).toFixed(4)})`, opacity: Math.min(1, Math.max(0, x)) * (1 - t) });
      // Light is what makes it metal, and the light stays where it is: as the
      // plate tumbles its reflections hold still against the room, sliding over
      // the turned surface with its tilt, not turning round with it.
      const sheen = (x, t = 0) => ({ transform: `rotate(${(30 * x - spin(t) + 80 * t).toFixed(2)}deg)` });
      const bevel = (x, t = 0) => ({ transform: `rotate(${(-spin(t)).toFixed(2)}deg)` });
      const flash = (x, t = 0) => ({ opacity: Math.max(0, Math.min(1, x)) * (1 - Math.min(1, t * 4)) });
      const steps = Math.round(FALL_S * 60);
      const frames = make => [
        ...springSamples(SPRING_S, 38, 0.35).map(x => make(x)),
        ...Array.from({ length: steps }, (_, i) => make(1, (i + 1) / steps)),
      ];
      const total = (SPRING_S + FALL_S) * 1000, freed = SPRING_S / (SPRING_S + FALL_S), motion = { duration: total, fill: 'both' };
      const under = className => {
        const el = Object.assign(document.createElement('div'), { className });
        lid.before(el);
        return el;
      };
      const parts = [under('lid-cast'), under('lid-side'), under('lid-shade')];
      parts[0].animate(frames(cast), motion);
      parts[1].animate(frames(side), motion);
      parts[2].animate([{ opacity: 1 }, { opacity: 1, offset: freed }, { opacity: 0, offset: freed + (1 - freed) * 0.65 }, { opacity: 0 }], motion);
      lid.querySelector('.lid-sheen').animate(frames(sheen), motion);
      lid.querySelector('.lid-flash').animate(frames(flash), motion);
      lid.querySelector('.lid-bevel').animate(frames(bevel), motion);
      const swing = lid.animate(frames(at), motion);
      setTimeout(wake, SPRING_S * 1000 - 20);
      swing.onfinish = () => {
        lid.hidden = true;
        watch.style.transformStyle = '';
        gauge.style.position = gauge.style.zIndex = '';
        swing.cancel();
        parts.forEach(el => el.remove());
      };
    };
  }));
}
