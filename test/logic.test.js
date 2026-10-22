import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCitic, beijingDay, evaluate, validFloor, testMessage } from '../src/logic.js';

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

test('parses the CITIC rate feed', () => {
  const row = (curCode, buy, sell) => ({ quotePriceDate: '2026年10月22日', quotePriceTime: '20:33:52', curCode, cstexcBuyPrice: buy, cstexcSellPrice: sell });
  const text = 'cb(' + JSON.stringify({ retCode: 'AAAAAAA', content: { resultList: [
    row('014001', '666.34', '669.29'), row('012001', '889.14', '895.87'),
  ] } }) + ')';
  const rates = parseCitic(text);
  assert.equal(rates.GBP.price, 8.9587);
  assert.equal(rates.USD.price, 6.6929);
  // 20:33:52 Beijing = 12:33:52 UTC
  assert.equal(new Date(rates.GBP.time * 1000).toISOString(), '2026-10-22T12:33:52.000Z');
  assert.throws(() => parseCitic('cb({"content":{"resultList":[]}})'));
});

test('buckets days by Beijing time', () => {
  assert.equal(beijingDay(Date.parse('2026-10-22T15:59:00Z')), '2026-10-22');
  assert.equal(beijingDay(Date.parse('2026-10-22T16:00:00Z')), '2026-10-23');
});

test('validates floors', () => {
  assert.ok(validFloor(null));
  assert.ok(validFloor(8.9));
  assert.ok(!validFloor(0));
  assert.ok(!validFloor('8.9'));
});

test('test message does not claim a floor was crossed', () => {
  const msg = testMessage({ GBP: { price: 8.958 }, USD: { price: 6.69 } }, { GBP: 8.9, USD: null });
  assert.match(msg, /GBP 8\.9580 · USD 6\.6900/);
  assert.match(msg, /Floors: GBP 8\.9000 · USD off/);
  assert.doesNotMatch(msg, /below your floor/);
});
