import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChart, evaluate, validFloor } from '../src/logic.js';

const none = { GBP: false, USD: false };

test('alerts once when a rate drops below its floor', () => {
  const first = evaluate({ GBP: 8.8, USD: 6.7 }, { GBP: 8.9, USD: null }, none);
  assert.deepEqual(first.alerts.map(a => a.pair), ['GBP']);
  const second = evaluate({ GBP: 8.7, USD: 6.7 }, { GBP: 8.9, USD: null }, first.alerted);
  assert.equal(second.alerts.length, 0);
});

test('re-arms only when the rate climbs back above the floor', () => {
  let state = { GBP: true, USD: false };
  state = evaluate({ GBP: 8.9 }, { GBP: 8.9 }, state).alerted;
  assert.equal(state.GBP, true);
  state = evaluate({ GBP: 9.0 }, { GBP: 8.9 }, state).alerted;
  assert.equal(state.GBP, false);
  assert.equal(evaluate({ GBP: 8.8 }, { GBP: 8.9 }, state).alerts.length, 1);
});

test('parses Yahoo chart data and skips empty points', () => {
  const parsed = parseChart({ chart: { result: [{
    meta: { regularMarketPrice: 6.67, regularMarketTime: 100, chartPreviousClose: 6.69 },
    timestamp: [1, 2, 3],
    indicators: { quote: [{ close: [6.69, null, 6.67] }] },
  }] } });
  assert.equal(parsed.price, 6.67);
  assert.deepEqual(parsed.points, [{ t: 1, rate: 6.69 }, { t: 3, rate: 6.67 }]);
  assert.throws(() => parseChart({ chart: { result: [] } }));
});

test('validates floors', () => {
  assert.ok(validFloor(null));
  assert.ok(validFloor(8.9));
  assert.ok(!validFloor(0));
  assert.ok(!validFloor('8.9'));
});
