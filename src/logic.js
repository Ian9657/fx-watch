// Pure helpers shared by the worker and tests. No I/O here.

export const PAIRS = ['GBP', 'USD'];

// CITIC Bank currency codes in its rate feed.
const CITIC_CODES = { GBP: '012001', USD: '014001' };

// CITIC quotes are Beijing time (UTC+8).
const BEIJING = 8 * 3600 * 1000;

// CITIC rate feed (JSONP) → { GBP: { price, time }, USD: ... }
// price = customer buy price (客户购汇价) per 1 unit; time = epoch seconds.
export function parseCitic(text) {
  const json = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
  const rows = json?.content?.resultList;
  if (!Array.isArray(rows)) throw new Error('Unexpected CITIC response');
  const rates = {};
  for (const pair of PAIRS) {
    const row = rows.find(r => r.curCode === CITIC_CODES[pair]);
    const price = Number(row?.cstexcSellPrice) / 100;
    if (!Number.isFinite(price) || price <= 0) throw new Error(`No CITIC price for ${pair}`);
    const [y, m, d] = row.quotePriceDate.match(/\d+/g).map(Number);
    const [hh, mm, ss] = row.quotePriceTime.split(':').map(Number);
    const time = (Date.UTC(y, m - 1, d, hh, mm, ss) - BEIJING) / 1000;
    rates[pair] = { price, time };
  }
  return rates;
}

// The ticker tape: the last few quotes seen by the 10-minute check, newest
// first. A check that sees the same quote as the last one adds nothing.
export const TAPE_LENGTH = 12;
export function appendTape(tape, sample) {
  if (tape[0]?.t === sample.t) return tape;
  return [sample, ...tape].slice(0, TAPE_LENGTH);
}

// Beijing calendar date (YYYY-MM-DD) for an epoch-ms timestamp.
export function beijingDay(ms) {
  return new Date(ms + BEIJING).toISOString().slice(0, 10);
}

export const SIDES = ['floor', 'ceiling'];

export function validLimit(value) {
  return value === null || (Number.isFinite(value) && value > 0 && value < 1000);
}

// Settings saved before ceilings existed: { floors: { GBP: n } } and
// alerted: { GBP: bool } → { limits: { GBP: { floor, ceiling } } } and
// alerted: { GBP: { floor, ceiling } }.
export function migrate(data) {
  const limits = data.limits || Object.fromEntries(PAIRS.map(p => [p, { floor: data.floors?.[p] ?? null, ceiling: null }]));
  const alerted = Object.fromEntries(PAIRS.map(p => {
    const a = data.alerted?.[p];
    return [p, typeof a === 'object' && a ? { floor: !!a.floor, ceiling: !!a.ceiling } : { floor: !!a, ceiling: false }];
  }));
  const { floors, ...rest } = data;
  return { ...rest, limits, alerted };
}

const crossed = (side, rate, limit) => side === 'floor' ? rate < limit : rate > limit;

// Decide which alerts to send. Each side alerts once when the rate crosses
// its limit (below a floor, above a ceiling), then stays quiet until the rate
// is strictly back on the other side. Equal to the limit changes nothing.
export function evaluate(rates, limits, alerted) {
  const next = {};
  const alerts = [];
  for (const pair of PAIRS) {
    next[pair] = { ...alerted[pair] };
    const rate = rates[pair];
    for (const side of SIDES) {
      const limit = limits[pair]?.[side];
      if (!Number.isFinite(rate) || limit == null) {
        next[pair][side] = false;
      } else if (crossed(side, rate, limit)) {
        if (!alerted[pair]?.[side]) alerts.push({ pair, side, rate, limit });
        next[pair][side] = true;
      } else if (rate !== limit) {
        next[pair][side] = false;
      }
    }
  }
  return { alerts, alerted: next };
}

export function alertMessage({ pair, side, rate, limit }) {
  const name = side === 'floor' ? 'Floor' : 'Ceiling';
  return `${pair} is ${side === 'floor' ? 'below' : 'above'} your ${side}\n` +
    `CITIC buy price: 1 ${pair} = ${rate.toFixed(4)} CNY\n` +
    `${name}: ${limit.toFixed(4)}\n` +
    `https://fx.etarc.net`;
}

function describeLimits({ floor, ceiling } = {}) {
  const parts = [];
  if (floor != null) parts.push(`below ${floor.toFixed(4)}`);
  if (ceiling != null) parts.push(`above ${ceiling.toFixed(4)}`);
  return parts.length ? parts.join(' or ') : 'off';
}

// Confirms delivery only; says nothing about whether a limit was crossed.
export function testMessage(quotes, limits) {
  const list = f => PAIRS.map(p => `${p} ${f(p)}`).join(' · ');
  return `FX Watch test: notifications are working.\n` +
    `CITIC buy price now: ${list(p => quotes[p].price.toFixed(4))}\n` +
    `Alerts: ${list(p => describeLimits(limits[p]))}\n` +
    `You'll get a message when a price crosses one of these.`;
}
