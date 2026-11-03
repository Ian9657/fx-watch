<div align="center">

# FX Watch

[![Tests](https://github.com/Ian9657/fx-watch/actions/workflows/test.yml/badge.svg)](https://github.com/Ian9657/fx-watch/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

A single-user web app that tracks China CITIC Bank's buy prices for eight currencies, records their history, and sends Telegram alerts at a floor and a ceiling.

[Live demo](https://fx.etarc.net/demo) · Cloudflare Workers + KV · vanilla JS, no dependencies, no build step

<br>

<img src="docs/hero.jpg" width="820" alt="The watch, front and back. The front: the needle in the TOO HIGH band and the price on number drums. The back: a round chart of the last seven days, with the floor and ceiling as rings">

</div>

> [!NOTE]
> Prices come from the public feed behind the rate table on citicbank.com and are for reference only. The price in the CITIC app at the time of trade is final.

CITIC publishes only its current quote: no history, no alerts. A Cron Trigger polls the feed every 10 minutes, the Worker stores each new quote in KV (all 20 currencies in the feed, buy and sell), and the page reads the history back from there.

## Features

**Dial (front)**
- Needle position is the price mapped onto a scale built from the floor and ceiling: floor at 0.3, ceiling at 0.7, clamped to [0.02, 0.98]. Bands read BUY / HOLD / TOO HIGH.
- Price on number drums, change against the previous day's last quote, and a tape of the last 12 recorded quotes.
- Eight currencies: USD, GBP, EUR, JPY, HKD, AUD, CAD, SGD. JPY is per 100 yen, as CITIC quotes it.
- The knob carries one to four of them, each with a lamp showing its band. A tap moves to the next stop; a drag turns it stop by stop, with a click at each.
- The crown refreshes; the page also refreshes every 30 s while visible, and on focus or resume.

**Chart (back)**
- Polar chart in SVG: one turn per span (24 h, 7 d, 30 d or 90 d), time clockwise from the top, price outward on the dial's scale.
- Thinned to at most ~900 points (90 days is about 13,000 quotes).
- A quote stands until the next one, so over a quiet spell (weekends) the trace follows a constant-radius arc and then steps to the new price.
- The span is set by a bezel that turns one way in 3° clicks, read through a window at twelve.

<p align="center"><img src="docs/turn.webp" width="300" alt="The watch turning over to its chart, the bezel clicking round from 7 to 30 to 90 days, and turning back"></p>

**Alerts**
- Each currency has an optional floor and ceiling, set on digit wheels and previewed on the dial before saving.
- A wheel of currency codes in the sheet's title picks the currency, and a KNOB switch beside it puts that currency on the knob or takes it off. Alerts don't depend on the knob.
- Per side, the alert state records the limit it fired for. It sends once on crossing, repeats every 4 h while the price stays outside, and re-arms only once the price is back inside by more than 0.1% (hysteresis).
- A failed send is retried on the next check. After 3 failed checks in a row a "checks failing" message goes out, then a "recovered" one.

<p align="center"><img src="docs/sheet.jpg" width="300" alt="The settings sheet open under the watch: a GBP currency wheel and a KNOB ON switch in its title, floor 8.9300 and ceiling 8.9800 on number wheels, each with an ON switch, and a Save button"></p>

**Client**
- Installable PWA. The service worker is network-first with a cache fallback; cached API responses carry an `X-Offline` timestamp so the page can mark stale data.
- Sounds are synthesised in Web Audio from filtered noise bursts, with no audio files. Haptics use `navigator.vibrate` on Android. iOS Safari gives a tap only when the finger itself flips an `<input type="checkbox" switch>`, so each tapped control carries a clear one over its face; drags there have sound only.
- Honours `prefers-reduced-motion`.
- The settings sheet exports the full history as CSV: `time` (ISO 8601, Beijing time), `unix`, then one column per currency, per unit (JPY per 100). Built in the browser from `/api/history`.

## Data

Workers KV, binding `STORE`:

| Key | Contents | Written by |
|---|---|---|
| `limits` | `{ USD: { floor, ceiling }, GBP: …, … }` for the eight currencies | `PUT /api/settings` only |
| `knob` | the knob's currencies in order, e.g. `["GBP", "USD"]` | `PUT /api/settings` only |
| `data` | alert state, last check, failure count | the 10-minute check only |
| `h:YYYY-MM-DD` | one Beijing day: `{ codes, rows }`, a row `[t, …sell, …buy]` per new quote for all 20 currencies, as quoted (per 100 units). ≤144 rows (~50 KB), TTL 92 days | the 10-minute check |
| `r:YYYY-MM-DD` | the last row of each hour of a finished day, TTL 92 days | the 10-minute check, once a day |

Each record has one writer, so a save and a check can't overwrite each other. A check reads and writes only today's record, and skips the write when the quote time hasn't changed.

Parsing 90 full days would take more than the ~10 ms of CPU a free-plan request gets. The chart reads the last 8 days in full and hourly rollups before that (3.7 ms). The CSV reads full days through `/api/history?from=&to=`, 15 days per request (2.2 ms each).

## Security

- `/demo` is public: the same page on GBP and USD prices generated in the browser, with no API requests, so it exposes nothing recorded or saved. It has no settings sheet, alerts or CSV, and its bezel stops at 24 h and 7 d.
- Every `/api/*` route needs `Authorization: Bearer <password>`; the Worker compares SHA-256 digests with `crypto.subtle.timingSafeEqual`.
- Before the password is checked, a [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) allows 60 API requests a minute per address (counted per Cloudflare location), which slows guessing. The page makes about ten a minute.
- The password is kept per device in `localStorage`. A 401 clears it and shows the lock.
- Outbound requests go only to the CITIC feed and the Telegram Bot API. No third-party scripts, fonts or analytics; fonts are self-hosted.

## UI

The interface is one SVG pocket watch, drawn and animated in CSS and JS without images. The constraints, kept at the top of [`public/style.css`](public/style.css):

- One light source, upper left. Every highlight, gradient and inset shadow follows it.
- Every part is mounted in or on the case. No floating drop shadows.
- Brass is reserved for the watch. The rest of the page uses only navy and ivory.
- Mechanical feel comes from motion, sound and haptics, not ornament: drums roll, the bezel clicks one way, the hand sweeps up from rest.

## Architecture

```mermaid
flowchart TB
  app["Web app<br/>public/"] -- "/api/*" --> worker["Cloudflare Worker<br/>src/worker.js"]
  cron(["Cron · every 10 min"]) --> worker
  worker -- "price" --> citic["CITIC rate feed"]
  worker <-- "read · write" --> kv[("Workers KV")]
  worker -- "alerts" --> tg["Telegram"]
```

| Path | Role |
|---|---|
| `src/worker.js` | API routes (`/api/rates`, `/api/history`, `/api/settings`, `/api/test`), scheduled check, KV I/O, Telegram |
| `src/logic.js` | Pure functions: JSONP feed parsing, history rows, alert evaluation, messages, settings migrations |
| `public/js/` | ES modules, one per part of the page: `dial`, `tape`, `back` (chart and bezel), `sheet`, `shared`, `app` (start-up) |
| `public/sw.js` | Service worker for the offline copy |
| `test/` | `node:test` suites: the logic, and the Worker end to end against an in-memory KV with fake CITIC and Telegram |
| `scripts/check-screens.mjs` | Headless Chrome over the DevTools protocol, at six viewport sizes |

## Development

Requires Node 24.

```sh
cp .dev.vars.example .dev.vars   # then set EDIT_PASSWORD=localtest
npm run dev            # wrangler dev, http://localhost:8787
npm test               # node --test
npm run check:screens  # needs npm run dev
```

At each size, `check:screens` asserts that the layout fits one screen without scrolling and that there are no console errors. It then drives the real controls (turns the watch over, turns the knob, drags a wheel, opens the settings sheet), checks that each one responded, and saves screenshots to `screens/`. CI runs `npm test` on every push to `main`.

## Deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ian9657/fx-watch)

Step by step, from creating the Telegram bot to installing on a phone: [docs/SETUP.md](docs/SETUP.md).

The button copies the repository to your GitHub account, creates the KV namespace, and deploys the Worker with its Cron Trigger through Workers Builds, so later pushes to `main` redeploy. It asks for three secrets, listed in [`.dev.vars.example`](.dev.vars.example):

| Name | Purpose |
|---|---|
| `EDIT_PASSWORD` | API password |
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) (`/newbot`) |
| `TELEGRAM_CHAT_ID` | Chat to send alerts to: message the bot, then read `message.chat.id` from `https://api.telegram.org/bot<token>/getUpdates` |

They can be changed later under the Worker's Settings → Variables and Secrets. The Worker is served on `<name>.<subdomain>.workers.dev`; a custom domain can be added under Settings → Domains & Routes.

To install on a device, open the site in Safari, then Share → Add to Home Screen (iPhone) or File → Add to Dock (Mac).

## Credits

Fonts: Cinzel, Cormorant Garamond, Playfair Display and Special Elite, all under the SIL Open Font License.

## License

[MIT](LICENSE)
