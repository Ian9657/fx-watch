// Small helpers and the state every part of the page reads.

export const $ = id => document.getElementById(id);
// The currencies the Worker quotes and alerts on (src/logic.js). The knob
// carries one to four of them, chosen in the settings sheet.
export const PAIRS = ['USD', 'GBP', 'EUR', 'JPY', 'HKD', 'AUD', 'CAD', 'SGD'];
export const KNOB_MAX = 4;
export const unit = p => p === 'JPY' ? 100 : 1; // CITIC quotes yen per 100
export const per = p => `${unit(p) === 1 ? '' : `${unit(p)} `}${p}`;
export const SIDES = ['floor', 'ceiling'];

// The public demo: the same page on recorded GBP and USD prices with sample
// limits, no password and no settings. It keeps its own saved choices.
export const DEMO = location.pathname === '/demo';
export const REPO = 'https://github.com/Ian9657/fx-watch';
const saved = key => DEMO ? `demo:${key}` : key;
export const store = {
  get: key => { try { return localStorage.getItem(saved(key)); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(saved(key), value); } catch {} },
  remove: key => { try { localStorage.removeItem(saved(key)); } catch {} },
};

export const state = {
  rates: {},
  limits: Object.fromEntries(PAIRS.map(p => [p, { floor: null, ceiling: null }])),
  knob: ['GBP', 'USD'], // the currencies on the knob, in the order it turns through them
  lastCheck: null, // when the 10-minute alert check last ran (epoch ms)
  tape: [],        // quotes the alert check has recorded, newest first
  lastGood: null,  // when this page last loaded prices successfully
  feedError: null, // message if the latest price load failed
  woundAt: 0,      // when the crown was last pressed (epoch ms)
  alerted: null,   // per currency and side: the limit an alert was sent for, or false
  rearm: 0.001,    // how far back inside a limit a sent alert re-arms (from the Worker)
  failing: null,   // { since, count, error } while the 10-minute check keeps failing
  alertError: null, // { time, error } if the last alert couldn't be sent
  offlineAt: null, // when the answers on show were saved, if they're the offline copy (sw.js)
  lidShut: false,  // the lid is still over the dial, just after unlocking (js/lock.js)
  winding: false,  // a refresh you asked for (crown or status line) is under way
  pair: PAIRS.includes(store.get('pair')) ? store.get('pair') : 'GBP', // which currency the dial reads
  draft: null,     // { floor: { on, text }, ceiling: { on, text } } for the currency in the sheet
  drafts: null,    // every currency's draft opened in the sheet, by currency
  knobDraft: null, // the knob's currencies as the sheet has them
};

export const time = (date, seconds = false) => date.toLocaleTimeString('en-GB', {
  hour: '2-digit', minute: '2-digit', ...(seconds && { second: '2-digit' }),
});

export class Locked extends Error {}

export async function getJSON(url, options = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${store.get('password') || ''}` },
  });
  // The offline copy (sw.js) is marked with when it was saved.
  const saved = res.headers.get('X-Offline');
  state.offlineAt = saved ? Number(saved) : null;
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Locked();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export function showError(message) {
  $('error').hidden = !message;
  $('error').textContent = message || '';
}

export function lock(message = '') {
  // The watch stays in its place, shut; the form takes the place of the rest.
  $('app').hidden = false;
  $('app').classList.add('locked');
  $('gauge').inert = true;
  $('lid').hidden = false;
  $('refresh').hidden = false; // unseen, but keeping its space, as the rest does
  $('lock').hidden = false;
  $('lock-status').textContent = message;
  $('password').focus();
}

export function unlock() {
  $('lock').hidden = true;
  $('app').hidden = false;
  $('app').classList.remove('locked');
  $('gauge').inert = false;
  $('refresh').hidden = false;
  $('crown-hint').hidden = !!store.get('wound');
}

export function draftLimits(draft = state.draft) {
  return Object.fromEntries(SIDES.map(side => [side, draft[side].on ? Number(draft[side].text) : null]));
}
export const crossed = ({ floor, ceiling }) => floor != null && ceiling != null && floor >= ceiling;

// While the sheet is open the dial previews the draft, unless the draft has
// floor above ceiling.
export function limitsFor(p) {
  if (!state.draft || p !== state.pair || crossed(draftLimits())) return state.limits[p];
  return draftLimits();
}

// Both faces map a price the same way, so they read alike whatever the
// currency: 0 to 1 across the scale, the floor always at 0.3 and the
// ceiling at 0.7, so the HOLD band is the range you set. With one side
// off, a 1% span stands in for the missing limit only to scale it; with
// both off, half a percent either side of the price.
export function span(price, floor, ceiling) {
  if (floor == null && ceiling == null) return [price * 0.995, price * 1.005];
  return [floor ?? ceiling * 0.99, ceiling ?? floor * 1.01];
}

export function position(price, floor, ceiling, ref = price) {
  const [lo, hi] = span(ref, floor, ceiling);
  const pos = 0.3 + (0.4 * (price - lo)) / (hi - lo);
  return Math.min(0.98, Math.max(0.02, pos));
}

// The watch's sounds, all short and quiet, made from a burst of filtered
// noise: a tick for a wheel's notch or the bezel's click, a lower clack for
// a lever or the knob's detent, and three ticks of the crown's ratchet,
// in time with its knurling turning. Web audio, so it follows the phone's
// silent switch where the browser allows (audioSession).
const SOUNDS = {
  tick: { freq: 3200, len: 0.012, gain: 0.28 },
  clack: { freq: 1400, len: 0.03, gain: 0.5 },
  ratchet: { freq: 2600, len: 0.012, gain: 0.3, times: [0, 0.107, 0.213] },
};
let audio;
export function sound(kind, level = 1) {
  try {
    if (!audio) {
      if (navigator.audioSession) navigator.audioSession.type = 'ambient';
      audio = new AudioContext();
    }
    if (audio.state === 'suspended') audio.resume();
    const { freq, len, gain, times = [0] } = SOUNDS[kind];
    const buf = audio.createBuffer(1, Math.ceil(audio.sampleRate * len), audio.sampleRate);
    const data = buf.getChannelData(0);
    for (let n = 0; n < data.length; n++) data[n] = (Math.random() * 2 - 1) * Math.exp(-n / (data.length / 5));
    for (const at of times) {
      const src = audio.createBufferSource(), band = audio.createBiquadFilter(), amp = audio.createGain();
      src.buffer = buf;
      band.type = 'bandpass';
      band.frequency.value = freq;
      band.Q.value = 1.2;
      amp.gain.value = gain * level;
      src.connect(band).connect(amp).connect(audio.destination);
      src.start(audio.currentTime + at);
    }
  } catch {}
}

// A tap felt through the fingertip. Android has the vibration API, called
// as a control moves. iPhone has none for web pages; Safari does give a
// light tap when a switch control is flipped, but only by the finger itself,
// not from script. So on iPhone each control that is tapped carries a clear
// switch over its face (feel), and a drag gives no tap, only the sound.
const IOS = !navigator.vibrate && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent)));
export function haptic(ms = 6) {
  navigator.vibrate?.(ms);
}
export function feel(el) {
  if (!IOS || el.querySelector(':scope > .feel')) return;
  const skin = Object.assign(document.createElement('input'), { type: 'checkbox', tabIndex: -1, className: 'feel' });
  skin.setAttribute('switch', '');
  skin.setAttribute('aria-hidden', 'true');
  el.classList.add('felt');
  el.append(skin);
}

// Phones don't show :active, so controls get a .pressed class from the
// pointer instead, held for at least 140ms so even a quick tap shows.
export function pressable(el, onPress) {
  let since = 0, timer;
  const release = () => {
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('pressed'), Math.max(0, 140 - (Date.now() - since)));
  };
  el.addEventListener('pointerdown', () => {
    clearTimeout(timer);
    since = Date.now();
    el.classList.add('pressed');
    onPress?.();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, release);
}
