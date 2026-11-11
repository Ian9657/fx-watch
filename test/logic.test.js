import test from 'node:test';
import assert from 'node:assert/strict';
import { quietAt, validZone, parseCitic, CODES, PAIRS, fillLimits, TAPE_LENGTH, toRow, appendRow, normalizeDay, pairRows, hourly, splitByDay, tapeFrom, daysBack, beijingDay, evaluate, validLimit, migrate, alertMessage, testMessage, failingMessage, recoveredMessage, stepOf, stepAt } from '../src/logic.js';

const none = { GBP: { floor: false, ceiling: false }, USD: { floor: false, ceiling: false } };
const limits = (gbp, usd = {}) => ({
  GBP: { floor: null, ceiling: null, ...gbp },
  USD: { floor: null, ceiling: null, ...usd },
});

test('alerts once when a rate drops below its floor', () => {
  const first = evaluate({ GBP: 8.8, USD: 6.7 }, limits({ floor: 8.9 }), none);
  assert.deepEqual(first.alerts.map(a => [a.pair, a.side]), [['GBP', 'floor']]);
  const second = evaluate({ GBP: 8.8, USD: 6.7 }, limits({ floor: 8.9 }), first.alerted, first.sentAt, Date.now(), first.steps);
  assert.equal(second.alerts.length, 0);
});

test('alerts once when a rate rises above its ceiling', () => {
  const first = evaluate({ GBP: 9.1, USD: 6.7 }, limits({ ceiling: 9.0 }), none);
  assert.deepEqual(first.alerts.map(a => [a.pair, a.side]), [['GBP', 'ceiling']]);
  assert.equal(evaluate({ GBP: 9.1 }, limits({ ceiling: 9.0 }), first.alerted, first.sentAt, Date.now(), first.steps).alerts.length, 0);
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
  r = evaluate({ GBP: 8.8 }, l, r.alerted, r.sentAt, 3.9 * h, r.steps, r.sentRate);
  assert.equal(r.alerts.length, 0, 'not yet');
  // Due, but the same price as the last message: nothing new to say.
  assert.equal(evaluate({ GBP: 8.8 }, l, r.alerted, r.sentAt, 4 * h, r.steps, r.sentRate).alerts.length, 0);
  r = evaluate({ GBP: 8.801 }, l, r.alerted, r.sentAt, 4 * h, r.steps, r.sentRate);
  assert.deepEqual(r.alerts.map(a => a.repeat), [true]);
  assert.match(alertMessage(r.alerts[0]), /^GBP 8\.8010 · still below floor 8\.9000\n/);
  // Four hours after that repeat, again.
  assert.equal(evaluate({ GBP: 8.8 }, l, r.alerted, r.sentAt, 7.9 * h, r.steps, r.sentRate).alerts.length, 0);
  assert.equal(evaluate({ GBP: 8.8 }, l, r.alerted, r.sentAt, 8 * h, r.steps, r.sentRate).alerts.length, 1);
  // Back inside: no message, and the clock is cleared.
  const back = evaluate({ GBP: 9.0 }, l, r.alerted, r.sentAt, 9 * h, r.steps, r.sentRate);
  assert.equal(back.alerts.length, 0);
  assert.equal(back.sentAt.GBP.floor, null);
  assert.equal(back.steps.GBP.floor, 0);
  assert.equal(back.sentRate.GBP.floor, null);
});

test('a new limit alerts straight away, with no reset of the alert state', () => {
  const first = evaluate({ GBP: 8.8 }, limits({ floor: 8.9 }), none);
  assert.equal(first.alerted.GBP.floor, 8.9);
  // Still below the same floor: quiet.
  assert.equal(evaluate({ GBP: 8.8 }, limits({ floor: 8.9 }), first.alerted, first.sentAt, Date.now(), first.steps).alerts.length, 0);
  // Floor moved and the price is still below it: alerts for the new floor.
  const moved = evaluate({ GBP: 8.7 }, limits({ floor: 8.85 }), first.alerted);
  assert.deepEqual(moved.alerts.map(a => a.limit), [8.85]);
  // An alert state saved before limits were recorded (true) stays quiet.
  const old = { GBP: { floor: true, ceiling: false }, USD: { floor: false, ceiling: false } };
  assert.equal(evaluate({ GBP: 8.895 }, limits({ floor: 8.9 }), old).alerts.length, 0);
});

test('migrates settings saved before ceilings existed', () => {
  const data = migrate({ floors: { GBP: 8.9, USD: null }, alerted: { GBP: true, USD: false }, lastCheck: 1 });
  assert.deepEqual(data.limits, fillLimits({ GBP: { floor: 8.9 } }));
  assert.deepEqual(Object.keys(data.limits), PAIRS);
  assert.deepEqual(data.alerted.GBP, { floor: true, ceiling: false });
  assert.equal(data.lastCheck, 1);
  assert.equal('floors' in data, false);
  assert.deepEqual(migrate({}).limits, fillLimits());
  // The limit an alert was for survives a round trip.
  assert.deepEqual(migrate({ alerted: { GBP: { floor: 8.92, ceiling: false } } }).alerted.GBP, { floor: 8.92, ceiling: false });
});

test('alert message names the side that was crossed', () => {
  assert.match(alertMessage({ pair: 'GBP', side: 'ceiling', rate: 9.05, limit: 9 }), /^GBP 9\.0500 · above ceiling 9\.0000\n/);
  assert.match(alertMessage({ pair: 'USD', side: 'floor', rate: 6.6, limit: 6.65 }), /^USD 6\.6000 · below floor 6\.6500\n/);
  // Where it re-arms, 0.1% back inside the limit.
  assert.match(alertMessage({ pair: 'GBP', side: 'floor', rate: 8.8, limit: 8.9 }), /\nNext alert below 8\.8822 · resets above 8\.9089$/);
  assert.match(alertMessage({ pair: 'GBP', side: 'ceiling', rate: 9.05, limit: 9 }), /\nNext alert above 9\.0180 · resets below 8\.9910$/);
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
  assert.match(msg, /^Test · notifications are working\nUSD 6\.6900 · off\nGBP 8\.9580 · below 8\.9000 or above 9\.1000$/);
  assert.doesNotMatch(msg, /EUR/); // not in the feed this time
  assert.doesNotMatch(msg, /your (floor|ceiling)/);
});

test('each new quote is added to the day once, with every currency as quoted', () => {
  const quotes = { GBP: { sell: 893.41, buy: 886.7 }, USD: { sell: 668.79, buy: 666.34 }, JPY: { sell: 4.2364, buy: 4.1952 } };
  let rows = appendRow([], toRow(1, quotes));
  assert.equal(appendRow(rows, toRow(1, quotes)), rows); // unchanged, so nothing to write
  rows = appendRow(rows, toRow(2, quotes));
  assert.equal(rows.length, 2);
  const row = rows[0], n = CODES.length;
  assert.equal(row.length, 1 + 2 * n);
  assert.equal(row[1 + CODES.indexOf('JPY')], 4.2364);
  assert.equal(row[1 + n + CODES.indexOf('JPY')], 4.1952);
  assert.equal(row[1 + CODES.indexOf('EUR')], null); // not in this feed
  // The page's rows: per-unit sell prices, with no float noise.
  assert.deepEqual(pairRows({ codes: CODES, rows }, ['GBP', 'USD']), [[1, 8.9341, 6.6879], [2, 8.9341, 6.6879]]);
  // JPY in its own unit, per 100 as quoted.
  assert.deepEqual(pairRows({ codes: CODES, rows }, ['JPY']), [[1, 4.2364], [2, 4.2364]]);
});

test('reads day records kept before every currency was', () => {
  const old = normalizeDay([[1, 8.9341, 6.6879], [2, 8.91, null]]);
  assert.deepEqual(old.codes, CODES);
  assert.equal(old.rows[0][1 + CODES.indexOf('GBP')], 893.41);
  assert.deepEqual(pairRows(old, ['GBP', 'USD']), [[1, 8.9341, 6.6879], [2, 8.91, null]]);
  // Kept under another list of codes: laid out again by code.
  const other = normalizeDay({ codes: ['GBP', 'XYZ'], rows: [[3, 900, 1, 890, 2]] });
  assert.deepEqual(pairRows(other, ['GBP', 'USD']), [[3, 9, null]]);
  assert.equal(other.rows[0][1 + CODES.length + CODES.indexOf('GBP')], 890);
  assert.deepEqual(normalizeDay(null).rows, []);
});

test('a rollup keeps the last quote of each hour', () => {
  const h = 3600, rows = [[0], [600], [h - 1], [h], [2 * h + 5], [2 * h + 600]];
  assert.deepEqual(hourly(rows).map(r => r[0]), [h - 1, h, 2 * h + 600]);
  assert.deepEqual(hourly([]), []);
});

test('ticker tape is the newest quotes first', () => {
  const rows = Array.from({ length: 30 }, (_, t) => [t, ...PAIRS.map(p => p === 'GBP' ? 8 + t / 100 : 7)]);
  const tape = tapeFrom(rows);
  assert.equal(tape.length, TAPE_LENGTH);
  assert.deepEqual([tape[0].t, tape[0].GBP, tape[0].USD], [29, 8.29, 7]);
  assert.equal(tape.at(-1).t, 18);
});

test('old single history splits into Beijing days', () => {
  // 15:59 and 16:01 UTC fall either side of Beijing midnight.
  const a = Date.UTC(2026, 9, 26, 15, 59) / 1000, b = Date.UTC(2026, 9, 26, 16, 1) / 1000;
  assert.deepEqual(Object.keys(splitByDay([[a, 1, 1], [b, 2, 2]])), ['2026-10-26', '2026-10-27']);
  assert.deepEqual(daysBack('2026-03-01', 3), ['2026-03-01', '2026-02-28', '2026-02-27']);
});

test('failure and recovery messages say how long alerts were off', () => {
  assert.ok(!alertMessage({ pair: 'GBP', side: 'floor', rate: 8.8, limit: 8.9 }).includes('http'));
  assert.match(alertMessage({ pair: 'GBP', side: 'floor', rate: 8.8, limit: 8.9 }, 'https://a.example'), /\nhttps:\/\/a\.example$/);
  assert.match(failingMessage({ count: 3, error: 'x' }, 'https://a.example'), /\nhttps:\/\/a\.example$/);
  const msg = failingMessage({ count: 3, error: 'CITIC returned 503' });
  assert.match(msg, /^Price check failing · 3 in a row \(about 30 min\)\n/);
  assert.match(msg, /\nAlerts paused · last error: /);
  assert.match(msg, /CITIC returned 503/);
  assert.match(recoveredMessage({ count: 5 }), /^Price check working again · after 5 failures \(about 50 min\)\nAlerts back on$/);
});

test('a currency missing from one check keeps its alert state', () => {
  const first = evaluate({ GBP: 8.8, USD: 6.7 }, limits({ floor: 8.9 }), none);
  const gap = evaluate({ USD: 6.7 }, limits({ floor: 8.9 }), first.alerted, first.sentAt, Date.now(), first.steps);
  assert.equal(gap.alerts.length, 0);
  assert.equal(gap.alerted.GBP.floor, 8.9);
  // Back, still below: no second alert, as if it had never gone.
  assert.equal(evaluate({ GBP: 8.8, USD: 6.7 }, limits({ floor: 8.9 }), gap.alerted, gap.sentAt, Date.now(), gap.steps).alerts.length, 0);
});

test('yen is quoted and alerted per 100', () => {
  const feed = 'cb(' + JSON.stringify({ content: { resultList: [
    { quotePriceDate: '2026年11月03日', quotePriceTime: '21:00:00', curCode: '027001', cstexcBuyPrice: '4.1952', cstexcSellPrice: '4.2364' },
  ] } }) + ')';
  assert.equal(parseCitic(feed).JPY.price, 4.2364);
  assert.match(alertMessage({ pair: 'JPY', side: 'floor', rate: 4.2, limit: 4.25 }), /^100 JPY 4\.2000 · below floor 4\.2500\n/);
  assert.match(alertMessage({ pair: 'GBP', side: 'floor', rate: 8.8, limit: 8.9 }), /^GBP 8\.8000 · below floor 8\.9000\n/);
});

test('past the limit, each deeper 0.2% step alerts once, straight away', () => {
  const l = limits({ floor: 8.94 });
  // Steps of a floor at 8.94: 8.9400, 8.9221, 8.9042, ...
  let r = evaluate({ GBP: 8.939 }, l, none, {}, 0);
  assert.deepEqual(r.alerts.map(a => [a.step, a.further]), [[1, false]]);
  // Back up a little (not re-armed) and down again: nothing new.
  for (const rate of [8.941, 8.938, 8.93, 8.9222]) {
    r = evaluate({ GBP: rate }, l, r.alerted, r.sentAt, 3600_000, r.steps);
    assert.equal(r.alerts.length, 0, String(rate));
  }
  // Past 8.9221: the second step, without waiting for the 4-hour repeat.
  r = evaluate({ GBP: 8.922 }, l, r.alerted, r.sentAt, 2 * 3600_000, r.steps);
  assert.deepEqual(r.alerts.map(a => [a.step, a.further]), [[2, true]]);
  assert.match(alertMessage(r.alerts[0]), /^GBP 8\.9220 · past 8\.9221 \(floor −0\.2%\)\nNext alert below 8\.9042 · resets above 8\.9489$/);
  // The repeat clock restarts from that alert.
  assert.equal(evaluate({ GBP: 8.922 }, l, r.alerted, r.sentAt, 5.9 * 3600_000, r.steps).alerts.length, 0);
  assert.deepEqual(evaluate({ GBP: 8.922 }, l, r.alerted, r.sentAt, 6 * 3600_000, r.steps).alerts.map(a => [a.step, a.repeat]), [[2, true]]);
  // A jump past several steps sends one alert, for the deepest.
  const jump = evaluate({ GBP: 8.88 }, l, r.alerted, r.sentAt, 3 * 3600_000, r.steps);
  assert.deepEqual(jump.alerts.map(a => a.step), [4]);
  // Re-armed, the steps start again from the limit.
  const back = evaluate({ GBP: 8.96 }, l, jump.alerted, jump.sentAt, 4 * 3600_000, jump.steps);
  assert.equal(back.steps.GBP.floor, 0);
  assert.deepEqual(evaluate({ GBP: 8.939 }, l, back.alerted, back.sentAt, 5 * 3600_000, back.steps).alerts.map(a => a.step), [1]);
});

test('a ceiling steps up the same way', () => {
  const l = limits({ ceiling: 9.0 });
  let r = evaluate({ GBP: 9.001 }, l, none, {}, 0);
  r = evaluate({ GBP: 9.017 }, l, r.alerted, r.sentAt, 1, r.steps);
  assert.equal(r.alerts.length, 0);
  r = evaluate({ GBP: 9.0185 }, l, r.alerted, r.sentAt, 2, r.steps);
  assert.deepEqual(r.alerts.map(a => [a.step, a.further]), [[2, true]]);
  assert.match(alertMessage(r.alerts[0]), /^GBP 9\.0185 · past 9\.0180 \(ceiling \+0\.2%\)\nNext alert above 9\.0360 · resets below 8\.9910$/);
});

test('an alert state from before steps counts as the first step', () => {
  const sent = { GBP: { floor: 8.94, ceiling: false }, USD: { floor: false, ceiling: false } };
  const l = limits({ floor: 8.94 });
  assert.equal(evaluate({ GBP: 8.93 }, l, sent, { GBP: { floor: 0 } }, 1).alerts.length, 0);
  assert.deepEqual(evaluate({ GBP: 8.92 }, l, sent, { GBP: { floor: 0 } }, 1).alerts.map(a => a.step), [2]);
});

// The night of 10–11 Nov 2026, GBP every 20 minutes (UTC), floor 8.94: it
// alerted at 04:39, wobbled back over the floor without re-arming and fell
// on, and the next message waited for the 4-hour repeat at 08:49. Now the
// fall past 8.9221 alerts when it happens.
test('replay: 11 Nov 2026, the fall after the floor alert is told at once', () => {
  const night = [['04:09', 8.9411], ['04:39', 8.9398], ['05:09', 8.9438], ['05:49', 8.9403], ['06:09', 8.9383], ['06:29', 8.9358],
    ['06:49', 8.9326], ['07:09', 8.9375], ['07:29', 8.932], ['07:49', 8.9238], ['08:09', 8.9239], ['08:29', 8.9163], ['08:49', 8.9163]];
  const l = limits({ floor: 8.94 });
  let r = { alerted: none, sentAt: {}, steps: {} };
  const sent = [];
  for (const [hhmm, rate] of night) {
    r = evaluate({ GBP: rate }, l, r.alerted, r.sentAt, Date.parse(`2026-11-11T${hhmm}:00Z`), r.steps);
    sent.push(...r.alerts.map(a => `${hhmm} step ${a.step}${a.repeat ? ' repeat' : ''}`));
  }
  assert.deepEqual(sent, ['04:39 step 1', '08:29 step 2']);
});

test('the step a rate is past, at and around each step price', () => {
  assert.equal(stepOf('floor', 8.95, 8.94), 0);
  assert.equal(stepOf('floor', 8.94, 8.94), 0);
  for (let n = 1; n <= 30; n++) {
    const at = stepAt('floor', 8.94, n);
    assert.equal(stepOf('floor', at, 8.94), n - 1, `on step ${n}`);
    assert.equal(stepOf('floor', at - 1e-9, 8.94), n, `just past step ${n}`);
    const up = stepAt('ceiling', 9.0, n);
    assert.equal(stepOf('ceiling', up, 9.0), n - 1);
    assert.equal(stepOf('ceiling', up + 1e-9, 9.0), n);
  }
  // A glitch in the feed (a price 100 times too big) is worked out, not counted up to.
  assert.equal(stepOf('ceiling', 900, 9.0), 1 + Math.floor((900 - 9) / (9 * 0.002)));
});

// Last weekend, GBP every 10 minutes from Friday night (UTC), with a floor
// just above it: the price barely moved, and every reminder repeated it.
test('replay: a quiet weekend below the floor sends no reminder of the same price', () => {
  const l = limits({ floor: 8.955 }), h = 3600_000;
  let r = evaluate({ GBP: 8.9491 }, l, none, {}, 0);
  const sent = [];
  for (let t = 10 * 60_000; t <= 48 * h; t += 10 * 60_000) {
    r = evaluate({ GBP: t < 47 * h ? 8.9491 : 8.9538 }, l, r.alerted, r.sentAt, t, r.steps, r.sentRate);
    sent.push(...r.alerts.map(a => a.rate));
  }
  assert.deepEqual(sent, [8.9538]); // only once the price moved
});

test('quiet hours run 23:00 to 07:00 on the given clock, and need a known time zone', () => {
  const at = iso => Date.parse(iso);
  assert.equal(quietAt(at('2026-11-11T04:39Z'), 'Europe/London'), true);
  assert.equal(quietAt(at('2026-11-11T07:00Z'), 'Europe/London'), false);
  assert.equal(quietAt(at('2026-11-11T22:59Z'), 'Europe/London'), false);
  assert.equal(quietAt(at('2026-11-11T23:00Z'), 'Europe/London'), true);
  assert.equal(quietAt(at('2026-11-11T04:39Z'), 'Asia/Shanghai'), false); // 12:39 there
  assert.equal(quietAt(at('2026-07-01T06:30Z'), 'Europe/London'), false); // 07:30 in summer time
  assert.equal(quietAt(at('2026-11-11T04:39Z'), null), false);
  assert.equal(validZone('Not/AZone'), false);
});
