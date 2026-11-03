// Pure helpers shared by the worker and tests. No I/O here.

// The currencies the app watches: limits, alerts, the page. JPY is quoted
// per 100 units, as CITIC does, so it keeps four places on the drums like
// the rest; the others per unit.
export const PAIRS = ['USD', 'GBP', 'EUR', 'JPY', 'HKD', 'AUD', 'CAD', 'SGD'];
export const unit = p => p === 'JPY' ? 100 : 1;

// CITIC Bank's code for every currency in its rate feed, in the order
// history records them. The eight in PAIRS are the ones shown and alerted on.
export const CURRENCIES = {
  USD: '014001', GBP: '012001', EUR: '051001', JPY: '027001', HKD: '013001',
  CAD: '028001', CHF: '015001', NZD: '062001', AUD: '029001', SGD: '018001',
  DKK: '022001', SEK: '021001', NOK: '023001', KRW: '085001', THB: '038001',
  MOP: '081001', KZT: '031001', SAR: '065001', ZAR: '096001', IDR: '041001',
};
export const CODES = Object.keys(CURRENCIES);

// CITIC quotes are Beijing time (UTC+8).
const BEIJING = 8 * 3600 * 1000;

// CITIC rate feed (JSONP) → { GBP: { price, sell, buy, time }, ... } for
// every currency in it. sell is the customer buy price (客户购汇价) and buy
// the customer sell price (客户结汇价), both as quoted: CNY per 100 units.
// price is sell in the currency's own unit (see unit). A currency missing
// from the feed is left out; a feed with none of PAIRS is an error.
export function parseCitic(text) {
  const json = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
  const rows = json?.content?.resultList;
  if (!Array.isArray(rows)) throw new Error('Unexpected CITIC response');
  const quotes = {};
  for (const code of CODES) {
    const row = rows.find(r => r.curCode === CURRENCIES[code]);
    const sell = Number(row?.cstexcSellPrice), buy = Number(row?.cstexcBuyPrice);
    if (!Number.isFinite(sell) || sell <= 0) continue;
    const [y, m, d] = row.quotePriceDate.match(/\d+/g).map(Number);
    const [hh, mm, ss] = row.quotePriceTime.split(':').map(Number);
    const time = (Date.UTC(y, m - 1, d, hh, mm, ss) - BEIJING) / 1000;
    quotes[code] = { price: price(code, sell), sell, buy: Number.isFinite(buy) && buy > 0 ? buy : null, time };
  }
  if (!PAIRS.some(p => quotes[p])) throw new Error('No CITIC price for any currency watched');
  return quotes;
}

// A price as quoted (CNY per 100) in the currency's own unit. Dividing
// leaves float noise (893.41 / 100 = 8.934099999999999), so round to the 4
// places shown.
export const price = (code, quoted) => +(quoted * unit(code) / 100).toFixed(4);

// Price history is kept one record per Beijing day,
//   { codes: [...CODES], rows: [[t, ...sell per code, ...buy per code]] },
// oldest first, one row per new quote the 10-minute check sees, prices as
// quoted (per 100 units) and null where CITIC had none. A day holds at most
// 144 rows (about 50 KB). Each record expires on its own after HISTORY_DAYS
// (+2 for days that straddle the cut-off).
//
// Reading 90 full days would cost more CPU than a free Worker request has,
// so once a day is over the check also keeps a rollup of it (r:): the last
// row of each hour. The chart uses full days for the last week and rollups
// before that.
export const HISTORY_DAYS = 90;
export const FULL_DAYS = 8;
export const DAY_TTL = (HISTORY_DAYS + 2) * 86400; // seconds
export const dayKey = day => `h:${day}`;
export const rollupKey = day => `r:${day}`;

export const toRow = (t, quotes) => [t, ...CODES.map(c => quotes[c]?.sell ?? null), ...CODES.map(c => quotes[c]?.buy ?? null)];

// A stored day record in today's layout. Records from before every
// currency was kept are [t, GBP, USD] rows of per-unit sell prices; a
// record kept under another list of codes is laid out again.
export function normalizeDay(value) {
  if (!value) return { codes: CODES, rows: [] };
  const old = Array.isArray(value)
    ? { codes: ['GBP', 'USD'], rows: value.map(([t, ...prices]) => [t, ...prices.map(v => v == null ? null : +(v * 100).toFixed(4)), ...prices.map(() => null)]) }
    : value;
  if (old.codes.join() === CODES.join()) return old;
  const n = old.codes.length, at = CODES.map(c => old.codes.indexOf(c));
  return { codes: CODES, rows: old.rows.map(r => [r[0], ...at.map(i => i < 0 ? null : r[1 + i]), ...at.map(i => i < 0 ? null : r[1 + n + i])]) };
}

// Rows of [t, ...sell prices of `pairs` in their own units]: the shape the
// page, the tape and yesterday's close use.
export function pairRows(record, pairs = PAIRS) {
  const at = pairs.map(p => 1 + record.codes.indexOf(p));
  return record.rows.map(r => [r[0], ...at.map((i, k) => i < 1 || r[i] == null ? null : price(pairs[k], r[i]))]);
}

// The last row of each hour.
export const hourly = rows => rows.filter((r, i) => i === rows.length - 1 || Math.floor(rows[i + 1][0] / 3600) !== Math.floor(r[0] / 3600));

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

// The currencies on the dial's knob, in the order its stops turn through:
// one to four of PAIRS, chosen in the settings sheet.
export const KNOB = ['GBP', 'USD'];
export const KNOB_MAX = 4;
export function validKnob(list) {
  return Array.isArray(list) && list.length >= 1 && list.length <= KNOB_MAX
    && new Set(list).size === list.length && list.every(p => PAIRS.includes(p));
}

export function validLimit(value) {
  return value === null || (Number.isFinite(value) && value > 0 && value < 1000);
}

// Settings saved before ceilings existed: { floors: { GBP: n } } and
// alerted: { GBP: bool } → { limits: { GBP: { floor, ceiling } } } and
// alerted: { GBP: { floor, ceiling } }.
// Limits for every currency watched, none set for those added since.
export const fillLimits = (limits = {}) => Object.fromEntries(PAIRS.map(p => [p, { floor: null, ceiling: null, ...limits[p] }]));

export function migrate(data) {
  const limits = fillLimits(data.limits || Object.fromEntries(Object.entries(data.floors || {}).map(([p, floor]) => [p, { floor, ceiling: null }])));
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

// The rate a side must get back past to re-arm.
export const rearmAt = (side, limit) => side === 'floor' ? limit * (1 + REARM) : limit * (1 - REARM);
const rearmed = (side, rate, limit) =>
  side === 'floor' ? rate > rearmAt(side, limit) : rate < rearmAt(side, limit);

// Decide which alerts to send. Each side alerts when the rate crosses its
// limit (below a floor, above a ceiling), then again every REPEAT_MS while
// it stays out there, and goes quiet once the rate is back inside the limit
// by more than REARM. Coming back inside sends nothing.
//
// A side that has alerted records the limit it alerted for, so a new limit
// can alert straight away without anyone resetting it: saving settings
// never has to touch the alert state, and the check never has to touch the
// limits. (`true` is the old record, from before limits were kept.)
// `sentAt` holds when each side last alerted, for the repeats.
export const REPEAT_MS = 4 * 3600_000;

export function evaluate(rates, limits, alerted, sentAt = {}, now = Date.now()) {
  const next = {}, nextAt = {};
  const alerts = [];
  for (const pair of PAIRS) {
    next[pair] = { floor: false, ceiling: false, ...alerted[pair] };
    nextAt[pair] = { floor: null, ceiling: null, ...sentAt[pair] };
    const rate = rates[pair];
    // No quote this time (missing from the feed): keep the state as it was.
    if (!Number.isFinite(rate)) continue;
    for (const side of SIDES) {
      const limit = limits[pair]?.[side];
      const sent = alerted[pair]?.[side];
      const at = sentAt[pair]?.[side] ?? null;
      if (limit == null || (!crossed(side, rate, limit) && rearmed(side, rate, limit))) {
        next[pair][side] = false;
        nextAt[pair][side] = null;
      } else if (crossed(side, rate, limit)) {
        if (sent !== limit && sent !== true) {
          alerts.push({ pair, side, rate, limit, repeat: false });
          nextAt[pair][side] = now;
        } else if (at == null) {
          nextAt[pair][side] = now; // an old record with no time: start the clock
        } else if (now - at >= REPEAT_MS) {
          alerts.push({ pair, side, rate, limit, repeat: true });
          nextAt[pair][side] = now;
        }
        next[pair][side] = limit;
      }
    }
  }
  return { alerts, alerted: next, sentAt: nextAt };
}

export function alertMessage({ pair, side, rate, limit, repeat }, site) {
  const name = side === 'floor' ? 'Floor' : 'Ceiling';
  const where = side === 'floor' ? 'below' : 'above';
  return `${pair} is ${repeat ? 'still ' : ''}${where} your ${side}\n` +
    `CITIC buy price: ${unit(pair)} ${pair} = ${rate.toFixed(4)} CNY\n` +
    `${name}: ${limit.toFixed(4)}\n` +
    (repeat ? `A reminder every ${REPEAT_MS / 3600_000} hours while it stays ${where}.\n` : '') +
    `Re-arms once back ${side === 'floor' ? 'above' : 'below'} ${rearmAt(side, limit).toFixed(4)}.` +
    (site ? `\n${site}` : '');
}

function describeLimits({ floor, ceiling } = {}) {
  const parts = [];
  if (floor != null) parts.push(`below ${floor.toFixed(4)}`);
  if (ceiling != null) parts.push(`above ${ceiling.toFixed(4)}`);
  return parts.length ? parts.join(' or ') : 'off';
}

// Confirms delivery only; says nothing about whether a limit was crossed.
export function testMessage(quotes, limits) {
  const lines = PAIRS.filter(p => quotes[p]).map(p => `${unit(p) === 1 ? '' : `${unit(p)} `}${p} ${quotes[p].price.toFixed(4)} · ${describeLimits(limits[p])}`);
  return `FX Watch test: notifications are working.\n` +
    `CITIC buy price now, in CNY, and alerts:\n${lines.join('\n')}\n` +
    `You'll get a message when a price crosses one of these.`;
}

// When the 10-minute check keeps failing, alerts can't fire, so say so once
// it has failed FAIL_ALERT_AFTER times in a row (about half an hour), and
// again when it recovers.
export const FAIL_ALERT_AFTER = 3;

export function failingMessage({ count, error }, site) {
  return `FX Watch: the price check has failed ${count} times in a row (about ${count * 10} minutes).\n` +
    `Floor and ceiling alerts are paused until it works again.\n` +
    `Last error: ${error}` +
    (site ? `\n${site}` : '');
}

export function recoveredMessage({ count }) {
  return `FX Watch: the price check is working again after ${count} failed checks (about ${count * 10} minutes). Alerts are back on.`;
}
