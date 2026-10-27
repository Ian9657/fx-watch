// The Worker end to end, with an in-memory KV and fake CITIC and Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

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
  const row = (curCode, sell) => ({ quotePriceDate: '2026年10月27日', quotePriceTime: time, curCode, cstexcSellPrice: String(sell * 100) });
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
  const day = [...store.map.keys()].find(k => k.startsWith('h:'));
  assert.deepEqual(store.json(day), [[store.json(day)[0][0], 8.91, 6.69]]);

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
