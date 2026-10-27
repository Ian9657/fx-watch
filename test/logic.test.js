import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCitic, TAPE_LENGTH, toRow, appendRow, splitByDay, tapeFrom, daysBack, beijingDay, evaluate, validLimit, migrate, alertMessage, testMessage, failingMessage, recoveredMessage } from '../src/logic.js';

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

test('repeats every 4 hours while the rate stays out, and says nothing coming back', () => {
  const l = limits({ floor: 8.9 }), h = 3600_000;
  let r = evaluate({ GBP: 8.8 }, l, none, {}, 0);
  assert.equal(r.alerts.length, 1);
  r = evaluate({ GBP: 8.8 }, l, r.alerted, r.sentAt, 3.9 * h);
  assert.equal(r.alerts.length, 0, 'not yet');
  r = evaluate({ GBP: 8.8 }, l, r.alerted, r.sentAt, 4 * h);
  assert.deepEqual(r.alerts.map(a => a.repeat), [true]);
  assert.match(alertMessage(r.alerts[0]), /still below your floor[\s\S]*every 4 hours/);
  // Four hours after that repeat, again.
  assert.equal(evaluate({ GBP: 8.8 }, l, r.alerted, r.sentAt, 7.9 * h).alerts.length, 0);
  assert.equal(evaluate({ GBP: 8.8 }, l, r.alerted, r.sentAt, 8 * h).alerts.length, 1);
  // Back inside: no message, and the clock is cleared.
  const back = evaluate({ GBP: 9.0 }, l, r.alerted, r.sentAt, 9 * h);
  assert.equal(back.alerts.length, 0);
  assert.equal(back.sentAt.GBP.floor, null);
});

test('a new limit alerts straight away, with no reset of the alert state', () => {
  const first = evaluate({ GBP: 8.8 }, limits({ floor: 8.9 }), none);
  assert.equal(first.alerted.GBP.floor, 8.9);
  // Still below the same floor: quiet.
  assert.equal(evaluate({ GBP: 8.7 }, limits({ floor: 8.9 }), first.alerted).alerts.length, 0);
  // Floor moved and the price is still below it: alerts for the new floor.
  const moved = evaluate({ GBP: 8.7 }, limits({ floor: 8.85 }), first.alerted);
  assert.deepEqual(moved.alerts.map(a => a.limit), [8.85]);
  // An alert state saved before limits were recorded (true) stays quiet.
  const old = { GBP: { floor: true, ceiling: false }, USD: { floor: false, ceiling: false } };
  assert.equal(evaluate({ GBP: 8.7 }, limits({ floor: 8.9 }), old).alerts.length, 0);
});

test('migrates settings saved before ceilings existed', () => {
  const data = migrate({ floors: { GBP: 8.9, USD: null }, alerted: { GBP: true, USD: false }, lastCheck: 1 });
  assert.deepEqual(data.limits, limits({ floor: 8.9 }));
  assert.deepEqual(data.alerted.GBP, { floor: true, ceiling: false });
  assert.equal(data.lastCheck, 1);
  assert.equal('floors' in data, false);
  assert.deepEqual(migrate({}).limits, limits({}));
  // The limit an alert was for survives a round trip.
  assert.deepEqual(migrate({ alerted: { GBP: { floor: 8.92, ceiling: false } } }).alerted.GBP, { floor: 8.92, ceiling: false });
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
  // No float noise: 893.41 / 100 would otherwise be 8.934099999999999.
  const noisy = parseCitic('cb(' + JSON.stringify({ content: { resultList: [row('014001', '666.34', '668.79'), row('012001', '889.14', '893.41')] } }) + ')');
  assert.equal(noisy.GBP.price, 8.9341);
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

test('each new quote is added to the day once, rounded to 4 places', () => {
  let rows = [];
  rows = appendRow(rows, toRow({ t: 1, GBP: 8.934099999999999, USD: 6.6879 }));
  const same = appendRow(rows, toRow({ t: 1, GBP: 8.9341, USD: 6.6879 }));
  assert.equal(same, rows); // unchanged, so nothing to write
  rows = appendRow(rows, toRow({ t: 2, GBP: 8.91, USD: 6.69 }));
  assert.deepEqual(rows, [[1, 8.9341, 6.6879], [2, 8.91, 6.69]]);
});

test('ticker tape is the newest quotes first', () => {
  const rows = Array.from({ length: 30 }, (_, t) => [t, 8 + t / 100, 7]);
  const tape = tapeFrom(rows);
  assert.equal(tape.length, TAPE_LENGTH);
  assert.deepEqual(tape[0], { t: 29, GBP: 8.29, USD: 7 });
  assert.equal(tape.at(-1).t, 18);
});

test('old single history splits into Beijing days', () => {
  // 15:59 and 16:01 UTC fall either side of Beijing midnight.
  const a = Date.UTC(2026, 9, 26, 15, 59) / 1000, b = Date.UTC(2026, 9, 26, 16, 1) / 1000;
  assert.deepEqual(Object.keys(splitByDay([[a, 1, 1], [b, 2, 2]])), ['2026-10-26', '2026-10-27']);
  assert.deepEqual(daysBack('2026-03-01', 3), ['2026-03-01', '2026-02-28', '2026-02-27']);
});

test('failure and recovery messages say how long alerts were off', () => {
  const msg = failingMessage({ count: 3, error: 'CITIC returned 503' });
  assert.match(msg, /failed 3 times in a row \(about 30 minutes\)/);
  assert.match(msg, /alerts are paused/);
  assert.match(msg, /CITIC returned 503/);
  assert.match(recoveredMessage({ count: 5 }), /after 5 failed checks \(about 50 minutes\)/);
});
