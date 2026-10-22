// Pure helpers shared by the worker and tests. No I/O here.

export const PAIRS = ['GBP', 'USD'];
export const RANGES = { '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '1y': '1d' };

// Yahoo chart API → { price, time, previousClose, points: [{ t, rate }] }
export function parseChart(json) {
  const result = json?.chart?.result?.[0];
  const price = result?.meta?.regularMarketPrice;
  if (!Number.isFinite(price) || price <= 0) throw new Error('No price in response');
  const times = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  times.forEach((t, i) => {
    if (Number.isFinite(closes[i]) && closes[i] > 0) points.push({ t, rate: closes[i] });
  });
  return {
    price,
    time: result.meta.regularMarketTime,
    previousClose: result.meta.chartPreviousClose ?? null,
    points,
  };
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
  return `${pair}/CNY dropped below your floor\n` +
    `Now: 1 ${pair} = ${rate.toFixed(4)} CNY\n` +
    `Floor: ${floor.toFixed(4)}`;
}
