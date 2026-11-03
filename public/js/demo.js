// The public demo's data, made up in the browser: no request leaves the
// page, so the demo shows nothing recorded and doesn't touch the Worker's
// API. Prices drift smoothly with the clock, one row every 10 minutes for
// 8 days, and the limits are set around them so GBP always reads TOO HIGH
// and USD BUY.
const PAIRS = ['GBP', 'USD'];
const BASE = { GBP: 8.98, USD: 6.69 };
const ZONES = { GBP: 'high', USD: 'buy' };
const STEP = 600, DAYS = 8;

// A few slow waves, different for each currency, as a share of the base.
const drift = (p, t) => {
  const a = p === 'GBP' ? 0 : 2.1;
  return 0.0022 * Math.sin(t / 61000 + a) + 0.0013 * Math.sin(t / 19000 + 2 * a) + 0.0006 * Math.sin(t / 4300 + 3 * a) + 0.00025 * Math.sin(t / 1100 + a);
};
const price = (p, t) => +(BASE[p] * (1 + drift(p, t))).toFixed(4);
// The live price also trembles from one refresh to the next, so pressing
// the crown visibly moves the drums.
const live = (p, t) => +(price(p, t) * (1 + 0.00025 * Math.sin(t * 1.7))).toFixed(4);

// A band as wide as the prices' range, so the chart's trace stays on the
// scale. The price sits 30% of it past the limit, the needle well into the zone.
function limits(p, prices) {
  const last = prices.at(-1), band = Math.max(Math.max(...prices) - Math.min(...prices), last * 0.002);
  const floor = ZONES[p] === 'high' ? last - 1.3 * band : last + 0.3 * band;
  return { floor: +floor.toFixed(4), ceiling: +(floor + band).toFixed(4) };
}

export function sampleData(now = Date.now()) {
  const t = Math.floor(now / 1000), last = t - t % STEP;
  const times = Array.from({ length: DAYS * 86400 / STEP }, (_, i) => last - (DAYS * 86400 / STEP - 1 - i) * STEP);
  const midnight = new Date(now).setHours(0, 0, 0, 0) / 1000;
  const before = times.filter(x => x < midnight).at(-1);
  const each = fn => Object.fromEntries(PAIRS.map(p => [p, fn(p)]));
  return {
    pairs: PAIRS,
    knob: PAIRS,
    history: times.map(x => [x, ...PAIRS.map(p => price(p, x))]),
    rates: each(p => ({ price: live(p, t), time: t, previousClose: before ? price(p, before) : null })),
    limits: each(p => limits(p, times.map(x => price(p, x)))),
  };
}
