import { PAIRS, RANGES, parseChart, validFloor, evaluate, alertMessage } from './logic.js';

const EMPTY = { floors: { GBP: null, USD: null }, alerted: { GBP: false, USD: false }, lastCheck: null };

async function load(env) {
  return { ...EMPTY, ...(await env.STORE.get('data', 'json')) };
}

async function save(env, data) {
  await env.STORE.put('data', JSON.stringify(data));
}

async function fetchChart(pair, range = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}CNY=X?interval=${RANGES[range]}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Rate source returned ${res.status}`);
  return parseChart(await res.json());
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
  const quotes = await Promise.all(PAIRS.map(p => fetchChart(p)));
  const rates = Object.fromEntries(PAIRS.map((p, i) => [p, quotes[i].price]));
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
    const quotes = await Promise.all(PAIRS.map(p => fetchChart(p)));
    return json(Object.fromEntries(PAIRS.map((p, i) => {
      const { price, time, previousClose } = quotes[i];
      return [p, { price, time, previousClose }];
    })));
  }

  if (path === '/api/history') {
    const url = new URL(request.url);
    const pair = url.searchParams.get('pair');
    const range = url.searchParams.get('range');
    if (!PAIRS.includes(pair) || !RANGES[range]) return json({ error: 'Bad pair or range' }, 400);
    return json((await fetchChart(pair, range)).points);
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
    const { price } = await fetchChart('GBP');
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
