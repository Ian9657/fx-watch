import { PAIRS, RANGES, parseCitic, beijingDay, validFloor, evaluate, alertMessage } from './logic.js';

const EMPTY = { floors: { GBP: null, USD: null }, alerted: { GBP: false, USD: false }, lastCheck: null };

async function load(env) {
  return { ...EMPTY, ...(await env.STORE.get('data', 'json')) };
}

async function save(env, data) {
  await env.STORE.put('data', JSON.stringify(data));
}

const DAY = 86400 * 1000;

// The same feed that powers the rate table on citicbank.com.
async function fetchCitic() {
  const res = await fetch('https://etrade.citicbank.com/portalweb/cms/getForeignExchRate.htm?callback=cb', {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.citicbank.com/' },
  });
  if (!res.ok) throw new Error(`CITIC returned ${res.status}`);
  return parseCitic(await res.text());
}

// CITIC has no public history, so every check is recorded:
// `day:YYYY-MM-DD` holds that day's samples, `daily` the last sample of each day.
async function record(env, quotes) {
  const t = Math.max(...PAIRS.map(p => quotes[p].time));
  const sample = { t, ...Object.fromEntries(PAIRS.map(p => [p, quotes[p].price])) };
  const day = beijingDay(t * 1000);

  const samples = (await env.STORE.get(`day:${day}`, 'json')) || [];
  if (samples.at(-1)?.t === t) return;
  samples.push(sample);
  const daily = ((await env.STORE.get('daily', 'json')) || []).filter(d => d.d !== day);
  daily.push({ d: day, ...sample });
  await Promise.all([
    env.STORE.put(`day:${day}`, JSON.stringify(samples), { expirationTtl: 8 * 86400 }),
    env.STORE.put('daily', JSON.stringify(daily.slice(-400))),
  ]);
}

async function history(env, pair, range) {
  const now = Date.now();
  const days = RANGES[range];
  const daily = (await env.STORE.get('daily', 'json')) || [];
  const since = daily[0]?.d ?? null;
  let rows;
  if (days <= 5) {
    // Intraday samples, one KV key per Beijing day.
    const keys = Array.from({ length: days + 1 }, (_, i) => `day:${beijingDay(now - (days - i) * DAY)}`);
    rows = (await Promise.all(keys.map(k => env.STORE.get(k, 'json')))).flatMap(r => r || []);
    rows = rows.filter(r => r.t * 1000 >= now - days * DAY);
  } else {
    const cutoff = beijingDay(now - days * DAY);
    rows = daily.filter(r => r.d >= cutoff);
  }
  return { since, points: rows.map(r => ({ t: r.t, rate: r[pair] })) };
}

async function sendTelegram(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
  if (!res.ok) throw new Error(`Telegram returned ${res.status}`);
}

async function authorized(request, env) {
  const given = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (!env.EDIT_PASSWORD) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, env.EDIT_PASSWORD].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function check(env) {
  const data = await load(env);
  const quotes = await fetchCitic();
  await record(env, quotes);
  const rates = Object.fromEntries(PAIRS.map(p => [p, quotes[p].price]));
  const { alerts, alerted } = evaluate(rates, data.floors, data.alerted);
  for (const alert of alerts) {
    try {
      await sendTelegram(env, alertMessage(alert));
    } catch (err) {
      alerted[alert.pair] = false; // retry on the next check
      console.error(err.message);
    }
  }
  await save(env, { ...data, alerted, lastCheck: { time: Date.now(), rates } });
}

async function api(request, env, path) {
  if (path === '/api/rates') {
    const [quotes, daily] = await Promise.all([fetchCitic(), env.STORE.get('daily', 'json')]);
    // Previous close = last recorded price from an earlier Beijing day.
    const today = beijingDay(Date.now());
    const prev = (daily || []).filter(d => d.d < today).at(-1);
    return json(Object.fromEntries(PAIRS.map(p => [p, { ...quotes[p], previousClose: prev?.[p] ?? null }])));
  }

  if (path === '/api/history') {
    const url = new URL(request.url);
    const pair = url.searchParams.get('pair');
    const range = url.searchParams.get('range');
    if (!PAIRS.includes(pair) || !RANGES[range]) return json({ error: 'Bad pair or range' }, 400);
    return json(await history(env, pair, range));
  }

  if (path === '/api/settings' && request.method === 'GET') {
    const { floors, lastCheck } = await load(env);
    return json({ floors, lastCheck });
  }

  if (path === '/api/settings' && request.method === 'PUT') {
    if (!(await authorized(request, env))) return json({ error: 'Wrong password' }, 401);
    const body = await request.json().catch(() => ({}));
    const floors = {};
    for (const p of PAIRS) {
      const v = body.floors?.[p] ?? null;
      if (!validFloor(v)) return json({ error: `Invalid floor for ${p}` }, 400);
      floors[p] = v;
    }
    const data = await load(env);
    // A changed floor starts fresh, so it can alert straight away.
    const alerted = { ...data.alerted };
    for (const p of PAIRS) if (floors[p] !== data.floors[p]) alerted[p] = false;
    await save(env, { ...data, floors, alerted });
    return json({ floors });
  }

  if (path === '/api/test' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'Wrong password' }, 401);
    // Send a real-looking alert so the format can be checked.
    const { price } = (await fetchCitic()).GBP;
    const { floors } = await load(env);
    await sendTelegram(env, `[Test]\n${alertMessage({ pair: 'GBP', rate: price, floor: floors.GBP ?? price })}`);
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, path);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env));
  },
};
