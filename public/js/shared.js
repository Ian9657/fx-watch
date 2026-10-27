// Small helpers and the state every part of the page reads.

export const $ = id => document.getElementById(id);
export const PAIRS = ['GBP', 'USD'];
export const SIDES = ['floor', 'ceiling'];

export const store = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
  remove: key => { try { localStorage.removeItem(key); } catch {} },
};

export const state = {
  rates: {},
  limits: { GBP: { floor: null, ceiling: null }, USD: { floor: null, ceiling: null } },
  lastCheck: null, // when the 10-minute alert check last ran (epoch ms)
  tape: [],        // quotes the alert check has recorded, newest first
  lastGood: null,  // when this page last loaded prices successfully
  feedError: null, // message if the latest price load failed
  woundAt: 0,      // when the crown was last pressed (epoch ms)
  alerted: null,   // per currency and side: the limit an alert was sent for, or false
  rearm: 0.001,    // how far back inside a limit a sent alert re-arms (from the Worker)
  failing: null,   // { since, count, error } while the 10-minute check keeps failing
  alertError: null, // { time, error } if the last alert couldn't be sent
  pair: store.get('pair') === 'USD' ? 'USD' : 'GBP', // which currency the dial reads
  draft: null,     // { floor: { on, text }, ceiling: { on, text } } while the sheet is open
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
  $('app').hidden = true;
  $('refresh').hidden = true;
  $('lock').hidden = false;
  $('lock-status').textContent = message;
  $('password').focus();
}

export function unlock() {
  $('lock').hidden = true;
  $('app').hidden = false;
  $('refresh').hidden = false;
  $('crown-hint').hidden = !!store.get('wound');
}

export function draftLimits() {
  const { draft } = state;
  return Object.fromEntries(SIDES.map(side => [side, draft[side].on ? Number(draft[side].text) : null]));
}
export const crossed = ({ floor, ceiling }) => floor != null && ceiling != null && floor >= ceiling;

// While the sheet is open the dial previews the draft, unless the draft has
// floor above ceiling.
export function limitsFor(p) {
  if (!state.draft || p !== state.pair || crossed(draftLimits())) return state.limits[p];
  return draftLimits();
}
