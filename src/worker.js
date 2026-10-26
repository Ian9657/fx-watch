import { PAIRS, SIDES, parseCitic, beijingDay, validLimit, migrate, evaluate, alertMessage, testMessage } from './logic.js';

async function load(env) {
  return { lastCheck: null, ...migrate((await env.STORE.get('data', 'json')) || {}) };
}

async function save(env, data) {
  await env.STORE.put('data', JSON.stringify(data));
}

// The same feed that powers the rate table on citicbank.com.
async function fetchCitic() {
  const res = await fetch('https://etrade.citicbank.com/portalweb/cms/getForeignExchRate.htm?callback=cb', {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.citicbank.com/' },
  });
  if (!res.ok) throw new Error(`CITIC returned ${res.status}`);
  return parseCitic(await res.text());
}

// Keep the last price of each Beijing day, for the change vs. yesterday.
async function record(env, quotes) {
  const t = Math.max(...PAIRS.map(p => quotes[p].time));
  const day = beijingDay(t * 1000);
  const daily = (await env.STORE.get('daily', 'json')) || [];
  if (daily.at(-1)?.t === t) return;
  const next = daily.filter(d => d.d !== day);
  next.push({ d: day, t, ...Object.fromEntries(PAIRS.map(p => [p, quotes[p].price])) });
  await env.STORE.put('daily', JSON.stringify(next.slice(-30)));
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
  const { alerts, alerted } = evaluate(rates, data.limits, data.alerted);
  for (const alert of alerts) {
    try {
      await sendTelegram(env, alertMessage(alert));
    } catch (err) {
      alerted[alert.pair][alert.side] = false; // retry on the next check
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

  if (path === '/api/settings' && request.method === 'GET') {
    const { limits, lastCheck } = await load(env);
    return json({ limits, lastCheck });
  }

  if (path === '/api/settings' && request.method === 'PUT') {
    if (!(await authorized(request, env))) return json({ error: 'Wrong password' }, 401);
    const body = await request.json().catch(() => ({}));
    const limits = {};
    for (const p of PAIRS) {
      limits[p] = {};
      for (const side of SIDES) {
        const v = body.limits?.[p]?.[side] ?? null;
        if (!validLimit(v)) return json({ error: `Invalid ${side} for ${p}` }, 400);
        limits[p][side] = v;
      }
      const { floor, ceiling } = limits[p];
      if (floor != null && ceiling != null && floor >= ceiling) {
        return json({ error: `${p} floor must be lower than its ceiling` }, 400);
      }
    }
    const data = await load(env);
    // A changed limit starts fresh, so it can alert straight away.
    const alerted = structuredClone(data.alerted);
    for (const p of PAIRS) for (const side of SIDES) {
      if (limits[p][side] !== data.limits[p][side]) alerted[p][side] = false;
    }
    await save(env, { ...data, limits, alerted });
    return json({ limits });
  }

  if (path === '/api/test' && request.method === 'POST') {
    if (!(await authorized(request, env))) return json({ error: 'Wrong password' }, 401);
    const [quotes, { limits }] = await Promise.all([fetchCitic(), load(env)]);
    await sendTelegram(env, testMessage(quotes, limits));
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
