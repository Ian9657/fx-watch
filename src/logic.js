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
    // The feed gives CNY per 100 units; dividing leaves float noise
    // (893.41 / 100 = 8.934099999999999), so round to the 4 places quoted.
    const price = +(Number(row?.cstexcSellPrice) / 100).toFixed(4);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`No CITIC price for ${pair}`);
    const [y, m, d] = row.quotePriceDate.match(/\d+/g).map(Number);
    const [hh, mm, ss] = row.quotePriceTime.split(':').map(Number);
    const time = (Date.UTC(y, m - 1, d, hh, mm, ss) - BEIJING) / 1000;
    rates[pair] = { price, time };
  }
  return rates;
}

// Price history is kept one record per Beijing day: [t, GBP, USD] rows,
// oldest first, one per new quote the 10-minute check sees. A day holds at
// most 144 rows (about 4 KB), so a check reads and writes only today's
// record, and each record expires on its own after HISTORY_DAYS (+2 for
// days that straddle the cut-off).
export const HISTORY_DAYS = 90;
export const DAY_TTL = (HISTORY_DAYS + 2) * 86400; // seconds
export const dayKey = day => `h:${day}`;

export const toRow = sample => [sample.t, ...PAIRS.map(p => +sample[p].toFixed(4))];

// Add a row to a day's rows unless it repeats the last quote.
export function appendRow(rows, row) {
  return rows.at(-1)?.[0] === row[0] ? rows : [...rows, row];
}

// Group rows by Beijing day, for moving an older single history record over.
export function splitByDay(rows) {
  const days = {};
  for (const row of rows) (days[beijingDay(row[0] * 1000)] ??= []).push(row);
  return days;
}

// The ticker tape: the last TAPE_LENGTH quotes, newest first.
export const TAPE_LENGTH = 12;
export function tapeFrom(rows) {
  return rows.slice(-TAPE_LENGTH).reverse().map(([t, ...prices]) => ({ t, ...Object.fromEntries(PAIRS.map((p, i) => [p, prices[i]])) }));
}

// The Beijing days from `from` back `n` days (YYYY-MM-DD, newest first).
export function daysBack(from, n) {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(start - i * 86400_000).toISOString().slice(0, 10));
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
    // A side holds the limit it alerted for (a number), true from older
    // records, or false.
    const keep = v => typeof v === 'number' ? v : !!v;
    return [p, typeof a === 'object' && a ? { floor: keep(a.floor), ceiling: keep(a.ceiling) } : { floor: !!a, ceiling: false }];
  }));
  const { floors, ...rest } = data;
  return { ...rest, limits, alerted };
}

const crossed = (side, rate, limit) => side === 'floor' ? rate < limit : rate > limit;

// A side re-arms only once the rate is back inside its limit by this
// fraction, so a price wobbling around the floor doesn't alert again and
// again. 0.1% is about 0.009 on GBP/CNY, roughly a quarter of a quiet day.
export const REARM = 0.001;

const rearmed = (side, rate, limit) =>
  side === 'floor' ? rate > limit * (1 + REARM) : rate < limit * (1 - REARM);

// Decide which alerts to send. Each side alerts once when the rate crosses
// its limit (below a floor, above a ceiling), then stays quiet until the
// rate is back inside the limit by more than REARM.
//
// A side that has alerted records the limit it alerted for, so a new limit
// can alert straight away without anyone resetting it: saving settings
// never has to touch the alert state, and the check never has to touch the
// limits. (`true` is the old record, from before limits were kept.)
export function evaluate(rates, limits, alerted) {
  const next = {};
  const alerts = [];
  for (const pair of PAIRS) {
    next[pair] = { ...alerted[pair] };
    const rate = rates[pair];
    for (const side of SIDES) {
      const limit = limits[pair]?.[side];
      const sent = alerted[pair]?.[side];
      if (!Number.isFinite(rate) || limit == null) {
        next[pair][side] = false;
      } else if (crossed(side, rate, limit)) {
        if (sent !== limit && sent !== true) alerts.push({ pair, side, rate, limit });
        next[pair][side] = limit;
      } else if (rearmed(side, rate, limit)) {
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
