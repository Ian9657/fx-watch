// The Worker end to end, with an in-memory KV and fake CITIC and Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { CODES, pairRows, daysBack, beijingDay } from '../src/logic.js';

// Cloudflare's Workers runtime has this; Node doesn't.
crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function fakeKV(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const writes = [];
  return {
    map, writes,
    async get(key, type) { const v = map.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { writes.push(key); map.set(key, value); },
    async delete(key) { map.delete(key); },
    json: key => JSON.parse(map.get(key)),
  };
}

// CITIC's JSONP feed for one quote of each currency, at a Beijing time.
function citicFeed(gbp, usd, time = '20:33:52') {
  const row = (curCode, sell) => ({ quotePriceDate: '2026年10月27日', quotePriceTime: time, curCode, cstexcSellPrice: (sell * 100).toFixed(2), cstexcBuyPrice: (sell * 99).toFixed(2) });
  return 'cb(' + JSON.stringify({ content: { resultList: [row('012001', gbp), row('014001', usd)] } }) + ')';
}

// Route fetch: CITIC answers with `feed()` (or fails if it returns null);
// Telegram messages are collected in `sent`.
function network(feed) {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('citicbank')) {
      const text = feed();
      return text == null ? new Response('down', { status: 503 }) : new Response(text);
    }
    if (String(url).includes('telegram')) {
      sent.push(JSON.parse(options.body).text);
      return new Response('{}');
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return sent;
}

const env = store => ({ STORE: store, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c', EDIT_PASSWORD: 'pw' });
const run = async e => {
  let job;
  await worker.scheduled({}, e, { waitUntil: p => { job = p; } });
  return job.catch(err => err);
};
const limits = { GBP: { floor: 8.92, ceiling: 8.98 }, USD: { floor: null, ceiling: null } };

test('a check alerts once per crossing and records the quote once', async () => {
  const store = fakeKV({ limits });
  const e = env(store);
  const sent = network(() => citicFeed(8.91, 6.69));
  await run(e);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /GBP is below your floor/);
  assert.equal(store.json('data').alerted.GBP.floor, 8.92);
  const day = store.json('h:2026-10-27');
  assert.equal(day.rows.length, 1);
  assert.deepEqual(pairRows(day, ['GBP', 'USD']), [[day.rows[0][0], 8.91, 6.69]]);

  // Same quote again: no new alert and no write to the day's history.
  store.writes.length = 0;
  await run(e);
  assert.equal(sent.length, 1);
  assert.deepEqual(store.writes, ['data']);
});

test('saving limits during a check is not overwritten by it', async () => {
  const store = fakeKV({ limits });
  const e = env(store);
  network(() => citicFeed(8.95, 6.69));
  const realPut = store.put;
  // Save new limits in the middle of the check, as a user might.
  let saved;
  store.put = async (key, value) => {
    if (key === 'data') saved = await worker.fetch(new Request('https://x/api/settings', {
      method: 'PUT', headers: { Authorization: 'Bearer pw' },
      body: JSON.stringify({ limits: { ...limits, GBP: { floor: 8.9, ceiling: 9 } } }),
    }), e);
    return realPut.call(store, key, value);
  };
  await run(e);
  assert.equal(saved.status, 200);
  assert.deepEqual(store.json('limits').GBP, { floor: 8.9, ceiling: 9 });
});

test('a check that keeps failing is reported once, and its recovery', async () => {
  const store = fakeKV({ limits });
  const e = env(store);
  let up = false;
  const sent = network(() => up ? citicFeed(8.95, 6.69) : null);
  for (let i = 0; i < 4; i++) assert.match((await run(e)).message, /CITIC returned 503/);
  assert.equal(sent.length, 1, 'one report, not one per failure');
  assert.match(sent[0], /failed 3 times in a row/);
  assert.equal(store.json('data').failing.count, 4);

  up = true;
  await run(e);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /working again after 4 failed checks/);
  assert.equal(store.json('data').failing, undefined);
});

test("today's change starts from the page's own midnight", async () => {
  // Quotes at 23:00 and 01:00 UK time on 26/27 Oct (GMT), both on the
  // Beijing day of the 27th.
  const late = Date.UTC(2026, 9, 26, 23) / 1000, early = Date.UTC(2026, 9, 27, 1) / 1000;
  const store = fakeKV({ limits, 'h:2026-10-27': [[late, 8.9, 6.6], [early, 8.95, 6.65]] });
  network(() => citicFeed(8.96, 6.66));
  const rates = since => worker.fetch(new Request(`https://x/api/rates?since=${since}`, { headers: { Authorization: 'Bearer pw' } }), env(store)).then(r => r.json());
  // UK midnight: yesterday's close is the 23:00 quote.
  assert.equal((await rates(Date.UTC(2026, 9, 27) / 1000)).GBP.previousClose, 8.9);
  // A midnight two hours later (further west): the 01:00 quote.
  assert.equal((await rates(Date.UTC(2026, 9, 27, 2) / 1000)).GBP.previousClose, 8.95);
});

// A day record of GBP quotes at the given times (epoch seconds).
const dayOf = (times, gbp = 8.9) => ({ codes: CODES, rows: times.map(t => [t, ...CODES.map(c => c === 'GBP' ? gbp * 100 : null), ...CODES.map(() => null)]) });
const get = (store, path) => worker.fetch(new Request(`https://x${path}`, { headers: { Authorization: 'Bearer pw' } }), env(store));

test("once a day is over, the check keeps an hourly rollup of it, once", async () => {
  const [, yesterday] = daysBack(beijingDay(Date.now()), 2);
  const t0 = Date.parse(`${yesterday}T00:00:00+08:00`) / 1000;
  const store = fakeKV({ limits, [`h:${yesterday}`]: dayOf([t0, t0 + 600, t0 + 3600, t0 + 4200]) });
  network(() => citicFeed(8.95, 6.69));
  await run(env(store));
  assert.deepEqual(store.json(`r:${yesterday}`).rows.map(r => r[0]), [t0 + 600, t0 + 4200]);
  store.writes.length = 0;
  await run(env(store));
  assert.ok(!store.writes.includes(`r:${yesterday}`));
});

test('the chart gets the last week in full and hourly before; the CSV every quote', async () => {
  const days = daysBack(beijingDay(Date.now()), 12);
  const at = day => Date.parse(`${day}T09:00:00+08:00`) / 1000;
  const recent = days[2], old = days[10]; // within FULL_DAYS, and before it
  const store = fakeKV({
    [`h:${recent}`]: dayOf([at(recent), at(recent) + 600]),
    [`h:${old}`]: dayOf([at(old), at(old) + 600, at(old) + 1200]), // no rollup kept
    [`h:${days[11]}`]: [[at(days[11]), 8.8, 6.6]], // the old layout
  });
  const { pairs, history: chart } = await (await get(store, '/api/history')).json();
  assert.deepEqual(chart.map(r => r[0]), [at(days[11]), at(old) + 1200, at(recent), at(recent) + 600]);
  assert.deepEqual([chart[0][1 + pairs.indexOf('GBP')], chart[0][1 + pairs.indexOf('USD')]], [8.8, 6.6]);
  const full = (await (await get(store, `/api/history?from=${days[11]}&to=${days[0]}`)).json()).history;
  assert.equal(full.length, 6);
  assert.equal((await get(store, `/api/history?from=${days[11]}T&to=${days[0]}`)).status, 400);
  assert.equal((await get(store, `/api/history?from=${daysBack(days[0], 17)[16]}&to=${days[0]}`)).status, 400);
});

test('saving one currency keeps the others', async () => {
  const store = fakeKV({ limits: { ...limits, EUR: { floor: 7.4, ceiling: null } } });
  const put = body => worker.fetch(new Request('https://x/api/settings', { method: 'PUT', headers: { Authorization: 'Bearer pw' }, body: JSON.stringify(body) }), env(store));
  assert.equal((await put({ limits: { GBP: { floor: 8.9, ceiling: 9 } } })).status, 200);
  const saved = store.json('limits');
  assert.deepEqual(saved.GBP, { floor: 8.9, ceiling: 9 });
  assert.deepEqual(saved.EUR, { floor: 7.4, ceiling: null });
  assert.deepEqual(saved.JPY, { floor: null, ceiling: null });
  assert.equal((await put({ limits: { JPY: { floor: 4.3, ceiling: 4.2 } } })).status, 400);
});

test('the knob is saved with the settings, one to four currencies', async () => {
  const store = fakeKV({ limits });
  const put = body => worker.fetch(new Request('https://x/api/settings', { method: 'PUT', headers: { Authorization: 'Bearer pw' }, body: JSON.stringify(body) }), env(store));
  assert.deepEqual((await (await get(store, '/api/settings')).json()).knob, ['GBP', 'USD']);
  assert.equal((await put({ knob: ['USD', 'JPY', 'EUR'] })).status, 200);
  assert.deepEqual((await (await get(store, '/api/settings')).json()).knob, ['USD', 'JPY', 'EUR']);
  for (const knob of [[], ['USD', 'USD'], ['USD', 'GBP', 'EUR', 'JPY', 'HKD'], ['XYZ']]) {
    assert.equal((await put({ knob })).status, 400);
  }
  assert.deepEqual(store.json('knob'), ['USD', 'JPY', 'EUR']);
  assert.deepEqual(store.json('limits').GBP, limits.GBP); // limits left out stay as they were
});

test('API requests over the limit are refused before the password is checked', async () => {
  let left = 2;
  const e = { ...env(fakeKV({ limits })), API_LIMIT: { limit: async ({ key }) => { assert.equal(key, '1.2.3.4'); return { success: left-- > 0 }; } } };
  const call = pw => worker.fetch(new Request('https://x/api/settings', { headers: { Authorization: `Bearer ${pw}`, 'CF-Connecting-IP': '1.2.3.4' } }), e);
  assert.equal((await call('wrong')).status, 401);
  assert.equal((await call('pw')).status, 200);
  assert.equal((await call('pw')).status, 429);
});

test('a site with no password, or the example one, says so and lets nobody in', async () => {
  for (const EDIT_PASSWORD of [undefined, '', 'choose-a-password']) {
    const e = { ...env(fakeKV({ limits })), EDIT_PASSWORD };
    const res = await worker.fetch(new Request('https://x/api/settings', { headers: { Authorization: `Bearer ${EDIT_PASSWORD}` } }), e);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /EDIT_PASSWORD is not set/);
  }
});

test('alerts link to the address the site was opened on, and to nothing before that', async () => {
  const sent = network(() => citicFeed(8.91, 6.69));
  const store = fakeKV({ limits });
  await run(env(store));
  assert.ok(!sent[0].includes('http'));
  await worker.fetch(new Request('https://my.example/api/settings', { headers: { Authorization: 'Bearer pw' } }), env(store));
  assert.equal(await store.get('site'), 'https://my.example');
  // Opened on another address, it stays; saving from it moves it.
  await worker.fetch(new Request('https://other.example/api/settings', { headers: { Authorization: 'Bearer pw' } }), env(store));
  assert.equal(await store.get('site'), 'https://my.example');
  await worker.fetch(new Request('https://new.example/api/settings', { method: 'PUT', headers: { Authorization: 'Bearer pw' }, body: JSON.stringify({ limits }) }), env(store));
  assert.equal(await store.get('site'), 'https://new.example');
  const later = fakeKV({ limits });
  await later.put('site', 'https://my.example');
  const again = network(() => citicFeed(8.91, 6.69));
  await run(env(later));
  assert.match(again[0], /\nhttps:\/\/my\.example$/);
});

test('a missing Telegram secret is named in the alert error', async () => {
  network(() => citicFeed(8.91, 6.69));
  const store = fakeKV({ limits });
  await run({ STORE: store, EDIT_PASSWORD: 'pw' });
  assert.match(store.json('data').alertError.error, /TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set/);
});

test('the demo page is public, and no API route is', async () => {
  const assets = [];
  const e = { ...env(fakeKV({ limits })), ASSETS: { fetch: async r => { assets.push(new URL(r.url).pathname); return new Response('page'); } } };
  assert.equal(await (await worker.fetch(new Request('https://x/demo'), e)).text(), 'page');
  assert.deepEqual(assets, ['/']);
  assert.equal((await worker.fetch(new Request('https://x/api/demo'), e)).status, 401);
});

test('a check carries on when a currency is missing, and fails when all are', async () => {
  const store = fakeKV({ limits });
  const usdOnly = 'cb(' + JSON.stringify({ content: { resultList: [{ quotePriceDate: '2026年10月27日', quotePriceTime: '20:00:00', curCode: '014001', cstexcSellPrice: '669.00', cstexcBuyPrice: '666.00' }] } }) + ')';
  network(() => usdOnly);
  assert.equal(await run(env(store)), undefined);
  assert.deepEqual(Object.keys(store.json('data').lastCheck.rates), ['USD']);
  network(() => 'cb({"content":{"resultList":[]}})');
  assert.match((await run(env(store))).message, /No CITIC price/);
});

test('a deeper step that Telegram fails to send is sent on the next check', async () => {
  const store = fakeKV({ limits });
  const e = env(store);
  let gbp = 8.919, telegramUp = true;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('citicbank')) return new Response(citicFeed(gbp, 6.69));
    if (!telegramUp) return new Response('down', { status: 502 });
    sent.push(JSON.parse(options.body).text);
    return new Response('{}');
  };
  await run(e); // past the floor 8.92: step 1
  assert.equal(store.json('data').steps.GBP.floor, 1);
  gbp = 8.9; telegramUp = false; // past 8.9022: step 2, not delivered
  await run(e);
  assert.equal(store.json('data').steps.GBP.floor, 1);
  telegramUp = true;
  await run(e);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /GBP fell further below your floor[\s\S]*Past step 2: 8\.9022/);
  assert.equal(store.json('data').steps.GBP.floor, 2);
});
