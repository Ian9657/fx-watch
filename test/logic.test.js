import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCitic, appendTape, TAPE_LENGTH, appendHistory, HISTORY_DAYS, beijingDay, evaluate, validLimit, migrate, alertMessage, testMessage } from '../src/logic.js';

const none = { GBP: { floor: false, ceiling: false }, USD: { floor: false, ceiling: false } };
const limits = (gbp, usd = {}) => ({
  GBP: { floor: null, ceiling: null, ...gbp },
  USD: { floor: null, ceiling: null, ...usd },
});

test('alerts once when a rate drops below its floor', () => {
  const first = evaluate({ GBP: 8.8, USD: 6.7 }, limits({ floor: 8.9 }), none);
  assert.deepEqual(first.alerts.map(a => [a.pair, a.side]), [['GBP', 'floor']]);
  const second = evaluate({ GBP: 8.7, USD: 6.7 }, limits({ floor: 8.9 }), first.alerted);
  assert.equal(second.alerts.length, 0);
});

test('alerts once when a rate rises above its ceiling', () => {
  const first = evaluate({ GBP: 9.1, USD: 6.7 }, limits({ ceiling: 9.0 }), none);
  assert.deepEqual(first.alerts.map(a => [a.pair, a.side]), [['GBP', 'ceiling']]);
  assert.equal(evaluate({ GBP: 9.2 }, limits({ ceiling: 9.0 }), first.alerted).alerts.length, 0);
});

test('re-arms only once the rate is back inside the limit by the margin', () => {
  const l = limits({ floor: 8.9, ceiling: 9.1 });
  const both = { GBP: { floor: true, ceiling: true }, USD: { floor: false, ceiling: false } };
  // Equal to a limit, or back inside by less than 0.1%, keeps that side quiet.
  assert.equal(evaluate({ GBP: 8.9 }, l, both).alerted.GBP.floor, true);
  assert.equal(evaluate({ GBP: 8.905 }, l, both).alerted.GBP.floor, true);
  assert.equal(evaluate({ GBP: 9.1 }, l, both).alerted.GBP.ceiling, true);
  assert.equal(evaluate({ GBP: 9.095 }, l, both).alerted.GBP.ceiling, true);
  // Well inside re-arms both sides, so the next crossing alerts again.
  const rearmed = evaluate({ GBP: 9.0 }, l, both).alerted;
  assert.deepEqual(rearmed.GBP, { floor: false, ceiling: false });
  assert.equal(evaluate({ GBP: 8.8 }, l, rearmed).alerts[0].side, 'floor');
  assert.equal(evaluate({ GBP: 9.2 }, l, rearmed).alerts[0].side, 'ceiling');
});

test('a price wobbling around the floor alerts only once', () => {
  const l = limits({ floor: 8.9 });
  let state = { GBP: { floor: false, ceiling: false }, USD: { floor: false, ceiling: false } };
  let sent = 0;
  for (const rate of [8.899, 8.901, 8.898, 8.903, 8.897, 8.902]) {
    const r = evaluate({ GBP: rate }, l, state);
    sent += r.alerts.length;
    state = r.alerted;
  }
  assert.equal(sent, 1);
});

test('migrates settings saved before ceilings existed', () => {
  const data = migrate({ floors: { GBP: 8.9, USD: null }, alerted: { GBP: true, USD: false }, lastCheck: 1 });
  assert.deepEqual(data.limits, limits({ floor: 8.9 }));
  assert.deepEqual(data.alerted.GBP, { floor: true, ceiling: false });
  assert.equal(data.lastCheck, 1);
  assert.equal('floors' in data, false);
  assert.deepEqual(migrate({}).limits, limits({}));
});

test('alert message names the side that was crossed', () => {
  assert.match(alertMessage({ pair: 'GBP', side: 'ceiling', rate: 9.05, limit: 9 }), /GBP is above your ceiling[\s\S]*Ceiling: 9\.0000/);
  assert.match(alertMessage({ pair: 'USD', side: 'floor', rate: 6.6, limit: 6.65 }), /USD is below your floor[\s\S]*Floor: 6\.6500/);
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

test('validates limits', () => {
  assert.ok(validLimit(null));
  assert.ok(validLimit(8.9));
  assert.ok(!validLimit(0));
  assert.ok(!validLimit('8.9'));
});

test('test message does not claim a limit was crossed', () => {
  const msg = testMessage({ GBP: { price: 8.958 }, USD: { price: 6.69 } }, limits({ floor: 8.9, ceiling: 9.1 }));
  assert.match(msg, /GBP 8\.9580 · USD 6\.6900/);
  assert.match(msg, /Alerts: GBP below 8\.9000 or above 9\.1000 · USD off/);
  assert.doesNotMatch(msg, /your (floor|ceiling)/);
});

test('ticker tape keeps the newest quotes first and skips repeats', () => {
  let tape = [];
  tape = appendTape(tape, { t: 1, GBP: 8.9 });
  tape = appendTape(tape, { t: 2, GBP: 8.91 });
  tape = appendTape(tape, { t: 2, GBP: 8.91 });
  assert.deepEqual(tape.map(s => s.t), [2, 1]);
  for (let t = 3; t < 30; t++) tape = appendTape(tape, { t });
  assert.equal(tape.length, TAPE_LENGTH);
  assert.equal(tape[0].t, 29);
});

test('price history keeps every new quote for 90 days, oldest first', () => {
  const day = 86400;
  let history = [];
  history = appendHistory(history, { t: day, GBP: 8.9, USD: 7.1 });
  history = appendHistory(history, { t: day, GBP: 8.9, USD: 7.1 });
  history = appendHistory(history, { t: 2 * day, GBP: 8.91, USD: 7.12 });
  assert.deepEqual(history, [[day, 8.9, 7.1], [2 * day, 8.91, 7.12]]);
  history = appendHistory(history, { t: (HISTORY_DAYS + 1.5) * day, GBP: 9, USD: 7.2 });
  assert.deepEqual(history.map(row => row[0]), [2 * day, (HISTORY_DAYS + 1.5) * day]);
});
