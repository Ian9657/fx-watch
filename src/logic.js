// Pure helpers shared by the worker and tests. No I/O here.

export const PAIRS = ['GBP', 'USD'];
export const RANGES = { '1d': 1, '5d': 5, '1mo': 31, '3mo': 92, '1y': 366 };

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

// Beijing calendar date (YYYY-MM-DD) for an epoch-ms timestamp.
export function beijingDay(ms) {
  return new Date(ms + BEIJING).toISOString().slice(0, 10);
}

export function validFloor(value) {
  return value === null || (Number.isFinite(value) && value > 0 && value < 1000);
}

// Decide which pairs need an alert. A pair alerts once when it drops below
// its floor, then stays quiet until the rate climbs back above the floor.
export function evaluate(rates, floors, alerted) {
  const next = { ...alerted };
  const alerts = [];
  for (const pair of PAIRS) {
    const rate = rates[pair];
    const floor = floors[pair];
    if (!Number.isFinite(rate) || floor == null) {
      next[pair] = false;
      continue;
    }
    if (rate < floor && !alerted[pair]) {
      alerts.push({ pair, rate, floor });
      next[pair] = true;
    } else if (rate > floor) {
      next[pair] = false;
    }
  }
  return { alerts, alerted: next };
}

export function alertMessage({ pair, rate, floor }) {
  return `${pair} is below your floor\n` +
    `CITIC buy price: 1 ${pair} = ${rate.toFixed(4)} CNY\n` +
    `Floor: ${floor.toFixed(4)}\n` +
    `https://fx.etarc.net`;
}

// Confirms delivery only; says nothing about whether a floor was crossed.
export function testMessage(quotes, floors) {
  const list = f => PAIRS.map(p => `${p} ${f(p)}`).join(' · ');
  return `FX Watch test: notifications are working.\n` +
    `CITIC buy price now: ${list(p => quotes[p].price.toFixed(4))}\n` +
    `Floors: ${list(p => floors[p] == null ? 'off' : floors[p].toFixed(4))}\n` +
    `You'll get a message when a price drops below its floor.`;
}
