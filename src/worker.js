import { PAIRS, SIDES, parseCitic, HISTORY_DAYS, FULL_DAYS, DAY_TTL, dayKey, rollupKey, toRow, normalizeDay, pairRows, hourly, appendRow, splitByDay, tapeFrom, daysBack, beijingDay, validLimit, validKnob, KNOB, migrate, fillLimits, evaluate, alertMessage, testMessage, FAIL_ALERT_AFTER, failingMessage, recoveredMessage, REARM } from './logic.js';

// The currencies on the knob ('knob'), written only when you save settings.
async function readKnob(env) {
  const knob = await env.STORE.get('knob', 'json');
  return validKnob(knob) ? knob : KNOB;
}

// Two records, each with one writer, so neither can overwrite the other:
// 'limits' is written only when you save settings, and 'data' (alert state
// and the last check) only by the 10-minute check. Limits saved before the
// split are moved to 'limits' the first time they're read.
async function load(env) {
  let [data, limits] = await Promise.all([env.STORE.get('data', 'json'), env.STORE.get('limits', 'json')]);
  const old = migrate(data || {});
  // First read after the split: move the limits into their own record, once.
  if (!limits && data?.limits) {
    limits = old.limits;
    await env.STORE.put('limits', JSON.stringify(limits));
  }
  // Alert state from before the split says only true, not which limit it was
  // for; that was the limit saved alongside it.
  const alerted = Object.fromEntries(PAIRS.map(p => [p, Object.fromEntries(SIDES.map(side => {
    const sent = old.alerted[p][side];
    return [side, sent === true ? old.limits[p][side] ?? false : sent];
  }))]));
  return { lastCheck: old.lastCheck ?? null, alerted, limits: fillLimits(limits || old.limits), failing: data?.failing ?? null, alertError: data?.alertError ?? null, sentAt: data?.sentAt ?? {} };
}

// The same feed that powers the rate table on citicbank.com.
async function fetchCitic() {
  const res = await fetch('https://etrade.citicbank.com/portalweb/cms/getForeignExchRate.htm?callback=cb', {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.citicbank.com/' },
  });
  if (!res.ok) throw new Error(`CITIC returned ${res.status}`);
  return parseCitic(await res.text());
}

const readDay = async (env, day) => normalizeDay(await env.STORE.get(dayKey(day), 'json'));
const writeDay = (env, day, record) => env.STORE.put(dayKey(day), JSON.stringify(record), { expirationTtl: DAY_TTL });

// Add a new quote to today's history record: one write, and none when the
// quote hasn't changed since the last check.
async function record(env, quotes) {
  const t = Math.max(...Object.values(quotes).map(q => q.time));
  const day = beijingDay(t * 1000);
  const rec = await readDay(env, day);
  const rows = appendRow(rec.rows, toRow(t, quotes));
  if (rows !== rec.rows) await writeDay(env, day, { ...rec, rows });
}

// Once a day is over, keep its rollup (logic.js): one write a day.
async function rollUp(env) {
  const day = daysBack(beijingDay(Date.now()), 2)[1];
  if (await env.STORE.get(rollupKey(day))) return;
  const rec = await readDay(env, day);
  await env.STORE.put(rollupKey(day), JSON.stringify({ ...rec, rows: hourly(rec.rows) }), { expirationTtl: DAY_TTL });
}

// A past day for the chart: its rollup, or the day hourly if it has none.
async function readRollup(env, day) {
  const kept = await env.STORE.get(rollupKey(day), 'json');
  if (kept) return normalizeDay(kept);
  const rec = await readDay(env, day);
  return { ...rec, rows: hourly(rec.rows) };
}

// History used to be one record for all 90 days, with the last price of
// each day and the tape kept separately. Move it into day records once.
async function splitOldHistory(env) {
  const old = await env.STORE.get('history', 'json');
  if (!old) return;
  for (const [day, rows] of Object.entries(splitByDay(old))) {
    const have = await readDay(env, day);
    const merged = [...normalizeDay(rows).rows, ...have.rows].sort((a, b) => a[0] - b[0]).filter((r, i, all) => r[0] !== all[i - 1]?.[0]);
    await writeDay(env, day, { ...have, rows: merged });
  }
  await Promise.all(['history', 'daily', 'tape'].map(key => env.STORE.delete(key)));
}

// The most recent rows before now: today's, and earlier days' if today has
// fewer than `want` so far (quiet weekends included).
async function recentRows(env, want) {
  let rows = [];
  for (const day of daysBack(beijingDay(Date.now()), 8)) {
    rows = [...pairRows(await readDay(env, day)), ...rows];
    if (rows.length >= want) break;
  }
  return rows;
}

// The last price recorded before `before` (epoch seconds): yesterday's
// close, for the page's change today. The page sends its own midnight;
// without one, Beijing midnight.
async function previousClose(env, before) {
  for (const day of daysBack(beijingDay(before * 1000), 8)) {
    const row = pairRows(await readDay(env, day)).filter(r => r[0] < before).at(-1);
    if (row) return row;
  }
  return null;
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

// The 10-minute check: record the quote, send any alerts, and keep a note of
// failures so that a check that keeps failing is reported (see logic.js).
async function check(env) {
  const data = await load(env);
  try {
    await splitOldHistory(env);
    const quotes = await fetchCitic();
    await record(env, quotes);
    await rollUp(env);
    const rates = Object.fromEntries(PAIRS.filter(p => quotes[p]).map(p => [p, quotes[p].price]));
    const { alerts, alerted, sentAt } = evaluate(rates, data.limits, data.alerted, data.sentAt);
    let alertError = alerts.length ? null : data.alertError;
    for (const alert of alerts) {
      try {
        await sendTelegram(env, alertMessage(alert));
      } catch (err) {
        // Retry on the next check: a first alert as if never sent, a repeat
        // as if not yet due.
        if (alert.repeat) sentAt[alert.pair][alert.side] = data.sentAt[alert.pair]?.[alert.side] ?? null;
        else alerted[alert.pair][alert.side] = false;
        alertError = { time: Date.now(), error: err.message };
        console.error(err.message);
      }
    }
    if (data.failing?.told) await sendTelegram(env, recoveredMessage(data.failing)).catch(err => console.error(err.message));
    await env.STORE.put('data', JSON.stringify({ alerted, sentAt, lastCheck: { time: Date.now(), rates }, alertError }));
  } catch (err) {
    const failing = {
      since: data.failing?.since ?? Date.now(),
      count: (data.failing?.count ?? 0) + 1,
      error: err.message,
      told: data.failing?.told ?? false,
    };
    if (failing.count >= FAIL_ALERT_AFTER && !failing.told) {
      failing.told = await sendTelegram(env, failingMessage(failing)).then(() => true, () => false);
    }
    await env.STORE.put('data', JSON.stringify({ alerted: data.alerted, sentAt: data.sentAt, lastCheck: data.lastCheck, alertError: data.alertError, failing }));
    throw err; // logged by Cloudflare as a failed run
  }
}

async function api(request, env, path) {
  // The whole app is private: every API call needs the password.
  if (!(await authorized(request, env))) return json({ error: 'Locked' }, 401);

  if (path === '/api/rates') {
    const since = Number(new URL(request.url).searchParams.get('since'));
    const before = since > 0 ? since : Date.parse(`${beijingDay(Date.now())}T00:00:00+08:00`) / 1000;
    const [quotes, prev] = await Promise.all([fetchCitic(), previousClose(env, before)]);
    return json(Object.fromEntries(PAIRS.flatMap((p, i) => quotes[p] ? [[p, { ...quotes[p], previousClose: prev?.[i + 1] ?? null }]] : [])));
  }

  if (path === '/api/history') {
    // ?from=&to= (Beijing days, at most 16): every quote, for the CSV.
    // Otherwise the chart's: the last FULL_DAYS in full, hourly before.
    const q = new URL(request.url).searchParams, from = q.get('from'), to = q.get('to');
    let reads;
    if (from || to) {
      const span = (Date.parse(to) - Date.parse(from)) / 86400_000;
      if (!/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to) || !(span >= 0 && span < 16)) return json({ error: 'from and to must be days at most 15 apart' }, 400);
      reads = daysBack(to, span + 1).map(day => readDay(env, day));
    } else {
      reads = daysBack(beijingDay(Date.now()), HISTORY_DAYS + 1).map((day, i) => i < FULL_DAYS ? readDay(env, day) : readRollup(env, day));
    }
    const history = (await Promise.all(reads)).reverse().flatMap(rec => pairRows(rec));
    return json({ pairs: PAIRS, history }); // rows are [t, ...one price per pair]
  }

  if (path === '/api/settings' && request.method === 'GET') {
    const [{ limits, lastCheck, alerted, failing, alertError }, rows, knob] = await Promise.all([load(env), recentRows(env, 12), readKnob(env)]);
    // Alert state too, so the page can say which alerts have fired and
    // when they re-arm, and whether checks or sends are failing.
    return json({ limits, knob, lastCheck, tape: tapeFrom(rows), alerted, rearm: REARM, failing, alertError });
  }

  if (path === '/api/settings' && request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    if (body.knob !== undefined && !validKnob(body.knob)) return json({ error: 'The knob takes one to four of the currencies' }, 400);
    // A currency left out of the body keeps the limits it has.
    const limits = {}, { limits: current } = await load(env);
    for (const p of PAIRS) {
      if (body.limits?.[p] === undefined) { limits[p] = current[p]; continue; }
      limits[p] = {};
      for (const side of SIDES) {
        const v = body.limits[p]?.[side] ?? null;
        if (!validLimit(v)) return json({ error: `Invalid ${side} for ${p}` }, 400);
        limits[p][side] = v;
      }
      const { floor, ceiling } = limits[p];
      if (floor != null && ceiling != null && floor >= ceiling) {
        return json({ error: `${p} floor must be lower than its ceiling` }, 400);
      }
    }
    // A changed limit can alert straight away: the alert state records the
    // limit each alert was for, so it needn't be touched here.
    await env.STORE.put('limits', JSON.stringify(limits));
    if (body.knob !== undefined) await env.STORE.put('knob', JSON.stringify(body.knob));
    return json({ limits, knob: body.knob ?? await readKnob(env) });
  }

  if (path === '/api/test' && request.method === 'POST') {
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
