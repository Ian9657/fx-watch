// The public demo's made-up data (public/js/demo.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleData } from '../public/js/demo.js';

test('GBP reads TOO HIGH and USD BUY at any time', () => {
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 2000; i++) {
    const { rates, limits } = sampleData(start + i * 4.3 * 3600_000 + i * 977);
    assert.ok(limits.GBP.floor < limits.GBP.ceiling && limits.GBP.ceiling < rates.GBP.price);
    assert.ok(rates.USD.price < limits.USD.floor && limits.USD.floor < limits.USD.ceiling);
  }
});

test('history is 8 days of rows, oldest first, ending at the latest 10 minutes', () => {
  const now = Date.UTC(2026, 5, 15, 12, 34, 56);
  const { pairs, history, rates } = sampleData(now);
  assert.deepEqual(pairs, ['GBP', 'USD']);
  assert.equal(history.length, 8 * 144);
  assert.equal(history.at(-1)[0], Date.UTC(2026, 5, 15, 12, 30) / 1000);
  assert.ok(history.every((r, i) => r.length === 3 && (!i || r[0] - history[i - 1][0] === 600)));
  assert.ok(Math.abs(rates.GBP.price - history.at(-1)[1]) < 0.02);
  assert.ok(rates.GBP.previousClose > 8 && rates.USD.previousClose > 6);
});

test('the crown moves the price', () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const prices = Array.from({ length: 5 }, (_, i) => sampleData(now + i * 3000).rates.GBP.price);
  assert.ok(new Set(prices).size > 1);
});
